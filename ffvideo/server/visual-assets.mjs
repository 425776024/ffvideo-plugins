import { readFile, writeFile, mkdir, stat, rm, copyFile, realpath } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { probe } from '../../packages/server/media.mjs';
import { videoQueryMatches, imageQueryMatches } from './visual-subjects.mjs';
export { videoQueryMatches, imageQueryMatches } from './visual-subjects.mjs';
import { listMaterials, matchingMaterials, registerMaterial, useMaterial } from './materials.mjs';

const API = 'https://commons.wikimedia.org/w/api.php';
const USER_AGENT = 'ffvideo/0.1 (https://ffclip.com; local video drafts)';
const IMAGE_HOSTS = new Set(['upload.wikimedia.org', 'thumb.wikimedia.org']);
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_VIDEO_BYTES = 24 * 1024 * 1024;
const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'video/webm': '.webm', 'video/mp4': '.mp4', 'video/ogg': '.ogv' };
const searchCache = new Map();
const clean = (value, max = 240) => String(value || '').replace(/<[^>]*>/g, '').replace(/&(?:nbsp|amp|quot|lt|gt);/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
const contained = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('../'); };
function reusable(license) { return /^(?:CC0|Public domain|CC BY(?:-SA)?(?: [\d.]+)?|PDM)(?:$|\s)/i.test(license) && !/\b(?:NC|ND)\b/i.test(license); }
function imageUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || !IMAGE_HOSTS.has(url.hostname) || url.port || url.username || url.password || !url.pathname.startsWith('/wikipedia/commons/')) throw new Error('素材来源无效');
  return url;
}
function link(value, hosts, fallback) {
  try { const url = new URL(value); if (url.protocol === 'http:') url.protocol = 'https:';
    if (url.protocol === 'https:' && hosts.includes(url.hostname) && !url.username && !url.password && !url.port) return url.href;
  } catch {}
  return fallback;
}
async function readBounded(response, limit) {
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('素材文件过大'); }
  const reader = response.body?.getReader(); if (!reader) throw new Error('素材为空');
  const chunks = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break;
    size += value.length; if (size > limit) throw new Error('素材文件过大'); chunks.push(Buffer.from(value));
  } } catch (error) { await reader.cancel().catch(() => {}); throw error; }
  return Buffer.concat(chunks);
}
function signature(bytes, mime) {
  if (mime === 'image/jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  if (mime === 'image/png') return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (mime === 'image/webp') return bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
  if (mime === 'video/webm') return bytes.subarray(0, 4).equals(Buffer.from([0x1a, 0x45, 0xdf, 0xa3]));
  if (mime === 'video/ogg') return bytes.toString('ascii', 0, 4) === 'OggS';
  return mime === 'video/mp4' && bytes.toString('ascii', 4, 8) === 'ftyp';
}
function validMedia(asset, kind) {
  return asset.kind === kind && asset.width > 0 && asset.height > 0 && asset.width * asset.height <= 25000000 &&
    (kind !== 'video' || (asset.duration >= 120000 && asset.duration <= 120000 * 120));
}
async function download(candidate, directory, sceneIndex, fetchImpl, signal, cacheDir) {
  let url = imageUrl(candidate.url), response;
  const kind = candidate.kind === 'video' ? 'video' : 'image', limit = kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  const cacheKey = createHash('sha256').update(url.href).digest('hex');
  if (cacheDir) {
    await mkdir(cacheDir, { recursive: true });
    try {
      const info = JSON.parse(await readFile(join(cacheDir, cacheKey + '.json'), 'utf8'));
      if (info.url !== url.href || !EXTENSIONS[info.mime] || !info.mime.startsWith(kind + '/')) throw new Error('缓存不匹配');
      const extension = EXTENSIONS[info.mime];
      const source = join(cacheDir, cacheKey + extension);
      if (!contained(await realpath(cacheDir), await realpath(source))) throw new Error('缓存路径无效');
      const size = (await stat(source)).size; if (!size || size > limit) throw new Error('缓存大小无效');
      const asset = await probe(source);
      if (!signature(await readFile(source), info.mime) || !validMedia(asset, kind)) throw new Error('缓存画面无效');
      signal?.throwIfAborted();
      const path = join(directory, `shot-${sceneIndex + 1}-${cacheKey.slice(0, 16)}${extension}`);
      await copyFile(source, path);
      return { path, kind, sceneIndex, credit: candidate.credit };
    } catch { signal?.throwIfAborted(); }
  }
  for (let redirects = 0; redirects <= 3; redirects++) {
    response = await fetchImpl(url, { redirect: 'manual', signal, headers: { 'User-Agent': USER_AGENT } });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const next = response.headers.get('location'); await response.body?.cancel();
    if (!next || redirects === 3) throw new Error('素材跳转过多'); url = imageUrl(new URL(next, url));
  }
  if (!response.ok) throw new Error(`素材下载失败 (${response.status})`);
  const mime = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase();
  if (!EXTENSIONS[mime] || !mime.startsWith(kind + '/')) { await response.body?.cancel(); throw new Error('素材不是支持的画面格式'); }
  const bytes = await readBounded(response, limit); if (!signature(bytes, mime)) throw new Error('素材内容与类型不符');
  signal?.throwIfAborted();
  const extension = EXTENSIONS[mime];
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  const path = join(directory, `shot-${sceneIndex + 1}-${hash}${extension}`);
  await writeFile(path, bytes);
  try { const asset = await probe(path); if (!validMedia(asset, kind)) throw new Error('素材没有可用画面'); }
  catch (error) { await rm(path, { force: true }); throw error; }
  if (cacheDir) {
    try {
      await copyFile(path, join(cacheDir, cacheKey + extension));
      await writeFile(join(cacheDir, cacheKey + '.json'), JSON.stringify({ url: candidate.url, mime }));
    } catch { /* A cache failure must not discard a validated image. */ }
  }
  return { path, kind, sceneIndex, credit: candidate.credit };
}
export async function searchCommons(query, { fetchImpl = fetch, signal, kind = 'image' } = {}) {
  if (!['image', 'video'].includes(kind)) throw new Error('Invalid visual kind');
  const key = `${kind}:${query}`, video = kind === 'video';
  const cached = fetchImpl === fetch && searchCache.get(key);
  if (cached && Date.now() - cached.at < 600000) { signal?.throwIfAborted(); return structuredClone(cached.value); }
  const url = new URL(API);
  const params = { action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrsearch: `${query} filetype:${video ? 'video' : 'bitmap'}`, gsrnamespace: '6', gsrlimit: '6',
    ...(video ? { prop: 'videoinfo', viprop: 'url|mime|size|extmetadata|derivatives' } : { prop: 'imageinfo', iiprop: 'url|mime|size|extmetadata', iiurlwidth: '1280' }) };
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetchImpl(url, { signal, headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!response.ok) throw new Error(`画面检索失败 (${response.status})`);
  const data = JSON.parse((await readBounded(response, 2 * 1024 * 1024)).toString('utf8'));
  const results = (Array.isArray(data.query?.pages) ? data.query.pages : Object.values(data.query?.pages || {})).flatMap(page => {
    const info = (video ? page.videoinfo : page.imageinfo)?.[0], metadata = info?.extmetadata || {}, license = clean(metadata.LicenseShortName?.value, 80);
    if (!info || !reusable(license) || !EXTENSIONS[info.mime] || !info.mime.startsWith(kind + '/') || info.width < (video ? 360 : 480) || info.height < 360 || (video && (info.duration < 2 || info.duration > 120))) return [];
    if (video ? !videoQueryMatches(query, page.title) : !imageQueryMatches(query, page.title)) return [];
    const sourceUrl = link(info.descriptionurl, ['commons.wikimedia.org'], `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`);
    const credit = { title: clean(page.title.replace(/^File:/, '')), author: clean(metadata.Artist?.value || metadata.Credit?.value || 'Wikimedia Commons'), license,
      sourceUrl, licenseUrl: link(metadata.LicenseUrl?.value, ['creativecommons.org', 'commons.wikimedia.org'], sourceUrl) };
    let source = info.thumburl || info.url;
    if (video) {
      const variants = (info.derivatives || []).filter(item => item.type?.startsWith('video/webm') && item.width >= 360 && item.height >= 360 && Math.max(item.width, item.height) <= 1280 &&
        item.bandwidth > 0 && item.bandwidth * info.duration / 8 <= MAX_VIDEO_BYTES);
      variants.sort((a, b) => Math.abs(Math.max(a.width, a.height) - 1080) - Math.abs(Math.max(b.width, b.height) - 1080));
      source = variants[0]?.src || (info.size <= MAX_VIDEO_BYTES ? info.url : null);
      if (!source) return [];
    }
    try { return [{ url: imageUrl(source).href, credit, ...(video ? { kind: 'video' } : {}) }]; } catch { return []; }
  });
  if (fetchImpl === fetch) {
    if (searchCache.size >= 128) searchCache.delete(searchCache.keys().next().value);
    searchCache.set(key, { at: Date.now(), value: results });
  }
  return results;
}
// Old recipes have no visual query. These object-based searches are a migration
// aid; new recipes provide a different English query for each planned shot.
export function fallbackVisualQuery(recipe, scene, index) {
  return fallbackQuery(recipe, scene, index, false);
}
function fallbackQuery(recipe, scene, index, legacy) {
  const content = [recipe.visualTheme, recipe.title, ...recipe.tags || [], scene.heading, scene.body, scene.visualPrompt].join(' ');
  const choices = [
    ...legacy ? [] : [[/木瓜|papaya|carica\s+papaya/i, ['papaya fruit Carica papaya', 'papaya seeds cut fruit Carica papaya', 'Carica papaya tree fruit']]],
    [/窗|window/i, ['window sunlight interior', 'window light portrait', 'sunlit room']],
    [/椅|chair|等人/i, ['empty chair cafe', 'chair table interior', 'cafe window']],
    [/钥匙|出门|keys/i, ['door key', 'front door', 'keys on table']],
    [/海|coast|ocean|beach/i, ['ocean coast sunset', 'sea waves', 'rocky coastline']],
    [/星|宇宙|银河|star|space/i, ['milky way night sky', 'nebula stars', 'night observatory']],
    [/构图|摄影|framing|composition|photography/i, ['landscape rule of thirds', 'street photography', 'forest path perspective']],
    [/树|公园|叶|forest|leaf|park/i, ['park bench', 'green leaves close up', 'forest pathway']],
    [/灯|light|lamp/i, ['desk lamp interior', 'night city lights', 'lamp window']],
    [/饭|食|咖啡|food|coffee/i, ['fresh food cooking', 'coffee cup', 'vegetables market']],
    [/科学|技术|science|technology/i, ['science laboratory', 'microscope laboratory', 'electronic circuit']],
    [/建筑|城市|street|architecture/i, ['urban architecture', 'city street perspective', 'building facade']],
    [legacy ? /山|自然|nature|mountain/i : /山|mountain/i, ['mountain landscape', 'forest river', 'mountain sunrise']]
  ];
  const match = choices.find(([pattern]) => pattern.test(content));
  if (match) return match[1][index % match[1].length];
  if (legacy) return recipe.tags?.find(value => /^[\x20-\x7e]{3,80}$/.test(value)) || 'nature landscape';
  // A generic landscape is unrelated to an unfamiliar subject. When there is
  // no concrete search term, the composer supplies a topic illustration.
  return recipe.tags?.find(value => /^[\x20-\x7e]{3,80}$/.test(value) && /[a-z]/i.test(value) &&
    !/^(?:nature|landscape|nature landscape|video|draft|ai generated)$/i.test(value.trim())) || null;
}
function sceneSearchQuery(recipe, scene, index) {
  const explicit = clean(scene.visualQuery, 180);
  return explicit || clean(fallbackVisualQuery(recipe, scene, index), 180) || null;
}
const queryKey = query => typeof query === 'string' ? query.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase() : null;
export function photoSearchQueries(query) {
  const words = clean(query, 180).replace(/\b(?:illustration|diagram|workflow|comparison|storyboard|wireframe|animation|review|process)\b/gi, '').replace(/\s+/g, ' ').trim();
  const compact = words.split(' ').slice(0, 4).join(' ');
  const concrete = /\bpapaya\b/i.test(words) ? 'papaya fruit' : /\b(?:face|portrait|avatar|mouth|lip)\b/i.test(words) ? 'human face portrait' : null;
  const subject = words.split(' ').slice(0, 2).join(' ');
  return [...new Set([concrete, compact, subject, words].filter(Boolean))].slice(0, 3);
}
export async function resolveDraftVisuals(recipe, directory, { fetchImpl = fetch, signal, allowRemote = true, visualPreference = 'auto', cacheDir, topic = recipe.title } = {}) {
  signal?.throwIfAborted();
  directory = resolve(directory); await mkdir(directory, { recursive: true });
  if (visualPreference === 'illustration' || (recipe.visualStyle === 'illustration' && !['photo-first', 'video-first'].includes(visualPreference))) return [];
  const manifest = join(directory, 'visuals.json');
  const cached = [];
  let migratedQuery = false;
  try { const existing = JSON.parse(await readFile(manifest, 'utf8'));
    if (existing.version === 2 && Array.isArray(existing.visuals)) for (const item of existing.visuals.slice(0, 5)) {
      try {
        if (!['image', 'video'].includes(item.kind) || typeof item.path !== 'string' || !contained(directory, resolve(item.path)) || !Number.isInteger(item.sceneIndex) || item.sceneIndex < 0 || item.sceneIndex >= recipe.scenes.length || cached.some(value => value.sceneIndex === item.sceneIndex)) continue;
        const expected = sceneSearchQuery(recipe, recipe.scenes[item.sceneIndex], item.sceneIndex);
        if (item.kind === 'video' && !videoQueryMatches(expected || '', item.credit?.title || '')) continue;
        if (item.kind === 'image' && !imageQueryMatches(expected || '', item.credit?.title || '')) continue;
        const legacyQuery = clean(recipe.scenes[item.sceneIndex].visualQuery, 180) ||
          clean(fallbackQuery(recipe, recipe.scenes[item.sceneIndex], item.sceneIndex, true), 180);
        if (!expected || queryKey(item.searchQuery ?? legacyQuery) !== queryKey(expected)) continue;
        const info = await stat(item.path); if (!info.isFile() || info.size > (item.kind === 'video' ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES) || !info.size) continue;
        const asset = await probe(item.path); if (!validMedia(asset, item.kind)) continue;
        const credit = item.credit; if (!credit || ![credit.title, credit.author, credit.license].every(value => typeof value === 'string' && value.trim() && value.length <= 300) || !reusable(credit.license)) continue;
        if (link(credit.sourceUrl, ['commons.wikimedia.org'], null) !== credit.sourceUrl || link(credit.licenseUrl, ['creativecommons.org', 'commons.wikimedia.org'], null) !== credit.licenseUrl) continue;
        if (item.searchQuery === undefined) migratedQuery = true;
        cached.push({ ...item, searchQuery: expected });
      } catch { /* A damaged cached shot is reacquired or replaced with an illustration. */ }
    }
  } catch {}
  signal?.throwIfAborted();
  if (migratedQuery) await writeFile(manifest, JSON.stringify({ version: 2, visuals: cached }, null, 2));
  const remember = async visuals => { if(cacheDir) for(const visual of visuals) {
    signal?.throwIfAborted();
    try { await registerMaterial(cacheDir,visual,{topic}); } catch { signal?.throwIfAborted(); }
  } };
  if (cached.length === Math.min(recipe.scenes.length, 5)) { await remember(cached); return cached; }
  const inventory = await listMaterials(cacheDir,{limit:2000,signal});
  const overall = AbortSignal.timeout(15000), combined = signal ? AbortSignal.any([signal, overall]) : overall;
  const visuals = cached, used = new Set(cached.map(visual => visual.credit.sourceUrl)), searches = new Map();
  const indices = Array.from({ length: Math.min(recipe.scenes.length, 5) }, (_, index) => index).filter(index => !visuals.some(visual => visual.sceneIndex === index));
  let next = 0;
  const worker = async () => { while (next < indices.length && !combined.aborted) {
    const sceneIndex = indices[next++];
    const scene = recipe.scenes[sceneIndex], query = sceneSearchQuery(recipe, scene, sceneIndex);
    if (!query) continue;
    try {
      const requestSignal = AbortSignal.any([combined, AbortSignal.timeout(7000)]);
      const queries = ['photo-first', 'video-first'].includes(visualPreference) ? photoSearchQueries(query) : [query];
      let found = false;
      const requests = [...(visualPreference === 'video-first' ? queries.slice(0, 2).map(query => ({ query, kind: 'video' })) : []), ...queries.map(query => ({ query, kind: 'image' }))];
      // Local inventory precedes every network request, including synonyms that
      // have never been queried before. Layout and narration are not reused.
      for (const request of requests) {
        if (found) break;
        for(const info of matchingMaterials(inventory,request.query,{kind:request.kind,used}).slice(0,3)) {
          if(used.has(info.credit.sourceUrl)) continue;
          used.add(info.credit.sourceUrl);
          try { const visual=await useMaterial(cacheDir,info,directory,sceneIndex,query,requestSignal); visuals.push({...visual,...(request.query!==query?{resolvedQuery:request.query}:{})}); found=true; break; }
          catch { used.delete(info.credit.sourceUrl); signal?.throwIfAborted(); }
        }
      }
      if (!allowRemote) continue;
      for (const request of requests) {
        const searchQuery = request.query, searchKey = `${request.kind}:${searchQuery}`;
        if (found || requestSignal.aborted) break;
        if (!searches.has(searchKey)) searches.set(searchKey, searchCommons(searchQuery, { fetchImpl, kind: request.kind, signal: AbortSignal.any([combined, AbortSignal.timeout(7000)]) }));
        const candidates = await searches.get(searchKey);
        for (const candidate of candidates.filter(candidate => !used.has(candidate.credit.sourceUrl)).slice(0, 2)) {
          if (used.has(candidate.credit.sourceUrl)) continue;
          used.add(candidate.credit.sourceUrl);
          try { const visual = await download(candidate, directory, sceneIndex, fetchImpl, requestSignal, cacheDir); visuals.push({ ...visual, searchQuery: query, ...(searchQuery !== query ? { resolvedQuery: searchQuery } : {}) }); found = true; break; }
          catch { used.delete(candidate.credit.sourceUrl); if (signal?.aborted) throw signal.reason; if (combined.aborted) break; }
        }
      }
    } catch { if (signal?.aborted) throw signal.reason; /* A topic illustration is available offline. */ }
  } };
  await Promise.all([worker(), worker()]);
  signal?.throwIfAborted();
  visuals.sort((a, b) => a.sceneIndex - b.sceneIndex);
  await remember(visuals);
  await writeFile(manifest, JSON.stringify({ version: 2, visuals }, null, 2));
  return visuals;
}

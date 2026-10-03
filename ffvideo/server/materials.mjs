import { mkdir, readdir, readFile, stat, realpath, copyFile, writeFile, rename, rm } from 'node:fs/promises';
import { join, relative, isAbsolute, extname } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { probe } from '../../packages/server/media.mjs';
import { videoQueryMatches } from './visual-subjects.mjs';

// Inventory holds reusable source material, never a filled movie layout.
const ID = /^[a-f0-9]{64}$/;
const EXT = new Set(['.png', '.jpg', '.jpeg', '.webp', '.webm', '.mp4', '.ogv']);
const contains = (root, path) => { const part = relative(root, path); return !isAbsolute(part) && part !== '..' && !part.startsWith('../'); };
const clean = value => String(value || '').normalize('NFKC').replace(/\s+/g, ' ').trim().slice(0, 240);
function creditValid(c) {
  if (!c || !['title','author','license'].every(k => typeof c[k] === 'string' && c[k].trim() && c[k].length <= 500)) return false;
  if (!/^(CC0|Public domain|CC BY(?:-SA)?(?: [\d.]+)?|PDM)(?:$|\s)/i.test(c.license) || /\b(NC|ND)\b/i.test(c.license)) return false;
  try { return [c.sourceUrl,c.licenseUrl].every((value,i) => { const u = new URL(value); return u.protocol === 'https:' && !u.username && !u.password && !u.port && (i ? ['commons.wikimedia.org','creativecommons.org'] : ['commons.wikimedia.org']).includes(u.hostname); }); }
  catch { return false; }
}
function valid(info) {
  return info?.version === 1 && ID.test(info.id) && EXT.has(info.extension) && ['image','video'].includes(info.kind) && creditValid(info.credit) &&
    [info.width,info.height,info.bytes].every(v => Number.isSafeInteger(v) && v > 0) && info.bytes <= (info.kind === 'video' ? 24 : 8)*1024*1024 &&
    info.width * info.height <= 25000000 && Number.isFinite(info.durationSeconds) && info.durationSeconds >= 0 && info.durationSeconds <= 120 &&
    [info.queries,info.topics].every(values=>Array.isArray(values) && values.length<=24 && values.every(v=>typeof v==='string' && v.trim() && v.length<=240));
}
async function atomic(path, value) {
  const tmp = path + '.' + randomUUID() + '.tmp';
  try { await writeFile(tmp, JSON.stringify(value)); await rename(tmp,path); } finally { await rm(tmp,{force:true}); }
}
const writes = new Map();
export async function registerMaterial(cacheDir, visual, { topic = '', query = visual.searchQuery || '' } = {}) {
  if (!cacheDir || !creditValid(visual.credit)) return null;
  const directory = join(cacheDir,'materials'); await mkdir(directory,{recursive:true});
  const extension = extname(visual.path).toLowerCase(); if (!EXT.has(extension)) return null;
  const info = await stat(visual.path); if (!info.isFile() || !info.size || info.size > (visual.kind === 'video' ? 24 : 8)*1024*1024) return null;
  const bytes = await readFile(visual.path), id = createHash('sha256').update(bytes).digest('hex');
  const key = join(directory,id), previous = writes.get(key) || Promise.resolve();
  const operation = previous.catch(()=>{}).then(async()=>{
    const asset = await probe(visual.path); if (!['image','video'].includes(asset.kind) || asset.width*asset.height > 25000000) return null;
    let existing; try { existing = JSON.parse(await readFile(key+'.json','utf8')); if (!valid(existing)) existing = null; } catch {}
    const metadata = { version:1,id,extension:existing?.extension || extension,kind:asset.kind,width:asset.width,height:asset.height,bytes:bytes.length,
      durationSeconds:asset.duration/120000,credit:visual.credit,
      queries:[...new Set([...(existing?.queries || []),clean(query),clean(visual.resolvedQuery)].filter(Boolean))].slice(-24),
      topics:[...new Set([...(existing?.topics || []),clean(topic)].filter(Boolean))].slice(-24),createdAt:existing?.createdAt || Date.now() };
    const target = key+metadata.extension;
    // Clone-on-write when supported, with independent file lifetimes and edits.
    let intact=false; try { intact=(await readFile(target)).equals(bytes); } catch {}
    if (!intact) await writeFile(target,bytes);
    await atomic(key+'.json',metadata); return metadata;
  });
  writes.set(key,operation); try { return await operation; } finally { if(writes.get(key)===operation) writes.delete(key); }
}
export async function listMaterials(cacheDir, { topic = '', limit = 24, signal, relevantOnly = false } = {}) {
  if (!cacheDir) return [];
  const directory=join(cacheDir,'materials'); let names; try { names=await readdir(directory); } catch { return []; }
  const entries=[]; const subject=clean(topic).toLowerCase();
  for (const name of names.filter(n=>/^[a-f0-9]{64}\.json$/.test(n)).slice(0,2000)) {
    signal?.throwIfAborted();
    try { const info=JSON.parse(await readFile(join(directory,name),'utf8')); if (!valid(info)) continue;
      const path=join(directory,info.id+info.extension); if(!contains(await realpath(directory),await realpath(path))) continue;
      if ((await stat(path)).size !== info.bytes) continue;
      const score=subject && info.topics.some(t=>typeof t==='string' && (t.toLowerCase().includes(subject) || subject.includes(t.toLowerCase()))) ? 2 : 0;
      if (relevantOnly && subject && !score) continue;
      entries.push({...info,score});
    } catch {}
  }
  return entries.sort((a,b)=>b.score-a.score || b.createdAt-a.createdAt).slice(0,limit).map(({score,...info})=>info);
}
export function matchingMaterials(inventory, query, { kind, used = new Set() } = {}) {
  return inventory.filter(info => (!kind || info.kind===kind) && !used.has(info.credit.sourceUrl) &&
    (info.queries.some(previous=>clean(previous).toLowerCase()===clean(query).toLowerCase()) || videoQueryMatches(query,info.credit.title)));
}
export async function useMaterial(cacheDir, info, directory, sceneIndex, query, signal) {
  if (!valid(info)) throw new Error('无效的素材库存'); signal?.throwIfAborted();
  const root=join(cacheDir,'materials'),source=join(root,info.id+info.extension);
  if (!contains(await realpath(root),await realpath(source))) throw new Error('库存素材路径无效');
  const bytes=await readFile(source); if(bytes.length!==info.bytes || createHash('sha256').update(bytes).digest('hex')!==info.id) throw new Error('库存素材已损坏');
  const asset=await probe(source); if(asset.kind!==info.kind || asset.width!==info.width || asset.height!==info.height) throw new Error('库存画面无效');
  signal?.throwIfAborted(); await mkdir(directory,{recursive:true});
  const path=join(directory,`shot-${sceneIndex+1}-${info.id.slice(0,16)}${info.extension}`);
  await copyFile(source,path,constants.COPYFILE_FICLONE);
  return {path,kind:info.kind,sceneIndex,credit:info.credit,searchQuery:query,materialId:info.id};
}
export function materialBrief(inventory) {
  return inventory.map(({id,kind,credit,width,height,durationSeconds,queries}) => ({ id,kind,subject:credit.title,width,height,
    ...(kind==='video'?{durationSeconds}:{}),queries:queries.slice(-3) }));
}

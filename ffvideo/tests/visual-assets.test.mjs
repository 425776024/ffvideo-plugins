import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { searchCommons, resolveDraftVisuals, fallbackVisualQuery, photoSearchQueries, videoQueryMatches } from '../server/visual-assets.mjs';
import { backgroundPng } from '../server/drafts.mjs';
import { spawnSync } from 'node:child_process';

const recipe = { title: '构图', tags: ['摄影'], scenes: [{ heading: '窗边', body: '留出空间', visualQuery: 'window sunlight interior' }] };
const image = backgroundPng('#6ee7b7', 480, 640);
test('video-first downloads real moving footage, prefers a bounded derivative and reuses it offline without substituting a poster', async t => {
  const root = await mkdtemp(join(tmpdir(), 'ffvideo-stock-video-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'real.webm');
  const generated = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=480x640:rate=12:duration=2', '-c:v', 'libvpx-vp9', '-threads', '2', '-cpu-used', '8', '-crf', '40', '-b:v', '0', path]);
  assert.equal(generated.status, 0, generated.stderr.toString());
  const bytes = await readFile(path), queries = []; let downloads = 0;
  const videoUrl = 'https://upload.wikimedia.org/wikipedia/commons/transcoded/a/ab/walking.webm/walking.webm.640p.vp9.webm';
  const source = { title: 'File:Window sunlight interior.webm', videoinfo: [{ ...page(1).imageinfo[0], mime: 'video/webm', width: 1080, height: 1920, duration: 20, size: 90000000,
    url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/walking.webm',
    derivatives: [{ src: videoUrl, type: 'video/webm; codecs="vp9"', width: 480, height: 640, bandwidth: 500000 }] }] };
  const fetchImpl = async url => {
    if (String(url).includes('/w/api.php')) { const u = new URL(url); queries.push(u.searchParams.get('gsrsearch')); assert.equal(u.searchParams.get('prop'), 'videoinfo'); return Response.json({ query: { pages: [source] } }); }
    assert.equal(String(url), videoUrl); downloads++; return new Response(bytes, { headers: { 'Content-Type': 'video/webm' } });
  };
  const options = { fetchImpl, visualPreference: 'video-first', cacheDir: join(root, 'cache') };
  const first = await resolveDraftVisuals(recipe, join(root, 'first'), options);
  assert.equal(first.length, 1); assert.equal(first[0].kind, 'video');
  assert.equal(first[0].credit.license, 'CC BY 4.0');
  assert.deepEqual(await readFile(first[0].path), bytes);
  const next = await resolveDraftVisuals(recipe, join(root, 'next'), options);
  assert.equal(next[0].kind, 'video'); assert.equal(downloads, 1);
  assert(queries.every(query => query.endsWith('filetype:video')));
  assert.deepEqual(await resolveDraftVisuals(recipe, join(root, 'first'), { allowRemote: false, visualPreference: 'video-first' }), first);
});

test('video search rejects non-reusable licenses, private URLs and oversized sources without bounded derivatives', async () => {
  const source = { title: 'File:Moving forest footage.webm', videoinfo: [{ ...page(1).imageinfo[0], mime: 'video/webm', duration: 10, size: 10000000, url: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/moving.webm' }] };
  const pages = [source, { ...source, videoinfo: [{ ...source.videoinfo[0], url: 'http://127.0.0.1/private' }] },
    { ...source, videoinfo: [{ ...source.videoinfo[0], size: 100000000 }] },
    { ...source, videoinfo: [{ ...source.videoinfo[0], extmetadata: { LicenseShortName: { value: 'All rights reserved' } } }] }];
  const results = await searchCommons('forest', { kind: 'video', fetchImpl: async () => Response.json({ query: { pages } }) });
  assert.equal(results.length, 1); assert.equal(results[0].kind, 'video');
  assert(results[0].url.endsWith('moving.webm'), 'use the video source, never its image thumburl');
});

test('video relevance rejects uploader/category matches that do not describe the requested visible subject', () => {
  assert.equal(videoQueryMatches('forest stream', 'Forest Service - Northern Region.webm'), false);
  assert.equal(videoQueryMatches('forest trees wind', 'Midway Atoll - Bird Sightings.webm'), false);
  assert.equal(videoQueryMatches('forest trail', 'The Pacific Crest Trail in southern Oregon.webm'), false);
  assert.equal(videoQueryMatches('forest stream', 'Stream flowing in woodland.webm'), true);
  assert.equal(videoQueryMatches('raindrops water', 'Water Droplets on water.webm'), true);
});
test('photo-first resolves physical subjects even for illustration recipes and shares downloaded assets across works', async () => {
  const root = await mkdtemp(join(tmpdir(), 'ffvideo-shared-photos-')); let downloads = 0;
  try {
    const sample = { ...recipe, visualStyle: 'illustration', scenes: [{ ...recipe.scenes[0], visualQuery: 'portrait text speech animation workflow illustration' }] };
    assert.equal(photoSearchQueries(sample.scenes[0].visualQuery)[0], 'human face portrait');
    const queries = [];
    const fetchImpl = async url => {
      if (String(url).includes('/w/api.php')) { queries.push(new URL(url).searchParams.get('gsrsearch')); return Response.json({ query: { pages: [page(1, {}, 'Portrait')] } }); }
      downloads++; return new Response(image, { headers: { 'Content-Type': 'image/png' } });
    };
    const options = { fetchImpl, visualPreference: 'photo-first', cacheDir: join(root, 'cache') };
    const before = await resolveDraftVisuals(sample, join(root, 'first'), options);
    const after = await resolveDraftVisuals(sample, join(root, 'second'), options);
    assert.equal(before.length, 1); assert.equal(after.length, 1); assert.equal(downloads, 1);
    assert.notEqual(before[0].path, after[0].path);
    assert.equal(after[0].resolvedQuery, 'human face portrait');
    assert.deepEqual(await readFile(after[0].path), image);
    assert.deepEqual(queries, ['human face portrait filetype:bitmap']);
    assert.deepEqual(await resolveDraftVisuals(sample, join(root, 'offline'), { ...options, visualPreference: 'illustration' }), []);
  } finally { await rm(root, { recursive: true, force: true }); }
});
test('scene image requests overlap while scene ordering and distinct credits are preserved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-parallel-photos-')); let active = 0, maximum = 0;
  try {
    const fetchImpl = async url => {
      if (String(url).includes('/w/api.php')) return Response.json({ query: { pages: [page(1), page(2), page(3)] } });
      maximum = Math.max(maximum, ++active);
      await new Promise(resolve => setTimeout(resolve, 20)); active--;
      return new Response(image, { headers: { 'Content-Type': 'image/png' } });
    };
    const result = await resolveDraftVisuals({ ...recipe, scenes: Array.from({ length: 3 }, (_, index) => ({ ...recipe.scenes[0], visualQuery: `window room ${index}` })) }, directory, { fetchImpl });
    assert.equal(maximum, 2);
    assert.deepEqual(result.map(item => item.sceneIndex), [0, 1, 2]);
    assert.equal(new Set(result.map(item => item.credit.sourceUrl)).size, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
function page(index, overrides = {}, subject = 'Window') {
  return { title: `File:${subject}-${index}.png`, imageinfo: [{ mime: 'image/png', width: 480, height: 640,
    thumburl: `https://thumb.wikimedia.org/wikipedia/commons/a/ab/${subject.toLowerCase()}-${index}.png`,
    descriptionurl: `https://commons.wikimedia.org/wiki/File:${subject}-${index}.png`,
    extmetadata: { LicenseShortName: { value: 'CC BY 4.0' }, Artist: { value: '<a href="x">Author</a>' }, LicenseUrl: { value: 'https://creativecommons.org/licenses/by/4.0/' } }, ...overrides }] };
}
test('visual search retains reusable images with attribution and rejects private downloads and unknown licenses', async () => {
  const results = await searchCommons('window', { fetchImpl: async () => Response.json({ query: { pages: [page(1),
    page(2, { thumburl: 'http://127.0.0.1/private' }), page(3, { extmetadata: { LicenseShortName: { value: 'All rights reserved' } } }),
    page(4, { mime: 'image/svg+xml' }), page(5, { extmetadata: { LicenseShortName: { value: 'CC BY-NC 4.0' } } })] } }) });
  assert.equal(results.length, 1);
  assert.equal(results[0].credit.author, 'Author');
  assert.equal(results[0].credit.licenseUrl, 'https://creativecommons.org/licenses/by/4.0/');
});
test('downloaded shots are real image files and a persisted visual manifest avoids repeated network calls', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-assets-')); let calls = 0;
  try {
    const fetchImpl = async url => { calls++; return String(url).includes('/w/api.php') ? Response.json({ query: { pages: [page(1)] } }) : new Response(image, { headers: { 'Content-Type': 'image/png' } }); };
    const visuals = await resolveDraftVisuals(recipe, directory, { fetchImpl });
    assert.equal(visuals.length, 1); assert.equal(visuals[0].sceneIndex, 0);
    assert.deepEqual(await readFile(visuals[0].path), image);
    const count = calls;
    assert.deepEqual(await resolveDraftVisuals(recipe, directory, { fetchImpl }), visuals);
    assert.equal(calls, count);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('unsafe redirects and invalid image bytes fall back to local illustrations instead of publishing corrupt assets', async () => {
  for (const invalid of ['redirect', 'bytes']) {
    const directory = await mkdtemp(join(tmpdir(), 'ffvideo-assets-')); let privateCalls = 0;
    try {
      const fetchImpl = async url => {
        if (String(url).includes('127.0.0.1')) privateCalls++;
        if (String(url).includes('/w/api.php')) return Response.json({ query: { pages: [page(1)] } });
        return invalid === 'redirect' ? new Response(null, { status: 302, headers: { Location: 'http://127.0.0.1/secret' } }) : new Response('<html>blocked</html>', { headers: { 'Content-Type': 'image/png' } });
      };
      assert.deepEqual(await resolveDraftVisuals(recipe, directory, { fetchImpl }), []);
      assert.equal(privateCalls, 0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});
test('a cancelled visual request cannot create a manifest and corrupt cached shots are reacquired', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-assets-'));
  try {
    const controller = new AbortController(); controller.abort();
    await assert.rejects(resolveDraftVisuals(recipe, directory, { signal: controller.signal }), { name: 'AbortError' });
    await assert.rejects(access(join(directory, 'visuals.json')));
    let downloads = 0;
    const fetchImpl = async url => String(url).includes('/w/api.php') ? Response.json({ query: { pages: [page(1)] } }) : (downloads++, new Response(image, { headers: { 'Content-Type': 'image/png' } }));
    const before = await resolveDraftVisuals(recipe, directory, { fetchImpl });
    await writeFile(before[0].path, 'truncated image');
    const after = await resolveDraftVisuals(recipe, directory, { fetchImpl });
    assert.equal(downloads, 2); assert.deepEqual(await readFile(after[0].path), image);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('legacy papaya recipes search for the actual fruit and unknown subjects never request a generic landscape', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-relevance-'));
  try {
    const papaya = { title: '木瓜的营养特点', tags: ['水果', '自然'], scenes: [{ heading: '橙色果肉', body: '切开木瓜，看看果肉与种子。' }] };
    const queries = [];
    const fetchImpl = async url => { queries.push(new URL(url).searchParams.get('gsrsearch')); return Response.json({ query: { pages: [] } }); };
    assert.equal(fallbackVisualQuery(papaya, papaya.scenes[0], 0), 'papaya fruit Carica papaya');
    assert.deepEqual(await resolveDraftVisuals(papaya, directory, { fetchImpl }), []);
    assert.deepEqual(queries, ['papaya fruit Carica papaya filetype:bitmap']);
    for (const tags of [['陌生话题'], ['nature'], ['landscape']]) {
      const unfamiliar = { title: '一个尚未识别的主题', tags, scenes: [{ heading: '介绍', body: '没有具体可检索的画面线索。' }] };
      assert.equal(fallbackVisualQuery(unfamiliar, unfamiliar.scenes[0], 0), null);
      assert.deepEqual(await resolveDraftVisuals(unfamiliar, directory, { fetchImpl: async () => { throw new Error('unrelated search must not run'); } }), []);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('a cached picture from a different scene query is replaced and the corrected query is persisted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-query-cache-')); const queries = []; let downloads = 0;
  try {
    const fetchImpl = async url => {
      if (String(url).includes('/w/api.php')) {
        queries.push(new URL(url).searchParams.get('gsrsearch'));
        return Response.json({ query: { pages: [page(queries.length, {}, new URL(url).searchParams.get('gsrsearch').includes('papaya') ? 'Papaya' : 'Window')] } });
      }
      downloads++; return new Response(image, { headers: { 'Content-Type': 'image/png' } });
    };
    const before = await resolveDraftVisuals(recipe, directory, { fetchImpl });
    const papaya = { title: '木瓜', tags: ['水果'], scenes: [{ heading: '木瓜切面', body: '果肉与种子' }] };
    const after = await resolveDraftVisuals(papaya, directory, { fetchImpl });
    assert.equal(after.length, 1); assert.equal(downloads, 2);
    assert.equal(after[0].searchQuery, 'papaya fruit Carica papaya');
    assert.notEqual(after[0].credit.sourceUrl, before[0].credit.sourceUrl);
    assert.deepEqual(queries, ['window sunlight interior filetype:bitmap', 'papaya fruit Carica papaya filetype:bitmap']);
    const manifest = JSON.parse(await readFile(join(directory, 'visuals.json'), 'utf8'));
    assert.equal(manifest.visuals[0].searchQuery, after[0].searchQuery);
    assert.deepEqual(await resolveDraftVisuals(papaya, directory, { fetchImpl }), after);
    assert.equal(downloads, 2, 'matching scene queries reuse the downloaded image');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
test('unlabelled specific caches are migrated without downloads while old generic and changed queries are discarded', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-legacy-cache-'));
  try {
    const visuals = await resolveDraftVisuals(recipe, directory, { fetchImpl: async url => String(url).includes('/w/api.php') ? Response.json({ query: { pages: [page(1)] } }) : new Response(image, { headers: { 'Content-Type': 'image/png' } }) });
    const withoutQuery = { ...visuals[0] }; delete withoutQuery.searchQuery;
    await writeFile(join(directory, 'visuals.json'), JSON.stringify({ version: 2, visuals: [withoutQuery] }));
    assert.deepEqual(await resolveDraftVisuals(recipe, directory, { allowRemote: false }), visuals);
    assert.equal(JSON.parse(await readFile(join(directory, 'visuals.json'), 'utf8')).visuals[0].searchQuery, 'window sunlight interior');
    const legacyWindow = { ...recipe, scenes: [{ heading: '窗边', body: '留出空间' }] };
    await writeFile(join(directory, 'visuals.json'), JSON.stringify({ version: 2, visuals: [withoutQuery] }));
    assert.deepEqual(await resolveDraftVisuals(legacyWindow, directory, { allowRemote: false }), visuals, 'an unchanged concrete fallback stays cached');
    const papaya = { title: '木瓜', tags: ['水果'], scenes: [{ heading: '木瓜切面', body: '果肉与种子' }] };
    await writeFile(join(directory, 'visuals.json'), JSON.stringify({ version: 2, visuals: [withoutQuery] }));
    assert.deepEqual(await resolveDraftVisuals(papaya, directory, { allowRemote: false }), [], 'the earlier generic landscape is never reused for papaya');
    await writeFile(join(directory, 'visuals.json'), JSON.stringify({ version: 2, visuals }));
    const changed = { ...recipe, scenes: [{ ...recipe.scenes[0], visualQuery: 'papaya fruit Carica papaya' }] };
    assert.deepEqual(await resolveDraftVisuals(changed, directory, { allowRemote: false }), []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a literal cup-of-coffee fundraising title is not physical coffee footage', () => {
  assert.equal(videoQueryMatches('coffee cup', 'If everyone reading Wikipedia right now donated the cost of a cup of coffee.webm'), false);
  assert.equal(videoQueryMatches('coffee cup', 'A cup of Kenyan Coffee.webm'), true);
});

import { design, richDesign } from './fixtures/direction.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile, access, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { request } from 'node:http';
import { startFfvideo as startLocalServer } from '../server/index.mjs';
import { FeedStore } from '../server/store.mjs';
import { backgroundPng } from '../server/drafts.mjs';
const startFfvideo = options => startLocalServer({ ...options, visualOptions: { allowRemote: false, ...options.visualOptions } });
const samplesDir = fileURLToPath(new URL('../assets/samples', import.meta.url));
const staticDir = fileURLToPath(new URL('../', import.meta.url));
const recipe = (title) => ({ design: {...richDesign(),captionKeywords:[title.slice(0,2)]}, title, language: 'zh', tags: ['验证'], narration: title + '。这是一条用于检查任务切换的具体内容。', scenes: [{ heading: title, body: '任务状态必须与当前作品库一致。' }] });
test('standalone default starts a background provider while saved and explicit agent modes remain authoritative', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-standalone-default-')); let server;
  try {
    const store = await FeedStore.open(dataDir); await store.updatePreferences({ autoGenerate: false }); await store.close();
    const options = { dataDir, staticDir, port: 0, seed: false, speech: 'browser', defaultProvider: 'codex',
      providerOptions: { command: process.execPath, args: ['-e', 'process.exit(98)'] } };
    server = await startFfvideo(options);
    assert.equal(server.generationStatus().mode, 'codex'); assert.equal(server.generationStatus().status, 'paused');
    await server.close(); await writeFile(join(dataDir, 'generator.json'), JSON.stringify({ mode: 'agent' }));
    server = await startFfvideo(options); assert.equal(server.generationStatus().mode, 'agent');
    await server.close(); await writeFile(join(dataDir, 'generator.json'), JSON.stringify({ mode: 'codex' }));
    server = await startFfvideo({ ...options, provider: 'agent' }); assert.equal(server.generationStatus().mode, 'agent');
  } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('export downloads send attachment headers, survive restart and reject paths outside the export directory', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-download-')); let server;
  const filename = '中文 视频.mp4', content = Buffer.from('export download fixture');
  try {
    server = await startFfvideo({ dataDir, staticDir, port: 0, seed: false, speech: 'browser' });
    const path = join(dataDir, 'exports', filename), route = '/ffapi/exports/' + encodeURIComponent(filename);
    await writeFile(path, content);
    const response = await fetch(server.url + route);
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'video/mp4');
    assert.match(response.headers.get('content-disposition'), /^attachment;/);
    assert.ok(response.headers.get('content-disposition').includes(encodeURIComponent(filename)));
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), content);
    const head = await fetch(server.url + route, { method: 'HEAD' });
    assert.equal(head.headers.get('content-length'), String(content.length)); assert.equal((await head.arrayBuffer()).byteLength, 0);
    assert.equal((await fetch(server.url + '/ffapi/exports/..%2Foutside.mp4')).status, 400);
    await writeFile(join(dataDir, 'outside.mp4'), 'private'); await symlink(join(dataDir, 'outside.mp4'), join(dataDir, 'exports', 'escape.mp4'));
    assert.equal((await fetch(server.url + '/ffapi/exports/escape.mp4')).status, 403);
    assert.equal((await fetch(server.url + '/ffapi/exports/missing.mp4')).status, 404);
    await server.close(); server = await startFfvideo({ dataDir, staticDir, port: 0, seed: false, speech: 'browser' });
    assert.deepEqual(Buffer.from(await (await fetch(server.url + route)).arrayBuffer()), content);
  } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('native composition overlaps the next script with a bounded backlog and cancellation cannot publish stale work', { skip: process.platform !== 'darwin' }, async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-native-pipeline-')); let server, release;
  const gate = new Promise(resolve => { release = resolve; });
  try {
    const store = await FeedStore.open(dataDir); await store.updatePreferences({ autoGenerate: false, voiceMode: 'random' }); await store.close();
    const output = JSON.stringify({ ...recipe('并行制作'), visualStyle: 'photo', scenes: [{ heading: '观察', body: '一个清晰的画面', visualQuery: 'papaya fruit' }] });
    const fetchImpl = async url => {
      if (String(url).includes('/w/api.php')) return Response.json({ query: { pages: [{ title: 'File:Papaya.png', imageinfo: [{ mime: 'image/png', width: 480, height: 640,
        thumburl: 'https://upload.wikimedia.org/wikipedia/commons/a/ab/papaya.png', descriptionurl: 'https://commons.wikimedia.org/wiki/File:Papaya.png',
        extmetadata: { LicenseShortName: { value: 'CC0' }, Artist: { value: 'Test author' }, LicenseUrl: { value: 'https://creativecommons.org/publicdomain/zero/1.0/' } } }] }] } });
      await gate; return new Response(backgroundPng('#6ee7b7', 480, 640), { headers: { 'Content-Type': 'image/png' } });
    };
    server = await startFfvideo({ dataDir, staticDir, seed: false, port: 0, speech: 'native', provider: 'command', visualOptions: { allowRemote: true, fetchImpl },
      providerOptions: { command: process.execPath, args: ['-e', `let input=''; process.stdin.on('data',bytes=>input+=bytes); process.stdin.on('end',()=>{const {job,prompt}=JSON.parse(input); const draft=JSON.parse(${JSON.stringify(output)}); draft.title+=job.id; draft.narration+=job.id; const position=JSON.parse(prompt.slice(prompt.lastIndexOf(String.fromCharCode(10))+1)).editorialVariation.position-1; draft.design.shots[1].frame.y+=position*20;draft.design.shots[1].frame.height-=position*20; process.stdout.write(JSON.stringify(draft));});`] } });
    const feed = await server.createFeed('并行验证');
    await waitFor(async () => server.state().jobs.filter(job => job.feedId === feed.feedId && job.status === 'composing').length === 2);
    await waitFor(async () => server.state().jobs.filter(job => job.feedId === feed.feedId && job.voice).length >= 2, 30000);
    const reserved = server.state().jobs.filter(job => job.feedId === feed.feedId && job.voice);
    assert.notEqual(reserved[0].voice, reserved[1].voice, 'Concurrent native syntheses reserve different voices before either work publishes');
    assert.equal(server.state().works.length, 0);
    assert.equal(server.state().jobs.filter(job => job.feedId === feed.feedId && job.status === 'queued').length, 3);
    await server.store.removeFeed(feed.feedId); release();
    await server.close(); server = undefined;
    const reopened = await FeedStore.open(dataDir);
    try { assert.equal(reopened.state().works.length, 0); assert.ok(reopened.state().jobs.filter(job => job.feedId === feed.feedId).every(job => job.status === 'cancelled')); }
    finally { await reopened.close(); }
  } finally { release(); await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
async function waitFor(check, timeout = 6000) {
  const start = Date.now();
  while (Date.now() - start < timeout) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw new Error('Timed out waiting for server state');
}
test('bootstraps five voiced examples without recommendation jobs, enforces request origin, and persists preferences', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-server-')); let server;
  try {
    server = await startFfvideo({ dataDir, samplesDir, staticDir, port: 0, speech: 'browser' });
    const initial = await (await fetch(server.url + '/ffapi/state')).json();
    assert.equal(initial.works.length, 5);
    assert.equal(initial.jobs.filter(j => j.status === 'queued').length, 0);
    assert.equal(initial.generation.status, 'buffered');
    assert.equal(initial.generation.pending, 0);
    for (const work of initial.works) {
      assert.equal(work.captionVersion, 3, 'built-in narrated works ship with varied readable full captions rather than waiting for migration');
      const snapshot = await server.sessionFor(work.id);
      assert.ok(snapshot.project.assets.some(a => a.kind === 'audio'));
      assert.ok((await readFile(work.projectPath)).length > 100);
    }
    assert.equal((await fetch(server.url + '/ffapi/state', { headers: { Origin: 'https://untrusted.example' } })).status, 403);
    const invalidHost = await new Promise((resolve, reject) => {
      const req = request(server.url + '/ffapi/state', { headers: { Host: 'untrusted.example' } }, res => { res.resume(); resolve(res.statusCode); });
      req.on('error', reject); req.end();
    });
    assert.equal(invalidHost, 403);
    await server.store.updatePreferences({ topics: ['电影'], autoplay: false });
    await server.close(); server = await startFfvideo({ dataDir, samplesDir, staticDir, port: 0, speech: 'browser' });
    assert.equal(server.state().works.length, 5);
    assert.equal(server.state().preferences.autoplay, false);
    assert.deepEqual(server.state().preferences.topics, ['电影']);
  } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('a new topic cancels an old browser speech task without blocking the new task', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-switch-')); let server;
  try {
    server = await startFfvideo({ dataDir, staticDir, port: 0, seed: false, speech: 'browser' });
    await server.createFeed('old');
    const old = await server.store.claimJob('test');
    await server.submitDraft({ jobId: old.job.id, claimToken: old.claimToken, recipe: recipe('旧话题') });
    const previous = await waitFor(async () => (await (await fetch(server.url + '/ffapi/runtime')).json()).sessions[0]);
    await server.createFeed('new');
    const next = await server.store.claimJob('test');
    await server.submitDraft({ jobId: next.job.id, claimToken: next.claimToken, recipe: recipe('新话题') });
    const replacement = await waitFor(async () => {
      const runtime = await (await fetch(server.url + '/ffapi/runtime')).json();
      return runtime.sessions.find(s => s.id !== previous.id);
    });
    assert.equal(replacement.project.name, '新话题');
    assert.equal(server.state().jobs.find(j => j.id === old.job.id).status, 'cancelled');
  } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('startup failure releases lock and engine so the same library can be retried', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-failed-')); let server;
  try {
    await assert.rejects(startFfvideo({ dataDir, samplesDir: join(dataDir, 'missing'), staticDir, port: 0 }), /ENOENT/);
    await assert.rejects(access(join(dataDir, 'server.lock')));
    server = await startFfvideo({ dataDir, staticDir, seed: false, port: 0, speech: 'browser' });
    assert.ok(server.url.startsWith('http://127.0.0.1:'));
  } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('an authenticated public proxy origin accepts its viewer cookie alongside separate engine resource tokens', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-public-')); let server;
  const call = (url, headers) => new Promise((resolve, reject) => {
    const req = request(url, { headers }, res => { let body = ''; res.on('data', c => body += c); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body })); });
    req.on('error', reject); req.end();
  });
  try {
    server = await startFfvideo({ dataDir, staticDir, seed: false, port: 0, remoteToken: 'test-secret', publicUrl: 'https://video.example.com' });
    const headers = { Host: 'video.example.com', Origin: 'https://video.example.com' };
    assert.equal((await call(server.url + '/ffapi/state', {})).status, 401, 'public proxy rewriting Host cannot bypass authentication');
    assert.equal((await call(server.url + '/ffapi/state', headers)).status, 401);
    const first = await call(server.url + '/ffapi/state?token=test-secret', headers);
    assert.equal(first.status, 200);
    assert.match(first.headers['set-cookie'][0], /HttpOnly; SameSite=Strict; Path=\/; Secure/);
    assert.equal((await call(server.url + '/ffapi/state?token=engine-resource-token', { ...headers, Cookie: 'ffvideo_token=test-secret' })).status, 200);
    assert.equal((await call(server.url + '/ffapi/state', { ...headers, Cookie: 'ffvideo_token=wrong' })).status, 401);
    assert.equal((await call(server.url + '/ffapi/state', { ...headers, Cookie: 'ffvideo_token=%broken', Authorization: 'Bearer test-secret' })).status, 200);
  } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('permanent account/model errors stop automatic claims instead of failing every queued work', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-model-error-')); let server;
  const fake = `import {createInterface} from 'node:readline';
    const input=createInterface({input:process.stdin}); input.on('line',line=>{
      const m=JSON.parse(line); if(m.id===undefined)return;
      let result={};
      if(m.method==='model/list')result={data:[{model:'unavailable',isDefault:true}]};
      if(m.method==='thread/start')result={thread:{id:'thread'},model:'unavailable'};
      process.stdout.write(JSON.stringify(m.method==='turn/start' ?
        {jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'The model is not supported when using Codex with a ChatGPT account.'}} :
        {jsonrpc:'2.0',id:m.id,result})+'\\n');
    });`;
  try {
    server = await startFfvideo({ dataDir, staticDir, seed: false, port: 0, provider: 'codex', providerOptions: { command: process.execPath, args: ['--input-type=module', '-e', fake] } });
    await server.createFeed('模型错误验证');
    await waitFor(async () => server.generationStatus().blocked);
    assert.equal(server.state().jobs.filter(j => j.status === 'failed').length, 1);
    assert.equal(server.state().jobs.filter(j => j.status === 'queued').length, 4);
    assert.equal(server.generationStatus().connected, false);
  } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('a silent script service trips a circuit breaker and leaves the remaining queue untouched', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-silent-model-')); let server;
  const fake = `import {createInterface} from 'node:readline';
    createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line); if(m.id===undefined)return;
      let result={};
      if(m.method==='model/list')result={data:[{model:'fixture',isDefault:true}]};
      if(m.method==='thread/start')result={thread:{id:'thread'},model:'fixture'};
      if(m.method==='turn/start')result={turn:{id:'silent'}};
      process.stdout.write(JSON.stringify({id:m.id,result})+'\\n');
    });`;
  try {
    server = await startFfvideo({ dataDir, staticDir, seed: false, port: 0, provider: 'codex',
      providerOptions: { command: process.execPath, args: ['--input-type=module', '-e', fake], idleTimeoutMs: 20, generationTimeoutMs: 300 } });
    await server.createFeed('无输出验证');
    await waitFor(async () => server.generationStatus().blocked && server.state().jobs.some(j => j.status === 'failed'));
    assert.equal(server.generationStatus().status, 'blocked');
    assert.match(server.generationStatus().lastError, /没有返回新内容/);
    assert.equal(server.state().jobs.filter(j => j.status === 'failed').length, 1);
    assert.equal(server.state().jobs.filter(j => j.status === 'queued').length, 4);
  } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('clear-history removes owned drafts and live sessions while preserving manual preferences and exported files across restart', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-clear-')); let server;
  try {
    server = await startFfvideo({ dataDir, samplesDir, staticDir, port: 0, speech: 'browser' });
    await server.store.updatePreferences({ autoGenerate: false, topics: ['建筑'] });
    const work = server.state().works[0];
    await server.sessionFor(work.id);
    await server.store.addComment(work.id, '想看更多解释');
    const exported = join(dataDir, 'exports', 'retained-export.mp4');
    await writeFile(exported, 'existing export ownership marker');
    const response = await fetch(server.url + '/ffapi/history', { method: 'DELETE' });
    assert.equal(response.status, 200);
    assert.equal(server.state().works.length, 0);
    assert.ok(server.state().jobs.every(j => j.status === 'cancelled' && !j.recipe && !j.topic));
    assert.deepEqual(server.state().preferences.topics, ['建筑']);
    await assert.rejects(access(work.projectPath));
    assert.equal(await readFile(exported, 'utf8'), 'existing export ownership marker');
    assert.equal((await fetch(server.url + '/ffapi/works/' + work.id + '/session')).status, 404);
    await server.close(); server = await startFfvideo({ dataDir, samplesDir, staticDir, port: 0, speech: 'browser' });
    assert.equal(server.state().works.length, 0);
    assert.equal(server.state().seeded, true);
  } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('an explicitly selected background mode survives restart without starting model calls while auto generation is paused', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-mode-')); let server;
  try {
    const options = { dataDir, staticDir, seed: false, port: 0, providerOptions: { command: process.execPath, args: ['-e', 'process.exit(98)'] } };
    server = await startFfvideo(options);
    await server.store.updatePreferences({ autoGenerate: false });
    const response = await fetch(server.url + '/ffapi/generator', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'codex' }) });
    assert.equal(response.status, 200);
    await server.close(); server = await startFfvideo(options);
    assert.equal(server.generationStatus().mode, 'codex');
    assert.equal(server.generationStatus().connected, false);
    assert.equal(server.generationStatus().lastError, '');
    assert.equal(server.generationStatus().status, 'paused');
  } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('resuming generation starts queued work immediately and exposes the browser dependency instead of a false connection error', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-resume-')); let server;
  try {
    const output = JSON.stringify(recipe('恢复后的草稿'));
    server = await startFfvideo({ dataDir, staticDir, seed: false, port: 0, speech: 'browser',
      providerOptions: { command: process.execPath, args: ['-e', `process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(output)}));`] } });
    await server.store.updatePreferences({ autoGenerate: false });
    await fetch(server.url + '/ffapi/generator', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'command' }) });
    assert.equal(server.generationStatus().status, 'paused');
    const response = await fetch(server.url + '/ffapi/preferences', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoGenerate: true }) });
    assert.equal(response.status, 200);
    assert.equal(server.state().jobs.length, 0, 'enabling topic replenishment does not create unrelated recommendations');
    await server.createFeed('恢复制作');
    await waitFor(async () => server.generationStatus().status === 'waiting-browser');
    const status = server.generationStatus();
    assert.equal(status.connected, true);
    assert.equal(status.title, '恢复后的草稿');
    assert.equal(status.phase, 'waiting_for_browser');
    assert.equal(status.pending, 5);
  } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});
test('pausing recommendation replenishment still lets an explicitly entered topic begin its first five drafts', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-explicit-')); let server;
  try {
    const output = JSON.stringify(recipe('明确请求的新草稿'));
    server = await startFfvideo({ dataDir, staticDir, seed: false, port: 0, speech: 'browser', provider: 'command',
      providerOptions: { command: process.execPath, args: ['-e', `process.stdin.resume(); process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(output)}));`] } });
    await server.store.updatePreferences({ autoGenerate: false });
    const response = await fetch(server.url + '/ffapi/topics', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ topic: '用户明确请求' }) });
    assert.equal(response.status, 201);
    const requested = (await response.json()).feedId;
    await waitFor(async () => server.state().jobs.some(j => j.feedId === requested && j.status === 'composing'));
    assert.equal(server.state().jobs.filter(j => j.feedId === requested).length, 5);
    assert.equal(server.state().preferences.autoGenerate, false);
  } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});


test('template HTTP workflow validates required facts, composes explicit copies while paused, and leaves the original unchanged', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-template-api-')); let server;
  try {
    server = await startFfvideo({ dataDir, samplesDir, staticDir, port: 0, speech: 'browser', visualOptions: { allowRemote: false } });
    await server.store.updatePreferences({ autoGenerate: false });
    const listed = await (await fetch(server.url + '/ffapi/templates')).json();
    assert.ok(listed.templates.length >= 18);
    const id = listed.templates.find(template => !template.mediaPreset)?.id || listed.templates[0].id;
    const full = await (await fetch(server.url + '/ffapi/templates/' + id)).json();
    const post = (path, value) => fetch(server.url + path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    const initial = server.state();
    const invalid = await post('/ffapi/templates/drafts', { templateId: id, topic: '缺少事实的新话题' });
    assert.equal(invalid.status, 400);
    assert.equal(server.state().jobs.length, initial.jobs.length);
    const original = initial.works[0];
    const saved = await (await fetch(server.url + '/ffapi/works/' + original.id + '/recipe')).json();
    assert.ok(saved.recipe.narration);
    const copy = await (await post('/ffapi/works/' + original.id + '/reuse', { overrides: { title: '复制并修改的一幕', scenes: [{ index: 0, body: '更新的旁白内容。' }] } })).json();
    assert.ok(copy.jobId); assert.ok(copy.feedId);
    const job = server.state().jobs.find(job => job.id === copy.jobId);
    assert.equal(job.recipe.title, '复制并修改的一幕');
    assert.ok(job.recipe.narration.includes('更新的旁白内容。'));
    assert.equal(job.copiedFrom, original.id);
    assert.equal(job.status, 'queued', 'A reference copy waits for its own creative direction rather than filling the template');
    assert.deepEqual(server.state().works.find(work => work.id === original.id), original);
    const claim = await server.store.claimJob('design-worker');
    assert.equal(claim.job.id, copy.jobId);
    const authored = {...richDesign(),captionKeywords:['内容']}; authored.shots.forEach((shot,index) => shot.sceneIndex = index % job.recipe.scenes.length);
    await server.submitDraft({ jobId: claim.job.id, claimToken: claim.claimToken, recipe: { ...job.recipe, design: authored } });
    const pending = await waitFor(async () => (await (await fetch(server.url + '/ffapi/runtime')).json()).sessions.find(session => session.project.name === '复制并修改的一幕'));
    assert.ok(pending.project.timeline.tracks.some(track => track.items.some(item => item.clip.text)));
    const persisted = JSON.parse(await readFile(join(dataDir, 'feed-state.json'), 'utf8'));
    assert.equal(persisted.preferences.autoGenerate, false);
    assert.equal(persisted.activeFeedId, initial.activeFeedId);
  } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('topic DELETE cancels leased jobs while retaining finished works, comments and preferences', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-topic-remove-')); let server;
  try {
    server = await startFfvideo({ dataDir, staticDir, seed: false, port: 0, provider: 'agent' });
    const feed = await server.createFeed('临时话题');
    const claim = await server.store.claimJob('external-worker');
    await server.store.submitRecipe(claim.job.id, claim.claimToken, recipe('保留历史'));
    await server.store.publishWork(claim.job.id, { id: 'retained-work', durationSeconds: 20, projectPath: join(dataDir, 'history.json') });
    await server.store.addComment('retained-work', '保留评论');
    const pending = await server.store.claimJob('external-worker');
    const before = server.state();
    const response = await fetch(server.url + '/ffapi/topics/' + feed.feedId, { method: 'DELETE' });
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.feeds.some(feed => feed.id === before.activeFeedId), false);
    assert.deepEqual(result.works, before.works); assert.deepEqual(result.preferences, before.preferences);
    assert.equal(result.jobs.find(job => job.id === pending.job.id).status, 'cancelled');
    assert.equal((await fetch(server.url + '/ffapi/topics/missing', { method: 'DELETE' })).status, 404);
  } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('manual generation retry cancels a hanging script and reconnects without losing queued work', async () => {
  const dataDir = await mkdtemp(join(tmpdir(), 'ffvideo-script-retry-')); let server;
  const fake = `import readline from 'node:readline';let turn=0;readline.createInterface({input:process.stdin}).on('line',line=>{
    const m=JSON.parse(line);if(m.id===undefined)return;
    const result=m.method==='model/list'?{data:[{id:'gpt-6-astra',model:'gpt-6-astra',isDefault:true}]}:m.method==='thread/start'?{thread:{id:'thread'}}:m.method==='turn/start'?{turn:{id:'turn-'+(++turn)}}:{};
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
  });`;
  try {
    server = await startFfvideo({ dataDir, staticDir, seed: false, port: 0, provider: 'codex',
      providerOptions: { command: process.execPath, args: ['--input-type=module', '-e', fake], generationTimeoutMs: 3000 } });
    await server.createFeed('重试制作');
    await waitFor(() => server.generationStatus().status === 'working');
    const id = server.state().jobs.find(job => job.status === 'claimed').id;
    assert.equal(server.generationStatus().phase, 'script'); assert.equal(typeof server.generationStatus().elapsedSeconds, 'number');
    const result = await fetch(server.url + '/ffapi/generation/retry', { method: 'POST' }); assert.equal(result.status, 200);
    await waitFor(() => server.store.data.events.filter(event => event.type === 'job-claimed' && event.jobId === id).length >= 2);
    assert.equal(server.state().jobs.filter(job => ['queued', 'claimed'].includes(job.status)).length, 5);
    assert.equal(server.generationStatus().blocked, false);
  } finally { await server?.close(); await rm(dataDir, { recursive: true, force: true }); }
});

test('new submissions require original direction and reject geometry-only template reuse even with a different script', async t => {
  const dataDir=await mkdtemp(join(tmpdir(),'ffvideo-design-contract-')); const server=await startFfvideo({dataDir,staticDir,seed:false,port:0,speech:'browser'});
  t.after(async()=>{await server.close();await rm(dataDir,{recursive:true,force:true});});
  await server.store.updatePreferences({autoGenerate:false});await server.createFeed('原创设计验证');
  const first=await server.store.claimJob('designer');const missing=recipe('第一条');delete missing.design;
  await assert.rejects(server.submitDraft({jobId:first.job.id,claimToken:first.claimToken,recipe:missing}),/缺少原创镜头设计/);
  const plain=recipe('普通白字');plain.design=design();await assert.rejects(server.submitDraft({jobId:first.job.id,claimToken:first.claimToken,recipe:plain}),/原创文字编排/);
  assert.equal(server.state().jobs.find(j=>j.id===first.job.id).status,'claimed');
  await server.submitDraft({jobId:first.job.id,claimToken:first.claimToken,recipe:recipe('第一条')});
  const second=await server.store.claimJob('designer');const duplicate=recipe('另一份不同的文案');
  await assert.rejects(server.submitDraft({jobId:second.job.id,claimToken:second.claimToken,recipe:duplicate}),/镜头布局和标注时间.*重复/);
  duplicate.design={...richDesign(5),captionKeywords:['文案']};await server.submitDraft({jobId:second.job.id,claimToken:second.claimToken,recipe:duplicate});
  assert.equal(server.state().jobs.find(j=>j.id===second.job.id).status,'composing');
});

import { richDesign as design } from './fixtures/direction.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { createMcpHandler, serveMcp, MCP_TOOLS } from '../server/mcp.mjs';
import { createHostConfig } from '../hosts/config.mjs';

const request = (id, method, params) => ({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) });
const tool = (id, name, args = {}) => request(id, 'tools/call', { name, arguments: args });
const validRecipe = () => ({ design: {...design(),captionKeywords:['水滴','足够重']}, title: '雨为什么会落下来', narration: '云中的水滴逐渐长大，足够重时就会落下，形成我们看到的雨。', tags: ['天气'], language: 'zh', scenes: [{ heading: '小水滴长大', body: '水滴逐渐聚集，最后落向地面。', seconds: 12 }] });

function fixture() {
  const state = { cursor: 0, epoch: 1, preferences: { format: 'webm', autoGenerate: true },
    works: [{ id: 'work-1', status: 'ready', comments: [] }], jobs: [{ id: 'job-1', status: 'queued' }], feeds: [], interest: {} };
  const calls = [], listeners = new Set();
  const store = {
    state: () => structuredClone(state),
    updatePreferences: async (patch) => { calls.push(['preferences', patch]); Object.assign(state.preferences, patch); return structuredClone(state.preferences); },
    claimJob: async (workerId) => { calls.push(['claim', workerId]); return { job: { id: 'job-1', topic: '雨' }, claimToken: 'owned-token' }; },
    addComment: async (id, text) => { calls.push(['comment', id, text]); return { id: 'comment-1', workId: id, text }; },
    waitEvents: async (cursor, timeout, signal) => { calls.push(['wait', cursor, timeout]); return { events: [], nextCursor: cursor, timedOut: true, readyCount: 1, epoch: 1 }; },
    subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener); }
  };
  const handler = createMcpHandler({ store, baseUrl: 'http://127.0.0.1:4320/',
    createFeed: async (topic) => { calls.push(['feed', topic]); return { feedId: 'feed-1', ...store.state() }; },
    submitDraft: async (a) => { calls.push(['submit', a]); return { id: a.jobId, status: 'composing' }; },
    getWork: async (id) => { calls.push(['work', id]); return { id, status: 'ready', audio: '/audio/real.wav' }; },
    exportWork: async (id, format) => { calls.push(['export', id, format]); return { status: 'complete', path: `/exports/${id}.${format}` }; },
    createTemplateDraft: async (a) => { calls.push(['template', a]); return { feedId: 'template-feed', jobId: 'template-job' }; },
    reuseDraft: async (a) => { calls.push(['reuse', a]); return { feedId: 'copied-feed', jobId: 'copied-job' }; },
    generationStatus: () => ({ mode: 'agent', connected: true }) });
  return { handler, store, state, calls, listeners, emit(type, patch = {}) {
    Object.assign(state, patch); state.cursor++;
    for (const listener of listeners) listener({ type, cursor: state.cursor, epoch: state.epoch, state: store.state(), text: 'SECRET untrusted raw comment', claimToken: 'SECRET claim' });
  } };
}
async function until(predicate, ms = 2000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const value = predicate(); if (value) return value; await delay(5); }
  throw new Error('Timed out waiting for protocol output');
}
function stdio(f, options = {}) {
  const input = new PassThrough(), messages = [], chunks = [];
  const output = new Writable({ write(chunk, encoding, done) {
    const text = chunk.toString(); chunks.push(text);
    for (const line of text.trim().split('\n')) if (line) messages.push(JSON.parse(line));
    done();
  } });
  const done = serveMcp(f.handler, { input, output, store: f.store, ...options });
  return { messages, chunks, input, done,
    send: value => input.write(JSON.stringify(value) + '\n'),
    response: id => until(() => messages.find(item => item.id === id)),
    close: async () => { input.end(); await done; } };
}
function awaitAbort(signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) reject(signal.reason);
    else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
  });
}

test('MCP initialize/tools stay within implemented protocol and provide readable structured results', async () => {
  const f = fixture();
  const initialized = await f.handler(request(1, 'initialize', { protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'test', version: '1' } }));
  assert.equal(initialized.result.protocolVersion, '2024-11-05');
  assert.deepEqual(initialized.result.capabilities, { tools: {} });
  assert.equal((await f.handler(request(2, 'server/discover'))).error.code, -32601);
  assert.equal((await f.handler(request(3, 'resources/list'))).error.code, -32601);
  const listed = await f.handler(request(4, 'tools/list'));
  assert.equal(listed.result.tools.length, MCP_TOOLS.length);
  assert.deepEqual(listed.result.tools.map(item => item.name), MCP_TOOLS.map(item => item.name));
  assert.equal(listed.result.tools.find(item => item.name === 'add_comment').annotations.readOnlyHint, false);
  const opened = await f.handler(tool(5, 'open_feed'));
  assert.equal(opened.result.structuredContent.previewUrl, 'http://127.0.0.1:4320');
  assert.deepEqual(JSON.parse(opened.result.content[0].text), opened.result.structuredContent);
  assert.equal(opened.result.structuredContent.generation.connected, true);
});

test('unknown fields, invalid values and total scene overflow fail as tool errors before mutation', async () => {
  const f = fixture();
  const invalid = [
    ['create_topic_feed', { topic: '雨', command: 'malicious' }],
    ['set_preferences', { preferences: { autoGenerate: 'true' } }],
    ['set_preferences', { preferences: { voice: 'bad voice' } }],
    ['wait_feed_events', { cursor: 0, timeoutMs: 20001 }],
    ['wait_feed_events', { cursor: 0.5 }],
    ['add_comment', { workId: 'work-1', text: '   ' }],
    ['export_video', { workId: 'work-1', format: 'mov' }],
    ['submit_draft', { jobId: 'job-1', claimToken: 'owned-token', recipe: { ...validRecipe(), audio: 'fake' } }],
    ['submit_draft', { jobId: 'job-1', claimToken: 'owned-token', recipe: { ...validRecipe(), scenes: Array.from({ length: 4 }, () => ({ heading: 'a', body: 'b', seconds: 60 })) } }]
  ];
  for (const [name, args] of invalid) {
    const response = await f.handler(tool(1, name, args));
    assert.equal(response.result.isError, true, name);
    assert.equal(response.result.structuredContent.code, 'INVALID_ARGUMENT', name);
    assert.equal(response.error, undefined, 'tool failures are not framing failures');
  }
  assert.equal(f.calls.length, 0);
  assert.equal((await f.handler(tool(10, 'delete_everything'))).result.structuredContent.code, 'UNKNOWN_TOOL');
});

test('tools forward the validated claim, recipe, comment, preference and export arguments', async () => {
  const f = fixture();
  assert.equal((await f.handler(tool(1, 'create_topic_feed', { topic: '雨' }))).result.structuredContent.feedId, 'feed-1');
  assert.equal((await f.handler(tool(2, 'claim_generation_job', { workerId: 'session-A' }))).result.structuredContent.claimToken, 'owned-token');
  const args = { jobId: 'job-1', claimToken: 'owned-token', recipe: validRecipe() };
  assert.equal((await f.handler(tool(3, 'submit_draft', args))).result.structuredContent.status, 'composing');
  await f.handler(tool(4, 'add_comment', { workId: 'work-1', text: '请多讲水循环' }));
  await f.handler(tool(5, 'set_preferences', { preferences: { autoplay: false } }));
  const waited = await f.handler(tool(6, 'wait_feed_events', { cursor: 9, timeoutMs: 0 }));
  assert.equal(waited.result.structuredContent.nextCursor, 9);
  assert.equal((await f.handler(tool(7, 'get_work', { workId: 'work-1' }))).result.structuredContent.audio, '/audio/real.wav');
  assert.equal((await f.handler(tool(8, 'export_video', { workId: 'work-1' }))).result.structuredContent.path, '/exports/work-1.webm');
  assert.deepEqual(f.calls.find(item => item[0] === 'submit')[1], args);
  assert.deepEqual(f.calls.find(item => item[0] === 'comment'), ['comment', 'work-1', '请多讲水循环']);
  assert.deepEqual(f.calls.find(item => item[0] === 'wait'), ['wait', 9, 0]);
});

test('notification calls cannot execute tools and malformed framing is a JSON-RPC error', async () => {
  const f = fixture();
  assert.equal(await f.handler({ jsonrpc: '2.0', method: 'tools/call', params: { name: 'add_comment', arguments: { workId: 'work-1', text: 'injected' } } }), undefined);
  assert.equal(f.calls.length, 0);
  for (const value of [null, [], { jsonrpc: '1.0', method: 'ping' }, request({}, 'ping')]) {
    assert.equal((await f.handler(value)).error.code, -32600);
  }
  assert.equal((await f.handler(request(1, 'initialize', {}))).error.code, -32602);
  assert.equal((await f.handler(request(1, 'tools/call', {}))).error.code, -32602);
});

test('stdio keeps ping responsive during waits, matches cancellation by request id, and writes only JSON', async () => {
  const f = fixture();
  f.store.waitEvents = async (cursor, timeout, signal) => { f.calls.push(['wait-started']); return awaitAbort(signal); };
  const io = stdio(f);
  try {
    io.send(tool('waiting', 'wait_feed_events', { cursor: 0 }));
    await until(() => f.calls.length);
    io.send(request(2, 'ping'));
    assert.deepEqual((await io.response(2)).result, {});
    io.send({ jsonrpc: '1.0', method: 'notifications/cancelled', params: { requestId: 'waiting' } });
    await until(() => io.messages.find(item => item.error?.code === -32600));
    assert.equal(io.messages.some(item => item.id === 'waiting'), false);
    io.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 'waiting', reason: 'user chat priority' } });
    assert.equal((await io.response('waiting')).result.structuredContent.code, 'CANCELLED');
    assert.ok(io.chunks.every(chunk => chunk.endsWith('\n')));
  } finally { await io.close(); }
});

test('stdio EOF cancels pending waits but flushes their replies, including final unterminated input', async () => {
  const f = fixture();
  f.store.waitEvents = async (cursor, timeout, signal) => awaitAbort(signal);
  const io = stdio(f);
  io.send(tool(1, 'wait_feed_events', { cursor: 0 }));
  io.input.end(JSON.stringify(request(2, 'ping')));
  await io.done;
  assert.deepEqual(io.messages.find(item => item.id === 2).result, {});
  assert.equal(io.messages.find(item => item.id === 1).result.structuredContent.code, 'CANCELLED');
  assert.equal(f.listeners.size, 0);
});

test('stdio rejects duplicate active ids and recovers after bounded oversized input', async () => {
  const f = fixture();
  f.store.waitEvents = async (cursor, timeout, signal) => awaitAbort(signal);
  const io = stdio(f);
  try {
    io.send(tool('same', 'wait_feed_events', { cursor: 0 }));
    io.send(request('same', 'ping'));
    await until(() => io.messages.find(item => item.id === 'same' && item.error?.code === -32600));
    io.input.write('x'.repeat(1024 * 1024 + 1));
    io.input.write('\n');
    io.send(request(3, 'ping'));
    assert.deepEqual((await io.response(3)).result, {});
    assert.equal(io.messages.filter(item => item.error?.message === 'Message exceeds 1 MiB').length, 1);
  } finally { await io.close(); }
});

test('native Channels require explicit supported-host opt-in and never advertise permission relay', async () => {
  const f = fixture();
  await assert.rejects(serveMcp(f.handler, { channels: 'true', host: 'claude', store: f.store }), /explicit boolean/);
  await assert.rejects(serveMcp(f.handler, { channels: true, host: 'workbuddy', store: f.store }), /host=claude or host=codebuddy/);
  for (const host of ['claude', 'codebuddy']) {
    const io = stdio(f, { channels: true, host });
    try {
      io.send(request(1, 'initialize', { protocolVersion: '2024-11-05' }));
      const initialized = await io.response(1);
      assert.deepEqual(initialized.result.capabilities.experimental, { 'claude/channel': {} });
      assert.equal(initialized.result.capabilities.experimental['claude/channel/permission'], undefined);
    } finally { await io.close(); }
  }
});

test('Channels coalesce comments without forwarding text/tokens; new queued work pushes but watch heartbeats do not', async () => {
  const f = fixture(), io = stdio(f, { channels: true, host: 'claude' });
  const notifications = () => io.messages.filter(item => item.method === 'notifications/claude/channel');
  try {
    f.emit('comment');
    io.send(request(1, 'initialize', { protocolVersion: '2024-11-05' }));
    await io.response(1);
    io.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    io.send(request(2, 'ping')); await io.response(2);
    f.emit('events'); await delay(550);
    assert.equal(notifications().length, 0);
    f.emit('comment'); f.emit('comment'); f.emit('comment');
    await until(() => notifications().length === 1);
    const pushed = notifications()[0];
    assert.equal(pushed.params.meta.feed_cursor, String(f.state.cursor));
    assert.ok(Object.values(pushed.params.meta).every(value => typeof value === 'string'));
    assert.equal(JSON.stringify(pushed).includes('SECRET'), false);
    f.emit('claim', { jobs: [] }); await delay(550);
    assert.equal(notifications().length, 1);
    f.emit('events', { jobs: [{ id: 'fresh-job', status: 'queued' }] });
    await until(() => notifications().length === 2);
    assert.match(notifications()[1].params.content, /1 queued jobs/);
  } finally { await io.close(); }
  assert.equal(f.listeners.size, 0);
});

test('host configuration is explicit, handles each transport and refuses unsupported channel/cloud-local claims', () => {
  const local = createHostConfig('codex', { command: '/path with spaces/node', args: ['/project/ffvideo.mjs', '--mcp'], directory: '/feeds' });
  assert.equal(local.transport, 'stdio');
  assert.deepEqual(local.config.mcp_servers.ffvideo.args, ['/project/ffvideo.mjs', '--mcp', '--data-dir', '/feeds']);
  assert.match(local.configText, /\[mcp_servers.ffvideo\]/);
  const remote = createHostConfig('codex', { url: 'https://video.example.com/mcp' });
  assert.match(remote.configText, /bearer_token_env_var = "FFVIDEO_MCP_TOKEN"/);
  const literal = createHostConfig('codex', { url: 'https://video.example.com/mcp', token: 'ffvideo-test-token' });
  assert.match(literal.configText, /\[mcp_servers.ffvideo.http_headers\]/);
  assert.match(literal.configText, /Bearer ffvideo-test-token/);
  for (const host of ['claude', 'codebuddy', 'workbuddy', 'qoder']) {
    assert.equal(createHostConfig(host).config.mcpServers.ffvideo.type, 'stdio');
    assert.equal(createHostConfig(host, { url: 'https://video.example.com/mcp' }).config.mcpServers.ffvideo.type, host === 'workbuddy' ? 'streamableHttp' : 'http');
  }
  assert.ok(createHostConfig('claude', { channels: true }).config.mcpServers.ffvideo.args.includes('--channels'));
  assert.throws(() => createHostConfig('qoder', { channels: true }), /only/);
  assert.throws(() => createHostConfig('claude', { channels: 'false' }), /explicit boolean/);
  assert.throws(() => createHostConfig('claude', { channels: true, url: 'https://video.example.com/mcp' }), /stdio/);
  for (const url of ['http://localhost:4320/mcp', 'https://127.0.0.1/mcp', 'https://[::1]/mcp', 'http://video.example.com/mcp'])
    assert.throws(() => createHostConfig('chatgpt', { url }), /ChatGPT needs/);
  const cloud = createHostConfig('chatgpt', { url: 'https://video.example.com/mcp' });
  assert.equal(cloud.config.connection.url, 'https://video.example.com/mcp');
  assert.equal(cloud.config.mcpServers, undefined);
  assert.match(cloud.launchInstructions.join(' '), /not a ChatGPT JSON import/);
  assert.equal(createHostConfig('chatgpt').transport, 'manual');
});


test('template tools expose copies, missing fields, and validated local modification requests', async () => {
  const f = fixture();
  const listed = (await f.handler(tool(1, 'list_draft_templates'))).result.structuredContent.templates;
  assert.ok(listed.length >= 18);
  const id = listed[0].id;
  const full = (await f.handler(tool(2, 'get_draft_template', { templateId: id }))).result.structuredContent;
  const copy = (await f.handler(tool(3, 'instantiate_draft_template', { templateId: id }))).result.structuredContent;
  assert.deepEqual(copy.recipe, full.example.recipe);
  const custom = (await f.handler(tool(4, 'instantiate_draft_template', { templateId: id, topic: '自定义话题' }))).result.structuredContent;
  assert.equal(custom.recipe, null); assert.ok(custom.missingFields.length);
  assert.equal(f.calls.length, 0);
  const args = { templateId: id, values: full.example.values, overrides: { scenes: [{ index: 0, body: '局部修改后的旁白。' }] } };
  assert.equal((await f.handler(tool(5, 'create_template_draft', args))).result.structuredContent.jobId, 'template-job');
  const reuse = { workId: 'work-1', overrides: { title: '复制作品', scenes: [{ index: 0, heading: '新标题' }] } };
  await f.handler(tool(6, 'reuse_draft', reuse));
  assert.deepEqual(f.calls, [['template', args], ['reuse', reuse]]);
  for (const bad of [{ values: { a: 3 } }, { overrides: { script: 'unsafe' } }, { overrides: { scenes: [{ index: -1, body: 'x' }] } }]) {
    assert.equal((await f.handler(tool(7, 'create_template_draft', { templateId: id, ...bad }))).result.isError, true);
  }
  assert.equal(f.calls.length, 2);
});

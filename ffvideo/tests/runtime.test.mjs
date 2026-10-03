import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { build } from 'esbuild';

const mocks = {
  vue: 'export const reactive = value => value;',
  '../../packages/client/index.mjs': 'export const VideoCutClient = globalThis.harness.Client;',
  '../../src/editor/tts-jobs': 'export const TtsJobCoordinator = globalThis.harness.Tts;',
  '../../src/editor/template-export': 'export const renderTemplateExport = (...args) => globalThis.harness.render(...args);',
  '../../packages/media/browser': 'export const sharedMediaEngine = { invalidate() {} };'
};
const compiled = await build({
  entryPoints: [new URL('../src/runtime.ts', import.meta.url).pathname],
  bundle: true, platform: 'node', format: 'cjs', write: false, logLevel: 'silent',
  plugins: [{ name: 'runtime-boundaries', setup(builder) {
    builder.onResolve({ filter: /.*/ }, args => args.path in mocks ? { path: args.path, namespace: 'runtime-mock' } : undefined);
    builder.onLoad({ filter: /.*/, namespace: 'runtime-mock' }, args => ({ contents: mocks[args.path], loader: 'js' }));
  } }]
});

const snapshot = id => ({ id, version: 1, project: { name: id } });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
const settle = async () => { for (let i = 0; i < 10; i++) await Promise.resolve(); };

function environment() {
  const h = {
    sources: new Set(), allSources: [], coordinators: new Map(), jobs: new Map(),
    runtime: [], maximum: 0, queue: [], checks: new Map(), heldChecks: new Map(), renders: new Map()
  };
  // Model HTTP/1's shared six-connection pool: an SSE holds its slot until close().
  h.network = operation => new Promise((resolve, reject) => {
    const run = () => { Promise.resolve().then(operation).then(resolve, reject); };
    if (h.sources.size >= 6) h.queue.push(run); else run();
  });
  h.drain = () => { if (h.sources.size < 6) for (const run of h.queue.splice(0)) run(); };
  h.EventSource = class {
    listeners = new Map();
    constructor(url) {
      this.id = url.split('/').at(-1);
      h.sources.add(this); h.allSources.push(this);
      h.maximum = Math.max(h.maximum, h.sources.size);
    }
    addEventListener(type, listener) {
      const listeners = this.listeners.get(type) || [];
      listeners.push(listener); this.listeners.set(type, listeners);
    }
    emit(type, data) { for (const listener of this.listeners.get(type) || []) listener({ data: JSON.stringify(data) }); }
    close() { h.sources.delete(this); this.closed = true; h.drain(); }
  };
  h.Client = class {
    constructor(url) { this.url = url; }
    async connect() { return {}; }
    eventsUrl(id) { return `${this.url}/events/${id}`; }
    request(path) {
      const id = path.split('/')[2];
      h.checks.set(id, (h.checks.get(id) || 0) + 1);
      return h.network(() => h.heldChecks.get(id)?.promise || { phase: 'idle' });
    }
  };
  h.Tts = class {
    constructor(_client, id, _source, receive) {
      this.id = id; this.receive = receive;
      h.coordinators.set(id, this);
      receive(h.jobs.get(id) || null);
    }
    dispose() { this.disposed = true; }
  };
  h.setJob = (id, state) => {
    const job = { id: `speech-${id}`, state };
    h.jobs.set(id, job); h.coordinators.get(id)?.receive(job);
  };
  h.render = (_client, id, jobId) => {
    const pending = deferred(); h.renders.set(jobId, { ...pending, id }); return pending.promise;
  };
  const module = { exports: {} };
  vm.runInNewContext(compiled.outputFiles[0].text, {
    module, exports: module.exports, harness: h, location: { origin: 'http://feed.test' },
    EventSource: h.EventSource, AbortController,
    setInterval: () => 1, clearInterval: () => {},
    fetch: path => h.network(() => ({ ok: true, json: async () => path.endsWith('/runtime') ? { sessions: [...h.runtime] } : { works: ['latest'] } }))
  });
  return { h, runtime: new module.exports.FeedRuntime(), api: module.exports.api };
}

test('rapid playback switches keep one read-only SSE and leave HTTP requests able to complete', { timeout: 2000 }, async () => {
  const { h, runtime, api } = environment();
  try {
    await runtime.start();
    for (let i = 0; i < 30; i++) {
      await runtime.activate(snapshot(`work-${i}`));
      assert.equal(h.sources.size, 1);
      assert.deepEqual((await api('/state')).works, ['latest']);
    }
    assert.equal(h.maximum, 1);
    assert.equal(h.queue.length, 0);
    assert.ok(h.allSources.slice(0, -1).every(source => source.closed));
    runtime.deactivate();
    assert.equal(h.sources.size, 0);
  } finally { runtime.dispose(); }
});

test('refresh releases completed subscriptions before requesting a connection from an exhausted pool', { timeout: 2000 }, async () => {
  const { h, runtime, api } = environment();
  try {
    await runtime.start();
    for (let i = 0; i < 6; i++) {
      h.jobs.set(`speech-${i}`, { id: `tts-${i}`, state: 'running' });
      await runtime.activate(snapshot(`speech-${i}`));
    }
    assert.equal(h.sources.size, 6);
    for (let i = 0; i < 6; i++) h.setJob(`speech-${i}`, 'completed');
    await runtime.refresh();
    assert.equal(h.sources.size, 1, 'Only the selected work still needs its snapshot subscription');
    assert.equal(h.queue.length, 0);
    assert.deepEqual((await api('/state')).works, ['latest']);
  } finally { runtime.dispose(); }
});

test('playback cleanup preserves queued speech and active exports, then releases each after completion', { timeout: 2000 }, async () => {
  const { h, runtime } = environment();
  try {
    await runtime.start();
    h.jobs.set('speech', { id: 'tts', state: 'queued' });
    await runtime.activate(snapshot('speech'));
    await runtime.activate(snapshot('export'));
    const exportSource = h.allSources.find(source => source.id === 'export');
    exportSource.emit('render-request', { id: 'render-one' });
    await settle();
    assert.ok(h.renders.has('render-one'));
    for (let i = 0; i < 20; i++) await runtime.activate(snapshot(`next-${i}`));
    assert.deepEqual([...h.sources].map(source => source.id).sort(), ['export', 'next-19', 'speech']);
    assert.equal(h.maximum, 3);
    runtime.deactivate();
    assert.equal(h.sources.size, 2);
    assert.equal(h.coordinators.get('speech').disposed, undefined);
    assert.equal(exportSource.closed, undefined);
    h.setJob('speech', 'completed');
    h.renders.get('render-one').resolve();
    await settle();
    await runtime.refresh();
    assert.equal(h.sources.size, 0);
    assert.equal(h.coordinators.get('speech').disposed, true);
    assert.equal(exportSource.closed, true);
  } finally { runtime.dispose(); }
});

test('server-discovered background work survives selection changes before its speech state arrives', { timeout: 2000 }, async () => {
  const { h, runtime } = environment();
  try {
    h.runtime = [snapshot('pending-speech')];
    await runtime.start();
    await runtime.activate(snapshot('playing'));
    runtime.deactivate();
    assert.deepEqual([...h.sources].map(source => source.id), ['pending-speech']);
    h.runtime = [];
    await runtime.refresh();
    assert.equal(h.sources.size, 0);
  } finally { runtime.dispose(); }
});

test('a slow export discovery is not duplicated by repeated runtime polling', { timeout: 2000 }, async () => {
  const { h, runtime } = environment();
  try {
    await runtime.start();
    const check = deferred(); h.heldChecks.set('playing', check);
    await runtime.activate(snapshot('playing'));
    for (let i = 0; i < 10; i++) await runtime.refresh();
    assert.equal(h.checks.get('playing'), 1, 'A queued or slow GET must not grow an unbounded request backlog');
    h.heldChecks.delete('playing'); check.resolve({ phase: 'idle' });
    await settle();
    await runtime.refresh();
    assert.equal(h.checks.get('playing'), 2, 'Discovery can resume after the previous request completes');
  } finally { runtime.dispose(); }
});

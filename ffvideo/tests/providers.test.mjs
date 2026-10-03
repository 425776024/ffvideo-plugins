import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Writable, PassThrough } from 'node:stream';
import { CodexRecipeProvider, CommandRecipeProvider, CodexEventBridge, RECIPE_SCHEMA, generationPrompt, recipeWorkerConfig, recipeEffort, groundCaptionKeywords } from '../server/providers.mjs';
import { listTemplates, getTemplate, pickTemplate } from '../server/templates.mjs';

const draft = title => ({ title, narration: `A supplied script for ${title}.`, tags: ['science'], language: 'en',
  scenes: [{ heading: 'Question', body: 'An example.' }, { heading: 'Explanation', body: 'The explanation.' }] });
const state = { preferences: { durationSeconds: 25, language: 'en' }, works: [] };
const job = { id: 'job-1', topic: 'science', angle: 'different angles' };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };

test('one planning prompt follows the topic, with optional relevant inventory and authored text composition',()=>{
 const material={id:'stock-1',kind:'video',subject:'Coffee brewing.webm',queries:['coffee brewing'],durationSeconds:12};
 const prompt=generationPrompt(job,{...state,materialInventory:[material]});
 const input=JSON.parse(prompt.slice(prompt.lastIndexOf('\n')+1));assert.deepEqual(input.availableMaterials,[material]);
 assert.match(prompt,/not film templates/);assert.match(prompt,/never bend an arbitrary user topic/);assert.match(prompt,/Do not produce new bitmap assets/);
 assert.match(prompt,/Text composition is central/);assert.match(prompt,/share a baseline/);assert.match(prompt,/short EXACT substrings/);
});

test('automatic duration varies editorial targets within 20–60 seconds while fixed mode honors the chosen target', () => {
  const jobs = Array.from({ length: 8 }, (_, index) => ({ ...job, id: `duration-${index}`, feedId: 'duration-feed' }));
  const durations = jobs.map(item => {
    const prompt = generationPrompt(item, { ...state, jobs, preferences: { ...state.preferences, durationMode: 'auto', visualPreference: 'video-first' } });
    assert.match(prompt, /within 20 to 60 seconds/);
    assert.match(prompt, /server creates full subtitles from narration/);
    assert.match(prompt, /not a slide deck/);
    assert.match(prompt, /actual licensed video first/);
    return Number(/roughly (\d+) seconds/.exec(prompt)[1]);
  });
  assert(durations.every(value => value >= 20 && value <= 60));
  assert(new Set(durations).size >= 4);
  assert.match(generationPrompt(job, { ...state, preferences: { ...state.preferences, durationMode: 'fixed', durationSeconds: 45 } }), /target of 45 seconds/);
});

class FakeChild extends EventEmitter {
  constructor(onRequest) {
    super(); this.killed = false; this.requests = []; this.stdout = new PassThrough(); this.stderr = new PassThrough();
    let buffer = '';
    this.stdin = new Writable({ write: (bytes, encoding, callback) => {
      buffer += bytes.toString();
      while (buffer.includes('\n')) {
        const split = buffer.indexOf('\n'), line = buffer.slice(0, split); buffer = buffer.slice(split + 1);
        if (!line) continue;
        const message = JSON.parse(line); this.requests.push(message); onRequest(this, message);
      }
      callback();
    } });
  }
  send(message) { this.stdout.write(JSON.stringify(message) + '\n'); }
  reply(request, result = {}) { this.send({ jsonrpc: '2.0', id: request.id, result }); }
  notify(method, params) { this.send({ jsonrpc: '2.0', method, params }); }
  kill() {
    if (this.killed) return; this.killed = true;
    queueMicrotask(() => { this.stdout.end(); this.stderr.end(); this.emit('exit', 0); this.emit('close', 0); });
  }
}
function codexChild(onTurn, onInitialize, onModels, onThreadStart) {
  let turn = 0;
  return new FakeChild((child, request) => {
    if (request.method === 'initialize') { if (onInitialize) onInitialize(child, request); else child.reply(request); }
    if (request.method === 'model/list') { if (onModels) onModels(child, request); else child.reply(request, { data: [{ id: 'gpt-6-astra', model: 'gpt-6-astra', isDefault: true, hidden: false }] }); }
    if (request.method === 'config/read') child.reply(request, { config: { mcp_servers: { 'unrelated.server': { command: 'never-start', env: { SECRET: 'not-forwarded' } } }, plugins: { 'unused@plugin': { enabled: true } } } });
    if (request.method === 'thread/start') { if (onThreadStart) onThreadStart(child, request); else child.reply(request, { thread: { id: 'thread-1' } }); }
    if (request.method === 'turn/start') onTurn(child, request, `turn-${++turn}`);
    if (request.method === 'turn/interrupt') child.reply(request);
  });
}
function completed(child, turnId, recipe, threadId = 'thread-1') {
  child.notify('turn/completed', { threadId, turn: { id: turnId, status: 'completed', items: [{ type: 'agentMessage', id: `${turnId}-message`, text: JSON.stringify(recipe) }] } });
}

test('Codex structured output schema recursively requires every declared object property', () => {
  const inspect = (schema, path) => {
    if (schema.type === 'object' || schema.properties) {
      assert.equal(schema.additionalProperties, false, `${path}: strict objects must reject extra properties`);
      assert.deepEqual([...schema.required].sort(), Object.keys(schema.properties).sort(), `${path}: every declared property must be required`);
      for (const [key, property] of Object.entries(schema.properties)) inspect(property, `${path}.${key}`);
    }
    if (schema.items) inspect(schema.items, `${path}[]`);
    for (const union of ['anyOf', 'oneOf', 'allOf'])
      for (const [index, member] of (schema[union] || []).entries()) inspect(member, `${path}.${union}[${index}]`);
  };
  inspect(RECIPE_SCHEMA, 'recipe');
});
test('Codex uses low effort only when the account default model explicitly advertises support', async () => {
  for (const supported of [true, false]) {
    const child = codexChild((child, request, turnId) => {
      assert.equal(request.params.effort, supported ? 'low' : undefined);
      child.reply(request, { turn: { id: turnId } }); queueMicrotask(() => completed(child, turnId, draft('FAST')));
    }, undefined, (child, request) => child.reply(request, { data: [{ model: 'gpt-6-astra', isDefault: true,
      supportedReasoningEfforts: supported ? [{ reasoningEffort: 'low' }] : [] }] }));
    const provider = new CodexRecipeProvider({ spawnProcess: () => child });
    try { assert.equal((await provider.generate(job, state)).title, 'FAST'); assert.equal(provider.actualModel, 'gpt-6-astra'); }
    finally { provider.close(); }
  }
});

test('minimum reasoning honors none/minimal when advertised and standard honors the model default', () => {
  const supported = ['high', 'low', 'none', 'medium'];
  assert.equal(recipeEffort(supported), 'none');
  assert.equal(recipeEffort(['low', 'minimal']), 'minimal');
  assert.equal(recipeEffort(supported, 'standard', 'medium'), 'medium');
  assert.equal(recipeEffort([], 'fast'), undefined);
  assert.equal(recipeEffort([], 'none'), 'none', 'explicit off must not silently inherit deep reasoning');
});
test('invalid caption accents do not force a new script while complete narration and authored design remain unchanged', () => {
  const input = { ...draft('Caption grounding'), narration: '每天走一段路，减少含糖饮料。',
    design: { captionKeywords: ['走一段路', '健康减脂', '含糖饮料'], shots: [{ authored: true }], typography: [{ authored: true }] } };
  const output = groundCaptionKeywords(input);
  assert.deepEqual(output.design.captionKeywords, ['走一段路', '含糖饮料']);
  assert.equal(output.narration, input.narration); assert.equal(output.scenes, input.scenes);
  assert.equal(output.design.shots, input.design.shots); assert.equal(output.design.typography, input.design.typography);
  assert.deepEqual(input.design.captionKeywords, ['走一段路', '健康减脂', '含糖饮料']);
  const invalid = { ...input, design: { ...input.design, captionKeywords: ['虚构词语'] } };
  assert.equal(groundCaptionKeywords(invalid), invalid, 'no valid authored emphasis remains: strict validation must still reject it');
});
test('background Codex grounds partial caption accents in one completed model turn', async t => {
  const recipe = { ...draft('One turn'), narration: 'A useful explanation.', design: { captionKeywords: ['useful', 'fictional'] } };
  const child = codexChild((child, request, turnId) => {
    child.reply(request, { turn: { id: turnId } }); queueMicrotask(() => completed(child, turnId, recipe));
  });
  const provider = new CodexRecipeProvider({ spawnProcess: () => child }); t.after(() => provider.close());
  const result = await provider.generate(job, state);
  assert.deepEqual(result.design.captionKeywords, ['useful']); assert.equal(result.narration, recipe.narration);
  assert.equal(child.requests.filter(request => request.method === 'turn/start').length, 1);
  const retryInput = JSON.parse(generationPrompt({ ...job, error: '字幕强调词必须来自真实旁白' }, state).split('\n').at(-1));
  assert.equal(retryInput.previousValidationError, '字幕强调词必须来自真实旁白');
});
test('the saved gpt-6-luna choice and no-reasoning request take effect without substituting an advertised model', async t => {
  const child = codexChild((child, request, turnId) => {
    assert.equal(request.params.effort, 'none');
    child.reply(request, { turn: { id: turnId } }); queueMicrotask(() => completed(child, turnId, draft('LUNA')));
  });
  const provider = new CodexRecipeProvider({ spawnProcess: () => child }); t.after(() => provider.close());
  const result = await provider.generate(job, { ...state, preferences: { ...state.preferences, generationModel: 'gpt-6-luna', reasoningMode: 'none' } });
  assert.equal(result.title, 'LUNA');
  assert.equal(child.requests.find(r => r.method === 'thread/start').params.model, 'gpt-6-luna');
  assert.equal(provider.actualModel, 'gpt-6-luna'); assert.equal(provider.actualEffort, 'none');
});

test('both recipe providers send a picture-led contract with short captions and independent shot search queries', async t => {
  const visual = { ...draft('A visual explanation'), visualTheme: '海岸暖色与空气示意图', visualStyle: 'mixed',
    scenes: Array.from({ length: 3 }, (_, index) => ({ heading: `Shot ${index + 1}`, body: 'A short subtitle.',
      seconds: [8, 9, 8][index], visualPrompt: `第${index + 1}个不同的海岸镜头`, visualQuery: ['sunset ocean', 'atmosphere scattering', 'sunset clouds'][index] })) };
  const prompt = generationPrompt(job, state);
  assert.match(prompt, /Always supply visualTheme and visualStyle/);
  assert.match(prompt, /visualPrompt plus visualQuery for every scene/);
  assert.match(prompt, /never invent URLs, local paths, source credits/);
  assert.match(prompt, /no paragraph cards/);
  assert.equal(JSON.parse(prompt.slice(prompt.lastIndexOf('\n') + 1)).topic, 'science');
  const codexChildInstance = codexChild((child, request, turnId) => {
    assert.deepEqual(request.params.outputSchema, RECIPE_SCHEMA);
    assert.equal(request.params.input[0].text, prompt);
    assert.equal(request.params.outputSchema.properties.scenes.minItems, 3);
    assert.equal(request.params.outputSchema.properties.scenes.maxItems, 5);
    child.reply(request, { turn: { id: turnId } });
    queueMicrotask(() => completed(child, turnId, visual));
  });
  const codex = new CodexRecipeProvider({ spawnProcess: () => codexChildInstance }); t.after(() => codex.close());
  assert.deepEqual(await codex.generate(job, state), visual);
  const commandChild = new FakeChild((child, request) => {
    assert.equal(request.prompt, prompt); assert.deepEqual(request.schema, RECIPE_SCHEMA);
    child.stdout.end(JSON.stringify(visual)); child.emit('close', 0);
  });
  const command = new CommandRecipeProvider({ command: 'fixture', spawnProcess: () => commandChild }); t.after(() => command.close());
  assert.deepEqual(await command.generate(job, state), visual);
});

test('template guidance honors an explicit scenario and language without changing the strict recipe output shape', () => {
  const automatic = pickTemplate('木瓜营养特点');
  const selected = getTemplate(listTemplates().find(template => template.id !== automatic.id).id);
  const text = generationPrompt({ ...job, topic: '木瓜营养特点', templateId: selected.id }, state);
  const input = JSON.parse(text.slice(text.lastIndexOf('\n') + 1));
  assert.equal(input.sceneTemplate.id, selected.id);
  assert.deepEqual(input.sceneTemplate.structure, selected.structure);
  assert.deepEqual(input.sceneTemplate.style, selected.style);
  assert.ok(input.sceneTemplate.guide.includes(selected.name));
  assert.match(input.sceneTemplate.guide, /本次正文与旁白使用英文/);
  assert.equal(input.preferences.language, 'en');
  assert.match(text, /do not copy their facts, names or claims/i);
  assert.equal(RECIPE_SCHEMA.properties.templateId, undefined);
  const inferred = generationPrompt({ ...job, topic: '木瓜营养特点', templateId: 'auto' }, state);
  assert.equal(JSON.parse(inferred.slice(inferred.lastIndexOf('\n') + 1)).sceneTemplate.id, automatic.id);
});

test('five drafts using the same template receive distinct editorial focuses, angles and prior-template avoidance', () => {
  const template = pickTemplate('木瓜营养特点');
  const jobs = Array.from({ length: 5 }, (_, index) => ({ id: `batch-${index}`, feedId: 'batch', topic: '木瓜营养特点', templateId: template.id, angle: `角度 ${index}` }));
  const batch = { ...state, jobs, works: [{ title: '已有的木瓜解释', topic: '木瓜营养特点', templateId: template.id }] };
  const variations = jobs.map(item => {
    const text = generationPrompt(item, batch);
    const input = JSON.parse(text.slice(text.lastIndexOf('\n') + 1));
    assert.equal(input.angle, item.angle);
    assert.equal(input.editorialVariation.angle, item.angle);
    assert.deepEqual(input.editorialVariation.previousTemplateWorks, [{ title: '已有的木瓜解释', topic: '木瓜营养特点' }]);
    return input.editorialVariation;
  });
  assert.deepEqual(variations.map(value => value.position), [1, 2, 3, 4, 5]);
  assert.equal(new Set(variations.map(value => value.focus)).size, 5);
});

test('invalid selected templates reject before either provider creates a child process', async () => {
  let spawns = 0;
  const spawnProcess = () => { spawns++; throw new Error('must not spawn'); };
  const codex = new CodexRecipeProvider({ spawnProcess });
  const command = new CommandRecipeProvider({ command: 'fixture', spawnProcess });
  try {
    await assert.rejects(codex.generate({ ...job, templateId: 'missing-template' }, state), /template not found/i);
    await assert.rejects(command.generate({ ...job, templateId: 'missing-template' }, state), /template not found/i);
    assert.equal(spawns, 0); assert.equal(codex.busy, false);
  } finally { codex.close(); command.close(); }
});

test('Codex buffers notifications before start response and filters stale turns and other threads', async t => {
  const child = codexChild((child, request, turnId) => {
    child.notify('turn/started', { threadId: 'thread-1', turn: { id: 'old-turn' } });
    completed(child, 'old-turn', draft('STALE'));
    completed(child, turnId, draft('OTHER THREAD'), 'another-thread');
    child.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId, itemId: 'current-item', delta: JSON.stringify(draft('CURRENT')) });
    child.notify('turn/completed', { threadId: 'thread-1', turn: { id: turnId, status: 'completed', items: [] } });
    child.reply(request, { turn: { id: turnId } });
  });
  const provider = new CodexRecipeProvider({ spawnProcess: () => child }); t.after(() => provider.close());
  assert.equal((await provider.generate(job, state)).title, 'CURRENT');
  assert.equal(provider.pending.size, 0);
});

test('an aborted start response arriving during the next generation interrupts only its own old turn', async t => {
  const started = deferred(); let oldRequest;
  const child = codexChild((child, request, turnId) => {
    if (turnId === 'turn-1') { oldRequest = request; started.resolve(); return; }
    // The old turn responds late; its notifications must never satisfy this second generation.
    child.reply(oldRequest, { turn: { id: 'turn-1' } });
    completed(child, 'turn-1', draft('STALE ABORTED'));
    child.notify('turn/started', { threadId: 'thread-1', turn: { id: 'turn-1' } });
    child.reply(request, { turn: { id: turnId } });
    queueMicrotask(() => completed(child, turnId, draft('SECOND')));
  });
  const provider = new CodexRecipeProvider({ spawnProcess: () => child, rpcTimeoutMs: 500 }); t.after(() => provider.close());
  const abort = new AbortController(); const first = provider.generate(job, state, abort.signal);
  const rejection = assert.rejects(first, error => error.name === 'AbortError');
  await started.promise; abort.abort(); await rejection;
  assert.equal((await provider.generate(job, state)).title, 'SECOND');
  assert.deepEqual(child.requests.filter(r => r.method === 'turn/interrupt').map(r => r.params.turnId), ['turn-1']);
});

test('Codex initialization failure can reconnect and process exits do not retain a dead ready promise', async t => {
  let spawns = 0; const children = [];
  const provider = new CodexRecipeProvider({ spawnProcess: () => {
    const index = ++spawns;
    const child = codexChild((child, request, turnId) => {
      child.reply(request, { turn: { id: turnId } }); queueMicrotask(() => completed(child, turnId, draft(`CONNECTED ${index}`)));
    }, index === 1 ? (child, request) => child.send({ jsonrpc: '2.0', id: request.id, error: { message: 'Initialization failed' } }) : null);
    children.push(child); return child;
  } }); t.after(() => provider.close());
  await assert.rejects(provider.generate(job, state), /Initialization failed/);
  assert.equal((await provider.generate(job, state)).title, 'CONNECTED 2');
  children[1].emit('exit', 1);
  assert.equal((await provider.generate(job, state)).title, 'CONNECTED 3');
  assert.equal(spawns, 3);
});

test('Codex rejects an unexpected disconnect during a turn and recovers on the next request', async t => {
  let spawns = 0;
  const provider = new CodexRecipeProvider({ spawnProcess: () => codexChild((child, request, turnId) => {
    child.reply(request, { turn: { id: turnId } });
    if (++spawns === 1) queueMicrotask(() => child.emit('exit', 1));
    else queueMicrotask(() => completed(child, turnId, draft('RECOVERED')));
  }) }); t.after(() => provider.close());
  await assert.rejects(provider.generate(job, state), /连接已结束/);
  assert.equal((await provider.generate(job, state)).title, 'RECOVERED');
});

test('Codex generation timeout interrupts the correct turn and releases the busy flag', async t => {
  const child = codexChild((child, request, turnId) => child.reply(request, { turn: { id: turnId } }));
  const provider = new CodexRecipeProvider({ spawnProcess: () => child, generationTimeoutMs: 10 }); t.after(() => provider.close());
  await assert.rejects(provider.generate(job, state), error => error.code === 'GENERATION_TIMEOUT' && /超过.*秒/.test(error.message));
  assert.equal(provider.busy, false);
  assert.equal(child.requests.find(r => r.method === 'turn/interrupt').params.turnId, 'turn-1');
});

test('recipe worker disables inherited MCP servers and plugins only inside its own thread', async t => {
  const child = codexChild((child, request, turnId) => { child.reply(request, { turn: { id: turnId } }); queueMicrotask(() => completed(child, turnId, draft('ISOLATED'))); });
  const provider = new CodexRecipeProvider({ spawnProcess: () => child }); t.after(() => provider.close());
  await provider.generate(job, state);
  const request = child.requests.find(r => r.method === 'thread/start');
  assert.equal(request.params.config.mcp_servers['unrelated.server'].enabled, false);
  assert.equal(request.params.config.plugins['unused@plugin'].enabled, false);
  assert.equal(request.params.config['features.shell_tool'], false);
  assert.match(request.params.baseInstructions, /content-only/);
  assert(!JSON.stringify(request.params.config).includes('SECRET'));
  assert(!child.requests.some(r => /config\/.*write/i.test(r.method)));
  assert.equal(recipeWorkerConfig().web_search, 'disabled');
});

test('streaming output keeps a long recipe alive and reports actual script activity', async t => {
  const progress = [], output = JSON.stringify(draft('STREAMED'));
  const child = codexChild((child, request, turnId) => {
    child.reply(request, { turn: { id: turnId } });
    for (const delay of [10, 30, 50]) setTimeout(() => child.notify('item/agentMessage/delta', { threadId: 'thread-1', turnId, itemId: 'answer', delta: output.slice(0, 5) }), delay);
    setTimeout(() => completed(child, turnId, draft('STREAMED')), 70);
  });
  const provider = new CodexRecipeProvider({ spawnProcess: () => child, generationTimeoutMs: 200, idleTimeoutMs: 40 }); t.after(() => provider.close());
  assert.equal((await provider.generate(job, state, undefined, item => progress.push(item))).title, 'STREAMED');
  assert.deepEqual(progress.filter(p => p.phase === 'script-writing').map(p => p.characters), [5, 10, 15]);
});

test('a silent model stops once instead of renewing its lease forever', async t => {
  const child = codexChild((child, request, turnId) => child.reply(request, { turn: { id: turnId } }));
  const provider = new CodexRecipeProvider({ spawnProcess: () => child, generationTimeoutMs: 200, idleTimeoutMs: 15 }); t.after(() => provider.close());
  await assert.rejects(provider.generate(job, state), error => error.code === 'GENERATION_STALLED');
  assert.equal(provider.busy, false); assert.equal(child.killed, true);
});

test('a terminal model error is surfaced even if the host never sends turn/completed', async t => {
  const child = codexChild((child, request, turnId) => {
    child.reply(request, { turn: { id: turnId } });
    queueMicrotask(() => child.notify('error', { threadId: 'thread-1', turnId, willRetry: false, error: { message: 'Inference service unavailable' } }));
  });
  const provider = new CodexRecipeProvider({ spawnProcess: () => child }); t.after(() => provider.close());
  await assert.rejects(provider.generate(job, state), /Inference service unavailable/);
});

test('Codex selects the advertised non-hidden default rather than an unsupported configuration default', async t => {
  const child = codexChild(() => {}, null, (child, request) => {
    assert.deepEqual(request.params, { limit: 100, includeHidden: false });
    child.reply(request, { data: [
      { id: 'hidden-default', model: 'hidden-default', isDefault: true, hidden: true },
      { id: 'gpt-5.6-sol', model: 'gpt-5.6-sol', hidden: false },
      { id: 'gpt-6-astra', model: 'gpt-6-astra', isDefault: true, hidden: false }
    ] });
  });
  const provider = new CodexRecipeProvider({ spawnProcess: () => child }); t.after(() => provider.close());
  await provider.connect();
  assert.equal(child.requests.find(request => request.method === 'thread/start').params.model, 'gpt-6-astra');
  assert.equal(provider.actualModel, 'gpt-6-astra');
});

test('Codex chooses the first visible model when no default is advertised', async t => {
  const child = codexChild(() => {}, null, (child, request) => child.reply(request, { data: [
    { id: 'hidden', hidden: true }, { id: 'first-visible' }, { id: 'second-visible' }
  ] }));
  const provider = new CodexRecipeProvider({ spawnProcess: () => child }); t.after(() => provider.close());
  await provider.connect();
  assert.equal(provider.actualModel, 'first-visible');
});

test('an explicitly configured model is never replaced even when the host rejects it', async t => {
  const child = codexChild(() => {}, null, null, (child, request) => child.send({
    id: request.id, error: { code: -32000, message: 'Explicit model is unsupported by this account' }
  }));
  const provider = new CodexRecipeProvider({ model: 'user-requested-model', spawnProcess: () => child }); t.after(() => provider.close());
  await assert.rejects(provider.connect(), error => error.code === -32000 && /unsupported/.test(error.message));
  assert.equal(child.requests.some(request => request.method === 'model/list'), false);
  assert.equal(child.requests.find(request => request.method === 'thread/start').params.model, 'user-requested-model');
  assert.equal(provider.actualModel, 'user-requested-model');
});

test('only model/list method-not-found falls back to the older server default', async t => {
  const child = codexChild(() => {}, null,
    (child, request) => child.send({ id: request.id, error: { code: -32601, message: 'Method not found' } }),
    (child, request) => child.reply(request, { thread: { id: 'thread-1' }, model: 'legacy-actual-model' }));
  const provider = new CodexRecipeProvider({ spawnProcess: () => child }); t.after(() => provider.close());
  await provider.connect();
  assert.equal(Object.hasOwn(child.requests.find(request => request.method === 'thread/start').params, 'model'), false);
  assert.equal(provider.actualModel, 'legacy-actual-model');
});

test('model discovery account errors and empty advertised choices are never hidden by fallback', async t => {
  const child = codexChild(() => {}, null, (child, request) => child.send({
    id: request.id, error: { code: -32001, message: 'Account is blocked' }
  }));
  const provider = new CodexRecipeProvider({ spawnProcess: () => child }); t.after(() => provider.close());
  await assert.rejects(provider.connect(), error => error.code === -32001 && /Account is blocked/.test(error.message));
  assert.equal(child.requests.some(request => request.method === 'thread/start'), false);
  const emptyChild = codexChild(() => {}, null, (child, request) => child.reply(request, { data: [{ id: 'hidden-only', hidden: true }] }));
  const empty = new CodexRecipeProvider({ spawnProcess: () => emptyChild }); t.after(() => empty.close());
  await assert.rejects(empty.connect(), /没有公布可用模型/);
  assert.equal(emptyChild.requests.some(request => request.method === 'thread/start'), false);
});

test('command adapters wait for stdout close after process exit instead of parsing a partial recipe', async t => {
  const child = new FakeChild((child, request) => {
    assert.equal(request.job.id, job.id);
    const output = JSON.stringify(draft('FULL OUTPUT'));
    child.stdout.write(output.slice(0, 20)); child.emit('exit', 0);
    queueMicrotask(() => { child.stdout.end(output.slice(20)); child.emit('close', 0); });
  });
  const provider = new CommandRecipeProvider({ command: 'fixture', spawnProcess: () => child }); t.after(() => provider.close());
  assert.equal((await provider.generate(job, state)).title, 'FULL OUTPUT');
});

test('closing a command adapter rejects and kills pending generators', async () => {
  const child = new FakeChild(() => {});
  const provider = new CommandRecipeProvider({ command: 'fixture', spawnProcess: () => child });
  const pending = provider.generate(job, state); const rejection = assert.rejects(pending, /已关闭/);
  provider.close(); await rejection;
  assert.equal(child.killed, true); assert.equal(provider.children.size, 0);
  await assert.rejects(provider.generate(job, state), /已关闭/);
});

function socketClass({ autoOpen = true, initializeReply = true, onTurn } = {}) {
  return class FakeSocket extends EventTarget {
    static OPEN = 1; static CLOSED = 3; static instances = [];
    constructor() {
      super(); this.readyState = 0; this.requests = []; this.constructor.instances.push(this);
      if (autoOpen) queueMicrotask(() => { if (this.readyState === 0) { this.readyState = 1; this.dispatchEvent(new Event('open')); } });
    }
    send(text) {
      const request = JSON.parse(text); this.requests.push(request);
      if (request.method === 'initialize' && initializeReply) this.reply(request);
      if (request.method === 'turn/start') onTurn?.(this, request);
    }
    reply(request, result = {}) {
      const event = new Event('message'); event.data = JSON.stringify({ jsonrpc: '2.0', id: request.id, result }); this.dispatchEvent(event);
    }
    close() { if (this.readyState === 3) return; this.readyState = 3; this.dispatchEvent(new Event('close')); }
  };
}

test('event bridge opening has a bounded timeout and releases the socket', async t => {
  const Socket = socketClass({ autoOpen: false });
  const bridge = new CodexEventBridge({ url: 'ws://127.0.0.1:1', threadId: 'target', WebSocketImpl: Socket, connectTimeoutMs: 10 });
  t.after(() => bridge.close());
  await assert.rejects(bridge.connect(), /连接超时/);
  assert.equal(Socket.instances[0].readyState, Socket.CLOSED);
  assert.equal(bridge.pending.size, 0);
});

test('event bridge rejects pending requests on unexpected close and reconnects', async t => {
  const firstRequest = deferred(); let turns = 0;
  const Socket = socketClass({ onTurn: (socket, request) => {
    if (++turns === 1) firstRequest.resolve(socket); else socket.reply(request, { delivered: true });
  } });
  const bridge = new CodexEventBridge({ url: 'ws://localhost:1', threadId: 'target', WebSocketImpl: Socket }); t.after(() => bridge.close());
  const pending = bridge.push([{ type: 'comment' }]); const rejection = assert.rejects(pending, /连接已结束/);
  (await firstRequest.promise).close(); await rejection;
  assert.equal(bridge.pending.size, 0);
  assert.deepEqual(await bridge.push([{ type: 'view' }]), { delivered: true });
  assert.equal(Socket.instances.length, 2);
});

test('parallel event pushes wait for initialization before sending any turn request', async t => {
  const initialized = deferred();
  const Socket = socketClass({ initializeReply: false, onTurn: (socket, request) => socket.reply(request, { delivered: true }) });
  const original = Socket.prototype.send;
  Socket.prototype.send = function(text) {
    const request = JSON.parse(text); original.call(this, text);
    if (request.method === 'initialize') initialized.resolve({ socket: this, request });
  };
  const bridge = new CodexEventBridge({ url: 'ws://127.0.0.1:1', threadId: 'target', WebSocketImpl: Socket }); t.after(() => bridge.close());
  const first = bridge.push([]); const { socket, request } = await initialized.promise;
  const second = bridge.push([]);
  assert.equal(socket.requests.filter(r => r.method === 'turn/start').length, 0);
  socket.reply(request);
  assert.deepEqual(await Promise.all([first, second]), [{ delivered: true }, { delivered: true }]);
});

test('event bridge close rejects a connection still opening and prevents later reuse', async () => {
  const Socket = socketClass({ autoOpen: false });
  const bridge = new CodexEventBridge({ url: 'ws://127.0.0.1:1', threadId: 'target', WebSocketImpl: Socket });
  const pending = bridge.connect(); const rejection = assert.rejects(pending, /桥已关闭/);
  bridge.close(); await rejection;
  await assert.rejects(bridge.push([]), /桥已关闭/);
});

test('one script deadline includes connection initialization and permits a fresh reconnect after timeout', async t => {
  let count = 0; const children = [];
  const provider = new CodexRecipeProvider({ generationTimeoutMs: 40, rpcTimeoutMs: 500, spawnProcess: () => {
    const index = ++count;
    const child = codexChild((child, request, turnId) => {
      child.reply(request, { turn: { id: turnId } }); queueMicrotask(() => completed(child, turnId, draft('RECOVERED')));
    }, index === 1 ? () => {} : null);
    children.push(child); return child;
  } }); t.after(() => provider.close());
  await assert.rejects(provider.generate(job, state), /生成超时.*连接/);
  assert.equal(children[0].killed, true);
  assert.equal(provider.busy, false);
  assert.equal((await provider.generate(job, state)).title, 'RECOVERED');
});

test('cancelling during model connection settles immediately and releases the busy flag', async t => {
  const started = deferred();
  const child = codexChild(() => {}, () => started.resolve());
  const provider = new CodexRecipeProvider({ spawnProcess: () => child, rpcTimeoutMs: 500 }); t.after(() => provider.close());
  const abort = new AbortController();
  const pending = provider.generate(job, state, abort.signal);
  const rejected = assert.rejects(pending, error => error.name === 'AbortError');
  await started.promise; abort.abort(); await rejected;
  assert.equal(child.killed, true); assert.equal(provider.busy, false);
});

test('a timed-out start RPC cannot disconnect the next freshly connected generation', async t => {
  let count = 0;
  const provider = new CodexRecipeProvider({ generationTimeoutMs: 80, rpcTimeoutMs: 500, spawnProcess: () => {
    const index = ++count;
    return codexChild((child, request, turnId) => {
      if(index === 1) return;
      child.reply(request,{turn:{id:turnId}}); queueMicrotask(()=>completed(child,turnId,draft('FRESH')));
    });
  } }); t.after(()=>provider.close());
  await assert.rejects(provider.generate(job,state),/生成超时/);
  assert.equal((await provider.generate(job,state)).title,'FRESH');
});

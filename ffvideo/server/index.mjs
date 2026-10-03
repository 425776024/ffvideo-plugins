import { createServer, request as httpRequest } from 'node:http';
import { readFile, mkdir, writeFile, stat, rm, open, realpath, rename } from 'node:fs/promises';
import { createReadStream, readFileSync } from 'node:fs';
import { join, resolve, relative, extname, basename, sep, isAbsolute } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { startServer as startEngine } from '../../packages/server/index.mjs';
import { VideoCutClient } from '../../packages/client/index.mjs';
import { probe, run } from '../../packages/server/media.mjs';
import { duration, ticks } from '../../packages/core/project.mjs';
import { FeedStore } from './store.mjs';
import { createMcpHandler } from './mcp.mjs';
import { composeDraft, saveDraftProject, readDraftProject, CAPTION_VERSION } from './drafts.mjs';
import { CodexRecipeProvider, CommandRecipeProvider, CodexEventBridge } from './providers.mjs';
import { listTemplates, getTemplate, instantiateTemplate, applyRecipeOverrides, pickTemplate } from './templates.mjs';
import { voiceCatalog, pickVoice, nativeSayArgs } from './voices.mjs';
import { presentationStyle } from './illustrations.mjs';
import { validateRecipe, plain, failure } from './recommendation.mjs';
import { resolveDraftVisuals } from './visual-assets.mjs';
import { designSignature, validateDesign } from './direction.mjs';
import { listMaterials, materialBrief } from './materials.mjs';

const packageRoot = fileURLToPath(new URL(JSON.parse(readFileSync(new URL('../../package.json', import.meta.url))).name === '@ffclip-com/ffvideo' ? '../../' : '../', import.meta.url));
const VISUAL_VERSION = 4;
export const defaultDataDir = () => process.env.FFVIDEO_DATA_DIR || join(homedir(), '.ffvideo');
const json = (res, status, value) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); };
const within = (root, path) => { const p = relative(root, path); return p === '' || (!p.startsWith('..' + sep) && p !== '..' && !isAbsolute(p)); };
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.wav': 'audio/wav', '.mp4': 'video/mp4', '.webm': 'video/webm', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
async function body(req, limit = 1024 * 1024) {
  const chunks = []; let size = 0;
  for await (const chunk of req) { size += chunk.length; if (size > limit) throw Object.assign(new Error('请求过大'), { status: 413 }); chunks.push(chunk); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks)) : {};
}
function safeToken(a, b) { if (!a || !b) return false; const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); }
async function file(res, path) { const s = await stat(path); if (!s.isFile()) throw new Error('文件不存在'); res.writeHead(200, { 'Content-Type': mime[extname(path)] || 'application/octet-stream', 'Content-Length': s.size }); createReadStream(path).pipe(res); }
export async function startFfvideo({ dataDir = defaultDataDir(), port = 4320, host = '127.0.0.1', staticDir = join(packageRoot, 'dist/web'),
  samplesDir = join(packageRoot, 'dist/samples'), provider, defaultProvider = 'agent', speech = process.platform === 'darwin' ? 'native' : 'browser',
  providerOptions = {}, visualOptions = {}, bridgeOptions, remoteToken = process.env.FFVIDEO_MCP_TOKEN, publicUrl, roots = [], seed = true } = {}) {
  dataDir = resolve(dataDir); staticDir = resolve(staticDir); samplesDir = resolve(samplesDir);
  const externalOrigin = publicUrl ? new URL(publicUrl).origin : null;
  if (publicUrl && !/^https?:\/\//.test(publicUrl)) throw new Error('public-url 需要 HTTP(S) URL');
  if (publicUrl && !remoteToken) throw new Error('public-url 需要配置 FFVIDEO_MCP_TOKEN');
  if (publicUrl && (new URL(publicUrl).pathname !== '/' || new URL(publicUrl).search || new URL(publicUrl).hash)) throw new Error('public-url 需要域名根 URL');
  if (!['127.0.0.1', 'localhost', '::1'].includes(host) && !remoteToken) throw new Error('非本地监听需要 FFVIDEO_MCP_TOKEN');
  await mkdir(dataDir, { recursive: true });
  dataDir = await realpath(dataDir);
  const lockPath = join(dataDir, 'server.lock');
  let lock;
  try { lock = await open(lockPath, 'wx', 0o600); } catch (error) {
    if (error.code !== 'EEXIST') throw error;
    const pid = Number(await readFile(lockPath, 'utf8'));
    try { if (!Number.isSafeInteger(pid) || pid <= 0) throw Object.assign(new Error('失效的服务锁'), { code: 'ESRCH' }); process.kill(pid, 0); throw new Error('此本地作品库已有 ffvideo 服务在运行，请复用该服务或指定另一个 --data-dir'); }
    catch (e) { if (e.code !== 'ESRCH') throw e; }
    await rm(lockPath); lock = await open(lockPath, 'wx', 0o600);
  }
  await lock.writeFile(String(process.pid)); await lock.close();
  let startupStore, startupEngine, startupServer, startupCleanup;
  try {
  const store = startupStore = await FeedStore.open(dataDir, { topicOnly: true });
  await store.recoverProviderClaims();
  if (provider === undefined) {
    try {
      const saved = JSON.parse(await readFile(join(dataDir, 'generator.json'), 'utf8'));
      if (!['agent', 'codex'].includes(saved.mode)) throw new Error('本地制作方式设置无效');
      provider = saved.mode;
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  provider ||= defaultProvider;
  await mkdir(join(dataDir, 'works'), { recursive: true }); await mkdir(join(dataDir, 'exports'), { recursive: true });
  const engine = startupEngine = await startEngine({ port: 0, roots: [dataDir, ...roots], staticDir });
  const client = new VideoCutClient(engine.url); await client.connect();
  const live = new Map(), pending = new Map(), subscribers = new Set(), exportBusy = new Map();
  const instanceId = randomUUID();
  const assetTasks = new Map(), upgradedSessions = new Set(), visualFailures = new Set();
  let visualUpgradeBusy = false, visualWorkTitle = '', visualUpgradePromise;
  let compositionTask;
  let materialWarmup = Promise.resolve();
  let tickCompletion = Promise.resolve();
  let origin = '', closed = false, ticking = false, providerBusy = false, providerBlocked = false, providerRevision = 0, generator, controller, activeJobId, mode = provider, lastError = '', agentConnected = false;
  const bridge = bridgeOptions ? new CodexEventBridge(bridgeOptions) : null;
  let bridgeTimer, bridgeCursor = store.state().cursor, bridgeSending = false, timer, refill, unsub;
  startupCleanup = async () => {
    closed = true; controller?.abort(); generator?.close(); bridge?.close(); unsub?.();
    for (const task of assetTasks.values()) task.controller.abort();
    clearInterval(timer); clearInterval(refill); clearTimeout(bridgeTimer);
    for (const res of subscribers) res.end();
    await tickCompletion;
  };
  function generationStatus() {
    const current = store.state();
    const jobs = current.jobs.filter(job => job.epoch === current.epoch && job.feedId === current.activeFeedId);
    const running = current.jobs.find(job => job.epoch === current.epoch && job.status === 'composing') || jobs.find(job => job.status === 'claimed');
    const queued = jobs.filter(job => job.status === 'queued');
    const explicit = queued.some(job => explicitInitialJob(current, job));
    const retry = jobs.find(job => job.status === 'failed' && job.retryAt > Date.now() && job.attempts < 3);
    const failed = jobs.find(job => job.status === 'failed' && job.attempts >= 3);
    let status = 'buffered';
    if (providerBlocked) status = 'blocked';
    else if (running) status = ['waiting_for_browser', 'model_required'].includes(running.phase) ? 'waiting-browser' : 'working';
    else if (retry) status = 'retrying';
    else if (failed && !queued.length) status = 'failed';
    else if (!current.preferences.autoGenerate && !explicit) status = 'paused';
    else if (queued.length) status = mode === 'agent' ? 'waiting-agent' : 'starting';
    return { mode, status, queued: queued.length, pending: current.buffer.pending, available: current.buffer.available,
      target: current.buffer.target, autoGenerate: current.preferences.autoGenerate,
      ...(current.buffer.lookAhead ? { aheadReady: current.buffer.aheadReady, aheadPending: current.buffer.aheadPending, lookAhead: current.buffer.lookAhead, trackingWorkId: current.buffer.trackingWorkId } : {}),
      phase: running?.phase || (running?.status === 'claimed' ? 'script' : null), title: running?.recipe?.title || null,
      elapsedSeconds: running ? Math.max(0, Math.floor((Date.now() - (running.phase?.startsWith('script') ? running.startedAt : running.phaseStartedAt || running.startedAt || running.createdAt || Date.now())) / 1000)) : 0,
      connected: mode === 'agent' ? agentConnected : !providerBlocked && (mode === 'codex' ? !!generator?.threadId : !!generator),
      model: generator?.actualModel || current.preferences.generationModel || providerOptions.model || null, effort: generator?.actualEffort || null,
      minimumEffort: generator?.minimumEffort || null, reasoningMode: current.preferences.reasoningMode || 'fast',
      blocked: providerBlocked, speechBackend: speech, lastError,
      preparingVisuals: visualUpgradeBusy, visualWorkTitle,
      supportedModes: ['agent', 'codex', ...(providerOptions.command ? ['command'] : [])], bridge: bridge ? 'configured' : 'none' };
  }
  function state() { return { ...store.state(), instanceId, generation: generationStatus() }; }
  async function setProvider(next, persist = false) {
    if (!['agent', 'codex', 'command'].includes(next) || (next === 'command' && !providerOptions.command)) throw new Error('未知或未配置的生成器');
    const revision = ++providerRevision;
    controller?.abort(); generator?.close(); generator = null; mode = next; lastError = ''; providerBlocked = false;
    if (next === 'codex') generator = new CodexRecipeProvider({ cwd: dataDir, ...providerOptions });
    if (next === 'command') generator = new CommandRecipeProvider({ cwd: dataDir, ...providerOptions });
    if (persist && ['agent', 'codex'].includes(next)) {
      const temporary = join(dataDir, `.generator-${randomUUID()}.tmp`);
      try { await writeFile(temporary, JSON.stringify({ mode: next }), { mode: 0o600 }); if (revision === providerRevision) await rename(temporary, join(dataDir, 'generator.json')); }
      finally { await rm(temporary, { force: true }); }
      if (revision === providerRevision) await store.retryGenerationJobs();
    }
    return generationStatus();
  }
  await setProvider(provider);
  async function createFeed(topic, options = {}) { const feed = await store.createFeed(topic, options); void tick(); return { feedId: feed.id, ...state() }; }
  async function submitDraft({ jobId, claimToken, recipe }) {
    if (!recipe.design) throw failure('作品缺少原创镜头设计 design；模板只能作为参考，不能直接填充后发布。');
    if (!recipe.design.typography || !recipe.design.captionKeywords) throw failure('新作品必须提交原创文字编排 typography 和旁白重点 captionKeywords，不能继续使用统一白字。');
    const current = store.state(), claimed = current.jobs.find(job => job.id === jobId);
    validateDesign(recipe.design, (claimed?.recipe || recipe).scenes.length);
    if (current.jobs.some(job => job.id !== jobId && (job.feedId === claimed?.feedId || (claimed?.copiedFrom && job.workId === claimed.copiedFrom)) && job.recipe?.design && designSignature(job.recipe.design) === designSignature(recipe.design)))
      throw failure('镜头布局和标注时间与同话题作品重复，请重新设计，不能只替换文字和素材。');
    const supplied = claimed?.recipe ? { ...claimed.recipe, design: recipe.design } : recipe;
    const job = await store.submitRecipe(jobId, claimToken, supplied);
    if (speech === 'native') await selectJobVoice(job);
    void tick(); return job;
  }
  async function recipeForWork(workId) {
    const current = store.state(), work = current.works.find(work => work.id === workId);
    if (!work) throw failure('作品不存在或已清空', 404);
    let recipe = current.jobs.find(job => job.workId === workId)?.recipe;
    if (!recipe && work.source === 'sample') {
      const sample = JSON.parse(await readFile(join(samplesDir, 'recipes.json'), 'utf8')).find(value => value.id === workId);
      if (sample) { const { id, topic, ...value } = sample; recipe = value; }
    }
    if (!recipe) throw failure('此历史作品缺少可复用的文案', 409);
    return { work, recipe: validateRecipe(recipe) };
  }
  async function createTemplateDraft(input) {
    plain(input, 'template draft');
    const { templateId, ...options } = input;
    const instantiated = instantiateTemplate(templateId, options);
    if (!instantiated.recipe) throw failure('请填写：' + instantiated.missingFields.map(field => field.label).join('、'));
    const created = await store.createRecipeDraft(instantiated.recipe, { templateId, topic: options.topic || options.values?.topic });
    if (!created.job.recipe.design) { await store.updateJob(created.jobId, { status: 'queued', phase: 'design' }); created.job.status = 'queued'; }
    void tick(); return { ...created, previewUrl: (publicUrl || origin) + '/feed/' + created.feedId, ...state() };
  }
  async function reuseDraft(input) {
    plain(input, 'draft copy');
    for (const key of Object.keys(input)) if (!['workId', 'topic', 'overrides'].includes(key)) throw failure('Unknown draft copy field: ' + key);
    const { work, recipe } = await recipeForWork(input.workId);
    const updated = applyRecipeOverrides(recipe, input.overrides || {});
    if(input.overrides?.design && recipe.design && designSignature(recipe.design)===designSignature(updated.design))
      throw failure('复制作品也需要重新设计镜头关系和节奏，不能只换素材、文字或配色。');
    if (!input.overrides?.design) delete updated.design;
    const created = await store.createRecipeDraft(updated, { templateId: work.templateId, topic: input.topic || work.topic, copiedFrom: work.id, presentationStyle: work.presentationStyle });
    if (!created.job.recipe.design) { await store.updateJob(created.jobId, { status: 'queued', phase: 'design' }); created.job.status = 'queued'; }
    void tick(); return { ...created, previewUrl: (publicUrl || origin) + '/feed/' + created.feedId, ...state() };
  }
  const compositionOptions = job => {
    const index = compositionIndex(job.id);
    return { index, templateId: job.templateId || pickTemplate(job.topic).id,
      ...(store.state().preferences.durationMode === 'auto' ? { maxDurationSeconds: 60 } : {}),
      ...(job.presentationStyle ? { presentationStyle: job.presentationStyle } : !job.explicitTemplate ? { presentationStyle: store.state().preferences.visualPreference === 'video-first' ? 'cinema' : presentationStyle(index).id } : {}) };
  };
  async function availableVoices(options = {}) {
    return voiceCatalog({ speechBackend: speech, ...options, ...(speech === 'browser' ? { ttsCatalog: await client.listTtsVoices() } : {}) });
  }
  async function selectJobVoice(job) {
    const assignment = voiceAssignment.then(() => assignJobVoice(job));
    voiceAssignment = assignment.catch(() => {});
    return assignment;
  }
  let voiceAssignment = Promise.resolve();
  async function assignJobVoice(job) {
    const current = store.state();
    const recommendedOnly = current.preferences.voiceMode === 'random' && (!job.voice || job.recipe.language !== 'zh' || /^native_(tingting|meijia)_/.test(job.voice));
    const catalog = await availableVoices({ language: job.recipe.language, recommendedOnly });
    // Reserve against in-flight jobs too; two concurrent syntheses cannot pick from the same published predecessor.
    const previous = current.jobs.filter(item => item.id !== job.id && item.voice && !['cancelled', 'failed'].includes(item.status)).at(-1)?.voice
      || current.works.filter(work => work.source === 'generated').at(-1)?.voice;
    const selected = pickVoice({ voice: job.voice || (current.preferences.voiceMode === 'fixed' ? current.preferences.voice : 'random'), language: job.recipe.language,
      workId: job.id, previousVoice: job.voice ? undefined : previous, backend: speech, catalog });
    if (!job.voice) { await store.updateJob(job.id, { voice: selected.id, voiceLabel: selected.name }); job.voice = selected.id; job.voiceLabel = selected.name; }
    return selected;
  }
  function explicitInitialJob(current, job) {
    const feed = current.feeds.find(f => f.id === job.feedId);
    return Boolean(job.manualRequest || (feed?.topic && current.jobs.filter(j => j.feedId === feed.id).slice(0, 5).some(j => j.id === job.id)));
  }
  function compositionIndex(id) {
    const current = store.state();
    const job = current.jobs.find(job => job.id === id || job.workId === id);
    if (job) return current.jobs.filter(item => item.feedId === job.feedId).findIndex(item => item.id === job.id);
    const work = current.works.find(work => work.id === id);
    if (work) return current.works.filter(item => item.feedId === work.feedId).findIndex(item => item.id === id);
    const index = current.works.findIndex(work => work.id === id);
    return index >= 0 ? index : Math.max(0, current.jobs.findIndex(job => job.id === id)) + 5;
  }
  async function sessionFor(workId) {
    const work = store.state().works.find(w => w.id === workId); if (!work) throw Object.assign(new Error('作品不存在或已清空'), { status: 404 });
    let entry = live.get(workId);
    if (entry) { try { const value = await client.getSession(entry.id); entry.touched = Date.now(); return value; } catch { live.delete(workId); } }
    const project = await readDraftProject(work.projectPath);
    // Retain persisted projects, bound only disposable engine sessions. Avoid evicting the recently active player.
    if (live.size >= 24) {
      const oldest = [...live].filter(([id]) => !exportBusy.has(id)).sort((a, b) => a[1].touched - b[1].touched)[0];
      if (oldest) { live.delete(oldest[0]); await client.closeSession(oldest[1].id).catch(() => {}); }
    }
    const snapshot = await client.createSession(project); live.set(workId, { id: snapshot.id, touched: Date.now() });
    return snapshot;
  }
  async function getWork(id) {
    const work = store.state().works.find(w => w.id === id); if (!work) throw new Error('作品不存在');
    const snapshot = await sessionFor(id);
    return { ...work, status: 'ready', narrationReady: snapshot.project.assets.some(a => a.kind === 'audio'), snapshot, previewUrl: (publicUrl || origin).replace(/\/$/, '') + '/watch/' + encodeURIComponent(id) };
  }
  async function exportWork(workId, format = 'mp4') {
    if (!['mp4', 'webm'].includes(format)) throw new Error('导出格式需要 mp4 或 webm');
    if (exportBusy.size) throw Object.assign(new Error('另一条视频正在导出，请稍后重试'), { status: 409 });
    exportBusy.set(workId, null);
    try {
      const snapshot = await sessionFor(workId);
      const work = store.state().works.find(work => work.id === workId);
      exportBusy.set(workId, snapshot);
      const result = await client.renderVideo(snapshot.id, snapshot.version, join(dataDir, 'exports'), format);
      const filename = basename(result.path);
      const downloadUrl = (publicUrl || origin).replace(/\/$/, '') + '/ffapi/exports/' + encodeURIComponent(filename);
      let creditsPath;
      if (work?.visualCredits?.length) {
        creditsPath = result.path.replace(/\.(?:mp4|webm)$/i, '.credits.txt');
        const credits = work.visualCredits.map((credit, index) => `${index + 1}. ${credit.title}\n作者：${credit.author}\n许可：${credit.license}\n来源：${credit.sourceUrl}\n许可条款：${credit.licenseUrl}`).join('\n\n');
        await writeFile(creditsPath, `${work.title}\n画面素材来源与许可\n\n${credits}\n`);
      }
      await store.recordEvents([{ eventId: randomUUID(), type: 'export', workId }]);
      return { ...result, filename, downloadUrl, ...(process.platform === 'darwin' && !publicUrl ? { revealUrl: '/exports/' + encodeURIComponent(filename) + '/reveal' } : {}), ...(creditsPath ? { creditsPath } : {}) };
    } finally { exportBusy.delete(workId); }
  }
  async function publish(job, project, directory, posterPath, composition = {}) {
    if (job.epoch !== store.state().epoch || closed) return;
    const path = await saveDraftProject(project, directory);
    await store.publishWork(job.id, { id: job.workId || `work-${job.id}`, feedId: job.feedId, topic: job.topic,
      title: job.recipe.title, description: job.recipe.narration, tags: job.recipe.tags, durationSeconds: duration(project) / 120000,
      projectPath: path, posterPath, source: 'generated', visualVersion: composition.visualVersion || VISUAL_VERSION, visualCredits: composition.visualCredits || [],
      captionVersion: composition.captionVersion || 0,
      ...(composition.presentationStyle ? { presentationStyle: composition.presentationStyle } : {}),
      ...(composition.designVersion ? { designVersion: composition.designVersion } : {}),
      templateId: job.templateId || composition.templateId, ...(job.voice ? { voice: job.voice, voiceLabel: job.voiceLabel } : {}), ...(job.copiedFrom ? { copiedFrom: job.copiedFrom } : {}) });
  }
  async function visualsFor(recipe, directory, key, kind = 'job', options = {}) {
    const controller = new AbortController();
    const promise = resolveDraftVisuals(recipe, directory, { visualPreference: store.state().preferences.visualPreference,
      cacheDir: join(dataDir, 'media-cache'), topic: store.state()[kind === 'work' ? 'works' : 'jobs'].find(item=>item.id===key)?.topic || recipe.title,
      ...visualOptions, ...options, signal: controller.signal });
    assetTasks.set(key, { controller, kind, promise });
    try { return await promise; }
    finally { assetTasks.delete(key); }
  }
  async function getMaterials({ topic = '', limit = 18, relevantOnly = false } = {}, signal) {
    await materialWarmup;
    return { materials: materialBrief(await listMaterials(join(dataDir,'media-cache'),{topic,limit,signal,relevantOnly})) };
  }
  async function upgradeNextVisualWork() {
    if (visualUpgradeBusy || closed) return;
    const current = store.state();
    const work = current.works.filter(work => ((work.visualVersion || 0) < VISUAL_VERSION || (work.captionVersion || 0) < CAPTION_VERSION) && !visualFailures.has(work.id) && !exportBusy.has(work.id))
      .sort((a, b) => Number(b.feedId === current.activeFeedId) - Number(a.feedId === current.activeFeedId))[0];
    if (!work) return;
    visualUpgradeBusy = true; visualWorkTitle = work.title;
    try {
      const directory = resolve(work.projectPath, '..');
      const original = await readDraftProject(work.projectPath);
      let recipe = current.jobs.find(job => job.workId === work.id)?.recipe;
      if (!recipe && work.source === 'sample') recipe = JSON.parse(await readFile(join(samplesDir, 'recipes.json'), 'utf8')).find(recipe => recipe.id === work.id);
      if (!recipe) { visualFailures.add(work.id); return; }
      const audioPath = original.assets.find(asset => asset.kind === 'audio')?.path;
      const subtitleOnly = (work.visualVersion || 0) >= VISUAL_VERSION;
      const visuals = await visualsFor(recipe, directory, work.id, 'work', subtitleOnly ? { allowRemote: false } : {});
      if (closed || exportBusy.has(work.id) || !store.state().works.some(item => item.id === work.id)) return;
      const composition = await composeDraft(recipe, directory, { audioPath, durationSeconds: work.durationSeconds, ...(store.state().preferences.durationMode === 'auto' ? { maxDurationSeconds: 60 } : {}), visuals, index: compositionIndex(work.id), templateId: work.templateId, presentationStyle: work.presentationStyle });
      if (closed || exportBusy.has(work.id) || !store.state().works.some(item => item.id === work.id)) return;
      const backup = join(directory, 'original-project.json');
      try { await writeFile(backup, JSON.stringify(original), { flag: 'wx' }); } catch (error) { if (error.code !== 'EEXIST') throw error; }
      const projectPath = await saveDraftProject(composition.project, directory);
      const oldSession = live.get(work.id); live.delete(work.id);
      if (oldSession) {
        upgradedSessions.add(oldSession.id);
        setTimeout(() => { if (!closed) void client.closeSession(oldSession.id).catch(() => {}).finally(() => upgradedSessions.delete(oldSession.id)); }, 5000).unref();
      }
      await store.replaceWorkComposition(work.id, { projectPath, posterPath: composition.posterPath, durationSeconds: composition.durationSeconds,
        visualVersion: composition.visualVersion || VISUAL_VERSION, visualCredits: composition.visualCredits || [],
        captionVersion: composition.captionVersion || 0,
        ...(composition.designVersion ? { designVersion: composition.designVersion } : {}),
        ...(composition.presentationStyle ? { presentationStyle: composition.presentationStyle } : {}) });
    } catch (error) { if (!closed && error.name !== 'AbortError' && store.state().works.some(item => item.id === work.id)) { visualFailures.add(work.id); lastError = `画面更新：${error.message}`; } }
    finally { visualUpgradeBusy = false; visualWorkTitle = ''; }
  }
  async function nativeSpeech(recipe, directory, selection) {
    if (process.platform !== 'darwin') throw new Error('系统语音目前仅支持 macOS；请使用浏览器语音');
    const input = join(directory, 'narration.txt'), path = join(directory, 'narration.wav'), raw = join(directory, '.narration-source.wav');
    await writeFile(input, recipe.narration);
    try {
      await run('/usr/bin/say', nativeSayArgs(selection, { inputPath: input, outputPath: raw }), { timeout: 60000 });
      await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-af', 'loudnorm=I=-18:TP=-1.5:LRA=7',
        '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', path], { timeout: 30000 });
    } finally { await rm(raw, { force: true }); }
    const audio = await probe(path); if (!audio.duration || audio.duration < ticks(.25)) throw new Error('系统配音未生成有效声音');
    return path;
  }
  async function compose(job) {
    if (!job.recipe.design) {
      await store.updateJob(job.id, { status: 'queued', phase: 'design' });
      return;
    }
    const directory = join(dataDir, 'works', job.id); await mkdir(directory, { recursive: true });
    await store.updateJob(job.id, { phase: speech === 'native' ? 'media' : 'visuals', progress: .25 });
    if (speech === 'native') {
      const audioTask = selectJobVoice(job).then(selection => nativeSpeech(job.recipe, directory, selection));
      const results = await Promise.allSettled([visualsFor(job.recipe, directory, job.id), audioTask]);
      const failure = results.find(result => result.status === 'rejected');
      if (failure) throw failure.reason;
      const [visuals, audioPath] = results.map(result => result.value);
      if (closed || !store.state().jobs.some(item => item.id === job.id && item.status === 'composing')) return;
      await store.updateJob(job.id, { phase: 'composing', progress: .8 });
      const result = await composeDraft(job.recipe, directory, { audioPath, visuals, ...compositionOptions(job) });
      await publish(job, result.project, directory, result.posterPath, result);
    } else {
      const visuals = await visualsFor(job.recipe, directory, job.id);
      if (closed || !store.state().jobs.some(item => item.id === job.id && item.status === 'composing')) return;
      const result = await composeDraft(job.recipe, directory, { durationSeconds: store.state().preferences.durationSeconds, visuals, ...compositionOptions(job) });
      const snapshot = await client.createSession(result.project);
      pending.set(job.id, { job, directory, snapshot, posterPath: result.posterPath, visuals, submitted: false });
      await store.updateJob(job.id, { phase: 'waiting_for_browser', progress: .3 });
    }
  }
  async function tick() {
    if (ticking || closed) return; ticking = true;
    let finishTick; tickCompletion = new Promise(resolve => { finishTick = resolve; });
    try {
      const current = store.state();
      for (const [key, task] of assetTasks) {
        const exists = task.kind === 'work' ? current.works.some(work => work.id === key) : current.jobs.some(job => job.id === key && job.status === 'composing' && job.epoch === current.epoch);
        if (!exists) task.controller.abort();
      }
      if (!visualUpgradeBusy) visualUpgradePromise = upgradeNextVisualWork();
      if (activeJobId && !current.jobs.some(j => j.id === activeJobId && j.status === 'claimed' && j.epoch === current.epoch)) controller?.abort();
      for (const [id, task] of pending) {
        if (task.job.epoch !== current.epoch || !current.jobs.some(j => j.id === id && j.status === 'composing')) {
          await client.cancelTts(task.snapshot.id).catch(() => {}); await client.closeSession(task.snapshot.id).catch(() => {}); pending.delete(id); continue;
        }
        if (!task.submitted) {
          try {
            const snapshot = await client.getSession(task.snapshot.id);
            const selection = await selectJobVoice(task.job);
            await client.synthesizeSpeech(snapshot.id, { version: snapshot.version, text: task.job.recipe.narration,
              voice: selection.id, speed: selection.speed, dtype: 'fp32', backend: 'auto', insert: true, startSeconds: 0 });
            task.submitted = true; await store.updateJob(id, { phase: 'speech', progress: .5 });
          } catch (error) {
            // Browser/model setup is recoverable; the recipe stays persisted.
            await store.updateJob(id, { phase: /model|模型|voice|音色/.test(error.message) ? 'model_required' : 'waiting_for_browser', error: error.message });
          }
        } else {
          const status = await client.ttsStatus(task.snapshot.id);
          if (status.state === 'completed') {
            const snap = await client.getSession(task.snapshot.id);
            const speechAsset = snap.project.assets.find(a => a.kind === 'audio');
            if (!speechAsset) throw new Error('配音完成但作品缺少音轨');
            const result = await composeDraft(task.job.recipe, task.directory, { audioPath: speechAsset.path, visuals: task.visuals, ...compositionOptions(task.job) });
            await publish(task.job, result.project, task.directory, result.posterPath, result); pending.delete(id); await client.closeSession(task.snapshot.id).catch(() => {});
          } else if (['error', 'cancelled', 'conflict'].includes(status.state)) {
            task.submitted = false; await store.updateJob(id, { phase: 'waiting_for_browser', error: status.error || '配音待重试' });
          }
        }
      }
      if (closed) return;
      if (!pending.size && !compositionTask) {
        const job = store.state().jobs.find(j => j.status === 'composing' && j.recipe);
        if (job) {
          const task = async () => { try { await compose(job); } catch (error) {
          const stillActive = store.state().jobs.some(j => j.id === job.id && j.status === 'composing');
          if (stillActive) { lastError = error.message; await store.updateJob(job.id, { status: 'failed', error: error.message }).catch(() => {}); }
          } };
          if (speech === 'native') {
            // One composer and one model turn overlap, with at most two prepared drafts in the backlog.
            compositionTask = task().finally(() => { compositionTask = undefined; if (!closed) void tick(); });
          } else await task();
        }
      }
      const needsExplicitDraft = current.jobs.some(j => j.status === 'queued' && explicitInitialJob(current, j));
      if (generator && !providerBlocked && !providerBusy && (current.preferences.autoGenerate || needsExplicitDraft) && !pending.size && store.state().jobs.filter(job => job.status === 'composing').length < 2) {
        const claimGenerator = generator, claimMode = mode;
        const claim = await store.claimJob(`provider-${mode}`);
        if (claim) {
          const latest = store.state();
          if (closed || generator !== claimGenerator || mode !== claimMode || (!latest.preferences.autoGenerate && !explicitInitialJob(latest, claim.job))) {
            if (!closed) await store.updateJob(claim.job.id, { status: 'queued' }).catch(() => {});
            return;
          }
          providerBusy = true; activeJobId = claim.job.id; controller = new AbortController(); const own = controller, activeGenerator = generator;
          // Heartbeat keeps the job lease alive while a model response streams.
          const heartbeat = setInterval(() => { void store.updateJob(claim.job.id, { leaseExpiresAt: Date.now() + 45000 }).catch(() => {}); }, 15000);
          let lastProgressAt = 0, lastProgressPhase;
          const scriptProgress = ({ phase, characters = 0, error }) => {
            if (own.signal.aborted || closed) return;
            const now = Date.now();
            if (phase === lastProgressPhase && now - lastProgressAt < 1500) return;
            lastProgressAt = now; lastProgressPhase = phase;
            void store.updateJob(claim.job.id, { phase, scriptCharacters: Math.min(100000, characters),
              ...(error ? { error: String(error).slice(0, 2000) } : { error: '' }) }).catch(() => {});
          };
          void getMaterials({topic:claim.job.topic,relevantOnly:true},own.signal)
            .then(({materials})=>activeGenerator.generate(claim.job,{...store.state(),materialInventory:materials},own.signal,scriptProgress))
            .then(recipe => submitDraft({ jobId: claim.job.id, claimToken: claim.claimToken, recipe }))
            .catch(async error => {
              const current = store.state();
              if (!closed && current.jobs.some(j => j.id === claim.job.id && j.epoch === current.epoch && j.status === 'claimed')) {
                lastError = error.message;
                providerBlocked = ['GENERATION_TIMEOUT', 'GENERATION_STALLED'].includes(error.code) || /invalid_json_schema|not supported when using Codex|unsupported.*reasoning|reasoning.*not supported|unauthorized|authentication|account.*(?:blocked|disabled|suspended)|没有公布可用模型|(?:status["':\s]+|HTTP\s+)(401|403)\b|ENOENT/i.test(error.message);
                await store.updateJob(claim.job.id, { status: 'failed', error: error.message }).catch(() => {});
              }
            })
            .finally(() => { clearInterval(heartbeat); providerBusy = false; activeJobId = null; if (!closed) void tick(); }).catch(() => {});
        }
      }
    } catch (error) { lastError = error.message; } finally { ticking = false; finishTick(); }
  }
  if (seed && !store.state().seeded) {
    const recipes = JSON.parse(await readFile(join(samplesDir, 'recipes.json'), 'utf8'));
    const works = [];
    for (let i = 0; i < recipes.length; i++) {
      const recipe = recipes[i], directory = join(dataDir, 'works', recipe.id);
      await mkdir(directory, { recursive: true });
      const audioPath = join(directory, 'narration.wav');
      await writeFile(audioPath, await readFile(join(samplesDir, recipe.id + '.wav')));
      const result = await composeDraft(recipe, directory, { audioPath, index: i });
      works.push({ id: recipe.id, feedId: 'samples', topic: recipe.topic, title: recipe.title, description: recipe.narration, tags: recipe.tags,
        durationSeconds: result.durationSeconds, projectPath: await saveDraftProject(result.project, directory), posterPath: result.posterPath, captionVersion: result.captionVersion || 0,
        visualVersion: result.visualVersion || VISUAL_VERSION, visualCredits: result.visualCredits || [], ...(result.presentationStyle ? { presentationStyle: result.presentationStyle } : {}), source: 'sample' });
    }
    await store.seedWorks(works);
  }
  let handler;
  const server = startupServer = createServer(async (req, res) => {
    const requestAbort = new AbortController(); req.on('aborted', () => requestAbort.abort());
    res.on('close', () => { if (!res.writableEnded) requestAbort.abort(); });
    try {
      const url = new URL(req.url, origin || 'http://127.0.0.1');
      const remote = !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress);
      const cookie = req.headers.cookie?.split(';').map(x => x.trim()).find(x => x.startsWith('ffvideo_token='))?.slice(14);
      let cookieToken; try { cookieToken = cookie ? decodeURIComponent(cookie) : undefined; } catch { /* Bad cookies never override a valid bearer token. */ }
      const authorized = [req.headers.authorization?.replace(/^Bearer /, ''), url.searchParams.get('token'), cookieToken].some(value => safeToken(value, remoteToken));
      const requestHostname = new URL('http://' + req.headers.host).hostname;
      const externalRequest = externalOrigin && req.headers.host === new URL(externalOrigin).host;
      if (!remote && !externalRequest && req.headers.host !== new URL(origin).host && !['localhost', '127.0.0.1', '[::1]'].includes(requestHostname)) return json(res, 403, { error: '请求主机无效' });
      if ((remote || externalOrigin) && !authorized) return json(res, 401, { error: '需要 ffvideo 访问令牌' });
      if (req.headers.origin && ![origin, externalOrigin].includes(req.headers.origin) && !/^http:\/\/(127\.0\.0\.1|localhost):5174$/.test(req.headers.origin)) return json(res, 403, { error: '请求来源无效' });
      res.setHeader('Referrer-Policy', 'no-referrer');
      if (safeToken(url.searchParams.get('token'), remoteToken)) res.setHeader('Set-Cookie', `ffvideo_token=${encodeURIComponent(remoteToken)}; HttpOnly; SameSite=Strict; Path=/${externalOrigin?.startsWith('https:') ? '; Secure' : ''}`);
      if (url.pathname === '/mcp') {
        if (remoteToken && !authorized) return json(res, 401, { error: '需要 MCP 访问令牌' });
        if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }); return res.end(); }
        const value = await body(req); if (Array.isArray(value)) return json(res, 400, { error: '不支持 RPC 批量请求' });
        const result = await handler(value, { signal: requestAbort.signal });
        if (!result) { res.writeHead(202); return res.end(); } return json(res, 200, result);
      }
      if (url.pathname.startsWith('/api/') || /^\/(tts-models|asr-models|vision-models|project-resources)\//.test(url.pathname)) {
        // The shared engine stays on a private loopback port. Browser resources keep one origin.
        const headers = { ...req.headers, host: new URL(engine.url).host }; delete headers.origin;
        const upstreamUrl = new URL(engine.url); upstreamUrl.pathname = url.pathname; upstreamUrl.search = url.search;
        const upstream = httpRequest(upstreamUrl, { method: req.method,
          headers }, response => { res.writeHead(response.statusCode, response.headers); response.pipe(res); });
        upstream.on('error', error => { if (!res.headersSent) json(res, 502, { error: error.message }); else res.destroy(); });
        res.on('close', () => upstream.destroy()); req.pipe(upstream); return;
      }
      if (url.pathname === '/ffapi/templates' && req.method === 'GET') return json(res, 200, { templates: listTemplates() });
      const outputRoute = /^\/ffapi\/exports\/([^/]+)(\/reveal)?$/.exec(url.pathname);
      if (outputRoute) {
        const filename = decodeURIComponent(outputRoute[1]);
        if (basename(filename) !== filename || /[\\\x00-\x1f]/.test(filename) || !['.mp4', '.webm'].includes(extname(filename))) return json(res, 400, { error: '无效的导出文件名' });
        const directory = await realpath(join(dataDir, 'exports'));
        let path; try { path = await realpath(join(directory, filename)); } catch { return json(res, 404, { error: '导出视频不存在' }); }
        if (!within(directory, path)) return json(res, 403, { error: '导出文件不在作品库中' });
        const info = await stat(path); if (!info.isFile()) return json(res, 404, { error: '导出视频不存在' });
        if (outputRoute[2]) {
          if (req.method !== 'POST') return json(res, 405, { error: '需要 POST 请求' });
          if (remote || externalOrigin || process.platform !== 'darwin') return json(res, 400, { error: '请在本机打开导出文件夹' });
          await run('/usr/bin/open', ['-R', path]); return json(res, 200, { opened: true });
        }
        if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '需要 GET 或 HEAD 请求' });
        res.writeHead(200, { 'Content-Type': mime[extname(filename)], 'Content-Length': info.size, 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="ffvideo${extname(filename)}"; filename*=UTF-8''${encodeURIComponent(filename)}` });
        if (req.method === 'HEAD') return res.end();
        createReadStream(path).pipe(res); return;
      }
      if (url.pathname === '/ffapi/voices' && req.method === 'GET') return json(res, 200, await availableVoices());
      if (url.pathname === '/ffapi/templates/instantiate' && req.method === 'POST') {
        const { templateId, ...options } = await body(req); return json(res, 200, instantiateTemplate(templateId, options));
      }
      if (url.pathname === '/ffapi/templates/drafts' && req.method === 'POST') return json(res, 201, await createTemplateDraft(await body(req)));
      const templateRoute = /^\/ffapi\/templates\/([a-z0-9-]+)$/.exec(url.pathname);
      if (templateRoute && req.method === 'GET') return json(res, 200, getTemplate(templateRoute[1]));
      const reuseRoute = /^\/ffapi\/works\/([^/]+)\/(recipe|reuse)$/.exec(url.pathname);
      if (reuseRoute && reuseRoute[2] === 'recipe' && req.method === 'GET') return json(res, 200, await recipeForWork(decodeURIComponent(reuseRoute[1])));
      if (reuseRoute && reuseRoute[2] === 'reuse' && req.method === 'POST') return json(res, 201, await reuseDraft({ ...(await body(req)), workId: decodeURIComponent(reuseRoute[1]) }));
      if (url.pathname === '/ffapi/state' && req.method === 'GET') return json(res, 200, state());
      if (url.pathname === '/ffapi/preferences' && req.method === 'POST') { await store.updatePreferences(await body(req)); void tick(); return json(res, 200, state()); }
      if (url.pathname === '/ffapi/generator' && req.method === 'POST') { const { mode } = await body(req); await setProvider(mode, true); void tick(); return json(res, 200, state()); }
      if (url.pathname === '/ffapi/topics' && req.method === 'POST') return json(res, 201, await (async () => { const value = await body(req); return createFeed(value.topic, value.templateId ? { templateId: value.templateId } : {}); })());
      const moreTopic = /^\/ffapi\/topics\/([^/]+)\/more$/.exec(url.pathname);
      if (moreTopic && req.method === 'POST') { await store.requestMore(decodeURIComponent(moreTopic[1])); void tick(); return json(res, 200, state()); }
      const selectTopic = /^\/ffapi\/topics\/([^/]+)\/select$/.exec(url.pathname);
      if (selectTopic && req.method === 'POST') { await store.selectFeed(decodeURIComponent(selectTopic[1])); void tick(); return json(res, 200, state()); }
      const removeTopic = /^\/ffapi\/topics\/([^/]+)$/.exec(url.pathname);
      if (removeTopic && req.method === 'DELETE') {
        await store.removeFeed(decodeURIComponent(removeTopic[1])); void tick(); return json(res, 200, state());
      }
      if (url.pathname === '/ffapi/generation/retry' && req.method === 'POST') {
        if (activeJobId) {
          controller?.abort();
          const active = store.state().jobs.find(job => job.id === activeJobId && job.status === 'claimed');
          if (active) await store.updateJob(active.id, { status: 'failed', error: '用户重新尝试生成' });
        }
        await setProvider(mode); await store.retryGenerationJobs(); void tick(); return json(res, 200, state());
      }
      if (url.pathname === '/ffapi/comments' && req.method === 'POST') { const data = await body(req); const comment = await store.addComment(data.workId, data.text); return json(res, 201, { comment, ...state() }); }
      if (url.pathname === '/ffapi/events' && req.method === 'POST') { await store.recordEvents((await body(req)).events); await store.enqueueRecommendations(); void tick(); return json(res, 200, { cursor: store.state().cursor }); }
      if (url.pathname === '/ffapi/events' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
        subscribers.add(res); res.write('event: state\ndata: ' + JSON.stringify(state()) + '\n\n');
        const keepalive = setInterval(() => res.write(': heartbeat\n\n'), 15000);
        res.on('close', () => { clearInterval(keepalive); subscribers.delete(res); }); return;
      }
      if (url.pathname === '/ffapi/history' && req.method === 'DELETE') {
        if (exportBusy.size) throw Object.assign(new Error('请等待当前导出完成后清空历史'), { status: 409 });
        const previous = store.state(), old = previous.works; controller?.abort();
        const assets = [...assetTasks.values()]; for (const task of assets) task.controller.abort();
        await store.clearHistory();
        await Promise.allSettled(assets.map(task => task.promise)); await visualUpgradePromise?.catch(() => {});
        for (const task of pending.values()) await client.cancelTts(task.snapshot.id).catch(() => {});
        for (const task of pending.values()) await client.closeSession(task.snapshot.id).catch(() => {});
        for (const entry of live.values()) await client.closeSession(entry.id).catch(() => {});
        pending.clear(); live.clear();
        for (const work of old) { const dir = resolve(work.projectPath, '..'); if (within(join(dataDir, 'works'), dir)) await rm(dir, { recursive: true, force: true }); }
        for (const job of previous.jobs) if (/^[A-Za-z0-9_-]{1,100}$/.test(job.id)) await rm(join(dataDir, 'works', job.id), { recursive: true, force: true });
        return json(res, 200, state());
      }
      if (url.pathname === '/ffapi/runtime') {
        const sessions = [];
        for (const task of pending.values()) sessions.push(await client.getSession(task.snapshot.id).catch(() => task.snapshot));
        for (const [id, snapshot] of exportBusy) sessions.push(snapshot || await sessionFor(id));
        return json(res, 200, { sessions });
      }
      const workRoute = /^\/ffapi\/works\/([^/]+)\/(session|export|poster)$/.exec(url.pathname);
      if (workRoute) {
        const id = decodeURIComponent(workRoute[1]);
        if (workRoute[2] === 'session' && req.method === 'GET') return json(res, 200, await sessionFor(id));
        if (workRoute[2] === 'export' && req.method === 'POST') return json(res, 200, await exportWork(id, (await body(req)).format));
        if (workRoute[2] === 'poster' && req.method === 'GET') { const work = store.state().works.find(w => w.id === id); if (!work?.posterPath) return json(res, 404, { error: '封面不存在' }); return file(res, work.posterPath); }
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 404, { error: '接口不存在' });
      let path = resolve(staticDir, '.' + decodeURIComponent(url.pathname));
      if (!within(staticDir, path)) return json(res, 403, { error: '路径无效' });
      if (!extname(path)) path = join(staticDir, 'index.html');
      try { return await file(res, path); } catch (error) { if (error.code === 'ENOENT') return json(res, 404, { error: '资源不存在；请先构建 ffvideo' }); throw error; }
    } catch (error) { if (!res.headersSent) json(res, error.status || error.statusCode || 400, { error: error.message }); else res.destroy(); }
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  origin = `http://${host === '::1' ? '[::1]' : host}:${server.address().port}`;
  // The MCP tool closure reads this mutable URL through a facade created after listening.
  const mcpHandler = handler = createMcpHandler({ store, baseUrl: publicUrl || origin, createFeed, submitDraft, getWork, exportWork, createTemplateDraft, reuseDraft, generationStatus, getMaterials });
  // HTTP uses the identical handler and URL; no separate tool implementation.
  unsub = store.subscribe(event => {
    const current = store.state();
    for (const [key, task] of assetTasks) {
      const exists = task.kind === 'work' ? current.works.some(work => work.id === key) : current.jobs.some(job => job.id === key && job.status === 'composing' && job.epoch === current.epoch);
      if (!exists) task.controller.abort();
    }
    for (const res of subscribers) res.write('event: state\ndata: ' + JSON.stringify(state()) + '\n\n');
    if (bridge && !bridgeTimer && ['comment', 'watch', 'topic', 'events', 'preferences', 'feedback'].some(t => event.type.includes(t))) {
      bridgeTimer = setTimeout(async () => {
        bridgeTimer = null; if (bridgeSending || closed) return; bridgeSending = true;
        try { const batch = await store.waitEvents(bridgeCursor, 0); if (batch.events.length) { await bridge.push(batch.events); bridgeCursor = batch.nextCursor; } }
        catch (error) { lastError = error.message; } finally { bridgeSending = false; }
      }, 1500);
    }
    void tick();
  });
  refill = setInterval(() => { void store.enqueueRecommendations().catch(error => { lastError = error.message; }); }, 15000); refill.unref();
  timer = setInterval(() => { void tick(); }, 2000); timer.unref();
  
  materialWarmup = (async()=>{
    // Import completed source assets from the current library once, offline.
    const current=store.state();
    const works=current.works.filter(w=>current.jobs.some(j=>j.workId===w.id && j.recipe))
      .sort((a,b)=>Number(b.feedId===current.activeFeedId)-Number(a.feedId===current.activeFeedId)).slice(0,8);
    for(const work of works) {
      if(closed) break;
      const recipe=current.jobs.find(j=>j.workId===work.id)?.recipe;
      await visualsFor(recipe,resolve(work.projectPath,'..'),work.id,'work',{allowRemote:false}).catch(()=>{});
    }
  })();
  void tick();
  await writeFile(join(dataDir, 'server.json'), JSON.stringify({ url: origin, pid: process.pid }), { mode: 0o600 });
  return { url: origin, viewerUrl: publicUrl || origin, store, mcpHandler, state, createFeed, createTemplateDraft, reuseDraft, submitDraft, sessionFor, generationStatus, getMaterials,
    setAgentConnected(value) { agentConnected = value; },
    async close() {
      if (closed) return; const assets = [...assetTasks.values()]; await startupCleanup();
      await compositionTask?.catch(() => {});
      await materialWarmup.catch(()=>{});
      await Promise.allSettled(assets.map(task => task.promise)); await visualUpgradePromise?.catch(() => {});
      await Promise.allSettled([...upgradedSessions].map(id => client.closeSession(id)));
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); await engine.close(); await store.close();
      await rm(lockPath, { force: true }); await rm(join(dataDir, 'server.json'), { force: true });
    }
  };
  } catch (error) {
    await startupCleanup?.().catch(() => {});
    if (startupServer) { startupServer.closeAllConnections(); await new Promise(resolve => startupServer.close(resolve)); }
    await startupEngine?.close().catch(() => {}); await startupStore?.close().catch(() => {});
    await rm(lockPath, { force: true }); throw error;
  }
}

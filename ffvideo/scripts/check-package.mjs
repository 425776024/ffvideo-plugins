import { readFile, readdir, stat, mkdtemp, cp, rm } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import assert from 'node:assert/strict';
// Optional root lets CI validate an extracted npm tarball rather than the checkout.
const root = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await readFile(join(root, 'package.json')));
if (pkg.name !== '@ffclip-com/ffvideo') throw new Error('Wrong package name');
if (pkg.version !== '0.2.0' || !pkg.files.includes('templates')) throw new Error('Wrong release version or missing template package files');
for (const path of ['dist/bin/ffvideo.mjs', 'dist/web/index.html', 'dist/samples/recipes.json', 'hosts/config.mjs', 'skills/video-feed/SKILL.md', 'README.md']) await stat(join(root, path));
const templateFixtures = ['process.svg', 'reading.md', 'flow.json', 'shape.lottie.json'];
async function checkTemplates(directory) {
  for (const path of ['README.md', 'catalog.json', ...templateFixtures.map(file => 'media/' + file)]) {
    const resource = await stat(join(directory, path));
    if (!resource.isFile() || !resource.size) throw new Error('Missing local template resource: ' + join(directory, path));
  }
  const catalog = JSON.parse(await readFile(join(directory, 'catalog.json'), 'utf8'));
  if (catalog.templates?.length !== 20 || new Set(catalog.templates.map(template => template.id)).size !== 20)
    throw new Error('Need twenty distinct shipped scenario templates');
  return catalog.templates;
}
const shippedTemplates = await checkTemplates(join(root, 'templates'));
assert.deepEqual(await checkTemplates(join(root, 'dist/templates')), shippedTemplates, 'Built catalog differs from package catalog');
async function check(directory) { for (const entry of await readdir(directory, { withFileTypes: true })) {
  const path = join(directory, entry.name); if (entry.isDirectory()) await check(path);
  else if (/\.map$|\.ts$|\.vue$/.test(entry.name)) throw new Error('Source artifact in release: ' + path);
} }
await check(join(root, 'dist'));
const recipes = JSON.parse(await readFile(join(root, 'dist/samples/recipes.json')));
if (recipes.length < 5) throw new Error('Need five built-in works');
for (const recipe of recipes) if ((await stat(join(root, 'dist/samples', recipe.id + '.wav'))).size < 20000) throw new Error('Sample lacks sound');

const within = (root, path) => {
  const p = relative(root, path);
  return p === '' || (p !== '..' && !p.startsWith('..' + sep) && !isAbsolute(p));
};
async function checkedFetch(url) {
  const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Packaged runtime resource returned ${response.status}: ${new URL(url).pathname}`);
  return response;
}
async function checkPlugin(product) {
  const built = join(root, 'dist/plugins', product);
  const manifest = JSON.parse(await readFile(join(built, product === 'codex' ? '.codex-plugin/plugin.json' : '.claude-plugin/plugin.json'), 'utf8'));
  if (manifest.skills !== './skills/' || manifest.mcpServers !== './.mcp.json' || manifest.version !== pkg.version) throw new Error(`${product}: wrong manifest references/version`);
  for (const path of ['skills/video-feed/SKILL.md', 'runtime/package.json', 'runtime/dist/bin/ffvideo.mjs',
    'runtime/dist/web/index.html', 'runtime/dist/samples/recipes.json', 'runtime/dist/gsap-runtime.js', 'runtime/dist/licenses/Mediabunny-MPL-2.0.txt'])
    await stat(join(built, path));
  const runtimePackage = JSON.parse(await readFile(join(built, 'runtime/package.json'), 'utf8'));
  if (runtimePackage.name !== pkg.name || runtimePackage.version !== pkg.version) throw new Error(`${product}: runtime package identity mismatch`);
  const temporary = await mkdtemp(join(tmpdir(), 'ffvideo-plugin-check-'));
  let child, lines, killTimer;
  try {
    const isolated = join(temporary, 'installed-plugin');
    await cp(built, isolated, { recursive: true });
    assert.deepEqual(await checkTemplates(join(isolated, 'templates')), shippedTemplates, `${product}: readable template catalog mismatch`);
    assert.deepEqual(await checkTemplates(join(isolated, 'runtime/dist/templates')), shippedTemplates, `${product}: runtime template catalog mismatch`);
    for (const file of templateFixtures) {
      const expected = await readFile(join(root, 'templates/media', file));
      assert.deepEqual(await readFile(join(isolated, 'templates/media', file)), expected, `${product}: readable local fixture differs`);
      assert.deepEqual(await readFile(join(isolated, 'runtime/dist/templates/media', file)), expected, `${product}: local runtime fixture differs`);
    }
    const entry = JSON.parse(await readFile(join(isolated, '.mcp.json'), 'utf8')).mcpServers?.ffvideo;
    if (entry?.command !== 'node' || !Array.isArray(entry.args)) throw new Error(`${product}: plugin must start its local Node bundle`);
    const placeholder = product === 'codex' ? '${PLUGIN_ROOT}' : '${CLAUDE_PLUGIN_ROOT}';
    if (entry.args[0] !== placeholder + '/runtime/dist/bin/ffvideo.mjs') throw new Error(`${product}: unresolved or external runtime path`);
    const args = entry.args.map(arg => arg.replaceAll(placeholder, isolated));
    if (!within(isolated, resolve(args[0]))) throw new Error(`${product}: runtime escapes plugin root`);
    const pending = new Map(); let nextId = 0, stderr = '', protocolFailure;
    child = spawn(process.execPath, [...args, '--data-dir', join(temporary, 'feed-data')], {
      cwd: temporary, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, FFVIDEO_MCP_TOKEN: '' }
    });
    const exited = once(child, 'exit');
    child.stderr.on('data', chunk => { stderr = (stderr + chunk.toString()).slice(-16000); });
    const rejectPending = (error) => { for (const waiter of pending.values()) waiter.reject(error); pending.clear(); };
    child.on('error', rejectPending);
    child.on('exit', () => rejectPending(new Error(`${product} runtime exited before reply: ${stderr}`)));
    lines = createInterface({ input: child.stdout });
    lines.on('line', line => {
      let message;
      try { message = JSON.parse(line); }
      catch { protocolFailure = new Error(`${product}: stdout contains non-JSON protocol data`); rejectPending(protocolFailure); return; }
      const waiter = pending.get(message.id);
      if (waiter) { pending.delete(message.id); waiter.resolve(message); }
    });
    const rpc = async (method, params) => {
      if (protocolFailure) throw protocolFailure;
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${product}: packaged MCP timed out: ${stderr}`)); }, 15000);
        pending.set(id, { resolve: message => { clearTimeout(timer); if (message.error || message.result?.isError) reject(new Error(JSON.stringify(message.error || message.result.structuredContent))); else resolve(message.result); }, reject: error => { clearTimeout(timer); reject(error); } });
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      });
    };
    const initialized = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'ffvideo-package-check', version: '1' } });
    if (initialized.serverInfo?.name !== pkg.name || initialized.serverInfo?.version !== pkg.version) throw new Error(`${product}: wrong MCP server identity/version`);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const tools = (await rpc('tools/list', {})).tools;
    const toolNames = new Set(tools.map(tool => tool.name));
    for (const name of ['list_draft_templates', 'get_draft_template', 'instantiate_draft_template', 'create_template_draft', 'reuse_draft'])
      if (!toolNames.has(name)) throw new Error(`${product}: template MCP tool missing: ${name}`);
    const designSchema=tools.find(tool=>tool.name==='submit_draft').inputSchema.properties.recipe.properties.design;
    assert.ok(designSchema.required.includes('typography') && designSchema.required.includes('captionKeywords'),`${product}: authored type contract absent from installed bundle`);
    const tool = async (name, arguments_ = {}) => (await rpc('tools/call', { name, arguments: arguments_ })).structuredContent;
    const listed = (await tool('list_draft_templates')).templates;
    assert.deepEqual(listed.map(template => template.id), shippedTemplates.map(template => template.id), `${product}: bundled registry differs from shipped catalog`);
    for (const summary of listed) {
      const full = await tool('get_draft_template', { templateId: summary.id });
      assert.deepEqual(full, shippedTemplates.find(template => template.id === summary.id), `${product}: incomplete template: ${summary.id}`);
      const copy = await tool('instantiate_draft_template', { templateId: summary.id });
      assert.deepEqual(copy.recipe, full.example.recipe, `${product}: example copy failed: ${summary.id}`);
      assert.deepEqual(copy.missingFields, []);
      const filled = await tool('instantiate_draft_template', { templateId: summary.id, values: full.example.values });
      assert.deepEqual(filled.recipe, full.example.recipe, `${product}: field filling failed: ${summary.id}`);
      assert.deepEqual(filled.missingFields, []);
    }
    const first = listed[0].id;
    const original = await tool('get_draft_template', { templateId: first });
    const incomplete = await tool('instantiate_draft_template', { templateId: first, topic: '需要填写事实的新主题' });
    if (incomplete.recipe !== null || !incomplete.missingFields.length) throw new Error(`${product}: custom topic silently inherited example facts`);
    const changed = await tool('instantiate_draft_template', { templateId: first,
      overrides: { scenes: [{ index: 0, body: '这是隔离检查中的局部修改。' }] } });
    assert.equal(changed.recipe.scenes[0].body, '这是隔离检查中的局部修改。');
    assert.ok(changed.recipe.narration.includes('这是隔离检查中的局部修改。'));
    assert.deepEqual(await tool('get_draft_template', { templateId: first }), original, `${product}: instance edit changed the registry`);
    const opened = (await rpc('tools/call', { name: 'open_feed', arguments: {} })).structuredContent;
    const ready = opened.works.filter(work => work.status === 'ready');
    if (ready.length < 5) throw new Error(`${product}: isolated runtime lacks five ready sample works`);
    const html = await (await checkedFetch(opened.previewUrl)).text();
    const assetPaths = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map(match => match[1]).filter(path => path.startsWith('/assets/'));
    if (!assetPaths.some(path => path.endsWith('.js'))) throw new Error(`${product}: player bundle not referenced`);
    for (const path of assetPaths) await (await checkedFetch(new URL(path, opened.previewUrl))).arrayBuffer();
    const work = (await rpc('tools/call', { name: 'get_work', arguments: { workId: ready[0].id } })).structuredContent;
    if (!work.narrationReady) throw new Error(`${product}: sample narration missing`);
    const bootstrap = await (await checkedFetch(new URL('/api/bootstrap', opened.previewUrl))).json();
    const audio = work.snapshot.project.assets.find(asset => asset.kind === 'audio');
    const mediaUrl = new URL(`/api/sessions/${work.snapshot.id}/media`, opened.previewUrl);
    mediaUrl.searchParams.set('asset', audio.id); mediaUrl.searchParams.set('token', bootstrap.token);
    const audioBytes = Buffer.from(await (await checkedFetch(mediaUrl)).arrayBuffer());
    if (audioBytes.length < 20000 || audioBytes.toString('ascii', 0, 4) !== 'RIFF' || audioBytes.toString('ascii', 8, 12) !== 'WAVE')
      throw new Error(`${product}: sample media endpoint lacks a real WAV asset`);
    if (process.platform === 'darwin') {
      // Exercise minified function serialization and local font rasterization,
      // not just the source-module tests. No model or remote material calls.
      await tool('set_preferences',{preferences:{autoGenerate:false,visualPreference:'illustration'}});
      const frame={x:0,y:0,width:720,height:1280};
      const design={intent:'隔离包验证按内容排版不同字号的概念词，并以三个连续镜头保留完整旁白，不采用贯穿双卡片。',background:'#122021',
        captions:{font:'sans',size:30,color:'#FFFFFF',accent:'#F1D6A8',y:1080,width:600,plateColor:'#122021',plateOpacity:0,entrance:'fade'},captionKeywords:['观察','细节'],
        typography:[{purpose:'区分观察与细节的文字层级',start:0,end:.2,x:48,y:60,width:600,align:'left',gap:8,tracking:1,entrance:'rise',lines:[{indent:0,delay:0,runs:[
          {text:'观察',size:82,font:'sans-bold',color:'#F1D6A8',treatment:'outline'},{text:'细节',size:42,font:'serif',color:'#FFFFFF',treatment:'fill'}]}]}],
        shots:[0,1,2].map((sceneIndex,index)=>({sceneIndex,start:index/3,end:(index+1)/3,frame:index===1?{x:40,y:220,width:640,height:780}:frame,endFrame:frame,rotation:0,sourceStart:0,transition:'cut',overlays:[]}))};
      const created=await tool('create_template_draft',{templateId:first,overrides:{narration:'先观察整体，再看细节。找到具体变化，再回到整体理解它。观察与细节各有作用，不要只盯着一个局部。',design}});
      let state;const deadline=Date.now()+15000;
      while(Date.now()<deadline){state=await tool('get_feed_state');const job=state.jobs.find(job=>job.id===created.jobId);if(job?.status==='failed')throw new Error(`${product}: packaged rich type failed: ${job.error}`);if(job?.workId)break;await new Promise(resolve=>setTimeout(resolve,100));}
      const job=state.jobs.find(job=>job.id===created.jobId);assert.ok(job?.workId,`${product}: packaged local typography did not finish`);
      const typed=await tool('get_work',{workId:job.workId});assert.equal(typed.designVersion,2);assert.equal(typed.captionVersion,6);
      const layer=typed.snapshot.project.timeline.tracks.flatMap(track=>track.items).find(item=>item.name.startsWith('文字编排'));
      assert.equal(layer.clip.type,'image');assert.ok(!typed.snapshot.project.timeline.tracks.some(track=>track.items.some(item=>item.clip.html)));
      const imageUrl=new URL(`/api/sessions/${typed.snapshot.id}/media`,opened.previewUrl);imageUrl.searchParams.set('asset',layer.clip.assetId);imageUrl.searchParams.set('token',bootstrap.token);
      assert.deepEqual(Buffer.from(await (await checkedFetch(imageUrl)).arrayBuffer()).subarray(0,8),Buffer.from([137,80,78,71,13,10,26,10]));
    }
    child.stdin.end();
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    const [code] = await exited; clearTimeout(killTimer);
    if (code !== 0 || protocolFailure) throw protocolFailure || new Error(`${product}: runtime exit ${code}: ${stderr}`);
    process.stderr.write(`ffvideo ${product} plugin isolated MCP/player/audio, 20 template copies/fills and local fixtures verified\n`);
  } finally {
    clearTimeout(killTimer); lines?.close();
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL'); await once(child, 'exit').catch(() => {});
    }
    await rm(temporary, { recursive: true, force: true });
  }
}
for (const product of ['codex', 'claude']) await checkPlugin(product);
process.stderr.write('ffvideo package closure verified\n');

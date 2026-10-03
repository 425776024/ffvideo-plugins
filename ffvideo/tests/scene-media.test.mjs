import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';
import { createSceneMedia, sceneMediaForIndex, markdownBlocks, validateShapeLottie, sampleLottieProperty } from '../server/scene-media.mjs';
import { ticks, validateHtmlContent } from '../../packages/core/project.mjs';
import { HtmlFrameRenderer } from '../../packages/server/html-renderer.mjs';
import { findChromium } from '../../packages/server/chromium.mjs';

const scene = { heading: '连接与变化', body: '从一个观察出发，再把结果联系起来。' };
const presets = [['process-svg', 'svg'], ['reading-markdown', 'markdown'], ['flow-canvas', 'canvas'], ['shape-lottie', 'lottie']].map(([id, kind]) => ({ id, kind, sceneIndices: [1] }));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const lottie = () => readFile(new URL('../templates/media/shape.lottie.json', import.meta.url), 'utf8').then(JSON.parse);

test('scene presets are a closed allowlist and replace only their declared scene', async () => {
  for (const preset of presets) {
    const template = { mediaPreset: preset };
    assert.equal(sceneMediaForIndex(template, 0), null);
    assert.deepEqual(sceneMediaForIndex(template, 1), preset);
  }
  assert.equal(sceneMediaForIndex(null, 1), null);
  for (const preset of [
    { id: '../secret', kind: 'svg' }, { id: 'https://example.test/media.svg', kind: 'svg' }, { id: '__proto__' },
    { id: 'process-svg', kind: 'canvas' }, { id: 'process-svg', kind: 'svg', html: '<script>run()</script>' },
    { id: 'process-svg', kind: 'svg', sceneIndices: [-1] }
  ]) await assert.rejects(createSceneMedia(preset, { scene }), /Unsupported|Invalid/);
});

test('Markdown becomes bounded native text and a real PNG without HTML, links or duplicate captions', async () => {
  assert.deepEqual(markdownBlocks('# A heading\n\n- A **useful** point\nA short paragraph'), [
    { role: 'heading', content: 'A heading' }, { role: 'list', content: 'A useful point' }, { role: 'paragraph', content: 'A short paragraph' }
  ]);
  for (const source of ['<script>run()</script>', '[site](https://example.test)', '![img](url)', '```js\nrun()\n```']) assert.throws(() => markdownBlocks(source), /Unsupported/);
  const prepared = await createSceneMedia(presets[1], { scene, width: 480, height: 540 });
  assert.equal(prepared.kind, 'native'); assert.equal(prepared.html, undefined); assert.equal(prepared.includesBody, true);
  assert.deepEqual(prepared.blocks, [{ role: 'heading', content: scene.heading }, { role: 'list', content: scene.body }]);
  assert.equal(prepared.png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(prepared.png.readUInt32BE(16), 480); assert.equal(prepared.png.readUInt32BE(20), 540);
});

test('Lottie fixture rejects unsupported assets, scripts, animation easing and shape types', async () => {
  const original = await lottie(); validateShapeLottie(original);
  for (const edit of [
    document => { document.assets.push({ id: 'image', p: 'https://example.test/image.png' }); },
    document => { document.layers[0].ks.p.x = 'expression()'; },
    document => { document.layers[0].ks.p.k[0].i = { x: [1], y: [1] }; },
    document => { document.layers[0].shapes[0].ty = 'gr'; },
    document => { document.ddd = 1; },
    document => { document.layers[0].ks.p.k[1].t = 0; },
    document => { document.layers[0].ks.r.k = [0, 1]; }
  ]) {
    const document = structuredClone(original); edit(document);
    assert.throws(() => validateShapeLottie(document), /Unsupported|Invalid/);
  }
  const p = original.layers[0].ks.p;
  assert.deepEqual(sampleLottieProperty(p, 30), [350, 350, 0]);
  assert.deepEqual(sampleLottieProperty(p, 90), [350, 350, 0]);
  const held = structuredClone(p); held.k[0].h = 1;
  assert.deepEqual(sampleLottieProperty(held, 30), p.k[0].s);
});

function authoredContext(source, width = 240, height = 240) {
  const commands = [], canvas = { width, height };
  const methods = ['clearRect', 'save', 'restore', 'scale', 'fillRect', 'beginPath', 'moveTo', 'lineTo', 'stroke', 'arc', 'fill', 'fillText', 'translate', 'rotate', 'ellipse', 'roundRect', 'bezierCurveTo', 'closePath'];
  const context = Object.fromEntries(methods.map(name => [name, (...values) => commands.push([name, ...values])]));
  canvas.getContext = () => context;
  const document = { getElementById(id) { return id === 'scene' ? canvas : { setAttribute: (...values) => commands.push([id, ...values]) }; } };
  const window = {};
  const scripts = [...source.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(match => match[1]);
  assert.equal(scripts.length, 1);
  runInNewContext(scripts[0], { window, document }, { timeout: 1000 });
  return { draw(seconds) { commands.length = 0; window.tick(seconds, { duration: 4 }); return structuredClone(commands); } };
}
test('SVG, Canvas and Lottie use absolute-time drawing and restore their earlier state on backward seek', async () => {
  for (const preset of presets.filter(value => value.kind !== 'markdown')) {
    const prepared = await createSceneMedia(preset, { scene, width: 240, height: 240, durationSeconds: 4 });
    validateHtmlContent(prepared.html);
    assert.ok(!prepared.html.html.includes('requestAnimationFrame'));
    assert.ok(!/<script[^>]+src=|https?:\/\//.test(prepared.html.html.replace('http://www.w3.org/2000/svg', '')));
    const context = authoredContext(prepared.html.html);
    const first = context.draw(.2), later = context.draw(2.6), backward = context.draw(.2);
    assert.notDeepEqual(first, later, preset.id); assert.deepEqual(backward, first, `${preset.id}: no wall-clock state leaks`);
  }
});

test('text passed to graphics is escaped as content and cannot add authored scripts', async () => {
  for (const preset of presets.filter(value => value.kind !== 'markdown')) {
    const prepared = await createSceneMedia(preset, { scene: { heading: '</script><script>bad()</script>', body: 'text' } });
    assert.equal([...prepared.html.html.matchAll(/<script>/g)].length, 1);
    assert.ok(!prepared.html.html.includes('<script>bad()'));
    assert.doesNotThrow(() => authoredContext(prepared.html.html).draw(1));
  }
});

let chromium;
try { chromium = await findChromium(); } catch {}
test('actual SVG, Canvas and Lottie raster frames change with time and have identical uncached backward frames', {
  skip: !chromium && 'Local Chrome/Chromium unavailable; graphics raster runtime was not verified', timeout: 60000
}, async t => {
  const renderer = new HtmlFrameRenderer(); t.after(() => renderer.close());
  for (const preset of presets.filter(value => value.kind !== 'markdown')) {
    const prepared = await createSceneMedia(preset, { scene, width: 240, height: 240, durationSeconds: 4 });
    const first = await renderer.capture(prepared.html, ticks(.2));
    const later = await renderer.capture(prepared.html, ticks(2.6));
    assert.notEqual(hash(first.png), hash(later.png), preset.id);
    renderer.frames.clear();
    const backward = await renderer.capture(prepared.html, ticks(.2));
    assert.equal(backward.cached, false); assert.equal(hash(backward.png), hash(first.png), preset.id);
    assert.equal(backward.png.readUInt32BE(16), 240); assert.equal(backward.png.readUInt32BE(20), 240);
  }
});

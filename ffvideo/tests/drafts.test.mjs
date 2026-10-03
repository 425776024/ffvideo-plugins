import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { composeDraft, captionSegments } from '../server/drafts.mjs';
import { sceneIllustrationPng, captionShadePng } from '../server/illustrations.mjs';
import { ticks, duration, evaluateVisual, validateProject } from '../../packages/core/project.mjs';
import { layerGeometry } from '../../packages/render/plan.mjs';
import { build } from 'esbuild';
import { inflateSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { listTemplates, getTemplate, pickTemplate } from '../server/templates.mjs';

const compiled = await build({ entryPoints: ['packages/render/graph.ts'], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
const { SceneGraph } = await import('data:text/javascript;base64,' + Buffer.from(compiled.outputFiles[0].text).toString('base64'));
function pixels(png) {
  const width = png.readUInt32BE(16), height = png.readUInt32BE(20), chunks = [];
  for (let at = 8; at < png.length;) {
    const size = png.readUInt32BE(at);
    if (png.toString('ascii', at + 4, at + 8) === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + size));
    at += size + 12;
  }
  const rows = inflateSync(Buffer.concat(chunks)), stride = width * 4 + 1;
  return { width, height, at(x, y) { return [...rows.subarray(y * stride + 1 + x * 4, y * stride + 5 + x * 4)]; } };
}
test('scene timing preserves requested proportions and fills the actual composition duration without gaps', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-draft-'));
  try {
    const recipe = { title: 'Timing', tags: ['layout'], scenes: [
      { heading: 'First', body: 'body-one', seconds: 12 },
      { heading: 'Second', body: 'body-two', seconds: 6 },
      { heading: 'Third', body: 'body-three', seconds: 2 }
    ] };
    const { project } = await composeDraft(recipe, directory, { durationSeconds: 40 });
    const items = project.timeline.tracks.flatMap(track => track.items);
    const bodies = ['body-one', 'body-two', 'body-three'].map(value => items.find(item => item.clip.text?.content === value));
    assert.deepEqual(bodies.map(item => item.placement), [
      { begin: ticks(2.4), end: ticks(24) }, { begin: ticks(24), end: ticks(36) }, { begin: ticks(36), end: ticks(40) }
    ]);
    const pictures = project.timeline.tracks.find(track => track.name === '分镜画面').items;
    assert.deepEqual(pictures.map(item => item.placement), [{ begin: 0, end: ticks(24) }, { begin: ticks(24), end: ticks(36) }, { begin: ticks(36), end: ticks(40) }]);
    const title = items.find(item => item.name === '开场标题');
    assert.equal(title.placement.end, bodies[0].placement.begin, 'Opening title yields to the first caption without overlap');
    assert.equal(duration(project), ticks(40));
    for (const item of bodies) for (const frame of item.clip.automation['visual.opacity'].keyframes)
      assert.ok(frame.time >= 0 && frame.time <= item.clip.source.end);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('real image scenes replace text cards, keep their own source credits and render below timed readable captions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-footage-'));
  try {
    const first = join(directory, 'photograph-one.png'), second = join(directory, 'photograph-two.png');
    await writeFile(first, sceneIllustrationPng({ title: '宇宙行星' }, {}, 0, 320, 240).png);
    await writeFile(second, sceneIllustrationPng({ title: '海岸海浪' }, {}, 1, 320, 240).png);
    const credit = { title: 'First source', author: 'Photographer', license: 'CC BY', sourceUrl: 'https://example.test/source' };
    const recipe = { title: '有画面的故事', scenes: [
      { heading: '第一幕', body: '先看清主体。再观察它周围的空间。', seconds: 2 },
      { heading: '第二幕', body: '换一个角度，画面就有了新的层次。', seconds: 3 }
    ] };
    const draft = await composeDraft(recipe, directory, { durationSeconds: 10, visuals: [{ path: first, sceneIndex: 0, credit }, { path: second, sceneIndex: 1, credit }] });
    validateProject(draft.project);
    assert.equal(draft.visualVersion, 4);
    assert.deepEqual(draft.visualCredits, [credit]);
    assert.equal(draft.posterPath, first);
    assert.deepEqual(draft.illustrationThemes, []);
    const plan = new SceneGraph();
    for (const [time, source] of [[2, first], [7, second]]) {
      const layers = plan.evaluate(draft.project, ticks(time), 720, 1280).layers.map(entry => entry.layer);
      const photo = layers.find(layer => layer.asset?.path === source);
      assert.ok(photo, 'The composition uses the actual supplied scene image');
      assert.equal(photo.visual.fitPolicy, 'cover');
      assert.ok(layers.indexOf(photo) > layers.findIndex(layer => layer.asset?.path.endsWith('backdrop-cinema.png')), 'The style background does not cover the filmed subject');
      assert.ok(layers.slice(1).some(layer => layer.asset?.path.endsWith('caption-shade.png')));
      const captions = layers.filter(layer => layer.item.name.startsWith('字幕 '));
      assert.equal(captions.length, 1, 'Only the currently spoken caption is active');
      assert.ok(captions[0].visual.positionY > 300, 'The center of the scene remains unobstructed');
    }
    const footage = draft.project.timeline.tracks.find(track => track.name === '分镜画面').items[0];
    const early = evaluateVisual(footage, ticks(.5)), late = evaluateVisual(footage, ticks(3.5));
    assert.notEqual(early.scaleX, late.scaleX, 'The image really moves through the shared evaluated transform');
    assert.notEqual(early.positionX, late.positionX);
    assert.equal(duration(draft.project), ticks(10));
    const captionItems = draft.project.timeline.tracks.find(track => track.name === '逐句字幕').items;
    assert.equal(captionItems.filter(item => item.name.startsWith('字幕 ')).map(item => item.clip.text.content).join(''), recipe.scenes.map(scene => scene.body).join(''));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('offline fallback contains recognizable subject pixels and each topic changes the scene artwork', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-illustration-'));
  try {
    const recipe = { title: '从星空到海岸', scenes: [
      { heading: '摄影构图', body: '相机面对窗边人物。', visualPrompt: 'camera in a studio' },
      { heading: '宇宙行星', body: 'planet and stars', visualPrompt: 'space planet' },
      { heading: '海岸', body: 'ocean coast', visualPrompt: 'ocean beach' }
    ] };
    // Each scene's own subject should take precedence over a broad story title.
    recipe.title = '宇宙之旅';
    const draft = await composeDraft(recipe, directory, { durationSeconds: 12 });
    assert.deepEqual(draft.illustrationThemes, ['camera', 'space', 'coast']);
    const picture = pixels(await readFile(join(directory, 'scene-1.png')));
    assert.equal(picture.width, 720); assert.equal(picture.height, 1280);
    assert.deepEqual(picture.at(272, 796), [11, 25, 48, 255], 'The camera lens is real artwork, not a title glyph');
    assert.deepEqual(picture.at(535, 594), [201, 156, 131, 255], 'A human subject is present in the photographed scene');
    const starBytes = await readFile(join(directory, 'scene-2.png'));
    assert.notDeepEqual(await readFile(join(directory, 'scene-1.png')), starBytes);
    assert.notDeepEqual(starBytes, await readFile(join(directory, 'scene-3.png')));
    const shade = pixels(captionShadePng());
    assert.equal(shade.at(360, 600)[3], 0, 'The main scene remains visible through the caption layer');
    assert.ok(shade.at(360, 1150)[3] > 150, 'Bottom captions have a real contrast layer in preview and export');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('long captions preserve complete words and fit a bounded screenful', () => {
  const body = '这是一句很长的中文旁白，用于检查同一个分镜不会同时显示整段长文章。之后的每一句也应该被完整保留！';
  const captions = captionSegments(body, 20);
  assert.equal(captions.join(''), body);
  assert.ok(captions.length > 2);
  assert.ok(captions.every(content => [...content].length <= 20));
  const boundary = '甲'.repeat(20) + '。';
  const parts = captionSegments(boundary, 20);
  assert.equal(parts.join(''), boundary);
  assert(parts.every(content => content.length >= 10), 'balance long sentences instead of leaving a punctuation-only cue');
});

const ffmpeg = process.env.FFVIDEO_TEST_FFMPEG || '/opt/homebrew/opt/ffmpeg@4/bin/ffmpeg';
const hasFfmpeg = spawnSync(ffmpeg, ['-version'], { encoding: 'utf8' }).status === 0;
test('short actual video loops without source overruns or scene gaps and keeps motion continuous across cuts', { skip: !hasFfmpeg && 'ffmpeg fixture encoder unavailable' }, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-video-'));
  try {
    const path = join(directory, 'footage.mp4');
    const result = spawnSync(ffmpeg, ['-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x240:r=30', '-f', 'lavfi', '-i', 'anullsrc=r=24000:cl=mono', '-t', '1', '-c:v', 'libx264', '-c:a', 'aac', '-pix_fmt', 'yuv420p', '-y', path], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const { project } = await composeDraft({ title: '视频画面', scenes: [{ heading: '电影镜头', body: '真实视频片段循环播放。' }] }, directory, { durationSeconds: 3.5, visuals: [{ path, kind: 'video' }] });
    validateProject(project);
    const footage = project.timeline.tracks.find(track => track.name === '分镜画面').items;
    assert.equal(footage.length, 4);
    assert.equal(footage[0].placement.begin, 0);
    assert.equal(footage.at(-1).placement.end, ticks(3.5));
    for (let i = 0; i < footage.length; i++) {
      assert.equal(footage[i].clip.audio.muted, true);
      assert.ok(footage[i].clip.source.end <= project.assets.find(asset => asset.path === path).duration);
      if (i) {
        assert.equal(footage[i].placement.begin, footage[i - 1].placement.end);
        assert.equal(evaluateVisual(footage[i - 1], footage[i - 1].placement.end).scaleX, evaluateVisual(footage[i], footage[i].placement.begin).scaleX);
      }
    }
    const frame = new SceneGraph().evaluate(project, ticks(2.5), 720, 1280).layers.find(entry => entry.layer.asset?.kind === 'video').layer;
    assert.equal(frame.asset.path, path);
    assert.equal(frame.sourceTime, ticks(.5), 'The native video clock restarts at the expected loop boundary');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('five presentation styles change real native layout, background pixels and typography while keeping one bounded caption at a time', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-style-'));
  try {
    const image = join(directory, 'subject.png');
    await writeFile(image, sceneIllustrationPng({ title: '海岸风景' }, {}, 1, 480, 640).png);
    const recipe = { title: '同一个主题也可以有截然不同的观看方式', scenes: [
      { heading: '重复长驻章节不应出现', body: '先看清楚画面里最重要的主体，再看看它与周围环境是什么关系。', seconds: 1 },
      { heading: '也不应覆盖第二幕', body: '换一个观察角度，让新的画面自然展开。', seconds: 1 }
    ] };
    const styles = [], layouts = [], backgrounds = [], typefaces = [];
    for (let index = 0; index < 5; index++) {
      const draft = await composeDraft(recipe, join(directory, String(index)), { durationSeconds: 12, index, visuals: [{ path: image, kind: 'image' }] });
      validateProject(draft.project);
      assert.equal(draft.visualVersion, 4);
      styles.push(draft.presentationStyle);
      backgrounds.push((await readFile(draft.project.assets.find(asset => asset.path.includes('backdrop-')).path)).toString('base64'));
      const captionTrack = draft.project.timeline.tracks.find(track => track.name === '逐句字幕');
      const caption = captionTrack.items[0].clip.text;
      typefaces.push(caption.font?.identity || `${caption.fontFamily}:${caption.fontSize}:${caption.color}`);
      assert.ok(!draft.project.timeline.tracks.some(track => track.name === '章节'));
      for (const item of captionTrack.items) {
        assert.ok([...item.clip.text.content].length <= Math.floor(item.clip.text.layoutWidth / item.clip.text.fontSize) * 2, 'Title/caption is limited to one or two lines');
        assert.ok(!item.clip.text.content.includes('重复长驻章节'));
      }
      const graph = new SceneGraph();
      for (const seconds of [.5, 1.5, 3, 5.9, 6.1, 9, 11.5]) {
        const frame = graph.evaluate(draft.project, ticks(seconds), 720, 1280);
        const textLayers = frame.layers.filter(entry => entry.layer?.item.clip.type === 'text');
        assert.equal(textLayers.length, 1, `${draft.presentationStyle} only displays its opening title OR one caption`);
      }
      const photo = draft.project.timeline.tracks.find(track => track.name === '分镜画面').items[0];
      const visual = evaluateVisual(photo, ticks(3));
      layouts.push(JSON.stringify([visual.fitPolicy, visual.positionX, visual.positionY, visual.scaleX, visual.scaleY, visual.rotationDegrees, caption.fontSize, caption.color]));
      const geometry = layerGeometry(draft.project, visual, 480, 640, 720, 1280);
      if (draft.presentationStyle !== 'cinema') {
        assert.ok(geometry.bounds.y > 80 && geometry.bounds.y + geometry.bounds.height < 970, 'Photo panel leaves a separate readable caption area');
        const croppedRatio = (geometry.crop[2] * 480) / (geometry.crop[3] * 640);
        const drawnRatio = Math.hypot(geometry.matrix[0], geometry.matrix[1]) / Math.hypot(geometry.matrix[2], geometry.matrix[3]);
        assert.ok(Math.abs(croppedRatio - drawnRatio) < 1e-9, 'Framed photos retain their proportions');
      }
      if (draft.presentationStyle === 'collage') assert.ok(draft.project.timeline.tracks.flatMap(track => track.items).some(item => item.name.startsWith('拼贴 ')), 'Collage contains a separate actual image layer');
    }
    assert.equal(new Set(styles).size, 5);
    assert.equal(new Set(layouts).size, 5);
    assert.equal(new Set(backgrounds).size, 5);
    assert.ok(new Set(typefaces).size >= 3, 'Installed fonts produce distinct real typefaces/weights');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('a selected scene template drives its actual layout and an explicit presentation override takes precedence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-template-layout-'));
  try {
    const template = listTemplates().map(value => getTemplate(value.id)).find(value => value.style.presentationStyle !== 'cinema');
    assert.ok(template);
    const recipe = { title: '木瓜营养特点', tags: ['水果'], scenes: [{ heading: '果肉', body: '切开以后，观察果肉与种子。', seconds: 3 }] };
    const selected = await composeDraft(recipe, join(directory, 'template'), { index: 0, durationSeconds: 6, templateId: template.id });
    validateProject(selected.project);
    assert.equal(selected.templateId, template.id);
    assert.equal(selected.presentationStyle, template.style.presentationStyle);
    const photo = selected.project.timeline.tracks.find(track => track.name === '分镜画面').items[0];
    assert.equal(photo.clip.visual.fitPolicy, 'stretch');
    assert.ok(selected.project.assets.some(asset => asset.path.endsWith(`backdrop-${template.style.presentationStyle}.png`)));
    const overridden = await composeDraft(recipe, join(directory, 'override'), { durationSeconds: 6, templateId: template.id, presentationStyle: 'cinema' });
    assert.equal(overridden.templateId, template.id); assert.equal(overridden.presentationStyle, 'cinema');
    assert.equal(overridden.project.timeline.tracks.find(track => track.name === '分镜画面').items[0].clip.visual.fitPolicy, 'cover');
    assert.ok(overridden.project.assets.some(asset => asset.path.endsWith('backdrop-cinema.png')));
    const automatic = await composeDraft(recipe, join(directory, 'auto'), { durationSeconds: 6, templateId: 'auto', index: 2 });
    const expected = pickTemplate([recipe.title, ...recipe.tags].join(' '));
    assert.equal(automatic.templateId, expected.id); assert.equal(automatic.presentationStyle, 'collage');
    await assert.rejects(composeDraft(recipe, join(directory, 'invalid'), { presentationStyle: 'unregistered-style' }), /未知的视频版式/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('four specific templates mix one controlled scene graphic with native photo/PNG scenes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-template-media-'));
  try {
    const templates = listTemplates().filter(value => value.mediaPreset).map(value => getTemplate(value.id));
    assert.equal(templates.length, 4);
    for (const template of templates) {
      const { recipe } = template.example;
      const draft = await composeDraft(recipe, join(directory, template.id), { durationSeconds: 12, templateId: template.id });
      validateProject(draft.project); assert.equal(duration(draft.project), ticks(12));
      assert.ok(draft.mediaKinds.includes(template.mediaPreset.kind));
      const index = template.mediaPreset.sceneIndices[0], scenes = draft.project.timeline.tracks.find(track => track.name === '分镜画面').items;
      assert.equal(scenes.length, recipe.scenes.length);
      assert.ok(scenes.filter(item => item.clip.type === 'image').length >= recipe.scenes.length - 1);
      const controlled = scenes[index];
      if (template.mediaPreset.kind === 'markdown') {
        assert.equal(controlled.clip.type, 'image');
        assert.ok(draft.project.assets.find(asset => asset.id === controlled.clip.assetId).path.endsWith('-markdown.png'));
        const notes = draft.project.timeline.tracks.filter(track => track.name.startsWith('原生阅读笔记')).flatMap(track => track.items);
        assert.ok(notes.some(item => item.clip.text.content.includes(recipe.scenes[index].body)));
        assert.ok(notes.every(item => item.placement.begin === controlled.placement.begin && item.placement.end === controlled.placement.end));
        assert.ok(!draft.project.timeline.tracks.find(track => track.name === '逐句字幕').items.some(item => item.name.startsWith(`字幕 ${index + 1}.`)), 'The same body is not simultaneously repeated as captions');
      } else {
        assert.equal(controlled.clip.type, 'html-clip');
        assert.equal(controlled.clip.html.duration, controlled.placement.end - controlled.placement.begin);
        assert.equal(controlled.clip.source.begin, 0);
        assert.match(controlled.clip.html.html, template.mediaPreset.kind === 'svg' ? /<svg / : /<canvas /);
      }
      const automatic = await composeDraft(recipe, join(directory, `${template.id}-auto`), { durationSeconds: 6, templateId: 'auto', index: 1 });
      assert.equal(automatic.presentationStyle, 'magazine');
      assert.ok(!automatic.project.timeline.tracks.flatMap(track => track.items).some(item => item.clip.type === 'html-clip'));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('fractional narration duration does not put collage keyframes beyond quantized scene boundaries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-collage-rounding-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const recipe = { title: 'Fractional timing', tags: ['timing'], scenes: [5, 7, 7, 6].map((seconds, i) => ({ heading: `Scene ${i}`, body: 'A short readable caption.', seconds })) };
  const result = await composeDraft(recipe, directory, { presentationStyle: 'collage', durationSeconds: 23.556875 });
  assert.doesNotThrow(() => validateProject(result.project));
  const pictures = result.project.timeline.tracks.find(track => track.items.some(item => item.name.startsWith('拼贴'))).items;
  assert.equal(pictures.length, 4);
  for (const item of pictures) for (const curve of Object.values(item.clip.automation))
    assert.equal(curve.keyframes.at(-1).time, item.placement.end - item.placement.begin);
});

test('real narration yields complete subtitles from the first spoken moment through the final frame, independent of short scene summaries', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-full-captions-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const narration = '门外忽然传来三下敲门声。她没有开门，而是看向桌上那只空杯子。刚才只有一只杯子，现在却多出了一道湿手印。她终于意识到，声音不是来自门外，而是来自身后。';
  const recipe = { title: '不能代替开头旁白的标题', narration, tags: ['故事'], scenes: [
    { heading: '门外', body: '三下敲门声', seconds: 5 }, { heading: '空杯子', body: '湿手印', seconds: 9 }, { heading: '身后', body: '反转', seconds: 4 }
  ] };
  const result = await composeDraft(recipe, directory, { audioPath: new URL('../assets/samples/sample-coast.wav', import.meta.url).pathname, templateId: 'book-note' });
  validateProject(result.project);
  const captions = result.project.timeline.tracks.find(track => track.name === '逐句字幕').items;
  assert.equal(result.captionVersion, 3);
  assert.equal(captions.map(item => item.clip.text.content).join(''), narration);
  assert.equal(captions[0].placement.begin, 0);
  assert.equal(captions.at(-1).placement.end, ticks(result.durationSeconds));
  assert(!captions.some(item => item.name === '开场标题'));
  assert(captions.every(item => [...item.clip.text.content].length <= 30));
  for (let i = 1; i < captions.length; i++) assert.equal(captions[i - 1].placement.end, captions[i].placement.begin);
});

test('photo cuts have bounded native dissolves while real footage uses its own camera motion', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-film-cuts-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const result = await composeDraft({ title: '镜头连接', scenes: [{ heading: '远景', body: '看环境' }, { heading: '特写', body: '看细节' }] }, directory, { durationSeconds: 10 });
  const transition = result.project.timeline.transitions[0];
  assert.equal(transition.templateId, 'dissolve');
  const frame = new SceneGraph().evaluate(result.project, ticks(5), 720, 1280);
  assert.equal(frame.layers.filter(entry => entry.kind === 'transition').length, 1);
  validateProject(result.project);
});

test('voiced news works have native title bars, colored caption plates and entrance motion without obscuring the subject or losing narration', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-news-type-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const narration = '国庆节不是黄金周的另一种叫法。注意两个概念的区别。';
  const result = await composeDraft({ title: '国庆节，就是黄金周吗？', tags: ['国庆'], narration, scenes: [{ heading: '两个概念', body: '区分节日与假期' }] }, directory,
    { audioPath: new URL('../assets/samples/sample-coast.wav', import.meta.url).pathname, presentationStyle: 'cinema' });
  const items = result.project.timeline.tracks.flatMap(track => track.items);
  const headline = items.find(item => item.name === '作品标题');
  assert.equal(headline.clip.text.content, '国庆节，就是黄金周吗？');
  assert.equal(headline.clip.text.color, '#152039');
  assert.notEqual(evaluateVisual(headline, ticks(.04)).positionY, evaluateVisual(headline, ticks(.5)).positionY);
  const captions = result.project.timeline.tracks.find(track => track.name === '逐句字幕').items;
  assert.equal(captions.map(item => item.clip.text.content).join(''), narration);
  assert.ok(captions.some(item => item.clip.text.color === '#ffd078'));
  const graph = new SceneGraph();
  const layers = graph.evaluate(result.project, ticks(.6), 720, 1280).layers.map(entry => entry.layer);
  const caption = layers.find(layer => layer.item.name.startsWith('字幕 旁白'));
  const shadow = layers.find(layer => layer.item.name === '字幕阴影');
  assert.ok(layers.indexOf(caption) > layers.indexOf(shadow), 'Caption fill sits above its dark offset shadow');
  assert.ok(caption.visual.positionY - headline.clip.visual.positionY > 800, 'Titles and spoken words occupy independent safe areas');
  const header = pixels(await readFile(join(directory, 'type-news-header.png')));
  assert.equal(header.at(360, 640)[3], 0, 'Title plates leave the filmed subject visible');
  assert.ok(header.at(50, 70)[3] > 240);
  const plate = pixels(await readFile(join(directory, 'type-news-captions.png')));
  assert.deepEqual(plate.at(46, 1038).slice(0, 3), [230, 63, 82]);
  for (const item of items) for (const binding of Object.values(item.clip.automation || {})) for (const keyframe of binding.keyframes)
    assert.ok(keyframe.time <= item.clip.source.end && keyframe.time >= 0);
});

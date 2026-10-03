import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { listTemplates, getTemplate, instantiateTemplate, applyRecipeOverrides, pickTemplate, templateGenerationGuide } from '../server/templates.mjs';
import { validateRecipe } from '../server/recommendation.mjs';

test('catalog contains twenty distinct scene plans, complete field examples and runnable recipes', () => {
  const summaries = listTemplates();
  assert.ok(summaries.length >= 18);
  assert.equal(new Set(summaries.map(template => template.id)).size, summaries.length);
  const scripts = new Set(), descriptions = new Set(), structures = new Set(), styles = new Set();
  for (const summary of summaries) {
    assert.equal(summary.example, undefined, 'Selection metadata omits the full sample payload');
    assert.equal(summary.recipeTemplate, undefined);
    const template = getTemplate(summary.id);
    assert.ok(template.structure.length >= 3 && template.structure.length <= 5);
    assert.equal(template.structure.length, template.example.recipe.scenes.length);
    assert.equal(template.style.durationSeconds, template.structure.reduce((sum, scene) => sum + scene.seconds, 0));
    styles.add(template.style.presentationStyle);
    assert.deepEqual(validateRecipe(template.example.recipe), template.example.recipe);
    assert.deepEqual(instantiateTemplate(template.id).recipe, template.example.recipe);
    assert.deepEqual(instantiateTemplate(template.id, { values: template.example.values }).recipe, template.example.recipe, 'Displayed sample fields reconstruct the entire sample');
    for (const field of template.fields) {
      assert.match(field.key, /^[A-Za-z][A-Za-z0-9_]*$/);
      assert.match(field.label, /[\u4e00-\u9fff]/);
      assert.equal(typeof field.required, 'boolean');
      assert.equal(field.example, template.example.values[field.key]);
      assert.ok(field.example.length && field.example.length <= field.maxLength);
    }
    for (let index = 0; index < template.structure.length; index++) {
      const scene = template.example.recipe.scenes[index];
      assert.equal(template.structure[index].heading, scene.heading);
      assert.equal(template.structure[index].seconds, scene.seconds);
      assert.match(scene.visualQuery, /^[A-Za-z0-9][A-Za-z0-9 ,.'()\-]*$/);
      assert.ok(scene.visualPrompt && scene.body && !JSON.stringify(scene).includes('{{'));
    }
    scripts.add(template.example.recipe.narration);
    descriptions.add(template.description);
    structures.add(template.structure.map(scene => scene.purpose).join('|'));
  }
  assert.equal(scripts.size, summaries.length, 'Sample scripts differ beyond their titles');
  assert.equal(descriptions.size, summaries.length);
  assert.equal(structures.size, summaries.length, 'Each scene has a specific purpose, not a repeated generic plan');
  assert.deepEqual([...styles].sort(), ['cinema', 'collage', 'diary', 'explain', 'magazine']);
});

test('a custom topic requires actual field content and never falls back to the sample facts', () => {
  const template = getTemplate('science-explainer');
  const missing = instantiateTemplate(template.id, { topic: '城市水循环' });
  assert.equal(missing.recipe, null);
  assert.ok(missing.missingFields.length > 0);
  assert.equal(missing.missingFields.some(field => field.key === 'topic'), false);
  assert.ok(missing.missingFields.some(field => field.key === 'mechanism'));
  assert.equal(instantiateTemplate(template.id, { values: {} }).recipe, null);
  assert.equal(instantiateTemplate(template.id, { values: { topic: '新主题', phenomenon: '   ' }, overrides: { narration: '不能用旁白覆盖绕过缺项' } }).recipe, null);
  const values = Object.fromEntries(template.fields.map(field => [field.key, field.key === 'visualSubject' ? 'water cycle city' : `${field.label}：用户自行填写的水循环内容。`]));
  const result = instantiateTemplate(template.id, { topic: '城市水循环', values });
  assert.equal(result.recipe.title, '城市水循环');
  assert.deepEqual(result.missingFields, []);
  assert.ok(!JSON.stringify(result.recipe).includes('气球'));
  assert.ok(!JSON.stringify(result.recipe).includes('纸片'));
  assert.ok(result.recipe.scenes.every(scene => scene.visualQuery.startsWith('water cycle city ')));
  assert.equal(result.recipe.narration, result.recipe.scenes.map(scene => scene.body).join(''));
  validateRecipe(result.recipe);
});

test('sample copies and partial scene edits leave catalog originals and previous instances intact', () => {
  const before = getTemplate('micro-lesson');
  const first = instantiateTemplate(before.id);
  const modified = instantiateTemplate(before.id, { overrides: { scenes: [{ index: 2, heading: '找到颜色主体', body: '先挑出最醒目的一块颜色。', visualPrompt: '原创色块图示，主体颜色与背景形成对比。', visualQuery: 'color contrast composition diagram' }] } });
  assert.equal(modified.recipe.scenes[2].body, '先挑出最醒目的一块颜色。');
  assert.ok(modified.recipe.narration.includes('先挑出最醒目的一块颜色。'));
  for (const index of [0, 1, 3, 4]) assert.deepEqual(modified.recipe.scenes[index], before.example.recipe.scenes[index]);
  assert.deepEqual(first.recipe, before.example.recipe);
  const originalNarration = first.recipe.narration;
  first.recipe.scenes[0].body = '改动实例';
  before.example.values.goal = '改动返回的示例表单';
  before.fields[0].label = '改动返回的元数据';
  const after = getTemplate(before.id);
  assert.equal(after.example.recipe.narration, originalNarration);
  assert.notEqual(after.example.recipe.scenes[0].body, '改动实例');
  assert.notEqual(after.example.values.goal, '改动返回的示例表单');
  assert.equal(after.fields[0].label, '作品主题');
});

test('shared override helper supports narration-only changes, validates patches and keeps the source recipe immutable', () => {
  const source = getTemplate('book-note').example.recipe;
  const before = structuredClone(source);
  const result = applyRecipeOverrides(source, { narration: '单独改写的完整旁白。', scenes: [{ index: 1, body: '新的个人理解。' }] });
  assert.equal(result.narration, '单独改写的完整旁白。', 'An explicit narration overrides automatic scene-body joining');
  assert.deepEqual(source, before);
  result.scenes[0].body = '结果副本也独立';
  assert.deepEqual(source, before);
  for (const overrides of [
    { unknown: 'x' }, { scenes: [{ index: -1, body: 'x' }] },
    { scenes: [{ index: 0, body: 'x' }, { index: 0, body: 'y' }] },
    { scenes: [{ index: 1, seconds: 61 }] }, { scenes: [{ index: 1, visualQuery: 'https://example.test/image' }] },
    { scenes: [{ index: 1, visualPrompt: '', unsafe: true }] }, { scenes: { 0: { body: 'x' } } }
  ]) assert.throws(() => applyRecipeOverrides(source, overrides));
  assert.throws(() => instantiateTemplate('not-a-template'), /Template not found/);
  assert.throws(() => instantiateTemplate('science-explainer', { values: { unknown: 'x' } }), /Unknown template value/);
  assert.throws(() => instantiateTemplate('science-explainer', { values: null }), /must be an object/);
});

test('topic selection and generation guides preserve scenario intent without promising fabricated media', () => {
  for (const [topic, id] of [
    ['游戏战术复盘', 'game-commentary'], ['户外徒步装备', 'outdoor-sport'], ['英语情景跟读', 'language-practice'],
    ['读书摘录', 'book-note'], ['采访人物故事', 'interview-profile'], ['如何讲清缓存算法', 'tech-concept'],
    ['折纸手工', 'craft-steps'], ['城市散步游记', 'travel-diary'], ['问卷统计图表', 'data-story']
  ]) assert.equal(pickTemplate(topic).id, id);
  assert.equal(pickTemplate({ topic: '游戏解说' }).id, 'game-commentary');
  assert.equal(pickTemplate('').id, 'science-explainer');
  const guide = templateGenerationGuide('game-commentary', { topic: '用户授权的一段棋类实录', angle: '关键选择', language: 'zh' });
  assert.ok(guide.includes('用户授权的一段棋类实录'));
  assert.ok(guide.includes('先说明素材') && guide.includes('关键选择') && guide.includes('比较代价'));
  assert.ok(guide.includes('不得把示例') && guide.includes('不能声称已有游戏片段或已生成数字人'));
  assert.ok(!guide.includes(getTemplate('game-commentary').example.values.situation), 'A new-topic guide does not inherit sample facts');
  const selected = pickTemplate('游戏解说'); selected.name = '外部修改';
  assert.notEqual(pickTemplate('游戏解说').name, '外部修改');
});

test('four controlled media presets target existing scenes and disclose their limited adapters', () => {
  const presets = listTemplates().filter(template => template.mediaPreset);
  assert.equal(presets.length, 4);
  assert.deepEqual(presets.map(template => template.mediaPreset.kind).sort(), ['canvas', 'lottie', 'markdown', 'svg']);
  for (const template of presets) {
    assert.ok(template.mediaKinds.includes(template.mediaPreset.kind));
    assert.ok(template.mediaPreset.sceneIndices.every(index => Number.isInteger(index) && index >= 0 && index < template.structure.length));
    assert.ok(template.style.mediaGuide.includes('受控内置素材预设'));
  }
  const lottie = getTemplate('creative-process');
  assert.ok(lottie.style.mediaGuide.includes('不支持任意外部Lottie JSON'));
});

test('the static JSON catalog is embedded in the bundled registry without filesystem lookups', async () => {
  const bundle = await build({ entryPoints: [new URL('../server/templates.mjs', import.meta.url).pathname], bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent' });
  assert.ok(!bundle.outputFiles[0].text.includes('readFile('));
  const standalone = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  assert.equal(standalone.listTemplates().length, listTemplates().length);
  assert.deepEqual(standalone.instantiateTemplate('outdoor-sport').recipe, instantiateTemplate('outdoor-sport').recipe);
});

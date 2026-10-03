import { richDesign as design } from './fixtures/direction.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { validateRecipe } from '../server/recommendation.mjs';
import { createMcpHandler } from '../server/mcp.mjs';

const visualRecipe = () => ({ title: '落日颜色的三个观察', language: 'zh', tags: ['自然', '光线'],
  narration: '落日低悬在海平线时，太阳光穿过的大气更多。蓝色光更容易散射，直射光中暖色的比例就增加了。云层和空气里的颗粒也会影响我们看到的颜色。',
  visualTheme: '暖色海岸与简单光路示意', visualStyle: 'mixed', scenes: [
    { heading: '太阳低了', body: '光线穿过更多空气', visualPrompt: '低太阳与海平线的宽景，展示傍晚位置', visualQuery: 'sunset ocean horizon', seconds: 8 },
    { heading: '蓝光散开', body: '暖色更明显', visualPrompt: '空气剖面与不同颜色光线的示意', visualQuery: 'atmosphere light scattering diagram', seconds: 9 },
    { heading: '看云的颜色', body: '每次落日都不同', visualPrompt: '暖色与紫色云层的近景，强调云的形状', visualQuery: 'colorful sunset clouds', seconds: 8 }
  ] });
const submit = recipe => ({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'submit_draft',
  arguments: { jobId: 'job-1', claimToken: 'owned-claim', recipe } } });

test('visual descriptions survive recipe validation and MCP submission together with narration', async () => {
  const recipe = visualRecipe(); recipe.design = design(); recipe.design.shots.forEach((shot,index)=>shot.sceneIndex=index);
  recipe.design.captionKeywords=['蓝色光','暖色','云层'];
  const expected = structuredClone(recipe);
  recipe.visualTheme = '  ' + recipe.visualTheme + '  ';
  recipe.scenes[0].visualPrompt = '  ' + recipe.scenes[0].visualPrompt + '  ';
  recipe.scenes[0].visualQuery = '  ' + recipe.scenes[0].visualQuery + '  ';
  assert.deepEqual(validateRecipe(recipe), expected);
  const accepted = [];
  const handler = createMcpHandler({ store: { state: () => ({}) }, baseUrl: 'http://127.0.0.1:4000',
    submitDraft: async args => { accepted.push(validateRecipe(args.recipe)); return { status: 'composing' }; } });
  const result = await handler(submit(expected));
  assert.equal(result.result.structuredContent.status, 'composing');
  assert.deepEqual(accepted, [expected]);
});

test('historical card recipes and all five shipped samples remain valid without visual fields', async () => {
  const samples = JSON.parse(await readFile(new URL('../assets/samples/recipes.json', import.meta.url), 'utf8'));
  assert.equal(samples.length, 5);
  for (const { title, narration, tags, language, scenes } of samples) {
    const recipe = { title, narration, tags, language, scenes };
    assert.deepEqual(validateRecipe(recipe), recipe);
  }
  const card = { ...visualRecipe(), scenes: [{ heading: '标题', body: '仍然可以读取较早保存的文字卡片草稿。' }] };
  delete card.visualTheme; delete card.visualStyle;
  assert.deepEqual(validateRecipe(card), card);
});

test('visual metadata rejects URLs, paths, unknown fields and invalid sizes before acceptance', async () => {
  const invalid = [
    { ...visualRecipe(), visualStyle: 'video' },
    { ...visualRecipe(), visualTheme: ' '.repeat(8) },
    { ...visualRecipe(), visualTheme: '画'.repeat(501) },
    { ...visualRecipe(), scenes: [{ ...visualRecipe().scenes[0], visualPrompt: '画'.repeat(1201) }] },
    { ...visualRecipe(), scenes: [{ ...visualRecipe().scenes[0], visualPrompt: '' }] },
    { ...visualRecipe(), scenes: [{ ...visualRecipe().scenes[0], visualQuery: 'https://invented.example/sunset.jpg' }] },
    { ...visualRecipe(), scenes: [{ ...visualRecipe().scenes[0], visualQuery: '/private/local-image.png' }] },
    { ...visualRecipe(), scenes: [{ ...visualRecipe().scenes[0], imageUrl: 'https://invented.example/sunset.jpg' }] }
  ];
  let mutations = 0;
  const handler = createMcpHandler({ store: { state: () => ({}) }, baseUrl: 'http://127.0.0.1:4000',
    submitDraft: async args => { mutations++; validateRecipe(args.recipe); return {}; } });
  for (const recipe of invalid) {
    assert.throws(() => validateRecipe(recipe));
    const result = await handler(submit(recipe));
    assert.equal(result.result.isError, true);
  }
  assert.equal(mutations, 0, 'invalid descriptions must not be forwarded to the composer');
});

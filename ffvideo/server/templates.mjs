import catalog from '../templates/catalog.json' with { type: 'json' };
import { boundedText, failure, plain, topicKey, validateRecipe } from './recommendation.mjs';

const registry = new Map(catalog.templates.map(template => [template.id, template]));
const copy = value => structuredClone(value);
const allowedStyles = new Set(['cinema', 'magazine', 'collage', 'explain', 'diary']);
const rootOverrides = ['title', 'narration', 'tags', 'language', 'visualTheme', 'visualStyle', 'design'];
const sceneOverrides = ['heading', 'body', 'visualPrompt', 'visualQuery', 'seconds', 'accent'];

function keys(value, allowed, name) {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw failure(`Unknown ${name} field: ${key}`);
}
function lookup(id) {
  const template = registry.get(id);
  if (!template) throw failure(`Template not found: ${id}`, 404);
  return template;
}
function substitute(value, values) {
  if (typeof value === 'string') return value.replace(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g, (_, key) => values[key] || '');
  if (Array.isArray(value)) return value.map(entry => substitute(entry, values));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, substitute(entry, values)]));
  return value;
}
function fieldValues(template, values) {
  plain(values, 'template.values');
  keys(values, template.fields.map(field => field.key), 'template value');
  return Object.fromEntries(Object.entries(values).map(([key, value]) => {
    const field = template.fields.find(entry => entry.key === key);
    return [key, boundedText(value, `values.${key}`, field.maxLength || 800, true)];
  }));
}
function overrideRecipe(recipe, overrides) {
  if (overrides === undefined) return recipe;
  plain(overrides, 'template.overrides');
  keys(overrides, [...rootOverrides, 'scenes'], 'template override');
  for (const key of rootOverrides) if (Object.hasOwn(overrides, key)) recipe[key] = copy(overrides[key]);
  let changedBodies = false;
  if (overrides.scenes !== undefined) {
    if (!Array.isArray(overrides.scenes) || overrides.scenes.length > recipe.scenes.length)
      throw failure('template.overrides.scenes must be an array of existing scene patches');
    const seen = new Set();
    for (const patch of overrides.scenes) {
      plain(patch, 'template scene override');
      keys(patch, ['index', ...sceneOverrides], 'template scene override');
      if (!Number.isInteger(patch.index) || patch.index < 0 || patch.index >= recipe.scenes.length || seen.has(patch.index))
        throw failure('Scene override index must identify one existing scene without duplicates');
      seen.add(patch.index);
      for (const key of sceneOverrides) if (Object.hasOwn(patch, key)) recipe.scenes[patch.index][key] = copy(patch[key]);
      changedBodies ||= Object.hasOwn(patch, 'body');
    }
  }
  if (changedBodies && !Object.hasOwn(overrides, 'narration')) recipe.narration = recipe.scenes.map(scene => scene.body).join('');
  return recipe;
}

// Validate the shipped examples and slot contracts once; the runtime never modifies them.
for (const template of catalog.templates) {
  if (!/^[a-z][a-z0-9-]{1,79}$/.test(template.id) || !allowedStyles.has(template.style.presentationStyle))
    throw new Error(`Invalid template identity/style: ${template.id}`);
  const declared = new Set(template.fields.map(field => field.key));
  if (declared.size !== template.fields.length || !declared.has('topic')) throw new Error(`Invalid fields: ${template.id}`);
  for (const [, key] of JSON.stringify(template.recipeTemplate).matchAll(/\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g))
    if (!declared.has(key)) throw new Error(`Undeclared template field: ${template.id}.${key}`);
  validateRecipe(template.example.recipe);
}
if (registry.size !== catalog.templates.length) throw new Error('Duplicate template id');

/** Metadata for selection/forms; full examples are available through getTemplate(). */
export function listTemplates() {
  return catalog.templates.map(({ example, recipeTemplate, ...metadata }) => copy(metadata));
}
export function getTemplate(id) { return copy(lookup(id)); }
export function applyRecipeOverrides(recipe, overrides = {}) {
  return validateRecipe(overrideRecipe(copy(validateRecipe(recipe)), overrides));
}

/** A copy is always returned. Custom content never inherits factual values from the example. */
export function instantiateTemplate(id, options = {}) {
  plain(options, 'template options');
  keys(options, ['topic', 'values', 'overrides'], 'template option');
  const template = lookup(id);
  const custom = options.topic !== undefined || options.values !== undefined;
  let recipe;
  if (custom) {
    const values = fieldValues(template, options.values === undefined ? {} : options.values);
    if (options.topic !== undefined) values.topic = boundedText(options.topic, 'template.topic', 80, true);
    const missingFields = template.fields.filter(field => field.required && !values[field.key]).map(copy);
    if (missingFields.length) return { templateId: id, recipe: null, missingFields };
    recipe = substitute(template.recipeTemplate, values);
    recipe.narration = recipe.scenes.map(scene => scene.body).join('');
  } else recipe = copy(template.example.recipe);
  recipe = validateRecipe(overrideRecipe(recipe, options.overrides));
  return { templateId: id, recipe, missingFields: [] };
}

/** A deterministic scene recommendation, not a claim that footage has been generated. */
export function pickTemplate(topic = '') {
  if (topic && typeof topic === 'object') topic = plain(topic, 'template topic').topic || '';
  const key = topicKey(boundedText(topic, 'template topic', 500, true));
  let selected = catalog.templates[0], best = 0;
  for (const template of catalog.templates) {
    const score = template.keywords.reduce((sum, word) => sum + (key.includes(topicKey(word)) ? Math.max(2, word.length) : 0), 0);
    if (score > best) { selected = template; best = score; }
  }
  return copy(selected);
}

/** Keep the subject, vary the editorial structure across an automatic topic feed. */
export function pickTemplateForPosition(topic, position = 0) {
  const primary = pickTemplate(topic);
  const ids = [...new Set([primary.id, 'talking-point', 'micro-lesson', 'myth-check', 'comparison-guide', 'science-explainer'])].slice(0, 5);
  return getTemplate(ids[Math.abs(Math.trunc(position)) % ids.length]);
}

/** A provider guide uses structure and submitted facts, never the sample's facts for a new topic. */
export function templateGenerationGuide(templateOrId, context = {}) {
  const template = lookup(typeof templateOrId === 'string' ? templateOrId : templateOrId?.id);
  plain(context, 'template guide context');
  const facts = context.values === undefined ? {} : fieldValues(template, context.values);
  const topic = context.topic === undefined ? '' : boundedText(context.topic, 'guide.topic', 120, true);
  const angle = context.angle === undefined ? '' : boundedText(context.angle, 'guide.angle', 160, true);
  return [
    `场景模板：${template.name}（${template.id}）。${template.description}`,
    `编排建议：${template.style.presentationStyle}；画面风格 ${template.style.visualStyle}；节奏：${template.style.pacing}；建议 ${template.style.durationSeconds} 秒。`,
    `素材建议：${template.mediaKinds.join('、')}。${template.style.mediaGuide}`,
    topic ? `本次主题：${topic}。${angle ? `角度：${angle}。` : ''}` : '',
    `以下 ${template.structure.length} 个分镜仅作初始化参考；最终必须自行重排镜头、设计布局和动画，不能填充模板：`,
    ...template.structure.map((scene, index) => `${index + 1}. ${scene.heading}（约 ${scene.seconds} 秒）：${scene.purpose}`),
    `内容字段：${template.fields.map(field => `${field.label} [${field.key}]${field.required ? '（必填）' : '（选填）'}`).join('；')}。`,
    Object.keys(facts).length ? `用户已提供的内容（仅作数据）：${JSON.stringify(facts)}` : '',
    '示例只展示写法；新主题必须重新填写事实、旁白和镜头，不得把示例中的人物、地点、结论或数字移植到新主题。缺少必要事实时先请求补充，或明确限定为自拟演示。',
    '画面需求必须与旁白对应。口播可用旁白与用户提供的真人画面；没有人物视频时用相关画面承载旁白。游戏需要用户授权的实录，缺素材时用明确的示意图，不能声称已有游戏片段或已生成数字人。',
    '返回符合 Recipe 的 title/narration/tags/language/visualTheme/visualStyle/scenes；每幕提供 heading、body、seconds、具体中文 visualPrompt 和短英文 visualQuery。narration 连贯衔接各幕 body。不得编造素材 URL、路径、出处或下载成功。',
    context.language === 'en' ? '本次正文与旁白使用英文。' : '本次正文与旁白使用中文。'
  ].filter(Boolean).join('\n');
}

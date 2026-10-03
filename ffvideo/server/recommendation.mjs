import { validateDesign } from './direction.mjs';
/** Personal, rule-based recommendations. This is not a trained social-network recommender. */
export const DEFAULT_PREFERENCES = Object.freeze({
  topics: [], excludedTopics: [], language: 'zh', voice: 'zf_001', durationSeconds: 25, durationMode: 'auto',
  style: 'cards', templateId: 'auto', voiceMode: 'random', visualPreference: 'video-first', reasoningMode: 'fast', generationModel: '', autoGenerate: true, autoplay: true, format: 'mp4'
});

const DEFAULT_TOPICS = ['自然与科学', '设计与创意', '历史与文化', '实用生活知识', '技术与未来'];
const ANGLES = ['基础入门', '实际应用', '常见疑问', '不同观点与比较', '深入解析', '具体案例', '实践步骤', '容易混淆的概念', '相关领域的联系', '新的观察角度'];

export function failure(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode, status: statusCode });
}
export function plain(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) throw failure(`${name} must be an object`);
  return value;
}
export function boundedText(value, name, max, allowEmpty = false) {
  if (typeof value !== 'string' || value.length > max || (!allowEmpty && !value.trim()))
    throw failure(`${name} must be ${allowEmpty ? 'a' : 'a non-empty'} string of at most ${max} characters`);
  return value.trim();
}
export const topicKey = value => String(value).normalize('NFKC').trim().toLocaleLowerCase();
function strings(value, name, max, length) {
  if (!Array.isArray(value) || value.length > max) throw failure(`${name} must contain at most ${max} strings`);
  const seen = new Set();
  return value.map(v => boundedText(v, name, length)).filter(v => {
    const key = topicKey(v);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function strictKeys(value, keys, name) {
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw failure(`Unknown ${name} field: ${key}`);
}
export function normalizePreferences(patch, previous = DEFAULT_PREFERENCES) {
  plain(patch, 'preferences');
  strictKeys(patch, Object.keys(DEFAULT_PREFERENCES), 'preference');
  const prefs = structuredClone(previous);
  for (const [key, value] of Object.entries(patch)) {
    if (key === 'topics' || key === 'excludedTopics') prefs[key] = strings(value, key, 24, 120);
    else if (key === 'language') {
      if (!['zh', 'en'].includes(value)) throw failure('language must be zh or en');
      prefs[key] = value;
    } else if (key === 'voice') {
      if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw failure('Invalid voice');
      prefs[key] = value;
    } else if (key === 'templateId') {
      if (typeof value !== 'string' || !/^[a-z][a-z0-9-]{1,79}$/.test(value)) throw failure('Invalid templateId');
      prefs[key] = value;
    } else if (key === 'voiceMode') {
      if (!['random', 'fixed'].includes(value)) throw failure('voiceMode must be random or fixed');
      prefs[key] = value;
    } else if (key === 'visualPreference') {
      if (!['video-first', 'photo-first', 'auto', 'illustration'].includes(value)) throw failure('Invalid visualPreference');
      prefs[key] = value;
    } else if (key === 'durationSeconds') {
      if (!Number.isFinite(value) || value < 8 || value > 120) throw failure('durationSeconds must be between 8 and 120');
      prefs[key] = value;
    } else if (key === 'durationMode') {
      if (!['auto', 'fixed'].includes(value)) throw failure('durationMode must be auto or fixed');
      prefs[key] = value;
    } else if (key === 'reasoningMode') {
      if (!['none', 'fast', 'standard'].includes(value)) throw failure('reasoningMode must be none, fast or standard');
      prefs[key] = value;
    } else if (key === 'generationModel') {
      if (typeof value !== 'string' || value.length > 80 || (value && !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value))) throw failure('Invalid generationModel');
      prefs[key] = value;
    } else if (key === 'style') {
      if (value !== 'cards') throw failure('Only cards style is supported');
      prefs[key] = value;
    } else if (key === 'format') {
      if (!['mp4', 'webm'].includes(value)) throw failure('format must be mp4 or webm');
      prefs[key] = value;
    } else {
      if (typeof value !== 'boolean') throw failure(`${key} must be boolean`);
      prefs[key] = value;
    }
  }
  return prefs;
}

export function validateRecipe(input) {
  plain(input, 'recipe');
  strictKeys(input, ['title', 'narration', 'tags', 'scenes', 'language', 'visualTheme', 'visualStyle', 'design'], 'recipe');
  const title = boundedText(input.title, 'title', 160);
  const narration = boundedText(input.narration, 'narration', 5000);
  const tags = strings(input.tags, 'tags', 16, 80);
  if (!['zh', 'en'].includes(input.language)) throw failure('recipe.language must be zh or en');
  if (!Array.isArray(input.scenes) || !input.scenes.length || input.scenes.length > 20)
    throw failure('recipe.scenes must contain between 1 and 20 scenes');
  const scenes = input.scenes.map((scene, index) => {
    plain(scene, `scenes[${index}]`);
    strictKeys(scene, ['heading', 'body', 'seconds', 'accent', 'visualPrompt', 'visualQuery'], 'scene');
    const result = { heading: boundedText(scene.heading, 'heading', 160), body: boundedText(scene.body, 'body', 800) };
    if (scene.seconds !== undefined) {
      if (!Number.isFinite(scene.seconds) || scene.seconds < 1 || scene.seconds > 60)
        throw failure('scene.seconds must be between 1 and 60');
      result.seconds = scene.seconds;
    }
    if (scene.accent !== undefined) {
      if (typeof scene.accent !== 'string' || !/^#(?:[a-f\d]{3}|[a-f\d]{4}|[a-f\d]{6}|[a-f\d]{8})$/i.test(scene.accent))
        throw failure('scene.accent must be a hex color');
      result.accent = scene.accent;
    }
    if (scene.visualPrompt !== undefined) result.visualPrompt = boundedText(scene.visualPrompt, 'scene.visualPrompt', 1200);
    if (scene.visualQuery !== undefined) {
      const query = boundedText(scene.visualQuery, 'scene.visualQuery', 160);
      if (!/^[A-Za-z0-9][A-Za-z0-9 ,.'()\-]*$/.test(query))
        throw failure('scene.visualQuery must be a short English media search query, not a URL or path');
      result.visualQuery = query;
    }
    return result;
  });
  if (scenes.reduce((sum, scene) => sum + (scene.seconds ?? 5), 0) > 180) throw failure('Scenes exceed 180 seconds');
  const result = { title, narration, tags, scenes, language: input.language };
  if (input.design !== undefined) result.design = validateDesign(input.design, scenes.length);
  if (result.design?.captionKeywords?.some(word=>!narration.includes(word))) throw failure('字幕强调词必须来自真实旁白');
  if (input.visualTheme !== undefined) result.visualTheme = boundedText(input.visualTheme, 'visualTheme', 500);
  if (input.visualStyle !== undefined) {
    if (!['photo', 'illustration', 'mixed'].includes(input.visualStyle)) throw failure('recipe.visualStyle must be photo, illustration or mixed');
    result.visualStyle = input.visualStyle;
  }
  return result;
}

export function isExcluded(topic, preferences) {
  const key = topicKey(topic);
  return preferences.excludedTopics.some(t => key.includes(topicKey(t)));
}
export function interestScore(topic, interest = {}) {
  const key = topicKey(topic);
  return Number(Object.hasOwn(interest, key) ? interest[key]?.score || 0 : 0);
}
export function adjustInterest(interest, topics, delta, intent, now = Date.now()) {
  const unique = new Map(topics.map(topic => [topicKey(topic), String(topic)]));
  for (const topic of [...unique.values()].slice(0, 16)) {
    const key = topicKey(topic);
    if (!key) continue;
    const old = Object.hasOwn(interest, key) ? interest[key] : { topic, score: 0, positive: 0, negative: 0, updatedAt: now };
    // Gradual decay prevents one old interaction from dominating indefinitely.
    const decay = Math.pow(0.95, Math.max(0, now - old.updatedAt) / 86400000);
    Object.defineProperty(interest, key, { enumerable: true, configurable: true, writable: true, value: {
      ...old, score: Math.max(-12, Math.min(12, old.score * decay + delta)),
      positive: old.positive + Math.max(0, delta), negative: old.negative + Math.max(0, -delta),
      updatedAt: now, lastIntent: intent,
      suppressed: intent === 'exclude' ? true : intent === 'explicit-topic' ? false : Boolean(old.suppressed)
    } });
  }
}
export function commentIntent(text) {
  if (/不要|不想|少推|别(?:再)?|不感兴趣|stop recommending|not interested|less of/i.test(text)) return 'exclude';
  if (/不准确|错误|说错|假的|有误|incorrect|wrong|false/i.test(text)) return 'correction';
  if (/为什么|如何|怎么|更多|多讲|深入|详细|展开|more|why|how|detail/i.test(text)) return 'request-more';
  if (/喜欢|不错|想看|interesting|love|\blike\b/i.test(text)) return 'positive';
  return 'neutral';
}

/** Plans angles only; agents must supply real scripts. No topic facts are invented here. */
export function planRecommendations({ preferences, interest = {}, feed, jobs = [], works = [], count, now = Date.now() }) {
  const allowed = topic => !isExcluded(topic, preferences) && !(Object.hasOwn(interest, topicKey(topic)) && interest[topicKey(topic)].suppressed);
  const explicit = preferences.topics.filter(allowed);
  const learned = Object.values(interest).filter(t => t.score > 0 && allowed(t.topic))
    .sort((a, b) => b.score - a.score).map(t => t.topic);
  const exploration = DEFAULT_TOPICS.filter(allowed);
  const focused = feed.topic && allowed(feed.topic) ? [feed.topic] : [];
  if (feed.topic && !focused.length) return [];
  const candidates = [...new Set([...focused, ...explicit, ...learned, ...exploration])].filter(allowed);
  if (!candidates.length) return [];
  const history = [...jobs, ...works].filter(item => item.feedId === feed.id);
  const baseIndex = jobs.filter(job => job.feedId === feed.id && job.status !== 'cancelled').length;
  const plans = [];
  for (let offset = 0; offset < count; offset++) {
    const index = baseIndex + offset;
    const core = focused.length ? focused : explicit.length ? explicit :
      learned.length ? [...new Set([...learned, ...focused])] : focused.length ? focused : candidates;
    // Topic feeds remain on that topic; only the recommendation tab explores other subjects.
    const pool = focused.length ? focused : index % 5 === 4 && exploration.length ? exploration : core;
    const ordered = [...pool].sort((a, b) => interestScore(b, interest) - interestScore(a, interest));
    const topic = ordered[index % ordered.length];
    const topicCount = history.concat(plans).filter(item => topicKey(item.topic) === topicKey(topic)).length;
    const angle = ANGLES[topicCount % ANGLES.length] + (topicCount >= ANGLES.length ? ` · 新的子主题 ${Math.floor(topicCount / ANGLES.length) + 1}` : '');
    plans.push({ feedId: feed.id, topic, angle, createdAt: now });
  }
  return plans;
}

export function rankWorks(works, preferences, interest = {}, metrics = {}) {
  return works.filter(work => !isExcluded(work.topic, preferences) && !work.tags.some(tag => isExcluded(tag, preferences)) &&
      !(Object.hasOwn(interest, topicKey(work.topic)) && interest[topicKey(work.topic)].suppressed))
    .map((work, index) => {
      const explicit = preferences.topics.some(topic => [work.topic, ...work.tags].some(t => topicKey(t).includes(topicKey(topic))));
      const learned = Math.max(interestScore(work.topic, interest), ...work.tags.map(tag => interestScore(tag, interest)));
      const seen = Boolean(metrics[work.id]?.seen);
      return { work, index, score: (explicit ? 50 : 0) + learned + (!seen ? 20 : 0) + (index % 5 === 4 ? 0.5 : 0) };
    }).sort((a, b) => b.score - a.score || b.work.createdAt - a.work.createdAt || a.index - b.index)
    .map(({ work }) => work);
}

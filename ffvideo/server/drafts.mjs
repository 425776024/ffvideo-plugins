import { composeDirectedDraft } from './direction.mjs';
import { writeFile, mkdir, readFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { createProject, addAsset, addText, addHtmlClip, validateProject, ticks, identity } from '../../packages/core/project.mjs';
import { probe, run } from '../../packages/server/media.mjs';
import { captionShadePng, sceneIllustrationPng, presentationStyle, presentationBackdropPng, PRESENTATION_STYLES } from './illustrations.mjs';
import { systemFonts } from '../../packages/server/system-fonts.mjs';
import { plainTextFontProjection } from '../../packages/text-wasm/src/system-fonts.mjs';
import { getTemplate, pickTemplate } from './templates.mjs';
import { sceneMediaForIndex, createSceneMedia } from './scene-media.mjs';
import { CAPTION_VERSION, addTypography, animateTypography, emphasizeCaption } from './typography.mjs';
export { CAPTION_VERSION } from './typography.mjs';

// Procedural background belongs to the composition, so preview and export match.
function crc(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let k = 0; k < 8; k++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}
function chunk(name, bytes) {
  const body = Buffer.concat([Buffer.from(name), bytes]);
  const header = Buffer.alloc(4), tail = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length); tail.writeUInt32BE(crc(body));
  return Buffer.concat([header, body, tail]);
}
export function backgroundPng(accent = '#6ee7b7', width = 720, height = 1280) {
  const rgb = /^#[a-fA-F0-9]{6}$/.test(accent) ? [1, 3, 5].map(i => parseInt(accent.slice(i, i + 2), 16)) : [110, 231, 183];
  const bytes = Buffer.alloc((width * 3 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const glow = Math.max(0, 1 - Math.hypot((x - width * .75) / width, (y - height * .25) / height) * 1.4);
    const base = (y > height * .61 && x < width * .6) ? 2 : 0;
    for (let c = 0; c < 3; c++) bytes[y * (width * 3 + 1) + 1 + x * 3 + c] = Math.round(10 + c * 3 + base + rgb[c] * glow * .22);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(bytes)), chunk('IEND', Buffer.alloc(0))]);
}
const accents = ['#6ee7b7', '#a5b4fc', '#f9a8d4', '#7dd3fc', '#fcd34d'];
function text(project, content, { start = 0, length, y, size = 36, color = '#f5f7fb', trackId, width = 600, font }) {
  // Quantize absolute boundaries once: separately rounded begin + length can overlap
  // the following subtitle by one tick for an arbitrary real narration duration.
  const startTicks = ticks(start), lengthTicks = ticks(start + length) - startTicks;
  const item = addText(project, { content, start: startTicks, length: lengthTicks, fontSize: size, color, trackId, validate: false });
  item.clip.visual.positionY = y;
  item.clip.text.layoutWidth = width;
  if (font) { item.clip.text.font = plainTextFontProjection(font); item.clip.text.fontFamily = font.family; }
  const localLength = lengthTicks / 120000;
  const fade = Math.min(.35, localLength * .2);
  item.clip.automation = { 'visual.opacity': { timeDomain: 'itemLocal', keyframes: [
    [0, 0], [fade, 1], [localLength - fade, 1], [localLength, 0]
  ].map(([t, value]) => ({ id: identity('keyframe'), time: ticks(t), value, interpolation: 'linear' })) } };
  return item;
}
const curve = (points) => ({ timeDomain: 'itemLocal', keyframes: points.map(([time, value]) => ({
  id: identity('keyframe'), time: ticks(time), value, interpolation: 'linear'
})) });
/** Captions preserve the complete authored body but reveal at most two short lines at once. */
export function captionSegments(body, maxCharacters = 40) {
  const sentences = String(body || '').match(/[^。！？!?；;\n]+[。！？!?；;]?|[\n]+/gu) || [];
  const segments = [];
  for (const sentence of sentences) {
    const characters = [...sentence.trim()];
    const count = Math.ceil(characters.length / maxCharacters);
    for (let part = 0; part < count; part++) segments.push(characters.splice(0, Math.ceil(characters.length / (count - part))).join(''));
  }
  return segments.length ? segments : [''];
}
function cropForFrame(asset, frame) {
  const sourceRatio = asset.width / asset.height, targetRatio = frame.width / frame.height;
  const horizontal = Math.max(0, (1 - targetRatio / sourceRatio) / 2);
  const vertical = Math.max(0, (1 - sourceRatio / targetRatio) / 2);
  return { left: horizontal, right: horizontal, top: vertical, bottom: vertical };
}
function motion(item, asset, segmentLength, offset, sceneLength, sceneIndex, style, frame = style.photo) {
  // Rounded scene boundaries define the clip length; independently rounding the
  // floating duration can put the final keyframe one tick beyond a collage clip.
  segmentLength = (item.placement.end - item.placement.begin) / 120000;
  const full = style.id === 'cinema';
  item.clip.visual.fitPolicy = full ? 'cover' : 'stretch';
  if (!full) item.clip.visual.crop = cropForFrame(asset, frame);
  item.clip.visual.rotationDegrees = frame.rotation;
  const baseX = full ? 0 : frame.x + frame.width / 2 - 360, baseY = full ? 0 : frame.y + frame.height / 2 - 640;
  const baseScaleX = full ? 1 : frame.width / 720, baseScaleY = full ? 1 : frame.height / 1280;
  item.clip.visual.positionX = baseX; item.clip.visual.positionY = baseY;
  item.clip.visual.scaleX = baseScaleX; item.clip.visual.scaleY = baseScaleY;
  if (asset.hasAudio) item.clip.audio.muted = true;
  const first = offset / sceneLength, last = (offset + segmentLength) / sceneLength;
  const scale = progress => (full ? 1.06 : 1) + (asset.kind === 'video' ? 0 : style.zoom) * (sceneIndex % 2 ? 1 - progress : progress);
  const amount = asset.kind === 'video' ? 0 : full ? 12 : 2;
  const pan = progress => (sceneIndex % 2 ? -1 : 1) * (amount - progress * amount * 2);
  item.clip.automation = {
    'visual.scaleX': curve([[0, baseScaleX * scale(first)], [segmentLength, baseScaleX * scale(last)]]),
    'visual.scaleY': curve([[0, baseScaleY * scale(first)], [segmentLength, baseScaleY * scale(last)]]),
    'visual.positionX': curve([[0, baseX + pan(first)], [segmentLength, baseX + pan(last)]]),
    'visual.positionY': curve([[0, baseY - amount + first * amount * 2], [segmentLength, baseY - amount + last * amount * 2]])
  };
}
async function presentationFont(style, recipe) {
  try {
    const catalog = await systemFonts.catalog(), cjk = /[\p{Script=Han}]/u.test(recipe.title + recipe.scenes.map(scene => scene.body).join(''));
    const families = cjk ? {
      serif: ['Songti SC', 'SimSun', 'Noto Serif CJK SC', 'Source Han Serif SC'], handwriting: ['Kaiti SC', 'STKaiti', 'KaiTi', 'Songti SC', 'SimSun'],
      sans: ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC'], 'sans-bold': ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC'], rounded: ['PingFang SC', 'Microsoft YaHei', 'Noto Sans CJK SC']
    } : { serif: ['Georgia', 'Times New Roman', 'Liberation Serif'], handwriting: ['American Typewriter', 'Georgia', 'Liberation Serif'], sans: ['Arial', 'DejaVu Sans'], 'sans-bold': ['Arial', 'DejaVu Sans'], rounded: ['Avenir Next', 'Arial', 'DejaVu Sans'] };
    const normalize = value => value.toLowerCase().replace(/[\s_-]/g, ''), targetWeight = style.font === 'sans-bold' ? 600 : style.font === 'rounded' ? 300 : style.font === 'sans' ? 500 : 400;
    for (const family of families[style.font]) {
      const choices = catalog.fonts.filter(font => normalize(font.family) === normalize(family) && font.slant === 'upright');
      if (choices.length) return choices.sort((a, b) => Math.abs(a.weight - targetWeight) - Math.abs(b.weight - targetWeight))[0];
    }
    return catalog.fonts.find(font => font.id === catalog.defaults[cjk ? 'cjk' : 'sans']);
  } catch { return undefined; }
}
export async function composeDraft(recipe, directory, { audioPath, index = 0, durationSeconds = 25, maxDurationSeconds, visuals = [], templateId, presentationStyle: requestedPresentation } = {}) {
  if (recipe.design) return composeDirectedDraft(recipe, directory, { audioPath, durationSeconds, maxDurationSeconds, visuals, text, fontFor: presentationFont, captionSegments });
  const template = templateId === 'auto' ? pickTemplate([recipe.title, ...recipe.tags || []].join(' ').slice(0, 500)) : templateId ? getTemplate(templateId) : null;
  const requestedStyle = requestedPresentation === 'auto' ? undefined : requestedPresentation;
  const styleId = requestedStyle || (templateId !== 'auto' ? template?.style.presentationStyle : undefined);
  const style = styleId ? PRESENTATION_STYLES.find(value => value.id === styleId) : presentationStyle(index);
  if (!style) throw new Error(`未知的视频版式：${styleId}`);
  await mkdir(directory, { recursive: true });
  const project = createProject(recipe.title); project.canvas = { width: 720, height: 1280 };
  const font = await presentationFont(style, recipe);
  let length = durationSeconds;
  const audio = audioPath ? await probe(audioPath) : null;
  if (audio) length = audio.duration / 120000;
  length = Math.max(3, Math.min(180, length));
  const scenes = recipe.scenes;
  const weights = scenes.map(scene => scene.seconds ?? 5);
  const weightSum = weights.reduce((sum, value) => sum + value, 0);
  const assetCache = new Map(), visualCredits = [], illustrationThemes = [], mediaKinds = new Set();
  let mediaTrack, secondaryTrack, posterPath;
  const timings = [];
  let start = 0;
  for (let i = 0; i < scenes.length; i++) {
    const end = i === scenes.length - 1 ? length : start + length * weights[i] / weightSum;
    const sceneLength = end - start;
    const sceneBegin = ticks(start), sceneEnd = ticks(end);
    const preset = sceneMediaForIndex(templateId === 'auto' ? null : template, i);
    const prepared = preset ? await createSceneMedia(preset, { scene: scenes[i], durationSeconds: (sceneEnd - sceneBegin) / 120000,
      width: 720, height: Math.round(720 * style.photo.height / style.photo.width) }) : null;
    if (prepared) mediaKinds.add(prepared.format);
    const generic = visuals.filter(visual => visual.sceneIndex === undefined);
    let visual = visuals.find(visual => visual.sceneIndex === i) || generic[i % generic.length];
    if (prepared?.kind === 'native') {
      const path = join(directory, `scene-${i + 1}-${prepared.format}.png`);
      await writeFile(path, prepared.png); visual = { path, kind: 'image', prepared };
    } else if (prepared?.kind === 'html') visual = { kind: 'html', prepared };
    if (!visual) {
      const artwork = sceneIllustrationPng(recipe, scenes[i], index + i);
      const path = join(directory, `scene-${i + 1}.png`);
      await writeFile(path, artwork.png);
      illustrationThemes.push(artwork.theme);
      visual = { path, kind: 'image' };
    }
    let asset = prepared?.kind === 'html' ? { width: prepared.html.width, height: prepared.html.height, kind: 'html' } : assetCache.get(visual.path);
    if (!asset) {
      asset = await probe(visual.path);
      if (!['image', 'video'].includes(asset.kind)) throw new Error('分镜画面素材必须是图片或视频');
      assetCache.set(visual.path, asset);
    }
    mediaKinds.add(prepared?.format || asset.kind);
    if (!posterPath && asset.kind === 'image') posterPath = visual.path;
    if (visual.credit && !visualCredits.some(credit => JSON.stringify(credit) === JSON.stringify(visual.credit))) visualCredits.push(visual.credit);
    // Native footage is looped only when shorter than the scene, without stretching its source clock.
    let offset = 0;
    while (sceneBegin + offset < sceneEnd) {
      const segmentTicks = asset.kind === 'video' ? Math.min(asset.duration, sceneEnd - sceneBegin - offset) : sceneEnd - sceneBegin - offset;
      const picture = prepared?.kind === 'html'
        ? addHtmlClip(project, { html: prepared.html, name: `${prepared.format} 图解`, start: sceneBegin, length: segmentTicks, trackId: mediaTrack, validate: false })
        : addAsset(project, asset, { start: sceneBegin + offset, trackId: mediaTrack, validate: false });
      mediaTrack ||= project.timeline.tracks.find(track => track.items.some(item => item.id === picture.id)).id;
      picture.name = `画面 ${i + 1} · ${scenes[i].heading}`;
      picture.placement.end = picture.placement.begin + segmentTicks;
      picture.clip.source.end = segmentTicks;
      motion(picture, asset, segmentTicks / 120000, offset / 120000, sceneLength, i, style);
      offset += segmentTicks;
    }
    if (style.secondary && !prepared) {
      const nextVisual = visuals.find(visual => visual.sceneIndex === (i + 1) % scenes.length) || generic[(i + 1) % generic.length] || visual;
      let secondary = assetCache.get(nextVisual.path);
      if (!secondary) { secondary = await probe(nextVisual.path); assetCache.set(nextVisual.path, secondary); }
      if (secondary.kind === 'image') {
        const item = addAsset(project, secondary, { start: sceneBegin, trackId: secondaryTrack, validate: false });
        secondaryTrack ||= project.timeline.tracks.at(-1).id;
        item.name = `拼贴 ${i + 1}`; item.placement.end = sceneEnd; item.clip.source.end = sceneEnd - sceneBegin;
        motion(item, secondary, sceneLength, 0, sceneLength, i + 1, style, style.secondary);
        if (nextVisual.credit && !visualCredits.some(credit => JSON.stringify(credit) === JSON.stringify(nextVisual.credit))) visualCredits.push(nextVisual.credit);
      }
    }
    timings.push({ start, end, visual, prepared });
    start = end;
  }
  project.timeline.tracks.find(track => track.id === mediaTrack).name = '分镜画面';
  const pictureItems = project.timeline.tracks.find(track => track.id === mediaTrack).items;
  for (let index = 1; index < pictureItems.length; index++) {
    const from = pictureItems[index - 1], to = pictureItems[index];
    if (from.clip.type === 'image' && to.clip.type === 'image' && from.placement.end === to.placement.begin) {
      project.timeline.transitions.push({ id: identity('transition'), fromItemId: from.id, toItemId: to.id, templateId: 'dissolve',
        duration: Math.min(ticks(.32), Math.floor((from.placement.end - from.placement.begin) / 3), Math.floor((to.placement.end - to.placement.begin) / 3)), parameters: {} });
    }
  }
  const backdropPath = join(directory, `backdrop-${style.id}.png`);
  await writeFile(backdropPath, presentationBackdropPng(style));
  const backdrop = addAsset(project, await probe(backdropPath), { validate: false });
  backdrop.placement.end = backdrop.clip.source.end = ticks(length);
  project.timeline.tracks.at(-1).name = '版式背景';
  if (style.id === 'cinema') {
    const shadePath = join(directory, 'caption-shade.png');
    await writeFile(shadePath, captionShadePng());
    const shade = addAsset(project, await probe(shadePath), { validate: false });
    const shadeTrack = project.timeline.tracks.pop();
    shadeTrack.name = '字幕遮罩'; project.timeline.tracks.unshift(shadeTrack);
    shade.placement.end = shade.clip.source.end = ticks(length);
  }
  // With video-only footage the poster remains a real offline scene image, never an audio resource.
  if (!posterPath) {
    posterPath = join(directory, 'poster.png');
    const video = visuals.find(visual => visual.kind === 'video');
    if (video) {
      try { await run('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-ss', '0.5', '-i', video.path, '-frames:v', '1', '-vf', 'scale=720:-1', posterPath], { timeout: 10000 }); }
      catch { await writeFile(posterPath, sceneIllustrationPng(recipe, scenes[0], index).png); }
    } else await writeFile(posterPath, sceneIllustrationPng(recipe, scenes[0], index).png);
  }
  if (audio) {
    const speech = addAsset(project, audio, { validate: false });
    speech.placement.end = speech.clip.source.end = Math.min(audio.duration, ticks(length));
  }
  // Titles occupy a separate safe area; only one complete spoken caption is visible at a time.
  const fullNarration = audio && typeof recipe.narration === 'string' && recipe.narration.trim();
  const introLength = !fullNarration && timings[0].end >= 3 ? Math.min(2.4, timings[0].end * .3) : 0;
  let captionTrack, creditTrack, shadowTrack;
  const subtitleFont = fullNarration ? await presentationFont({ ...style, font: 'sans-bold' }, recipe) : font;
  const typography = fullNarration ? await addTypography(project, recipe, directory, { style, template, index, length, timings, font: subtitleFont, text }) : null;
  function caption(content, options) {
    const item = text(project, content, { ...options, ...(typography ? { color: emphasizeCaption(content, recipe, typography), font: subtitleFont } : {}) });
    if (typography) {
      animateTypography(item, { entrance: .12, slide: 8 });
      const shadow = text(project, content, { ...options, y: options.y + 2, color: typography.id === 'tutorial' ? '#ffffff' : '#020b18', font: subtitleFont, trackId: shadowTrack });
      shadowTrack ||= project.timeline.tracks[0].id;
      shadow.name = '字幕阴影'; shadow.clip.visual.positionX = 2;
      animateTypography(shadow, { x: 2, y: options.y + 2, entrance: .12, slide: 8, shadow: true });
      const track = project.timeline.tracks.find(track => track.id === shadowTrack);
      project.timeline.tracks.splice(project.timeline.tracks.indexOf(track), 1);
      project.timeline.tracks.splice(project.timeline.tracks.findIndex(track => track.items.includes(item)) + 1, 0, track);
    }
    return item;
  }
  const noteTracks = [];
  if (introLength) {
    const titleChars = [...recipe.title], title = titleChars.length > style.caption.characters ? titleChars.slice(0, style.caption.characters - 1).join('') + '…' : recipe.title;
    text(project, title, { length: introLength, y: style.caption.y, size: style.caption.size, width: style.caption.width, color: style.caption.color, font });
    captionTrack = project.timeline.tracks[0].id;
    project.timeline.tracks[0].items[0].name = '开场标题';
  }
  if (fullNarration) {
    const cjk = /[\p{Script=Han}]/u.test(fullNarration);
    const readableLimit = cjk ? Math.max(8, Math.floor(style.caption.width / style.caption.size) - 1) : 30;
    const captions = captionSegments(fullNarration, Math.min(style.caption.characters, readableLimit));
    // Full text coverage with estimated timing, not ASR/word-level forced alignment.
    const weights = captions.map(content => Math.max(1, [...content].filter(char => !/\s/u.test(char)).length) + (/[。！？.!?；;]$/u.test(content) ? 2 : 0));
    const total = weights.reduce((sum, weight) => sum + weight, 0);
    let cursor = 0;
    for (let index = 0; index < captions.length; index++) {
      const end = index === captions.length - 1 ? length : cursor + length * weights[index] / total;
      const item = caption(captions[index], { start: cursor, length: end - cursor, y: style.caption.y, size: style.caption.size, color: style.caption.color, width: style.caption.width, font, trackId: captionTrack });
      captionTrack ||= project.timeline.tracks.find(track => track.items.includes(item)).id;
      item.name = `字幕 旁白.${index + 1}`;
      cursor = end;
    }
  }
  for (let i = 0; i < scenes.length; i++) {
    const { start, end, visual, prepared } = timings[i], bodyStart = i === 0 ? introLength : start, sceneLength = end - bodyStart;
    if (prepared?.kind === 'native') {
      let offset = .3;
      for (const [blockIndex, block] of prepared.blocks.entries()) {
        const size = block.role === 'heading' ? Math.min(32, style.photo.width / 16) : Math.min(28, style.photo.width / 20);
        const item = text(project, block.role === 'list' ? `• ${block.content}` : block.content, { start: bodyStart, length: sceneLength,
          y: style.photo.y + style.photo.height * offset - 640, size, width: style.photo.width * .76, color: '#173f57', font, trackId: noteTracks[blockIndex] });
        noteTracks[blockIndex] ||= project.timeline.tracks[0].id;
        item.clip.visual.positionX = style.photo.x + style.photo.width / 2 - 360;
        item.clip.visual.rotationDegrees = style.photo.rotation;
        item.name = `Markdown ${i + 1} · ${block.role}`;
        project.timeline.tracks.find(track => track.id === noteTracks[blockIndex]).name = `原生阅读笔记 · ${block.role}`;
        offset += block.role === 'heading' ? .23 : .14;
      }
    }
    const captions = fullNarration || prepared?.includesBody ? [] : captionSegments(scenes[i].body, style.caption.characters);
    const totalCharacters = Math.max(1, captions.reduce((sum, content) => sum + [...content].length, 0));
    let captionStart = bodyStart;
    for (let k = 0; k < captions.length; k++) {
      const captionEnd = k === captions.length - 1 ? end : captionStart + sceneLength * [...captions[k]].length / totalCharacters;
      const item = caption(captions[k], { start: captionStart, length: captionEnd - captionStart, y: style.caption.y, size: style.caption.size, color: style.caption.color, width: style.caption.width, font, trackId: captionTrack });
      captionTrack ||= project.timeline.tracks.find(track => track.items.includes(item)).id;
      item.name = `字幕 ${i + 1}.${k + 1}`;
      captionStart = captionEnd;
    }
    if (visual.credit) {
      const credit = typeof visual.credit === 'string' ? visual.credit : [visual.credit.author || visual.credit.title, visual.credit.license].filter(Boolean).join(' · ');
      text(project, [...String(credit)].slice(0, 54).join(''), { start, length: end - start, y: 608, size: 11, width: 660, color: ['magazine', 'explain', 'diary'].includes(style.id) ? '#7a766e' : '#b8bdbe', font, trackId: creditTrack });
      creditTrack ||= project.timeline.tracks[0].id;
      project.timeline.tracks.find(track => track.id === creditTrack).items.at(-1).name = `素材署名 ${i + 1}`;
    }
  }
  const subtitles = project.timeline.tracks.find(track => track.id === captionTrack);
  if (subtitles) subtitles.name = '逐句字幕';
  validateProject(project);
  return { project, durationSeconds: length, posterPath, visualCredits, visualVersion: 4, captionVersion: fullNarration ? CAPTION_VERSION : 0, illustrationThemes, presentationStyle: style.id, templateId: template?.id || null, mediaKinds: [...mediaKinds] };
}
export async function saveDraftProject(project, directory) {
  await mkdir(directory, { recursive: true });
  const path = join(directory, 'project.json');
  const temporary = join(directory, `project-${identity('save')}.tmp`);
  await writeFile(temporary, JSON.stringify(project));
  await rename(temporary, path);
  return path;
}
export async function readDraftProject(path) { return validateProject(JSON.parse(await readFile(path, 'utf8'))); }

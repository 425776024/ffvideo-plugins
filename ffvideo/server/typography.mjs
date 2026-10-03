import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { addAsset, ticks, identity } from '../../packages/core/project.mjs';
import { probe } from '../../packages/server/media.mjs';
import { encodePng } from './illustrations.mjs';

export const CAPTION_VERSION = 3;
export const TYPOGRAPHY_PRESETS = [
  { id: 'news', label: '主题解读', accent: '#e63f52', ink: '#152039', paper: '#f5f4ef', subtitle: '#fff3d7', emphasis: '#ffd078', dark: '#152039' },
  { id: 'science', label: '知识解读', accent: '#40d9df', ink: '#d9ffff', paper: '#102939', subtitle: '#e7ffff', emphasis: '#70efe2', dark: '#102939' },
  { id: 'tutorial', label: '跟着学', accent: '#2476ef', ink: '#153e63', paper: '#edf4ff', subtitle: '#153e63', emphasis: '#1a60b7', dark: '#edf4ff' },
  { id: 'gaming', label: '游戏讲解', accent: '#b897ff', ink: '#fff2b1', paper: '#211735', subtitle: '#fff2b1', emphasis: '#d1b5ff', dark: '#211735' },
  { id: 'outdoor', label: '行走记录', accent: '#ffc27a', ink: '#fff1d7', paper: '#24342e', subtitle: '#fff1d7', emphasis: '#ffc27a', dark: '#24342e' },
  { id: 'talk', label: '说点有用的', accent: '#f89f91', ink: '#ffe7da', paper: '#30222b', subtitle: '#ffe7da', emphasis: '#f9baa8', dark: '#30222b' }
];
export function typographyFor(recipe, template, index = 0) {
  const subject = [recipe.title, ...(recipe.tags || []), template?.id, template?.category].join(' ');
  const id = /新闻|资讯|热点|国庆|节日|时事|历史|由来|news|history/i.test(subject) ? 'news'
    : /游戏|电竞|gaming|game/i.test(subject) ? 'gaming'
    : /户外|运动|旅行|自然|徒步|露营|outdoor|travel|sport/i.test(subject) ? 'outdoor'
    : /教学|教程|步骤|烹饪|摄影|tutorial|how-to|cooking/i.test(subject) ? 'tutorial'
    : /科普|科学|科技|知识|物理|宇宙|science|technology/i.test(subject) ? 'science'
    : ['talk', 'science', 'tutorial'][Math.abs(Math.trunc(index)) % 3];
  return TYPOGRAPHY_PRESETS.find(preset => preset.id === id);
}
const curve = points => ({ timeDomain: 'itemLocal', keyframes: points.map(([seconds, value]) => ({ id: identity('keyframe'), time: ticks(seconds), value, interpolation: 'linear' })) });
export function animateTypography(item, { x = 0, y = item.clip.visual.positionY, entrance = .22, slide = 10, shadow = false } = {}) {
  const length = (item.placement.end - item.placement.begin) / 120000;
  const enter = Math.min(entrance, length * .22), exit = Math.min(.08, length * .12);
  item.clip.visual.positionX = x; item.clip.visual.positionY = y;
  item.clip.automation = {
    'visual.opacity': curve([[0, 0], [enter, shadow ? .85 : 1], [length - exit, shadow ? .85 : 1], [length, 0]]),
    'visual.positionY': curve([[0, y + slide], [enter, y], [length, y]])
  };
}
function plate(preset, captionY, header) {
  const width = 720, height = 1280, pixels = Buffer.alloc(width * height * 4);
  const rectangle = (x, y, w, h, hex, alpha = 255, radius = 0) => {
    const rgb = [1, 3, 5].map(at => parseInt(hex.slice(at, at + 2), 16));
    for (let py = Math.max(0, Math.floor(y)); py < Math.min(height, y + h); py++) for (let px = Math.max(0, Math.floor(x)); px < Math.min(width, x + w); px++) {
      if (radius) {
        const cx = Math.max(x + radius, Math.min(x + w - radius, px + .5));
        const cy = Math.max(y + radius, Math.min(y + h - radius, py + .5));
        if (Math.hypot(px + .5 - cx, py + .5 - cy) > radius) continue;
      }
      pixels.set([...rgb, alpha], (py * width + px) * 4);
    }
  };
  if (header) {
    if (preset.id === 'news') {
      rectangle(40, 50, 640, 174, preset.paper, 250, 6);
      rectangle(40, 50, 640, 6, preset.accent);
      rectangle(40, 56, 182, 43, preset.accent);
      rectangle(40, 210, 640, 38, preset.ink, 245);
      rectangle(40, 210, 6, 38, preset.accent);
    } else if (preset.id === 'tutorial') {
      rectangle(44, 56, 632, 188, preset.paper, 246, 16);
      rectangle(62, 76, 144, 32, preset.accent, 255, 6);
      rectangle(64, 226, 592, 3, preset.accent, 180);
    } else if (preset.id === 'gaming') {
      rectangle(38, 50, 644, 196, preset.paper, 228);
      rectangle(38, 50, 7, 196, preset.accent);
      rectangle(54, 60, 174, 38, preset.accent);
      rectangle(620, 50, 62, 4, preset.ink);
      rectangle(672, 212, 10, 34, preset.ink);
    } else {
      rectangle(44, 56, 632, 192, preset.paper, preset.id === 'outdoor' ? 218 : 238, 12);
      rectangle(64, 77, 5, 26, preset.accent);
      rectangle(80, 109, 556, 2, preset.accent, 100);
      rectangle(64, 226, 30, 3, preset.accent);
    }
  } else {
    const y = 640 + captionY - 38;
    rectangle(48, y + 5, 624, 76, '#000000', 85, 10);
    rectangle(44, y, 632, 76, preset.dark, preset.id === 'tutorial' ? 247 : 228, 10);
    rectangle(44, y + 12, 5, 52, preset.accent, 255, 2);
    rectangle(64, y + 68, 42, 3, preset.accent, 210);
  }
  return encodePng(pixels, width, height);
}
/** Reusable native PNG plates and native text/keyframes; no browser-only HTML overlay. */
export async function addTypography(project, recipe, directory, { style, template, index, length, timings, font, text }) {
  const preset = typographyFor(recipe, template, index);
  for (const header of [false, true]) {
    const path = join(directory, `type-${preset.id}-${header ? 'header' : 'captions'}.png`);
    await writeFile(path, plate(preset, style.caption.y, header));
    const item = addAsset(project, await probe(path), { validate: false });
    item.placement.end = item.clip.source.end = ticks(length);
    item.name = header ? '标题栏底板' : '字幕底板';
    const track = project.timeline.tracks.pop(); track.name = item.name;
    project.timeline.tracks.unshift(track);
    if (header) animateTypography(item, { y: 0, entrance: .32, slide: -18 });
  }
  const compact = (value, max) => [...String(value || '')].length > max ? [...value].slice(0, max - 1).join('') + '…' : value;
  const badge = text(project, preset.label, { length, y: -553, size: 21, width: 150, color: ['news', 'tutorial'].includes(preset.id) ? '#ffffff' : preset.id === 'gaming' ? preset.paper : preset.accent, font });
  badge.name = '栏目标签';
  animateTypography(badge, { x: preset.id === 'news' ? -228 : preset.id === 'gaming' ? -219 : -222, y: -553, slide: -18, entrance: .32 });
  const headline = text(project, compact(recipe.title, 32), { length, y: -479, size: 34, width: 566, color: preset.ink, font });
  headline.name = '作品标题';
  animateTypography(headline, { y: -479, slide: -18, entrance: .32 });
  let chapterTrack;
  for (let i = 0; i < timings.length; i++) {
    const { start, end } = timings[i];
    const item = text(project, `${String(i + 1).padStart(2, '0')} / ${String(timings.length).padStart(2, '0')}  ${compact(recipe.scenes[i].heading, 19)}`, {
      start, length: end - start, y: -411, size: 18, width: 566, color: preset.id === 'news' ? '#d5e1f3' : preset.ink, font, trackId: chapterTrack
    });
    chapterTrack ||= project.timeline.tracks[0].id;
    item.name = `章节提示 ${i + 1}`;
    animateTypography(item, { y: -411, entrance: .24, slide: 6 });
  }
  return preset;
}
export function emphasizeCaption(content, recipe, preset) {
  const keywords = (recipe.tags || []).filter(word => [...word].length >= 2 && [...word].length <= 8);
  return /\d|为什么|注意|关键|原因|第一|不是|不要|区别|应该|必须|重要|事实上/u.test(content) || keywords.some(word => content.includes(word)) ? preset.emphasis : preset.subtitle;
}

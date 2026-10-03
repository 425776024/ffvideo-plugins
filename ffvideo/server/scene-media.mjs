import { readFile } from 'node:fs/promises';
import { ticks, validateHtmlContent } from '../../packages/core/project.mjs';
import { encodePng } from './illustrations.mjs';

// These four checked-in graphics are data, not arbitrary user imports or model scripts.
const presets = {
  'process-svg': { kind: 'svg', file: 'process.svg' },
  'reading-markdown': { kind: 'markdown', file: 'reading.md' },
  'flow-canvas': { kind: 'canvas', file: 'flow.json' },
  'shape-lottie': { kind: 'lottie', file: 'shape.lottie.json' }
};
const escaped = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
const safeJson = value => JSON.stringify(value).replace(/</g, '\\u003c');
const short = (value, length) => [...String(value || '')].slice(0, length).join('');
function exact(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) if (!keys.includes(key)) throw new Error(`Unsupported ${label} field: ${key}`);
}
function configuration(value) {
  exact(value, ['id', 'kind', 'sceneIndices'], 'scene media preset');
  const preset = Object.hasOwn(presets, value.id) ? presets[value.id] : undefined;
  if (!preset || preset.kind !== value.kind) throw new Error('Unsupported scene media preset');
  if (value.sceneIndices !== undefined && (!Array.isArray(value.sceneIndices) || value.sceneIndices.length > 5 ||
    value.sceneIndices.some(index => !Number.isInteger(index) || index < 0 || index > 4))) throw new Error('Invalid scene media indices');
  return preset;
}
export function sceneMediaForIndex(template, index) {
  if (!template?.mediaPreset) return null;
  configuration(template.mediaPreset);
  return (template.mediaPreset.sceneIndices || [1]).includes(index) ? structuredClone(template.mediaPreset) : null;
}

/** A small static Markdown subset becomes native title/list/paragraph text, never HTML. */
export function markdownBlocks(source) {
  if (typeof source !== 'string' || source.length > 2000 || /[<>]|!\[|\]\(|```|^\s*\|/m.test(source)) throw new Error('Unsupported scene Markdown');
  return source.split(/\r?\n/).map(line => line.trim()).filter(Boolean).map(line => {
    const heading = /^(#{1,2})\s+(.+)$/.exec(line), list = /^[-*]\s+(.+)$/.exec(line);
    const content = (heading?.[2] || list?.[1] || line).replace(/\*\*([^*]+)\*\*/g, '$1');
    if ([...content].length > 140) throw new Error('Scene Markdown line is too long');
    return { role: heading ? 'heading' : list ? 'list' : 'paragraph', content };
  }).slice(0, 5);
}
function notePng(width, height) {
  const bytes = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const stripe = x < width * .035, paper = x > width * .075 && x < width * .925 && y > height * .11 && y < height * .89;
    bytes.set(stripe ? [66, 120, 134, 255] : paper ? [250, 247, 235, 255] : [219, 232, 231, 255], (y * width + x) * 4);
  }
  return encodePng(bytes, width, height);
}

function numbers(value, size) {
  const values = Array.isArray(value) ? value : [value];
  if (!values.length || values.length > 4 || (size && values.length !== size) || values.some(item => !Number.isFinite(item) || Math.abs(item) > 1000000)) throw new Error('Invalid Lottie numeric value');
}
function property(value, size) {
  exact(value, ['a', 'k'], 'Lottie property');
  if (value.a === 0) return numbers(value.k, size);
  if (value.a !== 1 || !Array.isArray(value.k) || value.k.length < 2 || value.k.length > 64) throw new Error('Unsupported Lottie property');
  let previous = -Infinity;
  for (const frame of value.k) {
    exact(frame, ['t', 's', 'e', 'h'], 'Lottie keyframe');
    if (!Number.isFinite(frame.t) || frame.t <= previous || frame.t < 0 || frame.t > 100000 || frame.h !== undefined && ![0, 1].includes(frame.h)) throw new Error('Invalid Lottie keyframe time');
    numbers(frame.s, size); if (frame.e !== undefined) numbers(frame.e, size);
    previous = frame.t;
  }
}
/** Supported fixture subset: 2D shape layers, ellipses/rectangles/static Bezier paths,
 * solid fills and linear/hold numeric transform keyframes. No assets, expressions,
 * groups, masks, effects, strokes, text, 3D, easing or arbitrary Lottie imports. */
export function validateShapeLottie(value) {
  exact(value, ['v', 'fr', 'ip', 'op', 'w', 'h', 'nm', 'ddd', 'assets', 'layers'], 'Lottie document');
  if (value.ddd !== 0 || !Array.isArray(value.assets) || value.assets.length || !Array.isArray(value.layers) || !value.layers.length || value.layers.length > 16) throw new Error('Unsupported Lottie assets or layers');
  for (const [field, limit] of [['fr', 120], ['w', 2048], ['h', 2048], ['op', 100000]])
    if (!Number.isFinite(value[field]) || value[field] <= 0 || value[field] > limit) throw new Error('Invalid Lottie extent/time');
  if (value.ip !== 0 || value.op <= value.ip) throw new Error('Unsupported Lottie range');
  for (const layer of value.layers) {
    exact(layer, ['ty', 'nm', 'ip', 'op', 'st', 'sr', 'ks', 'shapes'], 'Lottie layer');
    if (layer.ty !== 4 || layer.st !== 0 || layer.sr !== 1 || layer.ip !== 0 || layer.op !== value.op || !Array.isArray(layer.shapes) || layer.shapes.length > 16) throw new Error('Unsupported Lottie layer');
    exact(layer.ks, ['a', 'p', 's', 'r', 'o'], 'Lottie transform');
    for (const key of ['a', 'p', 's']) property(layer.ks[key], 3);
    for (const key of ['r', 'o']) property(layer.ks[key], 1);
    for (const shape of layer.shapes) {
      if (shape.ty === 'el' || shape.ty === 'rc') {
        exact(shape, ['ty', 'p', 's', ...(shape.ty === 'rc' ? ['r'] : [])], 'Lottie shape');
        property(shape.p, 2); property(shape.s, 2); if (shape.ty === 'rc') property(shape.r, 1);
      } else if (shape.ty === 'fl') {
        exact(shape, ['ty', 'c', 'o'], 'Lottie fill'); property(shape.c, 4); property(shape.o, 1);
      } else if (shape.ty === 'sh') {
        exact(shape, ['ty', 'ks'], 'Lottie path'); exact(shape.ks, ['a', 'k'], 'Lottie path property');
        if (shape.ks.a !== 0) throw new Error('Animated Lottie paths are unsupported');
        const path = shape.ks.k; exact(path, ['v', 'i', 'o', 'c'], 'Lottie Bezier path');
        if (typeof path.c !== 'boolean' || !Array.isArray(path.v) || path.v.length < 2 || path.v.length > 64 ||
          !Array.isArray(path.i) || !Array.isArray(path.o) || path.i.length !== path.v.length || path.o.length !== path.v.length) throw new Error('Invalid Lottie path');
        for (const points of [path.v, path.i, path.o]) for (const point of points) numbers(point, 2);
      } else throw new Error(`Unsupported Lottie shape: ${shape.ty}`);
    }
  }
  return structuredClone(value);
}
export function sampleLottieProperty(value, frame) {
  if (value.a === 0) return value.k;
  const keys = value.k;
  if (frame <= keys[0].t) return keys[0].s;
  const index = keys.findIndex(key => key.t > frame);
  if (index < 0) return keys.at(-1).s;
  const first = keys[index - 1], last = keys[index], end = first.e || last.s;
  if (first.h === 1) return first.s;
  const progress = (frame - first.t) / (last.t - first.t);
  return first.s.map((start, item) => start + (end[item] - start) * progress);
}
function lottieTick(document, canvas, seconds, duration, heading) {
  const context = canvas.getContext('2d'), frame = Math.min(document.op - 0.0001, Math.max(0, seconds / duration * document.op));
  const number = value => Array.isArray(value) ? value[0] : value;
  const sample = value => sampleLottieProperty(value, frame);
  context.clearRect(0, 0, canvas.width, canvas.height); context.save();
  context.scale(canvas.width / document.w, canvas.height / document.h);
  context.fillStyle = '#18273e'; context.fillRect(0, 0, document.w, document.h);
  context.strokeStyle = '#33435a'; context.lineWidth = 1;
  for (let x = 0; x < document.w; x += 48) { context.beginPath(); context.moveTo(x, 0); context.lineTo(x, document.h); context.stroke(); }
  for (let y = 0; y < document.h; y += 48) { context.beginPath(); context.moveTo(0, y); context.lineTo(document.w, y); context.stroke(); }
  for (const layer of document.layers) {
    const position = sample(layer.ks.p), anchor = sample(layer.ks.a), scale = sample(layer.ks.s);
    context.save(); context.translate(position[0], position[1]); context.rotate(number(sample(layer.ks.r)) * Math.PI / 180);
    context.scale(scale[0] / 100, scale[1] / 100); context.translate(-anchor[0], -anchor[1]);
    const fill = layer.shapes.find(shape => shape.ty === 'fl'), color = fill ? sample(fill.c) : [1, 1, 1, 1];
    context.fillStyle = `rgba(${color.slice(0, 3).map(value => Math.round(value * 255)).join(',')},${color[3]})`;
    context.globalAlpha = number(sample(layer.ks.o)) / 100 * (fill ? number(sample(fill.o)) / 100 : 1);
    for (const shape of layer.shapes) {
      context.beginPath();
      if (shape.ty === 'el' || shape.ty === 'rc') {
        const p = sample(shape.p), size = sample(shape.s);
        if (shape.ty === 'el') context.ellipse(p[0], p[1], Math.abs(size[0]) / 2, Math.abs(size[1]) / 2, 0, 0, Math.PI * 2);
        else context.roundRect(p[0] - size[0] / 2, p[1] - size[1] / 2, size[0], size[1], Math.max(0, number(sample(shape.r))));
      } else if (shape.ty === 'sh') {
        const path = shape.ks.k; context.moveTo(...path.v[0]);
        const count = path.c ? path.v.length + 1 : path.v.length;
        for (let index = 1; index < count; index++) {
          const a = index - 1, b = index % path.v.length;
          context.bezierCurveTo(path.v[a][0] + path.o[a][0], path.v[a][1] + path.o[a][1], path.v[b][0] + path.i[b][0], path.v[b][1] + path.i[b][1], ...path.v[b]);
        }
        if (path.c) context.closePath();
      } else continue;
      context.fill();
    }
    context.restore();
  }
  context.fillStyle = '#e8ecef'; context.font = '32px system-ui,sans-serif'; context.fillText(heading, 54, 85, 610);
  context.restore();
}
function canvasTick(data, canvas, seconds, duration, heading) {
  const context = canvas.getContext('2d'), progress = Math.max(0, Math.min(1, seconds / duration));
  context.clearRect(0, 0, canvas.width, canvas.height); context.save(); context.scale(canvas.width / 720, canvas.height / 720);
  context.fillStyle = data.background; context.fillRect(0, 0, 720, 720);
  context.strokeStyle = '#93afba'; context.lineWidth = 8;
  context.beginPath(); context.moveTo(data.nodes[0][0] * 720, data.nodes[0][1] * 720);
  for (const node of data.nodes.slice(1)) context.lineTo(node[0] * 720, node[1] * 720);
  context.stroke();
  for (let index = 0; index < data.nodes.length; index++) {
    const node = data.nodes[index], pulse = 1 + .09 * Math.sin(progress * Math.PI * 4 - index);
    context.fillStyle = data.palette[index]; context.beginPath(); context.arc(node[0] * 720, node[1] * 720, 67 * pulse, 0, Math.PI * 2); context.fill();
    context.fillStyle = index === 0 ? '#e5f8f3' : '#18394c'; context.font = 'bold 32px system-ui,sans-serif'; context.textAlign = 'center'; context.fillText(String(index + 1), node[0] * 720, node[1] * 720 + 11);
  }
  const pathPosition = Math.min(1.99999, progress * 2), first = Math.floor(pathPosition), weight = pathPosition - first;
  const a = data.nodes[first], b = data.nodes[first + 1];
  context.fillStyle = '#ffffff'; context.beginPath(); context.arc((a[0] + (b[0] - a[0]) * weight) * 720, (a[1] + (b[1] - a[1]) * weight) * 720, 17, 0, Math.PI * 2); context.fill();
  context.textAlign = 'left'; context.fillStyle = '#173f57'; context.font = '32px system-ui,sans-serif'; context.fillText(heading, 54, 85, 610); context.restore();
}
function htmlContent(body, script, width, height, durationSeconds) {
  const html = { html: `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:100%;height:100%;overflow:hidden}svg,canvas{display:block;width:100%;height:100%}</style></head><body>${body}${script ? `<script>${script}</script>` : ''}</body></html>`,
    width, height, duration: ticks(durationSeconds), transparent: false };
  validateHtmlContent(html); return html;
}

export async function createSceneMedia(presetInput, { scene, durationSeconds = 6, width = 720, height = 720 } = {}) {
  const preset = configuration(presetInput);
  if (![width, height].every(value => Number.isInteger(value) && value >= 2 && value <= 2048) || !Number.isFinite(durationSeconds) || durationSeconds <= 0 || durationSeconds > 180) throw new Error('Invalid scene media extent/time');
  const source = await readFile(new URL(`../templates/media/${preset.file}`, import.meta.url), 'utf8');
  const heading = short(scene?.heading, 28), body = short(scene?.body, 64);
  if (preset.kind === 'markdown') {
    const clean = value => value.replace(/[<>\[\]`*#\r\n]/g, '');
    const blocks = markdownBlocks(source.replace('{{heading}}', clean(heading)).replace('{{body}}', clean(body)));
    return { format: preset.kind, kind: 'native', png: notePng(width, height), width, height, blocks, includesBody: true };
  }
  if (preset.kind === 'svg') {
    const graphic = source.replaceAll('{{heading}}', escaped(heading));
    if (/<script|on\w+\s*=|(?:href|src)\s*=|<!DOCTYPE|<foreignObject/i.test(graphic)) throw new Error('Unsupported SVG fixture');
    const script = 'window.tick=(seconds,context)=>{const step=Math.min(2,Math.floor(Math.max(0,seconds)/context.duration*3));for(let index=0;index<3;index++)document.getElementById("step-"+index).setAttribute("opacity",index<=step?"1":"0.3");};';
    return { format: preset.kind, kind: 'html', html: htmlContent(graphic, script, width, height, durationSeconds) };
  }
  const data = JSON.parse(source), canvas = `<canvas id="scene" width="${width}" height="${height}" aria-label="${escaped(heading)}"></canvas>`;
  let script;
  if (preset.kind === 'canvas') {
    exact(data, ['version', 'nodes', 'palette', 'background'], 'Canvas fixture');
    if (data.version !== 1 || data.nodes.length !== 3 || data.palette.length !== 3 || [...data.palette, data.background].some(value => !/^#[a-f0-9]{6}$/i.test(value))) throw new Error('Invalid Canvas fixture');
    for (const node of data.nodes) { numbers(node, 2); if (node.some(value => value < 0 || value > 1)) throw new Error('Invalid Canvas point'); }
    script = `const data=${safeJson(data)};window.tick=(seconds,context)=>(${canvasTick.toString()})(data,document.getElementById('scene'),seconds,context.duration,${safeJson(heading)});`;
  } else {
    validateShapeLottie(data);
    script = `const data=${safeJson(data)};const sampleLottieProperty=${sampleLottieProperty.toString()};window.tick=(seconds,context)=>(${lottieTick.toString()})(data,document.getElementById('scene'),seconds,context.duration,${safeJson(heading)});`;
  }
  return { format: preset.kind, kind: 'html', html: htmlContent(canvas, script, width, height, durationSeconds) };
}

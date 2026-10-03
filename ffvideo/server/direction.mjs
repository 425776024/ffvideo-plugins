import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { addAsset, createProject, ticks, identity, validateProject } from '../../packages/core/project.mjs';
import { probe, run } from '../../packages/server/media.mjs';
import { encodePng, sceneIllustrationPng } from './illustrations.mjs';
import { TYPE_SCHEMA, renderTypeLayers, captionRuns } from './rich-type.mjs';

const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const color = { type: 'string', pattern: '^#[a-fA-F0-9]{6}$' };
const entrance = { type: 'string', enum: ['none', 'fade', 'rise', 'slide', 'pop'] };
const font = { type: 'string', enum: ['sans', 'sans-bold', 'serif', 'handwriting', 'rounded'] };
const frame = object({ x: number(0, 720), y: number(0, 1280), width: number(100, 720), height: number(100, 1280) });
export const DESIGN_SCHEMA = object({
  intent: { type: 'string', minLength: 20, maxLength: 600 }, background: color,
  typography: TYPE_SCHEMA,
  captionKeywords: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'string', minLength: 1, maxLength: 12 } },
  captions: object({ font, size: number(26, 42), color, accent: color, y: number(940, 1150), width: number(440, 640), plateColor: color, plateOpacity: number(0, .95), entrance }),
  shots: { type: 'array', minItems: 3, maxItems: 16, items: object({
    sceneIndex: { type: 'integer', minimum: 0, maximum: 19 }, start: number(0, 1), end: number(0, 1), frame, endFrame: frame,
    rotation: number(-10, 10), sourceStart: number(0, 60), transition: { type: 'string', enum: ['cut', 'dissolve'] },
    overlays: { type: 'array', maxItems: 6, items: object({
      kind: { type: 'string', enum: ['text', 'rect', 'ellipse'] }, text: { type: 'string', maxLength: 48 },
      start: number(0, 1), end: number(0, 1), x: number(24, 696), y: number(40, 880), width: number(8, 640), height: number(4, 780),
      size: number(18, 68), font, color, opacity: number(.05, 1), entrance
    }) }
  }) }
});
function check(value, schema, path) {
  const fail = message => { throw Object.assign(new Error(`${path}: ${message}`), { status: 400 }); };
  if (schema.type === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('expected design object');
    for (const key of Object.keys(value)) if (!Object.hasOwn(schema.properties, key)) fail(`unknown field ${key}`);
    for (const key of schema.required) if (!Object.hasOwn(value, key)) fail(`missing ${key}`);
    for (const [key, child] of Object.entries(schema.properties)) check(value[key], child, `${path}.${key}`);
  } else if (schema.type === 'array') {
    if (!Array.isArray(value) || value.length < (schema.minItems || 0) || value.length > (schema.maxItems || Infinity)) fail('invalid array size');
    value.forEach((entry, index) => check(entry, schema.items, `${path}[${index}]`));
  } else if (schema.type === 'number' || schema.type === 'integer') {
    if (!Number.isFinite(value) || (schema.type === 'integer' && !Number.isInteger(value)) || value < schema.minimum || value > schema.maximum) fail('invalid number');
  } else if (typeof value !== 'string' || value.length < (schema.minLength || 0) || value.length > (schema.maxLength || Infinity) || (schema.enum && !schema.enum.includes(value)) || (schema.pattern && !new RegExp(schema.pattern).test(value))) fail('invalid string');
}
export function validateDesign(design, sceneCount) {
  // Old projects remain readable; new provider/MCP schemas require authored type.
  const legacy = !Object.hasOwn(design || {}, 'typography') && !Object.hasOwn(design || {}, 'captionKeywords');
  const schema = legacy ? { ...DESIGN_SCHEMA, properties: Object.fromEntries(Object.entries(DESIGN_SCHEMA.properties).filter(([key])=>!['typography','captionKeywords'].includes(key))), required: DESIGN_SCHEMA.required.filter(key=>!['typography','captionKeywords'].includes(key)) } : DESIGN_SCHEMA;
  check(design, schema, 'design');
  for (const type of design.typography || []) {
    if (type.end-type.start < .015 || type.x+type.width > 696) throw new Error('Typography has invalid timing or exceeds the safe width');
    const runs = type.lines.flatMap(line=>line.runs);
    if (type.lines.every(line=>line.indent >= type.width-40) || runs.some(run=>/[\n\r\u0000-\u001f]/u.test(run.text))) throw new Error('Typography lines require printable text and readable space');
  }
  if (design.typography && !design.typography.some(type=>new Set(type.lines.flatMap(line=>line.runs.map(run=>run.size))).size > 1 || type.lines.some(line=>line.runs.some(run=>run.treatment !== 'fill')))) throw new Error('Typography needs a meaningful hierarchy or selective emphasis, not uniform text');
  if ((design.typography || []).filter(type=>type.end-type.start >= .7).length >= 2) throw new Error('Typography cannot recreate two permanent text cards');
  let previous = 0;
  for (const shot of design.shots) {
    if (shot.sceneIndex >= sceneCount || Math.abs(shot.start - previous) > .00001 || shot.end - shot.start < .015) throw new Error('Design shots must cover the film continuously, using existing scene assets');
    for (const f of [shot.frame, shot.endFrame]) if (f.x + f.width > 720 || f.y + f.height > 1280) throw new Error('Design frame exceeds canvas');
    for (const o of shot.overlays) {
      if (o.end <= o.start || o.x + o.width / 2 > 710 || o.x - o.width / 2 < 10 || o.y + o.height / 2 > 920 || o.y - o.height / 2 < 12) throw new Error('Design overlay exceeds its safe area or has invalid timing');
      if (o.kind === 'text' && (!o.text.trim() || [...o.text].length > Math.floor(o.width / o.size) * 2)) throw new Error('Design text must fit at most two readable lines');
    }
    previous = shot.end;
  }
  if (Math.abs(previous - 1) > .00001) throw new Error('Design must reach the end of narration');
  if (new Set(design.shots.map(shot => shot.sceneIndex)).size < Math.min(2, sceneCount)) throw new Error('A multi-scene work must use distinct scene assets, not one permanent background');
  if (design.shots.every(shot=>shot.overlays.filter(o=>o.kind==='text' && o.end-o.start >= .7).length >= 2))
    throw new Error('Two permanent text cards are not original visual direction');
  const signatures = new Set(design.shots.map(shot => JSON.stringify([shot.frame, shot.endFrame, shot.overlays.map(o => [o.kind, o.x, o.y, o.width, o.height, o.start, o.end])])));
  if (signatures.size < 2) throw new Error('Creative direction cannot repeat one fixed card layout throughout');
  return structuredClone(design);
}
export function designSignature(design) {
  const time=v=>Math.round(v*20),geometry=v=>Math.round(v/20),frame=f=>[f.x,f.y,f.width,f.height].map(geometry);
  // Swapping subjects, words, palette or a few pixels cannot bypass reuse checks.
  const shots = design.shots.map(s => [time(s.start),time(s.end),frame(s.frame),frame(s.endFrame),s.transition,
    s.overlays.map(o => [o.kind,...[o.x,o.y,o.width,o.height].map(geometry),time(o.start),time(o.end),o.entrance])]);
  return JSON.stringify([shots,(design.typography || []).map(t=>[time(t.start),time(t.end),geometry(t.x),geometry(t.y),geometry(t.width),t.align,t.entrance,t.lines.map(line=>[geometry(line.indent),time(line.delay),line.runs.map(run=>[geometry(run.size),run.treatment])])])]);
}
const curve = points => ({ timeDomain: 'itemLocal', keyframes: points.map(([time, value]) => ({ id: identity('keyframe'), time: ticks(time), value, interpolation: 'linear' })) });
function animate(item, mode, x, y, opacity = 1) {
  const length = (item.placement.end - item.placement.begin) / 120000, enter = Math.min(.35, length / 4), exit = Math.min(.12, length / 5);
  item.clip.visual.positionX = x; item.clip.visual.positionY = y; item.clip.visual.opacity = opacity;
  item.clip.automation = { 'visual.opacity': curve([[0, mode === 'none' ? opacity : 0], [enter, opacity], [length - exit, opacity], [length, 0]]) };
  if (mode === 'rise' || mode === 'slide') item.clip.automation[`visual.position${mode === 'rise' ? 'Y' : 'X'}`] = curve([[0, (mode === 'rise' ? y : x) + (mode === 'rise' ? 20 : -36)], [enter, mode === 'rise' ? y : x], [length, mode === 'rise' ? y : x]]);
  if (mode === 'pop') for (const axis of ['X', 'Y']) item.clip.automation[`visual.scale${axis}`] = curve([[0, item.clip.visual[`scale${axis}`] * .9], [enter, item.clip.visual[`scale${axis}`]], [length, item.clip.visual[`scale${axis}`]]]);
}
function shapePng(color, width, height, ellipse = false, onCanvas = false) {
  width = Math.max(1, Math.round(width)); height = Math.max(1, Math.round(height));
  const canvasWidth = onCanvas ? 720 : width, canvasHeight = onCanvas ? 1280 : height;
  const left = Math.floor((canvasWidth-width)/2), top = Math.floor((canvasHeight-height)/2);
  const rgb = [1, 3, 5].map(at => parseInt(color.slice(at, at + 2), 16)), bytes = Buffer.alloc(canvasWidth * canvasHeight * 4);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (!ellipse || ((x + .5 - width / 2) / (width / 2)) ** 2 + ((y + .5 - height / 2) / (height / 2)) ** 2 <= 1) bytes.set([...rgb, 255], ((y+top) * canvasWidth + x+left) * 4);
  return encodePng(bytes, canvasWidth, canvasHeight);
}
/** Execute an authored shot plan, never select or fill a layout template. */
export async function composeDirectedDraft(recipe, directory, { audioPath, durationSeconds, maxDurationSeconds, visuals = [], text, fontFor, captionSegments }) {
  const design = validateDesign(recipe.design, recipe.scenes.length);
  await mkdir(directory, { recursive: true });
  const project = createProject(recipe.title); project.canvas = { width: 720, height: 1280 };
  let audio = audioPath ? await probe(audioPath) : null;
  if (audio && maxDurationSeconds && audio.duration / 120000 > maxDurationSeconds) {
    const tempo = audio.duration / 120000 / (maxDurationSeconds - .1);
    if (tempo > 1.15) throw new Error('旁白过长，无法在保持清晰语速时完成指定时长，请精简文案');
    const path = join(directory, 'directed-narration.wav');
    await run('ffmpeg', ['-v','error','-y','-i',audioPath,'-af',`atempo=${tempo}`,'-ar','24000','-ac','1','-c:a','pcm_s16le',path],{timeout:30000});
    audio = await probe(path);
  }
  const length = audio ? audio.duration / 120000 : durationSeconds;
  const fonts = new Map(), assets = new Map(), credits = [], mediaKinds = new Set();
  const getFont = async id => { if (!fonts.has(id)) fonts.set(id, await fontFor({ font: id }, recipe)); return fonts.get(id); };
  if (design.captionKeywords?.some(word=>!recipe.narration.includes(word))) throw new Error('字幕强调词必须来自真实旁白');
  const assetFor = async visual => { if (!assets.has(visual.path)) assets.set(visual.path, await probe(visual.path)); return assets.get(visual.path); };
  let mediaTrack, posterPath;
  for (const [index, shot] of design.shots.entries()) {
    const scene = recipe.scenes[shot.sceneIndex];
    let visual = visuals.find(v => v.sceneIndex === shot.sceneIndex) || visuals.filter(v => v.sceneIndex === undefined)[shot.sceneIndex % Math.max(1, visuals.filter(v => v.sceneIndex === undefined).length)];
    if (!visual) {
      const path = join(directory, `directed-scene-${shot.sceneIndex}.png`); await writeFile(path, sceneIllustrationPng(recipe, scene, shot.sceneIndex).png); visual = { path };
    }
    const asset = await assetFor(visual); if (!['image', 'video'].includes(asset.kind)) throw new Error('Creative shots require real image/video assets');
    mediaKinds.add(asset.kind); posterPath ||= asset.kind === 'image' ? visual.path : undefined;
    if (visual.credit && !credits.some(c => JSON.stringify(c) === JSON.stringify(visual.credit))) credits.push(visual.credit);
    const begin = ticks(shot.start * length), end = ticks(shot.end * length), total = end - begin;
    // A dissolve reads across the butt cut. Reserve source handles even when
    // the authored shot starts at zero or wraps a short video several times.
    const handle = asset.kind === 'video' ? Math.min(ticks(.125), Math.floor(asset.duration / 4)) : 0;
    const head = shot.transition === 'dissolve' && index > 0 ? handle : 0;
    const tail = design.shots[index + 1]?.transition === 'dissolve' ? handle : 0;
    let offset = 0;
    while (offset < total) {
      const sourceStart = asset.kind === 'video' ? Math.max(head, Math.min(ticks(shot.sourceStart), Math.max(head, asset.duration - tail - ticks(.25)))) : 0;
      const segment = asset.kind === 'video' ? Math.min(asset.duration - sourceStart - tail, total - offset) : total - offset;
      const item = addAsset(project, asset, { start: begin + offset, trackId: mediaTrack, validate: false });
      mediaTrack ||= project.timeline.tracks.find(t => t.items.includes(item)).id;
      item.name = `导演镜头 ${index + 1} · ${scene.heading}`; item.placement.end = begin + offset + segment; item.clip.source.begin = sourceStart; item.clip.source.end = sourceStart + segment;
      if (asset.hasAudio) item.clip.audio.muted = true;
      item.clip.visual.fitPolicy = 'stretch'; item.clip.visual.rotationDegrees = shot.rotation;
      const ratio = asset.width / asset.height, target = shot.frame.width / shot.frame.height;
      const cx = Math.max(0, (1 - target / ratio) / 2), cy = Math.max(0, (1 - ratio / target) / 2);
      item.clip.visual.crop = { left: cx, right: cx, top: cy, bottom: cy };
      const at = fraction => Object.fromEntries(Object.keys(shot.frame).map(k => [k, shot.frame[k] + (shot.endFrame[k] - shot.frame[k]) * fraction]));
      const first = at(offset / total), last = at((offset + segment) / total), seconds = segment / 120000;
      item.clip.visual.positionX = first.x + first.width / 2 - 360; item.clip.visual.positionY = first.y + first.height / 2 - 640;
      item.clip.visual.scaleX = first.width / 720; item.clip.visual.scaleY = first.height / 1280;
      item.clip.automation = {
        'visual.positionX': curve([[0, first.x + first.width / 2 - 360], [seconds, last.x + last.width / 2 - 360]]),
        'visual.positionY': curve([[0, first.y + first.height / 2 - 640], [seconds, last.y + last.height / 2 - 640]]),
        'visual.scaleX': curve([[0, first.width / 720], [seconds, last.width / 720]]),
        'visual.scaleY': curve([[0, first.height / 1280], [seconds, last.height / 1280]])
      };
      offset += segment;
    }
    for (const [oi, o] of shot.overlays.entries()) {
      const start = (shot.start + (shot.end - shot.start) * o.start) * length;
      const duration = (shot.end - shot.start) * (o.end - o.start) * length;
      let item;
      if (o.kind === 'text') item = text(project, o.text, { start, length: duration, y: o.y - 640, size: o.size, width: o.width, color: o.color, font: await getFont(o.font) });
      else {
        const path = join(directory, `directed-${index}-${oi}.png`); await writeFile(path, shapePng(o.color, o.width, o.height, o.kind === 'ellipse', true));
        item = addAsset(project, await probe(path), { start: ticks(start), validate: false }); item.placement.end = ticks(start + duration); item.clip.source.end = item.placement.end - item.placement.begin;
        const track = project.timeline.tracks.pop(); project.timeline.tracks.unshift(track);
        item.clip.visual.fitPolicy = 'stretch';
      }
      item.name = `导演标注 ${index + 1}.${oi + 1}`;
      animate(item, o.entrance, o.x - 360, o.y - 640, o.opacity);
    }
  }
  const footage = project.timeline.tracks.find(t => t.id === mediaTrack); footage.name = '导演剪辑';
  for (let i = 1; i < footage.items.length; i++) {
    const from = footage.items[i - 1], to = footage.items[i];
    const shot = design.shots.find(s => ticks(s.start * length) === to.placement.begin);
    if (shot?.transition !== 'dissolve' || from.placement.end !== to.placement.begin) continue;
    let duration = Math.min(ticks(.25), Math.floor((from.placement.end - from.placement.begin) / 4), Math.floor((to.placement.end - to.placement.begin) / 4));
    // Native footage runs at its original source clock. The outgoing side
    // needs ceil(duration/2) ticks, and the incoming side floor(duration/2).
    if (from.clip.type === 'video') duration = Math.min(duration, 2 * (project.assets.find(a => a.id === from.clip.assetId).duration - from.clip.source.end));
    if (to.clip.type === 'video') duration = Math.min(duration, 2 * to.clip.source.begin + 1);
    if (duration > 0) project.timeline.transitions.push({ id: identity('transition'), fromItemId: from.id, toItemId: to.id, templateId: 'dissolve', duration, parameters: {} });
  }
  const bgPath = join(directory, 'directed-background.png'); await writeFile(bgPath, shapePng(design.background, 720, 1280));
  const bg = addAsset(project, await probe(bgPath), { validate: false }); bg.placement.end = bg.clip.source.end = ticks(length); project.timeline.tracks.at(-1).name = '导演背景';
  if (audio) { const item = addAsset(project, audio, { validate: false }); item.placement.end = item.clip.source.end = ticks(length); }
  const c = design.captions, captions = captionSegments(recipe.narration, Math.floor(c.width / c.size) - 1), weights = captions.map(s => [...s].length + 2), sum = weights.reduce((a,b) => a+b,0);
  let typeLayers = new Map();
  if (design.typography) {
    const requests = design.typography.map((type,id)=>({...type,id:`type-${id}`,bottom:920}));
    captions.forEach((content,i)=>requests.push({id:`caption-${i}`,x:360-c.width/2,y:c.y-c.size*.65,width:c.width,align:'center',gap:0,tracking:0,bottom:1240,lines:[{indent:0,delay:0,runs:captionRuns(content,design.captionKeywords,c)}]}));
    for (const request of requests) for (const line of request.lines) for (const run of line.runs) {
      const chosen = await getFont(run.font); run.family=chosen.family; run.weight=chosen.weight;
    }
    // A single local raster pass, not a new image-generation or HTML animation pipeline.
    const rendered = await renderTypeLayers(requests);
    for (const layer of rendered) { const path=join(directory,`${layer.id}-${layer.line}.png`); await writeFile(path,layer.png); typeLayers.set(`${layer.id}-${layer.line}`,{...layer,path}); }
    for (const [id,type] of design.typography.entries()) for (let line=0;line<type.lines.length;line++) {
      const layer=typeLayers.get(`type-${id}-${line}`), start=(type.start+(type.end-type.start)*layer.delay)*length, end=type.end*length;
      const item=addAsset(project,await probe(layer.path),{start:ticks(start),validate:false}); item.placement.end=ticks(end); item.clip.source.end=item.placement.end-item.placement.begin;
      item.name=`文字编排 · ${type.purpose} · ${layer.text}`; item.clip.visual.fitPolicy='stretch'; item.clip.visual.scaleX=layer.width/720; item.clip.visual.scaleY=layer.height/1280;
      animate(item,type.entrance,layer.x+layer.width/2-360,layer.y+layer.height/2-640);
      const track=project.timeline.tracks.pop();track.name='原创文字编排';project.timeline.tracks.unshift(track);
    }
  }
  let cursor = 0, captionTrack, shadowTrack;
  let renderedCaptionTrack;
  for (const [i, content] of captions.entries()) {
    const end = i === captions.length - 1 ? length : cursor + length * weights[i] / sum;
    const item = text(project, content, { start: cursor, length: end - cursor, y: c.y - 640, size: c.size, width: c.width, color: /\d|注意|关键|不要|为什么/.test(content) ? c.accent : c.color, font: await getFont(c.font), trackId: captionTrack });
    captionTrack ||= project.timeline.tracks.find(t => t.items.includes(item)).id; item.name = `字幕 旁白.${i + 1}`; animate(item, c.entrance, 0, c.y - 640);
    if (design.typography) {
      // Keep the full transcript as native text metadata, draw the measured rich line.
      item.clip.visual.opacity=0; item.clip.automation={'visual.opacity':curve([[0,0],[(item.placement.end-item.placement.begin)/120000,0]])};
      const layer=typeLayers.get(`caption-${i}-0`), raster=addAsset(project,await probe(layer.path),{start:ticks(cursor),trackId:renderedCaptionTrack,validate:false});
      renderedCaptionTrack ||= project.timeline.tracks.find(t=>t.items.includes(raster)).id;
      raster.name=`字幕排版 · ${content}`; raster.placement.end=ticks(end); raster.clip.source.end=raster.placement.end-raster.placement.begin;
      raster.clip.visual.fitPolicy='stretch'; raster.clip.visual.scaleX=layer.width/720;raster.clip.visual.scaleY=layer.height/1280;
      animate(raster,c.entrance,layer.x+layer.width/2-360,layer.y+layer.height/2-640);
    }
    const shadow = text(project, content, { start: cursor, length: end - cursor, y: c.y - 638, size: c.size, width: c.width, color: '#000000', font: await getFont(c.font), trackId: shadowTrack });
    shadowTrack ||= project.timeline.tracks.find(t => t.items.includes(shadow)).id; shadow.name = '字幕阴影'; animate(shadow, c.entrance, 2, c.y - 638, .85);
    if(design.typography) {shadow.clip.visual.opacity=0;shadow.clip.automation={'visual.opacity':curve([[0,0],[(shadow.placement.end-shadow.placement.begin)/120000,0]])};}
    cursor = end;
  }
  const shadow = project.timeline.tracks.find(t => t.id === shadowTrack); project.timeline.tracks.splice(project.timeline.tracks.indexOf(shadow),1); project.timeline.tracks.splice(project.timeline.tracks.findIndex(t => t.id === captionTrack)+1,0,shadow);
  if (renderedCaptionTrack) { const track=project.timeline.tracks.find(t=>t.id===renderedCaptionTrack);project.timeline.tracks.splice(project.timeline.tracks.indexOf(track),1);project.timeline.tracks.unshift(track);track.name='逐句重点字幕'; }
  project.timeline.tracks.find(t => t.id === captionTrack).name = '逐句字幕';
  if (c.plateOpacity > 0) {
    const path = join(directory, 'directed-caption-plate.png'); await writeFile(path, shapePng(c.plateColor,c.width+24,c.size*2.2+12));
    const item = addAsset(project, await probe(path), { validate: false }); item.name = '导演字幕底板'; item.placement.end = item.clip.source.end = ticks(length);
    item.clip.visual.fitPolicy = 'stretch'; item.clip.visual.scaleX = (c.width+24)/720; item.clip.visual.scaleY = (c.size*2.2+12)/1280; item.clip.visual.positionY = c.y-640; item.clip.visual.opacity=c.plateOpacity;
    const track = project.timeline.tracks.pop(); project.timeline.tracks.splice(project.timeline.tracks.findIndex(t=>t.id===shadowTrack)+1,0,track);
  }
  if (credits.length) { const item = text(project, credits.map(c=>`${c.author || c.title} · ${c.license}`).join(' / ').slice(0,100), { length, y:608,size:10,width:650,color:'#b8bdbe',font:await getFont('sans') }); item.name='素材署名'; }
  if (!posterPath) {
    posterPath = join(directory,'directed-poster.png'); const first = visuals.find(v=>v.kind==='video');
    if (first) await run('ffmpeg',['-v','error','-y','-ss','.5','-i',first.path,'-frames:v','1',posterPath],{timeout:10000});
    else await writeFile(posterPath,sceneIllustrationPng(recipe,recipe.scenes[0],0).png);
  }
  validateProject(project);
  return {project,durationSeconds:length,posterPath,visualCredits:credits,visualVersion:4,captionVersion:design.typography?6:5,designVersion:design.typography?2:1,presentationStyle:'directed',mediaKinds:[...mediaKinds]};
}

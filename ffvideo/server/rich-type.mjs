import { Chromium } from '../../packages/server/chromium.mjs';

const number = (minimum, maximum) => ({ type: 'number', minimum, maximum });
const object = properties => ({ type: 'object', additionalProperties: false, properties, required: Object.keys(properties) });
const color = { type: 'string', pattern: '^#[a-fA-F0-9]{6}$' };
export const TYPE_SCHEMA = { type: 'array', minItems: 1, maxItems: 10, items: object({
  purpose: { type: 'string', minLength: 4, maxLength: 120 },
  start: number(0, 1), end: number(0, 1), x: number(24, 650), y: number(32, 840), width: number(120, 640),
  align: { type: 'string', enum: ['left', 'center', 'right'] }, gap: number(4, 36), tracking: number(0, 8),
  entrance: { type: 'string', enum: ['none', 'fade', 'rise', 'slide', 'pop'] },
  lines: { type: 'array', minItems: 1, maxItems: 5, items: object({
    indent: number(0, 180), delay: number(0, .6),
    runs: { type: 'array', minItems: 1, maxItems: 5, items: object({
      text: { type: 'string', minLength: 1, maxLength: 48 }, size: number(22, 120),
      font: { type: 'string', enum: ['sans', 'sans-bold', 'serif', 'handwriting', 'rounded'] },
      color, treatment: { type: 'string', enum: ['fill', 'outline', 'underline', 'marker'] }
    }) }
  }) }
}) };

/** Pure typesetting, run in an isolated local canvas. Input strings are never HTML. */
export function rasterizeType(requests) {
  const canvas = document.createElement('canvas'), ctx = canvas.getContext('2d');
  const measure = run => {
    ctx.font = `${run.weight || 500} ${run.size}px ${JSON.stringify(run.family || 'sans-serif')}`;
    const m = ctx.measureText(run.text), chars = Array.from(run.text);
    return { width: (run.tracking ? chars.reduce((sum,c)=>sum+ctx.measureText(c).width,0) : m.width) + Math.max(0, chars.length - 1) * (run.tracking || 0), ascent: Math.max(m.actualBoundingBoxAscent || 0, run.size * .8), descent: Math.max(m.actualBoundingBoxDescent || 0, run.size * .15) };
  };
  const output = [];
  for (const request of requests) {
    let y = request.y;
    for (const [lineIndex, line] of request.lines.entries()) {
      let runs = line.runs.map(run => ({ ...run, tracking: request.tracking || 0 }));
      const available = request.width - line.indent - 20;
      let measured = runs.map(measure), width = measured.reduce((sum, m) => sum + m.width, 0);
      const fit = Math.min(1, available / width);
      if (fit < .65 || runs.some(run => run.size * fit < 20)) throw Error('文字行过密，请缩短文案或重新分行');
      if (fit < 1) { runs = runs.map(run => ({ ...run, size: run.size * fit, tracking: run.tracking * fit })); measured = runs.map(measure); width = measured.reduce((sum, m) => sum + m.width, 0); }
      const ascent = Math.max(...measured.map(m => m.ascent)), descent = Math.max(...measured.map(m => m.descent));
      const height = Math.ceil(ascent + descent + 24), imageWidth = Math.ceil(width + 24);
      if (y + height > (request.bottom || 920)) throw Error('文字排版超出安全区，请减少行数或调整位置');
      // Raster once at 2x. Playback/export animate ordinary native PNG layers.
      canvas.width = imageWidth * 2; canvas.height = height * 2; ctx.scale(2, 2);
      ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
      let pen = 12; const baseline = 12 + ascent;
      for (const [i, run] of runs.entries()) {
        ctx.font = `${run.weight || 500} ${run.size}px ${JSON.stringify(run.family || 'sans-serif')}`;
        ctx.fillStyle = run.color; ctx.strokeStyle = run.color; ctx.lineWidth = Math.max(1.2, run.size * .018);
        const m = measured[i];
        if (run.treatment === 'marker') {
          ctx.fillRect(pen - 4, baseline - m.ascent - 3, m.width + 8, m.ascent + m.descent + 8);
          const rgb = [1,3,5].map(at => parseInt(run.color.slice(at,at+2),16) / 255).map(v => v <= .04045 ? v/12.92 : ((v+.055)/1.055)**2.4);
          ctx.fillStyle = rgb[0]*.2126 + rgb[1]*.7152 + rgb[2]*.0722 > .179 ? '#102020' : '#ffffff';
        }
        if (run.treatment === 'underline') ctx.fillRect(pen, baseline + Math.max(3, m.descent/2), m.width, Math.max(2, run.size*.055));
        const draw = (content, x) => {
          ctx.shadowColor = 'rgba(0,0,0,.65)'; ctx.shadowBlur = 5; ctx.shadowOffsetY = 1;
          if (run.treatment === 'outline') ctx.strokeText(content,x,baseline); else ctx.fillText(content,x,baseline);
          ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
        };
        if (!run.tracking) draw(run.text, pen);
        else { let x = pen; for (const char of Array.from(run.text)) { draw(char,x); x += ctx.measureText(char).width + run.tracking; } }
        pen += m.width;
      }
      const left = request.x + line.indent + (request.align === 'center' ? (available-width)/2 : request.align === 'right' ? available-width : 0);
      output.push({ id: request.id, line: lineIndex, text: runs.map(r=>r.text).join(''), x: left - 12, y,
        width: imageWidth, height, delay: line.delay, fitted: fit, png: canvas.toDataURL('image/png').split(',')[1] });
      y += height + request.gap;
    }
  }
  return output;
}

/** One local browser for a complete work, no network and no per-video HTML frames. */
export async function renderTypeLayers(requests, { browserFactory = () => new Chromium().start() } = {}) {
  if (!requests.length) return [];
  const browser = await browserFactory();
  try {
    const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
    await browser.send('Network.enable', {}, sessionId);
    await browser.send('Network.setBlockedURLs', { urls: ['*'] }, sessionId);
    const result = await browser.send('Runtime.evaluate', {
      expression: `(${rasterizeType.toString()})(${JSON.stringify(requests)})`, awaitPromise: true, returnByValue: true, timeout: 10000
    }, sessionId);
    if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value.map(({ png, ...entry }) => ({ ...entry, png: Buffer.from(png, 'base64') }));
  } finally { await browser.close(); }
}

export function captionRuns(content, keywords, style) {
  const matches = [];
  for (const word of [...new Set(keywords)].sort((a,b)=>b.length-a.length)) {
    let at = 0;
    while ((at = content.indexOf(word, at)) !== -1) {
      if (!matches.some(m => at < m.end && at + word.length > m.start)) matches.push({ start: at, end: at+word.length });
      at += word.length;
    }
  }
  matches.sort((a,b)=>a.start-b.start);
  const runs = []; let at = 0;
  const add = (text, emphatic) => { if (text) runs.push({text,size:style.size,font:emphatic?'sans-bold':style.font,color:emphatic?style.accent:style.color,treatment:emphatic?'underline':'fill'}); };
  for (const m of matches) { add(content.slice(at,m.start),false); add(content.slice(m.start,m.end),true); at=m.end; }
  add(content.slice(at),false); return runs;
}

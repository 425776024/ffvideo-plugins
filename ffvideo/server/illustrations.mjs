import { deflateSync } from 'node:zlib';

// Offline scene artwork is real raster media on the shared native renderer.
// This deliberately needs no image service, browser rasterizer or new runtime dependency.
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
export function encodePng(pixels, width, height) {
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) pixels.copy(rows, y * (width * 4 + 1) + 1, y * width * 4, (y + 1) * width * 4);
  const header = Buffer.alloc(13); header.writeUInt32BE(width); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(rows)), chunk('IEND', Buffer.alloc(0))]);
}
const color = value => Array.isArray(value) ? value : [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16));
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
function raster(width, height, background = ['#0b1830', '#2d5a6b']) {
  const pixels = Buffer.alloc(width * height * 4);
  const top = color(background[0]), bottom = color(background[1]);
  for (let y = 0; y < height; y++) {
    const shade = mix(top, bottom, y / Math.max(1, height - 1));
    for (let x = 0; x < width; x++) pixels.set([...shade, 255], (y * width + x) * 4);
  }
  const sx = width / 720, sy = height / 1280;
  const put = (x, y, c, alpha = 1) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const p = (y * width + x) * 4;
    for (let k = 0; k < 3; k++) pixels[p + k] = Math.round(pixels[p + k] * (1 - alpha) + c[k] * alpha);
  };
  const rect = (x, y, w, h, c, alpha = 1) => {
    c = color(c);
    for (let j = Math.max(0, Math.floor(y * sy)); j < Math.min(height, Math.ceil((y + h) * sy)); j++)
      for (let i = Math.max(0, Math.floor(x * sx)); i < Math.min(width, Math.ceil((x + w) * sx)); i++) put(i, j, c, alpha);
  };
  const ellipse = (x, y, rx, ry, c, alpha = 1) => {
    c = color(c); x *= sx; y *= sy; rx *= sx; ry *= sy;
    for (let j = Math.max(0, Math.floor(y - ry)); j < Math.min(height, Math.ceil(y + ry)); j++) {
      const half = rx * Math.sqrt(Math.max(0, 1 - ((j + .5 - y) / ry) ** 2));
      for (let i = Math.max(0, Math.floor(x - half)); i < Math.min(width, Math.ceil(x + half)); i++) put(i, j, c, alpha);
    }
  };
  const polygon = (points, c, alpha = 1) => {
    c = color(c); points = points.map(([x, y]) => [x * sx, y * sy]);
    const min = Math.max(0, Math.floor(Math.min(...points.map(p => p[1]))));
    const max = Math.min(height, Math.ceil(Math.max(...points.map(p => p[1]))));
    for (let y = min; y < max; y++) {
      const intersections = [];
      for (let i = 0; i < points.length; i++) {
        const [x1, y1] = points[i], [x2, y2] = points[(i + 1) % points.length];
        if ((y1 <= y + .5 && y2 > y + .5) || (y2 <= y + .5 && y1 > y + .5))
          intersections.push(x1 + (y + .5 - y1) * (x2 - x1) / (y2 - y1));
      }
      intersections.sort((a, b) => a - b);
      for (let i = 0; i + 1 < intersections.length; i += 2)
        for (let x = Math.max(0, Math.floor(intersections[i])); x < Math.min(width, Math.ceil(intersections[i + 1])); x++) put(x, y, c, alpha);
    }
  };
  const line = (x1, y1, x2, y2, size, c, alpha = 1) => {
    const length = Math.max(1, Math.hypot(x2 - x1, y2 - y1)), steps = Math.ceil(length / Math.max(1, size / 3));
    for (let i = 0; i <= steps; i++) ellipse(x1 + (x2 - x1) * i / steps, y1 + (y2 - y1) * i / steps, size / 2, size / 2, c, alpha);
  };
  const glow = (x, y, radius, c) => {
    for (let i = 12; i > 0; i--) ellipse(x, y, radius * i / 12, radius * i / 12, c, .025 + (12 - i) * .002);
  };
  return { pixels, rect, ellipse, polygon, line, glow, png: () => encodePng(pixels, width, height) };
}
export function illustrationTheme(recipe, scene = {}) {
  const classify = values => {
    const content = values.filter(Boolean).join(' ').toLowerCase();
    if (/星|宇宙|天文|太空|行星|星系|月亮|space|galax|planet|astronom/.test(content)) return 'space';
    if (/海|海岸|海浪|潮汐|沙滩|ocean|coast|beach|wave|sea\b/.test(content)) return 'coast';
    if (/山|森林|自然|树|花|叶|瀑布|风景|mountain|forest|nature|landscape|leaf|flower/.test(content)) return 'nature';
    if (/美食|烹饪|咖啡|面包|餐|茶|食|cooking|food|coffee|bread|tea\b/.test(content)) return 'food';
    if (/电影|摄影|构图|拍摄|镜头|相机|camera|cinema|photograph|framing/.test(content)) return 'camera';
    if (/城市|街|建筑|旅行|楼|city|street|architect|travel/.test(content)) return 'city';
    if (/绘画|艺术|配色|色彩|画家|油画|art|paint|color/.test(content)) return 'art';
    if (/科学|物理|原子|分子|生物|实验|science|physics|atom|chemistry/.test(content)) return 'science';
    if (/代码|科技|电脑|智能|技术|机器人|code|tech|computer|robot/.test(content)) return 'technology';
  };
  return classify([scene.visualPrompt, scene.visualQuery, scene.heading, scene.body]) || classify([recipe.title, recipe.visualTheme, ...(recipe.tags || [])]) || 'landscape';
}
/** Original, topic-classified scene artwork. External footage always takes precedence. */
export function sceneIllustrationPng(recipe, scene = {}, index = 0, width = 720, height = 1280) {
  const theme = illustrationTheme(recipe, scene), variant = index % 3;
  const palettes = {
    space: ['#050b23', '#1a2b58'], coast: ['#557dab', '#e9b5a1'], nature: ['#235d74', '#acbec0'],
    camera: ['#1b2540', '#86614e'], city: ['#203347', '#ac8574'], food: ['#543c3a', '#dcb68a'],
    art: ['#302547', '#bd8178'], science: ['#081d38', '#285c72'], technology: ['#071b2d', '#33556e'], landscape: ['#344b69', '#c5aeb0']
  };
  const p = raster(width, height, palettes[theme]);
  const { rect, ellipse, polygon, line, glow } = p;
  const sunX = 180 + variant * 130;
  if (['coast', 'nature', 'city', 'landscape'].includes(theme)) { glow(sunX, 410, 170, '#ffd49d'); ellipse(sunX, 410, 72, 72, '#fbd6a7'); }
  if (theme === 'space') {
    for (let i = 0; i < 150; i++) {
      const x = (i * 137 + variant * 71) % 720, y = (i * 251 + 73) % 1180;
      ellipse(x, y, i % 11 === 0 ? 3 : 1.2, i % 11 === 0 ? 3 : 1.2, i % 3 ? '#c8dcff' : '#ffcea2', .75);
    }
    glow(420, 610, 210, '#b665ac');
    line(80, 790, 600, 500, 28, '#aac5e5', .45);
    ellipse(348, 648, 176, 176, '#c68c75'); ellipse(324, 626, 151, 151, '#e3b896');
    for (let i = 0; i < 6; i++) line(222, 563 + i * 29, 422, 563 + i * 29, 8, '#c89984', .6);
    line(80, 790, 351, 640, 16, '#dbe5f4', .85);
    ellipse(526, 310, 31, 31, '#dfe2db'); ellipse(532, 306, 9, 8, '#b6bcc8', .5);
  } else if (theme === 'coast') {
    rect(0, 640, 720, 640, '#1e6d89');
    polygon([[0, 925], [130, 840], [360, 860], [490, 925], [720, 780], [720, 1280], [0, 1280]], '#deb493');
    for (let i = 0; i < 10; i++) {
      const y = 664 + i * 27;
      line(30 + i * 13, y, 670 - i * 21, y + 7, i % 3 ? 2 : 4, '#c0e5e4', .55);
    }
    line(0, 926, 129, 851, 12, '#f3e9dc', .8); line(129, 851, 361, 872, 12, '#f3e9dc', .8); line(361, 872, 491, 936, 12, '#f3e9dc', .8); line(491, 936, 720, 793, 12, '#f3e9dc', .8);
    polygon([[450, 680], [560, 680], [540, 707], [474, 704]], '#282c3b'); line(505, 675, 505, 570, 3, '#f9eedc'); polygon([[500, 575], [500, 674], [453, 674]], '#fcdfb7');
    ellipse(181, 1040, 25, 12, '#5f574d', .7); ellipse(224, 1049, 14, 7, '#8c715c', .7);
  } else if (theme === 'nature' || theme === 'landscape') {
    polygon([[0, 750], [165, 425], [320, 690], [477, 370], [720, 735], [720, 1280], [0, 1280]], '#67798e');
    polygon([[370, 530], [477, 370], [584, 538], [510, 496], [476, 520], [438, 470]], '#dee0d7');
    polygon([[0, 980], [160, 720], [300, 856], [486, 674], [720, 931], [720, 1280], [0, 1280]], '#2b5966');
    polygon([[0, 1280], [240, 973], [415, 943], [556, 1130], [720, 1215], [720, 1280]], '#668e8c');
    polygon([[328, 943], [391, 943], [494, 1280], [175, 1280]], '#b6d1c8');
    for (const [x, y, scale] of [[72, 948, 1.2], [622, 968, 1.5], [576, 1104, 1], [126, 1132, 1.3]]) {
      rect(x - 5, y, 10, 170 * scale, '#355050');
      for (let j = 0; j < 3; j++) polygon([[x, y - 145 * scale + j * 58 * scale], [x - (60 + j * 12) * scale, y + j * 51 * scale], [x + (60 + j * 12) * scale, y + j * 51 * scale]], '#143d42');
    }
    if (theme === 'nature' && /花|flower/.test(scene.visualPrompt || scene.body || '')) for (let i = 0; i < 9; i++) {
      const x = 60 + i * 76, y = 1140 + i % 2 * 40;
      line(x, y + 90, x, y, 4, '#527b61');
      for (let a = 0; a < 5; a++) ellipse(x + Math.cos(a * 1.256) * 12, y + Math.sin(a * 1.256) * 12, 11, 11, '#e8a6af');
      ellipse(x, y, 7, 7, '#eec56d');
    }
  } else if (theme === 'camera') {
    // A complete filmed environment: window, warm light, camera and a human subject.
    rect(58, 270, 306, 402, '#f0c394'); rect(78, 290, 266, 362, '#627d8a');
    polygon([[78, 542], [177, 402], [271, 535], [344, 451], [344, 652], [78, 652]], '#365367');
    rect(202, 290, 14, 362, '#ebc08f'); rect(78, 467, 266, 14, '#ebc08f');
    polygon([[60, 673], [365, 673], [649, 1167], [0, 1167]], '#e4b181', .18);
    rect(0, 977, 720, 303, '#382e35');
    ellipse(535, 594, 45, 53, '#c99c83'); polygon([[497, 638], [569, 638], [612, 868], [459, 868]], '#29444b');
    line(490, 867, 474, 974, 19, '#202c37'); line(564, 867, 591, 974, 19, '#202c37');
    line(215, 849, 142, 1098, 12, '#242c3a'); line(215, 849, 300, 1098, 12, '#242c3a'); line(215, 849, 228, 1098, 10, '#455263');
    rect(126, 730, 188, 130, '#182a3c'); rect(139, 742, 58, 26, '#688da6'); rect(165, 711, 80, 22, '#192438');
    ellipse(272, 796, 71, 71, '#101c2f'); ellipse(272, 796, 53, 53, '#476c86'); ellipse(272, 796, 32, 32, '#0b1930'); ellipse(285, 778, 11, 11, '#94cadc', .7);
    line(652, 423, 652, 884, 8, '#21283a'); polygon([[568, 423], [703, 423], [679, 358], [594, 358]], '#e9bf8e'); glow(640, 440, 118, '#f8c781');
  } else if (theme === 'city') {
    rect(0, 975, 720, 305, '#283a45');
    polygon([[0, 1280], [332, 800], [377, 800], [720, 1280]], '#506574');
    for (let i = 0; i < 9; i++) {
      const x = i < 5 ? i * 91 - 42 : 445 + (i - 5) * 93;
      const roof = 412 + (i * 71 + variant * 39) % 280, h = 980 - roof;
      rect(x, roof, 82, h, ['#39424d', '#4f555c', '#68575c'][i % 3]);
      rect(x + 7, roof + 12, 69, 8, '#ad9993', .65);
      for (let y = roof + 42; y < 940; y += 47) for (let k = 0; k < 3; k++) rect(x + 10 + k * 23, y, 11, 22, (y + k + i) % 3 ? '#e7bd88' : '#849aaa', .8);
    }
    for (let i = 0; i < 4; i++) polygon([[351 - i * 8, 928 + i * 69], [362 + i * 8, 928 + i * 69], [364 + i * 9, 952 + i * 69], [349 - i * 9, 952 + i * 69]], '#e5c28d');
    line(588, 728, 588, 1032, 7, '#202e3a'); line(588, 728, 546, 728, 7, '#202e3a'); glow(546, 743, 58, '#f5c782'); ellipse(546, 738, 13, 12, '#f9dc9b');
  } else if (theme === 'food') {
    rect(0, 762, 720, 518, '#9c7559');
    for (let i = 0; i < 9; i++) line(0, 790 + i * 58, 720, 811 + i * 58, 3, '#704d45', .45);
    ellipse(342, 844, 235, 138, '#785c4d', .55); ellipse(330, 815, 224, 136, '#eae1c8'); ellipse(330, 815, 187, 109, '#d3c4a5');
    ellipse(250, 788, 98, 49, '#bb783d'); ellipse(251, 779, 96, 43, '#eac179');
    for (let i = 0; i < 4; i++) line(193 + i * 34, 758, 209 + i * 34, 794, 8, '#f8ddb0');
    ellipse(427, 759, 81, 65, '#51805c'); ellipse(447, 765, 45, 42, '#ad5545'); ellipse(414, 795, 42, 34, '#c8b263');
    ellipse(579, 628, 58, 30, '#ece3d1'); ellipse(579, 628, 41, 22, '#392c2c'); rect(521, 629, 116, 92, '#dfd4be'); ellipse(579, 717, 58, 27, '#c9bda6');
    ellipse(649, 673, 29, 36, '#d5c6af'); ellipse(649, 673, 16, 22, '#805e50');
    for (let i = 0; i < 3; i++) line(553 + i * 23, 579, 564 + i * 23, 508 - i * 12, 7, '#f4e6ce', .4);
    line(96, 983, 152, 628, 12, '#d2c4ae'); line(97, 982, 119, 1125, 14, '#ddd3bf');
    for (let i = 0; i < 4; i++) line(136 + i * 11, 612, 146 + i * 11, 671, 6, '#ddd3bf');
  } else if (theme === 'art') {
    rect(157, 288, 407, 498, '#6c4c53'); rect(173, 304, 375, 466, '#e8d9bd');
    polygon([[173, 304], [548, 304], [548, 560], [173, 725]], '#cc8369'); ellipse(334, 482, 105, 105, '#4d7280');
    polygon([[192, 653], [362, 474], [527, 739]], '#e4bb78'); ellipse(417, 645, 74, 74, '#956b82');
    line(173, 791, 126, 1132, 15, '#725348'); line(548, 791, 595, 1132, 15, '#725348'); line(165, 777, 555, 777, 20, '#9b795f');
    ellipse(279, 1002, 155, 94, '#c3a17c'); ellipse(265, 1023, 29, 22, '#67504e');
    for (const [x, y, c] of [[171, 977, '#ad5555'], [217, 942, '#e9bd6a'], [277, 928, '#447587'], [337, 946, '#73835b'], [385, 981, '#866a9b']]) ellipse(x, y, 25, 23, c);
    line(399, 1139, 453, 869, 14, '#352b39'); line(453, 869, 463, 834, 24, '#cbac90');
  } else if (theme === 'science') {
    glow(353, 592, 270, '#6c99bf');
    for (let i = 0; i < 3; i++) {
      const angle = i * Math.PI / 3;
      let previous;
      for (let j = 0; j <= 90; j++) {
        const a = j * Math.PI * 2 / 90, px = 255 * Math.cos(a), py = 105 * Math.sin(a);
        const point = [358 + px * Math.cos(angle) - py * Math.sin(angle), 605 + px * Math.sin(angle) + py * Math.cos(angle)];
        if (previous) line(...previous, ...point, 4, '#a0cbd7', .7);
        previous = point;
      }
      const a = variant * .6 + i * 2, x = 255 * Math.cos(a), y = 105 * Math.sin(a);
      ellipse(358 + x * Math.cos(angle) - y * Math.sin(angle), 605 + x * Math.sin(angle) + y * Math.cos(angle), 18, 18, '#ffd089');
    }
    for (let i = 0; i < 9; i++) ellipse(332 + i % 3 * 26, 579 + Math.floor(i / 3) * 26, 22, 22, i % 2 ? '#d78584' : '#83c7d7');
    rect(149, 963, 412, 19, '#a2bec5'); line(171, 963, 226, 853, 8, '#bfced0'); line(227, 853, 332, 853, 8, '#bfced0');
    polygon([[479, 798], [462, 901], [423, 951], [548, 951], [509, 901], [500, 798]], '#8abaaf', .9); rect(479, 790, 22, 19, '#d6e0d7');
  } else {
    glow(360, 558, 235, '#4eabb6');
    rect(115, 379, 484, 348, '#0c253a'); rect(130, 394, 454, 314, '#315d74'); rect(148, 412, 418, 278, '#14394f');
    for (let i = 0; i < 8; i++) { rect(170, 436 + i * 28, 24, 7, '#7192a1'); rect(209, 436 + i * 28, 92 + i % 3 * 49, 7, i % 2 ? '#68c3af' : '#e5b582'); }
    rect(334, 726, 48, 116, '#132d42'); rect(257, 825, 202, 23, '#355c70');
    polygon([[154, 897], [562, 897], [620, 989], [93, 989]], '#284a5d');
    for (let y = 0; y < 3; y++) for (let x = 0; x < 11; x++) rect(159 + x * 33 - y * 12, 913 + y * 21, 24, 12, '#648797');
    for (const [x, y] of [[76, 459], [650, 570], [126, 788]]) { line(x, y, x, y - 62, 3, '#7ebabb'); line(x, y - 62, x + 70, y - 62, 3, '#7ebabb'); ellipse(x + 70, y - 62, 8, 8, '#e3bd83'); }
  }
  return { png: p.png(), theme };
}
/** Transparent shade reserves readability while leaving the filmed subject visible. */
export function captionShadePng(width = 720, height = 1280) {
  const pixels = Buffer.alloc(width * height * 4);
  for (let y = 0; y < height; y++) {
    const top = Math.max(0, 1 - y / (height * .27)) * .56;
    const bottom = Math.max(0, (y - height * .58) / (height * .42)) * .88;
    for (let x = 0; x < width; x++) pixels[(y * width + x) * 4 + 3] = Math.round(Math.max(top, bottom) * 255);
  }
  return encodePng(pixels, width, height);
}

export const PRESENTATION_STYLES = [
  { id: 'cinema', name: '电影镜头', background: ['#071018', '#101921'], photo: { x: 0, y: 0, width: 720, height: 1280, rotation: 0 }, caption: { y: 398, width: 584, size: 32, color: '#ffffff', characters: 34 }, font: 'sans', zoom: .08 },
  { id: 'magazine', name: '留白杂志', background: ['#f5f0e7', '#eee8df'], photo: { x: 52, y: 156, width: 616, height: 644, rotation: 0 }, caption: { y: 345, width: 548, size: 34, color: '#25333c', characters: 30 }, font: 'serif', zoom: .022 },
  { id: 'collage', name: '照片拼贴', background: ['#102e37', '#213d43'], photo: { x: 86, y: 414, width: 548, height: 502, rotation: -4 }, secondary: { x: 347, y: 111, width: 286, height: 240, rotation: 7 }, caption: { y: 404, width: 552, size: 30, color: '#faf1da', characters: 34 }, font: 'rounded', zoom: .014 },
  { id: 'explain', name: '清晰科普', background: ['#eaf3f6', '#dbe8ec'], photo: { x: 108, y: 244, width: 504, height: 504, rotation: 0 }, caption: { y: 318, width: 540, size: 30, color: '#174764', characters: 34 }, font: 'sans-bold', zoom: .012 },
  { id: 'diary', name: '旅行日记', background: ['#decfb3', '#d3bf9b'], photo: { x: 78, y: 282, width: 564, height: 578, rotation: 3 }, caption: { y: 365, width: 552, size: 32, color: '#63472f', characters: 32 }, font: 'handwriting', zoom: .015 }
];
export function presentationStyle(index = 0) {
  return PRESENTATION_STYLES[Math.abs(Math.trunc(index) || 0) % PRESENTATION_STYLES.length];
}
function rotatedFrame(rectangle, padding = 13) {
  const angle = (rectangle.rotation || 0) * Math.PI / 180, c = Math.cos(angle), s = Math.sin(angle);
  const cx = rectangle.x + rectangle.width / 2, cy = rectangle.y + rectangle.height / 2;
  return [[-rectangle.width / 2 - padding, -rectangle.height / 2 - padding], [rectangle.width / 2 + padding, -rectangle.height / 2 - padding], [rectangle.width / 2 + padding, rectangle.height / 2 + padding], [-rectangle.width / 2 - padding, rectangle.height / 2 + padding]].map(([x, y]) => [cx + x * c - y * s, cy + x * s + y * c]);
}
/** Each backdrop is a different authored layout, rather than a recolored full-screen card. */
export function presentationBackdropPng(style, width = 720, height = 1280) {
  const p = raster(width, height, style.background);
  const { rect, line, ellipse, polygon } = p;
  if (style.id === 'magazine') {
    line(52, 112, 668, 112, 2, '#b5aea2');
    rect(52, 839, 72, 5, '#aa6d4e');
    line(52, 1163, 668, 1163, 2, '#b5aea2');
    rect(52, 1210, 120, 5, '#cdbea6');
  } else if (style.id === 'collage') {
    for (const rectangle of [style.photo, style.secondary]) {
      const frame = rotatedFrame(rectangle, 17);
      polygon(frame.map(([x, y]) => [x + 9, y + 13]), '#081b22', .65);
      polygon(frame, '#f4ead3');
    }
    polygon([[40, 172], [191, 116], [214, 159], [63, 215]], '#d8b58e', .72);
    line(59, 1094, 131, 1117, 2, '#b5c5b8');
    line(138, 1119, 200, 1093, 2, '#b5c5b8');
  } else if (style.id === 'explain') {
    for (let y = 113; y < 1190; y += 39) for (let x = 40; x < 680; x += 39) ellipse(x, y, 1.3, 1.3, '#72a4af', .27);
    rect(86, 223, 548, 546, '#f7fcff');
    line(54, 790, 665, 790, 2, '#508b9b');
    line(54, 809, 54, 872, 3, '#2d7391');
    for (const [x, y] of [[81, 139], [353, 147], [629, 137]]) ellipse(x, y, 13, 13, '#407d97');
    line(95, 140, 339, 147, 3, '#85aeba'); line(367, 147, 615, 137, 3, '#85aeba');
  } else if (style.id === 'diary') {
    // Paper grain and ruled lines are deterministic; they remain identical in exports.
    for (let i = 0; i < 4000; i++) ellipse((i * 137 + 31) % 720, (i * 251 + 63) % 1280, .6, .6, '#756246', .07);
    for (let y = 935; y < 1170; y += 43) line(48, y, 672, y, 1, '#aa987b', .28);
    const frame = rotatedFrame(style.photo, 19);
    polygon(frame.map(([x, y]) => [x + 7, y + 10]), '#9c8062', .35); polygon(frame, '#f5ebd4');
    polygon([[282, 241], [436, 248], [433, 286], [279, 279]], '#c1ac83', .65);
    ellipse(607, 136, 44, 44, '#947559', .22); ellipse(607, 136, 34, 34, '#d9c8a8');
    line(60, 114, 303, 114, 2, '#96785b'); line(60, 130, 215, 130, 2, '#96785b');
  }
  return p.png();
}

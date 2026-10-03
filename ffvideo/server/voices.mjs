import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateTtsWav } from '../../packages/server/tts.mjs';

const execute = promisify(execFile);
const NATIVE_GENDERS = Object.freeze({
  Aman: 'male', Daniel: 'male', Eddy: 'male', Fred: 'male', Grandpa: 'male', Reed: 'male',
  Rishi: 'male', Rocko: 'male', Flo: 'female', Grandma: 'female', Karen: 'female', Kathy: 'female',
  Meijia: 'female', Moira: 'female', Samantha: 'female', Sandy: 'female', Shelley: 'female',
  Tara: 'female', Tessa: 'female', Tingting: 'female'
});
// Novelty effects (bells, robots, whisper, singing voices) are not narration candidates.
const NARRATION_NAMES = new Set(Object.keys(NATIVE_GENDERS));
const LOCALE_PRIORITY = { zh_CN: 0, zh_TW: 1, en_US: 0, en_GB: 1, en_AU: 2, en_IE: 3, en_ZA: 4, en_IN: 5 };
const cachedNative = new Map();

const failure = (message, code = 'VOICE_UNAVAILABLE') => Object.assign(new Error(message), { code, status: 409 });
const hash = (value) => createHash('sha256').update(String(value)).digest();
const nativeId = (name, locale) => `native_${name.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '_').toLowerCase()}_${locale}`;

/** Read say's localized voice names, retain the exact -v argument, and deduplicate locale variants. */
export function parseSayVoices(listing) {
  if (typeof listing !== 'string') throw new TypeError('Native voice listing must be a string');
  const groups = new Map();
  for (const line of listing.split(/\r?\n/)) {
    const match = /^\s*(.+?)\s+([a-z]{2}_[A-Za-z0-9]+)\s+#/.exec(line);
    if (!match) continue;
    const [, sayName, locale] = match;
    const language = locale.startsWith('zh_') ? 'zh' : locale.startsWith('en_') ? 'en' : null;
    // zh_HK is Cantonese; do not silently use it for Mandarin narration.
    if (!language || !(locale in LOCALE_PRIORITY)) continue;
    const baseName = sayName.replace(/\s*\(.+\)\s*$/, '').trim();
    if (!NARRATION_NAMES.has(baseName)) continue;
    const group = `native:${language}:${baseName.toLowerCase()}`;
    const candidate = {
      id: nativeId(baseName, locale), name: `${baseName} · ${locale.replace('_', '-')}`,
      sayName: sayName.trim(), baseName, language, locale,
      gender: NATIVE_GENDERS[baseName] || 'unknown', genderSource: 'voice-name-metadata',
      backend: 'native', group, installed: true, verified: false, source: 'say-list'
    };
    candidate.recommended = language !== 'zh' || ['Tingting', 'Meijia'].includes(baseName);
    const previous = groups.get(group);
    if (!previous || LOCALE_PRIORITY[locale] < LOCALE_PRIORITY[previous.locale]) groups.set(group, candidate);
  }
  return [...groups.values()].sort((a, b) => a.language.localeCompare(b.language) || a.id.localeCompare(b.id));
}

/** Probe only voices enumerated by the local OS. This performs no installation or download. */
async function verifyNativeVoice(voice, directory) {
  const output = join(directory, voice.id + '.wav');
  await execute('/usr/bin/say', [
    '-v', voice.sayName, '--file-format=WAVE', '--data-format=LEI16@24000', '-o', output,
    voice.language === 'zh' ? '这是本地语音测试。' : 'This is a local voice test.'
  ], { timeout: 8000, maxBuffer: 128 * 1024 });
  const bytes = await readFile(output);
  const format = validateTtsWav(bytes);
  let cursor = 12, peak = 0;
  while (cursor + 8 <= bytes.length) {
    const size = bytes.readUInt32LE(cursor + 4), start = cursor + 8;
    if (bytes.toString('ascii', cursor, cursor + 4) === 'data') {
      for (let i = start; i < start + size; i += format.bits / 8) {
        const value = format.codec === 3 ? bytes.readFloatLE(i) : bytes.readInt16LE(i) / 32768;
        peak = Math.max(peak, Math.abs(value));
      }
      break;
    }
    cursor = start + size + (size % 2);
  }
  if (format.durationSeconds < 0.1 || peak < 0.001) throw new Error('Voice produced empty or silent speech');
  return { ...voice, verified: true, verification: { durationSeconds: format.durationSeconds, peak } };
}

async function nativeCatalog({ language, recommendedOnly } = {}) {
  if (process.platform !== 'darwin') return { voices: [], unavailableReason: 'macOS 系统声音仅可在 macOS 使用。' };
  const { stdout } = await execute('/usr/bin/say', ['-v', '?'], { timeout: 5000, maxBuffer: 1024 * 1024 });
  const listed = parseSayVoices(stdout).filter(voice => (!language || voice.language === language) && (!recommendedOnly || voice.recommended)), voices = [], failures = [];
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-voice-probe-'));
  try {
    // Keep OS synthesis bounded. Every selectable native voice must produce actual non-silent PCM.
    for (let offset = 0; offset < listed.length; offset += 2) {
      const results = await Promise.allSettled(listed.slice(offset, offset + 2).map(voice => verifyNativeVoice(voice, directory)));
      for (let i = 0; i < results.length; i++) {
        const result = results[i], voice = listed[offset + i];
        if (result.status === 'fulfilled') voices.push(result.value);
        else failures.push({ id: voice.id, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      }
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
  return { voices, ...(failures.length ? { unavailableVoices: failures } : {}) };
}

/** Browser callers supply the installed Kokoro catalog; no model is downloaded by this helper. */
export async function voiceCatalog({ speechBackend = process.platform === 'darwin' ? 'native' : 'browser', ttsCatalog, nativeListing, refresh = false, language, recommendedOnly = false } = {}) {
  if (!['native', 'browser'].includes(speechBackend)) throw new TypeError('Unknown speech backend');
  let result;
  if (speechBackend === 'native') {
    if (nativeListing !== undefined) result = { voices: parseSayVoices(nativeListing) };
    else {
      const key = `${language || 'all'}:${recommendedOnly}`;
      if (refresh) cachedNative.clear();
      if (!cachedNative.has(key)) cachedNative.set(key, nativeCatalog({ language, recommendedOnly }).catch(error => { cachedNative.delete(key); throw error; }));
      result = await cachedNative.get(key);
    }
  } else {
    const installed = new Set(ttsCatalog?.installedVoices || []);
    const modelInstalled = !ttsCatalog?.installedDtypes || ttsCatalog.installedDtypes.includes('fp32');
    result = { voices: modelInstalled ? (ttsCatalog?.voices || []).filter(voice => voice.installed || installed.has(voice.id)).map(voice => ({
      ...voice, backend: 'browser', installed: true, group: `kokoro:${voice.id}`, source: 'installed-kokoro',
      gender: ['female', 'male'].includes(voice.gender) ? voice.gender : 'unknown'
    })) : [] };
  }
  const availability = { zh: result.voices.filter(voice => voice.language === 'zh').length, en: result.voices.filter(voice => voice.language === 'en').length };
  return { backend: speechBackend, selectionMode: 'random', ...result, availability };
}

function findVoice(voices, selected) {
  if (!selected) return undefined;
  const id = typeof selected === 'object' ? selected.id : selected;
  return voices.find(voice => voice.id === id || voice.sayName === id || voice.baseName === id);
}

/** Deterministic for one work and assignment context; persist id to retain it across rebuilding. */
export function pickVoice({ voice = 'random', language = 'zh', workId, previousVoice, backend, catalog }) {
  const selectedBackend = backend || catalog?.backend;
  if (!['native', 'browser'].includes(selectedBackend) || !['zh', 'en'].includes(language)) throw new TypeError('Voice backend or language is invalid');
  if (typeof workId !== 'string' || !workId.trim()) throw new TypeError('A stable workId is required');
  const candidates = (catalog?.voices || []).filter(item => item.installed && item.language === language && (!item.backend || item.backend === selectedBackend));
  if (!candidates.length) throw failure(language === 'zh' ? '没有已安装且可用的中文音色。' : 'No installed English narration voice is available.', selectedBackend === 'browser' ? 'TTS_MODEL_REQUIRED' : 'VOICE_UNAVAILABLE');
  const fixed = voice !== 'random' && voice !== 'auto';
  let selected;
  if (fixed) {
    selected = findVoice(candidates, voice);
    if (!selected) throw failure(`所选音色 ${voice} 尚未安装、不可用或与作品语言不匹配。`);
  } else {
    const recommended = candidates.filter(candidate => candidate.recommended !== false);
    if (!recommended.length) throw failure('没有适合清晰中文旁白的已安装音色，请在设置中选择固定音色。');
    const previous = findVoice(catalog.voices || [], previousVoice);
    let pool = previous && recommended.length > 1 ? recommended.filter(candidate => candidate.group !== previous.group && candidate.id !== previous.id) : recommended;
    if (!pool.length) pool = recommended;
    // Alternate known genders when the installed inventory permits, while also avoiding adjacent repeats.
    const alternate = previous && ['female', 'male'].includes(previous.gender) ? pool.filter(candidate => ['female', 'male'].includes(candidate.gender) && candidate.gender !== previous.gender) : [];
    if (alternate.length) pool = alternate;
    pool = pool.slice().sort((a, b) => a.id.localeCompare(b.id));
    selected = pool[hash(`${selectedBackend}:${language}:${workId}:voice`).readUInt32BE(0) % pool.length];
  }
  const seed = hash(`${selectedBackend}:${language}:${workId}:expression`);
  const rate = language === 'zh' ? [170, 176, 182, 188][seed[0] % 4] : [155, 165, 175, 185][seed[0] % 4];
  const speed = [0.96, 1, 1.04][seed[1] % 3];
  const onlyOne = (fixed ? candidates : candidates.filter(candidate => candidate.recommended !== false)).length === 1;
  return {
    ...selected, mode: fixed ? 'fixed' : 'random', workId, rate, speed,
    // No unverified pitch control is sent to say or Kokoro. Rate changes are expression, not another voice.
    pitch: null, pitchSupported: false,
    expressionLabel: onlyOne && !fixed ? '仅有一个已安装音色，变化的是语速表达，音色保持相同。' : '语速表达变化',
    voiceVariety: onlyOne ? 'single' : 'multiple'
  };
}

export function nativeSayArgs(selection, { inputPath, outputPath }) {
  if (selection?.backend !== 'native' || typeof selection.sayName !== 'string' || !selection.sayName) throw new TypeError('A native voice selection is required');
  if (typeof inputPath !== 'string' || !inputPath || typeof outputPath !== 'string' || !outputPath) throw new TypeError('Speech input and output paths are required');
  const rate = Number(selection.rate);
  if (!Number.isFinite(rate) || rate < 120 || rate > 260) throw new TypeError('Speech rate is invalid');
  return ['-v', selection.sayName, '-r', String(rate), '--file-format=WAVE', '--data-format=LEI16@24000', '-f', inputPath, '-o', outputPath];
}

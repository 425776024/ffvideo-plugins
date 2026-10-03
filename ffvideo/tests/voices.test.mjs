import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSayVoices, voiceCatalog, pickVoice, nativeSayArgs } from '../server/voices.mjs';

const listing = `Tingting (中文（中国大陆）) zh_CN # 你好！
Tingting (中文（中国大陆）) zh_CN # duplicate
Meijia zh_TW # 你好！
Eddy (中文（中国大陆）) zh_CN # 你好！
Eddy (中文（台湾）) zh_TW # 你好！
Flo (中文（中国大陆）) zh_CN # 你好！
Sinji zh_HK # Cantonese
Samantha (英语（美国）) en_US # Hello
Daniel en_GB # Hello
Reed (英语（美国）) en_US # Hello
Boing en_US # effect
Kyoko ja_JP # Japanese`;

test('native listing retains real localized say names, deduplicates and excludes language/novelty mismatches', () => {
  const catalog = parseSayVoices(listing);
  assert.equal(catalog.filter(voice => voice.language === 'zh').length, 4);
  assert.equal(catalog.filter(voice => voice.language === 'en').length, 3);
  assert.equal(catalog.find(voice => voice.baseName === 'Eddy').locale, 'zh_CN');
  assert.equal(catalog.find(voice => voice.baseName === 'Tingting').sayName, 'Tingting (中文（中国大陆）)');
  assert.ok(!catalog.some(voice => ['Sinji', 'Boing', 'Kyoko'].includes(voice.baseName)));
});

test('Chinese random narration rotates clear local voices and excludes character voices', async () => {
  const catalog = await voiceCatalog({ speechBackend: 'native', nativeListing: listing });
  let previous;
  const assigned = [];
  for (let index = 0; index < 20; index++) {
    const selected = pickVoice({ language: 'zh', workId: `work-${index}`, previousVoice: previous, catalog });
    if (previous) assert.notEqual(selected.id, previous.id);
    assert.ok(['Tingting', 'Meijia'].includes(selected.baseName));
    assert.ok(selected.rate >= 170 && selected.rate <= 188);
    assigned.push(selected); previous = selected;
  }
  assert.equal(new Set(assigned.map(voice => voice.id)).size, 2);
  assert.equal(pickVoice({ voice: 'Eddy', workId: 'explicit-character', language: 'zh', catalog }).baseName, 'Eddy');
});

test('persisted fixed ids and deterministic expressions do not change when a work is rebuilt', async () => {
  const catalog = await voiceCatalog({ speechBackend: 'native', nativeListing: listing });
  const first = pickVoice({ workId: 'rebuild-me', language: 'zh', catalog });
  const rebuilt = pickVoice({ voice: first.id, workId: first.workId, language: 'zh', previousVoice: first.id, catalog });
  assert.equal(rebuilt.id, first.id); assert.equal(rebuilt.rate, first.rate); assert.equal(rebuilt.speed, first.speed);
  assert.equal(rebuilt.pitch, null);
});

test('fixed voices respect language and fail explicitly when unavailable', async () => {
  const catalog = await voiceCatalog({ speechBackend: 'native', nativeListing: listing });
  assert.throws(() => pickVoice({ voice: 'Samantha', language: 'zh', workId: 'zh-fixed', catalog }), /语言不匹配/);
  const selected = pickVoice({ voice: 'Daniel', language: 'en', workId: 'en-fixed', catalog });
  assert.equal(selected.baseName, 'Daniel');
});

test('browser random choices use installed voice plus installed FP32 model only', async () => {
  const voices = [
    { id: 'zf_001', language: 'zh', gender: 'female', installed: true },
    { id: 'zm_010', language: 'zh', gender: 'male', installed: false },
    { id: 'af_maple', language: 'en', gender: 'female', installed: true }
  ];
  const catalog = await voiceCatalog({ speechBackend: 'browser', ttsCatalog: { installedDtypes: ['fp32'], voices } });
  const selected = pickVoice({ language: 'zh', workId: 'only-one', catalog });
  assert.equal(selected.id, 'zf_001'); assert.equal(selected.voiceVariety, 'single');
  assert.match(selected.expressionLabel, /音色保持相同/);
  const absentModel = await voiceCatalog({ speechBackend: 'browser', ttsCatalog: { installedDtypes: [], voices } });
  assert.equal(absentModel.voices.length, 0);
  assert.throws(() => pickVoice({ language: 'zh', workId: 'no-model', catalog: absentModel }), { code: 'TTS_MODEL_REQUIRED' });
});

test('native synthesis arguments use the verified voice and rate without claiming pitch changes', async () => {
  const catalog = await voiceCatalog({ speechBackend: 'native', nativeListing: listing });
  const selection = pickVoice({ voice: 'Tingting', workId: 'args', language: 'zh', catalog });
  const args = nativeSayArgs(selection, { inputPath: '/tmp/voice input.txt', outputPath: '/tmp/out.wav' });
  assert.equal(args[1], 'Tingting (中文（中国大陆）)');
  assert.equal(args[3], String(selection.rate));
  assert.ok(!args.some(argument => argument.includes('pitch')));
  assert.ok(args.includes('/tmp/voice input.txt'));
});

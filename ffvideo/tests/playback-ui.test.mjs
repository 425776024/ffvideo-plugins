import test from 'node:test';
import assert from 'node:assert/strict';
import { stableFeedOrder, watchInterval, PlaybackRecoveryGate, hasServerRestarted, playbackSeekSeconds } from '../src/feed-state.mjs';

test('feedback can reorder future recommendations without moving the current work or prior scroll position', () => {
  assert.deepEqual(stableFeedOrder(['a', 'b', 'c', 'd'], ['d', 'c', 'a', 'b', 'e'], 'b'), [
    'a',
    'b',
    'd',
    'c',
    'e'
  ]);
});
test('excluded and removed works leave the upcoming stream; clearing resets its order', () => {
  assert.deepEqual(stableFeedOrder(['a', 'b', 'c'], ['c', 'b', 'd'], 'b'), ['b', 'c', 'd']);
  assert.deepEqual(stableFeedOrder(['a', 'b'], [], 'b'), []);
});
test('a newly published recommendation appends after existing upcoming works even when ranked first', () => {
  assert.deepEqual(stableFeedOrder(['a', 'b', 'c'], ['new', 'c', 'b', 'a'], 'b'), ['a', 'b', 'c', 'new']);
});
const sample = {
  fromSeconds: 4,
  toSeconds: 8,
  wallSeconds: 4,
  durationSeconds: 20,
  visible: true,
  foreground: true,
  playing: true,
  buffering: false,
  ready: true
};
test('paused, backgrounded, buffered and not-yet-rendered work cannot create watch time', () => {
  for (const patch of [
    { visible: false },
    { foreground: false },
    { playing: false },
    { buffering: true },
    { ready: false }
  ])
    assert.equal(watchInterval({ ...sample, ...patch }), null);
});
test('a seek or restored clock jump cannot be credited as watched duration', () => {
  assert.equal(watchInterval({ ...sample, toSeconds: 20, wallSeconds: 1 }).seconds, 1);
  assert.equal(
    watchInterval({ ...sample, fromSeconds: 17, toSeconds: 25, wallSeconds: 10 }).seconds,
    3
  );
  assert.equal(watchInterval({ ...sample, fromSeconds: 8, toSeconds: 2 }), null);
});
test('a server restart is distinguished from first load, stable polling and legacy state', () => {
  assert.equal(hasServerRestarted(undefined, 'server-a'), false);
  assert.equal(hasServerRestarted('server-a', 'server-a'), false);
  assert.equal(hasServerRestarted('server-a', undefined), false);
  assert.equal(hasServerRestarted('server-a', 'server-b'), true);
});
test('media authentication recovery survives player remounts and permits only one retry for the same work and instance', () => {
  const gate = new PlaybackRecoveryGate();
  assert.equal(gate.claim('server-a', 'work-1', '读取图片失败 (401)'), true);
  assert.equal(gate.claim('server-a', 'work-1', '读取音频失败 (401)'), false);
  assert.equal(gate.claim('server-a', 'work-1', new Error('Unauthorized')), false);
  assert.equal(gate.claim('server-b', 'work-1', '读取图片失败 (401)'), true, 'a subsequent service restart allows one fresh recovery');
  assert.equal(gate.claim('server-b', 'work-1', '读取图片失败 (401)'), false);
  assert.equal(gate.claim('server-b', 'work-2', '读取图片失败 (401)'), true);
});
test('unavailable files and ordinary renderer failures never cause bootstrap retry loops', () => {
  const gate = new PlaybackRecoveryGate();
  assert.equal(gate.claim('server-a', 'work-1', '读取图片失败 (404)'), false);
  assert.equal(gate.claim('server-a', 'work-1', '播放工作线程失败'), false);
  assert.equal(gate.claim('server-a', '', '读取图片失败 (401)'), false);
  assert.equal(gate.claim('server-a', 'work-1', '读取图片失败 (401)'), true, 'ordinary errors must not consume the one authentication retry');
});
test('seeking preserves subsecond positions and bounds both directions to the actual media duration', () => {
  assert.equal(playbackSeekSeconds(14.6, 27.35), 14.6);
  assert.equal(playbackSeekSeconds(-10, 27.35), 0);
  assert.equal(playbackSeekSeconds(100, 27.35), 27.35);
  assert.equal(playbackSeekSeconds(Number.NaN, 27.35), null);
  assert.equal(playbackSeekSeconds(4, 0), null);
});
test('slider scrubbing awards no watch time and playback after a seek starts credit at the new position', () => {
  assert.equal(watchInterval({ ...sample, toSeconds: 18, seeking: true }), null);
  assert.equal(watchInterval({ ...sample, toSeconds: 2, seeking: true }), null);
  assert.equal(watchInterval({ ...sample, fromSeconds: 18, toSeconds: 19, wallSeconds: 1, seeking: false }).seconds, 1);
  assert.equal(watchInterval({ ...sample, fromSeconds: 2, toSeconds: 3, wallSeconds: 1, seeking: false }).seconds, 1);
});

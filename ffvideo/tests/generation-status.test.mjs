import test from 'node:test';
import assert from 'node:assert/strict';
import { generationMessage } from '../src/generation-status.mjs';

test('failed drafts stay visible when other requests are queued or writing', () => {
  const failure = { status: 'failed', error: '模型连接失败' };
  const selectedJobs = [failure, { status: 'queued' }];
  assert.equal(generationMessage({ jobs: [selectedJobs[1]], selectedJobs }).error, failure.error);
  assert.match(generationMessage({ jobs: [selectedJobs[1]], selectedJobs }).title, /暂未完成/);
  const writing = generationMessage({ service: { elapsedSeconds: 95 }, jobs: [{ status: 'claimed', phase: 'script-writing', scriptCharacters: 4321 }], selectedJobs });
  assert.match(writing.title, /正在编写脚本 · 4321字/); assert.match(writing.detail, /4321/); assert.equal(writing.error, failure.error);
  assert(!writing.title.includes('已完成 0 条'));
});
test('blocked generation shows the real reason and cannot look like a live composing task', () => {
  const value = generationMessage({ service: { blocked: true, lastError: '90 秒没有返回新内容' }, jobs: [{ status: 'claimed', phase: 'script' }] });
  assert.equal(value.title, '制作已停止，请重连'); assert.equal(value.error, '90 秒没有返回新内容');
});

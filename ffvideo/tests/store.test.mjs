import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { FeedStore } from '../server/store.mjs';
import { validateRecipe, normalizePreferences, planRecommendations, rankWorks } from '../server/recommendation.mjs';

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'ffvideo-store-'));
  let store = await FeedStore.open(directory);
  t.after(async () => { await store.close(); await rm(directory, { recursive: true, force: true }); });
  return { directory, get store() { return store; }, reopen: async () => { await store.close(); store = await FeedStore.open(directory); return store; } };
}
const recipe = suffix => ({
  title: `A draft ${suffix}`, narration: `A real supplied narration ${suffix}.`, tags: ['science'], language: 'en',
  scenes: [{ heading: 'An example', body: 'Content comes from the agent, not the recommendation planner.', seconds: 10, accent: '#33aaff' }]
});
test('video model and reasoning preference persist locally and reject invalid modes', async t => {
  const f = await fixture(t);
  await f.store.updatePreferences({ generationModel: 'gpt-6-luna', reasoningMode: 'none' });
  const restored = await f.reopen();
  assert.equal(restored.state().preferences.generationModel, 'gpt-6-luna');
  assert.equal(restored.state().preferences.reasoningMode, 'none');
  assert.throws(() => normalizePreferences({ reasoningMode: 'deepest' }), /reasoningMode/);
  assert.throws(() => normalizePreferences({ generationModel: 'invalid model\n' }), /generationModel/);
});

test('an explicitly requested new direction may reuse completed narration without weakening automatic duplicate prevention',async t=>{
 const f=await fixture(t);await f.store.createFeed('same supplied facts');
 const first=await f.store.claimJob('original');const content=recipe('retained');await f.store.submitRecipe(first.job.id,first.claimToken,content);
 const work=await f.store.publishWork(first.job.id,{id:'original-reference',projectPath:join(f.directory,'original.json'),durationSeconds:25});
 const copy=await f.store.createRecipeDraft(content,{copiedFrom:work.id});await f.store.updateJob(copy.jobId,{status:'queued'});await f.store.selectFeed(copy.feedId);
 const claim=await f.store.claimJob('new-director');assert.equal(claim.job.id,copy.jobId);
 const submitted=await f.store.submitRecipe(claim.job.id,claim.claimToken,content);assert.equal(submitted.status,'composing');
 assert.equal(f.store.state().jobs.find(j=>j.id===first.job.id).recipe.narration,content.narration);
});
const sample = (id = 'sample-1', topic = 'science') => ({
  id, topic, title: `Playable ${id}`, tags: [topic], durationSeconds: 20, projectPath: `/tmp/${id}.vcutweb`, source: 'sample'
});
test('position follows the actual suffix, publishes one at a time and retains three future works without idle overfill', async t => {
  const f = await fixture(t), { store } = f;
  await store.updatePreferences({ autoGenerate: false });
  const feed = await store.createFeed('science');
  for (let index = 0; index < 5; index++) {
    const claim = await store.claimJob('position-worker');
    await store.submitRecipe(claim.job.id, claim.claimToken, recipe(`position-${index}`));
    await store.publishWork(claim.job.id, { id: `pos-${index}`, projectPath: `/tmp/pos-${index}.json`, durationSeconds: 20 });
  }
  const position = (id, aheadIds, tail = store.state().works.at(-1).id, list = 'topics') => ({ eventId: randomUUID(), type: 'position', workId: id, list, feedId: feed.id, aheadIds, knownTailId: tail });
  await store.recordEvents([position('pos-3', ['pos-4'])]);
  await store.updatePreferences({ autoGenerate: true });
  assert.equal(store.state().buffer.available, 5, 'all old works remain unread; suffix is counted independently');
  assert.equal(store.state().buffer.aheadReady, 1); assert.equal(store.state().buffer.pending, 2);
  for (let index = 5; index < 7; index++) {
    const claim = await store.claimJob('position-worker');
    await store.submitRecipe(claim.job.id, claim.claimToken, recipe(`position-${index}`));
    const count = store.state().works.length;
    await store.publishWork(claim.job.id, { id: `pos-${index}`, projectPath: `/tmp/pos-${index}.json`, durationSeconds: 20 });
    assert.equal(store.state().works.length, count + 1);
    await store.enqueueRecommendations();
    assert.equal(store.state().buffer.aheadReady + store.state().buffer.pending, 3);
  }
  const count = store.state().jobs.length;
  await Promise.all([store.enqueueRecommendations(), store.enqueueRecommendations()]);
  assert.equal(store.state().jobs.length, count);
  await f.reopen(); assert.equal(f.store.state().buffer.aheadReady, 3);
  await f.store.recordEvents([{ ...position('pos-6', [], 'pos-6'), eventId: randomUUID() }]);
  assert.equal(f.store.state().buffer.pending, 3, 'jumping to the end prepares three more despite seven unread works');
  assert.equal(f.store.state().interest.science?.positive || 0, 0, 'position is not manufactured viewing engagement');
});
test('background/stale positions do not move the window and publication races count the unseen new tail', async t => {
  const { store } = await fixture(t);
  await store.updatePreferences({ autoGenerate: false }); await store.seedWorks([sample('window-a'), sample('window-b')]);
  await store.recordEvents([{ eventId: 'race-position', type: 'position', list: 'recommended', workId: 'window-a', knownTailId: 'window-a', aheadIds: [] }]);
  assert.equal(store.state().buffer.aheadReady, 1, 'a work published after the client snapshot already covers one future slot');
  await store.recordEvents([{ eventId: 'background-position', type: 'position', list: 'recommended', workId: 'window-b', knownTailId: 'window-b', aheadIds: [], visible: false }]);
  assert.equal(store.state().buffer.trackingWorkId, 'window-a');
  await store.recordEvents([{ eventId: 'history-position', type: 'position', list: 'history', workId: 'window-b', knownTailId: 'window-b', aheadIds: [] }]);
  await store.updatePreferences({ autoGenerate: true });
  assert.equal(store.state().buffer.pending, 0, 'browsing history does not create an endless history refill');
});
test('explicit generator retry recovers exhausted active jobs without reviving a cancelled topic', async t => {
  const { store } = await fixture(t);
  await store.createFeed('old topic');
  const previous = await store.claimJob('previous-worker');
  await store.updateJob(previous.job.id, { status: 'failed', error: 'invalid_json_schema' });
  const active = await store.createFeed('new topic');
  let failed = await store.claimJob('active-worker');
  for (let retry = 0; retry < 2; retry++) {
    await store.updateJob(failed.job.id, { leaseExpiresAt: Date.now() - 1 });
    failed = await store.claimJob('active-worker');
  }
  await store.updateJob(failed.job.id, { status: 'failed', error: 'invalid_json_schema' });
  assert.deepEqual(await store.retryGenerationJobs(), [failed.job.id]);
  const current = store.state();
  assert.equal(current.jobs.find(job => job.id === failed.job.id).status, 'queued');
  assert.equal(current.jobs.find(job => job.id === failed.job.id).attempts, 0);
  assert.notEqual(current.jobs.find(job => job.id === previous.job.id).status, 'queued');
  assert.equal((await store.claimJob('recovery-worker')).job.feedId, active.id);
});
async function published(store, suffix = 'one') {
  await store.createFeed('science');
  const claim = await store.claimJob('test-agent');
  await store.submitRecipe(claim.job.id, claim.claimToken, recipe(suffix));
  return { claim, work: await store.publishWork(claim.job.id, { id: `work-${suffix}`, durationSeconds: 20, projectPath: `/tmp/${suffix}.vcutweb` }) };
}

test('atomic JSON persistence retains manual preferences, comments and dedupe across restart', async t => {
  const f = await fixture(t);
  await f.store.updatePreferences({ language: 'en', voice: 'af_heart', topics: ['Science', 'science'], autoplay: false, format: 'webm' });
  const { work } = await published(f.store);
  await f.store.addComment(work.id, 'Please explain more about this');
  const event = { eventId: 'persist-watch', type: 'watch', workId: work.id, seconds: 5 };
  await f.store.recordEvents([event]);
  const before = f.store.state();
  const detached = f.store.state(); detached.preferences.language = 'zh'; detached.works[0].comments.length = 0;
  assert.deepEqual(f.store.state(), before, 'state must not expose mutable backing data');
  await f.reopen();
  assert.deepEqual(f.store.state(), before);
  assert.equal((await f.store.recordEvents([event])).accepted, 0);
  assert.deepEqual((await readdir(f.directory)).filter(name => name.endsWith('.tmp')), []);
  assert.equal(JSON.parse(await readFile(join(f.directory, 'feed-state.json'), 'utf8')).schemaVersion, 1);
});

test('five distinct topic angles, exclusive claims, expired lease recovery and stale claim rejection', async t => {
  const f = await fixture(t);
  const feed = await f.store.createFeed('a user-supplied unfamiliar topic');
  assert.equal(feed.jobs.length, 5);
  assert.equal(new Set(feed.jobs.map(job => job.angle)).size, 5);
  assert(feed.jobs.every(job => job.topic === feed.topic && !job.recipe));
  const claims = await Promise.all(Array.from({ length: 6 }, (_, index) => f.store.claimJob(`worker-${index}`)));
  assert.equal(claims.filter(Boolean).length, 5);
  assert.equal(new Set(claims.filter(Boolean).map(claim => claim.job.id)).size, 5);
  const first = claims[0];
  assert.equal(f.store.state().jobs.find(job => job.id === first.job.id).claimToken, undefined, 'claim secrets must not leak through public state');
  await assert.rejects(f.store.submitRecipe(first.job.id, 'wrong-secret', recipe('lease')), /invalid or expired/);
  await f.store.updateJob(first.job.id, { leaseExpiresAt: Date.now() - 1 });
  await f.reopen();
  const reclaimed = await f.store.claimJob('replacement-worker');
  assert.equal(reclaimed.job.id, first.job.id);
  assert.notEqual(reclaimed.claimToken, first.claimToken);
  await assert.rejects(f.store.submitRecipe(first.job.id, first.claimToken, recipe('lease')), /invalid or expired/);
  assert.equal((await f.store.submitRecipe(reclaimed.job.id, reclaimed.claimToken, recipe('lease'))).status, 'composing');
});

test('invalid recipes and duplicate scripts do not mutate accepted work', async t => {
  const { store } = await fixture(t);
  await store.createFeed('science');
  const a = await store.claimJob('worker-a'), b = await store.claimJob('worker-b');
  const original = store.state();
  assert.throws(() => store.submitRecipe(a.job.id, a.claimToken, { ...recipe('same'), scenes: [] }), /between 1 and 20/);
  assert.deepEqual(store.state(), original);
  await store.submitRecipe(a.job.id, a.claimToken, recipe('same'));
  await assert.rejects(store.submitRecipe(b.job.id, b.claimToken, recipe('same')), /duplicates/);
  await assert.rejects(store.publishWork(b.job.id, { ...sample('bad'), source: 'generated' }), /no accepted recipe/);
  const work = await store.publishWork(a.job.id, { id: 'actual-work', durationSeconds: 20, projectPath: '/tmp/actual.vcutweb',
    posterPath: '/tmp/actual.png', description: 'A'.repeat(5000) });
  assert.equal(work.source, 'generated');
  assert.equal(work.title, recipe('same').title);
  assert.equal(work.posterPath, '/tmp/actual.png');
  assert.equal(work.description.length, 5000);
  assert.equal((await store.publishWork(a.job.id, { ...work, title: 'replacement' })).title, work.title, 'publish retry is idempotent and immutable');
  assert.equal(store.state().works.length, 1);
});

test('watching counts unique visible playback intervals; failures, buffering, seeks and replay spam are excluded', async t => {
  const { store } = await fixture(t);
  await store.seedWorks([sample()]); await store.updatePreferences({ autoGenerate: false });
  await store.recordEvents([
    { eventId: 'watch-1', type: 'watch', workId: 'sample-1', fromSeconds: 0, toSeconds: 5 },
    { eventId: 'watch-2', type: 'watch', workId: 'sample-1', fromSeconds: 0, toSeconds: 5 },
    { eventId: 'background', type: 'watch', workId: 'sample-1', seconds: 100, foreground: false },
    { eventId: 'buffering', type: 'watch', workId: 'sample-1', seconds: 100, buffering: true },
    { eventId: 'seek', type: 'watch', workId: 'sample-1', seconds: 100, seeked: true },
    { eventId: 'failure', type: 'skip', workId: 'sample-1', failed: true }
  ]);
  assert.equal(store.state().interest.science.positive, 0.5);
  assert.equal(store.state().interest.science.negative, 0);
  const duplicate = await store.recordEvents([{ eventId: 'watch-1', type: 'watch', workId: 'sample-1', seconds: 15 }]);
  assert.equal(duplicate.accepted, 0);
  await store.recordEvents([{ eventId: 'watch-rest', type: 'watch', workId: 'sample-1', fromSeconds: 5, toSeconds: 20 }]);
  assert.equal(store.state().interest.science.positive, 2);
  await store.recordEvents(Array.from({ length: 8 }, (_, index) => ({ eventId: `spam-${index}`, type: 'watch', workId: 'sample-1', seconds: 15 })));
  assert.equal(store.state().interest.science.positive, 2, 'watch reward is capped by actual work duration');
});

test('early successful skip is negative once; loading failures never become topic dislikes', async t => {
  const { store } = await fixture(t);
  await store.seedWorks([sample(), sample('sample-2', 'design')]); await store.updatePreferences({ autoGenerate: false });
  await store.recordEvents([
    { eventId: 'unplayed-skip', type: 'skip', workId: 'sample-2' },
    { eventId: 'watch', type: 'watch', workId: 'sample-1', seconds: 1.5 },
    { eventId: 'failed-skip', type: 'skip', workId: 'sample-1', failed: true },
    { eventId: 'buffer-skip', type: 'skip', workId: 'sample-1', buffering: true }
  ]);
  assert.equal(store.state().interest.science.negative, 0);
  assert.equal(store.state().interest.design, undefined);
  await store.recordEvents([{ eventId: 'real-skip', type: 'skip', workId: 'sample-1' }, { eventId: 'repeat-skip', type: 'skip', workId: 'sample-1' }]);
  assert.equal(store.state().interest.science.negative, 1);
});

test('a seek-sized interval cannot override the real elapsed playback time supplied by the player', async t => {
  const { store } = await fixture(t);
  await store.seedWorks([sample()]); await store.updatePreferences({ autoGenerate: false });
  const result = await store.recordEvents([{ eventId: 'seek-jump', type: 'watch', workId: 'sample-1', fromSeconds: 0, toSeconds: 20, seconds: 1 }]);
  assert.equal(result.events[0].seconds, 1);
  assert.equal(store.state().interest.science.positive, 0.1);
});

test('comments distinguish deeper requests, corrections and exclusions; exclusion invalidates queued topics', async t => {
  const { store } = await fixture(t);
  const { work } = await published(store, 'comments');
  assert.equal((await store.addComment(work.id, '为什么会这样，请讲得更详细')).intent, 'request-more');
  const score = store.state().interest.science.score;
  assert.equal((await store.addComment(work.id, '这里说错了')).intent, 'correction');
  assert.equal(store.state().interest.science.score, score);
  assert.equal((await store.addComment(work.id, '不要再推荐这个主题')).intent, 'exclude');
  assert(store.state().jobs.filter(job => job.status === 'queued').every(job => job.topic !== 'science'));
  assert.equal(store.recommendedWorks().length, 0, 'excluded suggestions stay in history but leave recommendations');
  assert.equal(store.state().works[0].comments.length, 3);
  await store.createFeed('science');
  assert.equal(store.state().interest.science.suppressed, false, 'a new explicit request can restore a dismissed topic');
});

test('sample seeding is durable and idempotent, and clearing invalidates old jobs while preserving manual preferences', async t => {
  const f = await fixture(t);
  const samples = Array.from({ length: 5 }, (_, index) => sample(`seed-${index}`));
  assert.equal((await f.store.seedWorks(samples)).length, 5);
  assert.equal(f.store.state().seeded, true);
  assert.equal((await f.store.seedWorks(samples)).length, 0);
  await f.store.updatePreferences({ topics: ['history'], excludedTopics: ['sports'], autoGenerate: false });
  const { claim } = await published(f.store, 'old');
  const oldEpoch = f.store.state().epoch;
  await f.store.clearHistory();
  assert.equal(f.store.state().epoch, oldEpoch + 1);
  assert.equal(f.store.state().works.length, 0);
  assert.deepEqual(f.store.state().preferences.topics, ['history']);
  await assert.rejects(f.store.publishWork(claim.job.id, sample('stale')), /no longer active/);
  await f.reopen();
  assert.equal((await f.store.seedWorks(samples)).length, 0);
  assert.equal(f.store.state().works.length, 0);
  assert.equal((await f.store.enqueueRecommendations()).length, 0);
});

test('viewing a draft replenishes below five unread works to eight and idle polling cannot overfill', async t => {
  const { store } = await fixture(t);
  await store.updatePreferences({ autoGenerate: false });
  await store.seedWorks(Array.from({ length: 5 }, (_, index) => sample(`buffer-${index}`)));
  await store.createFeed('science');
  // Complete the initial five fresh recommendations and use them as the ready buffer.
  for (let index = 0; index < 5; index++) {
    const claim = await store.claimJob('buffer-worker');
    await store.submitRecipe(claim.job.id, claim.claimToken, recipe(`buffer-${index}`));
    await store.publishWork(claim.job.id, { id: `fresh-${index}`, projectPath: `/tmp/fresh-${index}.vcutweb`, durationSeconds: 20 });
  }
  await store.updatePreferences({ autoGenerate: true });
  assert.equal((await store.enqueueRecommendations()).length, 0);
  assert.deepEqual(store.state().buffer, { available: 5, pending: 0, lowWater: 5, target: 8 });
  await store.recordEvents([{ eventId: 'seen-0', type: 'view', workId: 'fresh-0' }]);
  assert.equal(store.state().jobs.filter(job => job.status === 'queued').length, 4);
  assert.equal(store.state().buffer.available + store.state().buffer.pending, 8);
  await store.recordEvents([1, 2, 3].map(index => ({ eventId: `seen-${index}`, type: 'view', workId: `fresh-${index}` })));
  assert.equal(store.state().jobs.filter(job => job.status === 'queued').length, 4);
  await store.recordEvents([{ eventId: 'seen-4', type: 'view', workId: 'fresh-4' }]);
  assert.equal(store.state().jobs.filter(job => job.status === 'queued').length, 8);
  await Promise.all([store.enqueueRecommendations(), store.enqueueRecommendations(), store.enqueueRecommendations()]);
  assert.equal(store.state().jobs.filter(job => job.status === 'queued').length, 8, 'concurrent replenishment cannot overfill');
  await store.updatePreferences({ autoGenerate: false });
  await store.recordEvents([{ eventId: 'seen-sample', type: 'view', workId: 'buffer-3' }]);
  assert.equal((await store.enqueueRecommendations()).length, 0);
});

test('a full eight-work buffer survives restarting without generating idle replacement jobs', async t => {
  const f = await fixture(t);
  await f.store.updatePreferences({ autoGenerate: false });
  await f.store.createFeed('science');
  for (let index = 0; index < 5; index++) {
    const claim = await f.store.claimJob('restart-worker');
    await f.store.submitRecipe(claim.job.id, claim.claimToken, recipe(`restart-${index}`));
    await f.store.publishWork(claim.job.id, { id: `restart-${index}`, projectPath: `/tmp/restart-${index}.vcutweb`, durationSeconds: 20 });
  }
  await f.store.recordEvents([{ eventId: 'restart-seen', type: 'view', workId: 'restart-0' }]);
  await f.store.updatePreferences({ autoGenerate: true });
  assert.equal(f.store.state().buffer.available, 4);
  assert.equal(f.store.state().buffer.pending, 4);
  await f.reopen();
  const before = f.store.state().jobs.length;
  await Promise.all([f.store.enqueueRecommendations(), f.store.enqueueRecommendations()]);
  assert.equal(f.store.state().jobs.length, before);
});

test('paused auto-generation never creates refill jobs from watching, but resuming refills immediately', async t => {
  const { store } = await fixture(t);
  await store.updatePreferences({ autoGenerate: false });
  await store.createFeed('science');
  for (let index = 0; index < 5; index++) {
    const claim = await store.claimJob('pause-worker');
    await store.submitRecipe(claim.job.id, claim.claimToken, recipe(`pause-${index}`));
    await store.publishWork(claim.job.id, { id: `pause-${index}`, projectPath: `/tmp/pause-${index}.vcutweb`, durationSeconds: 20 });
  }
  await store.recordEvents([{ eventId: 'pause-seen', type: 'view', workId: 'pause-0' }]);
  assert.equal(store.state().jobs.filter(job => job.status === 'queued').length, 0);
  await store.updatePreferences({ autoGenerate: true });
  assert.equal(store.state().jobs.filter(job => job.status === 'queued').length, 4);
  assert.equal((await store.enqueueRecommendations()).length, 0);
  await store.updatePreferences({ autoGenerate: false });
  assert.equal(await store.claimJob('external-mcp-worker'), null, 'a paused feed cannot be resumed by a still-running MCP worker');
});

test('first opening schedules five fresh mixed recommendations even with five ready built-in samples', async t => {
  const { store } = await fixture(t);
  await store.seedWorks(Array.from({ length: 5 }, (_, index) => sample(`initial-${index}`)));
  const jobs = await store.enqueueRecommendations();
  assert.equal(jobs.length, 5);
  assert(new Set(jobs.map(job => job.topic)).size >= 3);
  assert.equal((await store.enqueueRecommendations()).length, 0);
  assert.equal(store.state().works.length, 5, 'samples remain playable while fresh drafts are planned');
});

test('stale epoch batches and deleted works are ignored without poisoning a concurrent valid playback batch', async t => {
  const { store } = await fixture(t);
  await store.updatePreferences({ autoGenerate: false });
  const { work } = await published(store, 'before-clear');
  const oldEpoch = store.state().epoch;
  await store.clearHistory();
  const result = await store.recordEvents([
    { eventId: 'old-work', type: 'watch', workId: work.id, seconds: 10 },
    { eventId: 'old-topic', type: 'topic', topic: 'outdated-topic', epoch: oldEpoch },
    { eventId: 'new-topic', type: 'topic', topic: 'current-topic', epoch: oldEpoch + 1 }
  ]);
  assert.equal(result.accepted, 1);
  assert.equal(store.state().interest['outdated-topic'], undefined);
  assert.equal(store.state().interest['current-topic'].positive, 2);
  assert.equal((await store.recordEvents([{ eventId: 'unknown-work', type: 'view', workId: 'deleted-work' }])).accepted, 0);
});

test('failed jobs wait for backoff instead of immediately multiplying generation requests', async t => {
  const { store } = await fixture(t);
  await store.createFeed('science');
  const claim = await store.claimJob('failing-provider');
  const failed = await store.updateJob(claim.job.id, { status: 'failed', error: 'Provider unavailable' });
  assert(failed.retryAt > Date.now());
  assert.equal((await store.enqueueRecommendations()).length, 0);
  assert.equal(store.state().jobs.length, 5);
  assert.notEqual((await store.claimJob('other-provider')).job.id, claim.job.id);
});

test('repeatedly abandoned claims stop retrying instead of generating an infinite lease loop', async t => {
  const { store } = await fixture(t);
  await store.createFeed('science');
  let target;
  for (let index = 0; index < 3; index++) {
    const claim = await store.claimJob('abandoned-worker');
    target ??= claim.job.id;
    assert.equal(claim.job.id, target);
    await store.updateJob(target, { leaseExpiresAt: Date.now() - 1 });
  }
  const next = await store.claimJob('new-worker');
  assert.notEqual(next.job.id, target);
  assert.equal(store.state().jobs.find(job => job.id === target).status, 'failed');
  assert.equal(store.state().jobs.filter(job => ['queued', 'claimed', 'composing'].includes(job.status)).length, 8, 'terminally abandoned job is excluded from the finite buffer');
});

test('visual upgrades keep narration, comments and viewing rewards, validate credits and persist across restart', async t => {
  const f = await fixture(t);
  await f.store.updatePreferences({ autoGenerate: false });
  const { work } = await published(f.store, 'upgrade');
  await f.store.addComment(work.id, 'Keep this explanation');
  await f.store.recordEvents([{ eventId: 'upgrade-watch', type: 'watch', workId: work.id, seconds: 5 }]);
  const before = f.store.state();
  const credit = { title: 'Mountain photograph', author: 'Photographer', license: 'CC BY 4.0',
    sourceUrl: 'https://commons.wikimedia.org/wiki/File:Mountain.jpg', licenseUrl: 'https://creativecommons.org/licenses/by/4.0/' };
  await assert.rejects(f.store.replaceWorkComposition(work.id, { visualCredits: [{ ...credit, sourceUrl: 'javascript:alert(1)' }] }), /credit URL/);
  assert.throws(() => f.store.replaceWorkComposition(work.id, { title: 'changed narration' }), /Cannot change work field/);
  const upgraded = await f.store.replaceWorkComposition(work.id, { projectPath: '/tmp/upgrade-visual.vcutweb', posterPath: '/tmp/mountain.jpg',
    durationSeconds: work.durationSeconds, visualVersion: 1, visualCredits: [credit] });
  assert.equal(upgraded.id, work.id); assert.equal(upgraded.title, work.title); assert.equal(upgraded.feedId, work.feedId);
  assert.equal(upgraded.comments.length, 1);
  assert.deepEqual(f.store.state().interest, before.interest);
  assert.equal((await f.store.recordEvents([{ eventId: 'upgrade-watch', type: 'watch', workId: work.id, seconds: 5 }])).accepted, 0);
  await f.reopen();
  assert.equal(f.store.state().works[0].visualVersion, 1);
  assert.deepEqual(f.store.state().works[0].visualCredits, [credit]);
  assert.equal(f.store.state().works[0].comments.length, 1);
});

test('case variants of topic tags cannot multiply interest reward', async t => {
  const { store } = await fixture(t);
  await store.seedWorks([{ ...sample(), topic: 'Science', tags: ['SCIENCE', 'science'] }]);
  await store.updatePreferences({ autoGenerate: false });
  await store.recordEvents([{ eventId: 'normal-watch', type: 'watch', workId: 'sample-1', seconds: 10 }]);
  assert.equal(store.state().interest.science.positive, 1);
});

test('long polling wakes on persisted events, reports timeouts, supports abort and releases on close', async t => {
  const { store } = await fixture(t);
  let deliveries = 0;
  const unsubscribe = store.subscribe(event => { deliveries++; assert.equal(event.state.cursor, event.cursor); });
  const pending = store.waitEvents(store.state().cursor, 1000);
  await store.updatePreferences({ autoplay: false });
  const result = await pending;
  assert.equal(result.events[0].type, 'preferences');
  assert.equal(result.timedOut, false);
  assert(deliveries > 0); unsubscribe();
  const timeout = await store.waitEvents(store.state().cursor, 5);
  assert.equal(timeout.timedOut, true);
  assert.deepEqual(timeout.events, []);
  const abort = new AbortController();
  const aborted = store.waitEvents(store.state().cursor, 1000, abort.signal);
  abort.abort(); await assert.rejects(aborted, error => error.name === 'AbortError');
  const closing = store.waitEvents(store.state().cursor, 1000);
  await store.close(); assert.equal((await closing).active, false);
  await assert.rejects(store.createFeed('after close'), /closed/);
});

test('input bounds reject invalid state atomically and retained cursors request resynchronization', async t => {
  const f = await fixture(t);
  await assert.rejects(f.store.seedWorks([sample('__proto__')]), /Invalid work id/);
  await f.store.seedWorks([sample()]); await f.store.updatePreferences({ autoGenerate: false });
  const original = f.store.state();
  await assert.rejects(f.store.recordEvents([
    { eventId: 'valid-before-invalid', type: 'watch', workId: 'sample-1', seconds: 2 },
    { eventId: 'invalid', type: 'watch', workId: 'sample-1', seconds: -1 }
  ]), /Invalid watch seconds/);
  assert.deepEqual(f.store.state(), original);
  assert.throws(() => normalizePreferences({ durationSeconds: 200 }), /between 8 and 120/);
  assert.throws(() => normalizePreferences({ unexpected: true }), /Unknown/);
  assert.throws(() => validateRecipe({ ...recipe('bad-color'), scenes: [{ heading: 'h', body: 'b', accent: 'url(evil)' }] }), /hex color/);
  await f.store.clearHistory();
  assert.equal((await f.store.waitEvents(0, 0)).resyncRequired, true);
  await assert.rejects(f.store.waitEvents(-1, 0), /Invalid cursor/);
  await assert.rejects(f.store.waitEvents(0, 60000), /30000/);
  await f.store.recordEvents([{ eventId: 'safe-prototype-topic', type: 'topic', topic: '__proto__' }]);
  assert.equal(Object.prototype.score, undefined);
  assert.equal(f.store.state().interest.__proto__.topic, '__proto__');
});

test('manual preferences override learned scores, exclusions filter results and planning preserves exploration', () => {
  const preferences = normalizePreferences({ topics: ['design'], excludedTopics: ['sports'] });
  const interest = { science: { topic: 'science', score: 12 }, sports: { topic: 'sports', score: 12 } };
  const works = [sample('sci', 'science'), sample('design', 'design'), sample('sports', 'sports')].map(work => ({ ...work, createdAt: 1 }));
  assert.deepEqual(rankWorks(works, preferences, interest).map(work => work.id), ['design', 'sci']);
  const jobs = planRecommendations({ preferences, interest, feed: { id: 'mixed', topic: '' }, count: 5 });
  assert.equal(jobs.length, 5);
  assert(jobs.some(job => job.topic !== 'design'), 'planning retains an exploration slot');
  assert(jobs.every(job => job.topic !== 'sports' && !job.narration));
});

test('topic replenishment stays visible on that topic after the first five even with stronger learned interests', () => {
  const preferences = normalizePreferences({ topics: ['design'] });
  const feed = { id: 'focused', topic: '鬼故事' };
  const interest = { history: { topic: '历史', score: 12 }, architecture: { topic: '建筑', score: 10 } };
  const jobs = Array.from({ length: 17 }, (_, index) => ({ feedId: feed.id, topic: feed.topic, status: 'completed', id: `old-${index}` }));
  const next = planRecommendations({ preferences, interest, feed, jobs, count: 8 });
  assert.equal(next.length, 8);
  assert(next.every(job => job.topic === feed.topic));
  assert.equal(new Set(next.map(job => job.angle)).size, 8);
  assert.deepEqual(planRecommendations({ preferences: normalizePreferences({ excludedTopics: ['鬼故事'] }), interest, feed, jobs, count: 3 }), []);
});

test('hidden legacy topic works and queued exploration do not satisfy the three upcoming slots', async t => {
  const { store } = await fixture(t);
  await store.updatePreferences({ autoGenerate: false });
  const feed = await store.createFeed('science');
  await store.seedWorks([ { ...sample('focused-current'), feedId: feed.id }, { ...sample('hidden-topic', 'history'), feedId: feed.id } ]);
  await store._mutate('legacy-fixture', data => {
    for (const job of data.jobs) { job.topic = 'history'; }
  });
  await store.recordEvents([{ eventId: 'topic-position', type: 'position', list: 'topics', feedId: feed.id, workId: 'focused-current', aheadIds: [], knownTailId: 'focused-current' }]);
  await store.updatePreferences({ autoGenerate: true });
  const state = store.state();
  assert.equal(state.buffer.aheadReady, 0);
  assert.equal(state.buffer.aheadPending, 3);
  assert.equal(state.jobs.filter(job => job.status === 'cancelled').length, 5);
  assert(state.jobs.filter(job => job.status === 'queued').every(job => job.topic === 'science'));
  assert(state.works.some(work => work.id === 'hidden-topic'), 'saved history remains intact');
});

test('damaged persisted state is reported without silently replacing user history', async t => {
  const f = await fixture(t);
  await f.store.close();
  await writeFile(join(f.directory, 'feed-state.json'), '{damaged');
  await assert.rejects(FeedStore.open(f.directory), SyntaxError);
  assert.equal(await readFile(join(f.directory, 'feed-state.json'), 'utf8'), '{damaged');
});


test('template preference persists and jobs retain the explicit scenario without changing recipe schema', async t => {
  const f = await fixture(t);
  const { listTemplates } = await import('../server/templates.mjs');
  const id = listTemplates()[1].id;
  await f.store.updatePreferences({ templateId: id, voiceMode: 'random', autoGenerate: false });
  const feed = await f.store.createFeed('科普');
  assert.ok(feed.jobs.every(job => job.templateId === id && job.explicitTemplate));
  await f.reopen();
  assert.equal(f.store.state().preferences.templateId, id);
  assert.equal(f.store.state().preferences.voiceMode, 'random');
  const before = f.store.state();
  await assert.rejects(f.store.updatePreferences({ templateId: 'missing-template' }), /not found/);
  assert.deepEqual(f.store.state(), before);
  const auto = await f.store.createFeed('户外徒步', { templateId: 'auto' });
  assert.ok(auto.jobs.every(job => job.templateId && !job.explicitTemplate));
  assert.equal(new Set(auto.jobs.map(job => job.templateId)).size, 5, 'Automatic siblings vary the content structure, including for one identical topic');
  await f.reopen();
  assert.deepEqual(f.store.state().jobs.filter(job => job.feedId === auto.id).map(job => job.templateId), auto.jobs.map(job => job.templateId), 'Assignments survive restart');
});

test('manual draft copies compose with generation paused, preserve original and do not cancel the active queue', async t => {
  const f = await fixture(t);
  const { getTemplate, listTemplates } = await import('../server/templates.mjs');
  const id = listTemplates()[0].id, input = getTemplate(id).example.recipe;
  const existing = await published(f.store, 'original');
  await f.store.updatePreferences({ autoGenerate: false });
  const before = f.store.state();
  const created = await f.store.createRecipeDraft(input, { templateId: id, topic: '模板复制', copiedFrom: existing.work.id });
  assert.equal(created.job.status, 'composing');
  assert.equal(f.store.state().activeFeedId, before.activeFeedId);
  assert.deepEqual(f.store.state().jobs.slice(0, before.jobs.length), before.jobs);
  await f.store.updateJob(created.jobId, { voice: 'native-tingting', voiceLabel: 'Tingting' });
  const copy = await f.store.publishWork(created.jobId, { id: 'template-copy', projectPath: '/tmp/template-copy.vcutweb', durationSeconds: 20, templateId: id, copiedFrom: existing.work.id, voice: 'native-tingting' });
  assert.equal(copy.templateId, id);
  assert.equal(copy.copiedFrom, existing.work.id);
  assert.deepEqual(f.store.state().works.find(work => work.id === existing.work.id), before.works[0]);
  await f.reopen();
  assert.equal(f.store.state().works.find(work => work.id === copy.id).voice, 'native-tingting');
  assert.deepEqual(getTemplate(id).example.recipe, input, 'registry content remains immutable');
});


test('independent manual copies survive a new topic and can retry after repeated composition failures', async t => {
  const { store } = await fixture(t);
  const { listTemplates, getTemplate } = await import('../server/templates.mjs');
  const template = getTemplate(listTemplates()[0].id);
  const created = await store.createRecipeDraft(template.example.recipe, { templateId: template.id });
  await store.createFeed('其他新话题');
  assert.equal(store.state().jobs.find(job => job.id === created.jobId).status, 'composing');
  await store.updateJob(created.jobId, { status: 'failed', error: '临时配音失败' });
  assert.ok((await store.retryGenerationJobs()).includes(created.jobId));
  assert.equal(store.state().jobs.find(job => job.id === created.jobId).status, 'composing');
});

test('removing a topic cancels its unfinished jobs, rejects stale recipes and preserves finished works and comments', async t => {
  const f = await fixture(t);
  const { work } = await published(f.store, 'remove-topic');
  await f.store.addComment(work.id, 'Keep this comment');
  const claimed = await f.store.claimJob('topic-worker');
  const before = f.store.state();
  await f.store.removeFeed(work.feedId);
  const after = f.store.state();
  assert.equal(after.feeds.some(feed => feed.id === work.feedId), false);
  assert.deepEqual(after.works, before.works);
  assert.equal(after.epoch, before.epoch);
  assert.ok(after.jobs.filter(job => job.feedId === work.feedId).every(job => ['completed', 'cancelled'].includes(job.status)));
  await assert.rejects(f.store.submitRecipe(claimed.job.id, claimed.claimToken, recipe('late')), /no longer active/);
  await f.reopen();
  assert.equal(f.store.state().feeds.some(feed => feed.id === work.feedId), false);
  assert.deepEqual(f.store.state().works, before.works);
});

test('restart recovery releases only owned background claims and rejects their obsolete tokens', async t => {
  const { store } = await fixture(t);
  await store.createFeed('recover');
  const own = await store.claimJob('provider-codex');
  const external = await store.claimJob('external-assistant');
  await store.recoverProviderClaims();
  assert.equal(store.state().jobs.find(job => job.id === own.job.id).status, 'queued');
  assert.equal(store.state().jobs.find(job => job.id === external.job.id).status, 'claimed');
  await assert.rejects(store.submitRecipe(own.job.id, own.claimToken, recipe('stale')), /invalid or expired/);
});


test('topic-only startup cancels mixed recommendations and feedback cannot create or personalize jobs', async t => {
  const f = await fixture(t);
  await f.store.enqueueRecommendations();
  assert.equal(f.store.state().jobs.length, 5);
  await f.store.close();
  const store = await FeedStore.open(f.directory, { topicOnly: true });
  t.after(() => store.close());
  await assert.rejects(async () => store.createFeed(''), /请输入要制作的话题/);
  assert.ok(store.state().jobs.every(job => job.status === 'cancelled'));
  await store.enqueueRecommendations();
  assert.equal(store.state().jobs.length, 5);
  const feed = await store.createFeed('physics');
  const claim = await store.claimJob('worker');
  await store.submitRecipe(claim.job.id, claim.claimToken, recipe('manual-first'));
  await store.publishWork(claim.job.id, { id: 'first-topic-only', projectPath: '/tmp/first.json', durationSeconds: 30 });
  await store.addComment('first-topic-only', '我喜欢旅行，多推荐旅行');
  await store.recordEvents([{ eventId: randomUUID(), type: 'watch', workId: 'first-topic-only', seconds: 10 }]);
  assert.deepEqual(store.state().interest, {});
  assert.ok(store.state().jobs.filter(job => job.feedId === feed.id).every(job => job.topic === 'physics'));
  assert.equal(store.state().works.length, 1, 'one work is ready while four scripts are still queued');
  await store.recordEvents([{ eventId: randomUUID(), type: 'position', workId: 'first-topic-only', list: 'topics', feedId: feed.id, aheadIds: [], knownTailId: 'first-topic-only' }]);
  assert.equal(store.state().buffer.aheadReady, 0);
  assert.equal(store.state().buffer.aheadPending, 4);
});

test('selecting an empty existing topic restores its generation target before any playback position exists', async t => {
  const { store } = await fixture(t);
  const first = await store.createFeed('physics');
  await store.createFeed('history');
  await store.selectFeed(first.id);
  assert.equal(store.state().activeFeedId, first.id);
  assert.equal(store.state().works.length, 0);
  assert.equal((await store.claimJob('worker')).job.feedId, first.id);
  await assert.rejects(store.selectFeed('missing'), /话题不存在/);
});

import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import {
  DEFAULT_PREFERENCES, normalizePreferences, validateRecipe, boundedText, plain, failure,
  topicKey, isExcluded, adjustInterest, commentIntent, planRecommendations, rankWorks
} from './recommendation.mjs';

import { getTemplate, pickTemplate, pickTemplateForPosition } from './templates.mjs';

const LEASE_MS = 45000;
const EVENT_LIMIT = 2000;
const EVENT_ID_LIMIT = 50000;
const BUFFER_LOW_WATER = 5;
const BUFFER_TARGET = 8;
const LOOK_AHEAD = 3;
const ACTIVE = new Set(['queued', 'claimed', 'composing']);
const EVENT_TYPES = new Set(['position', 'view', 'watch', 'skip', 'play', 'pause', 'complete', 'replay', 'export', 'topic']);
const JOB_STATUSES = new Set(['queued', 'claimed', 'composing', 'completed', 'failed', 'cancelled']);
const copy = value => structuredClone(value);
const initial = () => ({
  schemaVersion: 1, preferences: copy(DEFAULT_PREFERENCES), works: [], jobs: [], feeds: [], interest: {},
  cursor: 0, epoch: 0, events: [], eventIds: [], comments: [], metrics: {}, seeded: false, activeFeedId: null
});

function recipeFingerprint(recipe) {
  return createHash('sha256').update(topicKey(recipe.narration).replace(/\s+/g, '')).digest('hex');
}
function validatedWork(input, defaults = {}) {
  plain(input, 'work');
  const work = { ...defaults, ...input };
  const createdAt = typeof work.createdAt === 'string' ? Date.parse(work.createdAt) : work.createdAt ?? Date.now();
  if (!Number.isFinite(createdAt)) throw failure('Invalid createdAt');
  if (!Number.isFinite(work.durationSeconds) || work.durationSeconds <= 0 || work.durationSeconds > 180)
    throw failure('work.durationSeconds must be between 0 and 180');
  if (!['generated', 'sample'].includes(work.source)) throw failure('Invalid work.source');
  const tags = validateTags(work.tags ?? []);
  const result = {
    id: boundedText(work.id ?? randomUUID(), 'work.id', 100), feedId: boundedText(work.feedId, 'work.feedId', 100),
    topic: boundedText(work.topic, 'work.topic', 120), title: boundedText(work.title, 'work.title', 160),
    tags, createdAt, projectPath: boundedText(work.projectPath, 'projectPath', 4096),
    durationSeconds: work.durationSeconds, source: work.source, status: 'ready'
  };
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(result.id) || ['__proto__', 'constructor', 'prototype'].includes(result.id))
    throw failure('Invalid work id');
  if (work.description !== undefined) result.description = boundedText(work.description, 'description', 5000, true);
  if (work.poster !== undefined) result.poster = boundedText(work.poster, 'poster', 4096);
  if (work.posterPath !== undefined) result.posterPath = boundedText(work.posterPath, 'posterPath', 4096);
  for (const key of ['templateId', 'voice', 'voiceLabel', 'copiedFrom']) if (work[key] !== undefined) result[key] = boundedText(work[key], key, 160);
  if (work.presentationStyle !== undefined) result.presentationStyle = boundedText(work.presentationStyle, 'presentationStyle', 80);
  if (work.visualVersion !== undefined) {
    if (!Number.isSafeInteger(work.visualVersion) || work.visualVersion < 0) throw failure('Invalid visualVersion');
    result.visualVersion = work.visualVersion;
  }
  if (work.designVersion !== undefined) {
    if (!Number.isSafeInteger(work.designVersion) || work.designVersion < 0) throw failure('Invalid designVersion');
    result.designVersion = work.designVersion;
  }
  if (work.captionVersion !== undefined) {
    if (!Number.isSafeInteger(work.captionVersion) || work.captionVersion < 0) throw failure('Invalid captionVersion');
    result.captionVersion = work.captionVersion;
  }
  if (work.visualCredits !== undefined) {
    if (!Array.isArray(work.visualCredits) || work.visualCredits.length > 20) throw failure('At most 20 visual credits are allowed');
    result.visualCredits = work.visualCredits.map(credit => {
      plain(credit, 'visual credit');
      const sourceUrl = creditUrl(credit.sourceUrl, ['commons.wikimedia.org']);
      const licenseUrl = creditUrl(credit.licenseUrl, ['creativecommons.org', 'commons.wikimedia.org']);
      return { title: boundedText(credit.title, 'visual title', 300), author: boundedText(credit.author, 'visual author', 500),
        license: boundedText(credit.license, 'visual license', 120), sourceUrl, licenseUrl };
    });
  }
  return result;
}
function creditUrl(value, domains) {
  const text = boundedText(value, 'visual credit URL', 4096);
  let url; try { url = new URL(text); } catch { throw failure('Invalid visual credit URL'); }
  if (url.protocol !== 'https:' || !domains.includes(url.hostname) || url.username || url.password) throw failure('Invalid visual credit URL');
  return url.href;
}
function validateTags(tags) {
  if (!Array.isArray(tags) || tags.length > 16) throw failure('tags must contain at most 16 strings');
  return [...new Set(tags.map(tag => boundedText(tag, 'tag', 80)))];
}
function appendEvent(data, type, details = {}) {
  const event = { ...details, type, cursor: ++data.cursor, epoch: data.epoch, createdAt: Date.now() };
  data.events.push(event);
  if (data.events.length > EVENT_LIMIT) data.events.splice(0, data.events.length - EVENT_LIMIT);
  return event;
}
function attachComments(data) {
  return data.works.map(work => ({ ...work, status: 'ready', comments: data.comments.filter(comment => comment.workId === work.id) }));
}
function jobById(data, id) {
  const job = data.jobs.find(job => job.id === id);
  if (!job) throw failure('Generation job does not exist', 404);
  if (job.epoch !== data.epoch || job.status === 'cancelled') throw failure('Generation job is no longer active', 409);
  return job;
}
function activeFeed(data) { return data.feeds.find(feed => feed.id === data.activeFeedId); }
function readyCount(data, feedId) {
  return data.works.filter(work => (!feedId || work.feedId === feedId) && !data.metrics[work.id]?.seen &&
    !isExcluded(work.topic, data.preferences) && !work.tags.some(tag => isExcluded(tag, data.preferences)) &&
    !(Object.hasOwn(data.interest, topicKey(work.topic)) && data.interest[topicKey(work.topic)].suppressed)).length;
}
function aheadCount(data) {
  const window = data.playbackWindow;
  if (!window || !['topics', 'recommended', 'history'].includes(window.list) || !data.works.some(work => work.id === window.workId) || !Array.isArray(window.aheadIds) || !Number.isInteger(window.tailStart)) return null;
  if (window.list === 'history') return 0;
  const feed = data.feeds.find(item => item.id === window.feedId);
  const ids = new Set([...window.aheadIds, ...data.works.slice(window.tailStart).map(work => work.id)]);
  return data.works.filter(work => ids.has(work.id) && work.id !== window.workId &&
    (window.list !== 'topics' || (work.feedId === window.feedId && (!feed?.topic || work.topic === feed.topic))) && !isExcluded(work.topic, data.preferences) &&
    !work.tags.some(tag => isExcluded(tag, data.preferences)) && !data.interest[topicKey(work.topic)]?.suppressed).length;
}
function addPlans(data, feed, count) {
  const plans = planRecommendations({ preferences: data.preferences, interest: data.interest, feed,
    jobs: data.jobs, works: data.works, count });
  const selected = feed.templateId || data.preferences.templateId || 'auto';
  const offset = data.jobs.filter(job => job.feedId === feed.id).length;
  const jobs = plans.map((plan, index) => ({ ...plan, templateId: selected === 'auto' ? pickTemplateForPosition(plan.topic, offset + index).id : getTemplate(selected).id, explicitTemplate: selected !== 'auto', id: randomUUID(), status: 'queued', epoch: data.epoch, attempts: 0 }));
  data.jobs.push(...jobs);
  return jobs;
}
function ensureQueue(data) {
  if (!data.preferences.autoGenerate) return [];
  let feed = activeFeed(data);
  if (data.generationMode === 'topics' && !feed?.topic) return [];
  if (!feed) {
    // A fresh recommendation feed is independent of the five playable built-in examples.
    feed = { id: randomUUID(), topic: '', createdAt: Date.now(), epoch: data.epoch };
    data.feeds.push(feed);
    data.activeFeedId = feed.id;
    return addPlans(data, feed, 5);
  }
  const now = Date.now();
  const outstanding = data.jobs.filter(job => job.feedId === feed.id && job.epoch === data.epoch && ACTIVE.has(job.status) && (!feed.topic || job.topic === feed.topic));
  const pendingRetry = data.jobs.some(job => job.feedId === feed.id && job.epoch === data.epoch && job.status === 'failed' && job.retryAt > now);
  const buffer = readyCount(data, feed.topic ? feed.id : undefined) + outstanding.length;
  const ahead = aheadCount(data);
  if (data.playbackWindow?.list === 'history' || pendingRetry) return [];
  const target = data.generationMode === 'topics' ? 5 : BUFFER_TARGET;
  if (ahead === null ? buffer >= (data.generationMode === 'topics' ? 5 : BUFFER_LOW_WATER) : ahead + outstanding.length >= LOOK_AHEAD) return [];
  // A persistent provider failure must not create an unbounded stream of replacement jobs.
  const recentFailures = data.jobs.filter(job => job.feedId === feed.id && job.status === 'failed').slice(-3);
  if (recentFailures.length === 3 && recentFailures.every(job => job.attempts >= 3)) return [];
  return addPlans(data, feed, Math.max(0, ahead === null ? target - buffer : LOOK_AHEAD - ahead - outstanding.length));
}
function reclaimJobs(data, now) {
  for (const job of data.jobs) {
    if (job.epoch !== data.epoch || (job.feedId !== data.activeFeedId && !job.recipe)) continue;
    if (job.status === 'claimed' && job.leaseExpiresAt <= now) {
      job.status = job.attempts >= 3 ? 'failed' : 'queued';
      if (job.status === 'failed') { job.error = 'Generation worker lease expired repeatedly'; job.retryAt = now; }
      delete job.claimToken; delete job.workerId; delete job.leaseExpiresAt;
    } else if (job.status === 'failed' && job.attempts < 3 && job.retryAt <= now) {
      job.status = job.recipe ? 'composing' : 'queued'; delete job.retryAt;
      if (job.recipe) job.attempts++;
    }
  }
}

export class FeedStore {
  static async open(directory, { topicOnly = false } = {}) {
    boundedText(directory, 'directory', 4096);
    await mkdir(directory, { recursive: true });
    let data = initial();
    try {
      const saved = JSON.parse(await readFile(join(directory, 'feed-state.json'), 'utf8'));
      if (saved.schemaVersion !== 1 || !Array.isArray(saved.works) || !Array.isArray(saved.jobs) || !Array.isArray(saved.feeds))
        throw failure('Unsupported or damaged feed state');
      data = { ...data, ...saved, preferences: normalizePreferences(saved.preferences) };
      if (!Number.isSafeInteger(data.cursor) || !Number.isSafeInteger(data.epoch) || !Array.isArray(data.events) || !Array.isArray(data.eventIds))
        throw failure('Damaged feed event state');
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (topicOnly) {
      data.generationMode = 'topics';
      data.interest = {};
      delete data.playbackWindow;
      for (const job of data.jobs) if (ACTIVE.has(job.status)) {
        const feed = data.feeds.find(item => item.id === job.feedId);
        const explicit = Boolean(feed?.topic);
        if (!explicit) { job.status = 'cancelled'; delete job.claimToken; delete job.leaseExpiresAt; }
      }
    }
    for (const feed of data.feeds) {
      const siblings = data.jobs.filter(job => job.feedId === feed.id);
      siblings.forEach((job, position) => {
        if (!job.explicitTemplate && !job.recipe && ACTIVE.has(job.status) && job.topic)
          job.templateId = pickTemplateForPosition(job.topic, position).id;
      });
    }
    const store = new FeedStore(directory, data);
    store.topicOnly = topicOnly;
    await store._write(data);
    return store;
  }
  constructor(directory, data) {
    this.directory = directory;
    this.data = data;
    this.tail = Promise.resolve();
    this.listeners = new Set();
    this.closed = false;
    this.waiters = new Set();
  }
  state() {
    const data = this.data;
    const jobs = data.jobs.map(({ claimToken, ...job }) => job);
    const feed = activeFeed(data);
    const available = readyCount(data, feed?.topic ? feed.id : undefined);
    const outstanding = jobs.filter(job => job.feedId === feed?.id && job.epoch === data.epoch && ACTIVE.has(job.status) && (!feed?.topic || job.topic === feed.topic));
    return copy({ preferences: data.preferences, works: attachComments(data), jobs, feeds: data.feeds,
      generationMode: data.generationMode, interest: data.interest, cursor: data.cursor, epoch: data.epoch, seeded: data.seeded, activeFeedId: data.activeFeedId,
      buffer: { available, pending: outstanding.length, lowWater: BUFFER_LOW_WATER, target: BUFFER_TARGET,
        ...(aheadCount(data) !== null ? { aheadReady: aheadCount(data), aheadPending: outstanding.length, lookAhead: LOOK_AHEAD, trackingWorkId: data.playbackWindow.workId } : {}) } });
  }
  recommendedWorks() { return copy(rankWorks(attachComments(this.data), this.data.preferences, this.data.interest, this.data.metrics)); }
  recoverProviderClaims() {
    if (!this.data.jobs.some(job => job.status === 'claimed' && job.workerId?.startsWith('provider-'))) return Promise.resolve();
    return this._mutate('generation-recovered', data => {
      for (const job of data.jobs) if (job.status === 'claimed' && job.workerId?.startsWith('provider-')) {
        job.status = 'queued'; delete job.claimToken; delete job.leaseExpiresAt; delete job.workerId;
      }
    });
  }
  async _write(data) {
    const temporary = join(this.directory, `.feed-state-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(JSON.stringify(data));
      await handle.sync();
      await handle.close(); handle = null;
      await rename(temporary, join(this.directory, 'feed-state.json'));
    } finally {
      if (handle) await handle.close().catch(() => {});
      await unlink(temporary).catch(() => {});
    }
  }
  _mutate(type, operation) {
    if (this.closed) return Promise.reject(failure('Feed store is closed', 409));
    const task = this.tail.then(async () => {
      const next = copy(this.data);
      const result = await operation(next);
      await this._write(next);
      this.data = next;
      const notification = { type, cursor: next.cursor, epoch: next.epoch, state: this.state() };
      for (const listener of this.listeners) {
        try { listener(copy(notification)); } catch { /* Subscriber failures cannot roll back a persisted mutation. */ }
      }
      return copy(result);
    });
    this.tail = task.catch(() => {});
    return task;
  }
  updatePreferences(patch) {
    return this._mutate('preferences', data => {
      data.preferences = normalizePreferences(patch, data.preferences);
      if (data.preferences.templateId !== 'auto') getTemplate(data.preferences.templateId);
      if (patch.topics) adjustInterest(data.interest, data.preferences.topics, 0, 'explicit-topic');
      for (const job of data.jobs) if (ACTIVE.has(job.status) && isExcluded(job.topic, data.preferences)) {
        job.status = 'cancelled'; delete job.claimToken;
      }
      appendEvent(data, 'preferences', { preferences: data.preferences });
      ensureQueue(data);
      return data.preferences;
    });
  }
  createFeed(topic = '', options = {}) {
    plain(options, 'feed options');
    for (const key of Object.keys(options)) if (key !== 'templateId') throw failure(`Unknown feed option ${key}`);
    if (options.templateId !== undefined && options.templateId !== 'auto') getTemplate(options.templateId);
    const input = boundedText(topic, 'topic', 120, true);
    if (this.topicOnly && !input) throw failure('请输入要制作的话题');
    return this._mutate('feed', data => {
      if (input && isExcluded(input, data.preferences)) throw failure('This topic is excluded by your preferences');
      if (input && !this.topicOnly) adjustInterest(data.interest, [input], 0, 'explicit-topic');
      for (const job of data.jobs) if (ACTIVE.has(job.status) && !data.feeds.some(feed => feed.id === job.feedId && feed.source === 'template')) { job.status = 'cancelled'; delete job.claimToken; }
      const feed = { id: randomUUID(), topic: input, createdAt: Date.now(), epoch: data.epoch, ...(options.templateId ? { templateId: options.templateId } : {}) };
      delete data.playbackWindow;
      data.feeds.push(feed); data.activeFeedId = feed.id;
      const jobs = addPlans(data, feed, 5);
      if (jobs.length < 5) throw failure('No allowed recommendation topics are available');
      appendEvent(data, 'feed-created', { feedId: feed.id, topic: input });
      return { ...feed, jobs };
    });
  }
  selectFeed(id) {
    boundedText(id, 'feedId', 100);
    return this._mutate('feed-selected', data => {
      const feed = data.feeds.find(item => item.id === id && item.topic);
      if (!feed) throw failure('话题不存在', 404);
      if (isExcluded(feed.topic, data.preferences)) throw failure('This topic is excluded by your preferences');
      if (data.activeFeedId !== id) delete data.playbackWindow;
      data.activeFeedId = id;
      for (const job of data.jobs) if (job.feedId === id && job.topic !== feed.topic && job.status === 'queued' && !job.recipe) {
        job.status = 'cancelled'; delete job.claimToken;
      }
      appendEvent(data, 'feed-selected', { feedId: id });
      ensureQueue(data);
      return feed;
    });
  }
  requestMore(id, count = 3) {
    boundedText(id, 'feedId', 100);
    if (!Number.isInteger(count) || count < 1 || count > 5) throw failure('count must be between 1 and 5');
    return this._mutate('generation-requested', data => {
      const feed = data.feeds.find(item => item.id === id && item.topic);
      if (!feed) throw failure('话题不存在', 404);
      data.activeFeedId = id; delete data.playbackWindow;
      if (data.jobs.some(job => job.feedId === id && job.epoch === data.epoch && ACTIVE.has(job.status))) return [];
      const jobs = addPlans(data, feed, count);
      for (const job of jobs) job.manualRequest = true;
      appendEvent(data, 'generation-requested', { feedId: id, jobIds: jobs.map(job => job.id) });
      return jobs;
    });
  }
  createRecipeDraft(input, { templateId, topic, copiedFrom, presentationStyle } = {}) {
    const recipe = validateRecipe(input);
    const selected = templateId && templateId !== 'auto' ? getTemplate(templateId).id : pickTemplate(topic || recipe.title).id;
    const subject = boundedText(topic || recipe.title, 'topic', 120);
    if (presentationStyle !== undefined && !['cinema', 'magazine', 'collage', 'explain', 'diary', 'directed'].includes(presentationStyle)) throw failure('Invalid presentationStyle');
    if (copiedFrom !== undefined) boundedText(copiedFrom, 'copiedFrom', 100);
    return this._mutate('recipe', data => {
      if (isExcluded(subject, data.preferences)) throw failure('This topic is excluded by your preferences');
      if (copiedFrom && !data.works.some(work => work.id === copiedFrom)) throw failure('Original work no longer exists', 404);
      const feed = { id: randomUUID(), topic: subject, templateId: selected, source: 'template', createdAt: Date.now(), epoch: data.epoch };
      delete data.playbackWindow;
      const job = { id: randomUUID(), feedId: feed.id, topic: subject, templateId: selected, explicitTemplate: true, recipe,
        status: 'composing', manualRequest: true, epoch: data.epoch, attempts: 1, createdAt: Date.now(), ...(copiedFrom ? { copiedFrom } : {}), ...(presentationStyle ? { presentationStyle } : {}) };
      data.feeds.push(feed); data.jobs.push(job);
      appendEvent(data, 'recipe-submitted', { jobId: job.id, feedId: feed.id, templateId: selected });
      return { feedId: feed.id, jobId: job.id, job };
    });
  }
  removeFeed(id) {
    boundedText(id, 'feedId', 100);
    return this._mutate('feed-removed', data => {
      const feed = data.feeds.find(feed => feed.id === id);
      if (!feed?.topic) throw failure('话题不存在', 404);
      data.feeds = data.feeds.filter(feed => feed.id !== id);
      for (const job of data.jobs) if (job.feedId === id && ACTIVE.has(job.status)) {
        job.status = 'cancelled'; delete job.claimToken; delete job.leaseExpiresAt;
      }
      if (data.activeFeedId === id) data.activeFeedId = null;
      appendEvent(data, 'feed-removed', { feedId: id });
      if (data.playbackWindow?.feedId === id) delete data.playbackWindow;
      // Removing the list entry stops its pending jobs; finished works remain in history.
      ensureQueue(data);
      return { feedId: id };
    });
  }
  enqueueRecommendations() {
    return this._mutate('queue', data => {
      reclaimJobs(data, Date.now());
      const jobs = ensureQueue(data);
      if (jobs.length) appendEvent(data, 'generation-needed', { jobIds: jobs.map(job => job.id) });
      return jobs;
    });
  }
  claimJob(workerId) {
    const worker = boundedText(workerId, 'workerId', 100);
    return this._mutate('claim', data => {
      const now = Date.now(); reclaimJobs(data, now); ensureQueue(data);
      const feed = activeFeed(data);
      const explicitlyRequested = new Set(feed?.topic ? data.jobs.filter(job => job.feedId === feed.id).slice(0, 5).map(job => job.id) : []);
      const job = data.jobs.find(job => job.status === 'queued' && job.epoch === data.epoch && (job.feedId === data.activeFeedId || job.manualRequest) &&
        (data.preferences.autoGenerate || job.manualRequest || explicitlyRequested.has(job.id)));
      if (!job) return null;
      job.status = 'claimed'; job.workerId = worker; job.claimToken = randomUUID();
      job.startedAt = now; job.phase = 'script'; job.phaseStartedAt = now;
      job.leaseExpiresAt = now + LEASE_MS; job.attempts = (job.attempts || 0) + 1;
      appendEvent(data, 'job-claimed', { jobId: job.id });
      return { job, claimToken: job.claimToken };
    });
  }
  submitRecipe(jobId, claimToken, input) {
    const recipe = validateRecipe(input);
    return this._mutate('recipe', data => {
      const job = jobById(data, jobId);
      if (job.status !== 'claimed' || job.claimToken !== claimToken || job.leaseExpiresAt <= Date.now())
        throw failure('Generation claim is invalid or expired', 409);
      const fingerprint = recipeFingerprint(recipe);
      if (!job.manualRequest && data.jobs.some(other => other.id !== job.id && other.epoch === data.epoch && other.fingerprint === fingerprint && other.status !== 'cancelled'))
        throw failure('This script duplicates an existing recommendation', 409);
      job.recipe = recipe; job.fingerprint = fingerprint; job.status = 'composing';
      delete job.claimToken; delete job.leaseExpiresAt;
      appendEvent(data, 'recipe-submitted', { jobId: job.id });
      return job;
    });
  }
  updateJob(id, patch) {
    plain(patch, 'job patch');
    const allowed = ['status', 'error', 'progress', 'phase', 'leaseExpiresAt', 'voice', 'voiceLabel', 'scriptCharacters'];
    for (const key of Object.keys(patch)) if (!allowed.includes(key)) throw failure(`Cannot change job field ${key}`);
    if (patch.status !== undefined && !JOB_STATUSES.has(patch.status)) throw failure('Invalid job status');
      if (patch.status === 'completed') throw failure('Publish a work to complete a job');
    for (const key of ['voice', 'voiceLabel']) if (patch[key] !== undefined) boundedText(patch[key], key, 160);
    if (patch.error !== undefined) boundedText(patch.error, 'error', 2000, true);
    if (patch.phase !== undefined) boundedText(patch.phase, 'phase', 100, true);
    if (patch.progress !== undefined && (!Number.isFinite(patch.progress) || patch.progress < 0 || patch.progress > 1)) throw failure('Invalid job progress');
    if (patch.scriptCharacters !== undefined && (!Number.isInteger(patch.scriptCharacters) || patch.scriptCharacters < 0 || patch.scriptCharacters > 100000)) throw failure('Invalid script progress');
    if (patch.leaseExpiresAt !== undefined && !Number.isFinite(patch.leaseExpiresAt)) throw failure('Invalid lease expiry');
    return this._mutate('job', data => {
      const job = jobById(data, id);
      if (job.status === 'completed') throw failure('Completed works cannot be changed', 409);
      if (patch.phase !== undefined && job.phase !== patch.phase) job.phaseStartedAt = Date.now();
      Object.assign(job, patch);
      if (job.status === 'failed') {
        job.attempts = Math.max(1, job.attempts || 0);
        job.retryAt = Date.now() + Math.min(120000, 5000 * 2 ** (job.attempts - 1));
        delete job.claimToken;
      }
      if (job.status === 'cancelled') delete job.claimToken;
      appendEvent(data, 'job-updated', { jobId: id, status: job.status });
      return job;
    });
  }
  publishWork(jobId, input) {
    return this._mutate('work', data => {
      const job = jobById(data, jobId);
      if (job.status === 'completed') return data.works.find(work => work.id === job.workId);
      if (job.status !== 'composing' || !job.recipe) throw failure('The job has no accepted recipe to publish', 409);
      const work = validatedWork(input, { feedId: job.feedId, topic: job.topic, title: job.recipe.title, tags: job.recipe.tags, source: 'generated' });
      if (work.source !== 'generated') throw failure('Generated jobs must publish generated works');
      if (work.feedId !== job.feedId || topicKey(work.topic) !== topicKey(job.topic)) throw failure('Work does not belong to this generation job');
      if (data.works.some(other => other.id === work.id)) throw failure('Work id already exists', 409);
      if (isExcluded(work.topic, data.preferences)) throw failure('This topic has been excluded', 409);
      data.works.push(work); job.status = 'completed'; job.workId = work.id; job.progress = 1;
      appendEvent(data, 'work-published', { workId: work.id, jobId });
      return { ...work, comments: [] };
    });
  }
  retryGenerationJobs() {
    return this._mutate('retry', data => {
      const retried = [];
      for (const job of data.jobs) {
        if (job.epoch !== data.epoch || job.status !== 'failed' || (job.feedId !== data.activeFeedId && !data.feeds.some(feed => feed.id === job.feedId && feed.source === 'template'))) continue;
        job.status = job.recipe ? 'composing' : 'queued'; job.attempts = 0;
        delete job.error; delete job.retryAt; delete job.claimToken; delete job.leaseExpiresAt;
        retried.push(job.id);
      }
      if (retried.length) appendEvent(data, 'generation-retry', { jobIds: retried });
      return retried;
    });
  }
  replaceWorkComposition(workId, patch) {
    plain(patch, 'work composition patch');
    const allowed = ['projectPath', 'posterPath', 'durationSeconds', 'visualCredits', 'visualVersion', 'captionVersion', 'presentationStyle', 'templateId', 'designVersion'];
    for (const key of Object.keys(patch)) if (!allowed.includes(key)) throw failure(`Cannot change work field ${key}`);
    return this._mutate('work', data => {
      const index = data.works.findIndex(work => work.id === workId);
      if (index < 0) throw failure('Work no longer exists', 404);
      const updated = validatedWork({ ...data.works[index], ...patch });
      data.works[index] = updated;
      appendEvent(data, 'work-updated', { workId });
      return { ...updated, comments: data.comments.filter(comment => comment.workId === workId) };
    });
  }
  saveWorkDirection(workId, design) {
    return this._mutate('direction', data => {
      const job = data.jobs.find(item => item.workId === workId && item.recipe);
      if (!job || !data.works.some(work => work.id === workId)) throw failure('Work no longer exists', 404);
      job.recipe = validateRecipe({ ...job.recipe, design });
      return job.recipe;
    });
  }
  seedWorks(inputs) {
    if (!Array.isArray(inputs) || inputs.length > 50) throw failure('seedWorks accepts at most 50 works');
    return this._mutate('samples', data => {
      if (data.seeded) return [];
      const feedId = 'built-in-samples';
      const works = inputs.map(input => validatedWork(input, { feedId, source: 'sample' }));
      if (new Set(works.map(work => work.id)).size !== works.length) throw failure('Duplicate sample work id');
      for (const work of works) if (!data.works.some(existing => existing.id === work.id)) data.works.push(work);
      for (const id of new Set(works.map(work => work.feedId))) if (!data.feeds.some(feed => feed.id === id))
        data.feeds.push({ id, topic: '', createdAt: Date.now(), epoch: data.epoch, source: 'sample' });
      data.seeded = true;
      appendEvent(data, 'samples-ready', { workIds: works.map(work => work.id) });
      return works.map(work => ({ ...work, comments: [] }));
    });
  }
  recordEvents(inputs) {
    if (!Array.isArray(inputs) || inputs.length > 128) throw failure('At most 128 events may be submitted together');
    const events = inputs.map(input => {
      plain(input, 'event');
      const eventId = boundedText(input.eventId, 'eventId', 160);
      if (!EVENT_TYPES.has(input.type)) throw failure('Unknown playback event type');
      if (input.epoch !== undefined && (!Number.isSafeInteger(input.epoch) || input.epoch < 0)) throw failure('Invalid playback epoch');
      if (JSON.stringify(input).length > 8192) throw failure('Playback event is too large');
      return { ...input, eventId };
    });
    return this._mutate('events', data => {
      const seenIds = new Set(data.eventIds); const accepted = [];
      for (const input of events) {
        if (seenIds.has(input.eventId)) continue;
        if (input.epoch !== undefined && input.epoch !== data.epoch) continue;
        const work = input.workId ? data.works.find(work => work.id === input.workId) : null;
        // A page can flush a final batch concurrently with history clearing or another tab's deletion.
        if (input.type !== 'topic' && !work) continue;
        if (this.topicOnly && input.type !== 'export' && input.type !== 'position') continue;
        if (this.topicOnly && input.type === 'position' && input.list === 'recommended') continue;
        seenIds.add(input.eventId); data.eventIds.push(input.eventId);
        const safe = { eventId: input.eventId, workId: work?.id, topic: work?.topic, seconds: 0 };
        if (input.type === 'topic') {
          safe.topic = boundedText(input.topic, 'topic', 120);
          if (!isExcluded(safe.topic, data.preferences)) adjustInterest(data.interest, [safe.topic], 2, 'explicit-topic');
        } else if (input.type === 'position') {
          if (input.visible === false || input.foreground === false || !['topics', 'recommended', 'history'].includes(input.list)) continue;
          if (!Array.isArray(input.aheadIds) || input.aheadIds.length > LOOK_AHEAD || !input.aheadIds.every(id => typeof id === 'string')) throw failure('Invalid upcoming work list');
          const tail = data.works.findIndex(item => item.id === input.knownTailId);
          if (tail < 0) continue;
          let feed = activeFeed(data);
          if (input.list === 'topics') {
            feed = data.feeds.find(item => item.id === input.feedId);
            if (!feed || work.feedId !== feed.id) continue;
            // Old releases queued exploration inside topic feeds, which the topic page cannot display.
            for (const job of data.jobs) if (job.feedId === feed.id && job.topic !== feed.topic && job.status === 'queued' && !job.recipe) {
              job.status = 'cancelled'; appendEvent(data, 'job-updated', { jobId: job.id, status: 'cancelled' });
            }
          } else if (input.list === 'recommended') {
            feed = data.feeds.find(item => !item.topic && item.source !== 'sample' && item.epoch === data.epoch);
            if (!feed) { feed = { id: randomUUID(), topic: '', createdAt: Date.now(), epoch: data.epoch }; data.feeds.push(feed); }
          }
          if (input.list !== 'history') data.activeFeedId = feed.id;
          const aheadIds = [...new Set(input.aheadIds)].filter(id => id !== work.id && data.works.some(item => item.id === id && (input.list !== 'topics' || item.feedId === feed.id)));
          data.playbackWindow = { list: input.list, feedId: feed?.id, workId: work.id, aheadIds, tailStart: tail + 1, updatedAt: Date.now() };
          safe.list = input.list; safe.aheadIds = aheadIds;
        } else {
          const metric = data.metrics[work.id] ||= { seen: false, watchedSeconds: 0, coverage: [], replayCount: 0, completed: false, skipCount: 0 };
          const valid = input.failed !== true && input.buffering !== true && input.seeked !== true && input.ready !== false &&
            input.visible !== false && input.foreground !== false && input.playing !== false;
          const topics = [work.topic, ...work.tags];
          if (input.type === 'view' && input.ready !== false && input.failed !== true && input.buffering !== true &&
            input.visible !== false && input.foreground !== false) metric.seen = true;
          if (input.type === 'watch' && valid) {
            let delta = input.seconds ?? input.watchSeconds ?? input.watchedSeconds ?? input.effectiveWatchSeconds ?? 0;
            if (!Number.isFinite(delta) || delta < 0) throw failure('Invalid watch seconds');
            delta = Math.min(15, work.durationSeconds, delta);
            if (input.fromSeconds !== undefined || input.toSeconds !== undefined) {
              if (!Number.isFinite(input.fromSeconds) || !Number.isFinite(input.toSeconds) || input.fromSeconds < 0 || input.toSeconds < input.fromSeconds)
                throw failure('Invalid watch interval');
              const from = Math.min(work.durationSeconds, input.fromSeconds);
              const suppliedSeconds = input.seconds ?? input.watchSeconds ?? input.watchedSeconds ?? input.effectiveWatchSeconds;
              const to = Math.min(work.durationSeconds, input.toSeconds, from + (suppliedSeconds === undefined ? 15 : delta));
              const before = metric.coverage.reduce((sum, range) => sum + range[1] - range[0], 0);
              const ranges = [...metric.coverage, [from, to]].sort((a, b) => a[0] - b[0]);
              const merged = [];
              for (const range of ranges) {
                const previous = merged.at(-1);
                if (previous && previous[1] >= range[0]) previous[1] = Math.max(previous[1], range[1]);
                else merged.push([...range]);
              }
              if (merged.length > 1000) throw failure('Too many watch intervals');
              metric.coverage = merged;
              delta = Math.min(15, merged.reduce((sum, range) => sum + range[1] - range[0], 0) - before);
            }
            delta = Math.max(0, Math.min(delta, work.durationSeconds - metric.watchedSeconds));
            metric.watchedSeconds += delta; safe.seconds = delta;
            if (delta > 0) { metric.seen = true; adjustInterest(data.interest, topics, delta / work.durationSeconds * 2, 'watch'); }
          } else if (input.type === 'skip' && valid && metric.watchedSeconds >= 1 && metric.watchedSeconds < Math.min(3, work.durationSeconds * 0.2) && !metric.skipCount) {
            metric.skipCount++; adjustInterest(data.interest, topics, -1, 'early-skip');
          } else if (input.type === 'complete' && valid && !metric.completed && metric.watchedSeconds >= work.durationSeconds * 0.8) {
            metric.completed = true; adjustInterest(data.interest, topics, 1, 'complete');
          } else if (input.type === 'replay' && valid && metric.watchedSeconds >= 2 && metric.replayCount < 3) {
            metric.replayCount++; adjustInterest(data.interest, topics, 0.5, 'replay');
          } else if (input.type === 'export' && !metric.exported) {
            metric.exported = true; adjustInterest(data.interest, topics, 2, 'export');
          }
        }
        accepted.push(appendEvent(data, input.type, safe));
      }
      if (data.eventIds.length > EVENT_ID_LIMIT) data.eventIds.splice(0, data.eventIds.length - EVENT_ID_LIMIT);
      const jobs = ensureQueue(data);
      if (jobs.length) appendEvent(data, 'generation-needed', { jobIds: jobs.map(job => job.id) });
      return { accepted: accepted.length, events: accepted, cursor: data.cursor };
    });
  }
  addComment(workId, value) {
    const text = boundedText(value, 'comment', 2000);
    return this._mutate('comment', data => {
      const work = data.works.find(work => work.id === workId);
      if (!work) throw failure('Comment work does not exist', 404);
      const intent = this.topicOnly ? 'neutral' : commentIntent(text);
      const comment = { id: randomUUID(), workId, text, intent, createdAt: Date.now() };
      data.comments.push(comment);
      const deltas = { exclude: -5, 'request-more': 3, positive: 2, correction: 0, neutral: 0 };
      if (deltas[intent]) adjustInterest(data.interest, [work.topic, ...work.tags], deltas[intent], intent);
      if (intent === 'exclude') for (const job of data.jobs) {
        if (ACTIVE.has(job.status) && topicKey(job.topic) === topicKey(work.topic)) { job.status = 'cancelled'; delete job.claimToken; }
      }
      appendEvent(data, 'comment', { workId, comment });
      ensureQueue(data);
      return comment;
    });
  }
  clearHistory() {
    return this._mutate('clear', data => {
      data.epoch++;
      data.works = []; data.comments = []; data.metrics = {}; data.interest = {}; data.eventIds = [];
      // Keep bounded id/epoch tombstones for stale claim rejection, erase recipes and topic history.
      data.jobs = data.jobs.slice(-200).map(job => ({ id: job.id, epoch: job.epoch, status: 'cancelled' }));
      data.feeds = []; data.activeFeedId = null; data.events = []; delete data.playbackWindow;
      // Keep manual preferences and the seeded flag. Clearing never re-adds built-in history.
      appendEvent(data, 'history-cleared');
      return { epoch: data.epoch, cursor: data.cursor };
    });
  }
  subscribe(listener) {
    if (typeof listener !== 'function') throw failure('listener must be a function');
    if (this.closed) throw failure('Feed store is closed', 409);
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  _eventResult(cursor, timedOut = false) {
    const data = this.data;
    const oldest = data.events[0]?.cursor ?? data.cursor + 1;
    return copy({ events: data.events.filter(event => event.cursor > cursor), nextCursor: data.cursor,
      timedOut, resyncRequired: cursor > data.cursor || cursor < oldest - 1,
      active: !this.closed && data.preferences.autoGenerate, readyCount: readyCount(data), epoch: data.epoch });
  }
  waitEvents(cursor, timeoutMs = 15000, signal) {
    if (!Number.isSafeInteger(cursor) || cursor < 0) return Promise.reject(failure('Invalid cursor'));
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 30000) return Promise.reject(failure('timeoutMs must be between 0 and 30000'));
    if (signal?.aborted) return Promise.reject(signal.reason || new DOMException('Aborted', 'AbortError'));
    if (this.closed) return Promise.resolve(this._eventResult(cursor));
    const immediate = this._eventResult(cursor);
    if (immediate.events.length || immediate.resyncRequired || !timeoutMs) return Promise.resolve(immediate);
    return new Promise((resolve, reject) => {
      let timer; let done = false;
      const finish = (value, error) => {
        if (done) return; done = true;
        clearTimeout(timer); this.listeners.delete(changed); this.waiters.delete(closed);
        signal?.removeEventListener('abort', aborted);
        if (error) reject(error); else resolve(value);
      };
      const changed = () => { if (this.data.cursor > cursor) finish(this._eventResult(cursor)); };
      const closed = () => finish(this._eventResult(cursor));
      const aborted = () => finish(null, signal.reason || new DOMException('Aborted', 'AbortError'));
      this.listeners.add(changed); this.waiters.add(closed);
      signal?.addEventListener('abort', aborted, { once: true });
      timer = setTimeout(() => finish(this._eventResult(cursor, true)), timeoutMs);
      changed();
    });
  }
  async close() {
    if (this.closed) return;
    this.closed = true;
    await this.tail;
    for (const closeWaiter of this.waiters) closeWaiter();
    this.waiters.clear(); this.listeners.clear();
  }
}

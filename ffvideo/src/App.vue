<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  reactive,
  ref,
  shallowRef,
  watch
} from 'vue';
import type { Snapshot } from '../../packages/client/index.mjs';
import type { TtsCatalog, TtsInstallStatus } from '../../packages/client/types';
import Player from './Player.vue';
import Icon from './Icon.vue';
import TemplateLibrary from './TemplateLibrary.vue';
import ExportDialog from './ExportDialog.vue';
import { api, client, feedRuntime, runtimeStatus } from './runtime';
import { watchInterval, hasServerRestarted, PlaybackRecoveryGate, playbackSeekSeconds } from './feed-state.mjs';
import { generationMessage as describeGeneration } from './generation-status.mjs';

type WorkComment = { id: string; text: string; createdAt: string | number; author?: string };
type Work = {
  id: string;
  feedId?: string;
  title: string;
  description?: string;
  topic: string;
  tags?: string[];
  durationSeconds: number;
  createdAt: string | number;
  source: string;
  comments?: WorkComment[];
  posterUrl?: string;
  posterPath?: string;
  visualVersion?: number;
  captionVersion?: number;
  visualCredits?: { title: string; author: string; license: string; sourceUrl: string; licenseUrl: string }[];
};
type Preferences = {
  topics: string[];
  excludedTopics: string[];
  language: string;
  voice: string;
  voiceMode: 'random' | 'fixed';
  templateId: string;
  visualPreference: 'video-first' | 'photo-first' | 'auto' | 'illustration';
  durationSeconds: number;
  style: string;
  durationMode: 'auto' | 'fixed';
  reasoningMode: 'none' | 'fast' | 'standard';
  generationModel: string;
  autoGenerate: boolean;
  autoplay: boolean;
  format: 'mp4' | 'webm';
};
type FeedState = {
  instanceId?: string;
  works: Work[];
  jobs: any[];
  feeds: any[];
  preferences: Preferences;
  epoch?: number;
  cursor?: number;
  generation?: {
    mode: string;
    connected: boolean;
    speechBackend?: string;
    lastError?: string;
    supportedModes?: string[];
    status?: string;
    phase?: string;
    elapsedSeconds?: number;
    title?: string;
    model?: string;
    effort?: string;
    minimumEffort?: string;
    blocked?: boolean;
    available?: number;
    pending?: number;
    queued?: number;
    target?: number;
    aheadReady?: number;
    aheadPending?: number;
    lookAhead?: number;
    trackingWorkId?: string;
    preparingVisuals?: boolean;
    visualWorkTitle?: string;
  };
};
const emptyPreferences: Preferences = {
  topics: [],
  excludedTopics: [],
  language: 'zh',
  voice: 'zf_001',
  voiceMode: 'random',
  visualPreference: 'video-first',
  templateId: 'auto',
  durationSeconds: 25,
  durationMode: 'auto',
  reasoningMode: 'fast',
  generationModel: '',
  style: 'cards',
  autoGenerate: true,
  autoplay: true,
  format: 'mp4'
};
const state = shallowRef<FeedState>({
  works: [],
  jobs: [],
  feeds: [],
  preferences: emptyPreferences
});
const tab = ref<'topics' | 'history'>('topics');
let lastPositionSignature = '';
const topic = ref('');
const activeFeedId = ref('');
const removingTopic = ref(false);
const activeId = ref('');
const snapshot = shallowRef<Snapshot>();
const playing = ref(false);
const seeking = ref(false);
const muted = ref(false);
const time = ref(0);
const buffering = ref(true);
const frameReady = ref(false);
const pageVisible = ref(document.visibilityState === 'visible');
const windowFocused = ref(document.hasFocus());
const hasInteracted = ref(navigator.userActivation?.hasBeenActive || false);
const feedElement = ref<HTMLElement>();
const player = ref<InstanceType<typeof Player>>();
const detailId = ref('');
const settingsOpen = ref(false);
const templatesOpen = ref(false);
const reuseWorkId = ref('');
const systemVoices = shallowRef<{ voices: { id: string; name: string; language: string; recommended?: boolean }[] }>();
const clearConfirm = ref(false);
const submitting = ref(false);
const loading = ref(true);
const error = ref('');
const toast = ref('');
const commentText = ref('');
const sendingComment = ref(false);
const exportingId = ref('');
const exportDialogOpen = ref(false);
const exportError = ref('');
const exportProjectId = ref('');
const exportReceipt = ref<{ path: string; filename: string; downloadUrl: string; revealUrl?: string }>();
const settingsSaving = ref(false);
const draft = reactive({ ...emptyPreferences, topicsText: '', excludedTopicsText: '' });
const catalog = shallowRef<TtsCatalog>();
const installation = shallowRef<TtsInstallStatus>();
const installing = ref(false);
const modelError = ref('');
const generatorSaving = ref(false);
const visitedTimes = new Map<string, number>();
const viewed = new Set<string>();
let timer: ReturnType<typeof setInterval> | undefined,
  watchTimer: ReturnType<typeof setInterval> | undefined;
let stateSource: EventSource | undefined;
let refreshAgain = false;
let toastTimer: ReturnType<typeof setTimeout> | undefined,
  scrollFrame = 0,
  pollBusy = false,
  disposed = false;
let loadSequence = 0,
  preservedScroll = 0,
  listUrl = location.pathname + location.search,
  beforeHiddenPlaying = false;
let lastWatchTime = 0,
  lastWatchWall = performance.now();
const activeVisibleRatio = ref(1);
let queuedEvents: any[] = [],
  sendingEvents = false;
let removeSnapshotListener = () => {};
const playbackRecoveryGate = new PlaybackRecoveryGate();
let playbackRecovery: Promise<void> | undefined;
let seekPointerId: number | undefined;

const preferences = computed(() => ({ ...emptyPreferences, ...state.value.preferences }));
const works = computed(() => {
  const all = state.value.works || [];
  let list: Work[];
  if (tab.value === 'topics') {
    const selectedTopic = state.value.feeds?.find((feed) => feed.id === activeFeedId.value)?.topic;
    list = activeFeedId.value
      ? all.filter((work) => work.feedId === activeFeedId.value && (!selectedTopic || work.topic === selectedTopic))
      : all;
  } else {
    list = all.slice().sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  }
  // A direct work link can open a saved draft outside the current topic.
  const linked = detailId.value && all.find((work) => work.id === detailId.value);
  if (linked && !list.some((work) => work.id === linked.id)) return [...list, linked];
  return list;
});
const activeWork = computed(() => state.value.works.find((work) => work.id === activeId.value));
const comments = computed(() => activeWork.value?.comments || []);
const activeIndex = computed(() => works.value.findIndex((work) => work.id === activeId.value));
const jobs = computed(() =>
  (state.value.jobs || []).filter((job) =>
    [
      'queued',
      'claimed',
      'composing',
      'pending',
      'planning',
      'running',
      'generating',
      'synthesizing',
      'tts',
      'awaiting-agent',
      'waiting-agent'
    ].includes(job.state || job.status) && (tab.value !== 'topics' || job.feedId === activeFeedId.value)
  )
);
const feedTopics = computed(() => (state.value.feeds || []).filter(feed => feed.topic).slice().reverse());
const actualPlaying = computed(
  () =>
    playing.value &&
    pageVisible.value &&
    windowFocused.value &&
    !settingsOpen.value &&
    !templatesOpen.value &&
    !clearConfirm.value &&
    !exportDialogOpen.value &&
    !!snapshot.value &&
    activeVisibleRatio.value >= 0.55
);
const percent = computed(() =>
  activeWork.value?.durationSeconds
    ? Math.min(100, (time.value / activeWork.value.durationSeconds) * 100)
    : 0
);
const exportProgress = computed(() =>
  exportProjectId.value ? runtimeStatus.exports[exportProjectId.value] : undefined
);
const modelReady = computed(
  () =>
    catalog.value?.installedDtypes.includes('fp32') &&
    (catalog.value.installedVoices?.includes(draft.voice) ||
      catalog.value.voices.some((voice) => voice.id === draft.voice && voice.installed))
);
const generationLabel = computed(() =>
  state.value.generation?.mode === 'codex' ? '本机 Codex 自动制作' : '由 AI 助手制作'
);
const generationMessage = computed(() => describeGeneration({ service: state.value.generation, jobs: jobs.value,
  selectedJobs: state.value.jobs.filter(job => job.feedId === activeFeedId.value), completed: works.value.length, autoGenerate: preferences.value.autoGenerate }));
const canResumeGeneration = computed(() => jobs.value.length > 0 && (state.value.generation?.mode === 'agent' || state.value.generation?.blocked));
const canRetryGeneration = computed(() => state.value.jobs.some(job => job.feedId === activeFeedId.value && job.status === 'failed'));
const nativeSpeech = computed(() => state.value.generation?.speechBackend === 'native');
const suggestions = ['宇宙里最奇妙的事', '让人惊叹的建筑', '每天学一点电影', '人工智能的新点子'];

function notify(message: string) {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ''), 4500);
}
function showError(value: unknown) {
  error.value = value instanceof Error ? value.message : String(value);
}
function clock(value: number) {
  const seconds = Math.max(0, Math.floor(value || 0));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}
function age(value: string | number) {
  const date = new Date(value);
  return Number.isFinite(date.getTime())
    ? date.toLocaleDateString('zh-CN', { month: 'short', day: 'numeric' })
    : '刚刚';
}
function palette(index: number) {
  return ['violet', 'aqua', 'coral', 'blue', 'lime'][index % 5];
}
function enqueueEvent(type: string, workId = activeId.value, extra: Record<string, unknown> = {}) {
  if (type !== 'export' && type !== 'position') return;
  if (!workId) return;
  queuedEvents.push({
    eventId: crypto.randomUUID(),
    type,
    workId,
    epoch: state.value.epoch,
    ...extra
  });
  if (queuedEvents.length >= 8) void flushEvents();
}
function reportPosition() {
  if (disposed || !activeId.value || !pageVisible.value || settingsOpen.value || templatesOpen.value || detailId.value) return;
  const index = works.value.findIndex(work => work.id === activeId.value);
  if (index < 0) return;
  const extra = { list: tab.value, feedId: activeFeedId.value, aheadIds: works.value.slice(index + 1, index + 4).map(work => work.id), knownTailId: state.value.works.at(-1)?.id, visible: true, foreground: true };
  const signature = JSON.stringify([state.value.epoch, activeId.value, preferences.value.autoGenerate, extra]);
  if (signature === lastPositionSignature) return;
  lastPositionSignature = signature;
  enqueueEvent('position', activeId.value, extra); void flushEvents();
}
async function flushEvents() {
  if (sendingEvents || !queuedEvents.length) return;
  sendingEvents = true;
  const batch = queuedEvents.splice(0, 32);
  try {
    await api('/events', { method: 'POST', body: JSON.stringify({ events: batch }) });
  } catch (error) {
    const valid = batch.filter(
      (event) =>
        (event.epoch === undefined || event.epoch === state.value.epoch) &&
        ((error as { status?: number })?.status !== 404 ||
          state.value.works.some((work) => work.id === event.workId))
    );
    queuedEvents.unshift(...valid);
    if (queuedEvents.length > 128) queuedEvents.splice(0, queuedEvents.length - 128);
  } finally {
    sendingEvents = false;
  }
}
function reportWatch() {
  const now = performance.now();
  const elapsed = Math.max(0, (now - lastWatchWall) / 1000);
  const interval = watchInterval({
    fromSeconds: lastWatchTime,
    toSeconds: time.value,
    wallSeconds: elapsed,
    durationSeconds: activeWork.value?.durationSeconds || 0,
    foreground: pageVisible.value && windowFocused.value,
    visible: activeVisibleRatio.value >= 0.55,
    playing: actualPlaying.value,
    ready: frameReady.value,
    buffering: buffering.value,
    seeking: seeking.value
  });
  if (activeId.value && interval) enqueueEvent('watch', activeId.value, interval);
  lastWatchTime = time.value;
  lastWatchWall = now;
  void flushEvents();
}
async function selectFirstWork() {
  await nextTick();
  if (feedElement.value) feedElement.value.scrollTop = 0;
  if (works.value.length) await selectWork(works.value[0].id);
}
async function applyState(value: FeedState) {
  if (disposed) return;
    const restarted = hasServerRestarted(state.value.instanceId, value.instanceId);
    const oldActive = state.value.works.find(work => work.id === activeId.value);
    if (state.value.instanceId === value.instanceId && (value.cursor || 0) < (state.value.cursor || 0)) return;
    state.value = value;
    const newActive = value.works.find(work => work.id === activeId.value);
    const updatedActive = !!oldActive && !!newActive && (oldActive.visualVersion !== newActive.visualVersion || oldActive.captionVersion !== newActive.captionVersion);
    if (!activeFeedId.value)
      activeFeedId.value =
        value.feeds
          .slice()
          .reverse()
          .find((feed) => feed.topic)?.id || '';
    if (restarted) {
      await reconnectPlayback();
      if (!activeId.value && works.value.length) await selectFirstWork();
    }
    else if (updatedActive) await selectWork(activeId.value, true);
    else if (!activeId.value && works.value.length) await selectFirstWork();
    else if (
      activeId.value &&
      !works.value.some((work) => work.id === activeId.value) &&
      !detailId.value
    ) {
      playing.value = false;
      snapshot.value = undefined;
      activeId.value = '';
      detailId.value = '';
      if (works.value.length) await selectFirstWork();
    }
  reportPosition();
 }
async function refreshState() {
  if (disposed) return;
  if (pollBusy) { refreshAgain = true; return; }
  pollBusy = true;
  try {
    const value = await api<FeedState>('/state');
    if (disposed) return;
    await applyState(value);
    if (installation.value?.state === 'downloading') {
      installation.value = await client.ttsModelStatus();
      if (installation.value.state === 'ready') {
        catalog.value = await client.listTtsVoices();
        notify('本地配音模型已准备好');
      }
    }
    } catch (value) {
    if (loading.value) showError(value);
  } finally {
    pollBusy = false;
    loading.value = false;
    if (refreshAgain && !disposed) { refreshAgain = false; void refreshState(); }
  }
}
async function selectWork(id: string, refreshComposition = false, restoredPlayback?: { time: number; playing: boolean }) {
  if (seeking.value && !refreshComposition) return;
  if (seeking.value) endSeek();
  if (activeId.value === id && !refreshComposition) return;
  const wasPlaying = restoredPlayback?.playing ?? playing.value;
  reportWatch();
  if (activeId.value) {
    visitedTimes.set(activeId.value, restoredPlayback?.time ?? time.value);
    if (!refreshComposition && time.value < (activeWork.value?.durationSeconds || 0) * 0.85)
      enqueueEvent('skip', activeId.value, { seconds: time.value });
  }
  const sequence = ++loadSequence;
  activeId.value = id;
  reportPosition();
  snapshot.value = undefined;
  time.value = visitedTimes.get(id) || 0;
  lastWatchTime = time.value;
  lastWatchWall = performance.now();
  buffering.value = true;
  frameReady.value = false;
  playing.value = false;
  error.value = '';
  exportReceipt.value = undefined;
  feedRuntime.deactivate();
  try {
    const value = await api<Snapshot>(`/works/${encodeURIComponent(id)}/session`);
    if (sequence !== loadSequence || disposed) return;
    await feedRuntime.activate(value);
    if (sequence !== loadSequence || disposed) return;
    snapshot.value = value;
    playing.value = refreshComposition ? wasPlaying : preferences.value.autoplay && pageVisible.value && hasInteracted.value;
  } catch (value) {
    if (sequence === loadSequence) {
      buffering.value = false;
      showError(value);
    }
  }
}
function onScroll() {
  if (detailId.value || seeking.value || scrollFrame) return;
  scrollFrame = requestAnimationFrame(() => {
    scrollFrame = 0;
    const container = feedElement.value;
    if (!container) return;
    const bounds = container.getBoundingClientRect(),
      center = bounds.top + bounds.height / 2;
    let closest: HTMLElement | undefined,
      distance = Infinity;
    for (const element of container.querySelectorAll<HTMLElement>('[data-work-id]')) {
      const rect = element.getBoundingClientRect();
      const nextDistance = Math.abs(rect.top + rect.height / 2 - center);
      if (nextDistance < distance) {
        closest = element;
        distance = nextDistance;
      }
    }
    if (closest) {
      const rect = closest.getBoundingClientRect();
      activeVisibleRatio.value = Math.min(
        1,
        Math.max(0, Math.min(rect.bottom, bounds.bottom) - Math.max(rect.top, bounds.top)) /
          rect.height
      );
      const id = closest.dataset.workId!;
      if (id !== activeId.value) void selectWork(id);
    }
  });
}
async function switchTab(value: typeof tab.value) {
  reportWatch();
  if (seeking.value) endSeek();
  if (activeId.value) visitedTimes.set(activeId.value, time.value);
  if (scrollFrame) { cancelAnimationFrame(scrollFrame); scrollFrame = 0; }
  if (detailId.value) history.replaceState(null, '', listUrl);
  detailId.value = '';
  commentText.value = '';
  playing.value = false;
  snapshot.value = undefined;
  activeId.value = '';
  loadSequence++;
  feedRuntime.deactivate();
  tab.value = value;
  await nextTick();
  if (feedElement.value) feedElement.value.scrollTop = 0;
  if (works.value.length) await selectWork(works.value[0].id);
}
function step(direction: number) {
  if (seeking.value) return;
  const next =
    works.value[Math.max(0, Math.min(works.value.length - 1, activeIndex.value + direction))];
  if (!next || detailId.value) return;
  feedElement.value
    ?.querySelector<HTMLElement>(`[data-work-id="${next.id}"]`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
}
function togglePlay() {
  if (!snapshot.value || seeking.value) return;
  reportWatch();
  error.value = '';
  if (!playing.value && time.value >= (activeWork.value?.durationSeconds || 0) - 0.05) {
    player.value?.seek(0);
    time.value = 0;
    lastWatchTime = 0;
    enqueueEvent('replay');
  }
  playing.value = !playing.value;
  lastWatchWall = performance.now();
  lastWatchTime = time.value;
}
function ended() {
  if (seeking.value) return;
  reportWatch();
  playing.value = false;
  enqueueEvent('complete', activeId.value, { seconds: time.value });
  void flushEvents();
}
function beginSeek(event?: PointerEvent) {
  if (!snapshot.value || seeking.value) return;
  reportWatch();
  seeking.value = true;
  if (scrollFrame) { cancelAnimationFrame(scrollFrame); scrollFrame = 0; }
  if (event) {
    seekPointerId = event.pointerId;
    (event.currentTarget as HTMLInputElement).setPointerCapture(event.pointerId);
  }
  lastWatchTime = time.value; lastWatchWall = performance.now();
}
function seekInput(event: Event) {
  if (!snapshot.value) return;
  const target = playbackSeekSeconds(Number((event.currentTarget as HTMLInputElement).value), activeWork.value?.durationSeconds || 0);
  if (target === null) return;
  if (!seeking.value) reportWatch();
  player.value?.seek(target);
  time.value = target;
  visitedTimes.set(activeId.value, target);
  lastWatchTime = target; lastWatchWall = performance.now();
}
function endSeek(event?: PointerEvent) {
  if (event && seekPointerId !== undefined && event.pointerId !== seekPointerId) return;
  seeking.value = false; seekPointerId = undefined;
  lastWatchTime = time.value; lastWatchWall = performance.now();
  visitedTimes.set(activeId.value, time.value);
}
function seekKeyDown(event: KeyboardEvent) {
  if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key)) beginSeek();
}
function framePresented() {
  frameReady.value = true;
  if (
    !viewed.has(activeId.value) &&
    pageVisible.value &&
    windowFocused.value &&
    activeVisibleRatio.value >= 0.55
  ) {
    viewed.add(activeId.value);
    enqueueEvent('view', activeId.value, { ready: true, visible: true, foreground: true });
  }
}
function playbackError(message: string) {
  reportWatch();
  playing.value = false;
  buffering.value = false;
  showError(message);
}
async function reconnectPlayback() {
  if (playbackRecovery) return playbackRecovery;
  const workId = activeId.value;
  const restored = { time: time.value, playing: playing.value };
  reportWatch();
  const sequence = ++loadSequence;
  snapshot.value = undefined; buffering.value = true; frameReady.value = false; playing.value = false;
  const operation = (async () => {
    try {
      await feedRuntime.reconnect();
      if (disposed || sequence !== loadSequence) return;
      error.value = '';
      if (workId && state.value.works.some(work => work.id === workId)) await selectWork(workId, true, restored);
    } catch (value) { if (!disposed && sequence === loadSequence) { buffering.value = false; showError(value); } }
  })();
  playbackRecovery = operation;
  try { await operation; } finally { if (playbackRecovery === operation) playbackRecovery = undefined; }
}
async function recoverPlayback(message: string) {
  if (playbackRecovery) return;
  if (!playbackRecoveryGate.claim(state.value.instanceId, activeId.value, message)) return playbackError(message);
  await reconnectPlayback();
}
function openDetail(work: Work) {
  reportWatch();
  preservedScroll = feedElement.value?.scrollTop || 0;
  detailId.value = work.id;
  if (work.id !== activeId.value) void selectWork(work.id);
  listUrl = location.pathname + location.search;
  history.pushState(
    { ffvideoDetail: true },
    '',
    `${location.pathname}?work=${encodeURIComponent(work.id)}`
  );
  activeVisibleRatio.value = 1;
}
async function restoreList() {
  detailId.value = '';
  commentText.value = '';
  await nextTick();
  if (feedElement.value) feedElement.value.scrollTop = preservedScroll;
}
function closeDetail() {
  if (history.state?.ffvideoDetail) history.back();
  else {
    history.replaceState(null, '', listUrl);
    void restoreList();
  }
}
function popstate() {
  if (detailId.value) void restoreList();
}
function bindPlayer(value: unknown) {
  player.value = value ? (value as InstanceType<typeof Player>) : undefined;
}
async function generateTopic(value = topic.value, templateId = preferences.value.templateId) {
  const content = value.trim();
  if (!content || submitting.value) return;
  submitting.value = true;
  error.value = '';
  reportWatch();
  try {
    const result = await api<any>('/topics', {
      method: 'POST',
      body: JSON.stringify({ topic: content, templateId })
    });
    activeFeedId.value = result.feedId || '';
    topic.value = '';
    if (result.works) state.value = result;
    await switchTab('topics');
    history.replaceState(null, '', `/feed/${encodeURIComponent(activeFeedId.value)}`);
    listUrl = location.pathname;
    notify('已提交话题，首批将制作 5 条带声音的草稿');
  } catch (value) {
    showError(value);
  } finally {
    submitting.value = false;
  }
}
function openTemplates(workId = '') { reportWatch(); reuseWorkId.value = workId; templatesOpen.value = true; }
async function selectTemplate(id: string) {
  await api('/preferences', { method: 'POST', body: JSON.stringify({ templateId: id }) });
  await refreshState(); templatesOpen.value = false; notify('生成模板已保存');
}
async function generateFromTemplate(value: string, id: string) { templatesOpen.value = false; await generateTopic(value, id); }
async function templateCreated(result: { feedId: string; jobId: string }) {
  templatesOpen.value = false; activeFeedId.value = result.feedId; await refreshState(); await switchTab('topics');
  notify('已复制，画面和配音完成后即可播放');
}
async function chooseTopic(feed: any) {
  const id = feed.id || feed.feedId;
  if (tab.value === 'topics' && activeFeedId.value === id && activeId.value) return;
  activeFeedId.value = id;
  await switchTab('topics');
  try {
    const value = await api<FeedState>(`/topics/${encodeURIComponent(id)}/select`, { method: 'POST', body: '{}' });
    if (activeFeedId.value !== id || tab.value !== 'topics') return;
    await applyState(value);
    history.replaceState(null, '', `/feed/${encodeURIComponent(id)}`);
    listUrl = location.pathname;
  } catch (value) { showError(value); }
}
async function removeTopic() {
  if (!activeFeedId.value || removingTopic.value) return;
  removingTopic.value = true; reportWatch();
  try {
    const result = await api<FeedState>('/topics/' + encodeURIComponent(activeFeedId.value), { method: 'DELETE' });
    state.value = result;
    activeFeedId.value = feedTopics.value[0]?.id || '';
    await switchTab(activeFeedId.value ? 'topics' : 'history');
    notify('话题已移除，已有作品保留在历史');
  } catch (value) { showError(value); } finally { removingTopic.value = false; }
}
async function retryGeneration() {
  if (generatorSaving.value) return;
  generatorSaving.value = true;
  try { await api('/generation/retry', { method: 'POST' }); await refreshState(); notify('已重新开始制作'); }
  catch (value) { showError(value); } finally { generatorSaving.value = false; }
}
async function sendComment() {
  const text = commentText.value.trim();
  if (!text || !activeId.value || sendingComment.value) return;
  sendingComment.value = true;
  try {
    await api('/comments', {
      method: 'POST',
      body: JSON.stringify({ workId: activeId.value, text })
    });
    commentText.value = '';
    await refreshState();
    notify('评论已保存');
  } catch (value) {
    showError(value);
  } finally {
    sendingComment.value = false;
  }
}
async function revealExport() {
  if (!exportReceipt.value?.revealUrl) return;
  try { await api(exportReceipt.value.revealUrl, { method: 'POST', body: '{}' }); }
  catch (cause) { exportError.value = cause instanceof Error ? cause.message : String(cause); }
}
async function exportWork() {
  if (exportingId.value) { exportDialogOpen.value = true; return; }
  if (!activeId.value) return;
  const workId = activeId.value;
  reportWatch();
  playing.value = false;
  exportingId.value = workId;
  exportProjectId.value = snapshot.value?.id || '';
  if (exportProjectId.value) delete runtimeStatus.exports[exportProjectId.value];
  exportError.value = '';
  exportDialogOpen.value = true;
  error.value = '';
  exportReceipt.value = undefined;
  try {
    await feedRuntime.refresh();
    const result = await api<{ path: string; filename: string; downloadUrl: string; revealUrl?: string }>(
      `/works/${encodeURIComponent(workId)}/export`,
      { method: 'POST', body: JSON.stringify({ format: preferences.value.format }) }
    );
    exportReceipt.value = result;
    enqueueEvent('export', exportingId.value);
  } catch (value) {
    exportError.value = value instanceof Error ? value.message : String(value);
  } finally {
    exportingId.value = '';
  }
}
async function openSettings() {
  reportWatch();
  Object.assign(draft, preferences.value, {
    topicsText: preferences.value.topics.join('，'),
    excludedTopicsText: preferences.value.excludedTopics.join('，')
  });
  settingsOpen.value = true;
  void api<any>('/voices').then(value => { systemVoices.value = value; }).catch(() => {});
  modelError.value = '';
  try {
    if (!nativeSpeech.value) {
      catalog.value = await client.listTtsVoices();
      installation.value = await client.ttsModelStatus();
    }
  } catch (value) {
    modelError.value = value instanceof Error ? value.message : String(value);
  }
}
const splitTopics = (value: string) =>
  value
    .split(/[,，\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .slice(0, 20);
async function saveSettings() {
  if (settingsSaving.value) return;
  settingsSaving.value = true;
  try {
    const patch = {
      topics: splitTopics(draft.topicsText),
      excludedTopics: splitTopics(draft.excludedTopicsText),
      language: draft.language,
      voice: draft.voice,
      voiceMode: draft.voiceMode,
      templateId: draft.templateId,
      visualPreference: draft.visualPreference,
      durationSeconds: Number(draft.durationSeconds),
      durationMode: draft.durationMode,
      reasoningMode: draft.reasoningMode,
      generationModel: draft.generationModel.trim(),
      autoGenerate: draft.autoGenerate,
      autoplay: draft.autoplay,
      format: draft.format
    };
    await api('/preferences', { method: 'POST', body: JSON.stringify(patch) });
    await refreshState();
    settingsOpen.value = false;
    notify('偏好已保存在本机');
  } catch (value) {
    showError(value);
  } finally {
    settingsSaving.value = false;
  }
}
async function installModel() {
  if (installing.value || installation.value?.state === 'downloading') return;
  installing.value = true;
  modelError.value = '';
  try {
    installation.value = await client.installTtsModel({ dtype: 'fp32', voices: [draft.voice] });
  } catch (value) {
    modelError.value = value instanceof Error ? value.message : String(value);
  } finally {
    installing.value = false;
  }
}
async function changeGenerator(mode: string) {
  generatorSaving.value = true;
  try {
    await api('/generator', { method: 'POST', body: JSON.stringify({ mode }) });
    await refreshState();
    notify(mode === 'codex' ? '已启用本机 Codex 后台制作' : '已切换为 AI 助手制作');
  } catch (value) {
    showError(value);
  } finally {
    generatorSaving.value = false;
  }
}
async function resumeGeneration() {
  if (generatorSaving.value) return;
  generatorSaving.value = true;
  try {
    await api('/generator', { method: 'POST', body: JSON.stringify({ mode: state.value.generation?.mode === 'command' ? 'command' : 'codex' }) });
    await refreshState();
  } catch (value) { showError(value); } finally { generatorSaving.value = false; }
}
async function generateMore() {
  if (!activeFeedId.value || generatorSaving.value || jobs.value.length) return;
  generatorSaving.value = true;
  try { await api(`/topics/${encodeURIComponent(activeFeedId.value)}/more`, { method: 'POST', body: '{}' }); await refreshState(); }
  catch (value) { showError(value); } finally { generatorSaving.value = false; }
}
async function clearHistory() {
  reportWatch();
  playing.value = false;
  snapshot.value = undefined;
  activeId.value = '';
  detailId.value = '';
  loadSequence++;
  queuedEvents = [];
  feedRuntime.deactivate();
  try {
    await api('/history', { method: 'DELETE' });
    visitedTimes.clear();
    viewed.clear();
    await refreshState();
    clearConfirm.value = false;
    notify('草稿、评论与观看记录已清空');
  } catch (value) {
    showError(value);
  }
}
function requestClear() {
  reportWatch();
  clearConfirm.value = true;
}
function visibility() {
  reportWatch();
  if (document.visibilityState !== 'visible') {
    beforeHiddenPlaying = playing.value;
    playing.value = false;
    pageVisible.value = false;
  } else {
    pageVisible.value = true;
    if (beforeHiddenPlaying && preferences.value.autoplay) playing.value = true;
    lastWatchWall = performance.now();
    lastWatchTime = time.value;
  }
}
function userInteracted() {
  hasInteracted.value = true;
}
function focusChanged() {
  reportWatch();
  windowFocused.value = document.hasFocus();
  lastWatchTime = time.value;
  lastWatchWall = performance.now();
}
function keyboard(event: KeyboardEvent) {
  if (exportDialogOpen.value) {
    if (event.key === 'Escape') exportDialogOpen.value = false;
    return;
  }
  if ((event.target as HTMLElement)?.closest('input,textarea,select,button,a,[contenteditable]'))
    return;
  if (settingsOpen.value || templatesOpen.value || clearConfirm.value) {
    if (event.key === 'Escape') {
      settingsOpen.value = false;
      templatesOpen.value = false;
      clearConfirm.value = false;
    }
    return;
  }
  if (event.key === ' ' && snapshot.value) {
    event.preventDefault();
    togglePlay();
  } else if (event.key === 'ArrowDown') {
    event.preventDefault();
    step(1);
  } else if (event.key === 'ArrowUp') {
    event.preventDefault();
    step(-1);
  } else if (event.key === 'Escape' && detailId.value) closeDetail();
}
watch([() => draft.voiceMode, () => draft.language, systemVoices], () => {
  if (draft.voiceMode === 'fixed' && systemVoices.value) {
    const options = systemVoices.value.voices.filter(voice => voice.language === draft.language).sort((a, b) => Number(b.recommended !== false) - Number(a.recommended !== false));
    if (!options.some(voice => voice.id === draft.voice) && options.length) draft.voice = options[0].id;
  }
});
watch(error, async () => {
  const id = activeId.value;
  await nextTick();
  const index = works.value.findIndex(work => work.id === id);
  if (index >= 0 && feedElement.value && !detailId.value) feedElement.value.scrollTop = index * feedElement.value.clientHeight;
});
watch(playing, () => {
  lastWatchTime = time.value;
  lastWatchWall = performance.now();
});
onMounted(async () => {
  const requestedFeed = /^\/feed\/([^/]+)$/.exec(location.pathname)?.[1];
  if (requestedFeed) { activeFeedId.value = decodeURIComponent(requestedFeed); tab.value = 'topics'; }
  removeSnapshotListener = feedRuntime.onSnapshot((value) => {
    if (snapshot.value?.id === value.id && value.version > snapshot.value.version)
      snapshot.value = value;
  });
  try {
    await feedRuntime.start();
  } catch (value) {
    showError(value);
  }
  await refreshState();
  const requested =
    new URLSearchParams(location.search).get('work') ||
    /^\/watch\/([^/]+)$/.exec(location.pathname)?.[1];
  if (activeFeedId.value && state.value.feeds.some(feed => feed.id === activeFeedId.value)) {
    const id = activeFeedId.value;
    try { await api(`/topics/${encodeURIComponent(id)}/select`, { method: 'POST', body: '{}' }); } catch (value) { showError(value); }
  } else if (requestedFeed) await switchTab('history');
  if (requested && state.value.works.some((work) => work.id === requested)) {
    await selectWork(requested);
    detailId.value = requested;
  }
  timer = setInterval(() => void refreshState(), 2000);
  stateSource = new EventSource('/ffapi/events');
  stateSource.addEventListener('state', event => {
    try { void applyState(JSON.parse((event as MessageEvent).data)); } catch { void refreshState(); }
  });
  watchTimer = setInterval(reportWatch, 4000);
  document.addEventListener('visibilitychange', visibility);
  document.addEventListener('pointerdown', userInteracted, true);
  document.addEventListener('keydown', userInteracted, true);
  window.addEventListener('focus', focusChanged);
  window.addEventListener('blur', focusChanged);
  window.addEventListener('keydown', keyboard);
  window.addEventListener('popstate', popstate);
});
onBeforeUnmount(() => {
  reportWatch();
  disposed = true;
  stateSource?.close();
  clearInterval(timer);
  clearInterval(watchTimer);
  clearTimeout(toastTimer);
  cancelAnimationFrame(scrollFrame);
  removeSnapshotListener();
  feedRuntime.dispose();
  document.removeEventListener('visibilitychange', visibility);
  document.removeEventListener('pointerdown', userInteracted, true);
  document.removeEventListener('keydown', userInteracted, true);
  window.removeEventListener('focus', focusChanged);
  window.removeEventListener('blur', focusChanged);
  window.removeEventListener('keydown', keyboard);
  window.removeEventListener('popstate', popstate);
});
</script>

<template>
  <main class="app-shell" :class="{ 'detail-mode': !!detailId }">
    <section class="main-column">
      <header class="topbar">
        <a class="brand" href="/" aria-label="ffvideo 首页"><Icon name="play" :size="17" /><span>ff<span class="brand-light">video</span></span></a>
        <div class="topbar-actions"><button class="icon-button" aria-label="草稿模板" @click="openTemplates()"><Icon name="folder" :size="20" /></button><button class="icon-button" aria-label="偏好设置" @click="openSettings">
          <Icon name="settings" />
        </button></div>
      </header>
      <form v-if="!detailId" class="topic-input" @submit.prevent="generateTopic()">
        <input
          v-model="topic"
          placeholder="输入话题，生成视频"
          maxlength="120"
          aria-label="输入感兴趣的话题"
        /><button type="submit" :disabled="!topic.trim() || submitting">
          <span>{{ submitting ? '准备中' : '生成' }}</span>
        </button>
      </form>
      <div v-if="!detailId" class="feed-toolbar">
        <div class="feed-tabs" role="tablist" aria-label="作品列表">
          <button
            role="tab"
            :aria-selected="tab === 'topics'"
            :class="{ selected: tab === 'topics' }"
            @click="switchTab('topics')"
          >
            话题</button
          ><button
            role="tab"
            :aria-selected="tab === 'history'"
            :class="{ selected: tab === 'history' }"
            @click="switchTab('history')"
          >
            历史
          </button>
        </div>
        <button
          v-if="tab === 'history' && state.works.length"
          class="text-button"
          @click="requestClear"
        >
          <Icon name="trash" :size="15" />清空历史</button
        ><div v-else-if="tab === 'topics' && feedTopics.length" class="topic-actions">
          <select class="topic-picker" aria-label="切换历史话题" :value="activeFeedId" @change="chooseTopic({ id: ($event.target as HTMLSelectElement).value })">
            <option v-for="feed in feedTopics" :key="feed.id" :value="feed.id">{{ feed.topic }}</option>
          </select>
          <button class="icon-button remove-topic" aria-label="移除当前话题" title="移除话题，已有作品保留在历史" :disabled="removingTopic" @click="removeTopic"><Icon name="trash" :size="14" /></button>
        </div><span v-else class="scroll-hint">{{ works.length }} 条</span>
      </div>
      <div v-else class="detail-toolbar">
        <button class="text-button" @click="closeDetail">
          <Icon name="back" :size="19" />返回列表</button
        ><span>{{ comments.length }} 条评论</span>
      </div>

      <section v-if="!detailId && tab !== 'history'" class="feed-generation-status" role="status" aria-live="polite">
        <i :class="{ working: state.generation?.status === 'working' || state.generation?.preparingVisuals }" />
        <strong :title="generationMessage.detail">{{ generationMessage.title }}</strong>
        <button v-if="canRetryGeneration && state.generation?.mode !== 'agent' && !state.generation?.blocked" class="text-button" aria-label="重新尝试制作" :disabled="generatorSaving" @click="retryGeneration">重试</button>
        <button v-if="canResumeGeneration" class="secondary-button" aria-label="连接制作服务" :disabled="generatorSaving" @click="resumeGeneration">
          {{ generatorSaving ? '开启中' : state.generation?.mode === 'agent' ? '启用 Codex' : '重连' }}
        </button>
        <button v-else-if="!preferences.autoGenerate && activeFeedId && !jobs.length" class="text-button" aria-label="继续生成当前话题" :disabled="generatorSaving" @click="generateMore">继续生成</button>
        <p v-if="generationMessage.error" class="feed-generation-error">{{ generationMessage.error }}</p>
      </section>

      <div class="content-grid">
        <section class="feed-stage">
          <div
            ref="feedElement"
            class="feed-scroll"
            :class="{ 'is-seeking': seeking }"
            aria-label="视频列表"
            @scroll.passive="onScroll"
          >
            <article
              v-for="(work, index) in works"
              :key="work.id"
              :data-work-id="work.id"
              class="feed-item"
              :class="{ 'is-active': activeId === work.id }"
            >
              <div class="video-card" :class="palette(index)">
                <button
                  class="video-click-surface"
                  :aria-label="playing && activeId === work.id ? '暂停视频' : '播放视频'"
                  @click="activeId === work.id ? togglePlay() : selectWork(work.id)"
                >
                  <Player
                    v-if="activeId === work.id && snapshot"
                    :key="snapshot.id"
                    :ref="bindPlayer"
                    :snapshot="snapshot"
                    :playing="actualPlaying"
                    :muted="muted"
                    :initial-time="visitedTimes.get(work.id) || 0"
                    @time="time = $event"
                    @ended="ended"
                    @ready="framePresented"
                    @buffering="buffering = $event"
                    @error="playbackError"
                    @recover="recoverPlayback"
                  />
                  <div v-else class="poster-surface">
                    <img
                      v-if="work.posterUrl || work.posterPath"
                      :src="work.posterUrl || `/ffapi/works/${encodeURIComponent(work.id)}/poster`"
                      alt=""
                    />
                    <div v-else class="poster-art">
                      <span class="poster-orbit orbit-one" /><span
                        class="poster-orbit orbit-two"
                      /><span class="poster-orbit orbit-three" /><Icon name="play" :size="44" />
                    </div>
                  </div>
                </button>
                <div class="video-topline">
                  <span class="video-count"
                    >{{ String(index + 1).padStart(2, '0') }} <b>/</b>
                    {{ String(works.length).padStart(2, '0') }}</span
                  >
                </div>
                <button
                  v-if="activeId === work.id && !playing && frameReady"
                  class="center-play"
                  aria-label="播放视频"
                  @click="togglePlay"
                >
                  <Icon name="play" :size="30" />
                </button>
                <div class="video-shade" />
                <div class="video-caption">
                  <h2>{{ work.title }}</h2>
                </div>
                <div class="video-controls">
                  <button
                    :aria-label="playing && activeId === work.id ? '暂停' : '播放'"
                    @click="togglePlay"
                  >
                    <Icon
                      :name="playing && activeId === work.id ? 'pause' : 'play'"
                      :size="19"
                    /></button
                  ><span
                    >{{ clock(activeId === work.id ? time : 0) }} <b>/</b>
                    {{ clock(work.durationSeconds) }}</span
                  >
                  <div class="control-spacer" />
                  <button :aria-label="muted ? '开启声音' : '静音'" @click="muted = !muted">
                    <Icon :name="muted ? 'mute' : 'sound'" :size="19" /></button
                  ><button aria-label="复制并修改作品" @click="openTemplates(work.id)"><Icon name="folder" :size="18" /></button><button aria-label="打开作品详情和评论" @click="openDetail(work)">
                    <Icon name="comment" :size="19" />
                  </button><button :aria-label="exportingId === work.id ? '视频导出中' : '导出视频'" :disabled="activeId !== work.id" @click="exportWork">
                    <Icon name="export" :size="19" />
                  </button>
                </div>
                <div class="video-progress" @click.stop @pointerdown.stop @pointermove.stop @pointerup.stop>
                  <input
                    type="range"
                    min="0"
                    :max="work.durationSeconds"
                    step="0.1"
                    :value="activeId === work.id ? time : 0"
                    :style="{ '--progress': `${activeId === work.id ? percent : 0}%` }"
                    :disabled="activeId !== work.id || !snapshot"
                    aria-label="播放进度"
                    :aria-valuetext="`${clock(activeId === work.id ? time : 0)} / ${clock(work.durationSeconds)}`"
                    @pointerdown.stop="beginSeek"
                    @input="seekInput"
                    @pointerup.stop="endSeek"
                    @pointercancel.stop="endSeek"
                    @lostpointercapture="endSeek"
                    @keydown.stop="seekKeyDown"
                    @keyup.stop="endSeek()"
                    @blur="endSeek()"
                    @click.stop
                  />
                </div>
              </div>
            </article>
            <div v-if="!works.length" class="empty-feed">
              <span class="empty-icon"><Icon name="spark" :size="32" /></span
              >
              <h2>
                {{
                  loading
                    ? '正在打开你的作品空间'
                    : jobs.length
                      ? '你的新作品正在准备中'
                      : '还没有草稿'
                }}
              </h2>
              <p>
                {{
                  jobs.length
                    ? (state.feeds.find(feed => feed.id === activeFeedId)?.source === 'template' ? '画面和配音完成后即可播放。' : '首批 5 条草稿会陆续出现在这里。完成画面和配音后，即可播放。')
                    : '输入一个喜欢的话题，让 AI 把它变成可播放、有声音的视频草稿。'
                }}
              </p>
              <div class="suggestions">
                <button
                  v-for="suggestion in suggestions"
                  :key="suggestion"
                  @click="generateTopic(suggestion)"
                >
                  {{ suggestion }}<Icon name="arrow" :size="15" />
                </button>
              </div>
            </div>
          </div>
          <div v-if="error" class="error-banner" role="alert">
            <span>{{ error }}</span
            ><button aria-label="关闭提示" @click="error = ''">
              <Icon name="close" :size="16" />
            </button>
          </div>
        </section>

        <aside v-if="detailId" class="discussion-panel">
          <div class="discussion-heading">
            <h2>
              {{ activeWork?.title }}
            </h2>
            <p v-if="activeWork?.description">{{ activeWork.description }}</p>
          </div>
          <details v-if="activeWork?.visualCredits?.length" class="visual-credits">
            <summary>画面来源与许可 · {{ activeWork.visualCredits.length }}</summary>
            <ul><li v-for="(credit, index) in activeWork.visualCredits" :key="`${credit.sourceUrl}-${index}`">
              <a :href="credit.sourceUrl" target="_blank" rel="noopener noreferrer">{{ credit.title }}</a>
              <span>作者：{{ credit.author }}</span>
              <a :href="credit.licenseUrl" target="_blank" rel="noopener noreferrer">{{ credit.license }}</a>
            </li></ul>
          </details>
          <div class="comments-list">
            <div v-for="comment in comments" :key="comment.id" class="comment">
              <span class="avatar">你</span>
              <div>
                <div class="comment-meta">
                  <strong>{{ comment.author || '你' }}</strong
                  ><span>{{ age(comment.createdAt) }}</span>
                </div>
                <p>{{ comment.text }}</p>
              </div>
            </div>
            <div v-if="!comments.length" class="comments-empty">
              <Icon name="comment" :size="28" />
              <p>还没有评论</p>
              <span>你想继续了解什么？<br />哪一点最吸引你？</span>
            </div>
          </div>
          <form class="comment-composer" @submit.prevent="sendComment">
            <label for="comment">留下想法，或告诉 AI 下一条想看什么</label
            ><textarea
              id="comment"
              v-model="commentText"
              maxlength="2000"
              placeholder="我更想了解…"
              rows="3"
            /><button type="submit" :disabled="!commentText.trim() || sendingComment">
              {{ sendingComment ? '正在保存' : '发表评论' }}<Icon name="arrow" :size="17" />
            </button>
          </form>
        </aside>

      </div>
    </section>
    <Transition name="toast"
      ><div v-if="toast" class="toast-message" role="status">
        <Icon name="check" :size="17" />{{ toast }}
      </div></Transition
    >

    <ExportDialog v-if="exportDialogOpen" :busy="!!exportingId" :progress="exportProgress" :receipt="exportReceipt" :error="exportError" @close="exportDialogOpen = false" @reveal="revealExport" />
    <TemplateLibrary v-if="templatesOpen" :selected-id="preferences.templateId" :work-id="reuseWorkId || undefined" @close="templatesOpen = false" @select="selectTemplate" @generate="generateFromTemplate" @created="templateCreated" />
    <div v-if="settingsOpen" class="modal-backdrop" @click.self="settingsOpen = false">
      <section
        class="settings-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="settings-heading"
      >
        <div class="modal-heading">
          <div>
            <h2 id="settings-heading">你的观看偏好</h2>
          </div>
          <button class="icon-button" aria-label="关闭设置" @click="settingsOpen = false">
            <Icon name="close" />
          </button>
        </div>
        <form @submit.prevent="saveSettings">
          <div class="settings-body">
            <div class="fields-row">
              <label class="field-label"
                >语言<select v-model="draft.language">
                  <option value="zh">中文</option>
                  <option value="en">English</option>
                </select></label
              ><label class="field-label"
                >草稿时长<select v-model="draft.durationMode" aria-label="草稿时长模式">
                  <option value="auto">自动 · 按内容安排</option>
                  <option value="fixed">指定目标时长</option>
                </select><select v-if="draft.durationMode === 'fixed'" v-model="draft.durationSeconds" aria-label="目标时长">
                  <option :value="15">15 秒</option>
                  <option :value="25">25 秒</option>
                  <option :value="30">30 秒</option>
                  <option :value="45">45 秒</option>
                  <option :value="60">60 秒</option>
                </select></label
              >
            </div>
            <div class="fields-row">
              <label class="field-label"
                >声音<select v-model="draft.voiceMode" aria-label="音色模式"><option value="random">随机音色 · 每条轮换</option><option value="fixed">固定音色</option></select>
                <select v-if="draft.voiceMode === 'fixed'" v-model="draft.voice" aria-label="固定配音音色">
                  <template v-if="systemVoices"><option v-for="voice in systemVoices.voices.filter(voice => voice.language === draft.language)" :key="voice.id" :value="voice.id">{{ voice.name }}</option></template>
                  <template v-else-if="catalog"><option v-for="voice in catalog.voices" :key="voice.id" :value="voice.id">{{ voice.name }}</option></template><option v-else value="zf_001">中文女声</option>
                </select></label
              ><label class="field-label"
                >导出格式<select v-model="draft.format">
                  <option value="mp4">MP4</option>
                  <option value="webm">WebM</option>
                </select></label
              >
            </div>
            <div class="switch-row">
              <label class="field-label">画面<select v-model="draft.visualPreference" aria-label="画面偏好"><option value="video-first">真实视频优先</option><option value="photo-first">真实图片优先</option><option value="auto">随作品风格</option><option value="illustration">插画与动画</option></select></label>
            </div>
            <div class="switch-row">
              <span><strong>自动播放下一条</strong><small>切换作品后直接开始播放</small></span
              ><label class="switch"
                ><input v-model="draft.autoplay" type="checkbox" aria-label="自动播放" /><i
              /></label>
            </div>
            <div class="model-card">
              <strong>{{ generationLabel }} · {{ generationMessage.title }}</strong>
              <p>{{ generationMessage.detail }}</p>
              <p v-if="state.generation?.lastError" class="field-error">{{ state.generation.lastError }}</p>
              <p>作品、评论、观看记录和偏好保存在本机。实际画面素材的来源与许可可在评论详情查看。</p>
            </div>
            <div class="switch-row">
              <span><strong>话题自动补充</strong><small>只制作当前话题，准备播放位置后面 3 条</small></span>
              <label class="switch"><input v-model="draft.autoGenerate" type="checkbox" aria-label="话题自动补充" /><i /></label>
            </div>
            <div v-if="nativeSpeech" class="model-card">
              <strong>macOS 系统配音</strong>
              <p>
                配音在本机完成。中文随机轮换婷婷和美佳，语速适中并统一响度；其他风格音色可固定选择。
              </p>
            </div>
            <div v-else class="model-card">
              <div>
                <strong>{{ modelReady ? '本地配音已就绪' : '安装本地语音模型' }}</strong>
                <p>使用 Kokoro 生成配音。首次安装需下载约 340 MB 模型，后续在本机运行。</p>
              </div>
              <button
                type="button"
                class="secondary-button"
                :disabled="installing || installation?.state === 'downloading' || modelReady"
                @click="installModel"
              >
                {{
                  installation?.state === 'downloading'
                    ? `下载中 ${Math.round((installation.progress || 0) * 100)}%`
                    : modelReady
                      ? '已安装'
                      : '安装模型和音色'
                }}
              </button>
              <p v-if="modelError || installation?.error" class="field-error">
                {{ modelError || installation?.error }}
              </p>
            </div>
            <div
              v-if="state.generation?.supportedModes?.includes('codex')"
              class="model-card generator-options"
            >
              <strong>视频内容制作方式</strong>
              <p>
                AI 助手模式由当前助手制作；本机 Codex 模式会持续调用已安装的
                Codex，完成你提交的话题任务，并使用你的模型额度。
              </p>
              <select
                :value="state.generation.mode"
                :disabled="generatorSaving"
                aria-label="内容制作方式"
                @change="changeGenerator(($event.target as HTMLSelectElement).value)"
              >
                <option value="agent">AI 助手制作</option>
                <option value="codex">本机 Codex 后台制作</option>
              </select>
              <label v-if="state.generation.mode === 'codex'" class="field-label">视频制作模型
                <input v-model="draft.generationModel" aria-label="视频制作模型" placeholder="留空使用后台默认模型" maxlength="80" />
              </label>
              <label v-if="state.generation.mode === 'codex'" class="field-label">思考强度
                <select v-model="draft.reasoningMode" aria-label="视频生成思考强度">
                  <option value="none">关闭 · 需模型支持</option>
                  <option value="fast">最低 · 优先速度</option>
                  <option value="standard">标准 · 模型默认</option>
                </select>
              </label>
              <p v-if="state.generation.mode === 'codex' && state.generation.model">
                {{ state.generation.model }} · 实际 {{ state.generation.effort || '模型默认' }} · 保存后下一条生效
                <template v-if="state.generation.effort !== 'none' && state.generation.minimumEffort && !['none', 'minimal'].includes(state.generation.minimumEffort)">；当前模型不能完全关闭思考。</template>
              </p>
            </div>
            <button type="button" class="danger-link" @click="requestClear">
              <Icon name="trash" :size="15" />清空全部草稿与观看历史
            </button>
          </div>
          <div class="modal-footer">
            <span><Icon name="folder" :size="14" />偏好保存在本机</span
            ><button type="submit" class="primary-button" :disabled="settingsSaving">
              {{ settingsSaving ? '正在保存' : '保存偏好' }}<Icon name="check" :size="16" />
            </button>
          </div>
        </form>
      </section>
    </div>
    <div
      v-if="clearConfirm"
      class="modal-backdrop confirm-backdrop"
      @click.self="clearConfirm = false"
    >
      <section
        class="confirm-modal"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="clear-heading"
      >
        <span class="empty-icon"><Icon name="trash" :size="27" /></span>
        <h2 id="clear-heading">清空这个作品空间？</h2>
        <p>将删除全部草稿、评论和观看记录。<br />你的偏好设置会保留。</p>
        <div>
          <button class="secondary-button" @click="clearConfirm = false">保留作品</button
          ><button class="danger-button" @click="clearHistory">清空历史</button>
        </div>
      </section>
    </div>
  </main>
</template>

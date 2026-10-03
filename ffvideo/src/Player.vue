<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, toRaw, watch } from 'vue';
import type { Snapshot } from '../../packages/client/index.mjs';
import { duration, ticks, seconds, type Project } from '../../packages/core/project.mjs';
import { previewExtent, previewSampleTime } from '../../packages/render/plan.mjs';
import { PreviewAudioPlayer, sharedMediaEngine } from '../../packages/media/browser';
import { client } from './runtime';
import { isPlaybackAuthenticationError, playbackSeekSeconds } from './feed-state.mjs';

const props = defineProps<{
  snapshot: Snapshot;
  playing: boolean;
  muted: boolean;
  initialTime?: number;
}>();
const emit = defineEmits<{
  time: [seconds: number];
  ended: [];
  error: [message: string];
  recover: [message: string];
  ready: [];
  buffering: [value: boolean];
}>();
const stage = ref<HTMLElement>();
const canvas = ref<HTMLCanvasElement>();
const message = ref('正在准备播放…');
let worker: Worker | undefined,
  observer: ResizeObserver | undefined,
  animation = 0;
let ready = false,
  running = false,
  pending = false,
  disposed = false,
  generation = 0,
  sequence = 0;
let lastProject: Project | undefined;
let recoveryRequested = false;
let audioSequence = 0;
let audioStarted = false;
let time = ticks(props.initialTime || 0),
  lastEmitted = -Infinity;
const total = computed(() => duration(props.snapshot.project));
const mediaUrl = (id: string) => {
  const asset = props.snapshot.project.assets.find((entry) => entry.id === id);
  const url = new URL(client.mediaUrl(props.snapshot.id, id));
  url.searchParams.set(
    'source',
    asset?.sourceIdentity ||
      JSON.stringify([asset?.id, asset?.path, asset?.size, asset?.fingerprint])
  );
  return url.href;
};
const audioProject = () =>
  props.muted
    ? {
        ...toRaw(props.snapshot.project),
        timeline: {
          ...toRaw(props.snapshot.project.timeline),
          tracks: props.snapshot.project.timeline.tracks.map((track) => ({
            ...toRaw(track),
            muted: true
          }))
        }
      }
    : toRaw(props.snapshot.project);
function fail(error: unknown) {
  if (disposed || (error instanceof Error && error.name === 'AbortError')) return;
  const text = error instanceof Error ? error.message : String(error);
  if (isPlaybackAuthenticationError(error)) {
    if (recoveryRequested) return;
    recoveryRequested = true;
    audio.stop();
    message.value = text;
    emit('buffering', true);
    emit('recover', text);
    return;
  }
  message.value = text;
  emit('error', text);
}
const audio = new PreviewAudioPlayer(sharedMediaEngine, mediaUrl, fail);
function invalidate() {
  generation++;
  worker?.postMessage({ type: 'invalidate', generation });
}
function request() {
  pending = true;
  if (ready && !running) send();
}
function send() {
  if (!worker || !stage.value || disposed || recoveryRequested) return;
  running = true;
  pending = false;
  const project = toRaw(props.snapshot.project);
  const rect = stage.value.getBoundingClientRect();
  const size = previewExtent(project.canvas, rect.width, rect.height, devicePixelRatio || 1);
  const changed = lastProject !== project;
  worker.postMessage({
    type: 'render',
    id: ++sequence,
    generation,
    ...(changed
      ? {
          project,
          documentRevision: sequence,
          urls: Object.fromEntries(project.assets.map((asset) => [asset.id, mediaUrl(asset.id)]))
        }
      : {}),
    time: previewSampleTime(time, project.frameRate, props.playing),
    prefetch: props.playing,
    ...size
  });
  lastProject = project;
}
async function startAudio() {
  const requestId = ++audioSequence;
  audioStarted = true;
  emit('buffering', true);
  try {
    await audio.play(audioProject(), time);
    if (!disposed && requestId === audioSequence) emit('buffering', false);
  } catch (error) {
    if (requestId === audioSequence) fail(error);
  }
}
watch(
  () => props.playing,
  (playing) => {
    if (playing) {
      if (time >= total.value) time = 0;
      void startAudio();
    } else {
      if (audioStarted) time = Math.min(total.value, audio.currentTimeTicks());
      audioSequence++;
      audio.stop();
      audioStarted = false;
      emit('buffering', false);
      invalidate();
      request();
      emit('time', seconds(time));
    }
  }
);
watch(
  () => props.muted,
  () => {
    if (props.playing) void startAudio();
  }
);
watch(
  () => `${props.snapshot.id}:${props.snapshot.version}`,
  () => {
    if (props.playing && audioStarted) time = Math.min(total.value, audio.currentTimeTicks());
    invalidate();
    request();
    if (props.playing) void startAudio();
  }
);
function tick(now: number) {
  if (disposed) return;
  if (props.playing) {
    time = Math.min(total.value, audio.currentTimeTicks());
    request();
    if (time >= total.value) {
      emit('time', seconds(time));
      audio.stop();
      emit('ended');
    }
  }
  if (now - lastEmitted > 100) {
    emit('time', seconds(time));
    lastEmitted = now;
  }
  animation = requestAnimationFrame(tick);
}
onMounted(() => {
  if (!canvas.value?.transferControlToOffscreen) {
    fail(new Error('当前浏览器不支持实时画面，请使用新版 Chrome、Edge 或 Safari。'));
    return;
  }
  worker = new Worker(new URL('../../packages/render/worker.ts', import.meta.url), {
    type: 'module',
    name: 'ffvideo-player'
  });
  worker.onmessage = ({ data }) => {
    if (disposed || recoveryRequested) return;
    if (data.type === 'ready') {
      ready = true;
      request();
    } else if (data.type === 'frame') {
      running = false;
      if (data.generation === generation) {
        message.value = '';
        emit('ready');
      }
      if (pending) send();
    } else if (data.type === 'resync') {
      running = false;
      lastProject = undefined;
      invalidate();
      request();
    } else if (data.type === 'cancelled') {
      running = false;
      if (pending) send();
    } else if (data.type === 'error') {
      running = false;
      fail(new Error(data.error));
    }
  };
  worker.onerror = (event) => fail(new Error(event.message || '播放工作线程失败'));
  const offscreen = canvas.value.transferControlToOffscreen();
  worker.postMessage(
    { type: 'init', canvas: offscreen, urls: {}, options: { textWorkers: true } },
    [offscreen]
  );
  observer = new ResizeObserver(request);
  observer.observe(stage.value!);
  animation = requestAnimationFrame(tick);
  if (props.playing) void startAudio();
});
onBeforeUnmount(() => {
  disposed = true;
  cancelAnimationFrame(animation);
  observer?.disconnect();
  audio.stop();
  void audio.dispose();
  worker?.postMessage({ type: 'dispose' });
  worker?.terminate();
});
defineExpose({
  seek: (value: number) => {
    const target = playbackSeekSeconds(value, seconds(total.value));
    if (target === null || disposed) return;
    time = ticks(target);
    invalidate();
    request();
    if (props.playing) void startAudio();
    else { audioSequence++; audio.stop(); emit('buffering', false); }
    emit('time', seconds(time));
  }
});
</script>
<template>
  <div
    ref="stage"
    class="player-surface"
    :style="{ aspectRatio: `${snapshot.project.canvas.width}/${snapshot.project.canvas.height}` }"
    aria-label="草稿视频播放画面"
  >
    <canvas ref="canvas" aria-label="视频画面" />
    <div v-if="message" class="player-message" role="status">
      <span class="loading-orbit" />{{ message }}
    </div>
  </div>
</template>

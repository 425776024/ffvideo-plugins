<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import Icon from './Icon.vue';

const props = defineProps<{
  busy: boolean;
  progress?: { completed?: number; total?: number };
  receipt?: { filename: string; downloadUrl: string; revealUrl?: string };
  error?: string;
}>();
const emit = defineEmits<{ close: []; reveal: [] }>();
const dialog = ref<HTMLElement>();
const closeButton = ref<HTMLButtonElement>();
const previousFocus = document.activeElement;
const percent = computed(() => props.progress?.total
  ? Math.min(100, Math.max(0, Math.round(100 * (props.progress.completed || 0) / props.progress.total!)))
  : undefined);
const heading = computed(() => props.busy ? '正在导出视频' : props.receipt ? '视频已导出' : '导出失败');
function keyboard(event: KeyboardEvent) {
  event.stopPropagation();
  if (event.key === 'Escape') { event.preventDefault(); emit('close'); }
  if (event.key !== 'Tab') return;
  const controls = Array.from(dialog.value?.querySelectorAll<HTMLElement>('button:not(:disabled),a[href]') || []);
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}
onMounted(() => closeButton.value?.focus());
onBeforeUnmount(() => { if (previousFocus instanceof HTMLElement && previousFocus.isConnected) previousFocus.focus(); });
</script>

<template>
  <div class="modal-backdrop export-backdrop" @keydown="keyboard">
    <section ref="dialog" class="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-heading" :aria-busy="busy">
      <header class="modal-heading">
        <h2 id="export-heading">{{ heading }}</h2>
        <button ref="closeButton" class="icon-button" aria-label="关闭导出对话框" @click="emit('close')"><Icon name="close" /></button>
      </header>
      <div class="export-body" aria-live="polite">
        <template v-if="busy">
          <p class="export-state"><span class="loading-orbit" />{{ percent === undefined ? '正在准备渲染…' : `正在渲染视频 ${percent}%` }}</p>
          <progress aria-label="视频导出进度" :value="percent" max="100" />
          <p class="export-note">关闭对话框后，导出会继续。</p>
        </template>
        <template v-else-if="receipt">
          <p class="export-state"><Icon name="check" :size="20" />视频已保存到本机</p>
          <p class="export-filename">{{ receipt.filename }}</p>
        </template>
        <p v-if="error" class="field-error" role="alert">{{ error }}</p>
      </div>
      <footer class="export-actions">
        <button class="secondary-button" @click="emit('close')">关闭</button>
        <button v-if="receipt?.revealUrl" class="secondary-button" @click="emit('reveal')">打开文件夹</button>
        <a v-if="receipt" class="primary-button" :href="receipt.downloadUrl" :download="receipt.filename">下载 {{ receipt.filename.split('.').at(-1)?.toUpperCase() }}<Icon name="export" :size="16" /></a>
      </footer>
    </section>
  </div>
</template>

<style scoped>
.export-backdrop { z-index: 50; }
.export-modal { width: min(400px, 100%); max-height: 90dvh; overflow: auto; background: #15161e; border: 1px solid #ffffff16; border-radius: 14px; box-shadow: 0 25px 80px #0008; }
.export-body { padding: 18px; }
.export-state { margin: 0; display: flex; align-items: center; gap: 9px; font-size: 14px; }
.export-state svg { color: var(--accent); }
.export-note, .export-filename { margin: 12px 0 0; color: var(--muted); font-size: 12px; line-height: 1.6; overflow-wrap: anywhere; }
progress { display: block; width: 100%; height: 6px; margin-top: 16px; accent-color: var(--accent); }
.export-actions { padding: 14px 18px; border-top: 1px solid var(--line); display: flex; justify-content: flex-end; align-items: center; gap: 8px; flex-wrap: wrap; }
.export-actions a { display: inline-flex; align-items: center; gap: 6px; }
</style>

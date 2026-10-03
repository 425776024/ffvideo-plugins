<script setup lang="ts">
defineProps<{ name: string; size?: number }>();
const paths: Record<string, string> = {
  play: 'M8 5l11 7-11 7z',
  pause: 'M8 5v14M16 5v14',
  spark: 'M12 3l2.4 6.6L21 12l-6.6 2.4L12 21l-2.4-6.6L3 12l6.6-2.4z',
  search: 'M20 20l-5-5M17 10a7 7 0 1 1-14 0 7 7 0 0 1 14 0',
  comment: 'M21 11.5a9 9 0 0 1-9 9H3l2.5-4A9 9 0 1 1 21 11.5z',
  export: 'M12 3v12m-4-4 4 4 4-4M5 16v5h14v-5',
  sound: 'M11 4 6 8H3v8h3l5 4zM15 8a6 6 0 0 1 0 8M18 5a10 10 0 0 1 0 14',
  mute: 'M11 4 6 8H3v8h3l5 4zM16 9l5 6m0-6-5 6',
  back: 'M15 5l-7 7 7 7',
  close: 'M6 6l12 12M18 6 6 18',
  down: 'M6 9l6 6 6-6',
  up: 'M6 15l6-6 6 6',
  settings: 'M4 7h16M4 17h16M9 4v6M15 14v6',
  history: 'M3 10a9 9 0 1 1 1.7 7M3 4v6h6M12 7v5l3 2',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  check: 'M4 12l5 5L20 6',
  trash: 'M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7M14 10v7',
  folder: 'M3 7V4h7l3 3h8v13H3z',
  clock: 'M12 7v5l3 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0',
  bolt: 'M13 2 4 14h7l-1 8 10-13h-7z'
};
</script>
<template>
  <svg
    :width="size || 22"
    :height="size || 22"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.spark" />
  </svg>
</template>

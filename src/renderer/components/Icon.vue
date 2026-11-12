<script setup lang="ts">
withDefaults(defineProps<{ name: string; size?: number }>(), { size: 20 });
const paths: Record<string, string> = {
  home: "M3 10 12 3l9 7v11h-6v-7H9v7H3Z",
  file: "M6 3h8l4 4v14H6Z M14 3v5h4 M9 12h6 M9 16h6",
  chart: "M4 20V11h3v9 M10 20V5h3v15 M16 20V2h3v18",
  code: "m8 5-6 7 6 7 m8-14 6 7-6 7 m-3-17-2 20",
  box: "m12 3 9 5v9l-9 5-9-5V8Z M3 8l9 5 9-5 M12 13v9",
  external: "M13 3h8v8 M21 3l-12 12 M9 5H4v16h16v-6",
  play: "m6 3 15 9-15 9Z",
  search: "M10 18a8 8 0 1 0 0-16 8 8 0 0 0 0 16 m6-2 6 7",
  settings:
    "m9 3 1-2h4l1 2 3 2 2 1 1 4-2 2-1 4-2 2-4 1-2-2-4-1-2-2-1-4 2-2 1-4Z M15 11a3 3 0 1 0-6 0 3 3 0 0 0 6 0",
  database:
    "M3 5c0-4 18-4 18 0s-18 4-18 0v14c0 4 18 4 18 0V5 M3 12c0 4 18 4 18 0",
  pencil: "m3 17 13-13 5 5L8 22H3Z m11-11 5 5",
  bulb: "M9 18h6 M10 21h4 M12 3a6 6 0 0 0-3 11.2V16h6v-1.8A6 6 0 0 0 12 3Z",
  spark: "M12 2.5 14 8.5 20 10.5 14 12.5 12 18.5 10 12.5 4 10.5 10 8.5Z",
  book: "M6 3h13v18H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z M9 7h7 M9 11h7 M9 15h4",
  list: "M8 5h14 M8 12h14 M8 19h14 M2 5h1 M2 12h1 M2 19h1",
  folder: "M2 6h8l2 3h10v12H2Z",
  check: "m4 12 5 5L20 6",
  chevron: "m9 4 8 8-8 8",
  refresh: "M21 7v6h-6 M3 17v-6h6 M20 10A9 9 0 0 0 4 6 M4 14a9 9 0 0 0 16 4",
  copy: "M8 8h13v13H8Z M16 8V3H3v13h5",
  close: "m5 5 14 14 M19 5 5 19",
  plus: "M12 3v18 M3 12h18",
  minus: "M4 12h16",
  "arrow-left": "M20 12H4 M10 6l-6 6 6 6",
  "arrow-right": "M4 12h16 M14 6l6 6-6 6",
  save: "M4 3h13l4 4v14H3V3Z M7 3v6h10V3 M7 21v-8h10v8",
  calendar: "M3 5h18v17H3Z M7 2v6 M17 2v6 M3 11h18",
  link: "m10 7 4-4a5 5 0 0 1 7 7l-4 4 M14 17l-4 4a5 5 0 0 1-7-7l4-4 M8 16l8-8",
  lock: "M5 10h14v12H5Z M8 10V6a4 4 0 0 1 8 0v4",
  branch: "M6 3v14a4 4 0 0 0 4 4 M6 11h8a4 4 0 0 0 4-4V3",
  merge: "M6 3v14 M18 3v4c0 5-12 3-12 10 M3 20a3 3 0 1 0 6 0 3 3 0 0 0-6 0 M3 3a3 3 0 1 0 6 0 3 3 0 0 0-6 0 M15 3a3 3 0 1 0 6 0 3 3 0 0 0-6 0",
  warning: "m12 2 11 20H1Z M12 8v6 M12 18v1",
  grid: "M4 4h7v7H4Z M13 4h7v7h-7Z M4 13h7v7H4Z M13 13h7v7h-7Z",
  maximize: "M5 5h14v14H5Z",
  pause: "M8 5v14 M16 5v14",
  "arrow-down": "M12 4v16 M6 14l6 6 6-6",
  image:
    "M3 4h18v16H3Z M3 15.5l5-5 4 4 3-3 6 6 M8.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z",
};
</script>
<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.6"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
  >
    <path :d="paths[name] || paths.file" />
  </svg>
</template>

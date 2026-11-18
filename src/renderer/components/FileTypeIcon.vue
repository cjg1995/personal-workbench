<script setup lang="ts">
import { computed } from "vue";
import Icon from "./Icon.vue";

interface Spec { text: string; fg: string; bg: string }
const props = withDefaults(
  defineProps<{ name: string; directory?: boolean; size?: number }>(),
  { directory: false, size: 14 },
);
const special: Record<string, Spec> = {
  "pom.xml": { text: "M", fg: "#A6421C", bg: "#FBE6DC" },
  "package.json": { text: "N", fg: "#9A3C1B", bg: "#FBE7DF" },
  "agora.config.json": { text: "J", fg: "#7A5B00", bg: "#FFF1C9" },
  ".gitignore": { text: "G", fg: "#3F4A5A", bg: "#E7ECF2" },
  ".gitattributes": { text: "G", fg: "#3F4A5A", bg: "#E7ECF2" },
  ".editorconfig": { text: "E", fg: "#3F4A5A", bg: "#E7ECF2" },
  dockerfile: { text: "D", fg: "#1F6FA8", bg: "#E1EFFB" },
  license: { text: "L", fg: "#5A6070", bg: "#ECEFF3" },
};
const byExt: Record<string, Spec> = {
  java: { text: "J", fg: "#B52A1A", bg: "#FCE7E2" },
  class: { text: "C", fg: "#8A3A1A", bg: "#F8E9E1" },
  jav: { text: "J", fg: "#B52A1A", bg: "#FCE7E2" },
  xml: { text: "X", fg: "#B85A16", bg: "#FBEBD8" },
  html: { text: "H", fg: "#BE471C", bg: "#FBE6DC" },
  htm: { text: "H", fg: "#BE471C", bg: "#FBE6DC" },
  vue: { text: "V", fg: "#167A50", bg: "#DDF4E8" },
  js: { text: "JS", fg: "#8A6A00", bg: "#FFF3BE" },
  mjs: { text: "JS", fg: "#8A6A00", bg: "#FFF3BE" },
  cjs: { text: "JS", fg: "#8A6A00", bg: "#FFF3BE" },
  jsx: { text: "JS", fg: "#8A6A00", bg: "#FFF3BE" },
  ts: { text: "TS", fg: "#1F5FA8", bg: "#E0EDFB" },
  tsx: { text: "TS", fg: "#1F5FA8", bg: "#E0EDFB" },
  json: { text: "{}", fg: "#7A5B00", bg: "#FFF1C9" },
  jsonc: { text: "{}", fg: "#7A5B00", bg: "#FFF1C9" },
  md: { text: "M", fg: "#3C4A5A", bg: "#E8EDF3" },
  markdown: { text: "M", fg: "#3C4A5A", bg: "#E8EDF3" },
  yml: { text: "Y", fg: "#6A3FA0", bg: "#EFE3FA" },
  yaml: { text: "Y", fg: "#6A3FA0", bg: "#EFE3FA" },
  sql: { text: "S", fg: "#1B6E8C", bg: "#DDF0F7" },
  css: { text: "C", fg: "#1F6FB2", bg: "#E1F0FC" },
  scss: { text: "C", fg: "#1F6FB2", bg: "#E1F0FC" },
  less: { text: "C", fg: "#1F6FB2", bg: "#E1F0FC" },
  properties: { text: "P", fg: "#5A6070", bg: "#ECEFF3" },
  sh: { text: ">_", fg: "#276B48", bg: "#E0F2E7" },
  bash: { text: ">_", fg: "#276B48", bg: "#E0F2E7" },
  bat: { text: ">_", fg: "#276B48", bg: "#E0F2E7" },
  ps1: { text: ">_", fg: "#276B48", bg: "#E0F2E7" },
  png: { text: "▣", fg: "#8A3FA0", bg: "#F2E4FA" },
  jpg: { text: "▣", fg: "#8A3FA0", bg: "#F2E4FA" },
  jpeg: { text: "▣", fg: "#8A3FA0", bg: "#F2E4FA" },
  gif: { text: "▣", fg: "#8A3FA0", bg: "#F2E4FA" },
  svg: { text: "▣", fg: "#8A3FA0", bg: "#F2E4FA" },
  ico: { text: "▣", fg: "#8A3FA0", bg: "#F2E4FA" },
  jar: { text: "Z", fg: "#6B4A20", bg: "#F5E9D6" },
  zip: { text: "Z", fg: "#6B4A20", bg: "#F5E9D6" },
  rar: { text: "Z", fg: "#6B4A20", bg: "#F5E9D6" },
  war: { text: "Z", fg: "#6B4A20", bg: "#F5E9D6" },
  gradle: { text: "G", fg: "#2B6C4F", bg: "#E3F2E9" },
  kts: { text: "K", fg: "#6A3FA0", bg: "#EFE3FA" },
  txt: { text: "T", fg: "#4A5568", bg: "#E8ECF2" },
  log: { text: "T", fg: "#4A5568", bg: "#E8ECF2" },
};
const spec = computed<Spec>(() => {
  const lower = props.name.toLowerCase();
  if (special[lower]) return special[lower];
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot + 1) : lower;
  return byExt[ext] || { text: "·", fg: "#7B8494", bg: "#EEF1F5" };
});
</script>
<template>
  <span v-if="directory" class="file-type-icon file-type-folder"><Icon name="folder" :size="size" /></span>
  <span v-else class="file-type-icon" :class="{ 'file-type-wide': spec.text.length > 1 }"
    :style="{ width: `${size}px`, height: `${size}px`, color: spec.fg, background: spec.bg }"
    :title="name">{{ spec.text }}</span>
</template>

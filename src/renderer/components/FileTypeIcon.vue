<script setup lang="ts">
import { computed } from "vue";
import type { EditorDirectoryKind, JavaFileKind } from "../../shared/editor-tree";
import { editorFileIcon, editorIconUrl } from "../file-icons";

const props = withDefaults(defineProps<{
  name: string;
  directory?: boolean;
  directoryKind?: EditorDirectoryKind;
  javaKind?: JavaFileKind;
  size?: number;
}>(), { size: 16 });
const icon = computed(() => editorFileIcon(props.name, props.directory, props.javaKind, props.directoryKind));
const style = computed(() => ({
  "--file-icon-size": props.size + "px",
  "--file-icon-light": 'url("' + new URL(editorIconUrl(icon.value), document.baseURI).href + '")',
  "--file-icon-dark": 'url("' + new URL(editorIconUrl(icon.value, true), document.baseURI).href + '")',
}));
</script>

<template>
  <span class="file-type-icon" aria-hidden="true" :data-icon="icon" :style="style" />
</template>

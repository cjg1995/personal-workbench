<script setup lang="ts">
import FileTypeIcon from "./FileTypeIcon.vue";
import type { EditorTreeEntry } from "../../shared/editor-tree";
export interface TreeNode extends EditorTreeEntry {
  expanded?: boolean;
  loaded?: boolean;
  children?: TreeNode[];
}
defineOptions({ name: "EditorTreeNode" });
defineProps<{ node: TreeNode; depth: number; active: string }>();
const emit = defineEmits<{ toggle: [node: TreeNode]; open: [file: string] }>();
</script>
<template>
  <div class="editor-tree-row" :class="{ active: node.file === active }"
    :style="{ paddingLeft: `${depth * 15 + 8}px` }" :title="node.file"
    :data-file="node.file" @click="node.directory ? emit('toggle', node) : emit('open', node.file)">
    <span class="editor-tree-arrow" aria-hidden="true" :class="{ expanded: node.expanded, invisible: !node.directory }"></span>
    <FileTypeIcon :name="node.name" :directory="node.directory" :directory-kind="node.directoryKind" :java-kind="node.javaKind" />
    <span class="editor-tree-name">{{ node.javaKind ? node.name.slice(0, -5) : node.name }}</span>
  </div>
  <template v-if="node.directory && node.expanded">
    <EditorTreeNode v-for="child in node.children || []" :key="child.file"
      :node="child" :depth="depth + 1" :active="active"
      @toggle="emit('toggle', $event)" @open="emit('open', $event)" />
  </template>
</template>

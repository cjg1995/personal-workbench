<script setup lang="ts">
import Icon from "./Icon.vue";
export interface TreeNode {
  name: string;
  file: string;
  directory: boolean;
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
    <span class="editor-tree-arrow" :class="{ expanded: node.expanded, invisible: !node.directory }">▸</span>
    <Icon :name="node.directory ? 'folder' : 'file'" :size="15" />
    <span class="editor-tree-name">{{ node.name }}</span>
  </div>
  <template v-if="node.directory && node.expanded">
    <EditorTreeNode v-for="child in node.children || []" :key="child.file"
      :node="child" :depth="depth + 1" :active="active"
      @toggle="emit('toggle', $event)" @open="emit('open', $event)" />
  </template>
</template>

<script setup lang="ts">
defineProps<{
  message: string;
  amend: boolean;
  stagedCount: number;
  busy: boolean;
  upstream?: string;
  visibleCount: number;
  checkedCount: number;
}>();
defineEmits<{
  "update:message": [value: string];
  "update:amend": [value: boolean];
  stage: [checked: boolean];
  inspect: [];
  commit: [push: boolean];
}>();
</script>
<template>
  <div class="git-panel-title">
    <strong>Commit</strong><span>{{ stagedCount }} 个已暂存文件</span>
  </div>
  <p class="git-help">Commit 将已暂存的内容提交到本地仓库；Commit 并 Push 同时推送到上游分支。</p>
  <div class="git-stage-actions">
    <button :disabled="busy || !visibleCount" @click="$emit('stage', false)">暂存当前列表</button>
    <button v-if="checkedCount" :disabled="busy" @click="$emit('stage', true)">暂存勾选文件</button>
  </div>
  <p v-if="!stagedCount" class="git-help">先暂存需要提交的文件，再填写提交说明。</p>
  <button class="git-text-button" :disabled="!stagedCount" @click="$emit('inspect')">检查已暂存变更 →</button>
  <textarea
    :value="message"
    aria-label="本地提交说明"
    placeholder="填写提交说明…"
    maxlength="20000"
    @input="$emit('update:message', ($event.target as HTMLTextAreaElement).value)"
  />
  <label class="git-checkbox"><input type="checkbox" :checked="amend" :disabled="busy"
    @change="$emit('update:amend', ($event.target as HTMLInputElement).checked)" />修改最后一次提交（--amend）</label>
  <div class="git-commit-actions">
    <button class="primary" :disabled="busy || !message.trim() || (!stagedCount && !amend)"
      @click="$emit('commit', false)">Commit</button>
    <button :disabled="busy || !message.trim() || (!stagedCount && !amend) || !upstream"
      title="提交后推送到当前上游分支" @click="$emit('commit', true)">Commit 并 Push</button>
  </div>
  <small class="muted">提交全部已暂存内容 · Ctrl+Enter 提交</small>
</template>

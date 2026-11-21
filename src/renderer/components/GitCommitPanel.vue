<script setup lang="ts">
import Icon from "./Icon.vue";

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
  <div class="commit-body">
    <div class="stage-well" :class="{ ready: stagedCount > 0 }">
      <span class="stage-dot" aria-hidden="true" />
      <strong class="grow">已暂存 {{ stagedCount }} 个文件</strong>
      <button
        v-if="stagedCount"
        type="button"
        class="text-action"
        @click="$emit('inspect')"
      >
        查看 →
      </button>
    </div>

    <label class="field-label" for="git-commit-textarea">提交说明</label>
    <textarea
      id="git-commit-textarea"
      class="message-box"
      :value="message"
      aria-label="本地提交说明"
      placeholder="简要描述本次修改…"
      maxlength="20000"
      @input="
        $emit('update:message', ($event.target as HTMLTextAreaElement).value)
      "
    />

    <label class="amend">
      <input
        type="checkbox"
        :checked="amend"
        :disabled="busy"
        @change="
          $emit('update:amend', ($event.target as HTMLInputElement).checked)
        "
      />
      <span>修改最后一次提交（amend）</span>
    </label>

    <div class="commit-buttons">
      <button
        type="button"
        class="btn primary"
        :disabled="busy || !message.trim() || (!stagedCount && !amend)"
        title="提交全部已暂存内容（Ctrl+Enter）"
        @click="$emit('commit', false)"
      >
        <Icon name="git-commit" :size="15" />提交
      </button>
      <button
        type="button"
        class="btn"
        :disabled="
          busy || !message.trim() || (!stagedCount && !amend) || !upstream
        "
        :title="
          upstream ? '提交后推送到当前上游分支' : '当前分支没有上游，不能推送'
        "
        @click="$emit('commit', true)"
      >
        <Icon name="upload" :size="15" />提交并推送
      </button>
    </div>
  </div>
</template>

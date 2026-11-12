<script setup lang="ts">
import Icon from "./Icon.vue";
withDefaults(
  defineProps<{ label?: string; disabled?: boolean; size?: number }>(),
  { label: "关闭", size: 14 },
);
defineEmits<{ click: [event: MouseEvent] }>();
</script>
<template>
  <button
    type="button"
    class="close-button"
    :aria-label="label"
    :title="label"
    :disabled="disabled"
    @click="$emit('click', $event)"
  >
    <Icon name="close" :size="size" />
  </button>
</template>

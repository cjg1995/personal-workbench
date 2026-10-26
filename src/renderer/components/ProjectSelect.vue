<script setup lang="ts">
import { model } from "../state";
withDefaults(
  defineProps<{
    modelValue: string | null | undefined;
    optional?: boolean;
    label?: string;
    ids?: string[];
  }>(),
  { optional: true, label: "项目（可选）" },
);
defineEmits<{ "update:modelValue": [value: string | null] }>();
</script>
<template>
  <select
    :value="modelValue || ''"
    :aria-label="label"
    @change="
      $emit(
        'update:modelValue',
        ($event.target as HTMLSelectElement).value || null,
      )
    "
  >
    <option v-if="optional" value="">{{ label }}</option>
    <option
      v-for="p in model.config?.projects.filter(
        (p) => !ids || ids.includes(p.id),
      )"
      :key="p.id"
      :value="p.id"
    >
      {{ p.name }}
    </option>
  </select>
</template>

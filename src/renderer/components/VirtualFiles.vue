<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ChangeFile } from "../../shared/git-client";
const props = withDefaults(
  defineProps<{
    files: ChangeFile[];
    selected?: string;
    checked?: string[];
    multiple?: boolean;
  }>(),
  { selected: "", checked: () => [], multiple: false },
);
const emit = defineEmits<{
  select: [file: ChangeFile];
  show: [file: ChangeFile];
  toggle: [file: ChangeFile];
  menu: [file: ChangeFile, event: MouseEvent];
}>();
const viewport = ref<HTMLElement>(),
  top = ref(0),
  height = ref(400);
const rowHeight = 32,
  start = computed(() => Math.max(0, Math.floor(top.value / rowHeight) - 8));
const visible = computed(() =>
  props.files.slice(
    start.value,
    start.value + Math.ceil(height.value / rowHeight) + 16,
  ),
);
const checkedSet = computed(() => new Set(props.checked));
let observer: ResizeObserver;
function key(event: KeyboardEvent) {
  const index = props.files.findIndex((f) => f.path === props.selected);
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    const next = Math.max(
        0,
        Math.min(
          props.files.length - 1,
          index + (event.key === "ArrowDown" ? 1 : -1),
        ),
      ),
      file = props.files[next];
    if (!file) return;
    emit("select", file);
    if (viewport.value) {
      if (next * rowHeight < viewport.value.scrollTop)
        viewport.value.scrollTop = next * rowHeight;
      else if ((next + 1) * rowHeight > viewport.value.scrollTop + height.value)
        viewport.value.scrollTop = (next + 1) * rowHeight - height.value;
    }
  } else if (event.key === "Enter" && props.files[index]) {
    event.preventDefault();
    emit("show", props.files[index]);
  } else if (event.key === " " && props.multiple && props.files[index]) {
    event.preventDefault();
    emit("toggle", props.files[index]);
  }
}
watch(
  () => props.files,
  () => {
    if (viewport.value && top.value > props.files.length * rowHeight) {
      viewport.value.scrollTop = 0;
      top.value = 0;
    }
  },
);
watch(() => props.selected, () => {
  const index = props.files.findIndex((f) => f.path === props.selected),
    view = viewport.value;
  if (index < 0 || !view) return;
  if (index * rowHeight < view.scrollTop) view.scrollTop = index * rowHeight;
  else if ((index + 1) * rowHeight > view.scrollTop + height.value)
    view.scrollTop = (index + 1) * rowHeight - height.value;
});
onMounted(() => {
  observer = new ResizeObserver(
    (entries) => (height.value = entries[0].contentRect.height),
  );
  if (viewport.value) observer.observe(viewport.value);
});
onBeforeUnmount(() => observer?.disconnect());
</script>
<template>
  <div
    ref="viewport"
    class="git-virtual-files"
    role="listbox"
    tabindex="0"
    aria-label="变更文件"
    :aria-activedescendant="
      selected
        ? 'file-' + files.findIndex((f) => f.path === selected)
        : undefined
    "
    @keydown="key"
    @scroll="top = ($event.target as HTMLElement).scrollTop"
  >
    <div
      :style="{ height: files.length * rowHeight + 'px', position: 'relative' }"
    >
      <div
        v-for="(file, index) in visible"
        :id="'file-' + (start + index)"
        :key="file.path"
        class="git-file-row"
        :class="{ active: file.path === selected, conflicted: file.conflicted }"
        :style="{ top: (start + index) * rowHeight + 'px' }"
        role="option"
        :aria-selected="file.path === selected"
        :title="(file.oldPath ? file.oldPath + ' → ' : '') + file.path"
        @click="emit('select', file)"
        @dblclick="emit('show', file)"
        @contextmenu.prevent="emit('menu', file, $event)"
      >
        <input
          v-if="multiple"
          type="checkbox"
          :aria-label="'选择 ' + file.path"
          :checked="checkedSet.has(file.path)"
          @click.stop="emit('toggle', file)"
        />
        <span
          class="git-status-code"
          :class="
            file.conflicted
              ? 'conflict'
              : file.untracked || file.status.startsWith('A')
                ? 'added'
                : file.status.startsWith('D')
                  ? 'deleted'
                  : ''
          "
          >{{ file.conflicted ? "!" : file.status }}</span
        >
        <span class="git-file-path">{{ file.path }}</span
        ><span v-if="file.staged" class="git-index-dot" title="包含已暂存修改"
          >●</span
        ><span
          v-if="file.staged && file.unstaged"
          class="git-work-dot"
          title="同时存在未暂存修改"
          >◐</span
        >
      </div>
    </div>
    <div v-if="!files.length" class="git-empty">此范围没有变更文件</div>
  </div>
</template>

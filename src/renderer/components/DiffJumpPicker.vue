<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { CodeJumpTarget } from "../../shared/types";
import CloseButton from "./CloseButton.vue";

const props = defineProps<{
  open: boolean;
  symbol: string;
  targets: CodeJumpTarget[];
  dark?: boolean;
}>();
const emit = defineEmits<{
  pick: [target: CodeJumpTarget];
  close: [];
}>();

const query = ref("");
const selected = ref(0);
const filterInput = ref<HTMLInputElement>();
const listHost = ref<HTMLElement>();

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  if (!q) return props.targets;
  return props.targets.filter((item) =>
    `${item.label} ${item.detail || ""} ${item.snippet} ${roleLabel(item.role)}`.toLowerCase().includes(q),
  );
});

watch(
  () => props.open,
  async (opened) => {
    if (!opened) return;
    query.value = "";
    selected.value = 0;
    await nextTick();
    if (filterInput.value) filterInput.value.focus();
    else listHost.value?.focus();
  },
);

watch(query, () => {
  selected.value = 0;
});

watch(selected, async () => {
  await nextTick();
  listHost.value
    ?.querySelector<HTMLElement>(`.diff-jump-row[data-index="${selected.value}"]`)
    ?.scrollIntoView({ block: "nearest" });
});

function roleLabel(role?: CodeJumpTarget["role"]) {
  if (role === "implementation") return "实现";
  if (role === "interface") return "接口";
  if (role === "super") return "父类";
  return "";
}

function onKeydown(event: KeyboardEvent) {
  const total = filtered.value.length;
  if (event.key === "ArrowDown") {
    if (total) selected.value = (selected.value + 1) % total;
    event.preventDefault();
    event.stopPropagation();
  } else if (event.key === "ArrowUp") {
    if (total) selected.value = (selected.value - 1 + total) % total;
    event.preventDefault();
    event.stopPropagation();
  } else if (event.key === "Enter") {
    const chosen = filtered.value[selected.value];
    if (chosen) emit("pick", chosen);
    event.preventDefault();
    event.stopPropagation();
  } else if (event.key === "Escape") {
    emit("close");
    event.preventDefault();
    event.stopPropagation();
  }
}
</script>

<template>
  <Transition name="overlay-pop">
    <div
      v-if="open"
      class="diff-jump-backdrop"
      :class="{ dark }"
      @mousedown.self="emit('close')"
      @keydown="onKeydown"
    >
      <div class="diff-jump-dialog" role="dialog" :aria-label="`选择跳转目标 ${symbol}`">
      <header class="diff-jump-head">
        <span class="diff-jump-title">选择跳转目标</span>
        <code v-if="symbol" class="diff-jump-symbol">{{ symbol }}</code>
        <span class="diff-jump-count">{{ filtered.length }} 处</span>
        <CloseButton label="关闭" :size="13" @click="emit('close')" />
      </header>
      <div v-if="targets.length > 3" class="diff-jump-search">
        <input
          ref="filterInput"
          v-model="query"
          type="search"
          placeholder="筛选文件名、路径或代码片段…"
          aria-label="筛选跳转目标"
        />
      </div>
      <div ref="listHost" class="diff-jump-list" tabindex="0" role="listbox">
        <button
          v-for="(item, index) in filtered"
          :key="`${item.uri || item.file}:${item.line}:${item.column}:${index}`"
          type="button"
          class="diff-jump-row"
          :class="{ selected: index === selected }"
          :data-index="index"
          role="option"
          :aria-selected="index === selected"
          @mouseenter="selected = index"
          @click="emit('pick', item)"
        >
          <div class="diff-jump-row-top">
            <span class="diff-jump-dest" :class="{ external: !item.sameFile }">
              {{ item.sameFile ? "本页" : "代码编辑器 ↗" }}
            </span>
            <span v-if="roleLabel(item.role)" class="diff-jump-role" :class="item.role">
              {{ roleLabel(item.role) }}
            </span>
            <strong class="diff-jump-file">{{ item.label }}</strong>
            <span class="diff-jump-line">:{{ item.line }}</span>
            <span v-if="item.detail" class="diff-jump-dir" :title="item.file">{{ item.detail }}</span>
          </div>
          <code v-if="item.snippet" class="diff-jump-snippet">{{ item.snippet }}</code>
        </button>
        <div v-if="!filtered.length" class="diff-jump-empty">没有匹配的候选位置</div>
      </div>
      <footer class="diff-jump-foot">
        <span>↑↓ 选择 · Enter 跳转 · Esc 关闭</span>
        <span>本页将直接定位；其他文件将唤起代码编辑器打开</span>
      </footer>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.diff-jump-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1020;
  display: flex;
  justify-content: center;
  align-items: flex-start;
  padding: min(14vh, 110px) 16px 20px;
  background: rgba(15, 23, 42, 0.24);
}
.diff-jump-backdrop.dark {
  background: rgba(0, 0, 0, 0.45);
}
.diff-jump-dialog {
  display: flex;
  flex-direction: column;
  width: min(650px, 100%);
  max-height: min(460px, 68vh);
  border: 1px solid #cbd5e1;
  border-radius: 10px;
  background: #ffffff;
  color: #1f2329;
  box-shadow: 0 18px 42px -10px rgba(15, 23, 42, 0.26), 0 2px 10px rgba(15, 23, 42, 0.08);
  overflow: hidden;
  font-family: Inter, "Segoe UI Variable Text", "Segoe UI", "Microsoft YaHei UI", sans-serif;
}
.diff-jump-backdrop.dark .diff-jump-dialog {
  border-color: #464a54;
  background: #22242a;
  color: #d6dbe3;
  box-shadow: 0 22px 48px rgba(0, 0, 0, 0.52);
}
.diff-jump-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 8px 0 13px;
  border-bottom: 1px solid #e5e8ee;
  background: #f7f8fa;
  flex: none;
}
.diff-jump-backdrop.dark .diff-jump-head {
  border-bottom-color: #343740;
  background: #282a30;
}
.diff-jump-title {
  font-size: 12.5px;
  font-weight: 600;
}
.diff-jump-symbol {
  padding: 1px 6px;
  border-radius: 4px;
  background: #eaf1ff;
  color: #17459e;
  font: 11.5px/1.4 "Workbench JetBrains Mono", Consolas, monospace;
}
.diff-jump-backdrop.dark .diff-jump-symbol {
  background: #294169;
  color: #bfd7ff;
}
.diff-jump-count {
  margin-left: auto;
  color: #64748b;
  font-size: 11px;
}
.diff-jump-backdrop.dark .diff-jump-count {
  color: #94a3b8;
}
.diff-jump-search {
  padding: 8px 10px 4px;
  flex: none;
}
.diff-jump-search input {
  width: 100%;
  height: 30px;
  padding: 4px 9px;
  border: 1px solid #cbd5e1;
  border-radius: 6px;
  background: #ffffff;
  color: inherit;
  font-size: 12px;
  outline: none;
}
.diff-jump-search input:focus {
  border-color: #6b9ef5;
  box-shadow: 0 0 0 2px rgba(75, 141, 248, 0.16);
}
.diff-jump-backdrop.dark .diff-jump-search input {
  border-color: #464a54;
  background: #1b1d22;
}
.diff-jump-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 6px;
  outline: none;
  scrollbar-width: thin;
}
.diff-jump-row {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 7px 10px;
  border: 1px solid transparent;
  border-radius: 7px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
  min-height: 0;
  font-weight: 400;
}
.diff-jump-row:hover,
.diff-jump-row.selected {
  background: #eef4ff;
  border-color: #cfe0fc;
}
.diff-jump-backdrop.dark .diff-jump-row:hover,
.diff-jump-backdrop.dark .diff-jump-row.selected {
  background: #2b3f5e;
  border-color: #3f5c87;
}
.diff-jump-row-top {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  font-size: 12px;
}
.diff-jump-dest {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 6px;
  border-radius: 4px;
  font-size: 10.5px;
  font-weight: 600;
  background: #e6f0ff;
  color: #17459e;
}
.diff-jump-dest.external {
  background: #e3f5ec;
  color: #146347;
}
.diff-jump-backdrop.dark .diff-jump-dest {
  background: #26436e;
  color: #b7d4ff;
}
.diff-jump-backdrop.dark .diff-jump-dest.external {
  background: #1e493a;
  color: #9be3c3;
}
.diff-jump-role {
  flex: none;
  display: inline-flex;
  align-items: center;
  height: 18px;
  padding: 0 5px;
  border-radius: 4px;
  font-size: 10.5px;
  font-weight: 600;
  background: #f1f5f9;
  color: #475569;
}
.diff-jump-role.implementation {
  background: #fef3c7;
  color: #92400e;
}
.diff-jump-backdrop.dark .diff-jump-role {
  background: #353841;
  color: #b5bcc8;
}
.diff-jump-backdrop.dark .diff-jump-role.implementation {
  background: #52401b;
  color: #fde68a;
}
.diff-jump-file {
  font-weight: 600;
  white-space: nowrap;
}
.diff-jump-line {
  color: #586576;
  font-family: "Workbench JetBrains Mono", Consolas, monospace;
  font-size: 11.5px;
  flex: none;
}
.diff-jump-dir {
  margin-left: auto;
  color: #64748b;
  font-size: 11px;
  font-family: "Workbench JetBrains Mono", Consolas, monospace;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  min-width: 0;
}
.diff-jump-backdrop.dark .diff-jump-line,
.diff-jump-backdrop.dark .diff-jump-dir {
  color: #8f98a6;
}
.diff-jump-snippet {
  display: block;
  font: 11.5px/1.4 "Workbench JetBrains Mono", Consolas, monospace;
  color: #475569;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.diff-jump-backdrop.dark .diff-jump-snippet {
  color: #adb5c2;
}
.diff-jump-empty {
  padding: 24px 12px;
  text-align: center;
  color: #64748b;
  font-size: 12px;
}
.diff-jump-foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  height: 28px;
  padding: 0 12px;
  border-top: 1px solid #e5e8ee;
  background: #f7f8fa;
  color: #64748b;
  font-size: 10.5px;
  flex: none;
}
.diff-jump-backdrop.dark .diff-jump-foot {
  border-top-color: #343740;
  background: #282a30;
  color: #8f98a6;
}
</style>

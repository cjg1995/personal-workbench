<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { ChangeFile } from "../../shared/git-client";
import { splitFilePath } from "../format";
import Icon from "./Icon.vue";

const props = withDefaults(
  defineProps<{
    files: ChangeFile[];
    selected?: string;
    checked?: string[];
    multiple?: boolean;
    variant?: "compact" | "rich";
    busy?: boolean;
  }>(),
  {
    selected: "",
    checked: () => [],
    multiple: false,
    variant: "compact",
    busy: false,
  },
);

const emit = defineEmits<{
  select: [file: ChangeFile];
  show: [file: ChangeFile];
  toggle: [file: ChangeFile];
  menu: [file: ChangeFile, event: MouseEvent];
  stage: [file: ChangeFile];
  unstage: [file: ChangeFile];
}>();

const viewport = ref<HTMLElement>(),
  top = ref(0),
  height = ref(400);

const rowHeight = computed(() => (props.variant === "rich" ? 64 : 32));
const start = computed(() =>
  Math.max(0, Math.floor(top.value / rowHeight.value) - 8),
);
const visible = computed(() =>
  props.files.slice(
    start.value,
    start.value + Math.ceil(height.value / rowHeight.value) + 16,
  ),
);
const checkedSet = computed(() => new Set(props.checked));
let observer: ResizeObserver;

function isArchive(filePath: string) {
  return /\.(?:rar|zip|jar|war|7z|tar|gz|apk)$/i.test(filePath);
}

function statusMeta(file: ChangeFile): {
  code: string;
  label: string;
  tone: string;
} {
  if (file.conflicted) return { code: "!", label: "冲突", tone: "conflict" };
  if (file.untracked) return { code: "??", label: "未跟踪", tone: "added" };
  const rawCode = file.status.trim() || "M";
  if (file.staged && file.unstaged) {
    return { code: rawCode, label: "部分暂存", tone: "mixed" };
  }
  if (file.staged) {
    if (rawCode.startsWith("A"))
      return { code: "A", label: "已暂存 · 新增", tone: "staged" };
    if (rawCode.startsWith("D"))
      return { code: "D", label: "已暂存 · 删除", tone: "deleted" };
    if (rawCode.startsWith("R"))
      return { code: "R", label: "已暂存 · 重命名", tone: "staged" };
    return { code: rawCode, label: "已暂存", tone: "staged" };
  }
  if (rawCode.startsWith("D"))
    return { code: "D", label: "已删除", tone: "deleted" };
  if (rawCode.startsWith("A"))
    return { code: "A", label: "新增", tone: "added" };
  if (rawCode.startsWith("R"))
    return { code: "R", label: "重命名", tone: "modified" };
  return { code: rawCode, label: "已修改", tone: "modified" };
}

function key(event: KeyboardEvent) {
  const index = props.files.findIndex((f) => f.path === props.selected);
  const rh = rowHeight.value;
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
      if (next * rh < viewport.value.scrollTop)
        viewport.value.scrollTop = next * rh;
      else if ((next + 1) * rh > viewport.value.scrollTop + height.value)
        viewport.value.scrollTop = (next + 1) * rh - height.value;
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
    if (viewport.value && top.value > props.files.length * rowHeight.value) {
      viewport.value.scrollTop = 0;
      top.value = 0;
    }
  },
);

watch(
  () => props.selected,
  () => {
    const index = props.files.findIndex((f) => f.path === props.selected),
      view = viewport.value,
      rh = rowHeight.value;
    if (index < 0 || !view) return;
    if (index * rh < view.scrollTop) view.scrollTop = index * rh;
    else if ((index + 1) * rh > view.scrollTop + height.value)
      view.scrollTop = (index + 1) * rh - height.value;
  },
);

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
    :class="{ 'is-rich': variant === 'rich' }"
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
      :style="{
        height: files.length * rowHeight + 'px',
        position: 'relative',
      }"
    >
      <template v-if="variant === 'rich'">
        <div
          v-for="(file, index) in visible"
          :id="'file-' + (start + index)"
          :key="file.path"
          class="git-file-row rich"
          :class="{
            active: file.path === selected,
            selected: checkedSet.has(file.path),
            conflicted: file.conflicted,
          }"
          :style="{ top: (start + index) * rowHeight + 'px' }"
          role="option"
          :aria-selected="file.path === selected"
          :title="
            (file.oldPath ? file.oldPath + ' → ' : '') +
            file.path +
            '（双击或按 Enter 查看差异）'
          "
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
          <div class="file-path-cell">
            <span
              class="file-kind"
              :class="{ archive: isArchive(file.path) }"
              aria-hidden="true"
            >
              <Icon
                :name="isArchive(file.path) ? 'archive' : 'document'"
                :size="17"
              />
            </span>
            <span class="git-file-path rich-path">
              <small v-if="splitFilePath(file.path).dir">{{
                splitFilePath(file.path).dir
              }}</small>
              <strong>{{ splitFilePath(file.path).name }}</strong>
            </span>
          </div>
          <span
            class="git-status-pill"
            :class="statusMeta(file).tone"
            :title="statusMeta(file).code + ' · ' + statusMeta(file).label"
          >
            <span>{{ statusMeta(file).label }}</span>
          </span>
          <div class="file-row-actions">
            <button
              type="button"
              class="icon-btn small blank file-diff-btn"
              title="查看差异（双击 / Enter）"
              :aria-label="'查看差异 ' + file.path"
              @click.stop="emit('show', file)"
            >
              <Icon name="eye" :size="13" />
            </button>
            <button
              v-if="file.staged && !file.unstaged && !file.untracked"
              type="button"
              class="icon-btn small"
              :disabled="busy"
              title="取消暂存"
              :aria-label="'取消暂存 ' + file.path"
              @click.stop="emit('unstage', file)"
            >
              <Icon name="minus" :size="12" />
            </button>
            <button
              v-else
              type="button"
              class="icon-btn small"
              :disabled="busy"
              title="暂存"
              :aria-label="'暂存 ' + file.path"
              @click.stop="emit('stage', file)"
            >
              <Icon name="plus" :size="12" />
            </button>
          </div>
        </div>
      </template>

      <template v-else>
        <div
          v-for="(file, index) in visible"
          :id="'file-' + (start + index)"
          :key="file.path"
          class="git-file-row"
          :class="{
            active: file.path === selected,
            conflicted: file.conflicted,
          }"
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
          <span class="git-file-path">{{ file.path }}</span>
          <span v-if="file.staged" class="git-index-dot" title="包含已暂存修改"
            >●</span
          >
          <span
            v-if="file.staged && file.unstaged"
            class="git-work-dot"
            title="同时存在未暂存修改"
            >◐</span
          >
        </div>
      </template>
    </div>
    <div v-if="!files.length" class="git-empty">此范围没有变更文件</div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  activeDialog,
  bindMainDialogs,
  resolveActiveDialog,
} from "../dialog";
import Icon from "./Icon.vue";
import CloseButton from "./CloseButton.vue";

withDefaults(defineProps<{ dark?: boolean }>(), { dark: false });

const dialogEl = ref<HTMLDialogElement>();
const renderedDialog = ref(activeDialog.value);
let unbind: (() => void) | undefined;
let closeTimer: ReturnType<typeof setTimeout> | undefined;

const iconName = computed(() => {
  switch (renderedDialog.value?.tone) {
    case "danger":
      return "trash";
    case "warning":
    case "error":
      return "warning";
    case "info":
    case "question":
    default:
      return "info";
  }
});

const stackedButtons = computed(() => {
  const buttons = renderedDialog.value?.buttons || [];
  if (buttons.length <= 1) return false;
  const totalLen = buttons.reduce((sum, b) => sum + b.label.length, 0);
  return buttons.length >= 3 && totalLen > 16;
});

const hasLongDetail = computed(() => {
  const detail = renderedDialog.value?.detail || "";
  return detail.length > 90 || detail.includes("\n");
});

const canDismiss = computed(() => {
  const req = renderedDialog.value;
  return !!req && req.buttons.length > 0;
});

async function syncOpen() {
  const el = dialogEl.value;
  const req = activeDialog.value;
  if (req) {
    if (closeTimer) {
      clearTimeout(closeTimer);
      closeTimer = undefined;
    }
    renderedDialog.value = req;
    if (!el) return;
    if (!el.open) {
      el.showModal();
    }
    await nextTick();
    const btns = Array.from(
      el.querySelectorAll<HTMLButtonElement>("[data-dialog-btn]"),
    );
    const target = btns[req.defaultId] || btns[0];
    target?.focus();
  } else {
    if (el?.open) {
      el.close();
    }
    if (closeTimer) clearTimeout(closeTimer);
    closeTimer = setTimeout(() => {
      closeTimer = undefined;
      if (!activeDialog.value) renderedDialog.value = null;
    }, 140);
  }
}

watch(
  () => activeDialog.value?.id,
  () => {
    void nextTick(syncOpen);
  },
  { immediate: true },
);

onMounted(() => {
  unbind = bindMainDialogs();
  void syncOpen();
});

onBeforeUnmount(() => {
  unbind?.();
  if (closeTimer) clearTimeout(closeTimer);
  if (dialogEl.value?.open) dialogEl.value.close();
});

function choose(index: number) {
  resolveActiveDialog(index);
}

function dismiss() {
  if (!activeDialog.value) return;
  resolveActiveDialog(activeDialog.value.cancelId);
}

function onBackdropClick(event: MouseEvent) {
  if (event.target === dialogEl.value) {
    dismiss();
  }
}

function onKeydown(event: KeyboardEvent) {
  if (!activeDialog.value) return;
  if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
    const btns = Array.from(
      dialogEl.value?.querySelectorAll<HTMLButtonElement>("[data-dialog-btn]") ||
        [],
    );
    const idx = btns.indexOf(document.activeElement as HTMLButtonElement);
    if (idx < 0 || btns.length < 2) return;
    event.preventDefault();
    const delta = event.key === "ArrowRight" ? 1 : -1;
    const next = (idx + delta + btns.length) % btns.length;
    btns[next]?.focus();
  }
}
</script>

<template>
  <dialog
    ref="dialogEl"
    class="ui-msg-dialog"
    :class="{
      'ui-msg-dark': dark,
      'ui-msg-wide': hasLongDetail,
    }"
    role="alertdialog"
    aria-modal="true"
    :aria-labelledby="renderedDialog ? 'ui-msg-title' : undefined"
    :aria-describedby="renderedDialog ? 'ui-msg-body' : undefined"
    @cancel.prevent="dismiss"
    @click="onBackdropClick"
    @keydown="onKeydown"
  >
    <div v-if="renderedDialog" class="ui-msg-card">
      <div class="ui-msg-top">
        <span
          class="ui-msg-badge"
          :class="'tone-' + renderedDialog.tone"
          aria-hidden="true"
        >
          <Icon :name="iconName" :size="18" />
        </span>
        <div class="ui-msg-copy">
          <h2 id="ui-msg-title">{{ renderedDialog.title }}</h2>
          <p id="ui-msg-body" class="ui-msg-text">{{ renderedDialog.message }}</p>
        </div>
        <CloseButton
          v-if="canDismiss"
          class="ui-msg-close"
          label="关闭提示框"
          @click="dismiss"
        />
      </div>

      <div v-if="renderedDialog.detail" class="ui-msg-detail">
        {{ renderedDialog.detail }}
      </div>

      <div
        class="ui-msg-actions"
        :class="{ stacked: stackedButtons }"
      >
        <button
          v-for="(btn, idx) in renderedDialog.buttons"
          :key="idx + '-' + btn.label"
          type="button"
          data-dialog-btn
          :data-dialog-index="idx"
          class="ui-msg-btn"
          :class="btn.variant || 'default'"
          @click="choose(idx)"
        >
          {{ btn.label }}
        </button>
      </div>
    </div>
  </dialog>
</template>

<style scoped>
.ui-msg-dialog {
  padding: 0;
  border: 0;
  background: transparent;
  width: min(464px, 92vw);
  max-width: 92vw;
  max-height: 86vh;
  overflow: visible;
  color: #1f2329;
  font-family: Inter, "Segoe UI Variable Text", "Segoe UI", "Noto Sans SC",
    "Microsoft YaHei UI", "Microsoft YaHei", system-ui, sans-serif;
}

.ui-msg-dialog.ui-msg-wide {
  width: min(510px, 92vw);
}

.ui-msg-dialog::backdrop {
  background: rgba(23, 28, 38, 0.36);
  backdrop-filter: blur(2.5px);
}

.ui-msg-card {
  display: flex;
  flex-direction: column;
  max-height: 86vh;
  padding: 20px 22px 18px;
  border: 1px solid #e2e7ef;
  border-radius: 13px;
  background: #ffffff;
  box-shadow:
    0 24px 56px -22px rgba(15, 22, 34, 0.32),
    0 8px 20px -12px rgba(15, 22, 34, 0.12);
}

.ui-msg-top {
  display: flex;
  align-items: flex-start;
  gap: 13px;
}

.ui-msg-badge {
  display: grid;
  place-items: center;
  flex: none;
  width: 36px;
  height: 36px;
  border-radius: 9px;
  margin-top: 1px;
}

.ui-msg-badge.tone-info,
.ui-msg-badge.tone-question {
  background: #eaf1ff;
  color: #2f66c3;
  border: 1px solid #d5e4ff;
}

.ui-msg-badge.tone-warning {
  background: #fdf3e0;
  color: #9e6a11;
  border: 1px solid #f2dfb8;
}

.ui-msg-badge.tone-danger,
.ui-msg-badge.tone-error {
  background: #fbeceb;
  color: #b44139;
  border: 1px solid #f0d0cd;
}

.ui-msg-copy {
  flex: 1 1 0;
  min-width: 0;
}

.ui-msg-copy h2 {
  margin: 0;
  font-size: 15.5px;
  font-weight: 660;
  line-height: 1.4;
  letter-spacing: -0.15px;
  color: #1f2329;
}

.ui-msg-text {
  margin: 6px 0 0;
  font-size: 13.5px;
  line-height: 1.65;
  color: #4b586b;
  white-space: pre-wrap;
  word-break: break-word;
}

.ui-msg-close {
  display: inline-grid;
  place-items: center;
  flex: none;
  width: 28px;
  height: 28px;
  min-width: 28px;
  min-height: 28px;
  padding: 0;
  margin: -3px -5px 0 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  box-shadow: none;
  color: #67758a;
  cursor: pointer;
}

.ui-msg-close:hover {
  background: rgba(31, 35, 41, 0.06);
  color: #1f2329;
}

.ui-msg-dialog.ui-msg-dark .ui-msg-close {
  color: #8f97a4;
}

.ui-msg-dialog.ui-msg-dark .ui-msg-close:hover {
  background: rgba(255, 255, 255, 0.09);
  color: #eef1f6;
}

.ui-msg-detail {
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid #e7ecf3;
  border-radius: 8px;
  background: #f7f9fc;
  color: #3f4d60;
  font-size: 12.5px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
  overflow-y: auto;
  max-height: 220px;
}

.ui-msg-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 20px;
  flex-wrap: wrap;
}

.ui-msg-actions.stacked {
  flex-direction: column-reverse;
  align-items: stretch;
}

.ui-msg-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 35px;
  padding: 0 15px;
  border-radius: 7px;
  font: 540 13px/1 inherit;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background var(--motion-fast) var(--ease-out),
    border-color var(--motion-fast) var(--ease-out),
    color var(--motion-fast) var(--ease-out),
    box-shadow var(--motion-fast) var(--ease-out);
}

.ui-msg-actions.stacked .ui-msg-btn {
  width: 100%;
  min-height: 36px;
  white-space: normal;
  text-align: center;
  line-height: 1.35;
  padding: 7px 14px;
}

.ui-msg-btn:focus-visible {
  outline: 2px solid #4b8df8;
  outline-offset: 2px;
}

.ui-msg-btn.default {
  background: #ffffff;
  border: 1px solid #d8dde6;
  color: #344054;
  box-shadow: 0 1px 2px rgba(31, 35, 41, 0.04);
}

.ui-msg-btn.default:hover {
  background: #f5f8fc;
  border-color: #c3ccd9;
  color: #1f2329;
}

.ui-msg-btn.default:active {
  background: #eaf1ff;
  border-color: #c9dcff;
}

.ui-msg-btn.primary {
  background: #dbe8ff;
  border: 1px solid #aac9f5;
  color: #17459e;
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(50, 114, 184, 0.08);
}

.ui-msg-btn.primary:hover {
  background: #cce0ff;
  border-color: #93bbf2;
  color: #123a8a;
}

.ui-msg-btn.primary:active {
  background: #bcd5ff;
  border-color: #7eaef0;
}

.ui-msg-btn.danger {
  background: #fbeceb;
  border: 1px solid #e6bab6;
  color: #96362f;
  font-weight: 600;
  box-shadow: 0 1px 2px rgba(153, 71, 64, 0.06);
}

.ui-msg-btn.danger:hover {
  background: #f7dedc;
  border-color: #da9d98;
  color: #7d2822;
}

.ui-msg-btn.danger:active {
  background: #f1cecb;
  border-color: #ce857e;
}

/* 编辑器 / 对比窗口暗色模式适配 */
.ui-msg-dialog.ui-msg-dark .ui-msg-card {
  background: #25262a;
  border-color: #3d4048;
  box-shadow:
    0 24px 56px -18px rgba(0, 0, 0, 0.56),
    0 6px 18px rgba(0, 0, 0, 0.32);
}

.ui-msg-dialog.ui-msg-dark .ui-msg-copy h2 {
  color: #e4e8ef;
}

.ui-msg-dialog.ui-msg-dark .ui-msg-text {
  color: #a8b0bd;
}

.ui-msg-dialog.ui-msg-dark .ui-msg-detail {
  background: #1d1e22;
  border-color: #363840;
  color: #c2c8d3;
}

.ui-msg-dialog.ui-msg-dark .ui-msg-badge.tone-info,
.ui-msg-dialog.ui-msg-dark .ui-msg-badge.tone-question {
  background: #22324d;
  border-color: #324a73;
  color: #82b2ff;
}

.ui-msg-dialog.ui-msg-dark .ui-msg-badge.tone-warning {
  background: #3d311d;
  border-color: #5c4926;
  color: #e6b863;
}

.ui-msg-dialog.ui-msg-dark .ui-msg-badge.tone-danger,
.ui-msg-dialog.ui-msg-dark .ui-msg-badge.tone-error {
  background: #402424;
  border-color: #613535;
  color: #ec8d86;
}

.ui-msg-dialog.ui-msg-dark .ui-msg-btn.default {
  background: #2e3036;
  border-color: #464952;
  color: #d1d6df;
  box-shadow: none;
}

.ui-msg-dialog.ui-msg-dark .ui-msg-btn.default:hover {
  background: #383b43;
  border-color: #575b66;
  color: #eef1f6;
}

.ui-msg-dialog.ui-msg-dark .ui-msg-btn.primary {
  background: #2b3f66;
  border-color: #4465a3;
  color: #d6e6ff;
}

.ui-msg-dialog.ui-msg-dark .ui-msg-btn.primary:hover {
  background: #354e7d;
  border-color: #567cc2;
}

.ui-msg-dialog.ui-msg-dark .ui-msg-btn.danger {
  background: #4a2726;
  border-color: #783c3a;
  color: #f4b6b1;
}

.ui-msg-dialog.ui-msg-dark .ui-msg-btn.danger:hover {
  background: #5b302f;
  border-color: #8f4946;
}
</style>

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
let unbind: (() => void) | undefined;

const iconName = computed(() => {
  switch (activeDialog.value?.tone) {
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
  const buttons = activeDialog.value?.buttons || [];
  if (buttons.length <= 1) return false;
  const totalLen = buttons.reduce((sum, b) => sum + b.label.length, 0);
  return buttons.length >= 3 && totalLen > 16;
});

const hasLongDetail = computed(() => {
  const detail = activeDialog.value?.detail || "";
  return detail.length > 90 || detail.includes("\n");
});

const canDismiss = computed(() => {
  const req = activeDialog.value;
  return !!req && req.buttons.length > 0;
});

async function syncOpen() {
  const el = dialogEl.value;
  if (!el) return;
  const req = activeDialog.value;
  if (req) {
    if (!el.open) {
      el.showModal();
    }
    await nextTick();
    const btns = Array.from(
      el.querySelectorAll<HTMLButtonElement>("[data-dialog-btn]"),
    );
    const target = btns[req.defaultId] || btns[0];
    target?.focus();
  } else if (el.open) {
    el.close();
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
    :aria-labelledby="activeDialog ? 'ui-msg-title' : undefined"
    :aria-describedby="activeDialog ? 'ui-msg-body' : undefined"
    @cancel.prevent="dismiss"
    @click="onBackdropClick"
    @keydown="onKeydown"
  >
    <div v-if="activeDialog" class="ui-msg-card">
      <div class="ui-msg-top">
        <span
          class="ui-msg-badge"
          :class="'tone-' + activeDialog.tone"
          aria-hidden="true"
        >
          <Icon :name="iconName" :size="18" />
        </span>
        <div class="ui-msg-copy">
          <h2 id="ui-msg-title">{{ activeDialog.title }}</h2>
          <p id="ui-msg-body" class="ui-msg-text">{{ activeDialog.message }}</p>
        </div>
        <CloseButton
          v-if="canDismiss"
          class="ui-msg-close"
          label="关闭提示框"
          @click="dismiss"
        />
      </div>

      <div v-if="activeDialog.detail" class="ui-msg-detail">
        {{ activeDialog.detail }}
      </div>

      <div
        class="ui-msg-actions"
        :class="{ stacked: stackedButtons }"
      >
        <button
          v-for="(btn, idx) in activeDialog.buttons"
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
  color: var(--ink);
  font-family: var(--sans);
}

.ui-msg-dialog.ui-msg-wide {
  width: min(510px, 92vw);
}

.ui-msg-dialog[open] {
  animation: ui-msg-in 0.16s var(--ease);
}

.ui-msg-dialog::backdrop {
  background: var(--overlay);
}

@keyframes ui-msg-in {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.985);
  }
}

.ui-msg-card {
  display: flex;
  flex-direction: column;
  max-height: 86vh;
  padding: 20px 22px 18px;
  border: 1px solid var(--line);
  border-radius: var(--r-lg);
  background: var(--paper);
  box-shadow: var(--shadow-lg);
}

.ui-msg-top {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.ui-msg-badge {
  display: grid;
  place-items: center;
  flex: none;
  width: 34px;
  height: 34px;
  border-radius: var(--r-md);
  margin-top: 1px;
}

.ui-msg-badge.tone-info,
.ui-msg-badge.tone-question {
  background: var(--brand-tint);
  color: var(--brand-hover);
  border: 1px solid var(--brand-line);
}

.ui-msg-badge.tone-warning {
  background: var(--warning-bg);
  color: var(--warning-ink);
  border: 1px solid var(--warning-line);
}

.ui-msg-badge.tone-danger,
.ui-msg-badge.tone-error {
  background: var(--danger-bg);
  color: var(--danger-ink);
  border: 1px solid var(--danger-line);
}

.ui-msg-copy {
  flex: 1 1 0;
  min-width: 0;
}

.ui-msg-copy h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  line-height: 1.4;
  color: var(--ink);
}

.ui-msg-text {
  margin: 6px 0 0;
  font-size: 13px;
  line-height: 1.65;
  color: var(--text);
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
  border-radius: var(--r-md);
  background: transparent;
  box-shadow: none;
  color: var(--soft);
  cursor: pointer;
}

.ui-msg-close:hover {
  background: var(--hover);
  color: var(--ink);
}

.ui-msg-dialog.ui-msg-dark .ui-msg-close {
  color: var(--dark-muted);
}

.ui-msg-dialog.ui-msg-dark .ui-msg-close:hover {
  background: rgba(255, 255, 255, 0.09);
  color: var(--paper);
}

.ui-msg-detail {
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid var(--line);
  border-radius: var(--r-md);
  background: var(--back);
  color: var(--text);
  font-size: 12px;
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
  min-height: 34px;
  padding: 0 14px;
  border-radius: var(--r-md);
  font: 500 13px/1 inherit;
  cursor: pointer;
  white-space: nowrap;
  transition:
    background var(--dur) var(--ease),
    border-color var(--dur) var(--ease),
    color var(--dur) var(--ease);
}

.ui-msg-actions.stacked .ui-msg-btn {
  width: 100%;
  min-height: 34px;
  white-space: normal;
  text-align: center;
  line-height: 1.35;
  padding: 7px 14px;
}

.ui-msg-btn:focus-visible {
  outline: 2px solid var(--brand);
  outline-offset: 2px;
}

.ui-msg-btn.default {
  background: var(--paper);
  border: 1px solid var(--control-line);
  color: var(--text);
}

.ui-msg-btn.default:hover {
  background: var(--back);
  border-color: var(--control-line-hover);
  color: var(--ink);
}

.ui-msg-btn.default:active {
  background: var(--quiet-surface);
}

.ui-msg-btn.primary {
  background: var(--brand);
  border: 1px solid var(--brand);
  color: var(--paper);
  font-weight: 500;
}

.ui-msg-btn.primary:hover {
  background: var(--brand-hover);
  border-color: var(--brand-hover);
  color: var(--paper);
}

.ui-msg-btn.primary:active {
  background: var(--brand-hover);
  border-color: var(--brand-hover);
}

.ui-msg-btn.danger {
  background: var(--danger-bg);
  border: 1px solid var(--danger-line);
  color: var(--danger-ink);
  font-weight: 500;
}

.ui-msg-btn.danger:hover {
  background: var(--danger-hover-bg);
  border-color: var(--danger-ink);
  color: var(--danger-ink);
}

.ui-msg-btn.danger:active {
  background: var(--danger-hover-bg);
}

/* 编辑器 / 对比窗口暗色模式适配 */
.ui-msg-dialog.ui-msg-dark .ui-msg-card {
  background: var(--dark-panel);
  border-color: var(--dark-line);
  box-shadow: var(--shadow-lg);
}

.ui-msg-dialog.ui-msg-dark .ui-msg-copy h2 {
  color: var(--dark-text);
}

.ui-msg-dialog.ui-msg-dark .ui-msg-text {
  color: var(--dark-muted);
}

.ui-msg-dialog.ui-msg-dark .ui-msg-detail {
  background: var(--dark-bg);
  border-color: var(--dark-line);
  color: var(--dark-text);
}

.ui-msg-dialog.ui-msg-dark .ui-msg-badge.tone-info,
.ui-msg-dialog.ui-msg-dark .ui-msg-badge.tone-question {
  background: var(--dark-button-bg);
  border-color: var(--dark-button-line);
  color: var(--dark-brand-ink);
}

.ui-msg-dialog.ui-msg-dark .ui-msg-badge.tone-warning {
  background: var(--dark-warning-bg);
  border-color: var(--dark-warning-line);
  color: var(--dark-warning-ink);
}

.ui-msg-dialog.ui-msg-dark .ui-msg-badge.tone-danger,
.ui-msg-dialog.ui-msg-dark .ui-msg-badge.tone-error {
  background: var(--dark-danger-bg);
  border-color: var(--dark-danger-line);
  color: var(--dark-danger-ink);
}

.ui-msg-dialog.ui-msg-dark .ui-msg-btn.default {
  background: var(--dark-control);
  border-color: var(--dark-control-line);
  color: var(--dark-text);
}

.ui-msg-dialog.ui-msg-dark .ui-msg-btn.default:hover {
  background: var(--dark-line);
  border-color: var(--dark-muted);
  color: var(--paper);
}

.ui-msg-dialog.ui-msg-dark .ui-msg-btn.primary {
  background: var(--brand);
  border-color: var(--brand);
  color: var(--paper);
}

.ui-msg-dialog.ui-msg-dark .ui-msg-btn.primary:hover {
  background: var(--brand-hover);
  border-color: var(--brand-hover);
}

.ui-msg-dialog.ui-msg-dark .ui-msg-btn.danger {
  background: var(--dark-danger-bg);
  border-color: var(--dark-danger-line);
  color: var(--dark-danger-ink);
}

.ui-msg-dialog.ui-msg-dark .ui-msg-btn.danger:hover {
  background: var(--dark-danger-line);
  border-color: var(--dark-danger-ink);
}
</style>

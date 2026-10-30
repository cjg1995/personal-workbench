<script setup lang="ts">
import { computed, nextTick, onMounted, onBeforeUnmount, ref } from "vue";
import type { Note } from "../../shared/types";
import {
  attempt,
  call,
  confirm,
  model,
  notify,
  recordModal,
  reload,
  projectName,
  leaveGuard,
  setGuard,
} from "../state";
import Icon from "./Icon.vue";
const dialog = ref<HTMLDialogElement>();
const form = ref({ ...recordModal.value } as Partial<Note>);
const busy = ref(false);
const baseline = JSON.stringify(form.value),
  previousGuard = leaveGuard;
async function guard() {
  return (
    JSON.stringify(form.value) === baseline ||
    (await confirm(
      "有未保存的记录输入",
      "关闭后本次表单修改将丢弃。",
      "丢弃输入",
    ))
  );
}
setGuard(
  async () => (await guard()) && (!previousGuard || (await previousGuard())),
);
onBeforeUnmount(() => setGuard(previousGuard));
const existing = computed(() =>
  model.notes.filter(
    (n) =>
      !n.deletedAt &&
      n.kind === "work" &&
      form.value.sourceId &&
      n.sourceId === form.value.sourceId,
  ),
);
onMounted(async () => {
  dialog.value?.showModal();
  await nextTick();
  dialog.value?.querySelector("textarea")?.focus();
});
async function close() {
  if (!(await guard())) return;
  recordModal.value = null;
}
async function save() {
  if (busy.value || !form.value.text?.trim()) return;
  busy.value = true;
  await attempt(async () => {
    await call("record.save", form.value);
    await reload();
    notify("已保存工作记录");
    recordModal.value = null;
  });
  busy.value = false;
}
function onKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    void save();
  }
}
function setKind(value: "idea" | "work") {
  if (form.value.kind === value) return;
  form.value.kind = value;
}
</script>
<template>
  <dialog
    ref="dialog"
    class="record-dialog"
    aria-labelledby="record-dialog-title"
    @cancel.prevent="close"
    @keydown="onKeydown"
  >
    <form @submit.prevent="save">
      <div class="dialog-head">
        <h2 id="record-dialog-title">新建记录</h2>
        <button
          type="button"
          class="dialog-close"
          aria-label="关闭记录窗口"
          @click="close"
        >
          <Icon name="close" :size="15" />
        </button>
      </div>
      <div class="tabs" role="group" aria-label="记录类型">
        <button
          type="button"
          :class="{ active: form.kind === 'work' }"
          :aria-pressed="form.kind === 'work'"
          @click="setKind('work')"
        >
          记一条工作</button
        ><button
          type="button"
          :class="{ active: form.kind === 'idea' }"
          :aria-pressed="form.kind === 'idea'"
          @click="setKind('idea')"
        >
          记个想法
        </button>
      </div>
      <p v-if="existing.length" class="notice">
        此来源已有 {{ existing.length }} 条工作记录。请核对，避免重复录入。
      </p>
      <label
        >内容<textarea
          v-model="form.text"
          required
          rows="5"
          :placeholder="
            form.kind === 'idea'
              ? '想到的事，先记下来…'
              : '记录实际发生的工作，保存前可以修改…'
          "
        />
      </label>
      <div class="actions spaced">
        <span class="dialog-hint"
          >Ctrl + Enter 保存 · Esc 关闭</span
        >
        <div class="row">
          <button type="button" :disabled="busy" @click="close">取消</button
          ><button
            class="primary"
            :disabled="busy || !form.text?.trim()"
            :aria-busy="busy"
          >
            {{ busy ? "保存中…" : "保存记录" }}
          </button>
        </div>
      </div>
    </form>
  </dialog>
</template>

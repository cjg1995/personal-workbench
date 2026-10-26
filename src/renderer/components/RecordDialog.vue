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
import ProjectSelect from "./ProjectSelect.vue";
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
  busy.value = true;
  await attempt(async () => {
    await call("record.save", form.value);
    await reload();
    notify("已保存工作记录");
    recordModal.value = null;
  });
  busy.value = false;
}
</script>
<template>
  <dialog ref="dialog" class="record-dialog" @cancel.prevent="close">
    <form @submit.prevent="save">
      <h2>{{ form.kind === "idea" ? "记个想法" : "记一条工作" }}</h2>
      <p v-if="existing.length" class="notice">
        此来源已有 {{ existing.length }} 条工作记录。请核对，避免重复录入。
      </p>
      <label
        >内容<textarea
          v-model="form.text"
          required
          rows="6"
          placeholder="记录实际发生的工作，保存前可以修改…"
        />
      </label>
      <div class="row wrap">
        <ProjectSelect v-model="form.projectId" /><label
          v-if="form.kind === 'work'"
          class="inline-label"
          >发生日期<input
            v-model="form.happenedOn"
            type="date"
            aria-label="发生日期"
        /></label>
      </div>
      <label v-if="form.kind === 'work'"
        >实际结果（可选）<textarea v-model="form.result" rows="3" />
      </label>
      <div class="actions right">
        <button type="button" :disabled="busy" @click="close">取消</button
        ><button class="primary" :disabled="busy || !form.text?.trim()">
          {{ busy ? "保存中…" : "保存记录" }}
        </button>
      </div>
    </form>
  </dialog>
</template>

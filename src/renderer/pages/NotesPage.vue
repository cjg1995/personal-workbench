<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { Note } from "../../shared/types";
import {
  attempt,
  call,
  confirm,
  context,
  dateLabel,
  model,
  notify,
  openRecord,
  projectName,
  reload,
  setGuard,
  saveForm,
} from "../state";
import ProjectSelect from "../components/ProjectSelect.vue";
const props = defineProps<{ kind: "idea" | "work" }>();
const draft = model.formDrafts["note-add-" + props.kind] || {};
const text = ref(draft.text || ""),
  project = ref<string | null>(draft.projectId || null),
  date = ref(draft.happenedOn || model.today),
  busy = ref(false),
  query = ref(""),
  tab = ref(context.value.tab || "active"),
  month = ref(model.today.slice(0, 7)),
  filterProject = ref<string | null>(null),
  selected = ref<string | null>(context.value.selected || null);
watch(
  [text, project, date],
  () =>
    saveForm("note-add-" + props.kind, {
      text: text.value,
      projectId: project.value,
      happenedOn: date.value,
    }),
  { flush: "sync" },
);
const editor = ref<Note | null>(null);
const baseline = ref("");
const dirty = computed(
  () => !!editor.value && JSON.stringify(editor.value) !== baseline.value,
);
const all = computed(() => model.notes.filter((n) => n.kind === props.kind));
const filtered = computed(() =>
  all.value
    .filter(
      (n) =>
        (tab.value === "deleted" ? !!n.deletedAt : !n.deletedAt) &&
        (props.kind === "idea"
          ? tab.value === "completed"
            ? !!n.completedAt
            : tab.value === "deleted" || !n.completedAt
          : tab.value === "undated"
            ? !n.happenedOn
            : tab.value === "deleted" ||
              !month.value ||
              n.happenedOn?.startsWith(month.value)) &&
        (!filterProject.value || n.projectId === filterProject.value) &&
        (!query.value ||
          n.text.toLowerCase().includes(query.value.toLowerCase()) ||
          n.result.toLowerCase().includes(query.value.toLowerCase())),
    )
    .sort(
      (a, b) =>
        (b.happenedOn || "").localeCompare(a.happenedOn || "") ||
        b.createdAt.localeCompare(a.createdAt),
    ),
);
async function canLeave() {
  return (
    !dirty.value ||
    (await confirm(
      "有未保存修改",
      "切换后本次修改将丢弃，已保存记录仍保留。",
      "丢弃修改",
    ))
  );
}
setGuard(canLeave);
onBeforeUnmount(() => setGuard(null));
function loadEditor() {
  const n = all.value.find((n) => n.id === selected.value);
  editor.value = n ? JSON.parse(JSON.stringify(n)) : null;
  baseline.value = JSON.stringify(editor.value);
}
watch(
  () => props.kind,
  () => {
    tab.value = "active";
    selected.value = null;
    editor.value = null;
    baseline.value = "";
  },
);
watch(selected, loadEditor, { immediate: true });
watch(
  () => model.notes,
  () => {
    if (!dirty.value) loadEditor();
  },
);
async function select(n: Note) {
  if (!(await canLeave())) return;
  selected.value = n.id;
  loadEditor();
}
async function add() {
  busy.value = true;
  await attempt(async () => {
    const note = await call<Note>("record.save", {
      kind: props.kind,
      text: text.value,
      projectId: project.value,
      happenedOn: date.value,
    });
    text.value = "";
    await reload();
    if (!dirty.value) {
      selected.value = note.id;
      loadEditor();
    }
    notify("已保存");
  });
  busy.value = false;
}
async function save() {
  if (!editor.value) return;
  busy.value = true;
  await attempt(async () => {
    const updated = await call<Note>("record.save", editor.value);
    editor.value = updated;
    baseline.value = JSON.stringify(updated);
    await reload();
    notify("修改已保存");
  });
  busy.value = false;
}
async function complete() {
  if (!editor.value || !(await canLeave())) return;
  await attempt(async () => {
    await call("record.complete", {
      id: editor.value!.id,
      done: !editor.value!.completedAt,
    });
    baseline.value = "";
    editor.value = null;
    await reload();
    loadEditor();
    notify("状态已更新，未自动生成工作记录");
  });
}
async function remove() {
  if (!editor.value) return;
  await attempt(async () => {
    const n = await call("record.delete", { id: editor.value!.id });
    if (n) {
      editor.value = null;
      baseline.value = "";
      await reload();
      notify("已移入已删除列表，可恢复");
    }
  });
}
</script>
<template>
  <form class="note-add" @submit.prevent="add">
    <div v-if="kind === 'work'" class="row">
      <input
        v-model="date"
        type="date"
        aria-label="新记录发生日期"
      /><ProjectSelect v-model="project" />
    </div>
    <div class="row">
      <textarea
        v-model="text"
        :rows="kind === 'work' ? 2 : 1"
        required
        :placeholder="
          kind === 'idea' ? '想到的事，先记下来…' : '今天处理了什么…'
        "
        aria-label="新记录内容"
      /><button class="primary" :disabled="busy || !text.trim()">
        {{ kind === "idea" ? "添加" : "保存记录" }}
      </button>
    </div>
  </form>
  <div class="row wrap filters">
    <input
      v-if="kind === 'work'"
      v-model="month"
      type="month"
      aria-label="筛选月份"
    /><ProjectSelect v-model="filterProject" label="项目（全部）" /><input
      v-model="query"
      type="search"
      :placeholder="kind === 'idea' ? '搜索待办…' : '搜索关键词…'"
      aria-label="搜索记录"
    />
  </div>
  <div class="tabs">
    <button :class="{ active: tab === 'active' }" @click="tab = 'active'">
      {{
        kind === "idea"
          ? "未完成 " + all.filter((n) => !n.deletedAt && !n.completedAt).length
          : "按日期"
      }}</button
    ><button
      v-if="kind === 'idea'"
      :class="{ active: tab === 'completed' }"
      @click="tab = 'completed'"
    >
      已完成
      {{ all.filter((n) => !n.deletedAt && n.completedAt).length }}</button
    ><button
      v-else
      :class="{ active: tab === 'undated' }"
      @click="tab = 'undated'"
    >
      日期待补充
      {{ all.filter((n) => !n.deletedAt && !n.happenedOn).length }}</button
    ><button :class="{ active: tab === 'deleted' }" @click="tab = 'deleted'">
      已删除 {{ all.filter((n) => n.deletedAt).length }}
    </button>
  </div>
  <div class="columns note-layout">
    <section class="note-list">
      <p v-if="!filtered.length" class="empty">
        {{ query ? "没有匹配记录。" : "这里还没有记录。" }}
      </p>
      <button
        v-for="n in filtered"
        :key="n.id"
        class="note-row"
        :class="{ selected: selected === n.id, completed: !!n.completedAt }"
        @click="select(n)"
      >
        <strong>{{ n.text }}</strong
        ><small
          >{{
            kind === "work"
              ? n.happenedOn || "日期待补充"
              : n.importBatch
                ? "历史创建日期未指定"
                : dateLabel(n.createdAt)
          }}
          <span v-if="n.projectId">
            · {{ projectName(n.projectId) }}</span
          ></small
        >
      </button>
    </section>
    <section v-if="editor" class="note-detail">
      <h2>{{ kind === "idea" ? "待办详情" : "工作记录" }}</h2>
      <label
        >正文<textarea
          v-model="editor.text"
          rows="6"
          :disabled="!!editor.deletedAt"
          required
        /></label
      ><label v-if="kind === 'work'" class="row spaced"
        >发生日期<input
          v-model="editor.happenedOn"
          type="date"
          :disabled="!!editor.deletedAt" /></label
      ><label class="row spaced"
        >项目（可选）<ProjectSelect
          v-model="editor.projectId"
          :disabled="!!editor.deletedAt" /></label
      ><label v-if="kind === 'work'"
        >实际结果（可选）<textarea
          v-model="editor.result"
          rows="3"
          :disabled="!!editor.deletedAt"
        />
      </label>
      <p class="muted small">
        {{ editor.importBatch ? "导入时间" : "创建时间" }}
        {{ dateLabel(editor.createdAt) }}<br />修改时间
        {{ dateLabel(editor.updatedAt) }}
      </p>
      <p v-if="editor.importBatch" class="notice small">
        原文已保留，来源行
        {{ editor.sourceLine }}。<br />历史日期未依据文件修改时间推定。
      </p>
      <div v-if="editor.deletedAt" class="actions">
        <button
          class="primary"
          @click="
            attempt(async () => {
              await call('record.restore', { id: editor!.id });
              await reload();
              tab = 'active';
              loadEditor();
              notify('记录已恢复');
            })
          "
        >
          恢复记录
        </button>
      </div>
      <template v-else
        ><div class="actions wrap">
          <button
            class="primary"
            :disabled="busy || !dirty || !editor.text.trim()"
            @click="save"
          >
            保存修改</button
          ><button v-if="kind === 'idea'" @click="complete">
            {{ editor.completedAt ? "重新打开" : "标记完成" }}</button
          ><button :disabled="!dirty" @click="loadEditor">取消修改</button
          ><button class="danger text-button" @click="remove">删除记录</button>
        </div>
        <button
          v-if="kind === 'idea'"
          class="link section-rule"
          @click="
            openRecord({
              kind: 'work',
              text: editor.text,
              projectId: editor.projectId,
              sourceId: 'idea:' + editor.id,
            })
          "
        >
          记一条工作 →
        </button>
        <p v-if="kind === 'idea'" class="small muted">
          完成待办只改变状态。工作记录由你另行核对并保存。
        </p></template
      >
    </section>
    <section v-else class="empty">选择左侧记录，查看和编辑原文。</section>
  </div>
</template>

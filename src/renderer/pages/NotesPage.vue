<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
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
import Icon from "../components/Icon.vue";
const props = defineProps<{ kind: "idea" | "work" }>();
const draft = model.formDrafts["note-add-" + props.kind] || {};
const text = ref(draft.text || ""),
  busy = ref(false),
  query = ref(""),
  tab = ref(context.value.tab || "active"),
  month = ref(model.today.slice(0, 7)),
  selected = ref<string | null>(context.value.selected || null);
watch(
  text,
  () => saveForm("note-add-" + props.kind, { text: text.value }),
  { flush: "sync" },
);
const editor = ref<Note | null>(null);
const composer = ref<HTMLTextAreaElement>();
const focusComposer = () => composer.value?.focus();
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
        (!query.value ||
          n.text.toLowerCase().includes(query.value.toLowerCase())),
    )
    .sort(
      (a, b) =>
        (b.happenedOn || "").localeCompare(a.happenedOn || "") ||
        b.createdAt.localeCompare(a.createdAt),
    ),
);
const listOnly = computed(() => !editor.value && !filtered.value.length);
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
onMounted(() => {
  if (!selected.value) {
    const first = filtered.value[0];
    if (first) selected.value = first.id;
  }
  focusComposer();
});
async function select(n: Note) {
  if (!(await canLeave())) return;
  selected.value = n.id;
  loadEditor();
}
async function add() {
  if (busy.value || !text.value.trim()) return;
  busy.value = true;
  await attempt(async () => {
    const note = await call<Note>("record.save", {
      kind: props.kind,
      text: text.value,
      happenedOn: model.today,
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
function onComposerKeydown(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
  event.preventDefault();
  void add();
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
    <textarea
      ref="composer"
      v-model="text"
      :rows="2"
      required
      :placeholder="
        kind === 'idea' ? '想到的事，先记下来…' : '今天处理了什么…'
      "
      aria-label="新记录内容"
      @keydown="onComposerKeydown"
    />
    <div class="composer-foot">
      <div class="composer-actions">
        <span class="shortcut-hint" aria-hidden="true">Ctrl + Enter</span>
        <button
          class="primary"
          :disabled="busy || !text.trim()"
          :aria-busy="busy"
          title="Ctrl+Enter 快捷保存"
        >
          保存记录
        </button>
      </div>
    </div>
  </form>
  <div class="row wrap filters">
    <input
      v-if="kind === 'work'"
      v-model="month"
      type="month"
      aria-label="筛选月份"
    /><input
      v-model="query"
      type="search"
      :placeholder="kind === 'idea' ? '搜索待办…' : '搜索关键词…'"
      aria-label="搜索记录"
    />
  </div>
  <div class="tabs" role="group" aria-label="记录状态">
    <button
      :class="{ active: tab === 'active' }"
      :aria-pressed="tab === 'active'"
      @click="tab = 'active'"
    >
      {{
        kind === "idea" ? "未完成" : "按日期"
      }}<span class="tab-count">{{
        kind === "idea"
          ? all.filter((n) => !n.deletedAt && !n.completedAt).length
          : all.filter((n) => !n.deletedAt).length
      }}</span></button
    ><button
      v-if="kind === 'idea'"
      :class="{ active: tab === 'completed' }"
      :aria-pressed="tab === 'completed'"
      @click="tab = 'completed'"
    >
      已完成<span class="tab-count">{{
        all.filter((n) => !n.deletedAt && n.completedAt).length
      }}</span></button
    ><button
      v-else
      :class="{ active: tab === 'undated' }"
      :aria-pressed="tab === 'undated'"
      @click="tab = 'undated'"
    >
      日期待补充<span class="tab-count">{{
        all.filter((n) => !n.deletedAt && !n.happenedOn).length
      }}</span></button
    ><button
      :class="{ active: tab === 'deleted' }"
      :aria-pressed="tab === 'deleted'"
      @click="tab = 'deleted'"
    >
      已删除<span class="tab-count">{{
        all.filter((n) => n.deletedAt).length
      }}</span>
    </button>
  </div>
  <div class="columns note-layout" :class="{ single: listOnly }">
    <section class="note-list">
      <div v-if="!filtered.length" class="empty">
        <span class="empty-icon"
          ><Icon :name="query ? 'search' : 'list'" :size="16"
        /></span>
        <p class="empty-title">
          {{ query ? "没有匹配记录" : "这里还没有记录" }}
        </p>
        <p v-if="query" class="empty-hint">
          换个关键词，或清除搜索查看全部记录。
        </p>
        <p v-else class="empty-hint">
          {{
            kind === "idea"
              ? "想到什么就先记下来，之后再整理。"
              : "记录今天真实发生的工作，方便月度整理。"
          }}
        </p>
        <button v-if="query" class="link" @click="query = ''">清除搜索</button>
        <button v-else class="link" @click="focusComposer">写下第一条</button>
      </div>
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
      <div class="section-head">
        <h2>
          {{ kind === "idea" ? "待办详情" : "工作记录" }}
        </h2>
        <span v-if="dirty" class="chip warn">未保存</span>
      </div>
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
      >
      <p class="muted small">
        {{ editor.importBatch ? "导入时间" : "创建时间" }}
        {{ dateLabel(editor.createdAt) }} · 修改
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
          ><button class="danger text-button push-right" @click="remove">
            删除记录
          </button>
        </div>
        <button
          v-if="kind === 'idea'"
          class="link section-rule"
          @click="
            openRecord({
              kind: 'work',
              text: editor.text,
              sourceId: 'idea:' + editor.id,
            })
          "
        >
          记一条工作 →
        </button>
        <p v-if="kind === 'idea'" class="inline-note">
          完成待办只改变状态，不会自动生成工作记录。
        </p></template
      >
    </section>
    <section v-else-if="filtered.length" class="empty compact">
      <Icon name="pencil" :size="15" />
      <p class="empty-hint">选择一条记录查看和编辑</p>
    </section>
  </div>
</template>

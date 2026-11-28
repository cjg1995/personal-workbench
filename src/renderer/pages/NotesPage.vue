<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Note } from "../../shared/types";
import { deadlineFromInput, localDeadline } from "../../shared/todo-reminders";
import {
  attempt,
  call,
  choose,
  confirm,
  context,
  model,
  navigate,
  notify,
  projectName,
  reload,
  route,
  setGuard,
  saveForm,
} from "../state";
import {
  formatDateTime,
  formatFullDate,
  formatGroupDate,
  formatMonthDay,
  formatMonthTitle,
  formatNoteLabel,
  formatNotePreview,
  formatNoteText,
  formatTimeHM,
  getMonthDays,
  weekdayChar,
} from "../format";
import Icon from "../components/Icon.vue";

const props = defineProps<{ kind: "idea" | "work" }>();
const draft = model.formDrafts["note-add-" + props.kind] || {};
const prefilledText =
  props.kind === "work" && typeof context.value.draftText === "string"
    ? context.value.draftText
    : "";
const prefilledSourceId =
  props.kind === "work" && typeof context.value.sourceId === "string"
    ? context.value.sourceId
    : null;
const initialTab =
  props.kind === "idea" && context.value.tab === "completed"
    ? "completed"
    : "active";
const initialMonth =
  typeof context.value.month === "string"
    ? context.value.month
    : model.today.slice(0, 7);
const text = ref<string>(prefilledText || draft.text || ""),
  composerSourceId = ref<string | null>(prefilledSourceId),
  composerDate = ref<string>(model.today),
  composerDeadline = ref<string>(typeof draft.deadline === "string" ? draft.deadline : ""),
  busy = ref(false),
  query = ref(""),
  tab = ref<string>(initialTab),
  month = ref(initialMonth),
  selected = ref<string | null>(context.value.selected || null),
  editing = ref(false),
  monthPickerOpen = ref(false),
  pickerYear = ref(
    Number((initialMonth || model.today).slice(0, 4)) ||
      new Date().getFullYear(),
  );

const composer = ref<HTMLTextAreaElement>();
const editTextarea = ref<HTMLTextAreaElement>();
const workListRef = ref<HTMLElement>();
const editor = ref<Note | null>(null);
const baseline = ref("");
const nowMs = ref(Date.now());
let overdueTimer: ReturnType<typeof setInterval> | undefined;
const editDeadline = computed({
  get: () => localDeadline(editor.value?.dueAt),
  set: (value: string) => {
    if (!editor.value || (!value && !editor.value.dueAt)) return;
    try { editor.value.dueAt = deadlineFromInput(value); }
    catch { notify("请选择有效的截止时间", true); }
  },
});

function isOverdue(note: Note | null | undefined): boolean {
  if (!note || note.kind !== "idea" || note.completedAt || !note.dueAt) return false;
  const ts = Date.parse(note.dueAt);
  return Number.isFinite(ts) && ts < nowMs.value;
}

const currentYear = computed(
  () => Number(model.today.slice(0, 4)) || new Date().getFullYear(),
);
const currentMonth = computed(() => model.today.slice(0, 7));

function resizeComposer() {
  const el = composer.value;
  if (!el) return;
  el.style.height = "auto";
  const maxH = 160;
  const next = Math.min(el.scrollHeight, maxH);
  el.style.height = `${next}px`;
  el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
}

function clearComposer() {
  text.value = "";
  composerDeadline.value = "";
  composerSourceId.value = null;
  void nextTick(() => {
    resizeComposer();
    composer.value?.focus();
  });
}

watch(
  [text, composerDeadline],
  () => {
    saveForm("note-add-" + props.kind, {
      text: text.value,
      ...(props.kind === "idea" ? { deadline: composerDeadline.value } : {}),
    });
    void nextTick(resizeComposer);
  },
  { flush: "sync" },
);

watch(
  () => model.today,
  (today, prev) => {
    if (!composerDate.value || composerDate.value === prev) {
      composerDate.value = today;
    }
  },
);

const validComposerDate = computed(
  () =>
    props.kind !== "work" ||
    /^\d{4}-\d{2}-\d{2}$/.test(composerDate.value || ""),
);

const dirty = computed(
  () =>
    editing.value &&
    !!editor.value &&
    JSON.stringify(editor.value) !== baseline.value,
);

const validEditDate = computed(
  () =>
    props.kind !== "work" ||
    /^\d{4}-\d{2}-\d{2}$/.test(editor.value?.happenedOn || ""),
);

const canSaveEdit = computed(
  () =>
    !busy.value &&
    dirty.value &&
    !!editor.value?.text.trim() &&
    validEditDate.value,
);

const all = computed(() => model.notes.filter((n) => n.kind === props.kind));

/* 工作记录统计与月份索引 */
const monthRecords = computed(() =>
  all.value
    .filter((n) => !month.value || n.happenedOn?.startsWith(month.value))
    .sort(
      (a, b) =>
        (b.happenedOn || "").localeCompare(a.happenedOn || "") ||
        b.createdAt.localeCompare(a.createdAt),
    ),
);
const monthTitle = computed(() => formatMonthTitle(month.value));
const monthDays = computed(() =>
  month.value ? getMonthDays(month.value) : [],
);
const workActiveTabLabel = computed(() => {
  if (!month.value) return "全部记录";
  if (month.value === currentMonth.value) return "本月记录";
  if (month.value.startsWith(`${currentYear.value}-`)) {
    return `${monthTitle.value.monthNum}月记录`;
  }
  return `${monthTitle.value.year.replace(/\s+/g, "")}${monthTitle.value.monthNum}月记录`;
});
const dayCounts = computed(() => {
  const counts = new Map<string, number>();
  if (!month.value) return counts;
  for (const n of all.value) {
    if (n.happenedOn && n.happenedOn.startsWith(month.value)) {
      counts.set(n.happenedOn, (counts.get(n.happenedOn) || 0) + 1);
    }
  }
  return counts;
});
const monthsWithRecords = computed(() => {
  const set = new Set<string>();
  for (const n of all.value) {
    if (n.happenedOn) set.add(n.happenedOn.slice(0, 7));
  }
  return set;
});
const monthSummaryList = computed(() => {
  const counts = new Map<string, number>();
  for (const n of all.value) {
    if (n.happenedOn && /^\d{4}-\d{2}/.test(n.happenedOn)) {
      const ym = n.happenedOn.slice(0, 7);
      counts.set(ym, (counts.get(ym) || 0) + 1);
    }
  }
  return Array.from(counts.entries())
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([ym, count]) => {
      const y = Number(ym.slice(0, 4));
      const m = Number(ym.slice(5, 7));
      const label = y === currentYear.value ? `${m} 月` : `${y} 年 ${m} 月`;
      return { ym, label, count };
    });
});
const activeDay = computed(() =>
  month.value && editor.value?.happenedOn?.startsWith(month.value)
    ? editor.value.happenedOn
    : "",
);

/* 待办事项统计 */
const openIdeas = computed(() => all.value.filter((n) => !n.completedAt));
const completedIdeas = computed(() => all.value.filter((n) => !!n.completedAt));

/* 过滤后的列表 */
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return all.value
    .filter((n) => {
      if (props.kind === "idea") {
        return tab.value === "completed" ? !!n.completedAt : !n.completedAt;
      }
      return !month.value || n.happenedOn?.startsWith(month.value);
    })
    .filter((n) => !q || n.text.toLowerCase().includes(q))
    .sort((a, b) =>
      props.kind === "work"
        ? (b.happenedOn || "").localeCompare(a.happenedOn || "") ||
          b.createdAt.localeCompare(a.createdAt)
        : b.createdAt.localeCompare(a.createdAt),
    );
});

/* 工作记录在查看全部月份时按月份分组 */
const workGroups = computed(() => {
  if (month.value) {
    return [
      { key: month.value, title: monthTitle.value.label, items: filtered.value },
    ];
  }
  const map = new Map<string, { key: string; title: string; items: Note[] }>();
  for (const n of filtered.value) {
    const ym =
      n.happenedOn && /^\d{4}-\d{2}/.test(n.happenedOn)
        ? n.happenedOn.slice(0, 7)
        : "__undated__";
    let group = map.get(ym);
    if (!group) {
      group = {
        key: ym,
        title: ym === "__undated__" ? "未记录日期" : formatMonthTitle(ym).label,
        items: [],
      };
      map.set(ym, group);
    }
    group.items.push(n);
  }
  return Array.from(map.values());
});

/* 待办事项按创建日期分组 */
const ideaGroups = computed(() => {
  const map = new Map<
    string,
    { key: string; title: string; weekday: string; items: Note[] }
  >();
  for (const n of filtered.value) {
    const key = n.importBatch ? "__import__" : n.createdAt.slice(0, 10);
    let group = map.get(key);
    if (!group) {
      if (key === "__import__") {
        group = {
          key,
          title: "历史导入",
          weekday: "创建日期未指定",
          items: [],
        };
      } else {
        const formatted = formatGroupDate(key, currentYear.value);
        group = { key, ...formatted, items: [] };
      }
      map.set(key, group);
    }
    group.items.push(n);
  }
  return Array.from(map.values());
});

const editorText = computed(() => formatNoteText(editor.value?.text || ""));

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

function closeMonthPicker() {
  monthPickerOpen.value = false;
}

function onWindowKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && monthPickerOpen.value) {
    monthPickerOpen.value = false;
  }
}

onMounted(() => {
  window.addEventListener("click", closeMonthPicker);
  window.addEventListener("keydown", onWindowKeydown);
  window.addEventListener("resize", resizeComposer);
  if (props.kind === "idea") {
    overdueTimer = setInterval(() => {
      nowMs.value = Date.now();
    }, 30_000);
  }
  void nextTick(() => {
    resizeComposer();
    if (prefilledText) {
      saveForm("note-add-" + props.kind, { text: text.value });
      composer.value?.focus();
    }
  });
  if (!selected.value || !filtered.value.some((n) => n.id === selected.value)) {
    const first = filtered.value[0];
    if (first) selected.value = first.id;
  }
});

onBeforeUnmount(() => {
  setGuard(null);
  if (overdueTimer) clearInterval(overdueTimer);
  window.removeEventListener("click", closeMonthPicker);
  window.removeEventListener("keydown", onWindowKeydown);
  window.removeEventListener("resize", resizeComposer);
});

function loadEditor() {
  const n = all.value.find((item) => item.id === selected.value);
  editor.value = n ? JSON.parse(JSON.stringify(n)) : null;
  baseline.value = JSON.stringify(editor.value);
  editing.value = false;
}

watch(
  () => props.kind,
  () => {
    tab.value = "active";
    selected.value = null;
    editor.value = null;
    baseline.value = "";
    editing.value = false;
  },
);

watch(selected, loadEditor, { immediate: true });

watch(context, (destination) => {
  if (route.value !== "ideas" || props.kind !== "idea" || typeof destination.selected !== "string") return;
  tab.value = destination.tab === "completed" ? "completed" : "active";
  query.value = "";
  selected.value = destination.selected;
  loadEditor();
});

watch(
  () => model.notes,
  () => {
    if (!dirty.value) {
      const current = all.value.find((item) => item.id === selected.value);
      if (current) {
        editor.value = JSON.parse(JSON.stringify(current));
        baseline.value = JSON.stringify(editor.value);
      } else {
        selected.value = filtered.value[0]?.id || null;
        loadEditor();
      }
    }
  },
);

watch([tab, month, filtered], () => {
  if (dirty.value) return;
  if (!filtered.value.some((n) => n.id === selected.value)) {
    selected.value = filtered.value[0]?.id || null;
  }
});

async function switchTab(next: string) {
  if (next === tab.value) return;
  if (!(await canLeave())) return;
  tab.value = next;
  await nextTick();
  if (!filtered.value.some((n) => n.id === selected.value)) {
    selected.value = filtered.value[0]?.id || null;
  }
}

async function select(n: Note) {
  if (n.id === selected.value && !editing.value) return;
  if (!(await canLeave())) return;
  selected.value = n.id;
  loadEditor();
}

async function startEdit() {
  if (!editor.value) return;
  editing.value = true;
  await nextTick();
  editTextarea.value?.focus();
}

function cancelEdit() {
  loadEditor();
}

async function requestCancelEdit() {
  if (await canLeave()) cancelEdit();
}

async function copyNote() {
  const value = editor.value?.text;
  if (!value) return;
  await attempt(async () => {
    await call("clipboard.text", { text: value });
    notify("已复制到剪贴板");
  });
}

async function selectMonth(nextMonth: string) {
  const normalized = (nextMonth || "").trim();
  if (normalized === month.value) {
    monthPickerOpen.value = false;
    return;
  }
  if (!(await canLeave())) return;
  month.value = normalized;
  if (normalized) {
    pickerYear.value = Number(normalized.slice(0, 4)) || pickerYear.value;
  }
  monthPickerOpen.value = false;
  if (tab.value !== "active") tab.value = "active";
}

function toggleMonthPicker() {
  if (!monthPickerOpen.value) {
    pickerYear.value =
      Number((month.value || model.today).slice(0, 4)) ||
      new Date().getFullYear();
  }
  monthPickerOpen.value = !monthPickerOpen.value;
}

async function jumpToDay(dateStr: string, dayNum: number) {
  const onDay = monthRecords.value.filter((n) => n.happenedOn === dateStr);
  if (!onDay.length) {
    notify(`${monthTitle.value.monthNum} 月 ${dayNum} 日暂无工作记录`);
    return;
  }
  if (!(await canLeave())) return;
  tab.value = "active";
  if (
    query.value.trim() &&
    !onDay.some((n) =>
      n.text.toLowerCase().includes(query.value.trim().toLowerCase()),
    )
  ) {
    query.value = "";
  }
  const currentIdx = onDay.findIndex((n) => n.id === selected.value);
  const target = onDay[(currentIdx + 1) % onDay.length];
  selected.value = target.id;
  loadEditor();
  await nextTick();
  workListRef.value
    ?.querySelector<HTMLElement>(`[data-note-id="${target.id}"]`)
    ?.scrollIntoView({ block: "nearest", behavior: "smooth" });
}

async function add() {
  if (busy.value || !text.value.trim()) return;
  if (!validComposerDate.value) {
    notify("工作记录的发生日期不能为空", true);
    return;
  }
  busy.value = true;
  await attempt(async () => {
    const note = await call<Note>("record.save", {
      kind: props.kind,
      text: text.value,
      happenedOn: props.kind === "work" ? composerDate.value : model.today,
      dueAt: props.kind === "idea" ? deadlineFromInput(composerDeadline.value) : undefined,
      sourceId: props.kind === "work" ? composerSourceId.value : null,
    });
    text.value = "";
    composerDeadline.value = "";
    composerSourceId.value = null;
    if (props.kind === "work") {
      composerDate.value = model.today;
    }
    await nextTick(resizeComposer);
    await reload();
    if (
      props.kind === "work" &&
      month.value &&
      note.happenedOn &&
      !note.happenedOn.startsWith(month.value)
    ) {
      month.value = note.happenedOn.slice(0, 7);
    }
    if (tab.value !== "active") tab.value = "active";
    if (!dirty.value) {
      selected.value = note.id;
      loadEditor();
    }
    notify(props.kind === "idea" ? "已添加待办" : "已保存工作记录");
  });
  busy.value = false;
}

function onComposerKeydown(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
  event.preventDefault();
  void add();
}

function onEditKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    event.preventDefault();
    if (canSaveEdit.value) void save();
  } else if (event.key === "Escape") {
    event.preventDefault();
    void (async () => {
      if (await canLeave()) cancelEdit();
    })();
  }
}

async function save() {
  if (!editor.value || !editor.value.text.trim()) return;
  if (!validEditDate.value) {
    notify("发生日期不能为空，请选择有效日期", true);
    return;
  }
  busy.value = true;
  await attempt(async () => {
    const updated = await call<Note>("record.save", editor.value);
    editor.value = updated;
    baseline.value = JSON.stringify(updated);
    editing.value = false;
    await reload();
    if (
      props.kind === "work" &&
      updated.happenedOn &&
      tab.value === "active" &&
      month.value &&
      !updated.happenedOn.startsWith(month.value)
    ) {
      month.value = updated.happenedOn.slice(0, 7);
    }
    notify("修改已保存");
  });
  busy.value = false;
}

async function toggleComplete(target?: Note) {
  const item = target || editor.value;
  if (!item || busy.value) return;
  const isCurrent = editor.value?.id === item.id;
  const markingDone = !item.completedAt;
  let edit: Pick<Note, "text" | "dueAt"> | undefined;

  if (isCurrent && dirty.value && markingDone) {
    const canSave = !!editor.value?.text?.trim();
    const choice = await choose({
      tone: "question",
      title: "有未保存修改",
      message: canSave
        ? "可以先保存当前内容，再标记完成。"
        : "内容为空，无法保存。可以丢弃本次修改后标记完成。",
      buttons: canSave
        ? [
            { label: "取消", variant: "default" },
            { label: "丢弃修改", variant: "danger" },
            { label: "保存并完成", variant: "primary" },
          ]
        : [
            { label: "取消", variant: "default" },
            { label: "丢弃修改", variant: "danger" },
          ],
      defaultId: canSave ? 2 : 0,
      cancelId: 0,
    });
    if (!choice) return;
    if (choice === 2 && editor.value) edit = { text: editor.value.text, dueAt: editor.value.dueAt };
  } else if (dirty.value && !(await canLeave())) {
    return;
  }

  busy.value = true;
  await attempt(async () => {
    await call("record.complete", {
      id: item.id,
      done: markingDone,
      edit,
    });
    editing.value = false;
    baseline.value = "";
    await reload();
    await nextTick();
    if (!filtered.value.some((n) => n.id === selected.value)) {
      selected.value = filtered.value[0]?.id || null;
    }
    loadEditor();
    const targetId = item.id;
    const prevDone = !markingDone;
    notify(
      edit
        ? "已保存并标记完成"
        : markingDone
          ? "已标记完成"
          : "已重新打开待办",
      {
        action: {
          label: "撤销",
          run: async () => {
            await call("record.complete", { id: targetId, done: prevDone });
            await reload();
            tab.value = prevDone ? "completed" : "active";
            selected.value = targetId;
            loadEditor();
            notify(prevDone ? "已恢复为已完成" : "已恢复为未完成");
          },
        },
      },
    );
  });
  busy.value = false;
}

async function remove(note: Note) {
  if (busy.value) return;
  const targetId = note.id;
  const isIdea = note.kind === "idea";
  const wasCompleted = !!note.completedAt;
  const prevIndex = filtered.value.findIndex((n) => n.id === targetId);
  const wasSelected = selected.value === targetId;
  busy.value = true;
  try {
    await attempt(async () => {
      const removed = await call<Note | null>("record.delete", { id: targetId });
      if (!removed) return;
      if (wasSelected) {
        editing.value = false;
        baseline.value = "";
        selected.value = null;
        loadEditor();
      }
      await reload();
      if (wasSelected && !dirty.value) {
        const list = filtered.value;
        selected.value = list[Math.min(prevIndex, list.length - 1)]?.id ?? null;
        loadEditor();
      }
      notify(isIdea ? "待办已删除" : "记录已删除", {
        duration: 8000,
        action: {
          label: "撤销",
          run: async () => {
            const restored = await call<Note>("record.restore", { id: targetId });
            await reload();
            if (!dirty.value) {
              if (isIdea) tab.value = wasCompleted ? "completed" : "active";
              else if (
                month.value &&
                restored.happenedOn &&
                !restored.happenedOn.startsWith(month.value)
              ) {
                month.value = restored.happenedOn.slice(0, 7);
              }
              selected.value = restored.id;
              loadEditor();
            }
            notify(isIdea ? "已恢复待办" : "已恢复工作记录");
          },
        },
        onDismiss: () => {
          void call("record.purge", { id: targetId }).catch(() => {});
        },
      });
    });
  } finally {
    busy.value = false;
  }
}

async function createWorkFromIdea() {
  if (!editor.value) return;
  const sourceId = "idea:" + editor.value.id;
  const existing = model.notes.filter(
    (n) => n.kind === "work" && n.sourceId === sourceId,
  );
  if (
    existing.length &&
    !(await confirm(
      "已存在同来源工作记录",
      `该待办已生成 ${existing.length} 条工作记录，仍要前往再记一条吗？`,
      "继续记录",
    ))
  ) {
    return;
  }
  const pendingDraft = String(model.formDrafts["note-add-work"]?.text || "").trim();
  if (
    pendingDraft &&
    pendingDraft !== editor.value.text.trim() &&
    !(await confirm(
      "覆盖工作记录输入框内容",
      "工作记录顶部输入框已有未保存草稿，继续将替换为当前待办内容。",
      "覆盖草稿",
    ))
  ) {
    return;
  }
  await navigate("work", {
    draftText: editor.value.text,
    sourceId,
  });
}
</script>

<template>
  <form
    class="quick-entry"
    :class="{ focus: !!text.trim() }"
    :aria-label="kind === 'work' ? '新增工作记录' : '新增待办事项'"
    @submit.prevent="add"
  >
    <textarea
      ref="composer"
      v-model="text"
      class="entry-input"
      rows="1"
      :placeholder="kind === 'work' ? '记录今天的工作…' : '写下待办…'"
      :aria-label="kind === 'work' ? '新记录内容' : '新待办内容'"
      @input="resizeComposer"
      @keydown="onComposerKeydown"
    />
    <div class="entry-inline-actions">
      <span v-if="text.trim()" class="entry-char-count">{{ text.trim().length }} 字</span>
      <button
        v-if="text.trim() || (kind === 'idea' && composerDeadline)"
        type="button"
        class="text-action entry-clear"
        @click="clearComposer"
      >
        清空
      </button>
      <label
        v-if="kind === 'work'"
        class="entry-date-chip"
        :class="{ invalid: !validComposerDate }"
        title="发生日期"
      >
        <input v-model="composerDate" type="date" required aria-label="新记录发生日期" />
      </label>
      <label v-else class="entry-date-chip">
        <span class="entry-date-label">截止时间</span>
        <input v-model="composerDeadline" type="datetime-local" aria-label="新待办截止时间" />
        <button
          v-if="composerDeadline"
          type="button"
          class="chip-clear-btn"
          title="清除截止时间"
          aria-label="清除截止时间"
          @click.prevent="composerDeadline = ''"
        >
          <Icon name="close" :size="11" />
        </button>
      </label>
      <button
        type="submit"
        class="btn primary compact"
        :disabled="busy || !text.trim() || !validComposerDate"
        :aria-busy="busy"
        :title="kind === 'work' ? '保存记录（Ctrl+Enter）' : '添加待办（Ctrl+Enter）'"
      >
        {{ kind === 'work' ? '保存记录' : '添加待办' }}
      </button>
    </div>
  </form>

  <!-- ======================================================================
       工作记录页（01-工作记录.png）
       ====================================================================== -->
  <template v-if="kind === 'work'">
    <!-- 月份日期带 -->
    <div class="month-index card" :class="{ 'all-months': !month }">
      <div class="month-picker-wrap" @click.stop>
        <button
          type="button"
          class="month-name-btn"
          aria-label="切换月份"
          :aria-expanded="monthPickerOpen"
          @click="toggleMonthPicker"
        >
          <span class="year">{{ month ? monthTitle.year : "筛选月份" }}</span>
          <strong v-if="month">
            {{ monthTitle.monthNum }}<small>月</small>
            <Icon name="down" :size="13" />
          </strong>
          <strong v-else class="all-label">
            全部
            <Icon name="down" :size="13" />
          </strong>
        </button>

        <Transition name="pop">
          <div
            v-if="monthPickerOpen"
            class="month-popover"
            role="dialog"
            aria-label="选择月份"
          >
          <div class="month-popover-head">
            <button
              type="button"
              class="icon-btn small blank"
              aria-label="上一年"
              @click="pickerYear--"
            >
              <Icon name="arrow-left" :size="13" />
            </button>
            <strong>{{ pickerYear }} 年</strong>
            <button
              type="button"
              class="icon-btn small blank"
              aria-label="下一年"
              @click="pickerYear++"
            >
              <Icon name="arrow-right" :size="13" />
            </button>
          </div>
          <div class="month-popover-grid">
            <button
              v-for="m in 12"
              :key="m"
              type="button"
              :class="{
                active:
                  month === `${pickerYear}-${String(m).padStart(2, '0')}`,
              }"
              @click="
                selectMonth(`${pickerYear}-${String(m).padStart(2, '0')}`)
              "
            >
              {{ m }} 月
              <i
                v-if="
                  monthsWithRecords.has(
                    `${pickerYear}-${String(m).padStart(2, '0')}`,
                  )
                "
                class="month-dot"
                aria-hidden="true"
              />
            </button>
          </div>
          <div class="month-popover-foot">
            <input
              type="month"
              class="month-native-input"
              :value="month"
              aria-label="筛选月份"
              @change="selectMonth(($event.target as HTMLInputElement).value)"
            />
            <div class="month-popover-actions">
              <button
                type="button"
                class="text-action"
                :class="{ current: !month }"
                @click="selectMonth('')"
              >
                全部
              </button>
              <button
                type="button"
                class="text-action"
                :class="{ current: month === currentMonth }"
                @click="selectMonth(currentMonth)"
              >
                本月
              </button>
            </div>
          </div>
          </div>
        </Transition>
      </div>

      <div
        v-if="month"
        class="days"
        :style="{
          gridTemplateColumns: `repeat(${monthDays.length}, minmax(0, 1fr))`,
        }"
        role="group"
        aria-label="月份日期索引"
      >
        <button
          v-for="d in monthDays"
          :key="d.date"
          type="button"
          class="day"
          :class="{
            has: (dayCounts.get(d.date) || 0) > 0,
            selected: activeDay === d.date,
            today: d.date === model.today,
          }"
          :title="
            (dayCounts.get(d.date) || 0) > 0
              ? `${d.date}（周${d.weekday}）：${dayCounts.get(d.date)} 条工作记录`
              : `${d.date}（周${d.weekday}）`
          "
          :aria-pressed="activeDay === d.date"
          @click="jumpToDay(d.date, d.day)"
        >
          <span>{{ d.weekday }}</span>
          <strong>{{ d.dayStr }}</strong>
          <span v-if="d.date === model.today" class="today-label">今天</span>
          <div v-else class="points" aria-hidden="true">
            <i
              v-for="dot in Math.min(dayCounts.get(d.date) || 0, 3)"
              :key="dot"
            />
          </div>
        </button>
      </div>

      <div
        v-else
        class="all-months-strip"
        role="group"
        aria-label="全部月份快捷筛选"
      >
        <div class="month-chips">
          <span class="month-chip active">
            全部月份<small>{{ all.length }}</small>
          </span>
          <button
            v-for="item in monthSummaryList"
            :key="item.ym"
            type="button"
            class="month-chip"
            @click="selectMonth(item.ym)"
          >
            {{ item.label }}<small>{{ item.count }}</small>
          </button>
        </div>
        <button
          type="button"
          class="text-action all-months-today"
          @click="selectMonth(currentMonth)"
        >
          回到本月
        </button>
      </div>
    </div>

    <!-- 左右分栏 -->
    <div class="duo work-layout">
      <section class="card pane">
        <div class="panel-head spaced-head">
          <div class="head-title">
            <Icon name="list" :size="17" />
            <h2>{{ workActiveTabLabel }}</h2>
            <span class="count">{{ monthRecords.length }}</span>
          </div>
          <label class="search-box" style="margin: 0">
            <Icon name="search" :size="14" />
            <input
              v-model="query"
              type="search"
              placeholder="搜索记录"
              aria-label="搜索记录"
            />
          </label>
        </div>

        <div ref="workListRef" class="work-list">
          <div v-if="!filtered.length" class="empty">
            <span class="empty-icon">
              <Icon :name="query ? 'search' : 'note'" :size="16" />
            </span>
            <p class="empty-title">
              {{
                query
                  ? "没有匹配的工作记录"
                  : month
                    ? `${monthTitle.label}暂无工作记录`
                    : "暂无工作记录"
              }}
            </p>
            <button v-if="query" type="button" class="link" @click="query = ''">
              清除搜索
            </button>
          </div>

          <template v-else>
            <div
              v-for="group in workGroups"
              :key="group.key"
              class="work-month-group"
            >
              <div v-if="!month" class="work-month-head">
                <span>{{ group.title }}</span>
                <small>{{ group.items.length }} 条</small>
              </div>
              <div
                v-for="n in group.items"
                :key="n.id"
                class="work-item"
                :data-note-id="n.id"
                :class="{ selected: selected === n.id }"
              >
                <button
                  type="button"
                  class="note-select"
                  :aria-pressed="selected === n.id"
                  @click="select(n)"
                >
                  <span class="date-block">
                    <strong>{{
                      n.happenedOn ? n.happenedOn.slice(8, 10) : "--"
                    }}</strong>
                    <small>{{
                      n.happenedOn ? "周" + weekdayChar(n.happenedOn) : "未填"
                    }}</small>
                  </span>
                  <span class="grow">
                    <span class="item-title">{{ formatNotePreview(n.text) }}</span>
                    <span v-if="n.projectId" class="item-description">
                      {{ projectName(n.projectId) }}
                    </span>
                  </span>
                </button>
                <button
                  type="button"
                  class="list-delete-button"
                  :disabled="busy"
                  :aria-label="'删除工作记录 · ' + formatNoteLabel(n.text)"
                  title="删除工作记录"
                  @click="remove(n)"
                >
                  <Icon name="trash" :size="14" />
                </button>
              </div>
            </div>
          </template>
        </div>
      </section>

      <section class="card pane note-detail">
        <div class="panel-head spaced-head">
          <div class="head-title">
            <Icon name="document" :size="17" />
            <h2>记录详情</h2>
            <span v-if="dirty" class="badge pending">未保存</span>
          </div>
          <template v-if="editor">
            <div v-if="!editing" class="row" style="gap: 6px">
              <button
                type="button"
                class="icon-btn small blank"
                title="复制内容"
                aria-label="复制记录内容"
                @click="copyNote"
              >
                <Icon name="copy" :size="14" />
              </button>
              <button
                type="button"
                class="btn compact"
                @click="startEdit"
              >
                <Icon name="penbox" :size="14" />编辑记录
              </button>
            </div>
            <div v-else class="row" style="gap: 6px">
              <button type="button" class="btn compact" @click="requestCancelEdit">
                取消
              </button>
              <button
                type="button"
                class="btn primary compact"
                :disabled="!canSaveEdit"
                title="保存修改（Ctrl+Enter）"
                @click="save"
              >
                保存修改
              </button>
            </div>
          </template>
        </div>

        <template v-if="editor">
          <div class="detail-main">
            <template v-if="editing">
              <div class="detail-edit-form" @keydown="onEditKeydown">
                <label style="margin: 0">
                  正文内容
                  <textarea
                    ref="editTextarea"
                    v-model="editor.text"
                    rows="6"
                    placeholder="输入工作内容…"
                    required
                  />
                </label>
                <div class="detail-date-field">
                  <label class="detail-edit-row">
                    <span>发生日期 <em class="req-mark" aria-hidden="true">*</em></span>
                    <input
                      v-model="editor.happenedOn"
                      type="date"
                      required
                      :class="{ invalid: !validEditDate }"
                      aria-label="发生日期"
                    />
                  </label>
                  <p v-if="!validEditDate" class="field-error" role="alert">
                    发生日期不能为空，请选择有效日期
                  </p>
                </div>
              </div>
            </template>

            <template v-else>
              <article
                class="record-sheet editable"
                title="双击编辑"
                @dblclick="startEdit()"
              >
                <p class="record-content">{{ editorText }}</p>
              </article>
            </template>

            <dl class="record-fields">
              <div v-if="!editing">
                <dt><Icon name="calendar2" :size="14" />发生日期</dt>
                <dd>{{ formatFullDate(editor.happenedOn) }}</dd>
              </div>
              <div>
                <dt>
                  <Icon name="clockplus" :size="14" />{{
                    editor.importBatch ? "导入时间" : "创建时间"
                  }}
                </dt>
                <dd>{{ formatDateTime(editor.createdAt) }}</dd>
              </div>
              <div v-if="editor.updatedAt !== editor.createdAt">
                <dt><Icon name="history" :size="14" />最近修改</dt>
                <dd>{{ formatDateTime(editor.updatedAt) }}</dd>
              </div>
              <div v-if="editor.projectId">
                <dt><Icon name="folders" :size="14" />关联项目</dt>
                <dd>{{ projectName(editor.projectId) }}</dd>
              </div>
            </dl>

            <p v-if="editor.importBatch && editor.sourceLine" class="muted small" style="margin-top: 16px">
              导入源文件第 {{ editor.sourceLine }} 行
            </p>
          </div>
        </template>

        <div v-else class="empty empty-subtle" style="margin: auto">
          <span>{{ filtered.length ? "未选择记录" : "暂无详情" }}</span>
        </div>
      </section>
    </div>
  </template>

  <!-- ======================================================================
       待办事项页
       ====================================================================== -->
  <template v-else>
    <div class="duo ideas-layout">
      <!-- 左栏：待办清单 -->
      <section class="card pane">
        <div class="panel-head">
          <div class="head-title">
            <Icon name="checklist" :size="17" />
            <h2>待办清单</h2>
          </div>
          <label class="search-box" style="margin: 0">
            <Icon name="search" :size="14" />
            <input
              v-model="query"
              type="search"
              placeholder="搜索待办"
              aria-label="搜索待办"
            />
          </label>
        </div>

        <div class="tabs" role="tablist" aria-label="待办状态">
          <button
            type="button"
            role="tab"
            :class="{ active: tab === 'active' }"
            :aria-selected="tab === 'active'"
            @click="switchTab('active')"
          >
            未完成<span class="count">{{ openIdeas.length }}</span>
          </button>
          <button
            type="button"
            role="tab"
            :class="{ active: tab === 'completed' }"
            :aria-selected="tab === 'completed'"
            @click="switchTab('completed')"
          >
            已完成<span class="count">{{ completedIdeas.length }}</span>
          </button>
        </div>

        <div class="idea-groups">
          <div v-if="!filtered.length" class="empty" style="margin: auto">
            <span class="empty-icon">
              <Icon :name="query ? 'search' : 'idea'" :size="16" />
            </span>
            <p class="empty-title">
              {{
                query
                  ? "没有匹配的待办"
                  : tab === "completed"
                    ? "暂无已完成待办"
                    : "暂无待办"
              }}
            </p>
            <button v-if="query" type="button" class="link" @click="query = ''">
              清除搜索
            </button>
          </div>

          <section
            v-for="group in ideaGroups"
            :key="group.key"
            class="idea-group"
          >
            <h3>
              {{ group.title }}<span>{{ group.weekday }}</span>
            </h3>
            <div
              v-for="n in group.items"
              :key="n.id"
              class="idea-line"
              :class="{
                selected: selected === n.id,
                completed: !!n.completedAt,
              }"
            >
              <button
                type="button"
                class="radio-btn"
                :class="{ checked: !!n.completedAt }"
                :disabled="busy"
                :aria-label="
                  n.completedAt ? '重新打开此待办' : '标记此待办完成'
                "
                :title="n.completedAt ? '重新打开待办' : '标记完成'"
                @click="toggleComplete(n)"
              >
                <Icon name="check" :size="11" />
              </button>
              <button
                type="button"
                class="note-select"
                :aria-pressed="selected === n.id"
                @click="select(n)"
              >
                <span class="grow">
                  <span class="item-title">{{ formatNotePreview(n.text) }}</span>
                </span>
                <time
                  v-if="n.dueAt"
                  class="idea-time"
                  :class="{ overdue: isOverdue(n) }"
                  :datetime="n.dueAt"
                  :title="(isOverdue(n) ? '已逾期 · ' : '截止时间 ') + formatDateTime(n.dueAt)"
                >
                  {{ isOverdue(n) ? "已逾期 · " : "到期 " }}{{ formatDateTime(n.dueAt) }}
                </time>
                <span v-else-if="!n.importBatch" class="idea-time">{{
                  formatTimeHM(n.createdAt)
                }}</span>
              </button>
              <button
                type="button"
                class="list-delete-button"
                :disabled="busy"
                :aria-label="'删除待办 · ' + formatNoteLabel(n.text)"
                title="删除待办"
                @click="remove(n)"
              >
                <Icon name="trash" :size="14" />
              </button>
            </div>
          </section>
        </div>
      </section>

      <!-- 右栏：待办详情（撑满高度，与左栏齐平） -->
      <section class="card pane idea-detail note-detail">
        <div class="panel-head spaced-head">
          <div class="head-title">
            <Icon name="idea" :size="17" />
            <h2>待办详情</h2>
            <span v-if="dirty" class="badge pending">未保存</span>
          </div>
          <template v-if="editor">
            <div v-if="!editing" class="row" style="gap: 6px">
              <button
                type="button"
                class="icon-btn small blank"
                title="复制内容"
                aria-label="复制待办内容"
                @click="copyNote"
              >
                <Icon name="copy" :size="14" />
              </button>
              <button
                type="button"
                class="btn compact"
                @click="startEdit"
              >
                <Icon name="penbox" :size="14" />编辑
              </button>
            </div>
            <div v-else class="row" style="gap: 6px">
              <button type="button" class="btn compact" @click="requestCancelEdit">
                取消
              </button>
              <button
                type="button"
                class="btn primary compact"
                :disabled="busy || !dirty || !editor.text.trim()"
                title="保存修改（Ctrl+Enter）"
                @click="save"
              >
                保存修改
              </button>
            </div>
          </template>
        </div>

        <template v-if="editor">
          <div class="idea-article">
            <template v-if="editing">
              <div class="detail-edit-form" @keydown="onEditKeydown">
                <label style="margin: 0">
                  待办内容
                  <textarea
                    ref="editTextarea"
                    v-model="editor.text"
                    rows="6"
                    placeholder="输入待办详情…"
                    required
                  />
                </label>
                <div class="detail-edit-row todo-edit-deadline">
                  <label class="detail-edit-row-inner">
                    <span>截止时间</span>
                    <input v-model="editDeadline" type="datetime-local" />
                  </label>
                  <button
                    v-if="editDeadline"
                    type="button"
                    class="text-action"
                    @click="editDeadline = ''"
                  >
                    清除
                  </button>
                </div>
              </div>
            </template>

            <template v-else>
              <p
                class="idea-content editable"
                title="双击编辑"
                @dblclick="startEdit()"
              >
                {{ editorText }}
              </p>
            </template>

            <dl class="record-fields">
              <div v-if="editor.dueAt && !editing">
                <dt><Icon name="calendar2" :size="14" />截止时间</dt>
                <dd class="row" style="gap: 8px; align-items: center">
                  <time :datetime="editor.dueAt">{{ formatDateTime(editor.dueAt) }}</time>
                  <span v-if="isOverdue(editor)" class="badge danger">已逾期</span>
                </dd>
              </div>
              <div>
                <dt>
                  <Icon name="clockplus" :size="14" />{{
                    editor.importBatch ? "导入时间" : "创建时间"
                  }}
                </dt>
                <dd>{{ formatDateTime(editor.createdAt) }}</dd>
              </div>
              <div v-if="editor.updatedAt !== editor.createdAt">
                <dt><Icon name="history" :size="14" />最近修改</dt>
                <dd>{{ formatDateTime(editor.updatedAt) }}</dd>
              </div>
              <div v-if="editor.completedAt">
                <dt><Icon name="check-circle" :size="14" />完成时间</dt>
                <dd>{{ formatDateTime(editor.completedAt) }}</dd>
              </div>
            </dl>

            <div v-if="!editing" class="idea-action-row">
              <button
                type="button"
                class="btn"
                :class="editor.completedAt ? '' : 'primary'"
                :disabled="busy"
                title="只改变待办状态，不会自动生成工作记录"
                @click="toggleComplete()"
              >
                <Icon
                  :name="editor.completedAt ? 'refresh' : 'check'"
                  :size="15"
                />
                {{ editor.completedAt ? "重新打开" : "标记完成" }}
              </button>
            </div>
          </div>

          <div v-if="!editing" class="detail-foot">
            <button
              type="button"
              class="text-action"
              @click="createWorkFromIdea"
            >
              <Icon name="penbox" :size="14" />
              <span>记一条工作记录</span>
              <Icon name="arrow-right" :size="13" />
            </button>
          </div>
        </template>

        <div v-else class="empty empty-subtle" style="margin: auto">
          <span>{{ filtered.length ? "未选择待办" : "暂无详情" }}</span>
        </div>
      </section>
    </div>
  </template>
</template>

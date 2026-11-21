<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Note } from "../../shared/types";
import {
  attempt,
  call,
  choose,
  confirm,
  context,
  model,
  notify,
  openRecord,
  projectName,
  reload,
  setGuard,
  saveForm,
} from "../state";
import {
  formatDateTime,
  formatFullDate,
  formatGroupDate,
  formatMonthDay,
  formatMonthTitle,
  formatTimeHM,
  getMonthDays,
  splitNoteText,
  weekdayChar,
} from "../format";
import Icon from "../components/Icon.vue";

const props = defineProps<{ kind: "idea" | "work" }>();
const draft = model.formDrafts["note-add-" + props.kind] || {};
const initialTab =
  props.kind === "work" && context.value.tab === "undated"
    ? "active"
    : context.value.tab || "active";
const initialMonth =
  typeof context.value.month === "string"
    ? context.value.month
    : model.today.slice(0, 7);
const text = ref<string>(draft.text || ""),
  composerDate = ref<string>(model.today),
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

const currentYear = computed(
  () => Number(model.today.slice(0, 4)) || new Date().getFullYear(),
);
const currentMonth = computed(() => model.today.slice(0, 7));

function resizeComposer() {
  const el = composer.value;
  if (!el) return;
  el.style.height = "auto";
  const minH = 44;
  const maxH = 160;
  const next = Math.min(Math.max(el.scrollHeight, minH), maxH);
  el.style.height = `${next}px`;
  el.style.overflowY = el.scrollHeight > maxH ? "auto" : "hidden";
}

function clearComposer() {
  text.value = "";
  void nextTick(() => {
    resizeComposer();
    composer.value?.focus();
  });
}

watch(
  text,
  () => {
    saveForm("note-add-" + props.kind, { text: text.value });
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
const activeAll = computed(() => all.value.filter((n) => !n.deletedAt));
const deletedAll = computed(() => all.value.filter((n) => !!n.deletedAt));

/* 工作记录统计与月份索引 */
const monthRecords = computed(() =>
  activeAll.value
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
  return `${monthTitle.value.year.replace(/\s+/g, "")}${monthTitle.value.monthNum}月`;
});
const dayCounts = computed(() => {
  const counts = new Map<string, number>();
  if (!month.value) return counts;
  for (const n of activeAll.value) {
    if (n.happenedOn && n.happenedOn.startsWith(month.value)) {
      counts.set(n.happenedOn, (counts.get(n.happenedOn) || 0) + 1);
    }
  }
  return counts;
});
const monthsWithRecords = computed(() => {
  const set = new Set<string>();
  for (const n of activeAll.value) {
    if (n.happenedOn) set.add(n.happenedOn.slice(0, 7));
  }
  return set;
});
const monthSummaryList = computed(() => {
  const counts = new Map<string, number>();
  for (const n of activeAll.value) {
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
  month.value &&
  tab.value === "active" &&
  editor.value?.happenedOn?.startsWith(month.value)
    ? editor.value.happenedOn
    : "",
);

/* 灵感待办统计 */
const openIdeas = computed(() => activeAll.value.filter((n) => !n.completedAt));
const completedIdeas = computed(() =>
  activeAll.value.filter((n) => !!n.completedAt),
);
const ideaTotal = computed(
  () => openIdeas.value.length + completedIdeas.value.length,
);

/* 过滤后的列表 */
const filtered = computed(() => {
  const q = query.value.trim().toLowerCase();
  return all.value
    .filter((n) => {
      if (tab.value === "deleted") return !!n.deletedAt;
      if (n.deletedAt) return false;
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

/* 灵感待办按创建日期分组 */
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

const editorParts = computed(() => splitNoteText(editor.value?.text || ""));

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

onMounted(() => {
  window.addEventListener("click", closeMonthPicker);
  window.addEventListener("resize", resizeComposer);
  void nextTick(resizeComposer);
  if (!selected.value || !filtered.value.some((n) => n.id === selected.value)) {
    const first = filtered.value[0];
    if (first) selected.value = first.id;
  }
});

onBeforeUnmount(() => {
  setGuard(null);
  window.removeEventListener("click", closeMonthPicker);
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

watch([tab, month], () => {
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
  if (!editor.value || editor.value.deletedAt) return;
  editing.value = true;
  await nextTick();
  editTextarea.value?.focus();
}

function cancelEdit() {
  loadEditor();
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
    });
    text.value = "";
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
  if (!item || item.deletedAt || busy.value) return;
  const isCurrent = editor.value?.id === item.id;
  const markingDone = !item.completedAt;
  let savedFirst = false;

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
    if (choice === 2) {
      busy.value = true;
      const updated = await attempt(() =>
        call<Note>("record.save", editor.value),
      );
      busy.value = false;
      if (!updated) return;
      editor.value = updated;
      baseline.value = JSON.stringify(updated);
      editing.value = false;
      savedFirst = true;
    }
  } else if (dirty.value && !(await canLeave())) {
    return;
  }

  busy.value = true;
  await attempt(async () => {
    await call("record.complete", {
      id: item.id,
      done: markingDone,
    });
    editing.value = false;
    baseline.value = "";
    await reload();
    await nextTick();
    if (!filtered.value.some((n) => n.id === selected.value)) {
      selected.value = filtered.value[0]?.id || null;
    }
    loadEditor();
    notify(
      savedFirst
        ? "已保存并标记完成，未自动生成工作记录"
        : markingDone
          ? "已标记完成，未自动生成工作记录"
          : "已重新打开待办",
    );
  });
  busy.value = false;
}

async function remove() {
  if (!editor.value || busy.value) return;
  busy.value = true;
  await attempt(async () => {
    const n = await call("record.delete", { id: editor.value!.id });
    if (n) {
      editing.value = false;
      editor.value = null;
      baseline.value = "";
      await reload();
      selected.value = filtered.value[0]?.id || null;
      loadEditor();
      notify("已移入已删除列表，可随时恢复");
    }
  });
  busy.value = false;
}

async function restore() {
  if (!editor.value || busy.value) return;
  busy.value = true;
  await attempt(async () => {
    const id = editor.value!.id;
    await call("record.restore", { id });
    await reload();
    tab.value =
      props.kind === "idea" && editor.value?.completedAt
        ? "completed"
        : "active";
    selected.value = id;
    loadEditor();
    notify("记录已恢复");
  });
  busy.value = false;
}
</script>

<template>
  <!-- ======================================================================
       工作记录页（01-工作记录.png）
       ====================================================================== -->
  <template v-if="kind === 'work'">
    <div class="page-head notes-head">
      <div class="page-head-title">
        <h1>工作记录</h1>
      </div>
      <form
        class="quick-entry quick-entry-inline"
        :class="{ focus: !!text.trim() }"
        @submit.prevent="add"
      >
        <textarea
          ref="composer"
          v-model="text"
          class="entry-input"
          rows="1"
          placeholder="记录今天的工作…"
          aria-label="新记录内容"
          @input="resizeComposer"
          @keydown="onComposerKeydown"
        />
        <div class="entry-inline-actions">
          <label
            class="entry-date-chip"
            :class="{ invalid: !validComposerDate }"
            title="发生日期"
          >
            <input
              v-model="composerDate"
              type="date"
              required
              aria-label="新记录发生日期"
            />
          </label>
          <span v-if="text.trim()" class="entry-char-count">
            {{ text.trim().length }} 字
          </span>
          <button
            v-if="text.trim()"
            type="button"
            class="text-action entry-clear"
            @click="clearComposer"
          >
            清空
          </button>
          <button
            type="submit"
            class="btn primary compact"
            :disabled="busy || !text.trim() || !validComposerDate"
            :aria-busy="busy"
            title="保存记录（Ctrl+Enter）"
          >
            保存记录
          </button>
        </div>
      </form>
    </div>

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
        <button
          v-if="month"
          type="button"
          class="month-clear-btn"
          title="清空月份筛选，查看所有月份的工作记录"
          @click="selectMonth('')"
        >
          <span>查看全部</span>
        </button>

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
                @click="selectMonth(currentMonth)"
              >
                本月
              </button>
            </div>
          </div>
        </div>
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
            全部月份<small>{{ activeAll.length }}</small>
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
          <span v-if="!monthSummaryList.length" class="all-months-empty">
            当前展示所有月份的工作记录
          </span>
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
        <div class="panel-head">
          <div class="head-title">
            <Icon name="list" :size="17" />
            <h2>记录列表</h2>
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

        <div class="tabs" role="tablist" aria-label="记录状态">
          <button
            type="button"
            role="tab"
            :class="{ active: tab === 'active' }"
            :aria-selected="tab === 'active'"
            @click="switchTab('active')"
          >
            {{ workActiveTabLabel }}<span class="count">{{ monthRecords.length }}</span>
          </button>
          <button
            type="button"
            role="tab"
            :class="{ active: tab === 'deleted' }"
            :aria-selected="tab === 'deleted'"
            @click="switchTab('deleted')"
          >
            已删除<span class="count">{{ deletedAll.length }}</span>
          </button>
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
                  : tab === "deleted"
                    ? "没有已删除记录"
                    : month
                      ? `${monthTitle.label}暂无工作记录`
                      : "暂无工作记录"
              }}
            </p>
            <button v-if="query" type="button" class="link" @click="query = ''">
              清除搜索
            </button>
          </div>

          <template v-else-if="!month && tab === 'active'">
            <section
              v-for="group in workGroups"
              :key="group.key"
              class="work-month-group"
            >
              <div class="work-month-head">
                <span>{{ group.title }}</span>
                <small>{{ group.items.length }} 条</small>
              </div>
              <button
                v-for="n in group.items"
                :key="n.id"
                type="button"
                class="work-item"
                :data-note-id="n.id"
                :class="{ selected: selected === n.id }"
                @click="select(n)"
              >
                <div class="date-block">
                  <strong>{{
                    n.happenedOn ? n.happenedOn.slice(8, 10) : "--"
                  }}</strong>
                  <small>{{
                    n.happenedOn ? "周" + weekdayChar(n.happenedOn) : "未填"
                  }}</small>
                </div>
                <div class="grow">
                  <div class="item-title">{{ splitNoteText(n.text).title }}</div>
                  <p v-if="splitNoteText(n.text).body">
                    {{ splitNoteText(n.text).body }}
                  </p>
                  <p v-else-if="n.projectId">
                    {{ projectName(n.projectId) }}
                  </p>
                </div>
                <Icon v-if="selected === n.id" name="chevron" :size="13" />
              </button>
            </section>
          </template>

          <template v-else>
            <button
              v-for="n in filtered"
              :key="n.id"
              type="button"
              class="work-item"
              :data-note-id="n.id"
              :class="{ selected: selected === n.id }"
              @click="select(n)"
            >
              <div class="date-block">
                <strong>{{
                  n.happenedOn ? n.happenedOn.slice(8, 10) : "--"
                }}</strong>
                <small>{{
                  n.happenedOn
                    ? tab === "deleted"
                      ? `${Number(n.happenedOn.slice(5, 7))}月`
                      : "周" + weekdayChar(n.happenedOn)
                    : "未填"
                }}</small>
              </div>
              <div class="grow">
                <div class="item-title">{{ splitNoteText(n.text).title }}</div>
                <p v-if="splitNoteText(n.text).body">
                  {{ splitNoteText(n.text).body }}
                </p>
                <p v-else-if="n.projectId">
                  {{ projectName(n.projectId) }}
                </p>
              </div>
              <Icon v-if="selected === n.id" name="chevron" :size="13" />
            </button>
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
          <template v-if="editor && !editor.deletedAt">
            <button
              v-if="!editing"
              type="button"
              class="btn compact"
              @click="startEdit"
            >
              <Icon name="penbox" :size="14" />编辑记录
            </button>
            <div v-else class="row" style="gap: 6px">
              <button type="button" class="btn compact" @click="cancelEdit">
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
            <template v-if="editing && !editor.deletedAt">
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
                class="record-sheet"
                :class="{ editable: !editor.deletedAt }"
                :title="!editor.deletedAt ? '双击编辑' : undefined"
                @dblclick="!editor.deletedAt && startEdit()"
              >
                <div class="sheet-kind">
                  <Icon name="note" :size="14" />
                  <span>正文</span>
                  <span
                    v-if="editor.deletedAt"
                    class="badge neutral"
                    style="margin-left: 6px"
                    >已删除</span
                  >
                </div>
                <h3
                  :class="{
                    'long-single':
                      !editorParts.body && editorParts.title.length > 68,
                  }"
                >
                  {{ editorParts.title }}
                </h3>
                <p v-if="editorParts.body">{{ editorParts.body }}</p>
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
              <div>
                <dt><Icon name="history" :size="14" />最近修改</dt>
                <dd>{{ formatDateTime(editor.updatedAt) }}</dd>
              </div>
              <div v-if="editor.projectId">
                <dt><Icon name="folders" :size="14" />关联项目</dt>
                <dd>{{ projectName(editor.projectId) }}</dd>
              </div>
            </dl>

            <p v-if="editor.importBatch" class="notice" style="margin-top: 16px">
              原文已保留，来源行 {{ editor.sourceLine }}。历史日期未依据文件修改时间推定。
            </p>
          </div>

          <div v-if="!editing" class="detail-foot">
            <button
              v-if="editor.deletedAt"
              type="button"
              class="btn primary compact"
              :disabled="busy"
              @click="restore"
            >
              恢复记录
            </button>
            <button
              v-else
              type="button"
              class="delete-action"
              :disabled="busy"
              @click="remove"
            >
              <Icon name="trash" :size="14" />删除记录
            </button>
          </div>
        </template>

        <div v-else class="empty empty-subtle" style="margin: auto">
          <span>{{ filtered.length ? "未选择记录" : "暂无详情" }}</span>
        </div>
      </section>
    </div>
  </template>

  <!-- ======================================================================
       灵感待办页
       ====================================================================== -->
  <template v-else>
    <div class="page-head notes-head">
      <div class="page-head-title">
        <h1>灵感待办</h1>
      </div>
      <form
        class="quick-entry quick-entry-inline"
        :class="{ focus: !!text.trim() }"
        @submit.prevent="add"
      >
        <textarea
          ref="composer"
          v-model="text"
          class="entry-input"
          rows="1"
          placeholder="记个想法…"
          aria-label="新记录内容"
          @input="resizeComposer"
          @keydown="onComposerKeydown"
        />
        <div class="entry-inline-actions">
          <span v-if="text.trim()" class="entry-char-count">
            {{ text.trim().length }} 字
          </span>
          <button
            v-if="text.trim()"
            type="button"
            class="text-action entry-clear"
            @click="clearComposer"
          >
            清空
          </button>
          <button
            type="submit"
            class="btn primary compact"
            :disabled="busy || !text.trim()"
            :aria-busy="busy"
            title="添加待办（Ctrl+Enter）"
          >
            添加待办
          </button>
        </div>
      </form>
    </div>

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
          <button
            type="button"
            role="tab"
            :class="{ active: tab === 'deleted' }"
            :aria-selected="tab === 'deleted'"
            @click="switchTab('deleted')"
          >
            已删除<span class="count">{{ deletedAll.length }}</span>
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
                    : tab === "deleted"
                      ? "没有已删除待办"
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
              role="button"
              tabindex="0"
              @click="select(n)"
              @keydown.enter="select(n)"
            >
              <button
                type="button"
                class="radio-btn"
                :class="{ checked: !!n.completedAt }"
                :disabled="busy || !!n.deletedAt"
                :aria-label="
                  n.completedAt ? '重新打开此待办' : '标记此待办完成'
                "
                :title="
                  n.deletedAt
                    ? '已删除'
                    : n.completedAt
                      ? '重新打开待办'
                      : '标记完成'
                "
                @click.stop="toggleComplete(n)"
              >
                <Icon name="check" :size="11" />
              </button>
              <div class="grow">
                <div class="item-title">{{ splitNoteText(n.text).title }}</div>
                <p v-if="splitNoteText(n.text).body">
                  {{ splitNoteText(n.text).body }}
                </p>
              </div>
              <span v-if="!n.importBatch" class="idea-time">{{
                formatTimeHM(n.createdAt)
              }}</span>
              <Icon v-if="selected === n.id" name="chevron" :size="13" />
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
          <template v-if="editor && !editor.deletedAt">
            <button
              v-if="!editing"
              type="button"
              class="btn compact"
              @click="startEdit"
            >
              <Icon name="penbox" :size="14" />编辑
            </button>
            <div v-else class="row" style="gap: 6px">
              <button type="button" class="btn compact" @click="cancelEdit">
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
            <template v-if="editing && !editor.deletedAt">
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
              </div>
            </template>

            <template v-else>
              <span
                class="badge"
                :class="
                  editor.deletedAt
                    ? 'neutral'
                    : editor.completedAt
                      ? 'live'
                      : 'pending'
                "
              >
                <i class="dot" />
                {{
                  editor.deletedAt
                    ? "已删除"
                    : editor.completedAt
                      ? "已完成"
                      : "未完成"
                }}
              </span>
              <h3
                :class="{
                  'long-single':
                    !editorParts.body && editorParts.title.length > 60,
                  editable: !editor.deletedAt,
                }"
                :title="!editor.deletedAt ? '双击编辑' : undefined"
                @dblclick="!editor.deletedAt && startEdit()"
              >
                {{ editorParts.title }}
              </h3>
              <p v-if="editorParts.body" class="idea-body">
                {{ editorParts.body }}
              </p>
            </template>

            <dl class="record-fields">
              <div>
                <dt>
                  <Icon name="clockplus" :size="14" />{{
                    editor.importBatch ? "导入时间" : "创建时间"
                  }}
                </dt>
                <dd>{{ formatDateTime(editor.createdAt) }}</dd>
              </div>
              <div>
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
                v-if="editor.deletedAt"
                type="button"
                class="btn primary"
                :disabled="busy"
                @click="restore"
              >
                恢复待办
              </button>
              <button
                v-else
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

          <div v-if="!editor.deletedAt && !editing" class="detail-foot">
            <button
              type="button"
              class="text-action"
              @click="
                openRecord({
                  kind: 'work',
                  text: editor.text,
                  sourceId: 'idea:' + editor.id,
                })
              "
            >
              <Icon name="penbox" :size="14" />
              <span>记一条工作记录</span>
              <Icon name="arrow-right" :size="13" />
            </button>
            <span class="push" />
            <button
              type="button"
              class="delete-action"
              :disabled="busy"
              @click="remove"
            >
              <Icon name="trash" :size="14" />删除
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

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { MonthlyDraft, Note } from "../../shared/types";
import { sections } from "../../shared/types";
import {
  attempt,
  call,
  confirm,
  context,
  model,
  navigate,
  notify,
  setGuard,
} from "../state";
import Icon from "../components/Icon.vue";
const month = ref(context.value.month || model.today.slice(0, 7)),
  draft = ref<MonthlyDraft | null>(null),
  materials = ref<Note[]>([]),
  sources = ref<any[]>([]),
  undated = ref(0),
  selected = ref<string[]>([]),
  section = ref(sections[0]),
  saveState = ref(""),
  dirty = ref(false),
  loading = ref(true),
  selectedEntries = ref<string[]>([]);
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: Promise<void> | null = null,
  unmounted = false;
const linked = computed(
  () => new Set(draft.value?.entries.flatMap((e) => e.sourceIds) || []),
);
const stateClass = computed(() =>
  saveState.value.includes("失败")
    ? "error"
    : saveState.value.includes("待保存") || saveState.value.includes("新修改")
      ? "pending"
      : "",
);
const sourceCount = computed(() =>
  sources.value.reduce((total, group) => total + group.sources.length, 0),
);
async function flush() {
  if (timer) clearTimeout(timer);
  if (pending) await pending;
  if (!dirty.value || !draft.value) return;
  const current = JSON.stringify(draft.value);
  saveState.value = "保存中…";
  pending = (async () => {
    try {
      const saved = await call<MonthlyDraft>("monthly.save", draft.value);
      if (current === JSON.stringify(draft.value)) {
        dirty.value = false;
        saveState.value =
          "草稿已保存 " +
          new Date(saved.updatedAt).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          });
      } else saveState.value = "仍有新修改待保存";
    } catch (e) {
      saveState.value = "保存失败，正文仍保留在页面";
      throw e;
    }
  })();
  try {
    await pending;
  } finally {
    pending = null;
  }
}
async function guard() {
  try {
    await flush();
    return (
      !dirty.value ||
      (await confirm(
        "月报尚未保存",
        "正文仍有修改，离开会丢弃当前页面未保存内容。",
        "丢弃并离开",
      ))
    );
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), true);
    return false;
  }
}
setGuard(guard);
onBeforeUnmount(() => {
  unmounted = true;
  setGuard(null);
  if (timer) clearTimeout(timer);
});
function edited() {
  dirty.value = true;
  saveState.value = "待保存";
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (!unmounted) void attempt(flush);
  }, 650);
}
async function load(replace = true) {
  loading.value = true;
  await attempt(async () => {
    const data = await call<any>("monthly.get", {
      month: month.value,
    });
    materials.value = data.materials;
    sources.value = data.sources;
    undated.value = data.undated;
    if (replace) {
      draft.value = data.draft;
      dirty.value = false;
      saveState.value = draft.value!.entries.length ? "草稿已读取" : "空白草稿";
      selected.value = [];
      selectedEntries.value = [];
    }
  });
  loading.value = false;
}
onMounted(() => load());
async function changeMonth(event: Event) {
  const next = (event.target as HTMLInputElement).value;
  if (!next) return;
  if (!(await guard())) {
    (event.target as HTMLInputElement).value = month.value;
    return;
  }
  month.value = next;
  await load();
}
async function addSources() {
  await attempt(async () => {
    await flush();
    draft.value = await call("monthly.add", {
      month: month.value,
      name: draft.value?.name || model.config?.name,
      section: section.value,
      ids: selected.value,
    });
    dirty.value = false;
    selected.value = [];
    await load(false);
    saveState.value = "草稿已保存";
    notify("已按原文加入正文，可继续编辑");
  });
}
function addManual(section: string) {
  if (!draft.value) return;
  draft.value.entries.push({
    id: crypto.randomUUID(),
    section,
    text: "",
    sourceIds: [],
    sourceVersions: {},
    manual: true,
  });
  edited();
}
function move(entryId: string, delta: number) {
  if (!draft.value) return;
  const list = draft.value.entries,
    i = list.findIndex((e) => e.id === entryId),
    j = i + delta;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  edited();
}
async function remove(entryId: string) {
  if (!draft.value) return;
  if (
    !(await confirm(
      "删除月报条目",
      "只从当前月报正文中删除此条，不删除原始工作记录。",
      "删除条目",
    ))
  )
    return;
  draft.value.entries = draft.value.entries.filter((e) => e.id !== entryId);
  edited();
}
function merge() {
  if (!draft.value || selectedEntries.value.length < 2) return;
  const entries = draft.value.entries.filter((e) =>
    selectedEntries.value.includes(e.id),
  );
  const first = entries[0];
  first.text = entries.map((e) => e.text).join("\n");
  first.sourceIds = Array.from(new Set(entries.flatMap((e) => e.sourceIds)));
  first.sourceVersions = Object.assign(
    {},
    ...entries.map((e) => e.sourceVersions),
  );
  first.manual = first.sourceIds.length === 0;
  draft.value.entries = draft.value.entries.filter(
    (e) => e.id === first.id || !selectedEntries.value.includes(e.id),
  );
  selectedEntries.value = [];
  edited();
}
async function exportFile() {
  await attempt(async () => {
    await flush();
    const result = await call("monthly.export", {
      month: month.value,
    });
    notify(result ? "文件已写入：" + result.path : "已取消导出");
  });
}
async function copy() {
  await attempt(async () => {
    await flush();
    await call("monthly.copy", { month: month.value });
    notify("已复制当前月报正文");
  });
}
</script>
<template>
  <div class="toolbar">
    <input
      type="month"
      :value="month"
      aria-label="月报月份"
      @change="changeMonth"
    /><span
      class="save-state"
      :class="stateClass"
      role="status"
      >{{ saveState }}</span
    >
    <div class="row push-right">
      <button :disabled="!draft" @click="copy()">复制正文</button
      ><button class="primary" :disabled="!draft" @click="exportFile()">
        导出 Word
      </button>
    </div>
  </div>
  <div
    v-if="draft"
    class="monthly-layout"
    :class="{ 'no-sources': !sources.length }"
  >
    <section>
      <div class="section-head">
        <h2>本月素材</h2>
        <button class="link small" @click="load(false)">刷新</button>
      </div>
      <p v-if="!materials.length" class="empty compact">
        本月还没有日期明确的工作记录。
      </p>
      <div v-for="n in materials" :key="n.id" class="material">
        <label
          ><span
            v-if="linked.has(n.id)"
            class="material-check"
            aria-hidden="true"
            ><Icon name="check" :size="13" /></span
          ><input
            v-else
            v-model="selected"
            type="checkbox"
            :value="n.id"
          /><span
            ><time class="date">{{ n.happenedOn }}</time
            >{{ n.text
            }}<span v-if="linked.has(n.id)" class="material-state"
              >已加入正文</span
            ></span
          ></label
        >
      </div>
      <div v-if="materials.length" class="material-actions">
        <label class="field-stack"
          >放入章节<select v-model="section">
            <option v-for="s in sections" :key="s">{{ s }}</option>
          </select></label
        ><button
          class="primary"
          :disabled="!selected.length"
          @click="addSources"
        >
          {{ selected.length ? "加入正文 " + selected.length : "加入正文" }}
        </button>
      </div>
      <p v-if="undated" class="inline-note warn">
        {{ undated }} 条工作记录日期待补充，尚未计入本月。<button
          class="link"
          @click="navigate('work', { tab: 'undated' })"
        >
          去补日期 →
        </button>
      </p>
    </section>
    <section>
      <div class="doc-meta">
        <span>姓名</span
        ><input v-model="draft.name" aria-label="月报姓名" @input="edited" />
      </div>
      <h2 class="doc-title">
        {{ Number(month.slice(0, 4)) }}年{{
          Number(month.slice(5))
        }}月工作总结-{{ draft.name }}
      </h2>
      <p class="inline-note">
        Word 从「一、工作成果」开始，截图位置留一个空行；学习成长和工作计划多条内容时自动编号。
      </p>
      <button
        v-if="selectedEntries.length > 1"
        class="link"
        @click="merge"
      >
        合并所选 {{ selectedEntries.length }} 条正文</button
      ><template v-for="(s, index) in sections" :key="s"
        ><h2 v-if="index === 0" class="section-rule">一、工作成果</h2>
        <h3 v-if="index < 2">{{ index + 1 }}. {{ s }}</h3>
        <h2 v-else class="section-rule">
          {{ index === 2 ? "二、" : index === 3 ? "三、" : "四、" }}{{ s }}
        </h2>
        <div
          v-for="e in draft.entries.filter((e) => e.section === s)"
          :key="e.id"
          class="monthly-entry"
        >
          <textarea
            v-model="e.text"
            rows="3"
            :aria-label="s + '正文'"
            placeholder="在此人工编辑正文…"
            @input="edited"
          />
          <div class="row">
            <input
              v-model="selectedEntries"
              type="checkbox"
              :value="e.id"
              :aria-label="'选择正文 ' + e.text.slice(0, 20)"
            /><small class="muted">{{
              e.manual ? "手动补充" : "来源 " + e.sourceIds.length + " 条"
            }}</small
            ><select
              v-model="e.section"
              aria-label="调整条目章节"
              @change="edited"
            >
              <option v-for="section in sections" :key="section">
                {{ section }}
              </option></select
            ><button aria-label="上移条目" @click="move(e.id, -1)">↑</button
            ><button aria-label="下移条目" @click="move(e.id, 1)">↓</button
            ><button class="danger text-button" @click="remove(e.id)">
              移除
            </button>
          </div>
        </div>
        <p
          v-if="!draft.entries.some((e) => e.section === s)"
          class="small muted"
        >
          留空待填写。
        </p>
        <button class="link small" @click="addManual(s)">
          ＋ 手动补充
        </button></template
      >
      <p class="inline-note section-rule">
        正文修改自动保存；材料刷新不会覆盖已编辑内容。
      </p>
    </section>
    <section v-if="sources.length">
      <div class="section-head">
        <h2>来源核对</h2>
        <span class="tab-count">{{ sourceCount }}</span>
      </div>
      <template v-for="group in sources" :key="group.entryId"
        ><div v-for="s in group.sources" :key="s.id" class="source-block">
          <p v-if="s.deleted" class="notice warning">
            原始记录已删除，月报正文仍保留。
          </p>
          <template v-else
            ><time class="muted small">{{
              s.note.happenedOn || "日期待补充"
            }}</time>
            <p>
              {{ s.note.text }}<br v-if="s.note.result" />{{ s.note.result }}
            </p>
            <span v-if="s.changed" class="inline-note warn"
              >来源已变化，保留现有正文，请人工核对。</span
            ><button
              class="link small"
              @click="navigate('work', { selected: s.id })"
            >
              查看原记录 →
            </button></template
          >
        </div></template
      >
      <p class="inline-note section-rule">
        无日期记录和待办不会自动成为本月已完成成果。
      </p>
    </section>
  </div>
  <p v-else-if="loading" class="loading">正在读取月报草稿…</p>
  <div v-else class="empty">
    <span class="empty-icon"><Icon name="chart" :size="16" /></span>
    <p class="empty-title">暂时没有月报草稿</p>
    <p class="empty-hint">重新选择月份，或稍后重试读取。</p>
    <button class="link" @click="load()">重新读取</button>
  </div>
</template>

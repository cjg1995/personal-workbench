<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { Prompt } from "../../shared/types";
import {
  extractPromptVariables,
  hasActualVariableValue,
  normalizePromptTags,
  promptCharCount,
  replacePromptVariables,
  tokenizePrompt,
} from "../../shared/prompt-template";
import {
  attempt,
  call,
  confirm,
  context,
  leaveGuard,
  model,
  notify,
  reload,
  setGuard,
} from "../state";
import { activeDialog } from "../dialog";
import Icon from "../components/Icon.vue";
import "../prompts.css";

type PromptTab = "all" | "favorites" | "deleted";

interface EditorDraft {
  id: string | null;
  title: string;
  tags: string[];
  body: string;
  initial: string;
}

interface FillSession {
  prompt: Prompt;
  names: string[];
  values: Record<string, string>;
  pending: boolean;
}

interface CopyErrorState {
  text: string;
  error: string;
  fromFill: boolean;
  retrying: boolean;
}

const tab = ref<PromptTab>("all");
const search = ref("");
const selectedTag = ref("");
const selectedId = ref<string | null>(null);
const saving = ref(false);
const busyAction = ref(false);

const editor = ref<EditorDraft | null>(null);
const tagInput = ref("");

const fillSession = ref<FillSession | null>(null);
const copyError = ref<CopyErrorState | null>(null);

const titleInputRef = ref<HTMLInputElement>();
const tagInputRef = ref<HTMLInputElement>();
const bodyInputRef = ref<HTMLTextAreaElement>();
const fillDialogRef = ref<HTMLDialogElement>();
const copyErrorDialogRef = ref<HTMLDialogElement>();
const manualCopyAreaRef = ref<HTMLTextAreaElement>();

const allPrompts = computed(() => model.prompts || []);

const counts = computed(() => {
  let all = 0;
  let favorites = 0;
  let deleted = 0;
  for (const item of allPrompts.value) {
    if (item.deletedAt) {
      deleted++;
    } else {
      all++;
      if (item.starred) favorites++;
    }
  }
  return { all, favorites, deleted };
});

const availableTags = computed(() => {
  const scope = allPrompts.value.filter((p) =>
    tab.value === "deleted" ? !!p.deletedAt : !p.deletedAt,
  );
  const set = new Set<string>();
  for (const item of scope) {
    for (const tag of item.tags) set.add(tag);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b, "zh-CN"));
});

watch(availableTags, (tags) => {
  if (selectedTag.value && !tags.includes(selectedTag.value)) {
    selectedTag.value = "";
  }
});

const visiblePrompts = computed(() => {
  const needle = search.value.trim().toLocaleLowerCase();
  return allPrompts.value
    .filter((p) => {
      if (tab.value === "deleted" ? !p.deletedAt : !!p.deletedAt) return false;
      if (tab.value === "favorites" && !p.starred) return false;
      if (selectedTag.value && !p.tags.includes(selectedTag.value)) return false;
      if (!needle) return true;
      return [p.title, p.body, ...p.tags].some((text) =>
        text.toLocaleLowerCase().includes(needle),
      );
    })
    .sort((a, b) => {
      const left = tab.value === "deleted" ? a.deletedAt || "" : a.updatedAt;
      const right = tab.value === "deleted" ? b.deletedAt || "" : b.updatedAt;
      return Date.parse(right) - Date.parse(left) || a.id.localeCompare(b.id);
    });
});

watch(
  visiblePrompts,
  (list) => {
    if (!list.some((p) => p.id === selectedId.value)) {
      selectedId.value = list[0]?.id ?? null;
    }
  },
  { immediate: true },
);

const selectedPrompt = computed<Prompt | null>(
  () => visiblePrompts.value.find((p) => p.id === selectedId.value) ?? null,
);

const selectedTokens = computed(() =>
  selectedPrompt.value ? tokenizePrompt(selectedPrompt.value.body) : [],
);

const selectedVariables = computed(() =>
  selectedPrompt.value ? extractPromptVariables(selectedPrompt.value.body) : [],
);

const isFiltering = computed(
  () => Boolean(search.value.trim() || selectedTag.value),
);

const editorDirty = computed(() => {
  const e = editor.value;
  if (!e) return false;
  if (tagInput.value.trim().length > 0) return true;
  return (
    JSON.stringify({ title: e.title, tags: e.tags, body: e.body }) !== e.initial
  );
});

const canSaveEditor = computed(() => {
  const e = editor.value;
  return !!e && !saving.value && !!e.title.trim() && !!e.body.trim();
});

const editorTokens = computed(() =>
  editor.value ? tokenizePrompt(editor.value.body) : [],
);

const editorVariables = computed(() =>
  editor.value ? extractPromptVariables(editor.value.body) : [],
);

const fillTokens = computed(() =>
  fillSession.value ? tokenizePrompt(fillSession.value.prompt.body) : [],
);

const filledCount = computed(() => {
  const session = fillSession.value;
  if (!session) return 0;
  return session.names.filter((name) =>
    hasActualVariableValue(session.values[name]),
  ).length;
});

const canCopyFilled = computed(() => {
  const session = fillSession.value;
  if (!session || session.pending) return false;
  return (
    session.names.length > 0 && filledCount.value === session.names.length
  );
});

function formatCompactDate(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function formatDetailTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}/${pad(d.getMonth() + 1)}/${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function isTemplatePrompt(prompt: Prompt): boolean {
  return extractPromptVariables(prompt.body).length > 0;
}

async function canLeave(reason: "navigate" | "close" = "navigate") {
  if (!editor.value || !editorDirty.value) return true;
  return confirm(
    "放弃本次修改？",
    reason === "close"
      ? "关闭窗口后，本次提示词修改将丢弃。"
      : "离开编辑后，本次提示词修改将丢弃。",
    "放弃修改",
    { tone: "warning", danger: true },
  );
}

setGuard(canLeave);

watch(context, () => {
  if (editor.value) {
    editor.value = null;
    tagInput.value = "";
  }
});

function clearFilters() {
  search.value = "";
  selectedTag.value = "";
}

function openCreate() {
  const initial = { title: "", tags: [] as string[], body: "" };
  editor.value = {
    id: null,
    title: "",
    tags: [],
    body: "",
    initial: JSON.stringify(initial),
  };
  tagInput.value = "";
  void nextTick(() => titleInputRef.value?.focus());
}

function openEdit(prompt: Prompt) {
  if (prompt.deletedAt) return;
  const initial = {
    title: prompt.title,
    tags: [...prompt.tags],
    body: prompt.body,
  };
  editor.value = {
    id: prompt.id,
    title: prompt.title,
    tags: [...prompt.tags],
    body: prompt.body,
    initial: JSON.stringify(initial),
  };
  tagInput.value = "";
  void nextTick(() => titleInputRef.value?.focus());
}

async function cancelEdit() {
  if (!editor.value) return;
  if (!(await canLeave("navigate"))) return;
  editor.value = null;
  tagInput.value = "";
}

function commitPendingTags() {
  const e = editor.value;
  if (!e || !tagInput.value) return;
  const parts = tagInput.value.split(/[,，]/);
  e.tags = normalizePromptTags([...e.tags, ...parts]);
  tagInput.value = "";
}

function onTagKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (event.ctrlKey || event.metaKey || event.altKey) return;
  if (event.key === "Enter" || event.key === "," || event.key === "，") {
    event.preventDefault();
    commitPendingTags();
  }
}

function removeTag(index: number) {
  if (!editor.value) return;
  editor.value.tags.splice(index, 1);
}

function insertVariable() {
  const el = bodyInputRef.value;
  const e = editor.value;
  if (!el || !e) return;
  const start = el.selectionStart ?? e.body.length;
  const end = el.selectionEnd ?? e.body.length;
  const chosen = e.body.slice(start, end);
  const name =
    chosen.trim() && !/[{}\r\n]/.test(chosen) ? chosen.trim() : "变量名";
  const insertion = `{{${name}}}`;
  e.body = e.body.slice(0, start) + insertion + e.body.slice(end);
  void nextTick(() => {
    el.focus();
    el.setSelectionRange(start + 2, start + 2 + name.length);
  });
}

function focusVariable(name: string) {
  const el = bodyInputRef.value;
  const e = editor.value;
  if (!el || !e) return;
  const matches = tokenizePrompt(e.body).filter((t) => t.name === name);
  if (!matches.length) return;
  const currentStart = el.selectionStart;
  const currentEnd = el.selectionEnd;
  const currentIndex = matches.findIndex(
    (t) => t.offset === currentStart && t.offset + t.length === currentEnd,
  );
  const target =
    currentIndex >= 0
      ? matches[(currentIndex + 1) % matches.length]
      : matches[0];
  el.focus();
  el.setSelectionRange(target.offset, target.offset + target.length);
  // Ensure selected line is scrolled into view for long bodies.
  const linesBefore = e.body.slice(0, target.offset).split("\n").length - 1;
  const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 25;
  const targetTop = Math.max(0, linesBefore * lineHeight - el.clientHeight / 3);
  if (
    targetTop < el.scrollTop ||
    linesBefore * lineHeight > el.scrollTop + el.clientHeight - lineHeight
  ) {
    el.scrollTop = targetTop;
  }
}

async function saveDraft() {
  const e = editor.value;
  if (!e || saving.value) return;
  if (!e.title.trim()) {
    titleInputRef.value?.focus();
    return;
  }
  if (!e.body.trim()) {
    bodyInputRef.value?.focus();
    return;
  }
  commitPendingTags();
  saving.value = true;
  try {
    const saved = await call<Prompt>("prompt.save", {
      id: e.id || undefined,
      title: e.title,
      tags: e.tags,
      body: e.body,
    });
    await reload();
    selectedId.value = saved.id;
    const stillVisible = visiblePrompts.value.some((p) => p.id === saved.id);
    if (!stillVisible) {
      tab.value = "all";
      search.value = "";
      selectedTag.value = "";
      selectedId.value = saved.id;
    }
    editor.value = null;
    tagInput.value = "";
    notify("提示词已保存");
  } catch (err) {
    notify(err instanceof Error ? err.message : String(err), true);
  } finally {
    saving.value = false;
  }
}

async function toggleStar(prompt: Prompt) {
  if (prompt.deletedAt || busyAction.value) return;
  busyAction.value = true;
  try {
    await attempt(async () => {
      await call<Prompt>("prompt.star", {
        id: prompt.id,
        starred: !prompt.starred,
      });
      await reload();
    });
  } finally {
    busyAction.value = false;
  }
}

async function removePrompt(prompt: Prompt) {
  if (prompt.deletedAt || busyAction.value) return;
  const prevIndex = visiblePrompts.value.findIndex((p) => p.id === prompt.id);
  busyAction.value = true;
  try {
    const removed = await attempt(() =>
      call<Prompt | null>("prompt.delete", { id: prompt.id }),
    );
    if (removed) {
      await reload();
      const list = visiblePrompts.value;
      if (list.length) {
        selectedId.value =
          list[Math.min(Math.max(prevIndex, 0), list.length - 1)].id;
      } else {
        selectedId.value = null;
      }
      notify("已移至已删除");
    }
  } finally {
    busyAction.value = false;
  }
}

async function restorePrompt(prompt: Prompt) {
  if (!prompt.deletedAt || busyAction.value) return;
  busyAction.value = true;
  try {
    const restored = await attempt(() =>
      call<Prompt>("prompt.restore", { id: prompt.id }),
    );
    if (restored) {
      await reload();
      tab.value = "all";
      search.value = "";
      selectedTag.value = "";
      selectedId.value = restored.id;
      notify("提示词已恢复");
    }
  } finally {
    busyAction.value = false;
  }
}

function closeFillDialog() {
  if (fillDialogRef.value?.open) {
    fillDialogRef.value.close();
  }
  fillSession.value = null;
}

function openFillDialog(prompt: Prompt) {
  if (prompt.deletedAt) return;
  const vars = extractPromptVariables(prompt.body);
  if (!vars.length) {
    void copyText(prompt.body, false);
    return;
  }
  const values: Record<string, string> = {};
  for (const name of vars) values[name] = "";
  fillSession.value = {
    prompt,
    names: vars,
    values,
    pending: false,
  };
  void nextTick(() => {
    const el = fillDialogRef.value;
    if (el && !el.open) el.showModal();
    const first = el?.querySelector<HTMLTextAreaElement>("[data-var-input]");
    first?.focus();
  });
}

function onVarInput(name: string, event: Event) {
  const session = fillSession.value;
  if (!session) return;
  const el = event.target as HTMLTextAreaElement;
  session.values[name] = el.value;
  el.style.height = "auto";
  el.style.height = `${Math.min(180, Math.max(52, el.scrollHeight + 2))}px`;
}

function onFillBackdropClick(event: MouseEvent) {
  if (event.target === fillDialogRef.value) {
    closeFillDialog();
  }
}

function openCopyError(text: string, error: string, fromFill: boolean) {
  copyError.value = { text, error, fromFill, retrying: false };
  void nextTick(() => {
    const el = copyErrorDialogRef.value;
    if (el && !el.open) el.showModal();
    manualCopyAreaRef.value?.focus();
    manualCopyAreaRef.value?.select();
  });
}

function closeCopyError() {
  if (copyErrorDialogRef.value?.open) {
    copyErrorDialogRef.value.close();
  }
  copyError.value = null;
}

function onCopyErrorBackdropClick(event: MouseEvent) {
  if (event.target === copyErrorDialogRef.value) {
    closeCopyError();
  }
}

async function copyText(text: string, fromFill: boolean) {
  if (fromFill && fillSession.value) {
    if (fillSession.value.pending) return;
    fillSession.value.pending = true;
  }
  try {
    await call("clipboard.text", { text });
    if (fromFill) {
      closeFillDialog();
    }
    notify("已复制到剪贴板");
  } catch (err) {
    if (fromFill && fillSession.value) {
      fillSession.value.pending = false;
    }
    const message = err instanceof Error ? err.message : String(err);
    openCopyError(text, message, fromFill);
  }
}

async function copyFilled() {
  const session = fillSession.value;
  if (!session || !canCopyFilled.value) return;
  const rendered = replacePromptVariables(session.prompt.body, session.values);
  await copyText(rendered, true);
}

async function retryCopyFromError() {
  const errState = copyError.value;
  if (!errState || errState.retrying) return;
  errState.retrying = true;
  try {
    await call("clipboard.text", { text: errState.text });
    const wasFromFill = errState.fromFill;
    closeCopyError();
    if (wasFromFill) {
      closeFillDialog();
    }
    notify("已复制到剪贴板");
  } catch (err) {
    errState.error = err instanceof Error ? err.message : String(err);
    errState.retrying = false;
    void nextTick(() => {
      manualCopyAreaRef.value?.focus();
      manualCopyAreaRef.value?.select();
    });
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.keyCode === 229) return;
  if (
    editor.value &&
    !activeDialog.value &&
    !fillSession.value &&
    !copyError.value &&
    (event.ctrlKey || event.metaKey) &&
    event.key === "Enter"
  ) {
    event.preventDefault();
    void saveDraft();
  }
}

onMounted(() => {
  window.addEventListener("keydown", onKeydown);
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  if (leaveGuard === canLeave) setGuard(null);
  if (copyErrorDialogRef.value?.open) copyErrorDialogRef.value.close();
  if (fillDialogRef.value?.open) fillDialogRef.value.close();
});
</script>

<template>
  <div class="prompts-page">
    <!-- 列表与详情模式 -->
    <template v-if="!editor">
      <div class="page-head">
        <h1>提示词库</h1>
        <div class="h-actions">
          <button
            type="button"
            class="btn primary library-main-btn"
            @click="openCreate"
          >
            <Icon name="plus" :size="15" />
            <span>新建提示词</span>
          </button>
        </div>
      </div>

      <div class="library-layout">
        <!-- 左侧提示词列表卡片 -->
        <section class="card library-panel" aria-label="提示词列表">
          <div class="lib-head">
            <h2>我的提示词</h2>
            <label class="compact-select inline-label">
              <Icon name="tag" :size="12" />
              <select v-model="selectedTag" aria-label="按标签筛选">
                <option value="">全部标签</option>
                <option v-for="t in availableTags" :key="t" :value="t">
                  {{ t }}
                </option>
              </select>
            </label>
          </div>

          <label class="prompt-search inline-label">
            <Icon name="search" :size="14" />
            <input
              v-model="search"
              type="search"
              placeholder="搜索标题、正文或标签"
              aria-label="搜索提示词"
            />
          </label>

          <div class="library-tabbar" role="group" aria-label="提示词范围">
            <button
              v-for="item in [
                ['all', '全部'],
                ['favorites', '已收藏'],
                ['deleted', '已删除'],
              ] as const"
              :key="item[0]"
              type="button"
              class="filter-tab"
              :class="{ active: tab === item[0] }"
              :data-tab="item[0]"
              :aria-pressed="tab === item[0]"
              @click="tab = item[0]"
            >
              <span>{{ item[1] }}</span>
              <span class="count">{{ counts[item[0]] }}</span>
            </button>
          </div>

          <div class="prompt-rows">
            <template v-if="visiblePrompts.length">
              <article
                v-for="p in visiblePrompts"
                :key="p.id"
                class="prompt-row"
                :class="{ selected: p.id === selectedId }"
                :data-id="p.id"
              >
                <button
                  type="button"
                  class="select-prompt"
                  :aria-pressed="p.id === selectedId"
                  :aria-label="'查看 ' + p.title"
                  @click="selectedId = p.id"
                >
                  <span
                    class="prompt-icon"
                    :class="{ templ: isTemplatePrompt(p) }"
                    :title="isTemplatePrompt(p) ? '带变量的模板' : '纯文本提示词'"
                  >
                    <Icon
                      :name="isTemplatePrompt(p) ? 'braces' : 'paragraph'"
                      :size="17"
                    />
                  </span>
                  <span class="prompt-summary">
                    <strong>{{ p.title }}</strong>
                    <span class="prompt-row-meta">
                      <template v-if="p.tags.length">
                        <span class="tag-names">{{ p.tags.join(" / ") }}</span>
                        <i class="sep-dot" aria-hidden="true" />
                      </template>
                      <time>{{
                        formatCompactDate(
                          tab === "deleted" ? p.deletedAt : p.updatedAt,
                        )
                      }}</time>
                    </span>
                  </span>
                </button>
                <button
                  v-if="!p.deletedAt"
                  type="button"
                  class="star-button"
                  :class="{ on: p.starred }"
                  :title="p.starred ? '取消收藏' : '收藏'"
                  :aria-pressed="p.starred"
                  :aria-label="(p.starred ? '取消收藏' : '收藏') + ' · ' + p.title"
                  @click="toggleStar(p)"
                >
                  <Icon name="star" :size="15" />
                </button>
              </article>
            </template>

            <div v-else class="empty-panel">
              <span>
                {{
                  isFiltering
                    ? "没有匹配的提示词"
                    : tab === "deleted"
                      ? "已删除列表为空"
                      : tab === "favorites"
                        ? "暂无收藏的提示词"
                        : "还没有提示词"
                }}
              </span>
              <button
                v-if="isFiltering"
                type="button"
                class="btn compact"
                @click="clearFilters"
              >
                清除筛选
              </button>
            </div>
          </div>

          <div class="list-foot">
            <span>{{
              tab === "deleted" ? "按删除时间排列" : "按最近修改排列"
            }}</span>
            <span class="push" />
            <span v-if="isFiltering">匹配 {{ visiblePrompts.length }} 条</span>
          </div>
        </section>

        <!-- 右侧详情卡片 -->
        <section class="card reading-panel" aria-label="提示词详情">
          <template v-if="selectedPrompt">
            <div class="read-intro">
              <div class="reading-tools">
                <div class="type-label">
                  <span class="type-mark">
                    <Icon
                      :name="selectedVariables.length ? 'braces' : 'paragraph'"
                      :size="14"
                    />
                  </span>
                  <span>{{
                    selectedVariables.length ? "带变量的模板" : "纯文本提示词"
                  }}</span>
                </div>
                <div class="row-actions">
                  <span v-if="selectedPrompt.deletedAt" class="badge neutral"
                    >已删除</span
                  >
                  <button
                    v-else
                    type="button"
                    class="btn compact"
                    @click="openEdit(selectedPrompt)"
                  >
                    <Icon name="penbox" :size="14" />
                    <span>编辑</span>
                  </button>
                </div>
              </div>
              <h2 class="read-title">{{ selectedPrompt.title }}</h2>
              <div v-if="selectedPrompt.tags.length" class="tag-set">
                <span
                  v-for="tag in selectedPrompt.tags"
                  :key="tag"
                  class="tag-chip"
                >
                  <Icon name="tag" :size="11" />
                  <span>{{ tag }}</span>
                </span>
              </div>
            </div>

            <div class="read-body">
              <div class="body-label">
                <Icon name="document" :size="14" />
                <span>提示词正文</span>
                <span class="trailing"
                  >{{ promptCharCount(selectedPrompt.body) }} 字符</span
                >
              </div>
              <article class="paper-area">
                <div class="prompt-text" data-prompt-body>
                  <template
                    v-for="(token, idx) in selectedTokens"
                    :key="idx + '-' + token.offset"
                  >
                    <span v-if="token.name" class="placeholder">{{
                      token.raw
                    }}</span>
                    <template v-else>{{ token.raw }}</template>
                  </template>
                </div>
              </article>
              <div class="entry-line">
                <span class="inline-caption">
                  <Icon name="history" :size="13" />
                  <span>更新于 {{ formatDetailTime(selectedPrompt.updatedAt) }}</span>
                  <template v-if="selectedPrompt.deletedAt">
                    <i class="sep-dot" aria-hidden="true" />
                    <span>删除于 {{ formatDetailTime(selectedPrompt.deletedAt) }}</span>
                  </template>
                </span>
                <span v-if="selectedVariables.length" class="inline-caption">
                  <Icon name="braces" :size="13" />
                  <span>{{ selectedVariables.length }} 个变量</span>
                </span>
              </div>
            </div>

            <div class="foot-actions">
              <template v-if="selectedPrompt.deletedAt">
                <span class="inline-note-p">恢复后可继续编辑和使用。</span>
                <div class="toolbar-actions">
                  <button
                    type="button"
                    class="btn"
                    :disabled="busyAction"
                    @click="restorePrompt(selectedPrompt)"
                  >
                    <Icon name="history" :size="15" />
                    <span>恢复提示词</span>
                  </button>
                </div>
              </template>
              <template v-else>
                <button
                  type="button"
                  class="soft-danger"
                  :disabled="busyAction"
                  @click="removePrompt(selectedPrompt)"
                >
                  <Icon name="trash" :size="13" />
                  <span>移至已删除</span>
                </button>
                <div class="toolbar-actions">
                  <template v-if="selectedVariables.length">
                    <button
                      type="button"
                      class="btn"
                      @click="copyText(selectedPrompt.body, false)"
                    >
                      <Icon name="copy-p" :size="15" />
                      <span>复制原文</span>
                    </button>
                    <button
                      type="button"
                      class="btn"
                      @click="openFillDialog(selectedPrompt)"
                    >
                      <Icon name="braces" :size="15" />
                      <span>填写变量并复制</span>
                    </button>
                  </template>
                  <button
                    v-else
                    type="button"
                    class="btn"
                    @click="copyText(selectedPrompt.body, false)"
                  >
                    <Icon name="copy-p" :size="15" />
                    <span>复制提示词</span>
                  </button>
                </div>
              </template>
            </div>
          </template>

          <div v-else class="empty-panel">未选择</div>
        </section>
      </div>
    </template>

    <!-- 新建与编辑模式 -->
    <template v-else>
      <div class="page-head">
        <h1>{{ editor.id ? "编辑提示词" : "新建提示词" }}</h1>
        <div class="h-actions">
          <button type="button" class="btn" :disabled="saving" @click="cancelEdit">
            <span>取消</span>
          </button>
          <button
            type="button"
            class="btn primary"
            :disabled="!canSaveEditor"
            title="保存提示词（Ctrl+Enter）"
            @click="saveDraft"
          >
            <Icon name="check" :size="15" />
            <span>{{ saving ? "正在保存…" : "保存提示词" }}</span>
          </button>
        </div>
      </div>

      <div class="edit-layout">
        <!-- 左侧表单卡片 -->
        <section class="card form-panel" aria-label="编辑提示词表单">
          <div class="form-head">
            <h2>编辑内容</h2>
            <span class="form-status" :class="{ clean: !editorDirty }">
              {{
                editorDirty
                  ? "有未保存修改"
                  : editor.id
                    ? "已保存"
                    : "草稿"
              }}
            </span>
          </div>

          <div class="form-fields">
            <div class="form-group">
              <label for="prompt-edit-title">标题</label>
              <input
                id="prompt-edit-title"
                ref="titleInputRef"
                v-model="editor.title"
                class="text-input"
                maxlength="200"
                placeholder="取一个下次能搜到的名字"
              />
            </div>

            <div class="form-group">
              <label for="prompt-edit-tag">标签<small>选填</small></label>
              <div class="tag-editor" @click="tagInputRef?.focus()">
                <span v-if="editor.tags.length" class="tag-set">
                  <span
                    v-for="(tag, idx) in editor.tags"
                    :key="tag"
                    class="tag-chip"
                  >
                    <span>{{ tag }}</span>
                    <button
                      type="button"
                      class="tag-remove-btn"
                      :aria-label="'移除标签 ' + tag"
                      @click.stop="removeTag(idx)"
                    >
                      <Icon name="close" :size="10" />
                    </button>
                  </span>
                </span>
                <input
                  id="prompt-edit-tag"
                  ref="tagInputRef"
                  v-model="tagInput"
                  placeholder="输入标签，按 Enter 添加"
                  autocomplete="off"
                  @keydown="onTagKeydown"
                />
              </div>
            </div>

            <div class="form-group grow-field">
              <div class="fields-line">
                <label for="prompt-edit-body">提示词正文</label>
                <button
                  type="button"
                  class="insert-var"
                  @click="insertVariable"
                >
                  <Icon name="braces" :size="12" />
                  <span>插入变量</span>
                </button>
              </div>
              <textarea
                id="prompt-edit-body"
                ref="bodyInputRef"
                v-model="editor.body"
                class="body-input"
                placeholder="写下可直接复制使用的提示词…"
                spellcheck="false"
              />
              <p class="inline-note-p">
                用 &#123;&#123;变量名&#125;&#125; 标记变量
              </p>
            </div>
          </div>

          <div class="form-bottom">
            <span>Ctrl+Enter 保存</span>
            <span class="push" />
            <span>{{ promptCharCount(editor.body) }} 字符</span>
          </div>
        </section>

        <!-- 右侧实时预览卡片 -->
        <section class="card preview-panel" aria-label="实时预览">
          <div class="preview-head">
            <h2>实时预览</h2>
          </div>

          <div class="preview-body">
            <div class="preview-type">
              <Icon
                :name="editorVariables.length ? 'braces' : 'paragraph'"
                :size="13"
              />
              <span>{{
                editorVariables.length ? "带变量的模板" : "纯文本提示词"
              }}</span>
            </div>
            <h3>{{ editor.title.trim() || "未命名提示词" }}</h3>
            <div v-if="editor.tags.length" class="tag-set">
              <span
                v-for="tag in editor.tags"
                :key="tag"
                class="tag-chip"
              >
                <Icon name="tag" :size="11" />
                <span>{{ tag }}</span>
              </span>
            </div>

            <div class="preview-paper">
              <div class="prompt-text" data-edit-preview>
                <template v-if="editor.body">
                  <template
                    v-for="(token, idx) in editorTokens"
                    :key="idx + '-' + token.offset"
                  >
                    <span v-if="token.name" class="placeholder">{{
                      token.raw
                    }}</span>
                    <template v-else>{{ token.raw }}</template>
                  </template>
                </template>
                <span v-else class="inline-note-p">正文预览会显示在这里。</span>
              </div>
            </div>

            <div v-if="editorVariables.length" class="variable-footer">
              <div class="body-label">
                <Icon name="braces" :size="13" />
                <span>已识别变量</span>
                <span class="trailing">共 {{ editorVariables.length }} 个</span>
              </div>
              <div class="variable-tags">
                <button
                  v-for="varName in editorVariables"
                  :key="varName"
                  type="button"
                  title="定位到正文中的变量"
                  @click="focusVariable(varName)"
                >
                  {{ varName }}
                </button>
              </div>
            </div>
          </div>
        </section>
      </div>
    </template>

    <!-- 填写变量并复制弹窗 -->
    <dialog
      ref="fillDialogRef"
      class="prompt-dialog"
      aria-labelledby="fill-dialog-title"
      @cancel.prevent="closeFillDialog"
      @click="onFillBackdropClick"
    >
      <template v-if="fillSession">
        <div class="dialog-header">
          <div class="dialog-heading">
            <span class="dialog-symbol">
              <Icon name="braces" :size="20" />
            </span>
            <div>
              <h2 id="fill-dialog-title">填写变量并复制</h2>
              <p>{{ fillSession.prompt.title }}</p>
            </div>
          </div>
          <button
            type="button"
            class="icon-btn blank"
            aria-label="关闭"
            @click="closeFillDialog"
          >
            <Icon name="close" :size="16" />
          </button>
        </div>

        <div class="fill-grid">
          <section class="fill-form">
            <div class="fill-subhead">
              <h3>本次取值</h3>
              <span class="trailing"
                >已填写 {{ filledCount }} / {{ fillSession.names.length }}</span
              >
            </div>
            <div class="fill-fields">
              <div
                v-for="(varName, idx) in fillSession.names"
                :key="varName"
                class="form-group"
              >
                <label :for="'prompt-var-' + idx">{{ varName }}</label>
                <textarea
                  :id="'prompt-var-' + idx"
                  :value="fillSession.values[varName]"
                  class="value-input"
                  rows="2"
                  data-var-input
                  :data-var-name="varName"
                  :placeholder="'填写' + varName"
                  spellcheck="false"
                  @input="onVarInput(varName, $event)"
                />
              </div>
            </div>
          </section>

          <section class="fill-preview">
            <div class="fill-subhead">
              <h3>复制内容预览</h3>
            </div>
            <div class="prompt-text" data-fill-preview>
              <template
                v-for="(token, idx) in fillTokens"
                :key="idx + '-' + token.offset"
              >
                <template v-if="token.name">
                  <span
                    v-if="hasActualVariableValue(fillSession.values[token.name])"
                    class="replacement"
                    >{{ fillSession.values[token.name] }}</span
                  >
                  <span v-else class="placeholder">{{ token.raw }}</span>
                </template>
                <template v-else>{{ token.raw }}</template>
              </template>
            </div>
          </section>
        </div>

        <div class="dialog-footer">
          <span class="inline-caption">仅用于本次复制</span>
          <div class="toolbar-actions">
            <button type="button" class="btn" @click="closeFillDialog">
              取消
            </button>
            <button
              type="button"
              class="btn primary"
              :disabled="!canCopyFilled"
              @click="copyFilled"
            >
              <Icon name="copy-p" :size="15" />
              <span>{{ fillSession.pending ? "正在复制…" : "复制到剪贴板" }}</span>
            </button>
          </div>
        </div>
      </template>
    </dialog>

    <!-- 复制失败重试 / 手动复制弹窗 -->
    <dialog
      ref="copyErrorDialogRef"
      class="prompt-dialog small-dialog"
      aria-labelledby="copy-error-title"
      @cancel.prevent="closeCopyError"
      @click="onCopyErrorBackdropClick"
    >
      <template v-if="copyError">
        <div class="dialog-header">
          <div class="dialog-heading">
            <span class="dialog-symbol warn">
              <Icon name="warning" :size="18" />
            </span>
            <div>
              <h2 id="copy-error-title">未能写入剪贴板</h2>
              <p>可点击重试，或选中下方正文按 Ctrl + C 手动复制</p>
            </div>
          </div>
          <button
            type="button"
            class="icon-btn blank"
            aria-label="关闭手动复制弹窗"
            @click="closeCopyError"
          >
            <Icon name="close" :size="16" />
          </button>
        </div>

        <div class="copy-error-body">
          <div v-if="copyError.error" class="copy-error-reason">
            {{ copyError.error }}
          </div>
          <p class="copy-error-desc">
            内容已保留，重试或手动复制：
          </p>
          <textarea
            ref="manualCopyAreaRef"
            :value="copyError.text"
            class="manual-copy-area"
            readonly
            aria-label="待手动复制的正文"
          />
        </div>

        <div class="dialog-footer">
          <span />
          <div class="toolbar-actions">
            <button type="button" class="btn" @click="closeCopyError">
              关闭
            </button>
            <button
              type="button"
              class="btn primary"
              :disabled="copyError.retrying"
              @click="retryCopyFromError"
            >
              <Icon name="refresh" :size="14" />
              <span>{{ copyError.retrying ? "正在重试…" : "重试复制" }}</span>
            </button>
          </div>
        </div>
      </template>
    </dialog>
  </div>
</template>

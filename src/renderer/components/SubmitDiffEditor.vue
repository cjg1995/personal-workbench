<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { FileComparison } from "../../shared/git-client";
import type { SubmitCheck } from "../../shared/types";
import { call } from "../state";
import {
  diffChangePosition,
  diffCodeOptions,
  ideaLineDecorations,
  language,
  monaco,
  revealDiffCaret,
} from "../monaco";
import { DiffScrollbar } from "../diff-scrollbar";
import { revertLines } from "../../shared/diff-edit";
import { useDiffNavigation } from "../diff-navigation";
import Icon from "./Icon.vue";
import CloseButton from "./CloseButton.vue";
import DiffJumpPicker from "./DiffJumpPicker.vue";
import "../idea-editor.css";

const props = defineProps<{
  projectId: string;
  file: string;
  taskId?: string;
  fromGit?: boolean;
  protectedFile?: string;
}>();
const emit = defineEmits<{ saved: [check: SubmitCheck] }>();
const root = ref<HTMLElement>(), host = ref<HTMLElement>();
const data = ref<FileComparison>(), dirty = ref(false), busy = ref(false), loading = ref(false);
const error = ref(""), status = ref(""), differences = ref(0);
const wrap = ref(false), fontSize = ref(14), dark = ref(false);
try {
  const settings = JSON.parse(localStorage.getItem("git-diff-settings-v3") || localStorage.getItem("git-diff-settings-v2") || "{}");
  wrap.value = !!settings.wrap;
  dark.value = !!settings.dark;
  fontSize.value = Math.max(10, Math.min(24, Number(settings.fontSize) || 14));
} catch {}
const editable = computed(() => !!data.value?.editable && props.file.toLowerCase() !== props.protectedFile?.toLowerCase());
let editor: monaco.editor.IStandaloneDiffEditor | undefined;
let models: monaco.editor.ITextModel[] = [], listeners: monaco.IDisposable[] = [];
let scrollbar: DiffScrollbar | undefined;
let originalHighlights: string[] = [], modifiedHighlights: string[] = [];
let revertGlyphs: string[] = [];
let savedText = "", request = 0, disposed = false;
let saving: Promise<boolean> | undefined, leaving: Promise<boolean> | undefined;

const nav = useDiffNavigation({
  getProjectId: () => props.projectId,
  getFile: () => props.file,
  isAllowLsp: (side) => side === "modified" && !dirty.value,
  getEditorBySide: (side) =>
    side === "original" ? editor?.getOriginalEditor() : editor?.getModifiedEditor(),
  revealInPane: (side, position, scrollTop) => {
    const code = side === "original" ? editor?.getOriginalEditor() : editor?.getModifiedEditor();
    if (!code) return;
    code.setPosition(position);
    if (scrollTop !== undefined) code.setScrollTop(scrollTop);
    else code.revealPositionInCenter(position, monaco.editor.ScrollType.Immediate);
    code.focus();
  },
  resolveApi: (payload) => call("code.resolve-definition", payload),
  openEditorApi: (payload) => call("code.open-in-editor", payload),
  notify: (text) => { status.value = text; },
});

function applyOptions() {
  monaco.editor.setTheme(dark.value ? "workbench-dark" : "workbench-light");
  editor?.updateOptions({ ...diffCodeOptions(fontSize.value, wrap.value), readOnly: !editable.value,
    renderSideBySide: false, useInlineViewWhenSpaceIsLimited: false, originalEditable: false,
    renderMarginRevertIcon: false, renderIndicators: false, renderOverviewRuler: false,
    hideUnchangedRegions: { enabled: false }, ignoreTrimWhitespace: false });
  editor?.getModifiedEditor().updateOptions({ glyphMargin: true, lineNumbersMinChars: 3, overviewRulerLanes: 0,
    scrollbar: { vertical: "hidden", verticalScrollbarSize: 14 } });
  editor?.getOriginalEditor().updateOptions({ glyphMargin: false, lineNumbers: "on", lineDecorationsWidth: 22,
    overviewRulerLanes: 0, scrollbar: { vertical: "hidden", verticalScrollbarSize: 0 } });
}
watch([wrap, fontSize, dark, editable], applyOptions);
function disposeModels() {
  editor?.setModel(null);
  models.forEach((model) => model.dispose());
  models = [];
  originalHighlights = [];
  modifiedHighlights = [];
  revertGlyphs = [];
}
async function load() {
  if (!editor) return;
  const id = ++request;
  data.value = undefined;
  dirty.value = false;
  error.value = status.value = "";
  differences.value = 0;
  nav.resetForFile();
  disposeModels();
  if (!props.file) return;
  loading.value = true;
  try {
    // Use the working copy in both submission stages; saves in the final stage
    // also refresh that task's index and confirmation fingerprint.
    const next = await call<FileComparison>("git.content", {
      projectId: props.projectId, file: props.file, comparison: { mode: "local" },
    });
    if (id !== request || disposed) return;
    data.value = next;
    savedText = next.newText;
    if (!next.binary) {
      models = [next.oldText, next.newText].map((text, side) => monaco.editor.createModel(
        text, language(props.file), monaco.Uri.parse(`inmemory://submit/${Date.now()}-${id}/${side}/${props.file}`)));
      editor.setModel({ original: models[0], modified: models[1] });
      models[1].onDidChangeContent(() => { dirty.value = models[1].getValue() !== savedText; status.value = ""; });
      applyOptions();
    }
  } catch (value) {
    if (id === request) error.value = value instanceof Error ? value.message : String(value);
  } finally {
    if (id === request) loading.value = false;
  }
}
function save(): Promise<boolean> {
  if (saving) return saving;
  if (!dirty.value) return Promise.resolve(true);
  if (!editable.value || !data.value || loading.value) return Promise.resolve(false);
  saving = (async () => {
    busy.value = true;
    error.value = "";
    try {
      // Preserve edits typed while a save is in flight and save them as well.
      while (dirty.value && !disposed) {
        const text = models[1].getValue();
        const response = await call<{ value: { token: string }; check: SubmitCheck }>("git.submit.save", {
          projectId: props.projectId, taskId: props.taskId, file: props.file,
          token: data.value!.token, text, fromGit: props.fromGit,
        });
        data.value!.token = response.value.token;
        savedText = text;
        dirty.value = models[1].getValue() !== savedText;
        emit("saved", response.check);
      }
      status.value = props.taskId ? "已保存并更新提交预览" : "已保存到工作区";
      return true;
    } catch (value) {
      error.value = value instanceof Error ? value.message : String(value);
      return false;
    } finally {
      busy.value = false;
      saving = undefined;
    }
  })();
  return saving;
}
function canLeave(): Promise<boolean> {
  if (leaving) return leaving;
  leaving = (async () => {
    if (saving && !await saving) return false;
    if (!dirty.value) return true;
    const answer = await call<string>("git.confirm-save", { file: props.file });
    if (answer === "save") return save();
    if (answer === "discard") {
      models[1]?.setValue(savedText);
      dirty.value = false;
      return true;
    }
    editor?.getModifiedEditor().focus();
    return false;
  })().catch((value) => {
    error.value = value instanceof Error ? value.message : String(value);
    return false;
  }).finally(() => { leaving = undefined; });
  return leaving;
}
function key(event: KeyboardEvent) {
  if (nav.picker.value.open) return;
  if (event.key === "Control" && !event.repeat) {
    nav.onKeyDown(event);
    return;
  }
  const focusedInside = !!root.value?.contains(document.activeElement);
  if (focusedInside && nav.onKeyDown(event)) return;
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && focusedInside) {
    event.preventDefault();
    event.stopPropagation();
    void save();
  }
}
function nextDifference(next: boolean) {
  if (!editor) return;
  const code = editor.getModifiedEditor(), model = code.getModel();
  if (!model) return;
  const changes = editor.getLineChanges() || [], line = code.getPosition()?.lineNumber || 0;
  const change = next
    ? changes.find((item) => diffChangePosition(model, item).lineNumber > line) || changes[0]
    : [...changes].reverse().find((item) => diffChangePosition(model, item).lineNumber < line) || changes.at(-1);
  if (change) revealDiffCaret(code, diffChangePosition(model, change));
}
function decorate() {
  if (!editor || models.length !== 2) return;
  const changes = editor.getLineChanges() || [];
  differences.value = changes.length;
  scrollbar?.setChanges(changes);
  const highlights = ideaLineDecorations(dark.value ? [] : changes);
  originalHighlights = models[0].deltaDecorations(originalHighlights, highlights.original);
  modifiedHighlights = models[1].deltaDecorations(modifiedHighlights, highlights.modified);
  revertGlyphs = models[1].deltaDecorations(revertGlyphs, editable.value && !busy.value ? changes.map((change) => ({
    range: new monaco.Range(Math.max(1, Math.min(models[1].getLineCount(), change.modifiedStartLineNumber)), 1,
      Math.max(1, Math.min(models[1].getLineCount(), change.modifiedStartLineNumber)), 1),
    options: { glyphMarginClassName: "git-revert-glyph", glyphMarginHoverMessage: { value: "Revert 此处差异（立即保存；Ctrl+Z 撤销）" } },
  })) : []);
}
function revert(line: number) {
  if (!editable.value || busy.value || !editor || models.length !== 2) return;
  const change = editor.getLineChanges()?.find((item) => Math.max(1, Math.min(models[1].getLineCount(), item.modifiedStartLineNumber)) === line);
  if (!change) return;
  const text = revertLines(models[0].getValue(), models[1].getValue(), {
    oldStart: change.originalEndLineNumber ? change.originalStartLineNumber : change.originalStartLineNumber + 1,
    oldCount: change.originalEndLineNumber ? change.originalEndLineNumber - change.originalStartLineNumber + 1 : 0,
    newStart: change.modifiedEndLineNumber ? change.modifiedStartLineNumber : change.modifiedStartLineNumber + 1,
    newCount: change.modifiedEndLineNumber ? change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1 : 0,
  });
  const code = editor.getModifiedEditor();
  code.pushUndoStop();
  code.executeEdits("submit.revert", [{ range: models[1].getFullModelRange(), text }]);
  code.pushUndoStop();
  code.focus();
  void save();
}
watch([busy, dark, editable], decorate);
watch(() => [props.projectId, props.file, props.taskId], () => void load());
onMounted(() => {
  editor = monaco.editor.createDiffEditor(host.value!, { ...diffCodeOptions(fontSize.value, wrap.value), renderSideBySide: false });
  scrollbar = new DiffScrollbar(editor.getModifiedEditor(), "modified");
  listeners.push(editor.onDidUpdateDiff(decorate),
    ...nav.bindEditor(editor.getModifiedEditor(), "modified"),
    ...nav.bindEditor(editor.getOriginalEditor(), "original"),
    editor.getModifiedEditor().onMouseDown((event) => {
      if ((event.target.element?.closest('.git-revert-glyph')) && event.target.position) revert(event.target.position.lineNumber);
    }));
  window.addEventListener("keydown", key, true);
  window.addEventListener("keyup", nav.onKeyUp, true);
  window.addEventListener("blur", nav.onBlur);
  void load();
});
onBeforeUnmount(() => {
  disposed = true;
  request++;
  window.removeEventListener("keydown", key, true);
  window.removeEventListener("keyup", nav.onKeyUp, true);
  window.removeEventListener("blur", nav.onBlur);
  nav.dispose();
  listeners.forEach((listener) => listener.dispose());
  scrollbar?.dispose();
  disposeModels();
  editor?.dispose();
});
defineExpose({ canLeave });
</script>

<template>
  <div ref="root" class="submit-inline-diff diff-unified" :class="{ 'diff-light': !dark, 'diff-readonly': !editable, 'ctrl-link-hover': nav.ctrlLink.value }">
    <div class="submit-diff-toolbar">
      <strong>单页对比</strong>
      <button title="上一个差异" aria-label="上一个差异" :disabled="!differences" @click="nextDifference(false)">↑</button>
      <button title="下一个差异" aria-label="下一个差异" :disabled="!differences" @click="nextDifference(true)">↓</button>
      <button :aria-pressed="wrap" title="自动换行" @click="wrap = !wrap">换行</button>
      <button title="缩小代码字号" aria-label="缩小代码字号" :disabled="fontSize <= 10" @click="fontSize--">A−</button>
      <button title="放大代码字号" aria-label="放大代码字号" :disabled="fontSize >= 24" @click="fontSize++">A+</button>
      <button
        v-if="file && !data?.binary"
        title="在代码编辑器中打开当前文件并定位到光标处"
        aria-label="在代码编辑器中打开"
        @click="nav.openCurrentInEditor(editor?.getModifiedEditor())"
      >编辑器</button>
      <button class="push-right" title="保存（Ctrl+S）" :disabled="!dirty || busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
    </div>
    <div class="submit-diff-path" :title="file">{{ file || '选择文件查看差异' }}<span v-if="dirty"> · 未保存</span></div>
    <div v-if="data && !data.binary" class="diff-version-labels">
      <span>{{ data.oldLabel }}<small class="diff-eol diff-eol-old">{{ data.oldText.includes('\r\n') ? 'CRLF' : 'LF' }}</small></span>
      <span>{{ data.newLabel }}<small class="diff-eol diff-eol-new">{{ data.newText.includes('\r\n') ? 'CRLF' : 'LF' }}</small></span>
    </div>
    <p v-if="error" class="error small submit-diff-notice" role="alert">{{ error }}</p>
    <p v-if="data?.notice" class="small submit-diff-notice">{{ data.notice }}</p>
    <div class="submit-diff-stage">
      <div ref="host" class="submit-diff-host" :aria-busy="loading" />
      <Transition name="pop">
        <div v-if="nav.showReturnPill.value" class="diff-nav-pill" role="region" aria-label="跳转导航">
          <button
            type="button"
            class="diff-nav-pill-btn primary"
            :disabled="!nav.canGoBack.value"
            title="返回跳转前位置（Alt+←）"
            @click="nav.stepHistory(-1)"
          >
            <Icon name="arrow-left" :size="13" />
            <span>{{ nav.backEntry.value ? `返回第 ${nav.backEntry.value.line} 行` : "后退" }}</span>
          </button>
          <button
            v-if="nav.canGoForward.value"
            type="button"
            class="diff-nav-pill-btn"
            title="前进到下一跳转位置（Alt+→）"
            @click="nav.stepHistory(1)"
          >
            <Icon name="arrow-right" :size="13" />
          </button>
          <span v-if="nav.activeJumpLabel.value" class="diff-nav-pill-sep" />
          <span v-if="nav.activeJumpLabel.value" class="diff-nav-pill-label" :title="nav.activeJumpLabel.value">
            {{ nav.activeJumpLabel.value }}
          </span>
          <CloseButton class="diff-nav-pill-close" label="隐藏返回条" :size="11" @click="nav.dismissPill()" />
        </div>
      </Transition>
    </div>
    <div class="submit-diff-status small muted">
      {{ loading ? '读取中…' : status || (data?.binary ? '二进制文件无法编辑' : data && !editable ? '只读 · Ctrl+点击 / F12 跳转定义' : 'Ctrl+点击 / F12 跳转定义 · Alt+← 返回') }}
    </div>
    <div
      v-if="nav.hoverTooltip.value"
      class="diff-nav-tooltip"
      :class="{ dark }"
      :style="{ left: `${nav.hoverTooltip.value.x}px`, top: `${nav.hoverTooltip.value.y}px` }"
      role="tooltip"
    >
      <div class="diff-nav-tooltip-head">
        <span class="diff-nav-badge" :class="{ external: !nav.hoverTooltip.value.sameFile }">
          {{ nav.hoverTooltip.value.badge }}
        </span>
        <span class="diff-nav-tooltip-loc">{{ nav.hoverTooltip.value.location }}</span>
        <span class="diff-nav-tooltip-hint">{{ nav.hoverTooltip.value.hint }}</span>
      </div>
      <div v-if="nav.hoverTooltip.value.snippet" class="diff-nav-tooltip-code">
        {{ nav.hoverTooltip.value.snippet }}
      </div>
    </div>
    <DiffJumpPicker
      :open="nav.picker.value.open"
      :symbol="nav.picker.value.symbol"
      :targets="nav.picker.value.targets"
      :dark="dark"
      @pick="nav.pickTarget"
      @close="nav.closePicker"
    />
  </div>
</template>

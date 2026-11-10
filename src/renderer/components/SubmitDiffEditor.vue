<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { FileComparison } from "../../shared/git-client";
import type { SubmitCheck } from "../../shared/types";
import { call } from "../state";
import { monaco, language, diffCodeOptions, ideaLineDecorations } from "../monaco";
import { DiffScrollbar } from "../diff-scrollbar";
import { revertLines } from "../../shared/diff-edit";

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
  const settings = JSON.parse(localStorage.getItem("git-diff-settings-v2") || "{}");
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
let blurTimer: ReturnType<typeof setTimeout> | undefined;

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
function blur() {
  clearTimeout(blurTimer);
  blurTimer = setTimeout(() => {
    const active = document.activeElement;
    if (!disposed && dirty.value && !active?.closest('.monaco-menu-container, .context-view') &&
        (!document.hasFocus() || !root.value?.contains(active)))
      void canLeave();
  }, 0);
}
function key(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s" && root.value?.contains(document.activeElement)) {
    event.preventDefault();
    event.stopPropagation();
    void save();
  }
}
function nextDifference(next: boolean) {
  if (!editor) return;
  const changes = editor.getLineChanges() || [], line = editor.getModifiedEditor().getPosition()?.lineNumber || 0;
  const change = next ? changes.find((item) => item.modifiedStartLineNumber > line) || changes[0]
    : [...changes].reverse().find((item) => item.modifiedStartLineNumber < line) || changes.at(-1);
  if (change) {
    const target = Math.max(1, change.modifiedStartLineNumber);
    editor.getModifiedEditor().setPosition({ lineNumber: target, column: 1 });
    editor.getModifiedEditor().revealLineInCenter(target);
  }
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
  listeners.push(editor.onDidUpdateDiff(decorate), editor.getModifiedEditor().onDidBlurEditorWidget(blur),
    editor.getModifiedEditor().onMouseDown((event) => {
      if ((event.target.element?.closest('.git-revert-glyph')) && event.target.position) revert(event.target.position.lineNumber);
    }));
  window.addEventListener("keydown", key, true);
  window.addEventListener("blur", blur);
  void load();
});
onBeforeUnmount(() => {
  disposed = true;
  request++;
  clearTimeout(blurTimer);
  window.removeEventListener("keydown", key, true);
  window.removeEventListener("blur", blur);
  listeners.forEach((listener) => listener.dispose());
  scrollbar?.dispose();
  disposeModels();
  editor?.dispose();
});
defineExpose({ canLeave });
</script>

<template>
  <div ref="root" class="submit-inline-diff diff-unified" :class="{ 'diff-light': !dark }" @focusout="blur">
    <div class="submit-diff-toolbar">
      <strong>单页对比</strong>
      <button title="上一个差异" aria-label="上一个差异" :disabled="!differences" @click="nextDifference(false)">↑</button>
      <button title="下一个差异" aria-label="下一个差异" :disabled="!differences" @click="nextDifference(true)">↓</button>
      <button :aria-pressed="wrap" title="自动换行" @click="wrap = !wrap">换行</button>
      <button title="缩小代码字号" aria-label="缩小代码字号" :disabled="fontSize <= 10" @click="fontSize--">A−</button>
      <button title="放大代码字号" aria-label="放大代码字号" :disabled="fontSize >= 24" @click="fontSize++">A+</button>
      <button class="push-right" :disabled="!dirty || busy" @click="save">{{ busy ? '保存中…' : '保存' }}</button>
    </div>
    <div class="submit-diff-path" :title="file">{{ file || '选择文件查看差异' }}<span v-if="dirty"> · 未保存</span></div>
    <div v-if="data && !data.binary" class="diff-version-labels">
      <span>{{ data.oldLabel }}<small class="diff-eol diff-eol-old">{{ data.oldText.includes('\r\n') ? 'CRLF' : 'LF' }}</small></span>
      <span>{{ data.newLabel }} · 你的版本<small class="diff-eol diff-eol-new">{{ data.newText.includes('\r\n') ? 'CRLF' : 'LF' }}</small></span>
    </div>
    <p v-if="error" class="error small submit-diff-notice" role="alert">{{ error }}</p>
    <p v-if="data?.notice" class="small submit-diff-notice">{{ data.notice }}</p>
    <div ref="host" class="submit-diff-host" :aria-busy="loading" />
    <div class="submit-diff-status small muted">
      {{ loading ? '读取中…' : status || (data?.binary ? '二进制文件无法编辑' : editable ? 'HEAD → 工作区 · Ctrl+S 保存 · 离焦时询问保存' : data ? '此文件只读' : '') }}
    </div>
  </div>
</template>

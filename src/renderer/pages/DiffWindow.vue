<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import type {
  ChangeFile,
  ConflictContent,
  DiffWindowRequest,
  FileComparison,
  RepositoryState,
} from "../../shared/git-client";
import { conflictBlocks } from "../../shared/conflicts";
import { comparisonLabels, gitOperationLabel } from "../../shared/git-labels";
import { revertLines } from "../../shared/diff-edit";
import { monaco, language, diffCodeOptions, ideaLineDecorations } from "../monaco";
import { DiffScrollbar } from "../diff-scrollbar";
import VirtualFiles from "../components/VirtualFiles.vue";
import Icon from "../components/Icon.vue";
import CloseButton from "../components/CloseButton.vue";
const request = ref<DiffWindowRequest>(),
  projectName = ref(""),
  files = ref<ChangeFile[]>([]),
  file = ref(""),
  query = ref(""),
  statusFilter = ref(""),
  data = ref<FileComparison>(),
  conflict = ref<ConflictContent>();
const repository = ref<RepositoryState>();
const loading = ref(false),
  busy = ref(false),
  error = ref(""),
  result = ref(""),
  showFiles = ref(false),
  sidebarWidth = ref(240),
  settingsOpen = ref(false),
  showOperations = ref(false),
  dirty = ref(false),
  stale = ref(false),
  hunk = ref(0),
  block = ref(0),
  blockCount = ref(0),
  diffCount = ref(0);
const currentDifference = ref(-1),
  currentRevert = ref(0),
  navigating = ref(false);
const crossFileHint = ref<"next" | "previous" | "">("");
const historyState = ref({ undo: false, redo: false });
const host = ref<HTMLElement>(),
  oursHost = ref<HTMLElement>(),
  resultHost = ref<HTMLElement>(),
  theirsHost = ref<HTMLElement>();
const settings = ref({
  split: true,
  dark: false,
  fontSize: 14,
  wrap: false,
  ignoreWhitespace: false,
  fold: false,
  highlight: "words",
});
try {
  const current = localStorage.getItem("git-diff-settings-v2");
  Object.assign(
    settings.value,
    JSON.parse(current || localStorage.getItem("git-diff-settings") || "{}"),
  );
  if (!current) settings.value.dark = false;
  localStorage.setItem("git-diff-settings-v2", JSON.stringify(settings.value));
} catch {}
let editor: monaco.editor.IStandaloneDiffEditor | undefined,
  mergeEditors: monaco.editor.IStandaloneCodeEditor[] = [],
  models: monaco.editor.ITextModel[] = [],
  listeners: monaco.IDisposable[] = [],
  requestId = 0,
  disposed = false,
  unsubscribe: (() => void) | undefined,
  unsubscribeChanged: (() => void) | undefined,
  dragging = false;
let originalHighlights: string[] = [],
  modifiedHighlights: string[] = [],
  revertGlyphs: string[] = [],
  originalSelections: string[] = [],
  modifiedSelections: string[] = [];
let savedText = "", saveRequested = false, saving: Promise<void> | undefined;
let originalGutter: HTMLDivElement | undefined;
let outerScrollbars: DiffScrollbar[] = [];
const glyphHunks = new Map<number, number>();
let pendingReveal: { id: number; edge: "first" | "last" } | undefined;
const filtered = computed(() =>
  files.value.filter(
    (f) =>
      (!query.value ||
        f.path.toLowerCase().includes(query.value.toLowerCase())) &&
      (!f.untracked ||
        f.inTrackedDirectory !== false) &&
      (!statusFilter.value || f.status.startsWith(statusFilter.value)),
  ),
);
const hiddenUntrackedCount = computed(() =>
  files.value.filter(
        (file) => file.untracked && file.inTrackedDirectory === false,
      ).length,
);
const isConflict = computed(() => !!conflict.value),
  canEdit = computed(
    () => !!data.value?.editable && !isConflict.value,
  );
const isLocal = computed(
  () => request.value && request.value.comparison.mode !== "versions",
);
const filePosition = computed(
  () => filtered.value.findIndex((value) => value.path === file.value) + 1,
);
const api = <T = any,>(name: string, p: Record<string, any> = {}) =>
  window.workbench
    .call<T>(
      name,
      JSON.parse(JSON.stringify({ ...p, projectId: request.value?.projectId })),
    )
    .then((r) => {
      if (!r.ok) throw new Error(r.error || "操作失败");
      return r.data as T;
    });
function disposeModels() {
  for (const listener of listeners) listener.dispose();
  listeners = [];
  editor?.setModel(null);
  for (const e of mergeEditors) e.setModel(null);
  for (const model of models) model.dispose();
  models = [];
  originalHighlights = [];
  modifiedHighlights = [];
  revertGlyphs = [];
  originalSelections = [];
  modifiedSelections = [];
  if (originalGutter) originalGutter.replaceChildren();
  outerScrollbars.forEach((bar) => bar.setChanges([]));
  glyphHunks.clear();
}
function commonOptions() {
  return diffCodeOptions(settings.value.fontSize, settings.value.wrap);
}
function applySettings() {
  monaco.editor.setTheme(
    settings.value.dark ? "workbench-dark" : "workbench-light",
  );
  editor?.updateOptions({
    ...commonOptions(),
    readOnly: !canEdit.value,
    renderSideBySide: settings.value.split,
    useInlineViewWhenSpaceIsLimited: false,
    ignoreTrimWhitespace: settings.value.ignoreWhitespace,
    hideUnchangedRegions: {
      enabled: settings.value.fold,
      contextLineCount: 3,
      minimumLineCount: 8,
      revealLineCount: 20,
    },
    renderMarginRevertIcon: false,
    originalEditable: false,
    renderIndicators: false,
    enableSplitViewResizing: true,
    renderOverviewRuler: false,
  });
  editor
    ?.getModifiedEditor()
    .updateOptions({ glyphMargin: true, lineNumbersMinChars: 3, overviewRulerLanes: 0,
      scrollbar: { vertical: "hidden", verticalScrollbarSize: 14 } });
  editor
    ?.getOriginalEditor()
    .updateOptions({ glyphMargin: false, lineNumbers: settings.value.split ? "off" : "on", lineDecorationsWidth: 22, scrollBeyondLastColumn: 8, overviewRulerLanes: 0,
      scrollbar: { vertical: "hidden", verticalScrollbarSize: 0 } });
  outerScrollbars[0]?.setVisible(settings.value.split);
  mergeEditors.forEach((e, index) =>
    e.updateOptions({
      ...commonOptions(),
      readOnly: index !== 1 || !conflict.value?.editable,
    }),
  );
  updateDiffPresentation();
}
watch(
  settings,
  () => {
    applySettings();
    localStorage.setItem(
      "git-diff-settings-v2",
      JSON.stringify(settings.value),
    );
  },
  { deep: true },
);
watch([busy, stale, loading], updateRevertGlyphs);
function updateRevertGlyphs() {
  if (!editor || conflict.value || models.length !== 2 || !data.value) return;
  glyphHunks.clear();
  const available =
    canEdit.value &&
    !busy.value &&
    !stale.value &&
    !loading.value;
  const decorations: monaco.editor.IModelDeltaDecoration[] = [];
  for (const [index, chunk] of (canEdit.value ? liveReverts() : []).entries()) {
    const line = Math.max(
      1,
      Math.min(models[1].getLineCount(), chunk.newStart),
    );
    glyphHunks.set(line, index);
    decorations.push({
      range: new monaco.Range(line, 1, line, 1),
      options: {
        glyphMarginClassName: `git-revert-glyph${available ? "" : " git-revert-disabled"}`,
        glyphMarginHoverMessage: {
          value: available
            ? "Revert 此处差异（立即恢复左侧内容；Ctrl+Z 撤销；暂存区保留）"
            : stale.value ? "文件已在外部变化，请先刷新。" : "正在读取或保存，请稍候。",
        },
        zIndex: 20,
      },
    });
  }
  revertGlyphs = models[1].deltaDecorations(revertGlyphs, decorations);
}
function syncCursor(line: number) {
  const changes = editor?.getLineChanges() || [];
  currentDifference.value = changes.findIndex(
    (change) =>
      line >= Math.max(1, change.modifiedStartLineNumber) &&
      line <=
        Math.max(
          1,
          change.modifiedEndLineNumber || change.modifiedStartLineNumber,
        ),
  );
  let index = 0;
  liveReverts().forEach((chunk, i) => {
    if (chunk.newStart <= line) index = i;
  });
  currentRevert.value = index;
}
function revealDifference(index: number) {
  const changes = editor?.getLineChanges(),
    change = changes?.[index];
  if (!editor || !change) return;
  currentDifference.value = index;
  const line = Math.max(
    1,
    Math.min(
      editor.getModifiedEditor().getModel()!.getLineCount(),
      change.modifiedStartLineNumber,
    ),
  );
  editor.getModifiedEditor().setPosition({ lineNumber: line, column: 1 });
  editor.getModifiedEditor().revealLineInCenter(line);
}
function updateDiffPresentation() {
  if (!editor || conflict.value || models.length !== 2) return;
  const changes = editor.getLineChanges();
  if (!changes) return;
  diffCount.value = changes.length;
  const { original, modified } = ideaLineDecorations(settings.value.dark ? [] : changes);
  originalHighlights = models[0].deltaDecorations(originalHighlights, original);
  modifiedHighlights = models[1].deltaDecorations(modifiedHighlights, modified);
  if (pendingReveal?.id === requestId) {
    const edge = pendingReveal.edge;
    pendingReveal = undefined;
    if (changes.length)
      revealDifference(edge === "last" ? changes.length - 1 : 0);
  }
  syncCursor(editor.getModifiedEditor().getPosition()?.lineNumber || 1);
  updateRevertGlyphs();
  updateOriginalGutter();
  outerScrollbars.forEach((bar) => bar.setChanges(changes));
}
function liveReverts() {
  if (!dirty.value && data.value?.revertHunks.length) return data.value.revertHunks;
  return (editor?.getLineChanges() || []).map((change, index) => ({
    index,
    oldStart: change.originalEndLineNumber ? change.originalStartLineNumber : change.originalStartLineNumber + 1,
    oldCount: change.originalEndLineNumber ? change.originalEndLineNumber - change.originalStartLineNumber + 1 : 0,
    newStart: change.modifiedEndLineNumber ? change.modifiedStartLineNumber : change.modifiedStartLineNumber + 1,
    newCount: change.modifiedEndLineNumber ? change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1 : 0,
  }));
}
function revertAt(index: number) {
  if (!canEdit.value || !data.value || busy.value || stale.value || loading.value) return;
  const change = liveReverts()[index], modified = editor?.getModifiedEditor();
  if (!change || !modified) return;
  const text = revertLines(models[0].getValue(), models[1].getValue(), change);
  const before = models[1].getValue();
  let start = 0, oldEnd = before.length, newEnd = text.length;
  while (start < oldEnd && start < newEnd && before[start] === text[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
  const from = models[1].getPositionAt(start), to = models[1].getPositionAt(oldEnd);
  // One editor operation is one undo step; preserve the model when saving.
  modified.pushUndoStop();
  modified.executeEdits("workbench.revert", [{ range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: text.slice(start, newEnd) }]);
  modified.pushUndoStop();
  modified.focus();
  void persistEditor();
}
function updateSelection(side: "original" | "modified") {
  if (!editor || models.length !== 2) return;
  const code = side === "original" ? editor.getOriginalEditor() : editor.getModifiedEditor();
  const selections = (code.getSelections() || []).filter((selection) => !selection.isEmpty());
  const previous = side === "original" ? originalSelections : modifiedSelections;
  const next = code.getModel()!.deltaDecorations(previous, selections.map((range) => ({ range,
    options: { className: "idea-selected-code", inlineClassName: "idea-selected-text", zIndex: 100 },
  })));
  if (side === "original") originalSelections = next;
  else modifiedSelections = next;
}
function updateOriginalGutter() {
  if (!editor || !originalGutter || !models[0]) return;
  originalGutter.hidden = !settings.value.split;
  const code = editor.getOriginalEditor(), lineHeight = code.getOption(monaco.editor.EditorOption.lineHeight);
  originalGutter.style.height = code.getLayoutInfo().height + "px";
  const fragment = document.createDocumentFragment();
  for (const range of code.getVisibleRanges())
    for (let line = range.startLineNumber; line <= range.endLineNumber; line++) {
      const number = document.createElement("span");
      number.textContent = String(line);
      number.style.top = code.getTopForLineNumber(line) - code.getScrollTop() + "px";
      number.style.height = number.style.lineHeight = lineHeight + "px";
      fragment.append(number);
    }
  originalGutter.replaceChildren(fragment);
}
function updateHistory() {
  const model = isConflict.value ? mergeEditors[1]?.getModel() : editor?.getModifiedEditor().getModel();
  historyState.value = { undo: model?.canUndo() || false, redo: model?.canRedo() || false };
}
function undoRedo(redo: boolean) {
  const code = isConflict.value ? mergeEditors[1] : editor?.getModifiedEditor();
  if (!code || (!canEdit.value && !conflict.value?.editable)) return;
  code.trigger("keyboard", redo ? "redo" : "undo", null);
  code.focus();
  queueMicrotask(updateHistory);
}
function persistEditor(): Promise<void> {
  if (!canEdit.value || stale.value || !editor || !data.value) return Promise.resolve();
  saveRequested = true;
  if (saving) return saving;
  const id = requestId;
  saving = (async () => {
    busy.value = true;
    error.value = "";
    try {
      while (saveRequested && id === requestId && !disposed) {
        saveRequested = false;
        const text = models[1].getValue();
        if (text === savedText) continue;
        const response = await api<{ value: { token: string } }>("git.save", { token: data.value!.token, text });
        if (id !== requestId || disposed) return;
        data.value!.token = response.value.token;
        data.value!.newText = savedText = text;
        data.value!.canPatch = false;
        data.value!.hunks = [];
        data.value!.revertHunks = [];
        dirty.value = models[1].getValue() !== savedText;
      }
      await refreshFiles();
      if (id === requestId && !dirty.value && files.value.some((item) => item.path === file.value))
        data.value = await api<FileComparison>("git.content", { comparison: request.value!.comparison, file: file.value });
      result.value = "已保存 · Ctrl+Z 撤销 / Ctrl+Y 重做";
    } catch (value) {
      error.value = value instanceof Error ? value.message : String(value);
      if (/外部修改|过期/.test(error.value)) stale.value = true;
    } finally {
      busy.value = false;
      saving = undefined;
      updateDiffPresentation();
      if (saveRequested && !stale.value) void persistEditor();
    }
  })();
  return saving;
}
async function canLeave() {
  if (busy.value) return false;
  if (!dirty.value) return true;
  const allowed = await api<boolean>("git.confirm-leave");
  if (allowed) dirty.value = false;
  return allowed;
}
function createModel(text: string, side: string) {
  return monaco.editor.createModel(
    text,
    language(file.value),
    monaco.Uri.parse(
      `inmemory://git/${encodeURIComponent(request.value?.projectId || "project")}/${side}/${Date.now()}/${encodeURIComponent(file.value)}`,
    ),
  );
}
function updateBlocks() {
  const model = mergeEditors[1]?.getModel();
  if (!model) return;
  const blocks = conflictBlocks(model.getValue());
  blockCount.value = blocks.length;
  block.value = Math.max(0, Math.min(block.value, blocks.length - 1));
  model.deltaDecorations(
    model
      .getAllDecorations()
      .filter((d) => d.options.className === "git-conflict-block")
      .map((d) => d.id),
    blocks.map((b) => ({
      range: new monaco.Range(b.startLine, 1, b.endLine, 1),
      options: {
        isWholeLine: true,
        className: "git-conflict-block",
        linesDecorationsClassName: "git-conflict-gutter",
      },
    })),
  );
}
async function mountData(id: number) {
  await nextTick();
  if (id !== requestId || disposed) return;
  disposeModels();
  if (conflict.value) {
    if (!mergeEditors.length) {
      mergeEditors = [
        oursHost.value!,
        resultHost.value!,
        theirsHost.value!,
      ].map((h) => monaco.editor.create(h, commonOptions()));
    }
    const c = conflict.value;
    models = [
      createModel(c.ours, "stage-2"),
      createModel(c.result, "merge-result"),
      createModel(c.theirs, "stage-3"),
    ];
    mergeEditors.forEach((e, index) => e.setModel(models[index]));
    [c.oursChanges, c.theirsChanges].forEach((changes, index) => {
      models[index === 0 ? 0 : 2].deltaDecorations(
        [],
        changes.map((range) => ({
          range: new monaco.Range(range.start, 1, range.end, 1),
          options: {
            isWholeLine: true,
            className: "git-conflict-side",
            linesDecorationsClassName: "git-conflict-gutter",
          },
        })),
      );
    });
    listeners.push(
      models[1].onDidChangeContent(() => {
        dirty.value = true;
        updateBlocks();
      }),
    );
    let synchronizing = false;
    mergeEditors.forEach((e) =>
      listeners.push(
        e.onDidScrollChange((event) => {
          if (synchronizing) return;
          synchronizing = true;
          mergeEditors.forEach((other) => {
            if (other !== e) other.setScrollTop(event.scrollTop);
          });
          synchronizing = false;
        }),
      ),
    );
    updateBlocks();
    if (pendingReveal?.id === id) {
      block.value =
        pendingReveal.edge === "last" ? Math.max(0, blockCount.value - 1) : 0;
      pendingReveal = undefined;
      const chosen = conflictBlocks(models[1].getValue())[block.value];
      if (chosen) mergeEditors[1].revealLineInCenter(chosen.startLine);
    }
  } else if (data.value) {
    if (!editor) {
      editor = monaco.editor.createDiffEditor(host.value!, {
        ...commonOptions(),
        renderSideBySide: true,
        renderMarginRevertIcon: false,
        originalEditable: false,
      });
      originalGutter = document.createElement("div");
      originalGutter.className = "idea-original-gutter";
      editor.getOriginalEditor().addOverlayWidget({
        getId: () => "idea-original-line-numbers",
        getDomNode: () => originalGutter!,
        getPosition: () => ({ preference: monaco.editor.OverlayWidgetPositionPreference.TOP_RIGHT_CORNER }),
      });
      outerScrollbars = [
        new DiffScrollbar(editor.getOriginalEditor(), "original"),
        new DiffScrollbar(editor.getModifiedEditor(), "modified"),
      ];
    }
    models = [
      createModel(data.value.oldText, "original"),
      createModel(data.value.newText, "modified"),
    ];
    editor.setModel({ original: models[0], modified: models[1] });
    savedText = data.value.newText;
    listeners.push(models[1].onDidChangeContent((event) => {
      dirty.value = models[1].getValue() !== savedText;
      crossFileHint.value = "";
      queueMicrotask(updateHistory);
      if (event.isUndoing || event.isRedoing) void persistEditor();
    }));
    for (const side of ["original", "modified"] as const) {
      const code = side === "original" ? editor.getOriginalEditor() : editor.getModifiedEditor();
      listeners.push(code.onDidChangeCursorSelection(() => updateSelection(side)));
    }
    listeners.push(editor.getOriginalEditor().onDidScrollChange(updateOriginalGutter));
    listeners.push(editor.getOriginalEditor().onDidLayoutChange(updateOriginalGutter));
    listeners.push(
      editor.onDidUpdateDiff(() => {
        if (id === requestId) updateDiffPresentation();
      }),
    );
    listeners.push(
      editor.getModifiedEditor().onDidChangeCursorPosition((event) => {
        crossFileHint.value = "";
        syncCursor(event.position.lineNumber);
        const hunks = data.value?.hunks || [];
        let current = 0;
        hunks.forEach((v, i) => {
          if (v.newStart <= event.position.lineNumber) current = i;
        });
        hunk.value = current;
      }),
    );
    listeners.push(
      editor.getModifiedEditor().onMouseDown((event) => {
        if (
          event.target.type ===
            monaco.editor.MouseTargetType.GUTTER_GLYPH_MARGIN &&
          event.target.position &&
          event.event.leftButton
        ) {
          const index = glyphHunks.get(event.target.position.lineNumber);
          if (index !== undefined) revertAt(index);
        }
      }),
    );
    listeners.push(
      editor
        .getModifiedEditor()
        .addAction({
          id: "workbench.revert-change",
          label: "Revert 此处差异",
          contextMenuGroupId: "navigation",
          contextMenuOrder: 1,
          keybindings: [
            monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyZ,
          ],
          run: () => revertAt(currentRevert.value),
        }),
    );
  }
  dirty.value = false;
  updateHistory();
  applySettings();
}
async function loadFile(
  next: string,
  guard = true,
  edge: "first" | "last" = "first",
) {
  if (!request.value || (guard && !(await canLeave()))) return;
  const id = ++requestId;
  pendingReveal = { id, edge };
  currentDifference.value = -1;
  diffCount.value = 0;
  currentRevert.value = 0;
  crossFileHint.value = "";
  file.value = next;
  document.title = `${next.split(/[\\/]/).pop()} (${projectName.value}) [Git 对比]`;
  loading.value = true;
  error.value = "";
  stale.value = false;
  hunk.value = 0;
  block.value = 0;
  data.value = undefined;
  conflict.value = undefined;
  disposeModels();
  const selected = files.value.find((f) => f.path === next),
    conflicted = !!selected?.conflicted && isLocal.value;
  try {
    if (conflicted) {
      const value = await api<ConflictContent>("git.conflict", { file: next });
      if (id !== requestId || disposed) return;
      conflict.value = value;
    } else {
      const value = await api<FileComparison>("git.content", {
        comparison: request.value.comparison,
        file: next,
      });
      if (id !== requestId || disposed) return;
      data.value = value;
    }
    await mountData(id);
  } catch (e) {
    if (id === requestId)
      error.value = e instanceof Error ? e.message : String(e);
  } finally {
    if (id === requestId) loading.value = false;
  }
}
async function refreshFiles() {
  if (!request.value) return;
  files.value = await api<ChangeFile[]>("git.files", {
    comparison: request.value.comparison,
  });
  if (isLocal.value)
    repository.value = await api<RepositoryState>("git.status");
}
async function changeMode(event: Event) {
  if (!request.value) return;
  const mode = (event.target as HTMLSelectElement).value as
    | "local"
    | "staged"
    | "unstaged";
  if (!(await canLeave())) {
    (event.target as HTMLSelectElement).value = request.value.comparison.mode;
    return;
  }
  ++requestId;
  data.value = undefined;
  conflict.value = undefined;
  disposeModels();
  request.value.comparison = { mode };
  await refresh();
}
async function acceptRequest(value: DiffWindowRequest) {
  ++requestId;
  data.value = undefined;
  conflict.value = undefined;
  disposeModels();
  request.value = value;
  query.value = "";
  statusFilter.value = "";
  result.value = "";
  try {
    await refreshFiles();
    if (files.value.length)
      await loadFile(
        files.value.some((f) => f.path === value.file)
          ? value.file
          : files.value[0].path,
        false,
      );
    else {
      file.value = "";
      data.value = undefined;
      conflict.value = undefined;
      disposeModels();
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
async function refresh() {
  if (!(await canLeave())) return;
  try {
    await refreshFiles();
    if (files.value.some((f) => f.path === file.value))
      await loadFile(file.value, false);
    else if (files.value.length) await loadFile(files.value[0].path, false);
    else {
      ++requestId;
      disposeModels();
      file.value = "";
      data.value = undefined;
      conflict.value = undefined;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}
async function write(name: string, p: Record<string, any>) {
  if (name === "git.save") return persistEditor();
  if (busy.value || loading.value) return;
  if (dirty.value && !["git.save", "git.resolve"].includes(name)) {
    error.value = "请先保存编辑结果，再执行 Git 操作。";
    return;
  }
  busy.value = true;
  const order = filtered.value.map((value) => value.path),
    position = order.indexOf(file.value);
  error.value = "";
  if (name === "git.execute" && p.operation === "rollback")
    p.token = data.value?.token;
  try {
    const response = await api<any>(name, p);
    if (!response?.cancelled) {
      dirty.value = false;
      result.value = response.output || "操作完成";
      await refreshFiles();
      if (files.value.some((f) => f.path === file.value))
        await loadFile(file.value, false);
      else {
        disposeModels();
        data.value = undefined;
        conflict.value = undefined;
        if (filtered.value.length) {
          const paths = new Set(filtered.value.map((value) => value.path));
          const next =
            order.slice(position + 1).find((path) => paths.has(path)) ||
            order
              .slice(0, position)
              .reverse()
              .find((path) => paths.has(path)) ||
            filtered.value[0].path;
          await loadFile(next, false);
        }
      }
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    busy.value = false;
  }
}
async function navigateDiff(direction: "next" | "previous") {
  if (loading.value || busy.value || navigating.value) return;
  const step = direction === "next" ? 1 : -1;
  if (isConflict.value) {
    const blocks = conflictBlocks(mergeEditors[1]?.getValue() || "");
    const next = block.value + step;
    if (next >= 0 && next < blocks.length) {
      block.value = next;
      mergeEditors[1].revealLineInCenter(blocks[next].startLine);
      return;
    }
  } else {
    const changes = editor?.getLineChanges() || [],
      line = editor?.getModifiedEditor().getPosition()?.lineNumber || 1;
    const next =
      currentDifference.value >= 0
        ? currentDifference.value + step
        : direction === "next"
          ? changes.findIndex((change) => change.modifiedStartLineNumber > line)
          : changes.reduce(
              (last, change, index) =>
                Math.max(
                  change.modifiedEndLineNumber,
                  change.modifiedStartLineNumber,
                ) < line
                  ? index
                  : last,
              -1,
            );
    if (next >= 0 && next < changes.length) {
      revealDifference(next);
      return;
    }
  }
  const index = filtered.value.findIndex((value) => value.path === file.value),
    next =
      index < 0
        ? direction === "next"
          ? 0
          : filtered.value.length - 1
        : index + step;
  if (next < 0 || next >= filtered.value.length) {
    crossFileHint.value = "";
    result.value =
      direction === "next" ? "已到最后一个对比文件" : "已到第一个对比文件";
    return;
  }
  if (crossFileHint.value !== direction) {
    crossFileHint.value = direction;
    result.value = direction === "next" ? "再按一次跳到下一个文件" : "再按一次跳到上一个文件";
    return;
  }
  crossFileHint.value = "";
  navigating.value = true;
  try {
    await loadFile(
      filtered.value[next].path,
      true,
      direction === "next" ? "first" : "last",
    );
  } catch (value) {
    error.value = value instanceof Error ? value.message : String(value);
  } finally {
    navigating.value = false;
  }
}
function goHunk() {
  const current = data.value?.hunks[hunk.value];
  if (current)
    editor
      ?.getModifiedEditor()
      .revealLineInCenter(Math.max(1, current.newStart));
}
function acceptSide(side: "ours" | "theirs" | "both") {
  if (!conflict.value?.editable) return;
  const model = mergeEditors[1]?.getModel();
  if (!model) return;
  const current = conflictBlocks(model.getValue())[block.value];
  if (!current) return;
  const start = model.getPositionAt(current.start),
    end = model.getPositionAt(current.end);
  mergeEditors[1].executeEdits("accept-conflict", [
    {
      range: new monaco.Range(
        start.lineNumber,
        start.column,
        end.lineNumber,
        end.column,
      ),
      text:
        side === "ours"
          ? current.ours
          : side === "theirs"
            ? current.theirs
            : current.ours + current.theirs,
      forceMoveMarkers: true,
    },
  ]);
  mergeEditors[1].focus();
}
function moveSidebar(event: PointerEvent) {
  dragging = true;
  (event.target as HTMLElement).setPointerCapture(event.pointerId);
}
function resizeSidebar(event: PointerEvent) {
  if (dragging)
    sidebarWidth.value = Math.max(160, Math.min(600, event.clientX));
}
function key(event: KeyboardEvent) {
  const element = event.target as HTMLElement;
  if ((event.ctrlKey || event.metaKey) && ["z", "y"].includes(event.key.toLowerCase()) &&
      !element.closest(".find-widget") &&
      (!element.closest("input,textarea,select") || !!element.closest(".monaco-editor"))) {
    const code = isConflict.value ? mergeEditors[1] : editor?.getModifiedEditor();
    if (code && (canEdit.value || conflict.value?.editable)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      undoRedo(event.key.toLowerCase() === "y" || event.shiftKey);
    }
    return;
  }
  if (event.key === "F11") {
    event.preventDefault();
    void api("git.fullscreen");
  }
  if (event.key === "F7") {
    event.preventDefault();
    event.stopPropagation();
    void navigateDiff(event.shiftKey ? "previous" : "next");
  }
  if (event.key === "F5") {
    event.preventDefault();
    void refresh();
  }
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
    event.preventDefault();
    if (dirty.value && data.value?.editable)
      void write("git.save", {
        token: data.value.token,
        text: editor?.getModifiedEditor().getValue(),
      });
  }
  if (event.key === "Escape") settingsOpen.value = false;
}
async function validate() {
  if (
    disposed ||
    busy.value ||
    !file.value ||
    !(data.value?.token || conflict.value?.token)
  )
    return;
  try {
    await api("git.validate-token", {
      token: data.value?.token || conflict.value?.token,
      conflict: isConflict.value,
    });
  } catch {
    stale.value = true;
  }
}
onMounted(async () => {
  window.__workbenchCanClose = canLeave;
  window.addEventListener("keydown", key, true);
  window.addEventListener("focus", validate);
  window.addEventListener("beforeunload", disposeViewer);
  unsubscribe = window.workbench.onGitDiff(
    (value) => void acceptRequest(value),
  );
  unsubscribeChanged = window.workbench.onChanged(() => void validate());
  try {
    const initial = await api<{
      request: DiffWindowRequest;
      projectName: string;
    }>("git.window-context");
    projectName.value = initial.projectName;
    await acceptRequest(initial.request);
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
});
function disposeViewer() {
  if (disposed) return;
  disposed = true;
  ++requestId;
  unsubscribe?.();
  unsubscribeChanged?.();
  window.removeEventListener("keydown", key, true);
  window.removeEventListener("focus", validate);
  window.removeEventListener("beforeunload", disposeViewer);
  disposeModels();
  outerScrollbars.forEach((bar) => bar.dispose());
  editor?.dispose();
  mergeEditors.forEach((e) => e.dispose());
  delete window.__workbenchCanClose;
}
onBeforeUnmount(disposeViewer);
</script>
<template>
  <div class="diff-window" :class="{ 'diff-light': !settings.dark, 'diff-unified': !settings.split, 'diff-line-highlights': settings.highlight === 'lines', 'diff-no-highlights': settings.highlight === 'none' }">
    <header class="diff-toolbar">
      <button
        title="显示 / 隐藏文件列表"
        :aria-pressed="showFiles"
        @click="showFiles = !showFiles"
      >
        ☷</button
      ><strong class="diff-project">{{ projectName }}</strong
      ><span class="diff-toolbar-divider" /><span
        class="diff-current-path"
        :title="file"
        >{{ file || "Git 对比" }}</span
      ><button
        data-action="previous-difference"
        title="上一处差异 / 上一个文件（Shift+F7）"
        :disabled="loading || busy || navigating"
        @click="navigateDiff('previous')"
      >
        ↑</button
      ><button
        data-action="next-difference"
        title="下一处差异 / 下一个文件（F7）"
        :disabled="loading || busy || navigating"
        @click="navigateDiff('next')"
      >
        ↓</button
      ><button data-action="undo" title="撤销（Ctrl+Z）" :disabled="!historyState.undo || stale" @click="undoRedo(false)"><Icon name="arrow-left" :size="16" /></button
      ><button data-action="redo" title="重做（Ctrl+Y）" :disabled="!historyState.redo || stale" @click="undoRedo(true)"><Icon name="arrow-right" :size="16" /></button
      ><span class="diff-toolbar-divider" />
      <select v-if="!isConflict" v-model="settings.split" aria-label="对比布局">
        <option :value="true">双栏对比</option><option :value="false">单栏对比</option>
      </select>
      <select v-model="settings.ignoreWhitespace" aria-label="空白处理">
        <option :value="false">显示空白差异</option><option :value="true">忽略首尾空白</option>
      </select>
      <select v-model="settings.highlight" aria-label="差异高亮">
        <option value="words">按单词高亮</option><option value="lines">按行高亮</option><option value="none">不高亮</option>
      </select>
      <span class="diff-toolbar-divider" />
      <select v-if="isLocal" :value="request?.comparison.mode" aria-label="比较来源" :disabled="busy || loading" @change="changeMode">
        <option value="local">HEAD ↔ 工作区</option><option value="staged">HEAD ↔ 暂存区</option>
        <option v-if="request?.comparison.mode === 'history'" value="history">{{ request.comparison.base }} ↔ 工作区</option>
        <option value="unstaged">暂存区 ↔ 工作区</option>
      </select>
      <button
        title="文件内搜索（Ctrl+F）"
        @click="
          (isConflict ? mergeEditors[1] : editor?.getModifiedEditor())
            ?.getAction('actions.find')
            ?.run()
        "
      >
        查找</button
      ><button
        v-if="canEdit"
        data-action="revert-current"
        :disabled="busy || loading || !diffCount || stale"
        title="Revert 当前差异（Ctrl+Alt+Z）"
        @click="revertAt(currentRevert)"
      >
        ↶ Revert</button
      ><button v-if="canEdit" title="保存（Ctrl+S）" :disabled="!dirty || busy || stale" @click="persistEditor"><Icon name="save" :size="15" /></button
      ><button title="Git 操作" :aria-pressed="showOperations" @click="showOperations = !showOperations">Git 操作</button
      ><button title="刷新（F5）" :disabled="busy" @click="refresh">↻</button
      ><button
        :aria-expanded="settingsOpen"
        @click="settingsOpen = !settingsOpen"
      >
        设置 ⚙
      </button><span class="diff-toolbar-count">{{ diffCount }} 处差异</span>
    </header>
    <div v-if="settingsOpen" class="diff-settings">
      <label><input v-model="settings.dark" type="checkbox" />深色主题</label
      ><label
        >字号<input
          v-model.number="settings.fontSize"
          type="number"
          min="10"
          max="28" /></label
      ><label><input v-model="settings.wrap" type="checkbox" />自动换行</label
      ><label
        ><input
          v-model="settings.ignoreWhitespace"
          type="checkbox"
        />忽略首尾空白差异</label
      ><label
        ><input v-model="settings.fold" type="checkbox" />折叠未修改区域</label
      >
    </div>
    <div v-if="error" class="diff-alert" role="alert">
      <span>{{ error }}</span>
      <CloseButton label="关闭错误" @click="error = ''" />
    </div>
    <div v-if="stale" class="diff-alert">
      文件或暂存区已在外部变化。请刷新后操作；当前内容保留。<button
        @click="refresh"
      >
        刷新
      </button>
    </div>
    <div v-if="repository?.operation" class="diff-merge-toolbar">
      <span
        >{{ gitOperationLabel(repository.operation) }} ·
        {{ repository.files.filter((f) => f.conflicted).length }} 个冲突</span
      ><button
        :disabled="busy || dirty || repository.files.some((f) => f.conflicted)"
        @click="write('git.execute', { operation: 'continue' })"
      >
        Continue</button
      ><button
        v-if="['rebase', 'cherry-pick'].includes(repository.operation)"
        :disabled="busy"
        @click="write('git.execute', { operation: 'skip' })"
      >
        Skip</button
      ><button
        :disabled="busy"
        @click="write('git.execute', { operation: 'abort' })"
      >
        Abort
      </button>
    </div>
    <div class="diff-body">
      <aside
        v-show="showFiles"
        class="diff-files"
        :style="{ width: sidebarWidth + 'px' }"
      >
        <div class="diff-files-header">
          变更文件 <span>{{ files.length }}</span>
        </div>
        <div class="diff-file-filters">
          <input
            v-model="query"
            type="search"
            aria-label="搜索对比文件"
            placeholder="搜索文件路径"
          /><select v-model="statusFilter" aria-label="对比文件状态">
            <option value="">全部状态</option>
            <option value="M">已修改</option>
            <option value="A">新增</option>
            <option value="D">已删除</option>
            <option value="R">已重命名</option>
            <option value="??">未跟踪</option>
          </select>
          <small v-if="hiddenUntrackedCount"
            >已隐藏 {{ hiddenUntrackedCount }} 个</small
          >
        </div>
        <VirtualFiles
          :files="filtered"
          :selected="file"
          @select="loadFile($event.path)"
          @show="loadFile($event.path)"
        />
      </aside>
      <div
        v-show="showFiles"
        class="diff-resize"
        role="separator"
        aria-label="调整文件列表宽度"
        aria-orientation="vertical"
        @pointerdown="moveSidebar"
        @pointermove="resizeSidebar"
        @pointerup="dragging = false"
        @pointercancel="dragging = false"
      />
      <main class="diff-main">
        <div v-if="loading" class="diff-loading">正在按需读取完整文件…</div>
        <div v-if="isConflict" class="diff-merge-toolbar">
          <span>未解决冲突 {{ blockCount }} 个</span
          ><select v-model.number="block" aria-label="冲突块">
            <option v-for="n in blockCount" :key="n" :value="n - 1">
              冲突 {{ n }}
            </option></select
          ><button
            :disabled="!conflict?.editable || !blockCount || busy"
            @click="acceptSide('ours')"
          >
            接受左侧</button
          ><button
            :disabled="!conflict?.editable || !blockCount || busy"
            @click="acceptSide('theirs')"
          >
            接受右侧</button
          ><button
            :disabled="!conflict?.editable || !blockCount || busy"
            @click="acceptSide('both')"
          >
            接受两侧</button
          ><button
            :disabled="!!blockCount || busy || !conflict?.editable"
            @click="
              write('git.resolve', {
                token: conflict!.token,
                text: mergeEditors[1]?.getValue(),
              })
            "
          >
            保存并标记解决
          </button>
          <button
            v-if="conflict?.oursDeleted || conflict?.theirsDeleted"
            :disabled="!conflict?.editable || busy"
            @click="
              write('git.resolve', { token: conflict!.token, delete: true })
            "
          >
            接受文件删除…
          </button>
        </div>
        <div v-if="!isConflict && data" class="diff-version-labels">
          <span><Icon name="lock" :size="12" />{{ data.oldLabel }}<small class="diff-eol diff-eol-old">{{ data.oldText.includes('\r\n') ? 'CRLF' : 'LF' }}</small></span
          ><span><Icon :name="data.editable ? 'pencil' : 'lock'" :size="12" />{{ data.newLabel }}{{ data.editable ? " · 你的版本" : "" }}{{ dirty ? " · 未保存" : "" }}<small class="diff-eol diff-eol-new">{{ data.newText.includes('\r\n') ? 'CRLF' : 'LF' }}</small></span>
        </div>
        <div
          v-show="!isConflict"
          ref="host"
          class="diff-editor"
          :class="{ unavailable: data?.binary || data?.limited || !data }"
        />
        <div v-if="crossFileHint" class="diff-cross-file-hint" role="status">
          {{ crossFileHint === "next" ? "再按一次跳到下一个文件" : "再按一次跳到上一个文件" }}
          <small>{{ crossFileHint === "next" ? "点击 ↓ 或按 F7" : "点击 ↑ 或按 Shift+F7" }}</small>
        </div>
        <div v-show="isConflict" class="diff-three-way">
          <section>
            <div class="diff-pane-label">
              {{ conflict?.oursLabel
              }}{{ conflict?.oursDeleted ? " · 已删除" : "" }}
            </div>
            <div ref="oursHost" class="diff-editor" />
          </section>
          <section>
            <div class="diff-pane-label">
              合并结果 · {{ conflict?.editable ? "可编辑" : "只读"
              }}{{ dirty ? " · 未保存" : "" }}
            </div>
            <div ref="resultHost" class="diff-editor" />
          </section>
          <section>
            <div class="diff-pane-label">
              {{ conflict?.theirsLabel
              }}{{ conflict?.theirsDeleted ? " · 已删除" : "" }}
            </div>
            <div ref="theirsHost" class="diff-editor" />
          </section>
        </div>
        <div v-if="data?.notice || conflict?.notice" class="diff-notice">
          {{ data?.notice || conflict?.notice }}
        </div>
        <div v-if="!file && !loading" class="diff-empty">
          当前范围没有变更文件
        </div>
        <div
          v-if="showOperations && !isConflict && data && isLocal"
          class="diff-operation-toolbar"
        >
          <button
            :disabled="busy || dirty"
            @click="write('git.execute', { operation: 'stage', files: [file] })"
          >
            Stage 文件</button
          ><button
            :disabled="busy || dirty"
            @click="
              write('git.execute', { operation: 'unstage', files: [file] })
            "
          >
            Unstage 文件</button
          ><button
            :disabled="busy || dirty"
            @click="
              write('git.execute', { operation: 'rollback', files: [file] })
            "
          >
            回滚文件未暂存修改…</button
          ><template v-if="data.canPatch"
            ><span class="diff-toolbar-divider" /><select
              v-model.number="hunk"
              aria-label="当前差异块"
              @change="goHunk"
            >
              <option
                v-for="chunk in data.hunks"
                :key="chunk.index"
                :value="chunk.index"
              >
                块 {{ chunk.index + 1 }} · {{ chunk.header }}
              </option></select
            ><button
              v-if="request?.comparison.mode === 'unstaged'"
              :disabled="busy || dirty"
              @click="
                write('git.patch', {
                  operation: 'stage',
                  token: data!.token,
                  hunk,
                })
              "
            >
              Stage 此块</button
            ><button
              v-if="request?.comparison.mode === 'staged'"
              :disabled="busy || dirty"
              @click="
                write('git.patch', {
                  operation: 'unstage',
                  token: data!.token,
                  hunk,
                })
              "
            >
              Unstage 此块</button
            ><button
              v-if="request?.comparison.mode === 'unstaged'"
              :disabled="busy || dirty"
              @click="
                write('git.patch', {
                  operation: 'rollback',
                  token: data!.token,
                  hunk,
                })
              "
            >
              回滚此块…
            </button></template
          ><button
            v-if="data.editable"
            :disabled="!dirty || busy"
            @click="
              write('git.save', {
                token: data!.token,
                text: editor?.getModifiedEditor().getValue(),
              })
            "
          >
            保存（Ctrl+S）
          </button>
        </div>
      </main>
    </div>
    <footer class="diff-statusbar">
      <span>{{
        loading
          ? "读取中…"
          : busy
            ? "Git 操作中…"
            : dirty
              ? "编辑结果尚未保存"
              : canEdit || conflict?.editable ? "可编辑" : "只读对比"
      }}</span
      ><span v-if="data"
        >{{ data.encoding }} · {{ diffCount }} 处差异 ·
        {{ comparisonLabels[request?.comparison.mode || ""] }}</span
      ><span v-if="data && diffCount" class="diff-difference-position"
        >差异 {{ currentDifference >= 0 ? currentDifference + 1 : "—" }} /
        {{ diffCount }}</span
      ><span v-if="filePosition"
        >文件 {{ filePosition }} / {{ filtered.length }}</span
      ><span v-if="isConflict"
        >以 Git 暂存区三个阶段为准 · 在 Git 管理中 Continue / Abort</span
      ><span class="diff-status-result">{{ result.slice(-200) }}</span
      ><span>F7 / Shift+F7 跨文件 · F11 沉浸查看</span>
    </footer>
  </div>
</template>

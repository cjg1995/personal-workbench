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
import { appendDiffLines, revertLines } from "../../shared/diff-edit";
import {
  diffChangePosition,
  diffCodeOptions,
  ideaLineDecorations,
  language,
  monaco,
  revealDiffCaret,
} from "../monaco";
import { DiffScrollbar } from "../diff-scrollbar";
import { IdeaSplitEditor, type DiffAction, type Whitespace } from "../idea-split-editor";
import { useGitCommitDraft } from "../git-commit-draft";
import { matchInclusions, type Inclusion } from "../diff-inclusion";
import VirtualFiles from "../components/VirtualFiles.vue";
import Icon from "../components/Icon.vue";
import CloseButton from "../components/CloseButton.vue";
import MessageDialog from "../components/MessageDialog.vue";
const request = ref<DiffWindowRequest>(),
  projectName = ref(""),
  projectPath = ref(""),
  windowTitle = ref("Git 对比"),
  files = ref<ChangeFile[]>([]),
  file = ref(""),
  query = ref(""),
  statusFilter = ref(""),
  data = ref<FileComparison>(),
  conflict = ref<ConflictContent>();
const repository = ref<RepositoryState>();
const commitDraft = useGitCommitDraft(computed(() => request.value?.projectId));
const localCommit = computed(() => ["local", "unstaged", "staged"].includes(request.value?.comparison.mode || "") && !conflict.value);
const currentFile = computed(() => repository.value?.files.find(entry => entry.path === file.value));
const messageExpanded = ref(true);
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
  fontSize: 13,
  wrap: false,
  whitespace: "ignore" as Whitespace,
  fold: false,
  highlight: "words",
});
try {
  const current = localStorage.getItem("git-diff-settings-v3");
  if (current) Object.assign(settings.value, JSON.parse(current));
  else {
    const v2 = localStorage.getItem("git-diff-settings-v2");
    const old = JSON.parse(v2 || localStorage.getItem("git-diff-settings") || "{}");
    const { fontSize, ignoreWhitespace, ...other } = old;
    Object.assign(settings.value, other);
    if (!v2) settings.value.dark = false;
    if (fontSize && fontSize !== 14) settings.value.fontSize = fontSize;
    if (ignoreWhitespace) settings.value.whitespace = "trim";
  }
} catch {}
let editor: monaco.editor.IStandaloneDiffEditor | IdeaSplitEditor | undefined,
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
let outerScrollbars: DiffScrollbar[] = [];
let inclusionSources: { file: FileComparison; included: boolean }[] = [];
let inclusions = new Map<number, Inclusion>();
const glyphHunks = new Map<number, number>();
let pendingReveal: { id: number; edge: "first" | "last"; focusCaret: boolean } | undefined;
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
function detachEditors() {
  for (const listener of listeners) listener.dispose();
  listeners = [];
  if (models.length === 2) {
    models[0].deltaDecorations([...originalSelections, ...originalHighlights], []);
    models[1].deltaDecorations([...modifiedSelections, ...modifiedHighlights, ...revertGlyphs], []);
  }
  outerScrollbars.forEach(bar => bar.dispose());
  outerScrollbars = [];
  editor?.setModel(null);
  editor?.dispose();
  editor = undefined;
  originalHighlights = [];
  modifiedHighlights = [];
  revertGlyphs = [];
  originalSelections = [];
  modifiedSelections = [];
  glyphHunks.clear();
}
function disposeModels() {
  detachEditors();
  for (const e of mergeEditors) e.setModel(null);
  for (const model of models) model.dispose();
  models = [];
}
function commonOptions() {
  const size = settings.value.fontSize;
  return { ...diffCodeOptions(size, settings.value.wrap),
    fontFamily: '"Workbench JetBrains Mono", Consolas, "Microsoft YaHei", monospace',
    lineHeight: Math.round(size * 22 / 13),
    letterSpacing: Math.round(size * 0.6) - size * 0.6,
    padding: { top: 0, bottom: 0 } };
}
function applySettings() {
  if (editor && settings.value.split !== (editor instanceof IdeaSplitEditor)) {
    const position = editor.getModifiedEditor().getPosition();
    const oldVisibleLine = editor.getModifiedEditor().getVisibleRanges()[0]?.startLineNumber;
    const focused = editor.getModifiedEditor().hasTextFocus();
    detachEditors();
    diffCount.value = 0;
    attachComparison();
    if (position) editor.getModifiedEditor().setPosition(position);
    if (oldVisibleLine) editor.getModifiedEditor().revealLineNearTop(oldVisibleLine);
    if (focused) editor.getModifiedEditor().focus();
  }
  monaco.editor.setTheme(
    settings.value.dark ? "workbench-dark" : "workbench-light",
  );
  editor?.updateOptions({
    ...commonOptions(),
    readOnly: !canEdit.value,
    renderSideBySide: settings.value.split,
    useInlineViewWhenSpaceIsLimited: false,
    ignoreTrimWhitespace: settings.value.whitespace !== "all",
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
  if (editor instanceof IdeaSplitEditor) editor.configure(settings.value.whitespace, settings.value.highlight);
  else editor
    ?.getModifiedEditor()
    .updateOptions({ glyphMargin: true, lineNumbersMinChars: 3, overviewRulerLanes: 0,
      scrollbar: { vertical: "hidden", verticalScrollbarSize: 14 } });
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
      "git-diff-settings-v3",
      JSON.stringify(settings.value),
    );
  },
  { deep: true },
);
watch([busy, stale, loading], updateRevertGlyphs);
watch(dirty, updateRevertGlyphs);
watch(() => [data.value?.token, settings.value.split, busy.value, dirty.value], async (_, __, invalidate) => {
  const comparison = data.value, mode = request.value?.comparison.mode;
  let active = true;
  invalidate(() => { active = false; });
  inclusionSources = [];
  inclusions.clear();
  updateRevertGlyphs();
  if (!comparison || busy.value || dirty.value || !settings.value.split || !localCommit.value || comparison.binary || comparison.limited) return;
  const current = currentFile.value;
  if (!current || current.oldPath || current.untracked || current.conflicted) return;
  const sources = (["staged", "unstaged"] as const).filter(side => current[side] && (mode === "local" || mode === side));
  if (mode === "local") {
    await new Promise(resolve => setTimeout(resolve, 150));
    if (!active) return;
  }
  const snapshots = await Promise.allSettled(sources.map(async side => ({
    included: side === "staged",
    file: mode === side ? comparison : await api<FileComparison>("git.content", { file: comparison.path, comparison: { mode: side }, watch: false }),
  })));
  if (!active || disposed || data.value?.token !== comparison.token) return;
  inclusionSources = snapshots.flatMap(item => item.status === "fulfilled" ? [item.value] : []);
  updateInclusions();
});
function updateInclusions() {
  if (!(editor instanceof IdeaSplitEditor) || !data.value) return;
  inclusions = dirty.value ? new Map() : matchInclusions(data.value, editor.getLineChanges() || [], inclusionSources);
  updateRevertGlyphs();
}
function toggleInclusion(index: number) {
  const item = inclusions.get(index);
  if (!item || dirty.value || busy.value || stale.value || loading.value) return;
  void write("git.patch", { token: item.token, hunk: item.hunk, operation: item.included ? "unstage" : "stage" });
}
function updateRevertGlyphs() {
  if (!editor || conflict.value || models.length !== 2 || !data.value) return;
  glyphHunks.clear();
  const available =
    canEdit.value &&
    !busy.value &&
    !stale.value &&
    !loading.value;
  if (editor instanceof IdeaSplitEditor) {
    editor.setRevertState(!canEdit.value ? "hidden" : available ? "enabled" : "disabled");
    const current = currentFile.value;
    editor.setInclusions(inclusions, localCommit.value && current ? (current.staged && current.unstaged ? "mixed" : current.staged) : null,
      !busy.value && !dirty.value && !stale.value && !loading.value);
    return;
  }
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
    (change) => {
      const first = diffChangePosition(models[1], change).lineNumber;
      return line >= first && line <= (change.modifiedEndLineNumber || first);
    },
  );
  let index = 0;
  liveReverts().forEach((chunk, i) => {
    if (chunk.newStart <= line) index = i;
  });
  currentRevert.value = index;
}
function revealDifference(index: number, focusCaret: boolean) {
  const changes = editor?.getLineChanges(),
    change = changes?.[index];
  if (!editor || !change) return;
  const code = editor.getModifiedEditor();
  const position = diffChangePosition(code.getModel()!, change);
  if (editor instanceof IdeaSplitEditor) {
    code.setPosition(position);
    editor.revealChange(change);
    if (focusCaret) {
      code.revealPosition(position, monaco.editor.ScrollType.Immediate);
      code.focus();
    }
  } else {
    revealDiffCaret(code, position, focusCaret);
  }
  currentDifference.value = index;
  currentRevert.value = index;
}
function updateDiffPresentation() {
  if (!editor || conflict.value || models.length !== 2) return;
  const changes = editor.getLineChanges();
  if (!changes) return;
  diffCount.value = changes.length;
  if (!(editor instanceof IdeaSplitEditor)) {
    const { original, modified } = ideaLineDecorations(settings.value.dark ? [] : changes);
    originalHighlights = models[0].deltaDecorations(originalHighlights, original);
    modifiedHighlights = models[1].deltaDecorations(modifiedHighlights, modified);
  }
  if (pendingReveal?.id === requestId) {
    const { edge, focusCaret } = pendingReveal;
    pendingReveal = undefined;
    if (changes.length)
      revealDifference(edge === "last" ? changes.length - 1 : 0, focusCaret);
  } else {
    syncCursor(editor.getModifiedEditor().getPosition()?.lineNumber || 1);
  }
  if (editor instanceof IdeaSplitEditor) updateInclusions();
  else updateRevertGlyphs();
  outerScrollbars.forEach((bar) => bar.setChanges(changes));
}
function liveReverts() {
  return (editor?.getLineChanges() || []).map((change, index) => ({
    index,
    oldStart: change.originalEndLineNumber ? change.originalStartLineNumber : change.originalStartLineNumber + 1,
    oldCount: change.originalEndLineNumber ? change.originalEndLineNumber - change.originalStartLineNumber + 1 : 0,
    newStart: change.modifiedEndLineNumber ? change.modifiedStartLineNumber : change.modifiedStartLineNumber + 1,
    newCount: change.modifiedEndLineNumber ? change.modifiedEndLineNumber - change.modifiedStartLineNumber + 1 : 0,
  }));
}
function applyDifference(index: number, action: DiffAction = "revert") {
  if (!canEdit.value || !data.value || busy.value || stale.value || loading.value) return;
  const change = liveReverts()[index], modified = editor?.getModifiedEditor();
  if (!change || !modified) return;
  const original = models[0].getValue();
  const before = models[1].getValue();
  const text = action === "append" ? appendDiffLines(original, before, change) : revertLines(original, before, change);
  if (text === before) return;
  let start = 0, oldEnd = before.length, newEnd = text.length;
  while (start < oldEnd && start < newEnd && before[start] === text[start]) start++;
  while (oldEnd > start && newEnd > start && before[oldEnd - 1] === text[newEnd - 1]) { oldEnd--; newEnd--; }
  const from = models[1].getPositionAt(start), to = models[1].getPositionAt(oldEnd);
  // One editor operation is one undo step; preserve the model when saving.
  modified.pushUndoStop();
  modified.executeEdits(`workbench.${action}`, [{ range: new monaco.Range(from.lineNumber, from.column, to.lineNumber, to.column), text: text.slice(start, newEnd) }]);
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
      const { edge, focusCaret } = pendingReveal;
      block.value =
        edge === "last" ? Math.max(0, blockCount.value - 1) : 0;
      pendingReveal = undefined;
      const chosen = conflictBlocks(models[1].getValue())[block.value];
      if (chosen) revealDiffCaret(mergeEditors[1], { lineNumber: chosen.startLine, column: 1 }, focusCaret);
    }
  } else if (data.value) {
    models = [
      createModel(data.value.oldText, "original"),
      createModel(data.value.newText, "modified"),
    ];
    savedText = data.value.newText;
    attachComparison();
  }
  dirty.value = false;
  updateHistory();
  applySettings();
}
function attachComparison() {
  editor = settings.value.split
    ? new IdeaSplitEditor(host.value!, commonOptions(), applyDifference, toggleInclusion)
    : monaco.editor.createDiffEditor(host.value!, { ...commonOptions(), renderSideBySide: false,
        renderMarginRevertIcon: false, originalEditable: false, renderOverviewRuler: false });
  if (editor instanceof IdeaSplitEditor) outerScrollbars.push(new DiffScrollbar(editor.getOriginalEditor(), "original"));
  outerScrollbars.push(new DiffScrollbar(editor.getModifiedEditor(), "modified"));
  editor.setModel({ original: models[0], modified: models[1] });
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
  listeners.push(editor.onDidUpdateDiff(updateDiffPresentation));
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
        if (index !== undefined) applyDifference(index);
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
        run: () => applyDifference(currentRevert.value),
      }),
  );
}
async function loadFile(
  next: string,
  guard = true,
  edge: "first" | "last" = "first",
  focusCaret = false,
) {
  if (!request.value || (guard && !(await canLeave()))) return;
  const id = ++requestId;
  pendingReveal = { id, edge, focusCaret };
  currentDifference.value = -1;
  diffCount.value = 0;
  currentRevert.value = 0;
  crossFileHint.value = "";
  file.value = next;
  const directory = next.split(/[\\/]/).slice(0, -1).join("\\");
  document.title = windowTitle.value = `${next.split(/[\\/]/).pop()} (${[projectPath.value || projectName.value, directory].filter(Boolean).join("\\")}) [Git 对比]`;
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
      if (files.value.some((f) => f.path === file.value)) {
        if (["stage", "unstage"].includes(p.operation) && request.value?.comparison.mode === "local" && editor) {
          const snapshot = await api<FileComparison>("git.content", { comparison: request.value.comparison, file: file.value });
          if (snapshot.oldText === data.value?.oldText && snapshot.newText === savedText) {
            data.value = snapshot;
            stale.value = false;
            updateDiffPresentation();
            return;
          }
        }
        await loadFile(file.value, false);
      } else {
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
async function includeFile(event: Event) {
  const input = event.target as HTMLInputElement, current = currentFile.value;
  if (!current) return;
  const operation = input.checked ? "stage" : "unstage";
  input.checked = current.staged && !current.unstaged;
  input.indeterminate = current.staged && current.unstaged;
  const paths = [current.path];
  if (current.oldPath && operation === "unstage") paths.push(current.oldPath);
  await write("git.execute", { operation, files: paths });
}
async function navigateDiff(direction: "next" | "previous") {
  if (loading.value || busy.value || navigating.value) return;
  const step = direction === "next" ? 1 : -1;
  if (isConflict.value) {
    const blocks = conflictBlocks(mergeEditors[1]?.getValue() || "");
    const next = block.value + step;
    if (next >= 0 && next < blocks.length) {
      block.value = next;
      revealDiffCaret(mergeEditors[1], { lineNumber: blocks[next].startLine, column: 1 });
      return;
    }
  } else {
    const changes = editor?.getLineChanges() || [],
      line = editor?.getModifiedEditor().getPosition()?.lineNumber || 1;
    const next =
      currentDifference.value >= 0
        ? currentDifference.value + step
        : direction === "next"
          ? changes.findIndex((change) => diffChangePosition(models[1], change).lineNumber > line)
          : changes.reduce(
              (last, change, index) =>
                (change.modifiedEndLineNumber || diffChangePosition(models[1], change).lineNumber) < line
                  ? index
                  : last,
              -1,
            );
    if (next >= 0 && next < changes.length) {
      revealDifference(next, true);
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
      true,
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
  const token = data.value?.token || conflict.value?.token;
  try {
    await api("git.validate-token", {
      token,
      conflict: isConflict.value,
    });
  } catch {
    if (token === (data.value?.token || conflict.value?.token)) stale.value = true;
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
    await Promise.all([document.fonts.load('13px "Workbench JetBrains Mono"'), document.fonts.load('italic 13px "Workbench JetBrains Mono"')]);
    const initial = await api<{
      request: DiffWindowRequest;
      projectName: string;
      projectPath: string;
    }>("git.window-context");
    projectName.value = initial.projectName;
    projectPath.value = initial.projectPath;
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
  mergeEditors.forEach((e) => e.dispose());
  delete window.__workbenchCanClose;
}
onBeforeUnmount(disposeViewer);
</script>
<template>
  <div class="diff-window" :class="{ 'diff-light': !settings.dark, 'diff-readonly': isConflict ? !conflict?.editable : !canEdit,
    'diff-unified': !settings.split, 'diff-line-highlights': settings.highlight === 'lines', 'diff-no-highlights': settings.highlight === 'none' }">
    <div class="diff-titlebar"><img src="../../../assets/workbench-v2-64.png" alt="" /><span :title="windowTitle">{{ windowTitle }}</span></div>
    <header class="diff-toolbar">
      <span class="diff-current-path">{{ file }}</span>
      <button
        data-action="previous-difference"
        title="上一处差异 / 上一个文件（Shift+F7）"
        :disabled="loading || busy || navigating"
        @click="navigateDiff('previous')"
      >
        <Icon name="arrow-up" :size="16" /></button
      ><button
        data-action="next-difference"
        title="下一处差异 / 下一个文件（F7）"
        :disabled="loading || busy || navigating"
        @click="navigateDiff('next')"
      >
        <Icon name="arrow-down" :size="16" /></button>
      <button v-if="canEdit" data-action="revert-current" :disabled="busy || loading || !diffCount || stale"
        title="Revert 当前差异（Ctrl+Alt+Z）" @click="applyDifference(currentRevert)"><Icon name="history" :size="15" /></button>
      <span class="diff-toolbar-divider" />
      <button data-action="undo" title="撤销（Ctrl+Z）" :disabled="!historyState.undo || stale" @click="undoRedo(false)"><Icon name="arrow-left" :size="16" /></button
      ><button data-action="redo" title="重做（Ctrl+Y）" :disabled="!historyState.redo || stale" @click="undoRedo(true)"><Icon name="arrow-right" :size="16" /></button
      ><button title="显示 / 隐藏文件列表" :aria-pressed="showFiles" @click="showFiles = !showFiles"><Icon name="list" :size="15" /></button>
      <select v-if="!isConflict" v-model="settings.split" aria-label="对比布局">
        <option :value="true">双栏对比</option><option :value="false">单栏对比</option>
      </select>
      <select :value="!settings.split && settings.whitespace === 'ignore' ? 'trim' : settings.whitespace" aria-label="空白处理"
        @change="settings.whitespace = ($event.target as HTMLSelectElement).value as Whitespace">
        <option value="all">显示空白差异</option><option value="trim">忽略首尾空白</option>
        <option v-if="settings.split" value="ignore">忽略空白和空行</option>
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
        aria-label="查找"
        @click="
          (isConflict ? mergeEditors[1] : editor?.getModifiedEditor())
            ?.getAction('actions.find')
            ?.run()
        "
      >
        <Icon name="search" :size="15" /></button
      ><button v-if="canEdit" title="保存（Ctrl+S）" :disabled="!dirty || busy || stale" @click="persistEditor"><Icon name="save" :size="15" /></button
      ><button title="Git 操作" :aria-pressed="showOperations" @click="showOperations = !showOperations"><Icon name="branch2" :size="15" /></button
      ><button title="刷新（F5）" :disabled="busy" @click="refresh"><Icon name="refresh" :size="14" /></button
      ><button
        aria-label="设置 ⚙" title="对比设置"
        :aria-expanded="settingsOpen"
        @click="settingsOpen = !settingsOpen"
      >
        <Icon name="settings" :size="15" />
      </button>
      <label v-if="localCommit && currentFile" class="diff-include" title="将此文件的修改纳入或移出 Git 暂存区">
        <input type="checkbox" :checked="currentFile.staged && !currentFile.unstaged" :indeterminate="currentFile.staged && currentFile.unstaged"
          :disabled="busy || dirty || stale || loading" @change="includeFile" />纳入提交
      </label>
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
        <div v-if="loading" class="diff-loading">正在读取文件…</div>
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
          <span :title="data.oldLabel"><Icon name="lock" :size="12" />{{ settings.split && data.oldRevision ? data.oldRevision : data.oldLabel }}<small v-if="!settings.split || data.oldText.includes('\r\n') !== data.newText.includes('\r\n')" class="diff-eol diff-eol-old">{{ data.oldText.includes('\r\n') ? 'CRLF' : 'LF' }}</small></span>
          <span :title="data.newLabel"><Icon :name="data.editable ? 'pencil' : 'lock'" :size="12" />{{ data.editable ? "你的版本" : data.newLabel }}{{ dirty ? " · 未保存" : "" }}<small v-if="!settings.split || data.oldText.includes('\r\n') !== data.newText.includes('\r\n')" class="diff-eol diff-eol-new">{{ data.newText.includes('\r\n') ? 'CRLF' : 'LF' }}</small></span>
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
          没有变更文件
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
    <section v-if="localCommit" class="diff-commit-message">
      <button type="button" class="diff-message-heading" :aria-expanded="messageExpanded" @click="messageExpanded = !messageExpanded">
        提交说明<span aria-hidden="true" /><Icon :name="messageExpanded ? 'down' : 'up'" :size="14" />
      </button>
      <textarea v-show="messageExpanded" v-model="commitDraft" aria-label="本地提交说明" maxlength="20000" spellcheck="false" />
    </section>
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
      ><span>F7 / Shift+F7 跨文件 · F11 全屏</span>
    </footer>
    <MessageDialog :dark="settings.dark" />
  </div>
</template>

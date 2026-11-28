<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowReactive, shallowRef, watch } from "vue";
import { monaco, language, diffCodeOptions, ideaFoldingOptions, ideaImportHiddenAreas } from "../monaco";
import { completeJavaStatement, expandJavaOutput, isJavaOutputAbbreviation, javaCallArguments, preserveJavaCallSuffix, type JavaEdit } from "../java-editing";
import { installParameterHints } from "../parameter-hints";
import type { EditorOpenTarget, GitBlameLine } from "../../shared/types";
import type { EditorTreeEntry, JavaFileKind } from "../../shared/editor-tree";
import { showJavaDiagnostic } from "../../shared/java-diagnostics";
import * as tsLanguage from "monaco-editor/languages/features/typescript/register.js";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import "monaco-editor/editor/contrib/documentSymbols/browser/outlineModel.js";
import { call } from "../state";
import { activeDialog } from "../dialog";
import Icon from "../components/Icon.vue";
import CloseButton from "../components/CloseButton.vue";
import FileTypeIcon from "../components/FileTypeIcon.vue";
import MessageDialog from "../components/MessageDialog.vue";
import EditorTreeNode, { type TreeNode } from "../components/EditorTreeNode.vue";

const baseWorker = (self as any).MonacoEnvironment.getWorker;
(self as any).MonacoEnvironment.getWorker = (id: string, label: string) =>
  label === "typescript" || label === "javascript" ? new TypeScriptWorker() : baseWorker(id, label);

interface Context {
  projectId: string;
  projectName: string;
  root: string;
  java: boolean;
  status: string;
  error: string;
  initialOpen?: EditorOpenTarget;
}
interface DiskFile {
  file: string;
  text: string;
  version: string;
  encoding: "utf8" | "utf16le" | "utf16be" | "gb18030";
  bom: boolean;
  eol: "\n" | "\r\n";
  javaKind?: JavaFileKind;
}
interface Tab {
  file: string;
  uri: string;
  model: monaco.editor.ITextModel;
  savedText: string;
  version: string;
  encoding: DiskFile["encoding"];
  bom: boolean;
  dirty: boolean;
  stale: boolean;
  readonly: boolean;
  javaKind?: JavaFileKind;
  view?: monaco.editor.ICodeEditorViewState | null;
  restore?: { lineNumber: number; column: number; scrollTop: number };
  changeTimer?: ReturnType<typeof setTimeout>;
  autoSaveTimer?: ReturnType<typeof setTimeout>;
  saving?: Promise<boolean>;
  reloadId?: number;
  dispose?: monaco.IDisposable;
  blame?: BlameState;
}
interface Position { file: string; line: number; column: number; uri?: string }
interface LspRange { start: { line: number; character: number }; end: { line: number; character: number } }
interface Target extends Position { uri: string; label: string; snippet?: string; range?: LspRange }
interface SearchHit { file: string; line: number; column: number; text: string }
interface ProjectOption { id: string; name: string; group?: string; type: string; path: string }
interface BlameState {
  snapshot?: { version: number; lines: ReadonlyMap<number, GitBlameLine> };
  loading: boolean;
  timer?: ReturnType<typeof setTimeout>;
}
interface BlameRow extends GitBlameLine { top: number; height: number; lineHeight: number; authorLabel: string; ageBand: number }

const context = ref<Context>();
const rootNodes = ref<TreeNode[]>([]);
const tabs = shallowRef<Tab[]>([]);
const activeFile = ref("");
const current = computed(() => tabs.value.find((tab) => tab.file === activeFile.value));
const editorHost = ref<HTMLElement>();
const treeHost = ref<HTMLElement>();
const paletteInput = ref<HTMLInputElement>();
const paletteList = ref<HTMLElement>();
const searchInput = ref<HTMLInputElement>();
const sidebarWidth = ref(260);
const status = ref("");
const languageStatus = ref("");
const languageError = ref("");
const dark = ref(false);
const tsStatus = ref("");
const caret = ref({ line: 1, column: 1 });
const paletteMode = ref<"" | "files" | "locations">("");
const paletteTitle = ref("");
const paletteQuery = ref("");
const fileResults = ref<string[]>([]);
const fileSearching = ref(false);
const locationResults = ref<Target[]>([]);
const selectedResult = ref(0);
const paletteScroll = ref(0);
const searchVisible = ref(false);
const searchQuery = ref("");
const searchResults = ref<SearchHit[]>([]);
const searching = ref(false);
const searchElapsed = ref(0);
let searchClock: ReturnType<typeof setInterval> | undefined;
let searchStartedAt = 0;
const searchTypes = ref<{ ext: string; count: number }[]>([]);
const searchTypesOpen = ref(false);
const searchTypeFilter = ref<string[]>([]);
const gotoOpen = ref(false);
const gotoValue = ref("");
const gotoInput = ref<HTMLInputElement>();
const projectPickerOpen = ref(false);
const projectOptions = ref<ProjectOption[]>([]);
const projectQuery = ref("");
const projectBusy = ref(false);
const projectActiveId = ref("");
const projectFilterInput = ref<HTMLInputElement>();
const projectListHost = ref<HTMLElement>();
const tabMenu = ref<{ x: number; y: number; file: string } | null>(null);
const blameMenu = ref<{ x: number; y: number } | null>(null);
const tabStrip = ref<HTMLElement>();
const tabsOverflow = ref(false);
const tabListOpen = ref(false);
const tabListFiles = ref<string[]>([]);
const tabListPos = ref({ top: 0, right: 12 });
const switcher = ref<{ open: boolean; files: string[]; index: number }>({ open: false, files: [], index: 0 });
const activeBlame = computed(() => tabs.value.find((tab) => tab.file === activeFile.value)?.blame);
const showBlame = computed(() => !!activeBlame.value?.snapshot?.lines.size);
const blameTick = ref(0);
const ctrlLink = ref(false);
const filteredProjects = computed(() => {
  const q = projectQuery.value.trim().toLowerCase();
  return q ? projectOptions.value.filter((item) =>
    item.name.toLowerCase().includes(q) ||
    item.path.toLowerCase().includes(q) ||
    (item.group || "").toLowerCase().includes(q)) : projectOptions.value;
});
const groupedProjects = computed(() => {
  const ordered = ["HomeProject", "推荐官"];
  const names: string[] = [];
  for (const name of ordered) {
    if (filteredProjects.value.some((p) => (p.group || "其他") === name)) names.push(name);
  }
  for (const p of filteredProjects.value) {
    const g = p.group || "其他";
    if (!names.includes(g)) names.push(g);
  }
  return names.map((name) => ({
    name,
    items: filteredProjects.value.filter((p) => (p.group || "其他") === name),
  }));
});
const orderedFilteredProjects = computed(() =>
  groupedProjects.value.flatMap((group) => group.items),
);
function projectIcon(project: ProjectOption) {
  if (project.type === "spring" || project.type === "tomcat")
    return { icon: "server", cls: "server" };
  return { icon: "web", cls: "web" };
}
watch(projectQuery, () => {
  const list = orderedFilteredProjects.value;
  if (!list.some((p) => p.id === projectActiveId.value)) {
    projectActiveId.value = list[0]?.id || "";
  }
});
const searchGroups = computed(() => {
  const groups = new Map<string, SearchHit[]>();
  for (const hit of searchResults.value) {
    if (!groups.has(hit.file)) groups.set(hit.file, []);
    groups.get(hit.file)!.push(hit);
  }
  return [...groups].map(([file, hits]) => ({ file, hits }));
});
const switcherEntries = computed(() => switcher.value.files.map((file) => ({
  file,
  name: displayName(file),
  javaKind: tabs.value.find((tab) => tab.file === file)?.javaKind,
  active: file === activeFile.value,
})));
const blameTimeRange = computed(() => {
  let oldest = Infinity;
  let newest = -Infinity;
  for (const line of activeBlame.value?.snapshot?.lines.values() || []) {
    if (line.uncommitted) continue;
    oldest = Math.min(oldest, line.authoredAt);
    newest = Math.max(newest, line.authoredAt);
  }
  return { oldest, span: Math.max(0, newest - oldest) };
});
const blameRows = computed<BlameRow[]>(() => {
  blameTick.value;
  const instance = editor;
  const model = instance?.getModel();
  const snapshot = activeBlame.value?.snapshot;
  if (!instance || !model || model !== current.value?.model || snapshot?.version !== model.getVersionId()) return [];
  const rows: BlameRow[] = [];
  const { oldest, span } = blameTimeRange.value;
  const scrollTop = instance.getScrollTop();
  const viewportHeight = instance.getLayoutInfo().height;
  for (const range of instance.getVisibleRanges()) {
    // Include partially visible rows at either edge of the viewport.
    const from = Math.max(1, range.startLineNumber - 1);
    const to = Math.min(model.getLineCount(), range.endLineNumber + 1);
    for (let line = from; line <= to; line++) {
      const info = snapshot.lines.get(line);
      if (!info) continue;
      const lineHeight = instance.getLineHeightForPosition({ lineNumber: line, column: 1 });
      if (lineHeight <= 0) continue;
      const documentTop = instance.getTopForLineNumber(line);
      const top = documentTop - scrollTop;
      const height = instance.getBottomForLineNumber(line) - documentTop;
      if (top >= viewportHeight || top + height <= 0) continue;
      rows.push({
        ...info, top, height, lineHeight,
        ageBand: span > 0 && !info.uncommitted ? Math.round(4 * (info.authoredAt - oldest) / span) : 0,
        authorLabel: info.author.replace(/^\p{Ll}/u, (initial) => initial.toUpperCase()),
      });
    }
  }
  return rows;
});

let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let disposed = false;
let unlistenLsp: (() => void) | undefined;
let unlistenDisk: (() => void) | undefined;
let fileSearchTimer: ReturnType<typeof setTimeout> | undefined;
let fileSearchPromise: Promise<void> | null = null;
let textSearchTimer: ReturnType<typeof setTimeout> | undefined;
let textSearchId = 0;
let revealTimer: ReturnType<typeof setTimeout> | undefined;
let revealDecorations: string[] = [];
let revealModel: monaco.editor.ITextModel | undefined;
let providers: monaco.IDisposable[] = [];
let history: Position[] = [];
let historyIndex = -1;
let cursorStopTimer: ReturnType<typeof setTimeout> | undefined;
let suppressCursorHistory = false;
let unlistenHistory: (() => void) | undefined;
let unlistenSearch: (() => void) | undefined;
let unlistenOpen: (() => void) | undefined;
let editorReady = false;
let queuedOpen: EditorOpenTarget | undefined;
let paletteToken = 0;
let tabOrder: string[] = [];
let tabResizeObserver: ResizeObserver | undefined;
let ctrlHeld = false;
let hoverPosition: monaco.Position | null = null;
let ctrlHoverModel: monaco.editor.ITextModel | undefined;
let ctrlHoverIds: string[] = [];

function clearCtrlHover() {
  if (ctrlHoverModel && !ctrlHoverModel.isDisposed()) ctrlHoverModel.deltaDecorations(ctrlHoverIds, []);
  ctrlHoverModel = undefined;
  ctrlHoverIds = [];
  if (ctrlLink.value) ctrlLink.value = false;
}
function updateCtrlHover() {
  if (!editor) return;
  const model = editor.getModel();
  const position = hoverPosition;
  if (!model || !position) { clearCtrlHover(); return; }
  const word = model.getWordAtPosition(position);
  if (!word) { clearCtrlHover(); return; }
  // 只给标识符加可跳转样式，避免关键字、字符串也被标成链接
  const row = monaco.editor.tokenize(model.getLineContent(position.lineNumber), model.getLanguageId())[0] || [];
  const offset = position.column - 1;
  let type = "";
  for (let i = 0; i < row.length; i++) {
    const from = row[i].offset;
    const to = i + 1 < row.length ? row[i + 1].offset : Number.MAX_SAFE_INTEGER;
    if (offset >= from && offset < to) { type = row[i].type; break; }
  }
  if (!/identifier/i.test(type) || /keyword/i.test(type)) { clearCtrlHover(); return; }
  if (ctrlHoverModel && ctrlHoverModel !== model) clearCtrlHover();
  ctrlHoverModel = model;
  ctrlHoverIds = model.deltaDecorations(ctrlHoverIds, [{
    range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
    options: { inlineClassName: "idea-ctrl-link" },
  }]);
  ctrlLink.value = true;
}

function rememberTab(file: string) {
  tabOrder = [file, ...tabOrder.filter((item) => item !== file)].slice(0, 40);
}
function switcherOrder() {
  const available = tabOrder.filter((file) => tabs.value.some((tab) => tab.file === file));
  return [activeFile.value, ...available.filter((file) => file !== activeFile.value)].filter(Boolean);
}
function openSwitcher(step = 1) {
  const files = switcherOrder();
  if (files.length < 2) { message("当前只打开了一个文件"); return; }
  switcher.value = { open: true, files, index: step < 0 ? files.length - 1 : 1 };
}
function stepSwitcher(step: number) {
  if (!switcher.value.open) { openSwitcher(step); return; }
  const state = switcher.value;
  state.index = (state.index + step + state.files.length) % state.files.length;
}
async function commitSwitcher() {
  const state = switcher.value;
  if (!state.open) return;
  switcher.value = { ...state, open: false };
  const target = state.files[state.index];
  if (target && target !== activeFile.value) await openFile(target);
}
function cancelSwitcher() {
  switcher.value = { ...switcher.value, open: false };
}
function openTabMenu(tab: Tab, event: MouseEvent) {
  event.preventDefault();
  tabListOpen.value = false;
  blameMenu.value = null;
  tabMenu.value = {
    x: Math.min(event.clientX, window.innerWidth - 190),
    y: Math.min(event.clientY, window.innerHeight - 220),
    file: tab.file,
  };
}
function openBlameMenuAt(x: number, y: number) {
  const tab = current.value;
  if (!tab || tab.readonly || tab.file.startsWith("jdt:")) return;
  tabMenu.value = null;
  tabListOpen.value = false;
  blameMenu.value = {
    x: Math.min(x, window.innerWidth - 200),
    y: Math.min(y, window.innerHeight - 110),
  };
}
function toggleBlameFromMenu() {
  const tab = current.value;
  blameMenu.value = null;
  if (!tab || tab.readonly) return;
  if (tab.blame) {
    closeBlame(tab);
    message("已关闭提交历史标注");
  } else {
    tab.blame = shallowReactive<BlameState>({ loading: false });
    void refreshBlame(tab, tab.blame);
  }
  refreshTabs();
}
function tabIndex(file: string) {
  return tabs.value.findIndex((tab) => tab.file === file);
}
function updateTabOverflow() {
  const strip = tabStrip.value;
  if (!strip) { tabsOverflow.value = false; return; }
  tabsOverflow.value = strip.scrollWidth > strip.clientWidth + 1;
  if (!tabsOverflow.value) tabListOpen.value = false;
}
function scrollActiveTabIntoView() {
  const strip = tabStrip.value;
  const element = strip?.querySelector<HTMLElement>(".editor-tab.active");
  if (!strip || !element) return;
  const left = element.offsetLeft, right = left + element.offsetWidth;
  if (left < strip.scrollLeft) strip.scrollLeft = left;
  else if (right > strip.scrollLeft + strip.clientWidth) strip.scrollLeft = right - strip.clientWidth;
}
function offscreenTabFiles() {
  const strip = tabStrip.value;
  if (!strip) return [];
  const stripRect = strip.getBoundingClientRect();
  const elements = Array.from(strip.querySelectorAll<HTMLElement>(".editor-tab"));
  return tabs.value.filter((tab, index) => {
    const element = elements[index];
    if (!element) return false;
    const rect = element.getBoundingClientRect();
    return rect.left < stripRect.left - 1 || rect.right > stripRect.right + 1;
  }).map((tab) => tab.file);
}
function toggleTabList(event: MouseEvent) {
  if (tabListOpen.value) { tabListOpen.value = false; return; }
  const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
  const hidden = offscreenTabFiles();
  tabListFiles.value = hidden.length ? hidden : tabs.value.map((tab) => tab.file);
  tabListPos.value = { top: rect.bottom + 2, right: Math.max(8, window.innerWidth - rect.right) };
  tabListOpen.value = true;
}
function pickTab(file: string) {
  tabListOpen.value = false;
  void openFile(file);
}
watch(() => tabs.value.length, () => { void nextTick(updateTabOverflow); }, { flush: "post" });
watch(activeFile, () => { void nextTick(scrollActiveTabIntoView); }, { flush: "post" });
async function closeTabGroup(kind: "current" | "others" | "left" | "right" | "all") {
  const menu = tabMenu.value;
  tabMenu.value = null;
  if (!menu) return;
  const index = tabs.value.findIndex((tab) => tab.file === menu.file);
  if (index < 0) return;
  const list = tabs.value;
  const files = kind === "current" ? [list[index].file]
    : kind === "others" ? list.filter((_, i) => i !== index).map((tab) => tab.file)
      : kind === "left" ? list.slice(0, index).map((tab) => tab.file)
        : kind === "right" ? list.slice(index + 1).map((tab) => tab.file)
          : list.map((tab) => tab.file);
  await closeTabs(files, index);
}
async function closeTabs(files: string[], fallbackIndex = 0) {
  const set = new Set(files);
  if (!set.size) return;
  for (const tab of tabs.value) {
    if (!set.has(tab.file)) continue;
    if (!(await flushAutoSave(tab))) return;
    if (tab.changeTimer) clearTimeout(tab.changeTimer);
    if (tab.autoSaveTimer) clearTimeout(tab.autoSaveTimer);
    if (!tab.readonly) {
      void call("editor.unwatch", { file: tab.file }).catch(() => {});
      if (tab.file.endsWith(".java") && context.value?.java)
        void call("editor.lsp-close", { file: tab.file }).catch(() => {});
    }
  }
  const activeClosed = set.has(activeFile.value);
  if (activeClosed) editor?.setModel(null);
  for (const tab of tabs.value) {
    if (!set.has(tab.file)) continue;
    closeBlame(tab);
    tab.dispose?.dispose();
    tab.model.dispose();
    tabOrder = tabOrder.filter((file) => file !== tab.file);
  }
  const remaining = tabs.value.filter((tab) => !set.has(tab.file));
  tabs.value = remaining;
  if (activeClosed) {
    activeFile.value = "";
    const next = remaining[Math.min(fallbackIndex, remaining.length - 1)];
    if (next) await openFile(next.file);
  } else refreshTabs();
  persistSession();
}
function closeBlame(tab: Tab) {
  if (tab.blame?.timer) clearTimeout(tab.blame.timer);
  tab.blame = undefined;
}
function queueBlame(tab: Tab) {
  const state = tab.blame;
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void refreshBlame(tab, state);
  }, 300);
}
async function refreshBlame(tab: Tab, state: BlameState) {
  const { model } = tab;
  if (tab.blame !== state || state.loading || model.isDisposed()) return;
  const version = model.getVersionId();
  state.loading = true;
  try {
    const lines = await call<GitBlameLine[]>("editor.blame", {
      file: tab.file, text: model.getValue(), encoding: tab.encoding, bom: tab.bom,
    });
    if (tab.blame !== state || model.isDisposed() || version !== model.getVersionId()) return;
    state.snapshot = { version, lines: new Map(lines.map((line) => [line.line, line])) };
    if (!lines.length && tab === current.value) message("当前文件没有可标注的行");
  } catch (error) {
    if (tab.blame === state && !model.isDisposed() && version === model.getVersionId()) {
      closeBlame(tab);
      refreshTabs();
      if (tab === current.value) message(error instanceof Error ? error.message : String(error));
    }
  } finally {
    state.loading = false;
    if (tab.blame === state && !state.timer && !model.isDisposed() && version !== model.getVersionId()) queueBlame(tab);
  }
}
function scrollBlame(event: WheelEvent) {
  if (!editor) return;
  const unit = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? editor.getOption(monaco.editor.EditorOption.lineHeight)
    : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? editor.getLayoutInfo().height : 1;
  editor.setScrollPosition({
    scrollTop: editor.getScrollTop() + event.deltaY * unit,
    scrollLeft: editor.getScrollLeft() + event.deltaX * unit,
  });
}
async function showBlameDiff(row: BlameRow) {
  const tab = current.value;
  if (!tab || !row.hash) { message("未提交的修改没有历史差异"); return; }
  try { await call("editor.blame-diff", { file: tab.file, hash: row.hash }); }
  catch (error) { message(error instanceof Error ? error.message : String(error)); }
}
function deleteCurrentLine() {
  const tab = current.value;
  if (!editor || !tab || tab.readonly) return;
  const model = tab.model;
  const selection = editor.getSelection();
  const start = selection ? selection.startLineNumber : (editor.getPosition()?.lineNumber || 1);
  const end = selection && !selection.isEmpty() ? selection.endLineNumber : start;
  let range: monaco.Range;
  if (end < model.getLineCount()) range = new monaco.Range(start, 1, end + 1, 1);
  else if (start > 1) range = new monaco.Range(start - 1, model.getLineMaxColumn(start - 1), end, model.getLineMaxColumn(end));
  else range = new monaco.Range(1, 1, 1, model.getLineMaxColumn(1));
  editor.executeEdits("delete-line", [{ range, text: "", forceMoveMarkers: true }]);
  editor.setPosition({ lineNumber: Math.min(start, Math.max(1, model.getLineCount())), column: 1 });
  editor.focus();
}
// 折叠提供器是异步计算的：首帧先隐藏 import 行，确认折叠模型真的收起后再交还控制权。
const initialFoldOwner = {};
function preFoldImports(tab: Tab) {
  if (!editor) return;
  const areas = ideaImportHiddenAreas(tab.model);
  if (!areas.length) return;
  const anyEditor = editor as unknown as { setHiddenAreas: (ranges: monaco.Range[], owner?: unknown) => void };
  anyEditor.setHiddenAreas(areas, initialFoldOwner);
  const start = areas[0].startLineNumber;
  let tries = 0;
  const release = () => {
    if (!editor || editor.getModel() !== tab.model || tab.model.isDisposed()) {
      anyEditor.setHiddenAreas([], initialFoldOwner);
      return;
    }
    const folding = editor.getContribution<any>("editor.contrib.folding");
    const pending = folding?.getFoldingModel?.();
    if (pending && typeof pending.then === "function") {
      pending.then((fold: any) => {
        if (!editor || editor.getModel() !== tab.model || tab.model.isDisposed()) {
          anyEditor.setHiddenAreas([], initialFoldOwner);
          return;
        }
        let collapsed = false;
        try {
          const regions = fold?.regions;
          if (regions) {
            for (let i = 0; i < regions.length; i++) {
              if (regions.getStartLineNumber(i) <= start && regions.getEndLineNumber(i) >= start) {
                collapsed = regions.isCollapsed(i);
                break;
              }
            }
          }
        } catch { /* 折叠模型结构变化时直接交还 */ }
        if (collapsed || tries >= 15) {
          anyEditor.setHiddenAreas([], initialFoldOwner);
          return;
        }
        tries++;
        setTimeout(release, 60);
      }, () => {
        tries++;
        setTimeout(release, 80);
      });
      return;
    }
    if (tries++ < 15) setTimeout(release, 60);
    else anyEditor.setHiddenAreas([], initialFoldOwner);
  };
  release();
}
function queueAutoSave(tab: Tab) {
  if (tab.autoSaveTimer) clearTimeout(tab.autoSaveTimer);
  tab.autoSaveTimer = setTimeout(() => {
    tab.autoSaveTimer = undefined;
    if (tab.dirty && !tab.readonly) void saveTab(tab, true);
  }, 900);
}
function flushAutoSave(tab: Tab): Promise<boolean> {
  if (tab.autoSaveTimer) { clearTimeout(tab.autoSaveTimer); tab.autoSaveTimer = undefined; }
  return tab.dirty && !tab.readonly ? saveTab(tab, true) : Promise.resolve(true);
}
async function saveAllTabs(): Promise<boolean> {
  let ok = true;
  for (const tab of [...tabs.value]) if (!(await flushAutoSave(tab))) ok = false;
  return ok;
}
async function toggleProjectPicker() {
  if (projectPickerOpen.value) { projectPickerOpen.value = false; return; }
  try {
    projectOptions.value = await call<ProjectOption[]>("editor.projects");
    projectQuery.value = "";
    projectActiveId.value = "";
    projectPickerOpen.value = true;
    await nextTick();
    projectFilterInput.value?.focus();
    const cur = projectListHost.value?.querySelector<HTMLElement>(".editor-project-row.current");
    cur?.scrollIntoView({ block: "nearest" });
  } catch (error) { message(String(error)); }
}
function onProjectPickerKeydown(event: KeyboardEvent) {
  const list = orderedFilteredProjects.value;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    if (!list.length) return;
    event.preventDefault();
    const idx = list.findIndex((p) => p.id === projectActiveId.value);
    const nextIdx = idx < 0
      ? (event.key === "ArrowDown" ? 0 : list.length - 1)
      : (idx + (event.key === "ArrowDown" ? 1 : list.length - 1)) % list.length;
    const next = list[nextIdx];
    projectActiveId.value = next.id;
    void nextTick(() => {
      projectListHost.value
        ?.querySelector<HTMLElement>(`[data-project-id="${CSS.escape(next.id)}"]`)
        ?.scrollIntoView({ block: "nearest" });
    });
  } else if (event.key === "Enter") {
    const el = event.target as HTMLElement | null;
    if (el?.closest("button")) return;
    const focusedId = el?.closest<HTMLElement>(".editor-project-row")?.dataset.projectId;
    const target = list.find((p) => p.id === (focusedId || projectActiveId.value)) || list[0];
    if (!target) return;
    event.preventDefault();
    void switchProject(target, event.ctrlKey || event.metaKey || event.shiftKey ? "new" : "window");
  }
}
async function switchProject(project: ProjectOption, mode: "window" | "new") {
  if (projectBusy.value) return;
  if (mode === "window" && project.id === context.value?.projectId) {
    projectPickerOpen.value = false;
    return;
  }
  projectBusy.value = true;
  try {
    if (!(await saveAllTabs())) { message("存在未保存的修改，已取消切换"); return; }
    await call("editor.switch-project", { projectId: project.id, mode });
    projectPickerOpen.value = false;
    if (mode === "new") { message(`已在新窗口打开 ${project.name}`); return; }
    persistSession();
    window.location.reload();
  } catch (error) { message(String(error)); }
  finally { projectBusy.value = false; }
}

let statusTimer: ReturnType<typeof setTimeout> | undefined;
function message(text: string) {
  status.value = text;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = text
    ? setTimeout(() => {
        if (status.value === text) status.value = "";
        statusTimer = undefined;
      }, 5000)
    : undefined;
}
function sessionKey() { return `editor-session-${context.value?.projectId || ""}`; }
function fullPath(file: string) { return `${context.value!.root.replace(/[\\/]$/, "")}\\${file.replaceAll("/", "\\")}`; }
function currentPosition(): Position | undefined {
  const position = editor?.getPosition(), tab = current.value;
  if (!position || !tab) return;
  return { file: tab.file, uri: tab.uri, line: position.lineNumber, column: position.column };
}
function samePosition(a: Position, b: Position) {
  return a.file === b.file && a.line === b.line && a.column === b.column;
}
function pushHistory(position: Position) {
  if (historyIndex >= 0 && samePosition(history[historyIndex], position)) return;
  history = history.slice(0, historyIndex + 1);
  history.push(position);
  historyIndex = history.length - 1;
  if (history.length > 200) { history.shift(); historyIndex--; }
}
function recordJump(destination: Position) {
  const source = currentPosition();
  if (source) pushHistory(source);
  pushHistory(destination);
  persistSession();
}
// 光标停留（跨文件）也记入历史，供鼠标侧键前进/后退使用
function scheduleCursorStop() {
  if (suppressCursorHistory) return;
  if (cursorStopTimer) clearTimeout(cursorStopTimer);
  cursorStopTimer = setTimeout(() => {
    cursorStopTimer = undefined;
    if (suppressCursorHistory) return;
    const position = currentPosition();
    if (!position) return;
    pushHistory(position);
    persistSession();
  }, 320);
}
function persistSession() {
  if (!context.value) return;
  const active = current.value;
  if (active && editor) active.view = editor.saveViewState();
  try {
    localStorage.setItem(sessionKey(), JSON.stringify({
      files: tabs.value.filter((tab) => !tab.readonly).map((tab) => ({
        file: tab.file,
        position: tab.view?.cursorState?.[0]?.position || null,
        scrollTop: tab.view?.viewState?.scrollTop || 0,
      })),
      active: activeFile.value,
      history,
      historyIndex,
      sidebarWidth: sidebarWidth.value,
    }));
  } catch { /* Storage may be unavailable. */ }
}
async function loadTree(directory = "") {
  return (await call<EditorTreeEntry[]>("editor.tree", { directory }))
    .map((entry) => ({ ...entry, expanded: false, loaded: false, children: [] as TreeNode[] }));
}
async function toggleNode(node: TreeNode) {
  if (!node.directory) return;
  if (!node.loaded) {
    try { node.children = await loadTree(node.file); node.loaded = true; }
    catch (error) { message(String(error)); return; }
  }
  node.expanded = !node.expanded;
}
async function locate(file: string) {
  if (!file || file.startsWith("jdt:")) return;
  const pieces = file.split("/");
  let nodes = rootNodes.value;
  for (let i = 0; i < pieces.length - 1; i++) {
    const prefix = pieces.slice(0, i + 1).join("/");
    const node = nodes.find((item) => item.file === prefix);
    if (!node || !node.directory) return;
    if (!node.loaded) {
      node.children = await loadTree(node.file);
      node.loaded = true;
    }
    node.expanded = true;
    nodes = node.children || [];
  }
  await nextTick();
  treeHost.value?.querySelectorAll<HTMLElement>(".editor-tree-row").forEach((element) => {
    if (element.dataset.file === file) element.scrollIntoView({ block: "nearest" });
  });
}
function displayName(file: string) {
  return file.startsWith("jdt:")
    ? decodeURIComponent(file.split("?")[0].split("/").pop() || "依赖源码")
    : file.split(/[\\/]/).pop() || file;
}
function refreshTabs() { tabs.value = [...tabs.value]; }

async function openFile(file: string, position?: { line: number; column: number }, remember = false) {
  if (!context.value || !editor) return;
  let tab = tabs.value.find((item) => item.file === file);
  const isNew = !tab;
  if (!tab) {
    try {
      const disk = await call<DiskFile>("editor.read", { file });
      const uri = monaco.Uri.file(fullPath(file));
      const model = markRaw(monaco.editor.createModel(disk.text, language(file), uri));
      if (disk.eol === "\r\n") model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
      tab = {
        file, uri: uri.toString(), model, savedText: model.getValue(), version: disk.version,
        encoding: disk.encoding, bom: disk.bom, javaKind: disk.javaKind, dirty: false, stale: false, readonly: false,
      };
      const opened = tab;
      tab.dispose = model.onDidChangeContent(() => {
        opened.dirty = model.getValue() !== opened.savedText;
        refreshTabs();
        queueBlame(opened);
        if (file.endsWith(".java") && context.value?.java) queueSync(opened);
        queueAutoSave(opened);
      });
      tabs.value = [...tabs.value, tab];
      void call("editor.watch", { file }).catch(() => {});
      if (file.endsWith(".java") && context.value.java)
        void call("editor.lsp-open", { file, text: model.getValue() }).catch((error) => message(String(error)));
    } catch (error) { message(error instanceof Error ? error.message : String(error)); return; }
  }
  if (remember && position) recordJump({ file, ...position, uri: tab.uri });
  if (current.value && current.value !== tab) {
    current.value.view = editor.saveViewState();
    void flushAutoSave(current.value);
  }
  activeFile.value = file;
  rememberTab(file);
  editor.setModel(tab.model);
  editor.updateOptions({ readOnly: tab.readonly });
  clearCtrlHover();
  if (isNew) {
    const areas = position ? ideaImportHiddenAreas(tab.model) : [];
    const insideImports = !!position && areas.some((range) => position.line >= range.startLineNumber && position.line <= range.endLineNumber);
    if (!insideImports) preFoldImports(tab);
  }
  if (tab.restore && !position) {
    editor.setPosition({ lineNumber: tab.restore.lineNumber, column: tab.restore.column });
    editor.setScrollTop(tab.restore.scrollTop);
    tab.restore = undefined;
  } else if (tab.view && !position) editor.restoreViewState(tab.view);
  if (position) reveal(tab, position.line, position.column);
  editor.focus();
  void locate(file).catch(() => {});
  persistSession();
}

async function openVirtual(uri: string, position: { line: number; column: number }, remember: boolean) {
  if (!editor) return;
  let tab = tabs.value.find((item) => item.uri === uri);
  if (!tab) {
    try {
      const text = await call<string>("editor.lsp-classfile", { uri });
      const file = `jdt:${uri}`;
      tab = { file, uri, model: markRaw(monaco.editor.createModel(text || "", "java", monaco.Uri.parse(uri))),
        savedText: text || "", version: "", encoding: "utf8", bom: false,
        dirty: false, stale: false, readonly: true };
      tabs.value = [...tabs.value, tab];
    } catch (error) { message(String(error)); return; }
  }
  if (remember) recordJump({ file: tab.file, ...position, uri });
  if (current.value && current.value !== tab) {
    current.value.view = editor.saveViewState();
    void flushAutoSave(current.value);
  }
  activeFile.value = tab.file;
  rememberTab(tab.file);
  editor.setModel(tab.model);
  editor.updateOptions({ readOnly: true });
  reveal(tab, position.line, position.column);
  editor.focus();
}

function reveal(tab: Tab, line: number, column = 1) {
  if (!editor) return;
  const safeLine = Math.max(1, Math.min(line, tab.model.getLineCount()));
  const safeColumn = Math.max(1, Math.min(column, tab.model.getLineMaxColumn(safeLine)));
  editor.setPosition({ lineNumber: safeLine, column: safeColumn });
  editor.revealLineInCenter(safeLine);
  if (revealTimer) clearTimeout(revealTimer);
  if (revealModel && !revealModel.isDisposed()) revealModel.deltaDecorations(revealDecorations, []);
  revealModel = tab.model;
  revealDecorations = tab.model.deltaDecorations([], [{
    range: new monaco.Range(safeLine, safeColumn, safeLine, Math.min(safeColumn + 1, tab.model.getLineMaxColumn(safeLine))),
    options: { isWholeLine: true, className: "editor-jump-highlight", overviewRuler: {
      color: "#7aaef1", position: monaco.editor.OverviewRulerLane.Full,
    } },
  }]);
  revealTimer = setTimeout(() => {
    if (!tab.model.isDisposed()) tab.model.deltaDecorations(revealDecorations, []);
    revealDecorations = [];
  }, 2400);
}

function queueSync(tab: Tab) {
  if (tab.changeTimer) clearTimeout(tab.changeTimer);
  tab.changeTimer = setTimeout(() => { void flushSync(tab); }, 180);
}
async function flushSync(tab: Tab) {
  if (!context.value?.java || tab.readonly || !tab.file.endsWith(".java")) return;
  if (tab.changeTimer) clearTimeout(tab.changeTimer);
  tab.changeTimer = undefined;
  await call("editor.lsp-change", { file: tab.file, text: tab.model.getValue() });
}

async function saveTab(tab: Tab, quiet = false): Promise<boolean> {
  if (tab.saving) {
    if (!(await tab.saving)) return false;
    return tab.dirty ? saveTab(tab, quiet) : true;
  }
  if (tab.autoSaveTimer) { clearTimeout(tab.autoSaveTimer); tab.autoSaveTimer = undefined; }
  const pending = persistTab(tab, quiet);
  tab.saving = pending;
  try { return await pending; }
  finally { tab.saving = undefined; }
}
async function persistTab(tab: Tab, quiet = false): Promise<boolean> {
  if (tab.readonly || !tab.dirty) return true;
  const text = tab.model.getValue();
  try {
    let result = await call<{ conflict: boolean; version: string }>("editor.save", {
      file: tab.file, text, version: tab.version,
      encoding: tab.encoding, bom: tab.bom,
    });
    if (result.conflict) {
      tab.stale = true;
      refreshTabs();
      const choice = await call<"cancel" | "reload" | "overwrite">("editor.confirm-conflict", { file: tab.file });
      if (choice === "reload") { await reloadTab(tab, true); return true; }
      if (choice !== "overwrite") return false;
      result = await call("editor.save", {
        file: tab.file, text, version: tab.version,
        encoding: tab.encoding, bom: tab.bom, force: true,
      });
    }
    tab.version = result.version;
    tab.savedText = text;
    tab.dirty = tab.model.getValue() !== text;
    tab.stale = false;
    refreshTabs();
    if (!quiet) message(`已保存 ${tab.file}`);
    persistSession();
    return true;
  } catch (error) { message(error instanceof Error ? error.message : String(error)); return false; }
}
async function canClose() {
  if (!(await saveAllTabs())) return false;
  persistSession();
  return true;
}
async function reloadTab(tab: Tab, discard = false) {
  if (tab.readonly) return;
  const version = tab.model.getVersionId();
  const request = tab.reloadId = (tab.reloadId || 0) + 1;
  const disk = await call<DiskFile>("editor.read", { file: tab.file });
  if (tab.model.isDisposed() || request !== tab.reloadId) return;
  if (!discard && tab.model.getVersionId() !== version) {
    tab.stale = true;
    refreshTabs();
    return;
  }
  tab.model.setValue(disk.text);
  if (disk.eol === "\r\n") tab.model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
  tab.savedText = tab.model.getValue();
  tab.version = disk.version;
  tab.encoding = disk.encoding;
  tab.bom = disk.bom;
  tab.javaKind = disk.javaKind;
  tab.dirty = false;
  tab.stale = false;
  refreshTabs();
  if (tab.file.endsWith(".java") && context.value?.java) await flushSync(tab);
}
async function closeTab(tab: Tab) {
  if (!(await flushAutoSave(tab))) return;
  if (tab.changeTimer) clearTimeout(tab.changeTimer);
  if (tab.autoSaveTimer) clearTimeout(tab.autoSaveTimer);
  if (!tab.readonly) {
    void call("editor.unwatch", { file: tab.file }).catch(() => {});
    if (tab.file.endsWith(".java") && context.value?.java)
      void call("editor.lsp-close", { file: tab.file }).catch(() => {});
  }
  const index = tabs.value.indexOf(tab);
  closeBlame(tab);
  tabs.value = tabs.value.filter((item) => item !== tab);
  tabOrder = tabOrder.filter((item) => item !== tab.file);
  if (activeFile.value === tab.file) {
    const replacement = tabs.value[Math.min(index, tabs.value.length - 1)];
    activeFile.value = "";
    if (replacement) await openFile(replacement.file);
    else editor?.setModel(null);
  }
  tab.dispose?.dispose();
  tab.model.dispose();
  persistSession();
}

function uriToFile(uri: string): string | undefined {
  if (!context.value || !uri.startsWith("file:")) return;
  try {
    const url = new URL(uri);
    const disk = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1").replaceAll("/", "\\");
    const root = context.value.root.replaceAll("/", "\\").replace(/[\\/]$/, "");
    if (!disk.toLowerCase().startsWith(`${root.toLowerCase()}\\`)) return;
    return disk.slice(root.length + 1).replaceAll("\\", "/");
  } catch { return; }
}
function isTypeScriptFile(file: string) { return /\.(?:ts|tsx|js|jsx|mjs|cjs)$/i.test(file); }
function isMarkupFile(file: string) { return /\.(?:vue|html|htm)$/i.test(file); }
function escapeRegExp(value: string) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function scriptBlockRanges(lines: string[]): [number, number][] {
  const ranges: [number, number][] = [];
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    if (!start && /<script\b/i.test(lines[i]) && !/\bsrc\s*=/.test(lines[i])) start = i + 1;
    else if (start && /<\/script\s*>/i.test(lines[i])) { ranges.push([start, i + 1]); start = 0; }
  }
  if (start) ranges.push([start, lines.length]);
  return ranges;
}
// 光标落在 @click / onclick 属性名上时，取属性值里的处理函数名
function templateHandler(line: string, column: number, fallback: string) {
  const pattern = /(?:@|v-on:|:)?[\w.:-]+\s*=\s*(["'])([^"']*)\1/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line))) {
    const equals = line.indexOf("=", match.index);
    const at = column - 1;
    if (equals >= 0 && at >= match.index && at <= equals) {
      const handler = /^\s*([A-Za-z_$][\w$]*)/.exec(match[2]);
      if (handler) return handler[1];
    }
  }
  return fallback;
}
function definitionScore(line: string, name: string) {
  const trimmed = line.trim();
  if (!trimmed || /^\s*(?:\/\/|\*|<!--|#)/.test(trimmed)) return 0;
  const id = escapeRegExp(name);
  if (!new RegExp(`(^|[^\\w$])${id}(?=[^\\w$]|$)`).test(trimmed)) return 0;
  const pre = "(?:^|[^\\w$])";
  const patterns: [RegExp, number][] = [
    [new RegExp(`${pre}function\\s+${id}\\s*\\(`), 100],
    [new RegExp(`${pre}(?:export\\s+)?(?:const|let|var)\\s+${id}\\s*=`), 95],
    [new RegExp(`${pre}${id}\\s*:\\s*(?:async\\s*)?(?:function|\\(|[\\w$]+\\s*=>)`), 90],
    [new RegExp(`${pre}(?:async\\s+)?${id}\\s*\\([^)]*\\)\\s*\\{`), 85],
    [new RegExp(`${pre}${id}\\s*=\\s*(?:async\\s*)?(?:function|\\(|[\\w$]+\\s*=>)`), 80],
    [new RegExp(`${pre}export\\s+(?:default\\s+)?(?:async\\s+)?function\\s+${id}\\b`), 88],
  ];
  for (const [pattern, score] of patterns) if (pattern.test(trimmed)) return score;
  return 0;
}
async function scriptTargets(tab: Tab, name: string): Promise<(Target & { score: number })[]> {
  const found: (Target & { score: number })[] = [];
  const seen = new Set<string>();
  const add = (file: string, line: number, column: number, text: string, score: number) => {
    const key = `${file}:${line}:${column}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ file, uri: monaco.Uri.file(fullPath(file)).toString(), line, column,
      label: file, snippet: text.trim().slice(0, 180), score });
  };
  const lines = tab.model.getValue().split(/\r?\n/);
  const ranges = scriptBlockRanges(lines);
  for (let i = 0; i < lines.length; i++) {
    if (isMarkupFile(tab.file) && !ranges.some(([from, to]) => i + 1 >= from && i + 1 <= to)) continue;
    const score = definitionScore(lines[i], name);
    if (!score) continue;
    add(tab.file, i + 1, Math.max(1, lines[i].indexOf(name) + 1), lines[i], score + 20);
  }
  const htmlSource = /\.(?:html|htm)$/i.test(tab.file);
  try {
    const hits = await call<SearchHit[]>("editor.text-search", { query: name });
    for (const hit of hits) {
      if (!/\.(?:js|jsx|mjs|cjs|ts|tsx|vue|html|htm)$/i.test(hit.file)) continue;
      if (/<[a-z][\w-]*\b/i.test(hit.text)) continue;
      const score = definitionScore(hit.text, name);
      if (!score) continue;
      const rank = score + (htmlSource ? (/\.(?:js|mjs|cjs|ts|tsx)$/i.test(hit.file) ? 15 : -10) : 0);
      add(hit.file, hit.line, hit.column, hit.text, rank);
    }
  } catch (error) { message(String(error)); }
  return found.sort((a, b) => b.score - a.score).slice(0, 100);
}
async function scriptNavigate(kind: "definition" | "implementation" | "references" | "super", tab: Tab, line: number, column: number) {
  if (kind === "implementation" || kind === "super") {
    message("当前语言服务暂不提供此语义关系");
    return;
  }
  const at = tab.model.getWordAtPosition(new monaco.Position(line, column));
  const source = tab.model.getLineContent(line);
  const name = templateHandler(source, column, at?.word || "");
  if (!/^[A-Za-z_$][\w$]*$/.test(name)) { message("未找到可跳转的函数名"); return; }
  if (kind === "references") {
    try {
      const hits = await call<SearchHit[]>("editor.text-search", { query: name });
      const targets: Target[] = hits
        .filter((hit) => /\.(?:js|jsx|mjs|cjs|ts|tsx|vue|html|htm)$/i.test(hit.file))
        .map((hit) => ({ file: hit.file, uri: monaco.Uri.file(fullPath(hit.file)).toString(),
          line: hit.line, column: hit.column, label: hit.file, snippet: hit.text }));
      await showTargets("引用与调用", targets);
    } catch (error) { message(String(error)); }
    return;
  }
  const candidates = await scriptTargets(tab, name);
  if (candidates.length > 1 && candidates[0].score - candidates[1].score >= 15) {
    await jump(candidates[0]);
    return;
  }
  await showTargets("声明或定义", candidates);
}
async function indexTypeScript() {
  if (!context.value || context.value.java) return;
  tsStatus.value = "TS/JS 索引中";
  try {
    const sourceFiles = await call<string[]>("editor.code-files");
    const libs: { content: string; filePath: string }[] = [];
    let totalBytes = 0;
    for (let offset = 0; offset < sourceFiles.length && totalBytes < 16 * 1024 * 1024; offset += 16) {
      const batch = await Promise.all(sourceFiles.slice(offset, offset + 16).map(async (file) => {
        try {
          const source = await call<DiskFile>("editor.read", { file });
          return { content: source.text, filePath: monaco.Uri.file(fullPath(file)).toString() };
        } catch { return null; }
      }));
      for (const item of batch) if (item) { libs.push(item); totalBytes += item.content.length * 2; }
    }
    if (disposed) return;
    const options = {
      allowJs: true,
      checkJs: false,
      target: tsLanguage.ScriptTarget.ESNext,
      module: tsLanguage.ModuleKind.ESNext,
      moduleResolution: tsLanguage.ModuleResolutionKind.NodeJs,
      jsx: tsLanguage.JsxEmit.Preserve,
      allowNonTsExtensions: true,
    };
    tsLanguage.typescriptDefaults.setCompilerOptions(options);
    tsLanguage.javascriptDefaults.setCompilerOptions(options);
    tsLanguage.typescriptDefaults.setEagerModelSync(true);
    tsLanguage.javascriptDefaults.setEagerModelSync(true);
    tsLanguage.typescriptDefaults.setExtraLibs(libs);
    tsLanguage.javascriptDefaults.setExtraLibs(libs);
    tsStatus.value = `TS/JS 已索引 ${libs.length} 个文件`;
  } catch (error) {
    tsStatus.value = "TS/JS 索引失败";
    message(String(error));
  }
}
async function typeScriptTargets(tab: Tab, line: number, column: number, kind: "definition" | "references") {
  const factory = await (language(tab.file) === "typescript"
    ? tsLanguage.getTypeScriptWorker()
    : tsLanguage.getJavaScriptWorker());
  const service = await factory(tab.model.uri);
  const offset = tab.model.getOffsetAt({ lineNumber: line, column });
  const raw = kind === "definition"
    ? await service.getDefinitionAtPosition(tab.uri, offset)
    : await service.getReferencesAtPosition(tab.uri, offset);
  const found: Target[] = [];
  for (const item of raw || []) {
    if (kind === "references" && item.isDefinition) continue;
    const uri = String(item.fileName || "");
    const file = uriToFile(uri);
    if (!file) continue;
    const open = tabs.value.find((value) => value.file === file);
    const source = open?.model.getValue() || (await call<DiskFile>("editor.read", { file })).text;
    const start = Number(item.textSpan?.start);
    const length = Number(item.textSpan?.length);
    if (!Number.isInteger(start) || start < 0) continue;
    const prefix = source.slice(0, start);
    const targetLine = prefix.split("\n").length;
    const targetColumn = start - prefix.lastIndexOf("\n");
    found.push({ file, uri, line: targetLine, column: targetColumn, label: file,
      range: { start: { line: targetLine - 1, character: targetColumn - 1 },
        end: { line: targetLine - 1, character: targetColumn - 1 + length } },
    });
  }
  return found;
}
async function typeScriptNavigate(kind: "definition" | "implementation" | "references" | "super", tab: Tab, line: number, column: number): Promise<boolean> {
  if (kind === "implementation" || kind === "super") {
    message("当前语言服务暂不提供此语义关系");
    return true;
  }
  try {
    const matches = await typeScriptTargets(tab, line, column, kind);
    if (kind === "definition" && (!matches.length || matches.some((item) => onDeclaration(item, tab.file, line, column)))) {
      const references = await typeScriptTargets(tab, line, column, "references");
      if (references.length || !matches.length) {
        if (!references.length) return false;
        await showTargets("引用与调用", references);
        return true;
      }
    }
    if (!matches.length) return false;
    await showTargets(kind === "definition" ? "声明或定义" : "引用与调用", matches);
    return true;
  } catch { return false; }
}
function targets(value: any): Target[] {
  const raw = Array.isArray(value) ? value : value ? [value] : [];
  const seen = new Set<string>();
  return raw.flatMap((entry: any) => {
    const uri: string = entry.targetUri || entry.uri;
    const range: LspRange = entry.targetSelectionRange || entry.range || entry.targetRange;
    if (!uri || !range) return [];
    const file = uriToFile(uri) || (uri.startsWith("jdt:") ? `jdt:${uri}` : "");
    if (!file) return [];
    const line = range.start.line + 1, column = range.start.character + 1;
    const key = `${uri}:${line}:${column}`;
    if (seen.has(key)) return [];
    seen.add(key);
    return [{ file, uri, line, column, range,
      label: file.startsWith("jdt:") ? decodeURIComponent(uri.split("?")[0].split("/").pop() || "依赖源码") : file }];
  });
}
async function jump(target: Target, remember = true) {
  closePalette();
  if (target.uri.startsWith("jdt:")) await openVirtual(target.uri, target, remember);
  else await openFile(target.file, target, remember);
}
async function showTargets(title: string, candidates: Target[]) {
  if (!candidates.length) { message(`未找到${title}`); return; }
  if (candidates.length === 1) { await jump(candidates[0]); return; }
  locationResults.value = candidates;
  const token = ++paletteToken;
  paletteTitle.value = `${title} · ${candidates.length} 处`;
  paletteMode.value = "locations";
  paletteQuery.value = "";
  selectedResult.value = 0;
  paletteScroll.value = 0;
  await nextTick();
  if (paletteList.value) paletteList.value.scrollTop = 0;
  paletteInput.value?.focus();
  void (async () => {
    for (let offset = 0; offset < candidates.length; offset += 200) {
      if (paletteMode.value !== "locations" || token !== paletteToken) return;
      const chunk = candidates.slice(offset, offset + 200);
      const local = chunk.filter((item) => !item.file.startsWith("jdt:"));
      const snippets = await call<string[]>("editor.previews", { locations: local.map((item) => ({ file: item.file, line: item.line })) });
      if (token !== paletteToken) return;
      let localIndex = 0;
      const enriched = chunk.map((item) => {
        const diskSnippet = item.file.startsWith("jdt:") ? "" : snippets[localIndex++] || "";
        const open = tabs.value.find((tab) => tab.file === item.file);
        return { ...item, snippet: open?.model.getLineContent(item.line)?.trim().slice(0, 200) || diskSnippet };
      });
      locationResults.value = [
        ...locationResults.value.slice(0, offset), ...enriched,
        ...locationResults.value.slice(offset + chunk.length),
      ];
    }
  })().catch((error) => message(String(error)));
}
function onDeclaration(target: Target, file: string, line: number, column: number) {
  if (target.file !== file || target.line !== line || !target.range) return false;
  return target.range.start.character + 1 <= column && target.range.end.character + 1 >= column;
}
async function semantic(kind: string, file: string, line: number, column: number, item?: any) {
  const tab = tabs.value.find((value) => value.file === file);
  if (!tab || !context.value?.java || !file.endsWith(".java")) {
    message("此文件没有可用的项目级语义导航");
    return null;
  }
  try {
    await flushSync(tab);
    return await call<any>("editor.lsp-request", { kind, file, line, column, item });
  } catch (error) {
    message(error instanceof Error ? error.message : String(error));
    return null;
  }
}
async function navigateSymbol(kind: "definition" | "implementation" | "references" | "super", position?: monaco.Position) {
  const tab = current.value, at = position || editor?.getPosition();
  if (!tab || !at) return;
  const file = tab.file, line = at.lineNumber, column = at.column;
  if (isTypeScriptFile(file)) {
    if (!(await typeScriptNavigate(kind, tab, line, column))) await scriptNavigate(kind, tab, line, column);
    return;
  }
  if (isMarkupFile(file)) {
    await scriptNavigate(kind, tab, line, column);
    return;
  }
  if (kind === "super") {
    const overridden = targets(await semantic("super", file, line, column));
    if (overridden.length) { await showTargets("父方法", overridden); return; }
    const hierarchy = await semantic("hierarchy", file, line, column);
    const item = Array.isArray(hierarchy) ? hierarchy[0] : undefined;
    if (item) {
      const parents = await semantic("supertypes", file, line, column, item);
      const parentTargets = (Array.isArray(parents) ? parents : []).map((value: any) => ({
        uri: value.uri, range: value.selectionRange || value.range,
      }));
      await showTargets("父类型", targets(parentTargets));
    } else message("未找到父类型或被重写的方法");
    return;
  }
  let matches = targets(await semantic(kind, file, line, column));
  if (kind === "definition" && (!matches.length || matches.some((item) => onDeclaration(item, file, line, column)))) {
    const references = targets(await semantic("references", file, line, column));
    if (references.length || !matches.length) {
      await showTargets("引用与调用", references);
      return;
    }
  }
  await showTargets(kind === "definition" ? "声明或定义" : kind === "implementation" ? "具体实现" : "引用与调用", matches);
}
function goHistory(direction: -1 | 1) {
  // 把尚未落盘的当前光标位置补进历史，保证前进能回到原处
  if (cursorStopTimer) {
    clearTimeout(cursorStopTimer);
    cursorStopTimer = undefined;
    const pending = currentPosition();
    if (pending) pushHistory(pending);
  }
  const next = historyIndex + direction;
  if (next < 0 || next >= history.length) return;
  historyIndex = next;
  const target = history[next];
  suppressCursorHistory = true;
  if (cursorStopTimer) { clearTimeout(cursorStopTimer); cursorStopTimer = undefined; }
  const finish = () => { setTimeout(() => { suppressCursorHistory = false; }, 150); };
  if (target.uri?.startsWith("jdt:")) void openVirtual(target.uri, target, false).finally(finish);
  else void openFile(target.file, target, false).finally(finish);
  persistSession();
}
let lastHistoryNav = 0;
function navigateHistory(direction: -1 | 1) {
  const now = Date.now();
  if (now - lastHistoryNav < 60) return;
  lastHistoryNav = now;
  goHistory(direction);
}
function handleMouseButtons(event: MouseEvent) {
  if (event.button === 3) navigateHistory(-1);
  else if (event.button === 4) navigateHistory(1);
}

function closePalette() {
  if (fileSearchTimer) { clearTimeout(fileSearchTimer); fileSearchTimer = undefined; }
  fileSearchPromise = null;
  fileSearching.value = false;
  paletteToken++;
  paletteMode.value = "";
  paletteQuery.value = "";
}
watch(selectedResult, async () => {
  await nextTick();
  const list = paletteList.value, row = paletteMode.value === "locations" ? 42 : 30;
  if (!list) return;
  if (selectedResult.value * row < list.scrollTop) list.scrollTop = selectedResult.value * row;
  else if ((selectedResult.value + 1) * row > list.scrollTop + list.clientHeight)
    list.scrollTop = (selectedResult.value + 1) * row - list.clientHeight;
});
function recentLocalFiles() {
  return switcherOrder().filter((file) => !file.startsWith("jdt:"));
}
async function showFiles() {
  if (fileSearchTimer) { clearTimeout(fileSearchTimer); fileSearchTimer = undefined; }
  fileSearchPromise = null;
  fileSearching.value = false;
  paletteToken++;
  paletteMode.value = "files";
  paletteTitle.value = "打开项目文件";
  paletteQuery.value = "";
  fileResults.value = recentLocalFiles();
  selectedResult.value = 0;
  paletteScroll.value = 0;
  await nextTick();
  if (paletteList.value) paletteList.value.scrollTop = 0;
  paletteInput.value?.focus();
}
function runFileSearch(query: string, token: number) {
  fileSearching.value = true;
  const task: Promise<void> = (async () => {
    try {
      const results = await call<string[]>("editor.file-search", { query });
      if (paletteMode.value !== "files" || token !== paletteToken) return;
      fileResults.value = results;
      selectedResult.value = 0;
    } catch (error) {
      if (token === paletteToken) message(String(error));
    } finally {
      if (token === paletteToken) {
        fileSearchPromise = null;
        fileSearching.value = false;
      }
    }
  })();
  fileSearchPromise = task;
  return task;
}
function updateFileSearch() {
  if (fileSearchTimer) { clearTimeout(fileSearchTimer); fileSearchTimer = undefined; }
  const token = ++paletteToken;
  const query = paletteQuery.value.trim();
  if (!query) {
    fileSearchPromise = null;
    fileSearching.value = false;
    fileResults.value = recentLocalFiles();
    selectedResult.value = 0;
    return;
  }
  const lower = query.toLowerCase();
  fileResults.value = fileResults.value.filter((file) => file.toLowerCase().includes(lower));
  selectedResult.value = 0;
  fileSearching.value = true;
  fileSearchTimer = setTimeout(() => {
    fileSearchTimer = undefined;
    if (paletteMode.value !== "files" || token !== paletteToken) return;
    void runFileSearch(query, token);
  }, 90);
}
const visibleLocations = computed(() => {
  const query = paletteQuery.value.toLowerCase();
  return locationResults.value.filter((item) => !query || `${item.label} ${item.snippet || ""}`.toLowerCase().includes(query));
});
const paletteRowHeight = computed(() => paletteMode.value === "locations" ? 42 : 30);
const paletteStart = computed(() => Math.max(0, Math.floor(paletteScroll.value / paletteRowHeight.value) - 6));
const paletteFiles = computed(() => fileResults.value.slice(paletteStart.value, paletteStart.value + 42));
const paletteLocations = computed(() => visibleLocations.value.slice(paletteStart.value, paletteStart.value + 42));
const paletteCount = computed(() => paletteMode.value === "files" ? fileResults.value.length : visibleLocations.value.length);
async function acceptPalette(index?: number) {
  if (paletteMode.value === "files") {
    const query = paletteQuery.value.trim();
    if (index === undefined && query) {
      if (fileSearchTimer) {
        clearTimeout(fileSearchTimer);
        fileSearchTimer = undefined;
        await runFileSearch(query, paletteToken);
      } else if (fileSearchPromise) {
        await fileSearchPromise;
      }
    }
    const targetIndex = index ?? selectedResult.value;
    const file = fileResults.value[targetIndex];
    if (file) { closePalette(); await openFile(file); }
  } else if (paletteMode.value === "locations") {
    const target = visibleLocations.value[index ?? selectedResult.value];
    if (target) await jump(target);
  }
}
function paletteKey(event: KeyboardEvent) {
  const length = paletteMode.value === "files" ? fileResults.value.length : visibleLocations.value.length;
  if (event.key === "ArrowDown") { selectedResult.value = Math.max(0, Math.min(length - 1, selectedResult.value + 1)); event.preventDefault(); }
  else if (event.key === "ArrowUp") { selectedResult.value = Math.max(0, selectedResult.value - 1); event.preventDefault(); }
  else if (event.key === "Enter") { void acceptPalette(); event.preventDefault(); }
  else if (event.key === "Escape") { closePalette(); editor?.focus(); event.preventDefault(); }
}
async function showSearch() {
  searchVisible.value = true;
  const selection = editor?.getSelection();
  const tab = current.value;
  if (selection && !selection.isEmpty() && tab) {
    const text = tab.model.getValueInRange(selection).trim().split(/\r?\n/)[0].slice(0, 200);
    if (text) searchQuery.value = text;
  }
  await nextTick();
  updateTextSearch(true);
  searchInput.value?.focus();
  searchInput.value?.select();
}
async function loadSearchTypes() {
  try {
    searchTypes.value = await call<{ ext: string; count: number }[]>("editor.file-types");
  } catch (error) { message(String(error)); }
}
function toggleSearchTypes() {
  searchTypesOpen.value = !searchTypesOpen.value;
  if (searchTypesOpen.value && !searchTypes.value.length) void loadSearchTypes();
}
function stopSearchClock() {
  if (searchClock) { clearInterval(searchClock); searchClock = undefined; }
}
function startSearchClock() {
  stopSearchClock();
  searchStartedAt = Date.now();
  searchElapsed.value = 0;
  searchClock = setInterval(() => {
    searchElapsed.value = Math.round((Date.now() - searchStartedAt) / 100) / 10;
  }, 200);
}
function updateTextSearch(immediate = false) {
  if (textSearchTimer) clearTimeout(textSearchTimer);
  const query = searchQuery.value.trim();
  const requestId = String(++textSearchId);
  if (!query) {
    searchResults.value = [];
    searching.value = false;
    stopSearchClock();
    void call("editor.search-cancel").catch(() => {});
    return;
  }
  searching.value = true;
  searchResults.value = [];
  startSearchClock();
  const start = async () => {
    try {
      await call("editor.search-start", { requestId, query, extensions: searchTypeFilter.value });
    } catch (error) {
      if (requestId === String(textSearchId)) { message(String(error)); searching.value = false; stopSearchClock(); }
    }
  };
  if (immediate) void start();
  else textSearchTimer = setTimeout(() => { textSearchTimer = undefined; void start(); }, 220);
}
function onSearchStream(payload: { requestId: string; hits?: SearchHit[]; done?: boolean; error?: string }) {
  if (payload.requestId !== String(textSearchId)) return;
  if (payload.hits?.length) {
    const seen = new Set(searchResults.value.map((hit) => `${hit.file}:${hit.line}:${hit.column}`));
    const fresh = payload.hits.filter((hit) => !seen.has(`${hit.file}:${hit.line}:${hit.column}`));
    if (fresh.length) searchResults.value = [...searchResults.value, ...fresh].slice(0, 500);
  }
  if (payload.error) { message(payload.error); searching.value = false; stopSearchClock(); }
  if (payload.done) { searching.value = false; stopSearchClock(); }
}
watch(searchTypeFilter, () => { if (searchQuery.value.trim()) updateTextSearch(true); }, { deep: true });
function openGoto() {
  if (!current.value) return;
  gotoValue.value = String(caret.value.line);
  gotoOpen.value = true;
  void nextTick(() => { gotoInput.value?.focus(); gotoInput.value?.select(); });
}
function closeGoto() {
  gotoOpen.value = false;
  editor?.focus();
}
function commitGoto() {
  const tab = current.value;
  if (!tab) { closeGoto(); return; }
  const match = /^(\d+)(?:\s*[:：]\s*(\d+))?$/.exec(gotoValue.value.trim());
  const line = match ? Number(match[1]) : NaN;
  const col = match?.[2] ? Number(match[2]) : 1;
  if (!Number.isFinite(line) || line < 1) {
    message("请输入有效行号（如 42 或 42:10）");
    gotoInput.value?.select();
    return;
  }
  const targetLine = Math.min(tab.model.getLineCount(), line);
  const targetCol = Math.max(1, Math.min(tab.model.getLineMaxColumn(targetLine), col || 1));
  editor?.setPosition({ lineNumber: targetLine, column: targetCol });
  editor?.revealLineInCenter(targetLine);
  gotoOpen.value = false;
  editor?.focus();
}
async function openSearchHit(hit: SearchHit) {
  await openFile(hit.file, { line: hit.line, column: hit.column }, true);
}
function closeSearch() {
  searchVisible.value = false;
  searchTypesOpen.value = false;
  textSearchId++;
  searching.value = false;
  stopSearchClock();
  void call("editor.search-cancel").catch(() => {});
  editor?.focus();
}
function startResize(event: PointerEvent) {
  event.preventDefault();
  const startX = event.clientX, initial = sidebarWidth.value;
  const move = (at: PointerEvent) => {
    sidebarWidth.value = Math.max(170, Math.min(Math.min(620, window.innerWidth - 420), initial + at.clientX - startX));
    editor?.layout();
  };
  const end = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", end);
    persistSession();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", end, { once: true });
}
function handleWindowBlur() { void saveAllTabs(); }
function handleVisibility() { if (document.visibilityState === "hidden") void saveAllTabs(); }
function applyJavaEdit(code: monaco.editor.IStandaloneCodeEditor, model: monaco.editor.ITextModel, edit: JavaEdit) {
  if (!edit.text && edit.from === edit.to) {
    code.setPosition(model.getPositionAt(edit.cursor));
  } else {
    code.pushUndoStop();
    code.executeEdits("java-editing", [{
      range: monaco.Range.fromPositions(model.getPositionAt(edit.from), model.getPositionAt(edit.to)),
      text: edit.text,
    }], () => [monaco.Selection.fromPositions(model.getPositionAt(edit.cursor))]);
    code.pushUndoStop();
  }
  const position = code.getPosition();
  if (position) code.revealPositionInCenterIfOutsideViewport(position);
}
function finishJavaStatement(code: monaco.editor.IStandaloneCodeEditor, suggest: boolean) {
  const model = code.getModel();
  if (!model) return;
  const { insertSpaces, indentSize } = model.getOptions();
  const indent = insertSpaces ? " ".repeat(indentSize) : "\t";
  const plan = () => {
    const position = code.getPosition();
    return position && completeJavaStatement(model.getValue(), model.getOffsetAt(position), indent, model.getEOL());
  };
  let edit = plan();
  if (!edit && suggest) {
    code.trigger("keyboard", "acceptSelectedSuggestion", null);
    edit = plan();
  }
  if (!edit) return;
  code.trigger("keyboard", "hideSuggestWidget", null);
  applyJavaEdit(code, model, edit);
}
function expandJavaOutputAtCursor() {
  const code = editor;
  const model = code?.getModel();
  const selection = code?.getSelection();
  if (!code?.hasTextFocus() || code.getOption(monaco.editor.EditorOption.readOnly) ||
      code.getOption(monaco.editor.EditorOption.tabFocusMode) || model?.getLanguageId() !== "java" ||
      !selection?.isEmpty() || code.getSelections()?.length !== 1) return false;
  const position = selection.getPosition();
  if (!isJavaOutputAbbreviation(model.getWordUntilPosition(position).word)) return false;
  const edit = expandJavaOutput(model.getValue(), model.getOffsetAt(position));
  if (!edit) return false;
  code.trigger("keyboard", "hideSuggestWidget", null);
  applyJavaEdit(code, model, edit);
  return true;
}
function handleKeys(event: KeyboardEvent) {
  if (activeDialog.value) return;
  const ctrl = event.ctrlKey || event.metaKey;
  const target = event.target as HTMLElement | null;
  const typing = !!target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable);
  if (gotoOpen.value) {
    if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); commitGoto(); return; }
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeGoto(); return; }
    return;
  }
  if (event.key === "Control" && !event.repeat) {
    ctrlHeld = true;
    if (hoverPosition) updateCtrlHover();
  }
  if (switcher.value.open) {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); cancelSwitcher(); return; }
    if (event.key === "Tab") {
      event.preventDefault(); event.stopPropagation();
      if (!event.repeat) stepSwitcher(event.shiftKey ? -1 : 1);
      return;
    }
  }
  if (event.key === "Escape" && blameMenu.value) {
    blameMenu.value = null;
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && tabMenu.value) {
    tabMenu.value = null;
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && tabListOpen.value) {
    tabListOpen.value = false;
    event.preventDefault();
    return;
  }
  if (event.key === "Escape" && projectPickerOpen.value) {
    projectPickerOpen.value = false;
    event.preventDefault();
    return;
  }
  if (event.key === "Tab" && !ctrl && !event.shiftKey && !event.altKey &&
      !event.isComposing && expandJavaOutputAtCursor()) {
    event.preventDefault();
    event.stopPropagation();
    return;
  }
  if (ctrl && event.key === "Tab") {
    event.preventDefault(); event.stopPropagation();
    if (!switcher.value.open) openSwitcher(event.shiftKey ? -1 : 1);
    else if (!event.repeat) stepSwitcher(event.shiftKey ? -1 : 1);
    return;
  }
  if (ctrl && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "g" && !typing) {
    event.preventDefault(); event.stopPropagation();
    openGoto();
    return;
  }
  if (ctrl && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "d" && !typing) {
    event.preventDefault(); event.stopPropagation();
    deleteCurrentLine();
    return;
  }
  if (ctrl && event.shiftKey && event.key.toLowerCase() === "r") { event.preventDefault(); void showFiles(); }
  else if (ctrl && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); void showSearch(); }
  else if (ctrl && event.key.toLowerCase() === "s") { event.preventDefault(); if (current.value) void saveTab(current.value); }
  else if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); goHistory(-1); }
  else if (event.altKey && event.key === "ArrowRight") { event.preventDefault(); goHistory(1); }
  else if (event.key === "Escape" && searchTypesOpen.value) { searchTypesOpen.value = false; event.preventDefault(); }
  else if (event.key === "Escape" && searchVisible.value && !paletteMode.value) { event.preventDefault(); closeSearch(); }
}
function handleKeyUp(event: KeyboardEvent) {
  if (event.key !== "Control" && event.key !== "Meta") return;
  ctrlHeld = false;
  clearCtrlHover();
  if (switcher.value.open) void commitSwitcher();
}
function lspNotification(method: string, params: any) {
  if (method === "status") {
    languageStatus.value = params.status;
    languageError.value = params.status === "error" ? params.message : "";
    return;
  }
  if (method === "diagnostics") {
    // JDT LS 和 Monaco 对 Windows 盘符的大小写和转义方式不同。
    const uri = monaco.Uri.parse(params.uri).toString();
    const tab = tabs.value.find((item) => item.uri === uri);
    if (!tab) return;
    monaco.editor.setModelMarkers(tab.model, "java", (params.diagnostics || []).filter(showJavaDiagnostic).map((diagnostic: any) => ({
      startLineNumber: diagnostic.range.start.line + 1,
      startColumn: diagnostic.range.start.character + 1,
      endLineNumber: diagnostic.range.end.line + 1,
      endColumn: diagnostic.range.end.character + 1,
      message: diagnostic.message,
      severity: diagnostic.severity === 1 ? monaco.MarkerSeverity.Error
        : diagnostic.severity === 2 ? monaco.MarkerSeverity.Warning
          : monaco.MarkerSeverity.Info,
      source: diagnostic.source || "Java",
    })));
  }
}
function registerLanguageProviders() {
  const editRange = (range: LspRange) => new monaco.Range(
    range.start.line + 1, range.start.character + 1,
    range.end.line + 1, range.end.character + 1,
  );
  const extraEdits = (item: any) => item?.additionalTextEdits?.map((edit: { range: LspRange; newText: string }) => ({
    range: editRange(edit.range), text: edit.newText,
  }));
  const documentation = (doc?: string | { kind: string; value: string }) =>
    typeof doc === "string" ? doc : doc?.kind === "markdown" ? { value: doc.value } : doc?.value;
  const kinds: Record<number, monaco.languages.CompletionItemKind> = {
    2: monaco.languages.CompletionItemKind.Method,
    3: monaco.languages.CompletionItemKind.Function,
    4: monaco.languages.CompletionItemKind.Constructor,
    5: monaco.languages.CompletionItemKind.Field,
    6: monaco.languages.CompletionItemKind.Variable,
    7: monaco.languages.CompletionItemKind.Class,
    8: monaco.languages.CompletionItemKind.Interface,
    14: monaco.languages.CompletionItemKind.Keyword,
    15: monaco.languages.CompletionItemKind.Snippet,
  };
  providers.push(monaco.languages.registerCompletionItemProvider("java", {
    triggerCharacters: [".", "@", "#"],
    provideCompletionItems: async (model, position, _trigger, token) => {
      const tab = tabs.value.find((item) => item.model === model);
      if (!tab || tab.readonly || !context.value?.java) return { suggestions: [] };
      const result = await semantic("completion", tab.file, position.lineNumber, position.column);
      if (token.isCancellationRequested) return { suggestions: [] };
      const items = Array.isArray(result) ? result : result?.items || [];
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return { incomplete: result?.isIncomplete, suggestions: items.slice(0, 150).map((item: any) => {
        const edit = item.textEdit;
        let insertText = edit?.newText ?? item.insertText ?? item.label;
        let replacement = edit?.range ? editRange(edit.range)
          : edit?.insert && edit?.replace ? { insert: editRange(edit.insert), replace: editRange(edit.replace) } : range;
        const showParameters = [2, 3, 4].includes(item.kind) && insertText.includes("(");
        if (showParameters) {
          const inserted = "insert" in replacement ? replacement.insert : replacement;
          const nameEnd = Math.max(inserted.endColumn, model.getWordAtPosition(position)?.endColumn ?? 0);
          const suffix = model.getLineContent(inserted.endLineNumber).slice(nameEnd - 1);
          const withoutDuplicate = preserveJavaCallSuffix(insertText, suffix);
          if (withoutDuplicate !== insertText) {
            insertText = withoutDuplicate;
            replacement = inserted.setEndPosition(inserted.endLineNumber, nameEnd);
          }
        }
        return {
          label: item.label,
          kind: kinds[item.kind] ?? monaco.languages.CompletionItemKind.Text,
          insertText,
          insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
          detail: item.detail,
          documentation: documentation(item.documentation),
          filterText: item.filterText,
          sortText: item.sortText,
          range: replacement,
          additionalTextEdits: extraEdits(item),
          command: showParameters ? { id: "editor.action.triggerParameterHints", title: "参数提示" } : undefined,
          __lsp: item,
          __file: tab.file,
        };
      }) };
    },
    resolveCompletionItem: async (suggestion) => {
      const item = suggestion as typeof suggestion & { __lsp?: any; __file?: string };
      if (!item.__lsp?.data || !item.__file) return suggestion;
      try {
        const resolved = await call<any>("editor.lsp-resolve", { file: item.__file, item: item.__lsp });
        return { ...suggestion,
          detail: resolved?.detail ?? suggestion.detail,
          documentation: documentation(resolved?.documentation) ?? suggestion.documentation,
          additionalTextEdits: extraEdits(resolved) ?? suggestion.additionalTextEdits,
        };
      } catch { return suggestion; }
    },
  }));
  providers.push(monaco.languages.registerHoverProvider("java", {
    provideHover: async (model, position) => {
      const tab = tabs.value.find((item) => item.model === model);
      if (!tab || !context.value?.java) return null;
      const result = await semantic("hover", tab.file, position.lineNumber, position.column);
      if (!result?.contents) return null;
      const value = Array.isArray(result.contents) ? result.contents.map((item: any) => typeof item === "string" ? item : item.value).join("\n\n")
        : typeof result.contents === "string" ? result.contents : result.contents.value;
      return { contents: [{ value: String(value || "") }] };
    },
  }));
  providers.push(monaco.languages.registerSignatureHelpProvider("java", {
    signatureHelpTriggerCharacters: ["(", ","],
    signatureHelpRetriggerCharacters: [","],
    provideSignatureHelp: async (model, position, token, trigger) => {
      const tab = tabs.value.find((item) => item.model === model);
      if (!tab || !context.value?.java) return null;
      let result = await semantic("signature", tab.file, position.lineNumber, position.column);
      if (token.isCancellationRequested) return null;
      if (!result?.signatures?.length && trigger.triggerKind === monaco.languages.SignatureHelpTriggerKind.Invoke) {
        const offset = javaCallArguments(model.getValue(), model.getOffsetAt(position));
        if (offset !== undefined) {
          const inside = model.getPositionAt(offset);
          result = await semantic("signature", tab.file, inside.lineNumber, inside.column);
        }
      }
      if (token.isCancellationRequested || !result?.signatures?.length) return null;
      return { value: {
        signatures: result.signatures.map((item: any) => ({
          label: item.label,
          documentation: documentation(item.documentation),
          activeParameter: item.activeParameter,
          parameters: (item.parameters || []).map((parameter: any) => ({
            label: parameter.label,
            documentation: documentation(parameter.documentation),
          })),
        })),
        activeSignature: result.activeSignature || 0,
        activeParameter: result.activeParameter || 0,
      }, dispose: () => {} };
    },
  }));
}

onMounted(async () => {
  try {
    context.value = await call<Context>("editor.context");
    languageStatus.value = context.value.status;
    languageError.value = context.value.error;
    document.title = `${context.value.projectName} · 代码编辑器`;
    rootNodes.value = await loadTree();
    let fontSize = 14, wrap = false;
    try {
      const preferences = JSON.parse(localStorage.getItem("git-diff-settings-v2") || "{}");
      dark.value = !!preferences.dark;
      fontSize = Math.max(10, Math.min(30, Number(preferences.fontSize) || 14));
      wrap = !!preferences.wrap;
      monaco.editor.setTheme(dark.value ? "workbench-dark" : "workbench-light");
    } catch { monaco.editor.setTheme("workbench-light"); }
    editor = monaco.editor.create(editorHost.value!, {
      ...diffCodeOptions(fontSize, wrap), readOnly: false,
      ...ideaFoldingOptions(), foldingImportsByDefault: true,
      lineNumbers: "on", glyphMargin: true,
      renderLineHighlight: "line", smoothScrolling: true,
      fixedOverflowWidgets: true,
      scrollbar: { verticalScrollbarSize: 9, horizontalScrollbarSize: 9 },
    });
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, () => void navigateSymbol("definition"));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyB, () => void navigateSymbol("implementation"));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyU, () => void navigateSymbol("super"));
    editor.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.F7, () => void navigateSymbol("references"));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyY, () => editor?.trigger("keyboard", "redo", null));
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyF, () => editor?.trigger("keyboard", "actions.find", null));
    const code = editor;
    installParameterHints(code);
    const javaEnter = monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Enter;
    const javaEditing = "editorTextFocus && editorLangId == java && !editorReadonly && !editorHasMultipleSelections";
    code.addCommand(javaEnter, () => finishJavaStatement(code, false), `${javaEditing} && !suggestWidgetVisible`);
    code.addCommand(javaEnter, () => finishJavaStatement(code, true), `${javaEditing} && suggestWidgetVisible`);
    editorHost.value?.addEventListener("contextmenu", (event) => {
      const element = event.target as HTMLElement | null;
      if (!element?.closest(".margin-view-overlays")) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openBlameMenuAt(event.clientX, event.clientY);
    }, true);
    editor.onMouseMove((event) => {
      hoverPosition = event.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT && event.target.position
        ? event.target.position : null;
      if (ctrlHeld || event.event.ctrlKey) updateCtrlHover();
      else if (ctrlLink.value) clearCtrlHover();
    });
    editor.onMouseLeave(() => { hoverPosition = null; clearCtrlHover(); });
    const updateBlameLayout = () => { if (showBlame.value) blameTick.value++; };
    editor.onDidScrollChange(updateBlameLayout);
    editor.onDidLayoutChange(updateBlameLayout);
    editor.onDidChangeModelContent(updateBlameLayout);
    editor.onDidChangeHiddenAreas(updateBlameLayout);
    editor.onDidChangeViewZones(updateBlameLayout);
    editor.onMouseDown((event) => {
      const position = event.target.position;
      if (!position || !event.event.ctrlKey || event.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return;
      event.event.preventDefault();
      void navigateSymbol(event.event.shiftKey ? "implementation" : "definition", position);
    });
    editor.onDidChangeCursorPosition((event) => {
      caret.value = { line: event.position.lineNumber, column: event.position.column };
      scheduleCursorStop();
    });
    registerLanguageProviders();
    void indexTypeScript();
    unlistenLsp = window.workbench.onEditorLsp(lspNotification);
    unlistenHistory = window.workbench.onEditorHistory((direction) => navigateHistory(direction < 0 ? -1 : 1));
    unlistenSearch = window.workbench.onEditorSearch(onSearchStream);
    const applyExternalOpen = async (target: EditorOpenTarget) => {
      if (!target) return;
      const pos = { line: Math.max(1, target.line || 1), column: Math.max(1, target.column || 1) };
      if (target.uri?.startsWith("jdt:")) await openVirtual(target.uri, pos, true);
      else if (target.file) await openFile(target.file, pos, true);
    };
    queuedOpen = context.value.initialOpen;
    unlistenOpen = window.workbench.onEditorOpen((target) => {
      if (editorReady) void applyExternalOpen(target);
      else queuedOpen = target;
    });
    unlistenDisk = window.workbench.onEditorDisk(async (file) => {
      const tab = tabs.value.find((item) => item.file === file);
      if (!tab || tab.readonly) return;
      try {
        const version = await call<string | null>("editor.version", { file });
        if (version === tab.version) return;
        tab.stale = true;
        refreshTabs();
        if (!tab.dirty && version) await reloadTab(tab);
        else message(`${file} 已在外部修改`);
      } catch { /* A removed file is handled on save. */ }
    });
    window.addEventListener("keydown", handleKeys, true);
    window.addEventListener("keyup", handleKeyUp, true);
    window.addEventListener("mouseup", handleMouseButtons, true);
    window.addEventListener("blur", handleWindowBlur);
    if (tabStrip.value) {
      tabResizeObserver = new ResizeObserver(() => updateTabOverflow());
      tabResizeObserver.observe(tabStrip.value);
    }
    updateTabOverflow();
    document.addEventListener("visibilitychange", handleVisibility);
    window.__workbenchCanClose = canClose;
    try {
      const session = JSON.parse(localStorage.getItem(sessionKey()) || "{}");
      if (Number.isFinite(session.sidebarWidth)) sidebarWidth.value = Math.max(170, Math.min(620, session.sidebarWidth));
      for (const item of (session.files || []).slice(0, 20)) {
        if (typeof item.file !== "string") continue;
        await openFile(item.file);
        const tab = tabs.value.find((value) => value.file === item.file);
        if (tab && item.position) tab.restore = {
          lineNumber: Number(item.position.lineNumber) || 1,
          column: Number(item.position.column) || 1,
          scrollTop: Number(item.scrollTop) || 0,
        };
      }
      if (!queuedOpen && session.active && tabs.value.some((item) => item.file === session.active)) await openFile(session.active);
      history = Array.isArray(session.history) ? session.history.slice(-200) : [];
      historyIndex = Math.min(history.length - 1, Number(session.historyIndex) || 0);
      editorReady = true;
      if (queuedOpen) {
        const target = queuedOpen;
        queuedOpen = undefined;
        await applyExternalOpen(target);
      }
      await nextTick();
      updateTabOverflow();
      scrollActiveTabIntoView();
    } catch {
      editorReady = true;
      if (queuedOpen) {
        const target = queuedOpen;
        queuedOpen = undefined;
        await applyExternalOpen(target);
      }
    }
  } catch (error) { message(error instanceof Error ? error.message : String(error)); }
});
onBeforeUnmount(() => {
  disposed = true;
  persistSession();
  window.removeEventListener("keydown", handleKeys, true);
  window.removeEventListener("keyup", handleKeyUp, true);
  window.removeEventListener("mouseup", handleMouseButtons, true);
  window.removeEventListener("blur", handleWindowBlur);
  document.removeEventListener("visibilitychange", handleVisibility);
  unlistenLsp?.();
  unlistenDisk?.();
  unlistenHistory?.();
  unlistenSearch?.();
  unlistenOpen?.();
  stopSearchClock();
  if (statusTimer) clearTimeout(statusTimer);
  if (cursorStopTimer) clearTimeout(cursorStopTimer);
  tabResizeObserver?.disconnect();
  providers.forEach((item) => item.dispose());
  if (fileSearchTimer) clearTimeout(fileSearchTimer);
  if (textSearchTimer) clearTimeout(textSearchTimer);
  if (revealTimer) clearTimeout(revealTimer);
  for (const tab of tabs.value) {
    if (tab.changeTimer) clearTimeout(tab.changeTimer);
    if (tab.autoSaveTimer) clearTimeout(tab.autoSaveTimer);
    closeBlame(tab);
    tab.dispose?.dispose(); tab.model.dispose();
  }
  editor?.dispose();
  if (disposed) window.__workbenchCanClose = undefined;
});
</script>

<template>
  <div class="editor-window" :class="{ 'editor-dark': dark, 'ctrl-link-hover': ctrlLink }">
    <header class="editor-header">
      <button
        class="editor-project-title"
        :class="{ open: projectPickerOpen }"
        title="切换项目"
        :aria-expanded="projectPickerOpen"
        @click="toggleProjectPicker"
      >
        <Icon name="code" :size="16" /><strong>{{ context?.projectName || '代码编辑器' }}</strong><Icon name="down" :size="12" class="editor-project-caret" />
      </button>
      <div class="editor-header-actions">
        <button title="打开项目文件（Ctrl+Shift+R）" @click="showFiles"><Icon name="file" :size="15" /></button>
        <button title="全项目搜索（Ctrl+Shift+F）" @click="showSearch"><Icon name="search" :size="15" /></button>
      </div>
    </header>
    <div v-if="projectPickerOpen" class="editor-project-backdrop" @click="projectPickerOpen = false"></div>
    <Transition name="pop">
      <section
        v-if="projectPickerOpen"
        class="editor-project-picker"
        role="dialog"
        aria-label="切换项目"
        @keydown="onProjectPickerKeydown"
      >
      <div class="editor-project-search">
        <Icon name="search" :size="14" class="editor-project-search-icon" />
        <input
          ref="projectFilterInput"
          v-model="projectQuery"
          class="editor-project-filter"
          placeholder="搜索项目名、分组或路径…"
          aria-label="筛选项目"
          autocomplete="off"
        />
        <CloseButton
          v-if="projectQuery"
          label="清空搜索"
          :size="12"
          @click="projectQuery = ''; projectFilterInput?.focus()"
        />
        <span v-if="projectQuery.trim()" class="editor-project-count">{{ orderedFilteredProjects.length }}</span>
      </div>
      <div ref="projectListHost" class="editor-project-list">
        <template v-for="group in groupedProjects" :key="group.name">
          <div v-if="groupedProjects.length > 1" class="editor-project-group">{{ group.name }}</div>
          <div
            v-for="project in group.items"
            :key="project.id"
            :data-project-id="project.id"
            class="editor-project-row"
            :class="{
              current: project.id === context?.projectId,
              highlighted: project.id === projectActiveId,
            }"
            role="button"
            :aria-current="project.id === context?.projectId ? 'true' : undefined"
            tabindex="0"
            @mouseenter="projectActiveId = ''"
            @click="switchProject(project, 'window')"
          >
            <span class="editor-project-icon" :class="projectIcon(project).cls" aria-hidden="true">
              <Icon :name="projectIcon(project).icon" :size="15" />
            </span>
            <div class="editor-project-info">
              <strong>{{ project.name }}</strong>
              <code :title="project.path">{{ project.path }}</code>
            </div>
            <div class="editor-project-actions" @click.stop>
              <button
                v-if="project.id !== context?.projectId"
                type="button"
                class="editor-project-btn primary"
                :disabled="projectBusy"
                title="在本窗口切换到此项目（Enter）"
                @click="switchProject(project, 'window')"
              >
                本窗口切换
              </button>
              <button
                type="button"
                class="editor-project-btn"
                :disabled="projectBusy"
                title="在新窗口打开此项目（Ctrl+Enter）"
                @click="switchProject(project, 'new')"
              >
                <Icon name="external" :size="11" />新窗口打开
              </button>
            </div>
          </div>
        </template>
        <p v-if="!orderedFilteredProjects.length" class="editor-project-empty">没有匹配的项目</p>
      </div>
      </section>
    </Transition>
    <div class="editor-workspace">
      <aside class="editor-sidebar" :style="{ width: `${sidebarWidth}px` }">
        <div class="editor-sidebar-title">项目</div>
        <div ref="treeHost" class="editor-tree-scroll">
          <EditorTreeNode v-for="node in rootNodes" :key="node.file" :node="node" :depth="0" :active="activeFile"
            @toggle="toggleNode" @open="openFile($event)" />
        </div>
      </aside>
      <div class="editor-splitter" title="拖动调整目录宽度" @pointerdown="startResize"></div>
      <main class="editor-main">
        <div class="editor-tabbar">
          <div ref="tabStrip" class="editor-tabs" role="tablist">
            <div v-for="tab in tabs" :key="tab.file" class="editor-tab" :class="{ active: tab.file === activeFile }"
              role="tab" :aria-selected="tab.file === activeFile" :title="tab.file" @click="openFile(tab.file)"
              @contextmenu.prevent="openTabMenu(tab, $event)">
              <span v-if="tab.dirty" class="editor-dirty" title="未保存"></span>
              <FileTypeIcon v-else :name="displayName(tab.file)" :java-kind="tab.javaKind" :size="14" />
              <span class="editor-tab-name">{{ displayName(tab.file) }}</span>
              <span v-if="tab.stale" class="editor-stale" title="磁盘文件已变化">!</span>
              <CloseButton label="关闭文件" :size="11" @click.stop="closeTab(tab)" />
            </div>
          </div>
          <button v-if="tabsOverflow" class="editor-tab-more" :class="{ open: tabListOpen }" title="显示所有标签页"
            aria-label="显示所有标签页" @click="toggleTabList">
            <Icon name="chevron" :size="13" />
          </button>
        </div>
        <div class="editor-content" :class="{ 'with-blame': showBlame }">
          <div v-if="showBlame" class="editor-blame" aria-label="提交历史标注" :aria-busy="activeBlame?.loading"
            @wheel.prevent="scrollBlame" @contextmenu.prevent.stop="openBlameMenuAt($event.clientX, $event.clientY)">
            <button v-for="row in blameRows" :key="row.line" class="editor-blame-row"
              :class="{ local: row.uncommitted }" :data-line="row.line" :data-age-band="row.ageBand"
              :style="{
                top: `${row.top}px`, height: `${row.height}px`, '--blame-line-height': `${row.lineHeight}px`,
              }"
              :title="row.uncommitted ? row.summary : `${row.date} · ${row.author}\n${row.hash.slice(0, 8)} ${row.summary}`"
              @click="showBlameDiff(row)">
              <span v-if="row.uncommitted" class="editor-blame-local">未提交</span>
              <span v-else class="editor-blame-date">{{ row.date }}</span>
              <span v-if="!row.uncommitted" class="editor-blame-author">{{ row.authorLabel }}</span>
            </button>
          </div>
          <div v-if="!current" class="editor-empty">从左侧选择文件，或按 Ctrl+Shift+R 搜索</div>
          <div ref="editorHost" class="editor-monaco"></div>
        </div>
        <section v-if="searchVisible" class="editor-search-panel">
          <div class="editor-search-bar"><Icon name="search" :size="15" />
            <input ref="searchInput" v-model="searchQuery" placeholder="搜索项目内容" aria-label="搜索项目内容"
              @input="updateTextSearch()" @keydown.esc="closeSearch" />
            <CloseButton
              v-if="searchQuery"
              label="清除搜索内容"
              :size="12"
              @click="searchQuery = ''; updateTextSearch(true); searchInput?.focus()"
            />
            <span class="editor-search-count">{{ searching ? `搜索中… ${searchElapsed.toFixed(1)}s${searchResults.length ? ` · ${searchResults.length} 处` : ''}` : searchResults.length >= 500 ? '前 500 处' : searchResults.length ? `${searchResults.length} 处` : '' }}</span>
            <button class="editor-search-filter" :class="{ active: searchTypeFilter.length }"
              @click.stop="toggleSearchTypes">
              文件类型<span v-if="searchTypeFilter.length">{{ searchTypeFilter.length }}</span>
            </button>
            <CloseButton label="关闭搜索" :size="13" @click="closeSearch" />
          </div>
          <div v-if="searching" class="editor-search-progress"></div>
          <div v-if="searchTypesOpen" class="editor-search-types-backdrop" @mousedown="searchTypesOpen = false"></div>
          <Transition name="pop">
            <div v-if="searchTypesOpen" class="editor-search-types" role="group" aria-label="文件类型" @mousedown.stop>
              <div class="editor-search-types-list">
                <label v-for="type in searchTypes" :key="type.ext">
                  <input v-model="searchTypeFilter" type="checkbox" :value="type.ext" />
                  <span>.{{ type.ext }}</span><small>{{ type.count }}</small>
                </label>
                <p v-if="!searchTypes.length" class="editor-search-types-empty">正在读取项目文件类型…</p>
              </div>
              <div class="editor-search-types-foot">
                <button class="link" :disabled="!searchTypeFilter.length" @click="searchTypeFilter = []">清除筛选</button>
              </div>
            </div>
          </Transition>
          <div class="editor-search-results">
            <div v-if="!searching && searchQuery.trim() && !searchGroups.length" class="editor-search-empty">
              <span>未找到匹配内容</span>
              <button
                v-if="searchTypeFilter.length"
                type="button"
                class="link"
                @click="searchTypeFilter = []"
              >
                清除文件类型筛选
              </button>
            </div>
            <div v-for="group in searchGroups" :key="group.file" class="editor-search-group">
              <div class="editor-search-file" :title="group.file">{{ group.file }} <span>{{ group.hits.length }}</span></div>
              <button v-for="(hit, index) in group.hits" :key="`${hit.line}:${hit.column}:${index}`"
                class="editor-search-hit"
                :title="`${hit.file}:${hit.line}:${hit.column}`"
                @click="openSearchHit(hit)">
                <span class="editor-search-line">{{ hit.line }}</span><code>{{ hit.text }}</code>
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
    <footer class="editor-statusbar">
      <span>{{ context?.java ? (languageStatus === 'ready' ? 'Java 已就绪' : languageStatus === 'indexing' || languageStatus === 'starting' ? 'Java 索引中' : languageError || '') : tsStatus }}</span>
      <span class="editor-status-message">{{ status }}</span>
      <span v-if="current">{{ caret.line }}:{{ caret.column }} · {{ current.encoding.toUpperCase() }} · {{ current.model.getEOL() === '\r\n' ? 'CRLF' : 'LF' }}</span>
    </footer>
    <Transition name="overlay-pop">
      <div v-if="gotoOpen" class="editor-goto-backdrop" @mousedown.self="closeGoto">
        <div class="editor-goto" role="dialog" aria-label="转到行">
          <label for="editor-goto-line">转到行</label>
          <input id="editor-goto-line" ref="gotoInput" v-model="gotoValue" inputmode="numeric" aria-label="行号" />
          <small v-if="current">1 - {{ current.model.getLineCount() }}</small>
        </div>
      </div>
    </Transition>
    <div v-if="tabMenu" class="editor-menu-backdrop" @mousedown="tabMenu = null" @contextmenu.prevent="tabMenu = null"></div>
    <Transition name="pop">
      <div v-if="tabMenu" class="editor-tab-menu" :style="{ left: `${tabMenu.x}px`, top: `${tabMenu.y}px` }" role="menu">
        <button role="menuitem" @click="closeTabGroup('current')">关闭</button>
        <button role="menuitem" :disabled="tabs.length < 2" @click="closeTabGroup('others')">关闭其他</button>
        <button role="menuitem" :disabled="tabIndex(tabMenu.file) <= 0" @click="closeTabGroup('left')">关闭左边</button>
        <button role="menuitem" :disabled="tabIndex(tabMenu.file) >= tabs.length - 1" @click="closeTabGroup('right')">关闭右边</button>
        <div class="editor-menu-separator"></div>
        <button role="menuitem" @click="closeTabGroup('all')">关闭所有</button>
      </div>
    </Transition>
    <div v-if="blameMenu" class="editor-menu-backdrop" @mousedown="blameMenu = null" @contextmenu.prevent="blameMenu = null"></div>
    <Transition name="pop">
      <div v-if="blameMenu" class="editor-tab-menu editor-blame-menu" :style="{ left: `${blameMenu.x}px`, top: `${blameMenu.y}px` }" role="menu">
        <button role="menuitem" :disabled="activeBlame?.loading && !activeBlame.snapshot" @click="toggleBlameFromMenu">
          {{ activeBlame ? '关闭提交历史' : '显示提交历史' }}
        </button>
      </div>
    </Transition>
    <div v-if="tabListOpen" class="editor-menu-backdrop" @mousedown="tabListOpen = false" @contextmenu.prevent="tabListOpen = false"></div>
    <Transition name="pop">
      <div v-if="tabListOpen" class="editor-tab-list" :style="{ top: `${tabListPos.top}px`, right: `${tabListPos.right}px` }" role="menu">
        <button v-for="file in tabListFiles" :key="file" role="menuitem" :class="{ active: file === activeFile }"
          @click="pickTab(file)">
          <FileTypeIcon :name="displayName(file)" :java-kind="tabs.find((tab) => tab.file === file)?.javaKind" :size="14" />
          <span>{{ displayName(file) }}</span>
          <code>{{ file }}</code>
        </button>
      </div>
    </Transition>
    <Transition name="overlay-pop">
      <div v-if="switcher.open" class="editor-switcher-backdrop" @mousedown.self="cancelSwitcher">
        <div class="editor-switcher" role="listbox" aria-label="最近打开的文件">
          <div class="editor-switcher-head">切换文件<span>松开 Ctrl 打开 · Tab 继续选择</span></div>
          <button v-for="(entry, index) in switcherEntries" :key="entry.file" class="editor-switcher-row"
            :class="{ selected: index === switcher.index }" role="option" :aria-selected="index === switcher.index"
            @mouseenter="switcher.index = index" @click="switcher.index = index; commitSwitcher()">
            <FileTypeIcon :name="entry.name" :java-kind="entry.javaKind" :size="14" />
            <span class="editor-switcher-name">{{ entry.name }}</span>
            <code class="editor-switcher-path">{{ entry.file }}</code>
          </button>
        </div>
      </div>
    </Transition>
    <Transition name="overlay-pop">
      <div v-if="paletteMode" class="editor-palette-backdrop" @mousedown.self="closePalette">
      <div class="editor-palette" role="dialog" :aria-label="paletteTitle">
        <div class="editor-palette-heading">{{ paletteMode === 'files' && !paletteQuery.trim() && paletteCount ? '最近打开的文件' : paletteTitle }} <CloseButton label="关闭" :size="13" @click="closePalette" /></div>
        <input ref="paletteInput" v-model="paletteQuery" :placeholder="paletteMode === 'files' ? '输入文件名或路径' : '筛选结果'"
          @input="paletteMode === 'files' ? updateFileSearch() : selectedResult = 0" @keydown="paletteKey" />
        <div ref="paletteList" class="editor-palette-list" @scroll="paletteScroll = ($event.target as HTMLElement).scrollTop">
          <div v-if="!paletteCount" class="editor-palette-empty">
            {{ paletteMode === 'files' && fileSearching ? '搜索中…' : (paletteQuery.trim() ? '没有匹配项' : '输入关键词搜索项目文件') }}
          </div>
          <div v-else class="editor-palette-spacer" :style="{ height: `${paletteCount * paletteRowHeight}px` }">
          <template v-if="paletteMode === 'files'">
            <button v-for="(file, index) in paletteFiles" :key="file" :class="{ selected: paletteStart + index === selectedResult }"
              :style="{ top: `${(paletteStart + index) * paletteRowHeight}px`, height: `${paletteRowHeight}px` }"
              @mouseenter="selectedResult = paletteStart + index" @click="acceptPalette(paletteStart + index)">
              <FileTypeIcon :name="file" :size="14" /><span>{{ file }}</span>
            </button>
          </template>
          <template v-else>
            <button v-for="(target, index) in paletteLocations" :key="`${target.uri}:${target.line}:${target.column}`"
              :style="{ top: `${(paletteStart + index) * paletteRowHeight}px`, height: `${paletteRowHeight}px` }"
              :class="{ selected: paletteStart + index === selectedResult }" @mouseenter="selectedResult = paletteStart + index" @click="acceptPalette(paletteStart + index)">
              <span class="editor-palette-location">{{ target.label }}:{{ target.line }}</span>
              <code>{{ target.snippet }}</code>
            </button>
          </template>
          </div>
        </div>
        </div>
      </div>
    </Transition>
    <MessageDialog :dark="dark" />
  </div>
</template>

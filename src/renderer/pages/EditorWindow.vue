<script setup lang="ts">
import { computed, markRaw, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { monaco, language, diffCodeOptions } from "../monaco";
import * as tsLanguage from "monaco-editor/languages/features/typescript/register.js";
import TypeScriptWorker from "monaco-editor/language/typescript/ts.worker.js?worker";
import "monaco-editor/editor/contrib/documentSymbols/browser/outlineModel.js";
import { call } from "../state";
import Icon from "../components/Icon.vue";
import CloseButton from "../components/CloseButton.vue";
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
}
interface DiskFile {
  file: string;
  text: string;
  version: string;
  encoding: "utf8" | "utf16le" | "utf16be" | "gb18030";
  bom: boolean;
  eol: "\n" | "\r\n";
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
  view?: monaco.editor.ICodeEditorViewState | null;
  restore?: { lineNumber: number; column: number; scrollTop: number };
  changeTimer?: ReturnType<typeof setTimeout>;
  saving?: Promise<boolean>;
  reloadId?: number;
  dispose?: monaco.IDisposable;
}
interface Position { file: string; line: number; column: number; uri?: string }
interface LspRange { start: { line: number; character: number }; end: { line: number; character: number } }
interface Target extends Position { uri: string; label: string; snippet?: string; range?: LspRange }
interface SearchHit { file: string; line: number; column: number; text: string }

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
const locationResults = ref<Target[]>([]);
const selectedResult = ref(0);
const paletteScroll = ref(0);
const searchVisible = ref(false);
const searchQuery = ref("");
const searchResults = ref<SearchHit[]>([]);
const searching = ref(false);
const searchGroups = computed(() => {
  const groups = new Map<string, SearchHit[]>();
  for (const hit of searchResults.value) {
    if (!groups.has(hit.file)) groups.set(hit.file, []);
    groups.get(hit.file)!.push(hit);
  }
  return [...groups].map(([file, hits]) => ({ file, hits }));
});

let editor: monaco.editor.IStandaloneCodeEditor | undefined;
let disposed = false;
let unlistenLsp: (() => void) | undefined;
let unlistenDisk: (() => void) | undefined;
let fileSearchTimer: ReturnType<typeof setTimeout> | undefined;
let textSearchTimer: ReturnType<typeof setTimeout> | undefined;
let textSearchId = 0;
let revealTimer: ReturnType<typeof setTimeout> | undefined;
let revealDecorations: string[] = [];
let revealModel: monaco.editor.ITextModel | undefined;
let providers: monaco.IDisposable[] = [];
let history: Position[] = [];
let historyIndex = -1;
let paletteToken = 0;

function message(text: string) {
  status.value = text;
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
function recordJump(destination: Position) {
  const source = currentPosition();
  if (source && (historyIndex < 0 || !samePosition(history[historyIndex], source))) {
    history = history.slice(0, historyIndex + 1);
    history.push(source);
    historyIndex = history.length - 1;
  }
  if (historyIndex < 0 || !samePosition(history[historyIndex], destination)) {
    history = history.slice(0, historyIndex + 1);
    history.push(destination);
    historyIndex = history.length - 1;
  }
  if (history.length > 200) { history.shift(); historyIndex--; }
  persistSession();
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
  return (await call<{ name: string; file: string; directory: boolean }[]>("editor.tree", { directory }))
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
  if (!tab) {
    try {
      const disk = await call<DiskFile>("editor.read", { file });
      const uri = monaco.Uri.file(fullPath(file));
      const model = markRaw(monaco.editor.createModel(disk.text, language(file), uri));
      if (disk.eol === "\r\n") model.setEOL(monaco.editor.EndOfLineSequence.CRLF);
      tab = {
        file, uri: uri.toString(), model, savedText: model.getValue(), version: disk.version,
        encoding: disk.encoding, bom: disk.bom, dirty: false, stale: false, readonly: false,
      };
      const opened = tab;
      tab.dispose = model.onDidChangeContent(() => {
        opened.dirty = model.getValue() !== opened.savedText;
        refreshTabs();
        if (file.endsWith(".java") && context.value?.java) queueSync(opened);
      });
      tabs.value = [...tabs.value, tab];
      void call("editor.watch", { file }).catch(() => {});
      if (file.endsWith(".java") && context.value.java)
        void call("editor.lsp-open", { file, text: model.getValue() }).catch((error) => message(String(error)));
    } catch (error) { message(error instanceof Error ? error.message : String(error)); return; }
  }
  if (remember && position) recordJump({ file, ...position, uri: tab.uri });
  if (current.value && current.value !== tab) current.value.view = editor.saveViewState();
  activeFile.value = file;
  editor.setModel(tab.model);
  editor.updateOptions({ readOnly: tab.readonly });
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
  if (current.value && current.value !== tab) current.value.view = editor.saveViewState();
  activeFile.value = tab.file;
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

async function saveTab(tab: Tab): Promise<boolean> {
  if (tab.saving) {
    if (!(await tab.saving)) return false;
    return tab.dirty ? saveTab(tab) : true;
  }
  const pending = persistTab(tab);
  tab.saving = pending;
  try { return await pending; }
  finally { tab.saving = undefined; }
}
async function persistTab(tab: Tab): Promise<boolean> {
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
    message(`已保存 ${tab.file}`);
    persistSession();
    return true;
  } catch (error) { message(error instanceof Error ? error.message : String(error)); return false; }
}
async function confirmTabClose(tab: Tab) {
  while (tab.dirty) {
    const choice = await call<"save" | "discard" | "cancel">("editor.confirm-save", { file: tab.file });
    if (choice === "cancel") return false;
    if (choice === "discard") return true;
    if (!(await saveTab(tab))) return false;
  }
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
  tab.dirty = false;
  tab.stale = false;
  refreshTabs();
  if (tab.file.endsWith(".java") && context.value?.java) await flushSync(tab);
}
async function closeTab(tab: Tab) {
  if (!(await confirmTabClose(tab))) return;
  if (tab.changeTimer) clearTimeout(tab.changeTimer);
  if (!tab.readonly) {
    void call("editor.unwatch", { file: tab.file }).catch(() => {});
    if (tab.file.endsWith(".java") && context.value?.java)
      void call("editor.lsp-close", { file: tab.file }).catch(() => {});
  }
  const index = tabs.value.indexOf(tab);
  tabs.value = tabs.value.filter((item) => item !== tab);
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
async function canClose() {
  for (const tab of tabs.value.filter((item) => item.dirty)) {
    if (!(await confirmTabClose(tab))) return false;
  }
  persistSession();
  return true;
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
function isTypeScriptFile(file: string) { return /\.(?:ts|tsx|js|jsx)$/i.test(file); }
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
async function typeScriptNavigate(kind: "definition" | "implementation" | "references" | "super", tab: Tab, line: number, column: number) {
  if (kind === "implementation" || kind === "super") {
    message("当前语言服务暂不提供此语义关系");
    return;
  }
  try {
    let matches = await typeScriptTargets(tab, line, column, kind);
    if (kind === "definition" && (!matches.length || matches.some((item) => onDeclaration(item, tab.file, line, column)))) {
      const references = await typeScriptTargets(tab, line, column, "references");
      if (references.length || !matches.length) {
        await showTargets("引用与调用", references);
        return;
      }
    }
    await showTargets(kind === "definition" ? "声明或定义" : "引用与调用", matches);
  } catch (error) { message(String(error)); }
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
    await typeScriptNavigate(kind, tab, line, column);
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
  const next = historyIndex + direction;
  if (next < 0 || next >= history.length) return;
  historyIndex = next;
  const target = history[next];
  if (target.uri?.startsWith("jdt:")) void openVirtual(target.uri, target, false);
  else void openFile(target.file, target, false);
  persistSession();
}

function closePalette() { paletteToken++; paletteMode.value = ""; paletteQuery.value = ""; }
watch(selectedResult, async () => {
  await nextTick();
  const list = paletteList.value, row = paletteMode.value === "locations" ? 42 : 30;
  if (!list) return;
  if (selectedResult.value * row < list.scrollTop) list.scrollTop = selectedResult.value * row;
  else if ((selectedResult.value + 1) * row > list.scrollTop + list.clientHeight)
    list.scrollTop = (selectedResult.value + 1) * row - list.clientHeight;
});
async function showFiles() {
  paletteToken++;
  paletteMode.value = "files";
  paletteTitle.value = "打开项目文件";
  paletteQuery.value = "";
  fileResults.value = [];
  selectedResult.value = 0;
  paletteScroll.value = 0;
  await nextTick();
  if (paletteList.value) paletteList.value.scrollTop = 0;
  paletteInput.value?.focus();
}
function updateFileSearch() {
  if (fileSearchTimer) clearTimeout(fileSearchTimer);
  const query = paletteQuery.value;
  fileSearchTimer = setTimeout(async () => {
    if (paletteMode.value !== "files" || !query) { fileResults.value = []; return; }
    try { fileResults.value = await call<string[]>("editor.file-search", { query }); }
    catch (error) { message(String(error)); }
    selectedResult.value = 0;
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
async function acceptPalette(index = selectedResult.value) {
  if (paletteMode.value === "files") {
    const file = fileResults.value[index];
    if (file) { closePalette(); await openFile(file); }
  } else if (paletteMode.value === "locations") {
    const target = visibleLocations.value[index];
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
  await nextTick();
  searchInput.value?.focus();
}
function updateTextSearch() {
  if (textSearchTimer) clearTimeout(textSearchTimer);
  const query = searchQuery.value.trim(), requestId = ++textSearchId;
  if (!query) { searchResults.value = []; searching.value = false; return; }
  searching.value = true;
  textSearchTimer = setTimeout(async () => {
    try {
      const result = await call<SearchHit[]>("editor.text-search", { query });
      if (requestId === textSearchId) searchResults.value = result;
    } catch (error) { if (requestId === textSearchId) message(String(error)); }
    finally { if (requestId === textSearchId) searching.value = false; }
  }, 250);
}
async function openSearchHit(hit: SearchHit) {
  await openFile(hit.file, { line: hit.line, column: hit.column }, true);
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
function handleKeys(event: KeyboardEvent) {
  const ctrl = event.ctrlKey || event.metaKey;
  if (ctrl && event.shiftKey && event.key.toLowerCase() === "r") { event.preventDefault(); void showFiles(); }
  else if (ctrl && event.shiftKey && event.key.toLowerCase() === "f") { event.preventDefault(); void showSearch(); }
  else if (ctrl && event.key.toLowerCase() === "s") { event.preventDefault(); if (current.value) void saveTab(current.value); }
  else if (event.altKey && event.key === "ArrowLeft") { event.preventDefault(); goHistory(-1); }
  else if (event.altKey && event.key === "ArrowRight") { event.preventDefault(); goHistory(1); }
  else if (event.key === "Escape" && searchVisible.value && !paletteMode.value) { searchVisible.value = false; editor?.focus(); }
}
function lspNotification(method: string, params: any) {
  if (method === "status") {
    languageStatus.value = params.status;
    languageError.value = params.status === "error" ? params.message : "";
    return;
  }
  if (method === "diagnostics") {
    const tab = tabs.value.find((item) => item.uri === params.uri);
    if (!tab) return;
    monaco.editor.setModelMarkers(tab.model, "java", (params.diagnostics || []).map((diagnostic: any) => ({
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
  const extraEdits = (item: any) => (item.additionalTextEdits || []).map((edit: any) => ({
    range: editRange(edit.range), text: edit.newText,
  }));
  providers.push(monaco.languages.registerCompletionItemProvider("java", {
    triggerCharacters: [".", "@", "#"],
    provideCompletionItems: async (model, position) => {
      const tab = tabs.value.find((item) => item.model === model);
      if (!tab || !context.value?.java) return { suggestions: [] };
      const result = await semantic("completion", tab.file, position.lineNumber, position.column);
      const items = Array.isArray(result) ? result : result?.items || [];
      const word = model.getWordUntilPosition(position);
      const range = new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn);
      return { suggestions: items.slice(0, 150).map((item: any) => ({
        label: item.label,
        kind: item.kind === 7 ? monaco.languages.CompletionItemKind.Class
          : item.kind === 8 ? monaco.languages.CompletionItemKind.Interface
            : item.kind === 2 ? monaco.languages.CompletionItemKind.Method
              : item.kind === 3 ? monaco.languages.CompletionItemKind.Function
                : item.kind === 5 ? monaco.languages.CompletionItemKind.Field
                  : monaco.languages.CompletionItemKind.Text,
        insertText: item.textEdit?.newText || item.insertText || item.label,
        detail: item.detail,
        documentation: typeof item.documentation === "string" ? item.documentation : item.documentation?.value,
        sortText: item.sortText,
        range: item.textEdit?.range ? editRange(item.textEdit.range) : range,
        additionalTextEdits: extraEdits(item),
        __lsp: item,
        __file: tab.file,
      })) };
    },
    resolveCompletionItem: async (suggestion) => {
      const item = suggestion as typeof suggestion & { __lsp?: any; __file?: string };
      if (!item.__lsp || !item.__file) return suggestion;
      try {
        const resolved = await call<any>("editor.lsp-resolve", { file: item.__file, item: item.__lsp });
        return { ...suggestion,
          detail: resolved.detail || suggestion.detail,
          documentation: typeof resolved.documentation === "string" ? resolved.documentation : resolved.documentation?.value,
          additionalTextEdits: extraEdits(resolved),
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
    provideSignatureHelp: async (model, position) => {
      const tab = tabs.value.find((item) => item.model === model);
      if (!tab || !context.value?.java) return null;
      const result = await semantic("signature", tab.file, position.lineNumber, position.column);
      if (!result?.signatures?.length) return null;
      return { value: {
        signatures: result.signatures.map((item: any) => ({
          label: item.label,
          documentation: typeof item.documentation === "string" ? item.documentation : item.documentation?.value,
          parameters: (item.parameters || []).map((parameter: any) => ({
            label: typeof parameter.label === "string" ? parameter.label
              : item.label.slice(parameter.label[0], parameter.label[1]),
            documentation: typeof parameter.documentation === "string" ? parameter.documentation : parameter.documentation?.value,
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
      lineNumbers: "on", folding: true, glyphMargin: true,
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
    editor.onMouseDown((event) => {
      const position = event.target.position;
      if (!position || !event.event.ctrlKey || event.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT) return;
      event.event.preventDefault();
      void navigateSymbol(event.event.shiftKey ? "implementation" : "definition", position);
    });
    editor.onDidChangeCursorPosition((event) => {
      caret.value = { line: event.position.lineNumber, column: event.position.column };
    });
    registerLanguageProviders();
    void indexTypeScript();
    unlistenLsp = window.workbench.onEditorLsp(lspNotification);
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
      if (session.active && tabs.value.some((item) => item.file === session.active)) await openFile(session.active);
      history = Array.isArray(session.history) ? session.history.slice(-200) : [];
      historyIndex = Math.min(history.length - 1, Number(session.historyIndex) || 0);
    } catch { /* A stale session does not block the editor. */ }
  } catch (error) { message(error instanceof Error ? error.message : String(error)); }
});
onBeforeUnmount(() => {
  disposed = true;
  persistSession();
  window.removeEventListener("keydown", handleKeys, true);
  unlistenLsp?.();
  unlistenDisk?.();
  providers.forEach((item) => item.dispose());
  if (fileSearchTimer) clearTimeout(fileSearchTimer);
  if (textSearchTimer) clearTimeout(textSearchTimer);
  if (revealTimer) clearTimeout(revealTimer);
  for (const tab of tabs.value) { if (tab.changeTimer) clearTimeout(tab.changeTimer); tab.dispose?.dispose(); tab.model.dispose(); }
  editor?.dispose();
  if (disposed) window.__workbenchCanClose = undefined;
});
</script>

<template>
  <div class="editor-window" :class="{ 'editor-dark': dark }">
    <header class="editor-header">
      <div class="editor-project-title"><Icon name="code" :size="16" /><strong>{{ context?.projectName || '代码编辑器' }}</strong></div>
      <div class="editor-header-actions">
        <button title="打开项目文件（Ctrl+Shift+R）" @click="showFiles"><Icon name="file" :size="15" /></button>
        <button title="全项目搜索（Ctrl+Shift+F）" @click="showSearch"><Icon name="search" :size="15" /></button>
        <button title="保存当前文件（Ctrl+S）" :disabled="!current?.dirty" @click="current && saveTab(current)"><Icon name="save" :size="15" /></button>
      </div>
    </header>
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
        <div class="editor-tabs" role="tablist">
          <div v-for="tab in tabs" :key="tab.file" class="editor-tab" :class="{ active: tab.file === activeFile }"
            role="tab" :aria-selected="tab.file === activeFile" :title="tab.file" @click="openFile(tab.file)">
            <span v-if="tab.dirty" class="editor-dirty" title="未保存"></span>
            <Icon v-else name="file" :size="13" />
            <span class="editor-tab-name">{{ displayName(tab.file) }}</span>
            <span v-if="tab.stale" class="editor-stale" title="磁盘文件已变化">!</span>
            <CloseButton label="关闭文件" :size="11" @click.stop="closeTab(tab)" />
          </div>
        </div>
        <div class="editor-content">
          <div v-if="!current" class="editor-empty">从左侧选择文件，或按 Ctrl+Shift+R 搜索</div>
          <div ref="editorHost" class="editor-monaco"></div>
        </div>
        <section v-if="searchVisible" class="editor-search-panel">
          <div class="editor-search-bar"><Icon name="search" :size="15" />
            <input ref="searchInput" v-model="searchQuery" placeholder="搜索项目内容" aria-label="搜索项目内容"
              @input="updateTextSearch" @keydown.esc="searchVisible = false" />
            <span>{{ searching ? '搜索中…' : searchResults.length >= 500 ? '前 500 处' : searchResults.length ? `${searchResults.length} 处` : '' }}</span>
            <CloseButton label="关闭搜索" :size="13" @click="searchVisible = false" />
          </div>
          <div class="editor-search-results">
            <div v-for="group in searchGroups" :key="group.file" class="editor-search-group">
              <div class="editor-search-file" :title="group.file">{{ group.file }} <span>{{ group.hits.length }}</span></div>
              <button v-for="(hit, index) in group.hits" :key="`${hit.line}:${hit.column}:${index}`"
                class="editor-search-hit" :title="`${hit.file}:${hit.line}:${hit.column}`" @click="openSearchHit(hit)">
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
    <div v-if="paletteMode" class="editor-palette-backdrop" @mousedown.self="closePalette">
      <div class="editor-palette" role="dialog" :aria-label="paletteTitle">
        <div class="editor-palette-heading">{{ paletteTitle }} <CloseButton label="关闭" :size="13" @click="closePalette" /></div>
        <input ref="paletteInput" v-model="paletteQuery" :placeholder="paletteMode === 'files' ? '输入文件名或路径' : '筛选结果'"
          @input="paletteMode === 'files' ? updateFileSearch() : selectedResult = 0" @keydown="paletteKey" />
        <div ref="paletteList" class="editor-palette-list" @scroll="paletteScroll = ($event.target as HTMLElement).scrollTop">
          <div class="editor-palette-spacer" :style="{ height: `${paletteCount * paletteRowHeight}px` }">
          <template v-if="paletteMode === 'files'">
            <button v-for="(file, index) in paletteFiles" :key="file" :class="{ selected: paletteStart + index === selectedResult }"
              :style="{ top: `${(paletteStart + index) * paletteRowHeight}px`, height: `${paletteRowHeight}px` }"
              @mouseenter="selectedResult = paletteStart + index" @click="acceptPalette(paletteStart + index)">
              <Icon name="file" :size="14" /><span>{{ file }}</span>
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
  </div>
</template>

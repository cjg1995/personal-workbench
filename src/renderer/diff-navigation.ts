import { computed, ref } from "vue";
import type { CodeJumpTarget, CodeResolveResult } from "../shared/types";
import { monaco } from "./monaco";

export type DiffPaneSide = "original" | "modified" | "ours" | "result" | "theirs";

export interface DiffNavHistoryEntry {
  side: DiffPaneSide;
  line: number;
  column: number;
  scrollTop: number;
  symbol?: string;
}

export interface DiffNavTooltip {
  x: number;
  y: number;
  placement: "above" | "below";
  badge: string;
  sameFile: boolean;
  location: string;
  snippet: string;
  hint: string;
}

export interface DiffNavigationHost {
  getProjectId: () => string | undefined;
  getFile: () => string;
  isAllowLsp: (side: DiffPaneSide) => boolean;
  getEditorBySide: (side: DiffPaneSide) => monaco.editor.IStandaloneCodeEditor | undefined;
  revealInPane: (side: DiffPaneSide, position: monaco.IPosition, scrollTop?: number) => void;
  resolveApi: (payload: {
    projectId: string;
    file: string;
    text: string;
    line: number;
    column: number;
    kind: "definition" | "implementation";
    allowLsp: boolean;
  }) => Promise<CodeResolveResult>;
  openEditorApi: (payload: {
    projectId: string;
    file: string;
    uri?: string;
    line: number;
    column: number;
  }) => Promise<unknown>;
  notify: (text: string) => void;
}

const NON_NAVIGABLE_WORDS = new Set([
  "null", "true", "false", "this", "super", "void", "var", "let", "const",
  "if", "else", "for", "while", "do", "switch", "case", "default", "break",
  "continue", "return", "throw", "try", "catch", "finally", "new", "class",
  "interface", "enum", "extends", "implements", "public", "private", "protected",
  "static", "final", "abstract", "synchronized", "volatile", "transient", "native",
  "import", "package", "export", "from", "as", "async", "await", "function",
  "int", "long", "short", "byte", "char", "float", "double", "boolean",
]);

function isNavigableAt(model: monaco.editor.ITextModel, position: monaco.Position): { word: string; startColumn: number; endColumn: number } | null {
  const line = model.getLineContent(position.lineNumber);
  const lang = model.getLanguageId();
  const word = model.getWordAtPosition(position);
  if (!word || NON_NAVIGABLE_WORDS.has(word.word)) return null;
  if (!/^[A-Za-z_$][\w$]*$/.test(word.word)) return null;

  // Vue / HTML / JSP 模板事件处理器（如 @click="handleSave"）允许跳转
  if (lang === "vue" || lang === "html") {
    const pattern = /(?:@|v-on:|:)?[\w.:-]+\s*=\s*(["'])([^"']*)\1/g;
    let match: RegExpExecArray | null;
    const at = position.column - 1;
    while ((match = pattern.exec(line))) {
      const from = match.index;
      const to = match.index + match[0].length;
      if (at >= from && at <= to) return word;
    }
  }

  const row = monaco.editor.tokenize(line, lang)[0] || [];
  const offset = position.column - 1;
  let tokenType = "";
  for (let i = 0; i < row.length; i++) {
    const from = row[i].offset;
    const to = i + 1 < row.length ? row[i + 1].offset : Number.MAX_SAFE_INTEGER;
    if (offset >= from && offset < to) {
      tokenType = row[i].type;
      break;
    }
  }
  if (tokenType && (!/identifier|variable|attribute/i.test(tokenType) || /keyword|comment|string|number/i.test(tokenType))) {
    return null;
  }
  return word;
}

export function useDiffNavigation(host: DiffNavigationHost) {
  const ctrlLink = ref(false);
  const hoverTooltip = ref<DiffNavTooltip | null>(null);
  const picker = ref<{ open: boolean; symbol: string; targets: CodeJumpTarget[]; side: DiffPaneSide }>({
    open: false,
    symbol: "",
    targets: [],
    side: "modified",
  });
  const history = ref<DiffNavHistoryEntry[]>([]);
  const historyIndex = ref(-1);
  const pillDismissed = ref(false);
  const activeJumpLabel = ref("");

  const canGoBack = computed(() => historyIndex.value > 0);
  const canGoForward = computed(() => historyIndex.value >= 0 && historyIndex.value < history.value.length - 1);
  const backEntry = computed(() => (historyIndex.value > 0 ? history.value[historyIndex.value - 1] : null));
  const showReturnPill = computed(() => !pillDismissed.value && (canGoBack.value || canGoForward.value));

  let ctrlHeld = false;
  let hovered: { code: monaco.editor.IStandaloneCodeEditor; side: DiffPaneSide; position: monaco.Position } | null = null;
  let linkModel: monaco.editor.ITextModel | undefined;
  let linkIds: string[] = [];
  let highlightModel: monaco.editor.ITextModel | undefined;
  let highlightIds: string[] = [];
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverTimer: ReturnType<typeof setTimeout> | undefined;
  let hoverSeq = 0;
  let resolveSeq = 0;
  let lastHistoryAt = 0;
  const resolveCache = new Map<string, Promise<CodeResolveResult>>();

  function clearLinkDecoration() {
    if (linkModel && !linkModel.isDisposed()) linkModel.deltaDecorations(linkIds, []);
    linkModel = undefined;
    linkIds = [];
    ctrlLink.value = false;
  }

  function clearHoverTooltip() {
    hoverSeq++;
    if (hoverTimer) { clearTimeout(hoverTimer); hoverTimer = undefined; }
    hoverTooltip.value = null;
  }

  function clearCtrlHover() {
    clearLinkDecoration();
    clearHoverTooltip();
  }

  function clearHighlight() {
    if (highlightTimer) { clearTimeout(highlightTimer); highlightTimer = undefined; }
    if (highlightModel && !highlightModel.isDisposed()) highlightModel.deltaDecorations(highlightIds, []);
    highlightModel = undefined;
    highlightIds = [];
  }

  function resetForFile() {
    clearCtrlHover();
    clearHighlight();
    hovered = null;
    picker.value = { open: false, symbol: "", targets: [], side: "modified" };
    history.value = [];
    historyIndex.value = -1;
    pillDismissed.value = false;
    activeJumpLabel.value = "";
    resolveCache.clear();
  }

  function flashHighlight(code: monaco.editor.IStandaloneCodeEditor, line: number, column: number) {
    const model = code.getModel();
    if (!model || model.isDisposed()) return;
    clearHighlight();
    const safeLine = Math.max(1, Math.min(line, model.getLineCount()));
    const safeCol = Math.max(1, Math.min(column, model.getLineMaxColumn(safeLine)));
    highlightModel = model;
    highlightIds = model.deltaDecorations([], [{
      range: new monaco.Range(safeLine, safeCol, safeLine, Math.min(safeCol + 1, model.getLineMaxColumn(safeLine))),
      options: { isWholeLine: true, className: "diff-jump-highlight", zIndex: 25 },
    }]);
    highlightTimer = setTimeout(() => {
      if (highlightModel && !highlightModel.isDisposed()) highlightModel.deltaDecorations(highlightIds, []);
      highlightModel = undefined;
      highlightIds = [];
      highlightTimer = undefined;
    }, 2400);
  }

  function resolveCached(
    code: monaco.editor.IStandaloneCodeEditor,
    side: DiffPaneSide,
    position: monaco.Position,
    kind: "definition" | "implementation",
  ): Promise<CodeResolveResult> | null {
    const projectId = host.getProjectId();
    const file = host.getFile();
    const model = code.getModel();
    if (!projectId || !file || !model || model.isDisposed()) return null;
    const word = model.getWordAtPosition(position);
    const cacheKey = `${projectId}:${file}:${side}:${model.getVersionId()}:${position.lineNumber}:${word?.startColumn ?? position.column}:${kind}`;
    let pending = resolveCache.get(cacheKey);
    if (!pending) {
      if (resolveCache.size > 80) {
        const oldest = resolveCache.keys().next().value;
        if (oldest !== undefined) resolveCache.delete(oldest);
      }
      pending = host.resolveApi({
        projectId,
        file,
        text: model.getValue(),
        line: position.lineNumber,
        column: position.column,
        kind,
        allowLsp: host.isAllowLsp(side),
      });
      resolveCache.set(cacheKey, pending);
      pending.catch(() => resolveCache.delete(cacheKey));
    }
    return pending;
  }

  function tooltipCoords(code: monaco.editor.IStandaloneCodeEditor, position: monaco.Position) {
    const dom = code.getDomNode();
    const scrolled = code.getScrolledVisiblePosition(position);
    if (!dom || !scrolled) return null;
    const rect = dom.getBoundingClientRect();
    const x = Math.max(12, Math.min(window.innerWidth - 340, rect.left + scrolled.left));
    const anchorTop = rect.top + scrolled.top;
    const placeBelow = anchorTop < 88;
    const y = placeBelow ? anchorTop + scrolled.height + 6 : Math.max(8, anchorTop - 54);
    return { x, y, placement: placeBelow ? ("below" as const) : ("above" as const) };
  }

  function buildTooltip(
    code: monaco.editor.IStandaloneCodeEditor,
    position: monaco.Position,
    res: CodeResolveResult,
  ): DiffNavTooltip | null {
    if (!res.targets.length) return null;
    const coords = tooltipCoords(code, position);
    if (!coords) return null;
    if (res.targets.length === 1) {
      const target = res.targets[0];
      return {
        ...coords,
        sameFile: target.sameFile,
        badge: target.sameFile ? "本页" : "代码编辑器 ↗",
        location: target.sameFile ? `第 ${target.line} 行` : `${target.label}:${target.line}`,
        snippet: target.snippet,
        hint: target.sameFile ? "点击跳转" : "点击打开",
      };
    }
    const first = res.targets[0];
    const hasImpl = res.targets.some((item) => item.role === "implementation");
    const hasIface = res.targets.some((item) => item.role === "interface");
    const kindHint = hasImpl && hasIface ? "实现 / 接口" : `${res.targets.length} 处候选`;
    return {
      ...coords,
      sameFile: first.sameFile,
      badge: kindHint,
      location: `${first.label}:${first.line}`,
      snippet: first.snippet,
      hint: "点击选择",
    };
  }

  function updateCtrlHover() {
    if (!hovered) { clearCtrlHover(); return; }
    const { code, side, position } = hovered;
    const model = code.getModel();
    if (!model || model.isDisposed()) { clearCtrlHover(); return; }
    const word = isNavigableAt(model, position);
    if (!word) { clearCtrlHover(); return; }

    if (linkModel && linkModel !== model) clearLinkDecoration();
    linkModel = model;
    linkIds = model.deltaDecorations(linkIds, [{
      range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
      options: { inlineClassName: "idea-ctrl-link" },
    }]);
    ctrlLink.value = true;

    const seq = ++hoverSeq;
    if (hoverTimer) clearTimeout(hoverTimer);
    hoverTimer = setTimeout(() => {
      hoverTimer = undefined;
      if (!ctrlHeld || seq !== hoverSeq || !hovered) return;
      const pending = resolveCached(code, side, position, "definition");
      if (!pending) return;
      void pending.then((res) => {
        if (!ctrlHeld || seq !== hoverSeq || !hovered) return;
        hoverTooltip.value = buildTooltip(code, position, res);
      }).catch(() => {});
    }, 130);
  }

  async function jumpToTarget(target: CodeJumpTarget, side: DiffPaneSide, symbol: string) {
    picker.value = { open: false, symbol: "", targets: [], side };
    clearCtrlHover();
    if (target.sameFile) {
      const code = host.getEditorBySide(side);
      const currentPos = code?.getPosition();
      const sourceEntry: DiffNavHistoryEntry = {
        side,
        line: currentPos?.lineNumber || 1,
        column: currentPos?.column || 1,
        scrollTop: code?.getScrollTop() || 0,
      };
      const base = historyIndex.value >= 0 ? history.value.slice(0, historyIndex.value + 1) : [];
      const prev = base[base.length - 1];
      if (!prev || prev.side !== sourceEntry.side || prev.line !== sourceEntry.line) {
        base.push(sourceEntry);
      }
      base.push({ side, line: target.line, column: target.column, scrollTop: -1, symbol });
      if (base.length > 80) base.splice(0, base.length - 80);
      history.value = base;
      historyIndex.value = base.length - 1;
      pillDismissed.value = false;
      activeJumpLabel.value = symbol ? `${symbol} :${target.line}` : `第 ${target.line} 行`;

      host.revealInPane(side, { lineNumber: target.line, column: target.column });
      const targetCode = host.getEditorBySide(side);
      if (targetCode) flashHighlight(targetCode, target.line, target.column);
      host.notify(`已跳转到本页第 ${target.line} 行${symbol ? ` · ${symbol}` : ""}`);
      return;
    }

    const projectId = host.getProjectId();
    if (!projectId) return;
    try {
      await host.openEditorApi({
        projectId,
        file: target.file,
        uri: target.uri,
        line: target.line,
        column: target.column,
      });
      host.notify(`已在代码编辑器打开 ${target.label}:${target.line}`);
    } catch (error) {
      host.notify(error instanceof Error ? error.message : String(error));
    }
  }

  async function triggerNavigation(
    code: monaco.editor.IStandaloneCodeEditor,
    side: DiffPaneSide,
    position?: monaco.Position | null,
    kind: "definition" | "implementation" = "definition",
  ) {
    const model = code.getModel();
    const at = position || code.getPosition();
    if (!model || !at) return;
    clearHoverTooltip();
    const seq = ++resolveSeq;
    const pending = resolveCached(code, side, at, kind);
    if (!pending) return;
    try {
      const res = await pending;
      if (seq !== resolveSeq) return;
      if (!res.targets.length) {
        if (res.notice) host.notify(res.notice);
        else if (res.symbol) host.notify(`未找到 ${res.symbol} 的定义`);
        return;
      }
      if (res.targets.length === 1) {
        await jumpToTarget(res.targets[0], side, res.symbol);
        return;
      }
      picker.value = { open: true, symbol: res.symbol, targets: res.targets, side };
    } catch (error) {
      if (seq === resolveSeq) host.notify(error instanceof Error ? error.message : String(error));
    }
  }

  async function openCurrentInEditor(code?: monaco.editor.IStandaloneCodeEditor | null) {
    const projectId = host.getProjectId();
    const file = host.getFile();
    if (!projectId || !file) return;
    const pos = code?.getPosition();
    const line = pos?.lineNumber || 1;
    const column = pos?.column || 1;
    try {
      await host.openEditorApi({ projectId, file, line, column });
      const baseName = file.split(/[\\/]/).pop() || file;
      host.notify(`已在代码编辑器打开 ${baseName}:${line}`);
    } catch (error) {
      host.notify(error instanceof Error ? error.message : String(error));
    }
  }

  function stepHistory(direction: -1 | 1) {
    const now = Date.now();
    if (now - lastHistoryAt < 60) return;
    lastHistoryAt = now;
    const next = historyIndex.value + direction;
    if (next < 0 || next >= history.value.length) return;
    // Save current position/scrollTop before stepping back/forward
    const currentEntry = history.value[historyIndex.value];
    const currentCode = currentEntry ? host.getEditorBySide(currentEntry.side) : undefined;
    if (currentEntry && currentCode) {
      const pos = currentCode.getPosition();
      if (pos) {
        currentEntry.line = pos.lineNumber;
        currentEntry.column = pos.column;
      }
      currentEntry.scrollTop = currentCode.getScrollTop();
    }
    historyIndex.value = next;
    const entry = history.value[next];
    pillDismissed.value = false;
    activeJumpLabel.value = entry.symbol ? `${entry.symbol} :${entry.line}` : `第 ${entry.line} 行`;
    host.revealInPane(
      entry.side,
      { lineNumber: entry.line, column: entry.column },
      entry.scrollTop >= 0 ? entry.scrollTop : undefined,
    );
    const targetCode = host.getEditorBySide(entry.side);
    if (targetCode) flashHighlight(targetCode, entry.line, entry.column);
    host.notify(direction < 0 ? `已返回第 ${entry.line} 行` : `已前进到第 ${entry.line} 行`);
  }

  function bindEditor(code: monaco.editor.IStandaloneCodeEditor, side: DiffPaneSide): monaco.IDisposable[] {
    const disposables: monaco.IDisposable[] = [];
    disposables.push(code.onMouseMove((event) => {
      if (event.target.type === monaco.editor.MouseTargetType.CONTENT_TEXT && event.target.position) {
        const same = hovered && hovered.code === code && hovered.position.equals(event.target.position);
        hovered = { code, side, position: event.target.position };
        if (ctrlHeld || event.event.ctrlKey) {
          ctrlHeld = true;
          if (!same || !ctrlLink.value) updateCtrlHover();
        } else if (ctrlLink.value) {
          clearCtrlHover();
        }
      } else {
        if (hovered?.code === code) hovered = null;
        if (ctrlLink.value || hoverTooltip.value) clearCtrlHover();
      }
    }));
    disposables.push(code.onMouseLeave(() => {
      if (hovered?.code === code) hovered = null;
      clearCtrlHover();
    }));
    disposables.push(code.onDidScrollChange(() => {
      clearHoverTooltip();
    }));
    disposables.push(code.onMouseDown((event) => {
      if (!event.event.leftButton || !event.event.ctrlKey || event.event.altKey) return;
      if (event.target.type !== monaco.editor.MouseTargetType.CONTENT_TEXT || !event.target.position) return;
      const model = code.getModel();
      if (!model || !isNavigableAt(model, event.target.position)) return;
      event.event.preventDefault();
      event.event.stopPropagation();
      void triggerNavigation(code, side, event.target.position, event.event.shiftKey ? "implementation" : "definition");
    }));
    disposables.push(code.addAction({
      id: "workbench.diff.goto-definition",
      label: "转到定义（本页跳转 / 跨页打开编辑器）",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0.1,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyB, monaco.KeyCode.F12],
      run: () => void triggerNavigation(code, side, code.getPosition(), "definition"),
    }));
    disposables.push(code.addAction({
      id: "workbench.diff.goto-implementation",
      label: "转到实现（Java 接口 / 父类）",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0.2,
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Alt | monaco.KeyCode.KeyB],
      run: () => void triggerNavigation(code, side, code.getPosition(), "implementation"),
    }));
    disposables.push(code.addAction({
      id: "workbench.diff.open-in-editor",
      label: "在代码编辑器中打开此处",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 0.3,
      run: () => void openCurrentInEditor(code),
    }));
    return disposables;
  }

  function onKeyDown(event: KeyboardEvent) {
    if (event.key === "Control" && !event.repeat) {
      ctrlHeld = true;
      if (hovered) updateCtrlHover();
      return false;
    }
    if (event.altKey && !event.ctrlKey && !event.metaKey && !event.shiftKey) {
      if (event.key === "ArrowLeft" && canGoBack.value) {
        event.preventDefault();
        stepHistory(-1);
        return true;
      }
      if (event.key === "ArrowRight" && canGoForward.value) {
        event.preventDefault();
        stepHistory(1);
        return true;
      }
    }
    return false;
  }

  function onKeyUp(event: KeyboardEvent) {
    if (event.key === "Control" || event.key === "Meta") {
      ctrlHeld = false;
      clearCtrlHover();
    }
  }

  function onBlur() {
    ctrlHeld = false;
    clearCtrlHover();
  }

  function onMouseUp(event: MouseEvent) {
    if (event.button === 3 && canGoBack.value) stepHistory(-1);
    else if (event.button === 4 && canGoForward.value) stepHistory(1);
  }

  function closePicker() {
    const side = picker.value.side;
    picker.value = { open: false, symbol: "", targets: [], side };
    host.getEditorBySide(side)?.focus();
  }

  function pickTarget(target: CodeJumpTarget) {
    void jumpToTarget(target, picker.value.side, picker.value.symbol);
  }

  function dismissPill() {
    pillDismissed.value = true;
  }

  function dispose() {
    clearCtrlHover();
    clearHighlight();
    resolveCache.clear();
  }

  return {
    ctrlLink,
    hoverTooltip,
    picker,
    canGoBack,
    canGoForward,
    backEntry,
    activeJumpLabel,
    showReturnPill,
    bindEditor,
    triggerNavigation,
    openCurrentInEditor,
    stepHistory,
    closePicker,
    pickTarget,
    dismissPill,
    resetForFile,
    onKeyDown,
    onKeyUp,
    onBlur,
    onMouseUp,
    dispose,
  };
}

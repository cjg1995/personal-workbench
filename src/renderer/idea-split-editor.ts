import { monaco } from "./monaco";
import DiffWorker from "./idea-diff.worker.js?worker&inline";
import type { Inclusion } from "./diff-inclusion";

type Code = monaco.editor.IStandaloneCodeEditor;
type Change = monaco.editor.ILineChange;
type Side = "original" | "modified";
export type Whitespace = "all" | "trim" | "ignore";
export type DiffAction = "revert" | "append";
const sides: Side[] = ["original", "modified"];
const svgNamespace = "http://www.w3.org/2000/svg";
const emptyRuleHeight = 2;

function div(className: string) {
  const node = document.createElement("div");
  node.className = className;
  return node;
}

// Monaco encodes an empty side as the line BEFORE the insertion and an end of zero.
function lines(change: Change, side: Side): [number, number] {
  const start = change[`${side}StartLineNumber`], end = change[`${side}EndLineNumber`];
  return end ? [start, end + 1] : [start + 1, start + 1];
}

function lineTop(code: Code, line: number) {
  const last = code.getModel()!.getLineCount();
  return line > last ? code.getBottomForLineNumber(last) : code.getTopForLineNumber(line, true);
}

function extent(change: Change, code: Code, side: Side): [number, number] {
  const [first, end] = lines(change, side);
  const top = lineTop(code, first);
  return [top, first === end ? top : code.getBottomForLineNumber(end - 1)];
}

function ribbonEdge(top: number, bottom: number, afterLastLine: boolean): [number, number] {
  if (top !== bottom) return [top, bottom];
  // The editor paints the marker inside the next line, or inside the last line at EOF.
  return afterLastLine ? [top - emptyRuleHeight, top] : [top, top + emptyRuleHeight];
}

function hasChangedLines(model: monaco.editor.ITextModel, start: number, end: number) {
  return end > 0 && (start < model.getLineCount() || model.getLineLength(start) > 0);
}

export class IdeaSplitEditor {
  private root = div("monaco-diff-editor idea-split-view");
  private gutter = div("idea-diff-gutter");
  private ribbons = document.createElementNS(svgNamespace, "svg");
  private numbers = { original: div("idea-original-gutter"), modified: div("idea-modified-gutter") };
  private actions = div("idea-gutter-actions");
  private codes: Record<Side, Code>;
  private decorations: Record<Side, monaco.editor.IEditorDecorationsCollection>;
  private listeners: monaco.IDisposable[] = [];
  private updated = new monaco.Emitter<void>();
  readonly onDidUpdateDiff = this.updated.event;
  private worker = new DiffWorker();
  private model: monaco.editor.IDiffEditorModel | null = null;
  private changes: Change[] | null = null;
  private whitespace: Whitespace = "ignore";
  private highlight = "words";
  private revertState: "hidden" | "enabled" | "disabled" = "hidden";
  private appendMode = false;
  private modifierEvents = new AbortController();
  private inclusions = new Map<number, Inclusion>();
  private fileIncluded: boolean | "mixed" | null = null;
  private canInclude = false;
  private folded = false;
  private expanded = new Set<number>();
  private zones: Record<Side, string[]> = { original: [], modified: [] };
  private syncing = false;
  private request = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private frame = 0;
  private sashFraction = 0.5;
  private resize: ResizeObserver;

  constructor(
    host: HTMLElement,
    options: monaco.editor.IEditorOptions,
    private applyChange: (index: number, action: DiffAction) => void,
    private include: (index: number) => void,
  ) {
    const original = div("editor original"), modified = div("editor modified");
    const sash = div("idea-diff-sash");
    sash.setAttribute("role", "separator");
    sash.setAttribute("aria-label", "调整对比栏宽度");
    sash.setAttribute("aria-orientation", "vertical");
    sash.tabIndex = 0;
    this.root.style.setProperty("--idea-empty-rule-height", emptyRuleHeight + "px");
    this.ribbons.setAttribute("aria-hidden", "true");
    this.gutter.append(this.ribbons, this.numbers.original, this.numbers.modified, this.actions);
    const trackControl = (event: KeyboardEvent | PointerEvent) => this.setAppendMode(event.ctrlKey);
    const signal = this.modifierEvents.signal;
    window.addEventListener("keydown", trackControl, { capture: true, signal });
    window.addEventListener("keyup", trackControl, { capture: true, signal });
    window.addEventListener("blur", () => this.setAppendMode(false), { signal });
    this.actions.addEventListener("pointerover", trackControl, { signal });
    this.root.append(original, this.gutter, modified, sash);
    host.append(this.root);
    this.codes = {
      original: monaco.editor.create(original, { ...options, model: null }),
      modified: monaco.editor.create(modified, { ...options, model: null }),
    };
    this.decorations = {
      original: this.codes.original.createDecorationsCollection(),
      modified: this.codes.modified.createDecorationsCollection(),
    };
    this.updateOptions(options);
    for (const side of sides) {
      const code = this.codes[side];
      this.listeners.push(code.onDidScrollChange(event => {
        if (event.scrollTopChanged && !this.syncing && this.model) this.syncScroll(side);
        this.drawSoon();
      }), code.onDidLayoutChange(() => this.drawSoon()), code.onDidContentSizeChange(() => this.drawSoon()),
      code.onDidChangeHiddenAreas(() => this.drawSoon()));
    }
    this.listeners.push(this.codes.modified.onDidChangeModelContent(() => this.compute(90)));
    this.worker.onmessage = ({ data }: MessageEvent<{ id: number; changes: Change[] }>) => {
      if (data.id !== this.request || !this.model) return;
      this.changes = data.changes;
      this.decorate();
      this.foldContext();
      this.updated.fire();
      this.drawSoon();
    };
    const move = (clientX: number) => {
      const box = this.root.getBoundingClientRect(), width = this.gutter.offsetWidth;
      this.resizePanes((clientX - box.left - width / 2) / Math.max(1, box.width - width));
    };
    sash.onpointerdown = event => { if (event.button === 0) sash.setPointerCapture(event.pointerId); };
    sash.onpointermove = event => { if (sash.hasPointerCapture(event.pointerId)) move(event.clientX); };
    sash.ondblclick = () => this.resizePanes(0.5);
    sash.onkeydown = event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      this.resizePanes(this.sashFraction + (event.key === "ArrowLeft" ? -0.025 : 0.025));
    };
    this.resize = new ResizeObserver(() => this.drawSoon());
    this.resize.observe(this.root);
  }

  getOriginalEditor() { return this.codes.original; }
  getModifiedEditor() { return this.codes.modified; }
  getLineChanges() { return this.changes; }

  setModel(model: monaco.editor.IDiffEditorModel | null) {
    this.model = model;
    this.expanded.clear();
    this.changes = null;
    for (const side of sides) {
      this.codes[side].setModel(model?.[side] ?? null);
      this.zones[side] = [];
    }
    this.compute(0);
    this.drawSoon();
  }

  updateOptions(options: monaco.editor.IDiffEditorOptions) {
    for (const side of sides) this.codes[side].updateOptions({
      ...options, readOnly: side === "original" || options.readOnly,
      lineNumbers: "off", glyphMargin: false, folding: true, showFoldingControls: "never",
      lineDecorationsWidth: side === "original" ? 9 : 2,
      guides: { indentation: false, highlightActiveIndentation: false, bracketPairs: false },
      renderLineHighlight: "none", overviewRulerLanes: 0, overviewRulerBorder: false,
      scrollbar: { vertical: "hidden", verticalScrollbarSize: side === "original" ? 0 : 14,
        horizontal: "auto", horizontalScrollbarSize: 10, useShadows: false },
    });
    const fold = !!options.hideUnchangedRegions?.enabled;
    if (this.folded !== fold) { this.folded = fold; this.expanded.clear(); this.foldContext(); }
    this.drawSoon();
  }

  configure(whitespace: Whitespace, highlight: string) {
    if (this.whitespace !== whitespace) {
      this.whitespace = whitespace;
      this.compute(0);
    }
    if (this.highlight !== highlight) {
      this.highlight = highlight;
      this.decorate();
      this.drawSoon();
    }
  }

  setRevertState(state: typeof this.revertState) {
    if (this.revertState === state) return;
    this.revertState = state;
    this.drawSoon();
  }

  private setAppendMode(held: boolean) {
    if (this.appendMode === held) return;
    this.appendMode = held;
    this.actions.classList.toggle("diff-append-mode", held);
    this.actions.querySelectorAll<HTMLButtonElement>(".git-revert-appendable")
      .forEach(button => this.updateActionTitle(button, true));
  }

  private updateActionTitle(button: HTMLButtonElement, appendable: boolean) {
    const number = button.dataset.difference;
    if (appendable && this.appendMode) {
      button.title = `追加第 ${number} 处左侧代码到右侧（Ctrl+Z 撤销）`;
    } else {
      const hint = appendable ? "按住 Ctrl 切换为追加，Ctrl+Z 撤销" : "Ctrl+Z 撤销";
      button.title = `Revert 第 ${number} 处差异（${hint}）`;
    }
  }

  setInclusions(chunks: Map<number, Inclusion>, file: typeof this.fileIncluded, enabled: boolean) {
    this.inclusions = chunks;
    this.fileIncluded = file;
    this.canInclude = enabled;
    this.drawSoon();
  }

  private compute(delay: number) {
    const id = ++this.request;
    clearTimeout(this.timer);
    this.changes = null;
    this.actions.replaceChildren();
    if (!this.model) return;
    this.timer = setTimeout(() => {
      if (!this.model || this.request !== id) return;
      const content = (side: Side) => this.model![side].getValueLength() ? this.model![side].getLinesContent() : [];
      this.worker.postMessage({ id, original: content("original"), modified: content("modified"), whitespace: this.whitespace });
    }, delay);
  }

  private decorate() {
    if (!this.model || !this.changes) return;
    for (const side of sides) {
      const list: monaco.editor.IModelDeltaDecoration[] = [];
      for (const change of this.highlight === "none" ? [] : this.changes) {
        const [start, end] = lines(change, side);
        const kind = !change.originalEndLineNumber ? "added" : !change.modifiedEndLineNumber ? "deleted" : "changed";
        const last = this.model[side].getLineCount();
        const name = start === end ? `idea-empty-${kind} ${start > last ? "after" : "before"}` : `idea-${kind}-line`;
        list.push({ range: new monaco.Range(Math.min(start, last), 1, Math.min(Math.max(start, end - 1), last), 1),
          options: { isWholeLine: true, className: name, marginClassName: side === "modified" ? name : undefined, zIndex: 1 } });
        if (this.highlight !== "words") continue;
        for (const word of change.charChanges || []) {
          const range = (s: Side) => new monaco.Range(word[`${s}StartLineNumber`], word[`${s}StartColumn`],
            word[`${s}EndLineNumber`], word[`${s}EndColumn`]);
          const current = range(side);
          if (current.isEmpty()) continue;
          const only = range(side === "original" ? "modified" : "original").isEmpty();
          const color = only ? (side === "original" ? "deleted" : "added") : "changed";
          list.push({ range: current, options: { className: `idea-${color}-word`, shouldFillLineOnLineBreak: true, zIndex: 5 } });
        }
      }
      this.decorations[side].set(list);
    }
  }

  private foldContext() {
    if (!this.model || !this.changes) return;
    const hidden: Record<Side, monaco.Range[]> = { original: [], modified: [] };
    let old = 1, next = 1;
    const gap = (a: number, b: number) => {
      const length = Math.min(a - old, b - next) - 6;
      if (!this.folded || length < 8 || this.expanded.has(old + 3)) return;
      hidden.original.push(new monaco.Range(old + 3, 1, old + 2 + length, 1));
      hidden.modified.push(new monaco.Range(next + 3, 1, next + 2 + length, 1));
    };
    for (const change of this.changes) {
      const a = lines(change, "original"), b = lines(change, "modified");
      gap(a[0], b[0]); old = a[1]; next = b[1];
    }
    gap(this.model.original.getLineCount() + 1, this.model.modified.getLineCount() + 1);
    for (const side of sides) {
      const code = this.codes[side] as Code & { setHiddenAreas(ranges: monaco.Range[], owner: unknown): void };
      code.setHiddenAreas(hidden[side], this);
      code.changeViewZones(access => {
        this.zones[side].forEach(id => access.removeZone(id));
        this.zones[side] = hidden[side].map((range, i) => {
          const button = document.createElement("button");
          button.className = "idea-expand-context";
          button.textContent = `展开 ${range.endLineNumber - range.startLineNumber + 1} 行未修改代码`;
          button.onclick = () => { this.expanded.add(hidden.original[i].startLineNumber); this.foldContext(); this.drawSoon(); };
          return access.addZone({ afterLineNumber: range.startLineNumber - 1, heightInLines: 1, domNode: button });
        });
      });
    }
  }

  private resizePanes(fraction: number) {
    this.sashFraction = Math.min(0.82, Math.max(0.18, fraction));
    this.root.style.gridTemplateColumns = `minmax(0,${this.sashFraction}fr) var(--idea-gutter-width) minmax(0,${1 - this.sashFraction}fr)`;
  }

  revealChange(change: Change) {
    this.syncing = true;
    try {
      for (const side of sides) {
        const code = this.codes[side], top = lineTop(code, lines(change, side)[0]);
        code.setScrollTop(top - Math.floor(code.getLayoutInfo().height / 3));
      }
    } finally { this.syncing = false; }
    this.drawSoon();
  }

  private firstChangeAt(side: Side, y: number) {
    const changes = this.changes || [];
    let lo = 0, hi = changes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (extent(changes[mid], this.codes[side], side)[1] < y) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  private syncScroll(side: Side) {
    const other = side === "original" ? "modified" : "original";
    const source = this.codes[side], target = this.codes[other];
    const top = source.getScrollTop(), half = source.getLayoutInfo().height / 2;
    const center = top + half, max = source.getScrollHeight() - 2 * half;
    const targetMax = Math.max(0, target.getScrollHeight() - target.getLayoutInfo().height);
    let dest = 0;
    if (top > 0 && top >= max - 1) dest = targetMax;
    else if (top > 0) {
      let a = 0, b = 0, endA = source.getScrollHeight(), endB = target.getScrollHeight();
      const index = this.firstChangeAt(side, center), previous = this.changes?.[index - 1], current = this.changes?.[index];
      if (previous) { a = extent(previous, source, side)[1]; b = extent(previous, target, other)[1]; }
      if (current) {
        const from = extent(current, source, side), to = extent(current, target, other);
        if (center <= from[0]) { endA = from[0]; endB = to[0]; }
        else { [a, endA] = from; [b, endB] = to; }
      }
      dest = b + (center - a) / Math.max(1, endA - a) * (endB - b) - half;
    }
    this.syncing = true;
    try { target.setScrollTop(Math.max(0, Math.min(dest, targetMax))); }
    finally { this.syncing = false; }
  }

  private drawSoon() {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }

  private draw() {
    const width = this.gutter.clientWidth, height = this.gutter.clientHeight;
    const ribbonBox = this.ribbons.getBoundingClientRect();
    const scale = window.devicePixelRatio;
    // Monaco's line backgrounds snap to device pixels. Match them at both ends of the ribbon.
    const snapY = (y: number) => Math.round((ribbonBox.top + y) * scale) / scale - ribbonBox.top;
    this.root.style.setProperty("--idea-sash-x", this.gutter.offsetLeft + width / 2 + "px");
    this.root.closest<HTMLElement>(".diff-main")?.style.setProperty("--idea-divider", this.gutter.offsetLeft + width / 2 + "px");
    const ribbons = document.createDocumentFragment(), actions = document.createDocumentFragment();
    for (const side of sides) {
      const code = this.codes[side], nodes = document.createDocumentFragment(), scroll = code.getScrollTop();
      const lineHeight = code.getOption(monaco.editor.EditorOption.lineHeight);
      this.numbers[side].style.lineHeight = lineHeight + "px";
      for (const range of code.getVisibleRanges()) {
        for (let n = range.startLineNumber; n <= range.endLineNumber; n++) {
          const number = document.createElement("span");
          number.textContent = String(n);
          number.style.top = code.getTopForLineNumber(n, true) - scroll + "px";
          nodes.append(number);
        }
      }
      this.numbers[side].replaceChildren(nodes);
    }
    const curveStart = ribbonBox.width / 2 - 10, curveEnd = ribbonBox.width / 2 + 10;
    const first = Math.min(...sides.map(side => this.firstChangeAt(side, this.codes[side].getScrollTop() - emptyRuleHeight)));
    const changes = this.changes || [];
    for (let index = first; index < changes.length; index++) {
      const change = changes[index];
      const [a, b] = extent(change, this.codes.original, "original").map(y => y - this.codes.original.getScrollTop());
      const [c, d] = extent(change, this.codes.modified, "modified").map(y => y - this.codes.modified.getScrollTop());
      if (Math.min(a, c) > height + emptyRuleHeight) break;
      if (this.highlight !== "none") {
        const kind = !change.originalEndLineNumber ? "added" : !change.modifiedEndLineNumber ? "deleted" : "changed";
        const ribbon = document.createElementNS(svgNamespace, "path");
        ribbon.setAttribute("class", `idea-ribbon-${kind}`);
        const [leftTop, leftBottom] = ribbonEdge(a, b, change.originalStartLineNumber >= this.model!.original.getLineCount()).map(snapY);
        const [rightTop, rightBottom] = ribbonEdge(c, d, change.modifiedStartLineNumber >= this.model!.modified.getLineCount()).map(snapY);
        ribbon.setAttribute("d", [
          `M0 ${leftTop} H${curveStart}`,
          `C${curveStart + 5} ${leftTop} ${curveEnd - 5} ${rightTop} ${curveEnd} ${rightTop}`,
          `H${ribbonBox.width} V${rightBottom} H${curveEnd}`,
          `C${curveEnd - 5} ${rightBottom} ${curveStart + 5} ${leftBottom} ${curveStart} ${leftBottom} H0 Z`,
        ].join(" "));
        ribbons.append(ribbon);
      }
      if (this.revertState !== "hidden" && a >= -20 && a < height) {
        const button = document.createElement("button");
        const appendable = this.revertState === "enabled" &&
          hasChangedLines(this.model!.original, change.originalStartLineNumber, change.originalEndLineNumber) &&
          hasChangedLines(this.model!.modified, change.modifiedStartLineNumber, change.modifiedEndLineNumber);
        button.type = "button";
        button.className = "git-revert-glyph" + (this.revertState === "disabled" ? " git-revert-disabled" : "");
        button.classList.toggle("git-revert-appendable", appendable);
        button.disabled = this.revertState === "disabled";
        button.dataset.difference = String(index + 1);
        this.updateActionTitle(button, appendable);
        button.style.top = a + "px";
        button.onclick = (event) => this.applyChange(index, appendable && event.ctrlKey ? "append" : "revert");
        actions.append(button);
      }
      if (this.fileIncluded !== null && c >= -20 && c < height) {
        const part = this.inclusions.get(index), input = document.createElement("input");
        input.type = "checkbox";
        input.className = "idea-include-change";
        input.checked = part?.included ?? this.fileIncluded === true;
        input.indeterminate = !part && this.fileIncluded === "mixed";
        input.disabled = !this.canInclude || !part;
        input.title = part ? `${part.included ? "移出" : "纳入"}提交 · 第 ${index + 1} 处差异` : "此处无法独立暂存，可在 Git 操作中查看完整差异块";
        input.setAttribute("aria-label", input.title);
        input.style.top = (c + (this.codes.modified.getOption(monaco.editor.EditorOption.lineHeight) - 14) / 2) + "px";
        input.onclick = event => { event.preventDefault(); this.include(index); };
        actions.append(input);
      }
    }
    this.ribbons.replaceChildren(ribbons);
    this.actions.replaceChildren(actions);
  }

  dispose() {
    this.modifierEvents.abort();
    clearTimeout(this.timer);
    this.worker.terminate();
    this.resize.disconnect();
    this.listeners.forEach(listener => listener.dispose());
    this.updated.dispose();
    for (const side of sides) this.codes[side].dispose();
    cancelAnimationFrame(this.frame);
    this.root.remove();
  }
}

import type { editor, IDisposable } from "monaco-editor/editor/editor.api";

/** An outer-edge scrollbar, backed by the editor's real scroll position. */
export class DiffScrollbar implements IDisposable {
  private root = document.createElement("div");
  private marks = document.createElement("div");
  private thumb = document.createElement("div");
  private listeners: IDisposable[] = [];
  private changes: editor.ILineChange[] = [];
  private visible = true;
  private drag: { pointer: number; y: number; top: number } | undefined;
  private trackHeight = 0;
  private thumbHeight = 0;
  private maximum = 0;

  constructor(private code: editor.IStandaloneCodeEditor, private side: "original" | "modified") {
    this.root.className = `idea-outer-scrollbar idea-scrollbar-${side}`;
    this.root.setAttribute("role", "scrollbar");
    this.root.setAttribute("aria-label", side === "original" ? "原始代码垂直滚动条" : "工作区代码垂直滚动条");
    this.root.setAttribute("aria-orientation", "vertical");
    this.root.setAttribute("aria-valuemin", "0");
    this.root.tabIndex = 0;
    this.marks.className = "idea-scrollbar-marks";
    this.thumb.className = "idea-scrollbar-thumb";
    this.root.append(this.marks, this.thumb);
    // The container survives setModel(null) and file switches; the view DOM does not.
    const node = code.getContainerDomNode();
    if (!node.id) node.id = `idea-${side}-code`;
    this.root.setAttribute("aria-controls", node.id);
    node.append(this.root);
    this.listen("pointerdown", (event) => this.pointerDown(event as PointerEvent));
    this.listen("pointermove", (event) => this.pointerMove(event as PointerEvent));
    this.listen("pointerup", () => { this.drag = undefined; });
    this.listen("pointercancel", () => { this.drag = undefined; });
    this.listen("lostpointercapture", () => { this.drag = undefined; });
    this.listen("keydown", (event) => this.key(event as KeyboardEvent));
    this.listen("wheel", (event) => {
      const wheel = event as WheelEvent;
      wheel.preventDefault();
      wheel.stopPropagation();
      const delta = wheel.deltaY * (wheel.deltaMode === 1 ? 22 : wheel.deltaMode === 2 ? this.trackHeight : 1);
      code.setScrollTop(code.getScrollTop() + delta);
    });
    this.listeners.push(code.onDidScrollChange(() => this.render()));
    this.listeners.push(code.onDidLayoutChange(() => this.render()));
    this.listeners.push(code.onDidContentSizeChange(() => this.render()));
    this.listeners.push(code.onDidChangeModel(() => this.render()));
    this.render();
  }

  private listen(name: string, handler: EventListener) {
    this.root.addEventListener(name, handler, { passive: false });
    this.listeners.push({ dispose: () => this.root.removeEventListener(name, handler) });
  }

  setVisible(visible: boolean) { this.visible = visible; this.render(); }
  setChanges(changes: editor.ILineChange[]) { this.changes = changes; this.render(); }

  private render() {
    const model = this.code.getModel();
    this.root.hidden = !this.visible || !model;
    if (!model) return;
    const layout = this.code.getLayoutInfo(), height = this.code.getScrollHeight();
    this.trackHeight = Math.max(0, layout.height - layout.horizontalScrollbarHeight);
    this.maximum = Math.max(0, height - layout.height);
    this.thumbHeight = Math.min(this.trackHeight, Math.max(24, this.trackHeight * layout.height / Math.max(1, height)));
    this.root.style.height = this.trackHeight + "px";
    this.root.setAttribute("aria-valuemax", String(this.maximum));
    this.root.setAttribute("aria-valuenow", String(Math.round(this.code.getScrollTop())));
    this.root.setAttribute("aria-disabled", String(this.maximum === 0));
    this.thumb.hidden = this.maximum === 0;
    this.thumb.style.height = this.thumbHeight + "px";
    this.thumb.style.top = this.maximum ? (this.trackHeight - this.thumbHeight) * this.code.getScrollTop() / this.maximum + "px" : "0px";
    const fragment = document.createDocumentFragment();
    for (const change of this.changes) {
      const start = this.side === "original" ? change.originalStartLineNumber : change.modifiedStartLineNumber;
      const end = this.side === "original" ? change.originalEndLineNumber : change.modifiedEndLineNumber;
      const first = Math.max(1, Math.min(model.getLineCount(), end ? start : start + 1));
      const last = Math.max(first, Math.min(model.getLineCount(), end || first));
      const top = this.code.getTopForLineNumber(first), bottom = this.code.getBottomForLineNumber(last);
      const mark = document.createElement("div");
      mark.className = "idea-scrollbar-change " + (!change.originalEndLineNumber ? "added" : !change.modifiedEndLineNumber ? "removed" : "changed");
      mark.style.top = Math.max(0, Math.min(this.trackHeight - 2, top / Math.max(1, height) * this.trackHeight)) + "px";
      mark.style.height = Math.max(2, (bottom - top) / Math.max(1, height) * this.trackHeight) + "px";
      fragment.append(mark);
    }
    this.marks.replaceChildren(fragment);
  }

  private pointerDown(event: PointerEvent) {
    if (event.button !== 0 || this.maximum === 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.root.focus({ preventScroll: true });
    const y = event.clientY - this.root.getBoundingClientRect().top;
    if (event.target !== this.thumb) {
      const fraction = (y - this.thumbHeight / 2) / Math.max(1, this.trackHeight - this.thumbHeight);
      this.code.setScrollTop(Math.max(0, Math.min(1, fraction)) * this.maximum);
    }
    this.drag = { pointer: event.pointerId, y: event.clientY, top: this.code.getScrollTop() };
    this.root.setPointerCapture(event.pointerId);
  }

  private pointerMove(event: PointerEvent) {
    if (this.drag?.pointer !== event.pointerId) return;
    event.preventDefault();
    const distance = event.clientY - this.drag.y;
    this.code.setScrollTop(this.drag.top + distance / Math.max(1, this.trackHeight - this.thumbHeight) * this.maximum);
  }

  private key(event: KeyboardEvent) {
    const top = this.code.getScrollTop();
    const positions: Record<string, number> = {
      Home: 0, End: this.maximum,
      ArrowUp: top - 22, ArrowDown: top + 22,
      PageUp: top - this.trackHeight * 0.9, PageDown: top + this.trackHeight * 0.9,
    };
    if (!(event.key in positions)) return;
    event.preventDefault();
    event.stopPropagation();
    this.code.setScrollTop(positions[event.key]);
  }

  dispose() {
    for (const listener of this.listeners) listener.dispose();
    this.root.remove();
  }
}

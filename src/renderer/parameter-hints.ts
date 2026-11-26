import { alert as announce } from "monaco-editor/base/browser/ui/aria/aria.js";
import { ParameterHintsModel } from "monaco-editor/editor/contrib/parameterHints/browser/parameterHintsModel.js";
import { ILanguageFeaturesService } from "monaco-editor/editor/common/services/languageFeatures.js";
import { StandaloneServices } from "monaco-editor/editor/standalone/browser/standaloneServices.js";
import { IMarkdownRendererService } from "monaco-editor/platform/markdown/browser/markdownRenderer.js";
import { monaco } from "./monaco";

function parameterOffsets(signature: monaco.languages.SignatureInformation, index: number) {
  const parameter = signature.parameters[index];
  if (!parameter?.label.length) return;
  if (typeof parameter.label !== "string") return parameter.label;

  let cursor = signature.label.indexOf("(") + 1;
  for (const { label } of signature.parameters.slice(0, index)) {
    if (typeof label !== "string") {
      cursor = label[1];
    } else {
      const offset = signature.label.indexOf(label, cursor);
      if (offset >= 0) cursor = offset + label.length;
    }
  }
  const start = signature.label.indexOf(parameter.label, cursor);
  if (start >= 0) return [start, start + parameter.label.length] as const;
}

export function installParameterHints(code: monaco.editor.IStandaloneCodeEditor) {
  const { signatureHelpProvider } = StandaloneServices.get(ILanguageFeaturesService);
  const model = new ParameterHintsModel(code, signatureHelpProvider);
  const markdown = StandaloneServices.get(IMarkdownRendererService);
  const visible = code.createContextKey<boolean>("parameterHintsVisible", false);

  const panel = document.createElement("div");
  panel.className = "editor-parameter-hints";
  panel.setAttribute("role", "tooltip");
  const signatures = document.createElement("div");
  const docs = document.createElement("div");
  docs.className = "editor-parameter-docs";
  panel.append(signatures, docs);
  panel.addEventListener("wheel", (event) => event.stopPropagation(), { passive: true });

  const widget: monaco.editor.IContentWidget = {
    allowEditorOverflow: true,
    getId: () => "workbench.parameterHints",
    getDomNode: () => panel,
    getPosition: () => visible.get() ? {
      position: code.getPosition(),
      preference: [monaco.editor.ContentWidgetPositionPreference.ABOVE, monaco.editor.ContentWidgetPositionPreference.BELOW],
    } : null,
  };
  code.applyFontInfo(signatures);
  code.addContentWidget(widget);

  let announcedParameter = "";
  const renderedDocs: monaco.IDisposable[] = [];
  const clearDocs = () => {
    renderedDocs.splice(0).forEach((item) => item.dispose());
    docs.replaceChildren();
  };
  const layout = () => { if (visible.get()) code.layoutContentWidget(widget); };
  const update = model.onChangedHints((hints) => {
    clearDocs();
    if (!hints) {
      announcedParameter = "";
      visible.reset();
      signatures.replaceChildren();
      code.layoutContentWidget(widget);
      return;
    }

    const rows = hints.signatures.map((signature, index) => {
      const row = document.createElement("div");
      row.className = "editor-parameter-signature";
      if (index === hints.activeSignature) row.setAttribute("aria-current", "true");
      const offsets = parameterOffsets(signature, signature.activeParameter ?? hints.activeParameter);
      if (!offsets) {
        row.textContent = signature.label;
      } else {
        const [start, end] = offsets;
        const current = document.createElement("strong");
        current.className = "editor-parameter-current";
        current.textContent = signature.label.slice(start, end);
        row.append(signature.label.slice(0, start), current, signature.label.slice(end));
      }
      return row;
    });
    signatures.replaceChildren(...rows);

    const signature = hints.signatures[hints.activeSignature];
    const parameter = signature?.parameters[signature.activeParameter ?? hints.activeParameter];
    const documentation = [parameter?.documentation, signature?.documentation];
    for (const doc of documentation) {
      if (typeof doc === "string" && doc) {
        const text = document.createElement("p");
        text.textContent = doc;
        docs.append(text);
      } else if (doc && typeof doc !== "string" && doc.value) {
        const rendered = markdown.render(doc, { context: code, asyncRenderCallback: layout });
        renderedDocs.push(rendered);
        docs.append(rendered.element);
      }
    }
    docs.hidden = !docs.childElementCount;
    if (parameter && signature) {
      const label = typeof parameter.label === "string" ? parameter.label : signature.label.slice(...parameter.label);
      const details = documentation.map((doc) => typeof doc === "string" ? doc : doc?.value);
      const message = [label, ...details].filter(Boolean).join("，");
      if (message && message !== announcedParameter) {
        announcedParameter = message;
        announce(`${message}，参数提示`);
      }
    }
    visible.set(true);
    layout();
  });

  const trigger = () => model.trigger({ triggerKind: monaco.languages.SignatureHelpTriggerKind.Invoke }, 0);
  const command = monaco.editor.registerCommand("editor.action.triggerParameterHints", trigger);
  const invoke = code.addAction({
    id: "editor.action.triggerParameterHints",
    label: "显示参数提示",
    precondition: "editorHasSignatureHelpProvider",
    keybindingContext: "editorTextFocus",
    keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyP, monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Space],
    run: trigger,
  });
  const dismiss = code.addAction({
    id: "closeParameterHints",
    label: "关闭参数提示",
    precondition: "parameterHintsVisible",
    keybindingContext: "editorFocus",
    keybindings: [monaco.KeyCode.Escape, monaco.KeyMod.Shift | monaco.KeyCode.Escape],
    run: () => model.cancel(),
  });
  const cursor = code.onDidChangeCursorSelection(layout);
  const font = code.onDidChangeConfiguration((event) => {
    if (!event.hasChanged(monaco.editor.EditorOption.fontInfo)) return;
    code.applyFontInfo(signatures);
    layout();
  });
  code.onDidDispose(() => {
    update.dispose();
    model.dispose();
    cursor.dispose();
    font.dispose();
    invoke.dispose();
    dismiss.dispose();
    command.dispose();
    clearDocs();
  });
}

import "monaco-editor/nls/lang/zh-cn.js";
import * as monaco from "monaco-editor/editor/editor.api.js";
import EditorWorker from "monaco-editor/editor/editor.worker.js?worker&inline";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/hover/browser/hoverContribution.js";
import "monaco-editor/editor/contrib/suggest/browser/suggestController.js";
import "monaco-editor/editor/contrib/parameterHints/browser/parameterHints.js";
import "monaco-editor/languages/definitions/java/register.js";
import "monaco-editor/languages/definitions/javascript/register.js";
import "monaco-editor/languages/definitions/typescript/register.js";
import "monaco-editor/languages/definitions/html/register.js";
import "monaco-editor/languages/definitions/css/register.js";
import "monaco-editor/languages/definitions/xml/register.js";
import "monaco-editor/languages/definitions/sql/register.js";
import "monaco-editor/languages/definitions/shell/register.js";
import "monaco-editor/languages/definitions/powershell/register.js";
import "monaco-editor/languages/definitions/markdown/register.js";
import "monaco-editor/languages/definitions/yaml/register.js";
(self as any).MonacoEnvironment = { getWorker: () => new EditorWorker() };
monaco.languages.register({ id: "json", extensions: [".json", ".jsonc"] });
monaco.languages.setMonarchTokensProvider("json", {
  tokenizer: {
    root: [
      [/"([^"\\]|\\.)*"(?=\s*:)/, "key"],
      [/"([^"\\]|\\.)*"/, "string"],
      [/\b(true|false|null)\b/, "keyword"],
      [/-?\d+(\.\d+)?([eE][+-]?\d+)?/, "number"],
      [/[{}\[\],:]/, "delimiter"],
    ],
  },
});
monaco.languages.register({ id: "vue", extensions: [".vue"] });
monaco.languages.setMonarchTokensProvider("vue", {
  tokenizer: {
    root: [
      [
        /<script\b[^>]*>/,
        { token: "tag", next: "@script", nextEmbedded: "typescript" },
      ],
      [/<style\b[^>]*>/, { token: "tag", next: "@style", nextEmbedded: "css" }],
      [/<!--[\s\S]*?-->/, "comment"],
      [/<\/?[\w.-]+/, "tag"],
      [/[\w@:#.-]+(?=\s*=)/, "attribute.name"],
      [/"[^"\n]*"|'[^'\n]*'/, "attribute.value"],
      [/\{\{.*?\}\}/, "variable"],
      [/\/?>/, "tag"],
    ],
    script: [
      [/<\/script\s*>/, { token: "tag", next: "@pop", nextEmbedded: "@pop" }],
    ],
    style: [
      [/<\/style\s*>/, { token: "tag", next: "@pop", nextEmbedded: "@pop" }],
    ],
  },
});
monaco.editor.defineTheme("workbench-dark", {
  base: "vs-dark",
  inherit: true,
  rules: [],
  colors: {
    "editor.background": "#1e1f22",
    "editorGutter.background": "#1e1f22",
    "diffEditor.insertedTextBackground": "#2ea04338",
    "diffEditor.removedTextBackground": "#f8514938",
    "diffEditor.insertedLineBackground": "#2ea04315",
    "diffEditor.removedLineBackground": "#f8514915",
  },
});
monaco.editor.defineTheme("workbench-light", {
  base: "vs",
  inherit: true,
  rules: [
    { token: "comment", foreground: "808080", fontStyle: "italic" },
    { token: "keyword", foreground: "0000ff" },
    { token: "string", foreground: "008000" },
    { token: "number", foreground: "0000ff" },
    { token: "type.yaml", foreground: "0000ff" },
    { token: "string.yaml", foreground: "000000" },
  ],
  colors: {
    "editor.background": "#ffffff",
    "editorGutter.background": "#ffffff",
    "editor.foreground": "#000000",
    "editorLineNumber.foreground": "#a0a5b5",
    "editorLineNumber.activeForeground": "#777777",
    "editor.lineHighlightBackground": "#00000000",
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": "#a6d2ff",
    "editor.inactiveSelectionBackground": "#c8dff5",
    "diffEditor.insertedLineBackground": "#d6e4f2",
    "diffEditor.removedLineBackground": "#d6e4f2",
    "diffEditor.insertedTextBackground": "#bfe6b9",
    "diffEditor.removedTextBackground": "#d6d6d6",
    "diffEditor.diagonalFill": "#00000000",
    "diffEditorGutter.insertedLineBackground": "#c4d9f1",
    "diffEditorGutter.removedLineBackground": "#c4d9f1",
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": "#c2c2c280",
    "scrollbarSlider.hoverBackground": "#adadad99",
    "scrollbarSlider.activeBackground": "#999999bb",
  },
});
export function language(file: string) {
  const ext = file.split(".").pop()?.toLowerCase() || "";
  return (
    (
      {
        java: "java",
        js: "javascript",
        jsx: "javascript",
        ts: "typescript",
        tsx: "typescript",
        vue: "vue",
        json: "json",
        jsonc: "json",
        xml: "xml",
        sql: "sql",
        html: "html",
        htm: "html",
        css: "css",
        scss: "css",
        sh: "shell",
        bash: "shell",
        ps1: "powershell",
        psm1: "powershell",
        md: "markdown",
        yml: "yaml",
        yaml: "yaml",
      } as Record<string, string>
    )[ext] || "plaintext"
  );
}
export function diffCodeOptions(fontSize: number, wrap: boolean) {
  return {
    automaticLayout: true,
    fontFamily: 'Consolas, "JetBrains Mono", "Microsoft YaHei", monospace',
    fontSize,
    lineHeight: Math.round(fontSize * 1.6),
    minimap: { enabled: false },
    scrollBeyondLastLine: false,
    wordWrap: wrap ? ("on" as const) : ("off" as const),
    padding: { top: 3, bottom: 3 },
    renderWhitespace: "selection" as const,
    readOnly: true,
    contextmenu: true,
  };
}
export function ideaLineDecorations(changes: monaco.editor.ILineChange[]) {
  const original: monaco.editor.IModelDeltaDecoration[] = [], modified: monaco.editor.IModelDeltaDecoration[] = [];
  for (const change of changes) {
    const removed = change.originalEndLineNumber > 0, added = change.modifiedEndLineNumber > 0;
    if (removed && !added) original.push({
      range: new monaco.Range(change.originalStartLineNumber, 1, change.originalEndLineNumber, 1),
      options: { isWholeLine: true, className: "idea-deleted-line", marginClassName: "idea-deleted-gutter", zIndex: 10 },
    });
    if (added && !removed) modified.push({
      range: new monaco.Range(change.modifiedStartLineNumber, 1, change.modifiedEndLineNumber, 1),
      options: { isWholeLine: true, className: "idea-added-line", marginClassName: "idea-added-gutter", zIndex: 10 },
    });
  }
  return { original, modified };
}
export { monaco };

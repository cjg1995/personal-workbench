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

/* ---------- IDEA 风格主题（Light / Darcula） ---------- */
interface IdeaPalette {
  text: string;
  keyword: string;
  annotation: string;
  string: string;
  number: string;
  comment: string;
  field: string;
  tag: string;
  attribute: string;
  variable: string;
  background: string;
  gutter: string;
  lineNumber: string;
  activeLineNumber: string;
  lineHighlight: string;
  selection: string;
  inactiveSelection: string;
  cursor: string;
  indent: string;
  folding: string;
  foldBackground: string;
  bracket: string;
  whitespace: string;
  overviewBorder: string;
}
const ideaLight: IdeaPalette = {
  text: "000000", keyword: "0033B3", annotation: "9E880D", string: "067D17",
  number: "1750EB", comment: "8C8C8C", field: "871094", tag: "0033B3",
  attribute: "174AD5", variable: "871094", background: "FFFFFF", gutter: "FFFFFF",
  lineNumber: "A6A6A6", activeLineNumber: "1F1F1F", lineHighlight: "F5F8FF",
  selection: "A6D2FF", inactiveSelection: "E0EBF9", cursor: "000000",
  indent: "E7E9EE", folding: "6B7280", foldBackground: "F2F6FC",
  bracket: "99BBFF", whitespace: "C9CDD4", overviewBorder: "FFFFFF",
};
const ideaDark: IdeaPalette = {
  text: "A9B7C6", keyword: "CC7832", annotation: "BBB529", string: "6A8759",
  number: "6897BB", comment: "808080", field: "9876AA", tag: "E8BF6A",
  attribute: "BABABA", variable: "9876AA", background: "1E1F22", gutter: "1E1F22",
  lineNumber: "606366", activeLineNumber: "A9B7C6", lineHighlight: "2A2D31",
  selection: "214283", inactiveSelection: "263A5C", cursor: "A9B7C6",
  indent: "3B3E44", folding: "8A9099", foldBackground: "2A3140",
  bracket: "5F87BF", whitespace: "4B4E54", overviewBorder: "1E1F22",
};
function ideaRules(p: IdeaPalette): monaco.editor.ITokenThemeRule[] {
  const list: [string, string, string?][] = [
    ["", p.text],
    ["comment", p.comment, "italic"],
    ["comment.doc", p.comment, "italic"],
    ["comment.block", p.comment, "italic"],
    ["keyword", p.keyword, "bold"],
    ["keyword.directive", p.keyword, "bold"],
    ["keyword.flow", p.keyword, "bold"],
    ["storage", p.keyword, "bold"],
    ["number", p.number],
    ["string", p.string],
    ["string.escape", p.number],
    ["string.invalid", "CC0000"],
    ["annotation", p.annotation],
    ["annotation.java", p.annotation],
    ["annotation.ts", p.annotation],
    ["metadata", p.annotation],
    ["type", p.text],
    ["type.identifier", p.text],
    ["identifier", p.text],
    ["variable", p.variable],
    ["variable.name", p.variable],
    ["variable.predefined", p.field],
    ["key", p.field],
    ["tag", p.tag],
    ["tag.xml", p.tag],
    ["attribute.name", p.attribute],
    ["attribute.value", p.string],
    ["delimiter", p.text],
    ["delimiter.bracket", p.text],
    ["delimiter.parenthesis", p.text],
    ["operator", p.text],
    ["regexp", p.string],
    ["type.yaml", p.keyword, "bold"],
    ["string.yaml", p.string],
    ["keyword.yaml", p.keyword, "bold"],
    ["number.yaml", p.number],
    ["string.sql", p.string],
    ["keyword.sql", p.keyword, "bold"],
    ["string.key.json", p.field],
    ["string.value.json", p.string],
  ];
  return list.map(([token, foreground, fontStyle]) => ({ token, foreground, ...(fontStyle ? { fontStyle } : {}) }));
}
function ideaColors(p: IdeaPalette, dark: boolean): Record<string, string> {
  return {
    "editor.background": `#${p.background}`,
    "editor.foreground": `#${p.text}`,
    "editorGutter.background": `#${p.gutter}`,
    "editorLineNumber.foreground": `#${p.lineNumber}`,
    "editorLineNumber.activeForeground": `#${p.activeLineNumber}`,
    "editor.lineHighlightBackground": `#${p.lineHighlight}`,
    "editor.lineHighlightBorder": "#00000000",
    "editor.selectionBackground": `#${p.selection}`,
    "editor.inactiveSelectionBackground": `#${p.inactiveSelection}`,
    "editorCursor.foreground": `#${p.cursor}`,
    "editorIndentGuide.background1": `#${p.indent}`,
    "editorIndentGuide.activeBackground1": `#${p.folding}`,
    "editorWhitespace.foreground": `#${p.whitespace}`,
    "editorGutter.foldingControlForeground": `#${p.folding}`,
    "editor.foldBackground": `#${p.foldBackground}`,
    "editorBracketMatch.border": `#${p.bracket}`,
    "editorBracketMatch.background": `#${dark ? p.foldBackground : "E6EFFF"}`,
    "editorBracketHighlight.foreground1": `#${p.text}`,
    "editorBracketHighlight.foreground2": `#${p.text}`,
    "editorBracketHighlight.foreground3": `#${p.text}`,
    "editorBracketHighlight.foreground4": `#${p.text}`,
    "editorBracketHighlight.foreground5": `#${p.text}`,
    "editorBracketHighlight.foreground6": `#${p.text}`,
    "editorBracketHighlight.unexpectedBracket.foreground": "#CC0000",
    "editorOverviewRuler.border": `#${p.overviewBorder}`,
    "editorOverviewRuler.findMatchForeground": `#${p.bracket}`,
    "diffEditor.insertedLineBackground": dark ? "#2ea04315" : "#d6e4f2",
    "diffEditor.removedLineBackground": dark ? "#f8514915" : "#d6e4f2",
    "diffEditor.insertedTextBackground": dark ? "#2ea04338" : "#bfe6b9",
    "diffEditor.removedTextBackground": dark ? "#f8514938" : "#d6d6d6",
    "diffEditor.diagonalFill": "#00000000",
    "diffEditorGutter.insertedLineBackground": dark ? "#2ea04338" : "#c4d9f1",
    "diffEditorGutter.removedLineBackground": dark ? "#f8514938" : "#c4d9f1",
    "scrollbar.shadow": "#00000000",
    "scrollbarSlider.background": dark ? "#4A4E5580" : "#C2C2C280",
    "scrollbarSlider.hoverBackground": dark ? "#5A606999" : "#ADADAD99",
    "scrollbarSlider.activeBackground": dark ? "#6A7079BB" : "#999999BB",
  };
}
monaco.editor.defineTheme("workbench-dark", {
  base: "vs-dark",
  inherit: false,
  rules: ideaRules(ideaDark),
  colors: ideaColors(ideaDark, true),
});
monaco.editor.defineTheme("workbench-light", {
  base: "vs",
  inherit: false,
  rules: ideaRules(ideaLight),
  colors: ideaColors(ideaLight, false),
});

/* ---------- IDEA 风格代码折叠 ---------- */
interface ScannedLine { code: string; inBlock: boolean }
function scanLine(line: string, inBlock: boolean): ScannedLine {
  let code = "";
  let state: "code" | "string" | "template" | "block" = inBlock ? "block" : "code";
  let quote = "", templateDepth = 0, templateBraces = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i], n = line[i + 1];
    if (state === "block") {
      if (c === "*" && n === "/") { state = "code"; i++; code += "  "; }
      else code += " ";
      continue;
    }
    if (state === "string") {
      if (c === "\\") { i++; code += "  "; continue; }
      if (c === quote) state = "code";
      code += " ";
      continue;
    }
    if (state === "template") {
      if (c === "\\") { i++; code += "  "; continue; }
      if (c === "$" && n === "{") { state = "code"; templateDepth = 1; templateBraces = 0; i++; code += "  "; continue; }
      if (c === "`") state = "code";
      code += " ";
      continue;
    }
    if (c === "/" && n === "/") break;
    if (c === "/" && n === "*") { state = "block"; i++; code += "  "; continue; }
    if (c === '"' || c === "'" || c === "`") {
      quote = c; state = c === "`" ? "template" : "string"; code += " "; continue;
    }
    // Vue/HTML 插值与注释的花括号不参与折叠
    if ((c === "{" && n === "{") || (c === "}" && n === "}")) { code += "  "; i++; continue; }
    if (c === "<" && line.slice(i, i + 4) === "<!--") break;
    if (templateDepth > 0 && c === "}" && templateBraces === 0) {
      state = "template"; templateDepth = 0; code += " "; continue;
    }
    if (templateDepth > 0 && c === "{") templateBraces++;
    else if (templateDepth > 0 && c === "}" && templateBraces > 0) templateBraces--;
    code += c;
  }
  return { code, inBlock: state === "block" };
}
function ideaFoldingRanges(model: monaco.editor.ITextModel): monaco.languages.FoldingRange[] {
  const lines = model.getLinesContent();
  const ranges: monaco.languages.FoldingRange[] = [];
  const stack: number[] = [];
  let inBlock = false, blockStart = 0;
  let importStart = 0, importEnd = 0;
  const blocks: { tag: string; line: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNumber = i + 1;
    const raw = lines[i];
    const scanned = scanLine(raw, inBlock);
    if (!inBlock && /\/(?:\*|\/)/.test(raw) && !scanned.code.trim()) blockStart = lineNumber;
    inBlock = scanned.inBlock;
    if (blockStart && !inBlock) {
      if (lineNumber > blockStart) ranges.push({ start: blockStart, end: lineNumber, kind: monaco.languages.FoldingRangeKind.Comment });
      blockStart = 0;
    }
    // import / package 区（IDEA 默认折叠）
    if (/^\s*(?:import|@import)\b/.test(raw)) {
      if (!importStart) importStart = lineNumber;
      importEnd = lineNumber;
    } else if (importStart && raw.trim() && !/^\s*(?:\/\/|\/\*|\*)/.test(raw)) {
      if (importEnd > importStart) ranges.push({ start: importStart, end: importEnd, kind: monaco.languages.FoldingRangeKind.Imports });
      importStart = importEnd = 0;
    }
    // <template> / <script> / <style> 块
    const open = /^\s*<(template|script|style)\b/i.exec(raw);
    const close = /^\s*<\/(template|script|style)\s*>/i.exec(raw);
    if (open) blocks.push({ tag: open[1].toLowerCase(), line: lineNumber });
    else if (close) {
      for (let j = blocks.length - 1; j >= 0; j--) {
        if (blocks[j].tag === close[1].toLowerCase()) {
          if (lineNumber > blocks[j].line + 1) ranges.push({ start: blocks[j].line, end: lineNumber });
          blocks.splice(j, 1);
          break;
        }
      }
    }
    // 花括号块（类、方法、if/for、对象字面量）
    for (const c of scanned.code) {
      if (c === "{") stack.push(lineNumber);
      else if (c === "}") {
        const start = stack.pop();
        if (start !== undefined && lineNumber > start) ranges.push({ start, end: lineNumber });
      }
    }
  }
  if (importEnd > importStart) ranges.push({ start: importStart, end: importEnd, kind: monaco.languages.FoldingRangeKind.Imports });
  if (blockStart && inBlock) ranges.push({ start: blockStart, end: lines.length, kind: monaco.languages.FoldingRangeKind.Comment });
  return ranges;
}
for (const id of ["java", "javascript", "typescript", "vue", "html", "xml", "css", "json", "yaml", "sql", "shell", "powershell", "markdown"]) {
  monaco.languages.registerFoldingRangeProvider(id, {
    provideFoldingRanges: (model) => ideaFoldingRanges(model),
  });
}
/* 给 import 折叠起始行打 margin 标记：只有这些行的折叠箭头常驻，其余悬停才出现。 */
interface ImportFoldState { ids: string[]; timer?: ReturnType<typeof setTimeout>; listener: monaco.IDisposable }
const importFolds = new Map<monaco.editor.ITextModel, ImportFoldState>();
function applyImportFoldMarks(model: monaco.editor.ITextModel) {
  const state = importFolds.get(model);
  if (!state || model.isDisposed()) return;
  const decorations = ideaFoldingRanges(model)
    .filter((range) => range.kind === monaco.languages.FoldingRangeKind.Imports && range.end > range.start)
    .map((range) => ({
      range: new monaco.Range(range.start, 1, range.start, 1),
      options: { marginClassName: "idea-fold-import" },
    }));
  state.ids = model.deltaDecorations(state.ids, decorations);
}
monaco.editor.onDidCreateModel((model) => {
  const state: ImportFoldState = { ids: [], listener: { dispose() {} } };
  importFolds.set(model, state);
  state.timer = setTimeout(() => { state.timer = undefined; applyImportFoldMarks(model); }, 120);
  state.listener = model.onDidChangeContent(() => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => applyImportFoldMarks(model), 350);
  });
});
monaco.editor.onWillDisposeModel((model) => {
  const state = importFolds.get(model);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.listener.dispose();
  importFolds.delete(model);
});
// 首帧就把 import 区隐藏，避免折叠提供器异步计算时先展开再收起的闪动。
export function ideaImportHiddenAreas(model: monaco.editor.ITextModel): monaco.Range[] {
  return ideaFoldingRanges(model)
    .filter((range) => range.kind === monaco.languages.FoldingRangeKind.Imports && range.end > range.start)
    .map((range) => new monaco.Range(range.start + 1, 1, range.end, 1));
}
export function ideaFoldingOptions() {
  return {
    folding: true,
    foldingStrategy: "auto" as const,
    showFoldingControls: "always" as const,
    foldingHighlight: true,
    foldingImportsByDefault: false,
    unfoldOnClickAfterEndOfLine: false,
    foldingMaximumRegions: 5000,
    lineDecorationsWidth: 20,
    bracketPairColorization: { enabled: false },
  };
}

/* ---------- Java 字段的 IDEA 语义紫色 ---------- */
interface FieldColorState { ids: string[]; timer?: ReturnType<typeof setTimeout>; listener: monaco.IDisposable; retries?: number }
const fieldColors = new Map<monaco.editor.ITextModel, FieldColorState>();
function applyJavaFieldColors(model: monaco.editor.ITextModel) {
  const state = fieldColors.get(model);
  if (!state || model.isDisposed()) return;
  const text = model.getValue();
  let decorations: monaco.editor.IModelDeltaDecoration[] = [];
  let matchedTokens = 0, fieldNames = 0;
  if (text.length <= 300000) {
    const names = new Set<string>();
    const declaration = /^\s*(?:(?:@[\w.]+(?:\([^)]*\))?|public|private|protected|static|final|transient|volatile)\s+)+[\w$<>,\[\].?\s]+?\s+([A-Za-z_$][\w$]*)\s*(?:=[^;]*)?;\s*(?:\/\/.*)?$/;
    const lines = text.split(/\r?\n/);
    for (const line of lines) {
      const match = declaration.exec(line);
      if (match) names.add(match[1]);
    }
    if (names.size) {
      fieldNames = names.size;
      const tokens = monaco.editor.tokenize(text, "java");
      for (let i = 0; i < tokens.length && i < lines.length; i++) {
        const line = lines[i], row = tokens[i];
        for (let j = 0; j < row.length; j++) {
          if (!/^identifier/.test(row[j].type)) continue;
          matchedTokens++;
          const from = row[j].offset;
          const to = j + 1 < row.length ? row[j + 1].offset : line.length;
          const value = line.slice(from, to);
          const range = new monaco.Range(i + 1, from + 1, i + 1, to + 1);
          // IDEA 把 null 当作关键字（蓝色加粗）；Java Monarch 词表里缺少它
          if (value === "null") {
            decorations.push({ range, options: { inlineClassName: "idea-java-null" } });
          } else if (names.has(value)) {
            decorations.push({ range, options: { inlineClassName: "idea-java-field" } });
          }
        }
      }
    }
  }
  // 语言定义按需加载：若是首帧还没拿到 Java token，稍后重试而不是永久漏色
  if (fieldNames && !matchedTokens && (state.retries || 0) < 4) {
    state.retries = (state.retries || 0) + 1;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => { state.timer = undefined; applyJavaFieldColors(model); }, 350);
    return;
  }
  state.retries = 0;
  state.ids = model.deltaDecorations(state.ids, decorations);
}
monaco.editor.onDidCreateModel((model) => {
  if (model.getLanguageId() !== "java") return;
  const state: FieldColorState = { ids: [], listener: { dispose() {} } };
  fieldColors.set(model, state);
  // 语言定义按需加载，稍等一拍再取 token，确保首次打开也能着色
  state.timer = setTimeout(() => { state.timer = undefined; applyJavaFieldColors(model); }, 120);
  state.listener = model.onDidChangeContent(() => {
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => applyJavaFieldColors(model), 300);
  });
});
monaco.editor.onWillDisposeModel((model) => {
  const state = fieldColors.get(model);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  state.listener.dispose();
  fieldColors.delete(model);
});

export function language(file: string) {
  const ext = file.split(".").pop()?.toLowerCase() || "";
  return (
    (
      {
        java: "java",
        js: "javascript",
        jsx: "javascript",
        mjs: "javascript",
        cjs: "javascript",
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
    ...ideaFoldingOptions(),
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

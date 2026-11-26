import { parser } from "@lezer/java";

type SyntaxNode = ReturnType<typeof parser.parse>["topNode"];
export type JavaEdit = { from: number; to: number; text: string; cursor: number };

const outputTemplates = {
  sout: ["System.out.println(", ");"],
  serr: ["System.err.println(", ");"],
  souf: ['System.out.printf("', '");'],
} as const;
export function isJavaOutputAbbreviation(word: string): word is keyof typeof outputTemplates {
  return Object.hasOwn(outputTemplates, word);
}

const statementNames = new Set([
  "AssertStatement", "BreakStatement", "ContinueStatement", "DoStatement",
  "ExplicitConstructorInvocation", "ExpressionStatement", "FieldDeclaration",
  "ImportDeclaration", "LocalVariableDeclaration", "PackageDeclaration",
  "ReturnStatement", "ThrowStatement", "YieldStatement",
]);

const controlHeaders: Record<string, string> = {
  IfStatement: "ParenthesizedExpression",
  WhileStatement: "ParenthesizedExpression",
  SynchronizedStatement: "ParenthesizedExpression",
  SwitchStatement: "ParenthesizedExpression",
  SwitchExpression: "ParenthesizedExpression",
  ForStatement: "ForSpec",
  EnhancedForStatement: "ForSpec",
  CatchClause: "CatchFormalParameter",
};
const declarationBodies: Record<string, string> = {
  MethodDeclaration: "Block", ConstructorDeclaration: "ConstructorBody",
  ClassDeclaration: "ClassBody", InterfaceDeclaration: "InterfaceBody",
  RecordDeclaration: "ClassBody", EnumDeclaration: "EnumBody",
};

function isComment(node: SyntaxNode) {
  return node.name === "LineComment" || node.name === "BlockComment";
}

function lastCodeChild(node: SyntaxNode) {
  let child = node.lastChild;
  while (child && (child.type.isError || child.from === child.to || isComment(child))) child = child.prevSibling;
  return child;
}

function lastToken(node: SyntaxNode) {
  let token = node;
  for (let child = lastCodeChild(token); child; child = lastCodeChild(token)) token = child;
  return token;
}

function followingCode(node: SyntaxNode) {
  let next = node.nextSibling;
  while (next && isComment(next)) next = next.nextSibling;
  return next?.type.isError ? null : next;
}

function missingClosers(node: SyntaxNode) {
  const closers = [];
  for (let part: SyntaxNode | null = node; part; part = lastCodeChild(part)) {
    if (part.getChild("(") && !part.getChild(")")) closers.push(")");
    if (part.getChild("[") && !part.getChild("]")) closers.push("]");
  }
  return closers.reverse().join("");
}

function lineStart(source: string, pos: number) {
  return pos ? source.lastIndexOf("\n", pos - 1) + 1 : 0;
}

function lineEnd(source: string, pos: number) {
  const lf = source.indexOf("\n", pos);
  return lf < 0 ? source.length : lf - Number(source[lf - 1] === "\r");
}

function indentation(source: string, pos: number) {
  return /^[\t ]*/.exec(source.slice(lineStart(source, pos)))![0];
}

export function expandJavaOutput(source: string, offset: number): JavaEdit | undefined {
  const word = /[\p{ID_Continue}$]+$/u.exec(source.slice(lineStart(source, offset), offset))?.[0];
  if (!word || !isJavaOutputAbbreviation(word) || /[\p{ID_Continue}$]/u.test(source[offset] || "")) return;
  const from = offset - word.length;
  let node: SyntaxNode | null = parser.parse(source).resolveInner(from, 1);
  while (node && node.name !== "ExpressionStatement" && !isComment(node)) node = node.parent;
  if (node?.name !== "ExpressionStatement" || node.from !== from ||
      /^[\t ]*[.(=]/.test(source.slice(offset, lineEnd(source, offset)))) return;
  const [left, right] = outputTemplates[word];
  const suffix = /^[\t ]*;/.exec(source.slice(offset, lineEnd(source, offset)));
  return { from, to: offset + (suffix?.[0].length ?? 0), text: left + right, cursor: from + left.length };
}

export function javaCallArguments(source: string, offset: number) {
  const opening = /^[\t ]*\(/.exec(source.slice(offset, lineEnd(source, offset)));
  if (opening) {
    const pos = offset + opening[0].length;
    const node = parser.parse(source).resolveInner(pos, -1);
    if (node.name === "(" && node.parent?.name === "ArgumentList") return pos;
  }
  let pos = offset;
  if (source[pos - 1] === ";") pos--;
  if (source[pos - 1] !== ")") return;
  const node = parser.parse(source).resolveInner(pos, -1);
  return node.name === ")" && node.parent?.name === "ArgumentList" ? pos - 1 : undefined;
}

export function preserveJavaCallSuffix(completion: string, suffix: string) {
  const name = /^((?:[\p{ID_Continue}$.]|\\[$\\])+(?:<[^()\r\n]*>)?)\(/u.exec(completion)?.[1];
  if (!name) return completion;
  if (/^[\t ]*\(/.test(suffix)) return name;
  return /^[\t ]*;/.test(suffix) ? completion.replace(/;$/, "") : completion;
}

export function completeJavaStatement(source: string, offset: number, indentUnit: string, eol: string): JavaEdit | undefined {
  const start = lineStart(source, offset);
  const end = lineEnd(source, offset);
  const prefix = source.slice(start, offset).trimEnd();
  const point = prefix ? start + prefix.length : offset + /^[\t ]*/.exec(source.slice(offset, end))![0].length;
  if (!prefix && point >= end) return;

  const tree = parser.parse(source);
  const leaf = tree.resolveInner(point, prefix ? -1 : 1);
  if (isComment(leaf) || leaf.name === "TextBlock" && point < leaf.to) return;

  function nextLine(from: number, ending: string, indent: string): JavaEdit {
    const endOfLine = lineEnd(source, from);
    const tail = source.slice(from, endOfLine);
    const comment = /^[\t ]*(?:\/\*.*?\*\/[\t ]*)*(?:\/\/.*)?$/.test(tail);
    const to = comment ? endOfLine : from + /^[\t ]*/.exec(tail)![0].length;
    const text = ending + (comment ? tail.trimEnd() : "") + eol + indent;
    return { from, to, text, cursor: from + text.length };
  }

  function enterBody(body: SyntaxNode, indent: string): JavaEdit | undefined {
    const open = body.getChild("{");
    if (!open) return;
    const close = body.getChild("}");
    const next = followingCode(open);
    if (next && next.name !== "}")
      return { from: next.from, to: next.from, text: "", cursor: next.from };
    const inner = indent + indentUnit;
    if (close && lineStart(source, close.from) > lineStart(source, open.from)) {
      const from = lineStart(source, close.from);
      return { from, to: from, text: inner + eol, cursor: from + inner.length };
    }
    return { from: open.to, to: close?.from ?? open.to, text: eol + inner + eol + indent + (close ? "" : "}"),
      cursor: open.to + eol.length + inner.length };
  }

  function addBody(header: SyntaxNode, indent: string, body?: SyntaxNode | null, closing = "", cursor?: number) {
    const from = lastToken(header).to;
    if (body?.getChild("{")) {
      const edit = enterBody(body, indent);
      if (!edit || !closing) return edit;
      return { from, to: edit.to, text: closing + source.slice(from, edit.from) + edit.text, cursor: edit.cursor + closing.length };
    }
    const comment = /^[\t ]*\/\/.*$/.exec(source.slice(from, lineEnd(source, from)))?.[0] ?? "";
    const inner = closing + " {" + comment + eol + indent + indentUnit;
    return { from, to: from + comment.length, text: inner + eol + indent + "}", cursor: cursor ?? from + inner.length };
  }

  for (let node: SyntaxNode | null = leaf; node; node = node.parent) {
    const indent = indentation(source, node.from);
    if (node.name === "IfStatement") {
      const otherwise = node.getChild("else");
      if (otherwise && point >= otherwise.to) {
        const body = followingCode(otherwise);
        if (body && !body.getChild("{"))
          return { from: body.from, to: body.from, text: "", cursor: body.from };
        return addBody(otherwise, indent, body);
      }
    }
    const control = controlHeaders[node.name];
    if (control) {
      const header = node.getChild(control);
      if (!header) {
        const keyword = node.firstChild;
        if (keyword && /^\s*$/.test(source.slice(keyword.to, end)))
          return addBody(keyword, indent, null, " ()", keyword.to + 2);
        return;
      }
      const body = followingCode(header);
      const validBody = body && (body.getChild("{") ||
        indentation(source, body.from).length > indent.length || lineStart(source, body.from) === lineStart(source, lastToken(header).to));
      if (validBody && !body.getChild("{")) {
        const cursor = body.from;
        return { from: cursor, to: cursor, text: "", cursor };
      }
      const open = header.getChild("(");
      const at = lastToken(header).to;
      const empty = open && /^[\s)]*$/.test(source.slice(open.to, at));
      return addBody(header, indent, validBody ? body : null, missingClosers(header), empty ? open.to : undefined);
    }
    const declarationBody = declarationBodies[node.name];
    if (declarationBody) {
      const modifiers = node.getChild("Modifiers");
      const name = node.getChild("Definition");
      if (!name || point < name.from && modifiers?.to === point) return;
      const parameters = node.getChild("FormalParameters") ?? node.getChild("RecordHeader");
      const closing = parameters ? missingClosers(parameters) : "";
      const actualBody = node.getChild(declarationBody);
      if (actualBody && lastToken(actualBody).to <= point) return;
      if (node.name === "MethodDeclaration") {
        const modifierText = modifiers ? source.slice(modifiers.from, modifiers.to) : "";
        const signatureOnly = /\b(?:abstract|native)\b/.test(modifierText) ||
          (node.parent?.name === "InterfaceBody" && !/\b(?:default|static|private)\b/.test(modifierText));
        const tail = lastToken(node);
        if (signatureOnly || tail.name === ";")
          return nextLine(tail.to, tail.name === ";" ? "" : closing + ";", indent);
      }
      if (actualBody) return enterBody(actualBody, indent);
      return addBody(node, indent, null, closing);
    }
    if (node.name === "TryStatement" || node.name === "FinallyClause") {
      const header = node.getChild("ResourceSpecification") ?? node.firstChild;
      if (header) return addBody(header, indent, node.getChild("Block"), missingClosers(header));
    }
    if (node.name === "DoStatement" && !node.getChild("while")) {
      const keyword = node.firstChild;
      if (!keyword) return;
      const body = node.getChild("Block");
      if (body) return nextLine(lastToken(body).to, " while ();", indent);
      const edit = addBody(keyword, indent);
      return edit && { ...edit, text: edit.text + " while ();" };
    }
    if (statementNames.has(node.name) && node.parent?.name !== "ForSpec") {
      const tail = lastToken(node);
      if (tail.name === ";") return nextLine(tail.to, "", indent);
      if (node.name === "ExpressionStatement" && ![
        "AssignmentExpression", "MethodInvocation", "ObjectCreationExpression", "UpdateExpression",
      ].includes(node.firstChild?.name ?? "")) return;
      if (["AssignOp", "ArithOp", "LogicOp", "CompareOp", ",", ".", "throw", "assert", "yield", "new"].includes(tail.name)) return;
      if (node.name === "FieldDeclaration" && node.getChild("void")) return;
      const closers = missingClosers(node);
      if (tail.name === "(" && !closers) return;
      return nextLine(tail.to, closers + ";", indent);
    }
    if (node.name === "Block" || node.name.endsWith("Body")) {
      if (leaf.name === "{" && leaf.from === node.from) return enterBody(node, indent);
      return;
    }
  }
}

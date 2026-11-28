import path from "node:path";
import { parser as javaParser } from "@lezer/java";
import type { SyntaxNode } from "@lezer/common";
import type { CodeJumpTarget, CodeResolveResult } from "../shared/types.js";
import type { EditorFiles } from "./editor-files.js";

export type NavigationKind = "definition" | "implementation";

export interface NavigationRequest {
  root: string;
  file: string;
  text: string;
  line: number;
  column: number;
  kind?: NavigationKind;
  allowLsp?: boolean;
}

export interface LspLocationLike {
  uri?: string;
  targetUri?: string;
  range?: { start: { line: number; character: number }; end?: { line: number; character: number } };
  targetSelectionRange?: { start: { line: number; character: number }; end?: { line: number; character: number } };
  targetRange?: { start: { line: number; character: number }; end?: { line: number; character: number } };
}

export type LspResolver = (
  kind: NavigationKind,
  file: string,
  text: string,
  line: number,
  column: number,
) => Promise<LspLocationLike[] | null>;

interface LineIndex {
  starts: number[];
  lines: string[];
}

function buildLineIndex(text: string): LineIndex {
  const lines = text.split(/\r?\n/);
  const starts: number[] = [];
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    starts.push(offset);
    offset += lines[i].length;
    if (text[offset] === "\r") offset++;
    if (text[offset] === "\n") offset++;
  }
  return { starts, lines };
}

function positionToOffset(index: LineIndex, line: number, column: number): number {
  const row = Math.max(0, Math.min(index.starts.length - 1, line - 1));
  const maxCol = index.lines[row].length;
  return index.starts[row] + Math.max(0, Math.min(maxCol, column - 1));
}

function offsetToPosition(index: LineIndex, offset: number): { line: number; column: number } {
  const clamped = Math.max(0, offset);
  let lo = 0;
  let hi = index.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    if (index.starts[mid] <= clamped) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: clamped - index.starts[lo] + 1 };
}

function snippetAt(index: LineIndex, line: number): string {
  return (index.lines[line - 1] || "").trim().slice(0, 200);
}

function normalizeRelative(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

function sameRelativeFile(a: string, b: string): boolean {
  return normalizeRelative(a).toLowerCase() === normalizeRelative(b).toLowerCase();
}

function fileParts(file: string): { label: string; detail: string } {
  if (file.startsWith("jdt:")) {
    const clean = decodeURIComponent(file.slice(4).split("?")[0]);
    const name = clean.split("/").pop() || "依赖源码";
    return { label: name, detail: "外部依赖源码" };
  }
  const normalized = normalizeRelative(file);
  const slash = normalized.lastIndexOf("/");
  if (slash < 0) return { label: normalized, detail: "" };
  return { label: normalized.slice(slash + 1), detail: normalized.slice(0, slash) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function makeTarget(
  currentFile: string,
  file: string,
  line: number,
  column: number,
  snippet: string,
  role?: CodeJumpTarget["role"],
  uri?: string,
): CodeJumpTarget {
  const normalized = file.startsWith("jdt:") ? file : normalizeRelative(file);
  const sameFile = !normalized.startsWith("jdt:") && sameRelativeFile(currentFile, normalized);
  const { label, detail } = fileParts(normalized);
  return { file: normalized, uri, line, column, sameFile, label, detail, snippet, role };
}

/* ==========================================================================
   Java AST 解析与符号定位（基于 @lezer/java）
   ========================================================================== */

interface JavaMethodInfo {
  name: string;
  nameFrom: number;
  nameTo: number;
  returnType: string;
  paramCount: number;
  hasVarargs: boolean;
  hasBody: boolean;
  isStatic: boolean;
  isAbstract: boolean;
  from: number;
  to: number;
}

interface JavaFieldInfo {
  name: string;
  nameFrom: number;
  nameTo: number;
  typeName: string;
  from: number;
  to: number;
}

interface JavaTypeInfo {
  kind: "class" | "interface" | "enum" | "record" | "annotation";
  name: string;
  nameFrom: number;
  nameTo: number;
  isAbstract: boolean;
  extendsTypes: string[];
  implementsTypes: string[];
  methods: JavaMethodInfo[];
  constructors: JavaMethodInfo[];
  fields: JavaFieldInfo[];
  nestedTypes: JavaTypeInfo[];
  from: number;
  to: number;
}

interface JavaParsedFile {
  text: string;
  index: LineIndex;
  tree: ReturnType<typeof javaParser.parse>;
  packageName: string;
  typeImports: Map<string, string>;
  wildcardImports: string[];
  staticMemberImports: Map<string, { className: string; member: string }>;
  staticWildcardImports: string[];
  types: JavaTypeInfo[];
}

const JAVA_LANG_TYPES = new Set([
  "Object", "String", "CharSequence", "StringBuilder", "StringBuffer",
  "Boolean", "Byte", "Short", "Integer", "Long", "Float", "Double", "Character", "Number", "Void",
  "Math", "StrictMath", "System", "Runtime", "Thread", "Runnable", "Class", "ClassLoader",
  "Enum", "Record", "Iterable", "Comparable", "AutoCloseable", "Cloneable",
  "Throwable", "Exception", "RuntimeException", "Error", "IllegalArgumentException",
  "IllegalStateException", "NullPointerException", "UnsupportedOperationException",
  "IndexOutOfBoundsException", "NumberFormatException", "Override", "Deprecated", "SuppressWarnings",
]);

const EXTERNAL_PACKAGE_PREFIXES = [
  "java.", "javax.", "jakarta.", "sun.", "com.sun.", "org.w3c.", "org.xml.",
  "org.slf4j.", "org.apache.", "org.springframework.", "org.hibernate.",
  "com.alibaba.", "com.fasterxml.", "com.google.", "io.netty.", "lombok.",
  "org.junit.", "net.sf.", "cn.hutool.", "org.mybatis.", "com.baomidou.",
  "redis.clients.", "okhttp3.", "org.json.", "com.sun.", "kotlin.", "scala.",
];

const UBIQUITOUS_METHOD_NAMES = new Set([
  "get", "set", "put", "add", "remove", "clear", "size", "length", "isEmpty", "contains",
  "containsKey", "containsValue", "keySet", "values", "entrySet", "iterator", "stream",
  "toString", "equals", "hashCode", "compareTo", "clone", "valueOf", "of", "format",
  "trim", "split", "replace", "substring", "indexOf", "startsWith", "endsWith", "matches",
  "append", "toArray", "asList", "sort", "forEach", "map", "filter", "collect", "orElse",
  "isPresent", "getMessage", "printStackTrace", "info", "debug", "warn", "error", "trace",
  "getTime", "getId", "setId", "getName", "setName", "getCode", "setCode", "getType", "setType",
  "getString", "getInteger", "getInt", "getLong", "getDouble", "getBoolean", "getJSONObject", "getJSONArray",
]);

const javaParseCache = new Map<string, { text: string; parsed: JavaParsedFile }>();

function nodeText(text: string, node: SyntaxNode | null): string {
  return node ? text.slice(node.from, node.to) : "";
}

function extractSimpleTypeName(text: string, node: SyntaxNode | null): string {
  if (!node) return "";
  switch (node.name) {
    case "TypeName":
    case "PrimitiveType":
    case "void":
    case "Identifier":
      return nodeText(text, node).trim();
    case "GenericType": {
      const base = node.getChild("TypeName") || node.getChild("ScopedTypeName") || node.firstChild;
      return extractSimpleTypeName(text, base);
    }
    case "ArrayType":
      return extractSimpleTypeName(text, node.firstChild);
    case "ScopedTypeName": {
      let last = "";
      for (let child = node.firstChild; child; child = child.nextSibling) {
        if (child.name === "TypeName" || child.name === "Identifier") {
          last = nodeText(text, child).trim();
        }
      }
      return last || nodeText(text, node).split(".").pop()?.trim() || "";
    }
    case "AnnotatedType": {
      for (let child = node.lastChild; child; child = child.prevSibling) {
        if (!child.name.endsWith("Annotation")) {
          const found = extractSimpleTypeName(text, child);
          if (found) return found;
        }
      }
      return "";
    }
    default: {
      const raw = nodeText(text, node).replace(/<.*>/s, "").replace(/\[\]/g, "").trim();
      const parts = raw.split(".");
      return parts[parts.length - 1] || "";
    }
  }
}

function extractTypeList(text: string, container: SyntaxNode | null): string[] {
  if (!container) return [];
  const types: string[] = [];
  const walkList = (node: SyntaxNode) => {
    if (node.name === "TypeName" || node.name === "GenericType" || node.name === "ScopedTypeName") {
      const name = extractSimpleTypeName(text, node);
      if (name) types.push(name);
      return;
    }
    for (let child = node.firstChild; child; child = child.nextSibling) {
      if (child.name === "TypeArguments") continue;
      walkList(child);
    }
  };
  walkList(container);
  return types;
}

function countFormalParams(paramsNode: SyntaxNode | null): { count: number; hasVarargs: boolean } {
  if (!paramsNode) return { count: 0, hasVarargs: false };
  let count = 0;
  let hasVarargs = false;
  for (let child = paramsNode.firstChild; child; child = child.nextSibling) {
    if (child.name === "FormalParameter") count++;
    else if (child.name === "SpreadParameter") { count++; hasVarargs = true; }
  }
  return { count, hasVarargs };
}

function countArguments(argList: SyntaxNode | null): number | undefined {
  if (!argList) return undefined;
  let count = 0;
  for (let child = argList.firstChild; child; child = child.nextSibling) {
    if (child.name === "(" || child.name === ")" || child.name === "," ||
        child.name === "LineComment" || child.name === "BlockComment") continue;
    count++;
  }
  return count;
}

function findTypeBeforeDeclarator(text: string, declNode: SyntaxNode): string {
  for (let child = declNode.firstChild; child; child = child.nextSibling) {
    if (child.name === "Modifiers" || child.name === "TypeParameters" ||
        child.name === "LineComment" || child.name === "BlockComment" ||
        child.name.endsWith("Annotation")) continue;
    if (child.name === "VariableDeclarator" || child.name === "Definition" ||
        child.name === "FormalParameters") break;
    const type = extractSimpleTypeName(text, child);
    if (type) return type;
  }
  return "";
}

function parseJavaType(text: string, node: SyntaxNode): JavaTypeInfo | null {
  const kindMap: Record<string, JavaTypeInfo["kind"]> = {
    ClassDeclaration: "class",
    InterfaceDeclaration: "interface",
    EnumDeclaration: "enum",
    RecordDeclaration: "record",
    AnnotationTypeDeclaration: "annotation",
  };
  const kind = kindMap[node.name];
  if (!kind) return null;
  const def = node.getChild(kind === "annotation" ? "Identifier" : "Definition");
  if (!def) return null;
  const modifiers = node.getChild("Modifiers");
  const isAbstract = kind === "interface" || !!modifiers?.getChild("abstract");
  const extendsTypes: string[] = [];
  const implementsTypes: string[] = [];
  for (let child = node.firstChild; child; child = child.nextSibling) {
    if (child.name === "Superclass" || child.name === "ExtendsInterfaces") {
      extendsTypes.push(...extractTypeList(text, child));
    } else if (child.name === "SuperInterfaces") {
      implementsTypes.push(...extractTypeList(text, child));
    }
  }
  const methods: JavaMethodInfo[] = [];
  const constructors: JavaMethodInfo[] = [];
  const fields: JavaFieldInfo[] = [];
  const nestedTypes: JavaTypeInfo[] = [];

  // Record components act like fields/accessors
  const recordParams = kind === "record" ? node.getChild("FormalParameters") : null;
  if (recordParams) {
    for (let child = recordParams.firstChild; child; child = child.nextSibling) {
      if (child.name !== "FormalParameter") continue;
      const pDef = child.getChild("Definition");
      if (!pDef) continue;
      const pType = findTypeBeforeDeclarator(text, child);
      fields.push({ name: nodeText(text, pDef), nameFrom: pDef.from, nameTo: pDef.to, typeName: pType, from: child.from, to: child.to });
      methods.push({
        name: nodeText(text, pDef), nameFrom: pDef.from, nameTo: pDef.to,
        returnType: pType, paramCount: 0, hasVarargs: false, hasBody: true,
        isStatic: false, isAbstract: false, from: child.from, to: child.to,
      });
    }
  }

  const scanBody = (body: SyntaxNode | null) => {
    if (!body) return;
    for (let child = body.firstChild; child; child = child.nextSibling) {
      if (child.name === "EnumBodyDeclarations") {
        scanBody(child);
        continue;
      }
      if (child.name === "EnumConstant") {
        const cDef = child.getChild("Definition");
        if (cDef) {
          fields.push({
            name: nodeText(text, cDef), nameFrom: cDef.from, nameTo: cDef.to,
            typeName: nodeText(text, def), from: child.from, to: child.to,
          });
        }
        continue;
      }
      if (child.name === "MethodDeclaration") {
        const mDef = child.getChild("Definition");
        if (!mDef) continue;
        const mMods = child.getChild("Modifiers");
        const { count, hasVarargs } = countFormalParams(child.getChild("FormalParameters"));
        const hasBody = !!child.getChild("Block");
        methods.push({
          name: nodeText(text, mDef),
          nameFrom: mDef.from,
          nameTo: mDef.to,
          returnType: findTypeBeforeDeclarator(text, child),
          paramCount: count,
          hasVarargs,
          hasBody,
          isStatic: !!mMods?.getChild("static"),
          isAbstract: !hasBody || !!mMods?.getChild("abstract"),
          from: child.from,
          to: child.to,
        });
      } else if (child.name === "ConstructorDeclaration" || child.name === "CompactConstructorDeclaration") {
        const cDef = child.getChild("Definition");
        if (!cDef) continue;
        const { count, hasVarargs } = countFormalParams(child.getChild("FormalParameters"));
        constructors.push({
          name: nodeText(text, cDef),
          nameFrom: cDef.from,
          nameTo: cDef.to,
          returnType: nodeText(text, def),
          paramCount: count,
          hasVarargs,
          hasBody: true,
          isStatic: false,
          isAbstract: false,
          from: child.from,
          to: child.to,
        });
      } else if (child.name === "FieldDeclaration" || child.name === "ConstantDeclaration") {
        const fType = findTypeBeforeDeclarator(text, child);
        for (let decl = child.firstChild; decl; decl = decl.nextSibling) {
          if (decl.name !== "VariableDeclarator") continue;
          const vDef = decl.getChild("Definition");
          if (!vDef) continue;
          fields.push({
            name: nodeText(text, vDef), nameFrom: vDef.from, nameTo: vDef.to,
            typeName: fType, from: decl.from, to: decl.to,
          });
        }
      } else if (kindMap[child.name]) {
        const nested = parseJavaType(text, child);
        if (nested) nestedTypes.push(nested);
      }
    }
  };

  const body = node.getChild("ClassBody") || node.getChild("InterfaceBody") ||
    node.getChild("EnumBody") || node.getChild("AnnotationTypeBody");
  scanBody(body);

  return {
    kind,
    name: nodeText(text, def),
    nameFrom: def.from,
    nameTo: def.to,
    isAbstract,
    extendsTypes,
    implementsTypes,
    methods,
    constructors,
    fields,
    nestedTypes,
    from: node.from,
    to: node.to,
  };
}

function parseJavaFile(cacheKey: string, text: string): JavaParsedFile {
  const cached = javaParseCache.get(cacheKey);
  if (cached && cached.text === text) return cached.parsed;
  const tree = javaParser.parse(text);
  const index = buildLineIndex(text);
  let packageName = "";
  const typeImports = new Map<string, string>();
  const wildcardImports: string[] = [];
  const staticMemberImports = new Map<string, { className: string; member: string }>();
  const staticWildcardImports: string[] = [];
  const types: JavaTypeInfo[] = [];

  for (let child = tree.topNode.firstChild; child; child = child.nextSibling) {
    if (child.name === "PackageDeclaration") {
      const pkg = child.getChild("ScopedIdentifier") || child.getChild("Identifier");
      if (pkg) packageName = nodeText(text, pkg).trim();
    } else if (child.name === "ImportDeclaration") {
      const isStatic = !!child.getChild("static");
      const raw = nodeText(text, child)
        .replace(/^import\s+/, "")
        .replace(/^static\s+/, "")
        .replace(/;\s*$/, "")
        .trim();
      if (!raw) continue;
      if (raw.endsWith(".*")) {
        const base = raw.slice(0, -2);
        if (isStatic) staticWildcardImports.push(base);
        else wildcardImports.push(base);
      } else {
        const dot = raw.lastIndexOf(".");
        if (dot > 0) {
          const tail = raw.slice(dot + 1);
          const head = raw.slice(0, dot);
          if (isStatic) staticMemberImports.set(tail, { className: head, member: tail });
          else typeImports.set(tail, raw);
        }
      }
    } else {
      const parsedType = parseJavaType(text, child);
      if (parsedType) types.push(parsedType);
    }
  }

  const parsed: JavaParsedFile = {
    text, index, tree, packageName,
    typeImports, wildcardImports, staticMemberImports, staticWildcardImports, types,
  };
  if (javaParseCache.size > 120) {
    const firstKey = javaParseCache.keys().next().value;
    if (firstKey !== undefined) javaParseCache.delete(firstKey);
  }
  javaParseCache.set(cacheKey, { text, parsed });
  return parsed;
}

function findEnclosingTypes(types: JavaTypeInfo[], offset: number): JavaTypeInfo[] {
  for (const type of types) {
    if (offset >= type.from && offset <= type.to) {
      return [type, ...findEnclosingTypes(type.nestedTypes, offset)];
    }
  }
  return [];
}

function findNestedType(types: JavaTypeInfo[], name: string): JavaTypeInfo | undefined {
  for (const type of types) {
    if (type.name === name) return type;
    const nested = findNestedType(type.nestedTypes, name);
    if (nested) return nested;
  }
  return undefined;
}

function matchMethods(methods: JavaMethodInfo[], name: string, argCount?: number): JavaMethodInfo[] {
  const byName = methods.filter((method) => method.name === name);
  if (byName.length <= 1 || argCount === undefined) return byName;
  const exact = byName.filter((method) => !method.hasVarargs && method.paramCount === argCount);
  if (exact.length) return exact;
  const varargs = byName.filter((method) => method.hasVarargs && argCount >= method.paramCount - 1);
  if (varargs.length) return varargs;
  return byName;
}

interface LocalBinding {
  name: string;
  typeName: string;
  nameFrom: number;
  nameTo: number;
  initNode?: SyntaxNode | null;
}

function findLocalBinding(parsed: JavaParsedFile, offset: number, name: string): LocalBinding | null {
  let cursor: SyntaxNode | null = parsed.tree.resolveInner(offset, -1);
  while (cursor) {
    if (cursor.name === "ClassBody" || cursor.name === "InterfaceBody" ||
        cursor.name === "EnumBody" || cursor.name === "Program") break;

    if (cursor.name === "Block" || cursor.name === "SwitchBlock" || cursor.name === "SwitchRule") {
      // Search direct local declarations preceding offset inside this block
      let found: LocalBinding | null = null;
      for (let stmt = cursor.firstChild; stmt; stmt = stmt.nextSibling) {
        if (stmt.from > offset) break;
        if (stmt.name === "LocalVariableDeclaration") {
          const typeName = findTypeBeforeDeclarator(parsed.text, stmt);
          for (let decl = stmt.firstChild; decl; decl = decl.nextSibling) {
            if (decl.name !== "VariableDeclarator") continue;
            const vDef = decl.getChild("Definition");
            if (vDef && nodeText(parsed.text, vDef) === name && vDef.from <= offset) {
              const assign = decl.getChild("AssignOp");
              found = {
                name, typeName, nameFrom: vDef.from, nameTo: vDef.to,
                initNode: assign?.nextSibling || null,
              };
            }
          }
        }
      }
      if (found) return found;
    } else if (cursor.name === "EnhancedForStatement") {
      const spec = cursor.getChild("ForSpec");
      const vDef = spec?.getChild("Definition");
      if (vDef && nodeText(parsed.text, vDef) === name) {
        const typeName = spec ? findTypeBeforeDeclarator(parsed.text, spec) : "";
        return { name, typeName, nameFrom: vDef.from, nameTo: vDef.to };
      }
    } else if (cursor.name === "ForStatement") {
      const spec = cursor.getChild("ForSpec");
      const decl = spec?.getChild("LocalVariableDeclaration");
      if (decl) {
        const typeName = findTypeBeforeDeclarator(parsed.text, decl);
        for (let d = decl.firstChild; d; d = d.nextSibling) {
          if (d.name !== "VariableDeclarator") continue;
          const vDef = d.getChild("Definition");
          if (vDef && nodeText(parsed.text, vDef) === name) {
            const assign = d.getChild("AssignOp");
            return { name, typeName, nameFrom: vDef.from, nameTo: vDef.to, initNode: assign?.nextSibling || null };
          }
        }
      }
    } else if (cursor.name === "CatchClause") {
      const param = cursor.getChild("CatchFormalParameter");
      const vDef = param?.getChild("Definition");
      if (vDef && nodeText(parsed.text, vDef) === name) {
        const catchType = param?.getChild("CatchType");
        const firstType = catchType?.firstChild || null;
        return { name, typeName: extractSimpleTypeName(parsed.text, firstType), nameFrom: vDef.from, nameTo: vDef.to };
      }
    } else if (cursor.name === "TryWithResourcesStatement") {
      const spec = cursor.getChild("ResourceSpecification");
      if (spec) {
        for (let res = spec.firstChild; res; res = res.nextSibling) {
          if (res.name !== "Resource") continue;
          const vDef = res.getChild("Definition");
          if (vDef && nodeText(parsed.text, vDef) === name) {
            const typeName = findTypeBeforeDeclarator(parsed.text, res);
            const assign = res.getChild("AssignOp");
            return { name, typeName, nameFrom: vDef.from, nameTo: vDef.to, initNode: assign?.nextSibling || null };
          }
        }
      }
    } else if (cursor.name === "MethodDeclaration" || cursor.name === "ConstructorDeclaration") {
      const params = cursor.getChild("FormalParameters");
      if (params) {
        for (let param = params.firstChild; param; param = param.nextSibling) {
          if (param.name === "FormalParameter") {
            const vDef = param.getChild("Definition");
            if (vDef && nodeText(parsed.text, vDef) === name) {
              return { name, typeName: findTypeBeforeDeclarator(parsed.text, param), nameFrom: vDef.from, nameTo: vDef.to };
            }
          } else if (param.name === "SpreadParameter") {
            const decl = param.getChild("VariableDeclarator");
            const vDef = decl?.getChild("Definition");
            if (vDef && nodeText(parsed.text, vDef) === name) {
              return { name, typeName: findTypeBeforeDeclarator(parsed.text, param), nameFrom: vDef.from, nameTo: vDef.to };
            }
          }
        }
      }
    }
    cursor = cursor.parent;
  }
  return null;
}

class ProjectJavaIndex {
  private byBase = new Map<string, string[]>();
  private suffixList: { lower: string; file: string }[] = [];

  constructor(files: string[]) {
    for (const file of files) {
      if (!/\.java$/i.test(file)) continue;
      const normalized = normalizeRelative(file);
      const lower = normalized.toLowerCase();
      const base = lower.slice(lower.lastIndexOf("/") + 1);
      const bucket = this.byBase.get(base);
      if (bucket) bucket.push(normalized);
      else this.byBase.set(base, [normalized]);
      this.suffixList.push({ lower, file: normalized });
    }
  }

  findByQualified(qualified: string): string | undefined {
    const suffix = "/" + qualified.replaceAll(".", "/").toLowerCase() + ".java";
    const exact = qualified.replaceAll(".", "/").toLowerCase() + ".java";
    const base = qualified.split(".").pop()?.toLowerCase() + ".java";
    const candidates = this.byBase.get(base) || [];
    for (const file of candidates) {
      const lower = file.toLowerCase();
      if (lower === exact || lower.endsWith(suffix)) return file;
    }
    return undefined;
  }

  resolveTypeFile(
    typeName: string,
    parsed: JavaParsedFile,
    currentFile: string,
  ): { file?: string; external?: boolean; qualified?: string } {
    const clean = typeName.replace(/<.*>/s, "").replace(/\[\]/g, "").trim();
    if (!clean) return {};
    const topName = clean.split(".")[0];

    const exactImport = parsed.typeImports.get(topName);
    if (exactImport) {
      const hit = this.findByQualified(exactImport);
      if (hit) return { file: hit, qualified: exactImport };
      // Nested class import like com.foo.Outer.Inner -> Outer.java
      const parts = exactImport.split(".");
      for (let i = parts.length - 1; i >= 1; i--) {
        if (/^[A-Z]/.test(parts[i - 1])) {
          const outerHit = this.findByQualified(parts.slice(0, i).join("."));
          if (outerHit) return { file: outerHit, qualified: exactImport };
        }
      }
      if (EXTERNAL_PACKAGE_PREFIXES.some((prefix) => exactImport.startsWith(prefix))) {
        return { external: true, qualified: exactImport };
      }
      return { external: true, qualified: exactImport };
    }

    if (parsed.packageName) {
      const samePkg = this.findByQualified(`${parsed.packageName}.${topName}`);
      if (samePkg) return { file: samePkg, qualified: `${parsed.packageName}.${topName}` };
    }

    for (const pkg of parsed.wildcardImports) {
      const hit = this.findByQualified(`${pkg}.${topName}`);
      if (hit) return { file: hit, qualified: `${pkg}.${topName}` };
    }

    if (JAVA_LANG_TYPES.has(topName)) {
      return { external: true, qualified: `java.lang.${topName}` };
    }

    // Fallback: search by basename in project files
    const matches = this.byBase.get(`${topName.toLowerCase()}.java`) || [];
    if (matches.length === 1) return { file: matches[0] };
    if (matches.length > 1) {
      const currentParts = normalizeRelative(currentFile).toLowerCase().split("/");
      let best = matches[0];
      let bestCommon = -1;
      for (const candidate of matches) {
        const parts = candidate.toLowerCase().split("/");
        let common = 0;
        while (common < currentParts.length - 1 && common < parts.length - 1 && currentParts[common] === parts[common]) {
          common++;
        }
        if (common > bestCommon) { bestCommon = common; best = candidate; }
      }
      return { file: best };
    }

    // Check wildcard imports against external prefixes
    if (parsed.wildcardImports.some((pkg) => EXTERNAL_PACKAGE_PREFIXES.some((prefix) => `${pkg}.`.startsWith(prefix)))) {
      return { external: true };
    }
    return {};
  }

  findConventionImpl(interfaceName: string): string[] {
    return this.byBase.get(`${interfaceName.toLowerCase()}impl.java`) || [];
  }
}

const javaIndexCache = new WeakMap<string[], ProjectJavaIndex>();

async function getJavaIndex(editorFiles: EditorFiles, root: string): Promise<ProjectJavaIndex> {
  const files = await editorFiles.files(root);
  let index = javaIndexCache.get(files);
  if (!index) {
    index = new ProjectJavaIndex(files);
    javaIndexCache.set(files, index);
  }
  return index;
}

async function readParsedJava(
  editorFiles: EditorFiles,
  root: string,
  file: string,
  currentFile: string,
  currentParsed: JavaParsedFile,
): Promise<JavaParsedFile | null> {
  if (sameRelativeFile(file, currentFile)) return currentParsed;
  try {
    const disk = await editorFiles.read(root, file);
    return parseJavaFile(`${path.resolve(root).toLowerCase()}::${normalizeRelative(file).toLowerCase()}::${disk.version}`, disk.text);
  } catch {
    return null;
  }
}

function javaIdentifierAt(parsed: JavaParsedFile, offset: number): SyntaxNode | null {
  const candidates = [parsed.tree.resolveInner(offset, -1), parsed.tree.resolveInner(offset, 1)];
  for (const node of candidates) {
    if (!node) continue;
    if (node.name === "Identifier" || node.name === "Definition" || node.name === "TypeName") {
      if (offset >= node.from && offset <= node.to) return node;
    }
  }
  return null;
}

function getInvocationReceiver(invocation: SyntaxNode): SyntaxNode | null {
  let prev: SyntaxNode | null = null;
  for (let child = invocation.firstChild; child; child = child.nextSibling) {
    if (child.name === ".") return prev;
    if (child.name === "MethodName") return null;
    if (child.name !== "LineComment" && child.name !== "BlockComment") prev = child;
  }
  return null;
}

function getFieldAccessReceiver(access: SyntaxNode): SyntaxNode | null {
  let prev: SyntaxNode | null = null;
  for (let child = access.firstChild; child; child = child.nextSibling) {
    if (child.name === ".") return prev;
    if (child.name !== "LineComment" && child.name !== "BlockComment") prev = child;
  }
  return null;
}

function getMethodRefParts(ref: SyntaxNode): { receiver: SyntaxNode | null; member: SyntaxNode | null } {
  const items: SyntaxNode[] = [];
  for (let child = ref.firstChild; child; child = child.nextSibling) {
    if (child.name === "::" || child.name === "TypeArguments" ||
        child.name === "LineComment" || child.name === "BlockComment") continue;
    items.push(child);
  }
  if (items.length >= 2) return { receiver: items[0], member: items[items.length - 1] };
  return { receiver: null, member: items[0] || null };
}

function dedupeTargets(targets: CodeJumpTarget[]): CodeJumpTarget[] {
  const seen = new Set<string>();
  const result: CodeJumpTarget[] = [];
  for (const target of targets) {
    const key = `${(target.uri || target.file).toLowerCase()}:${target.line}:${target.column}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(target);
  }
  return result;
}

async function resolveJavaNavigation(
  request: NavigationRequest,
  editorFiles: EditorFiles,
  lspResolver?: LspResolver,
): Promise<CodeResolveResult> {
  const kind: NavigationKind = request.kind || "definition";
  const cacheKey = `buf::${path.resolve(request.root).toLowerCase()}::${normalizeRelative(request.file).toLowerCase()}`;
  const parsed = parseJavaFile(cacheKey, request.text);
  const offset = positionToOffset(parsed.index, request.line, request.column);
  const ident = javaIdentifierAt(parsed, offset);
  if (!ident) return { symbol: "", targets: [], source: "ast" };

  const symbol = nodeText(parsed.text, ident);
  if (!/^[A-Za-z_$][\w$]*$/.test(symbol)) return { symbol: "", targets: [], source: "ast" };

  const enclosingChain = findEnclosingTypes(parsed.types, offset);
  const enclosingType = enclosingChain[enclosingChain.length - 1] || parsed.types[0];
  let javaIndexPromise: Promise<ProjectJavaIndex> | undefined;
  const loadJavaIndex = () => (javaIndexPromise ??= getJavaIndex(editorFiles, request.root));

  const methodTarget = (
    file: string,
    fileParsed: JavaParsedFile,
    method: JavaMethodInfo,
    role?: CodeJumpTarget["role"],
  ): CodeJumpTarget => {
    const pos = offsetToPosition(fileParsed.index, method.nameFrom);
    return makeTarget(request.file, file, pos.line, pos.column, snippetAt(fileParsed.index, pos.line), role);
  };

  const fieldTarget = (
    file: string,
    fileParsed: JavaParsedFile,
    field: JavaFieldInfo,
    role?: CodeJumpTarget["role"],
  ): CodeJumpTarget => {
    const pos = offsetToPosition(fileParsed.index, field.nameFrom);
    return makeTarget(request.file, file, pos.line, pos.column, snippetAt(fileParsed.index, pos.line), role);
  };

  const typeTarget = (
    file: string,
    fileParsed: JavaParsedFile,
    type: JavaTypeInfo,
    role?: CodeJumpTarget["role"],
  ): CodeJumpTarget => {
    const pos = offsetToPosition(fileParsed.index, type.nameFrom);
    return makeTarget(request.file, file, pos.line, pos.column, snippetAt(fileParsed.index, pos.line), role);
  };

  const findMethodInHierarchy = async (
    file: string,
    fileParsed: JavaParsedFile,
    typeName: string | undefined,
    methodName: string,
    argCount: number | undefined,
    visited: Set<string>,
    depth: number,
  ): Promise<{ file: string; parsed: JavaParsedFile; type: JavaTypeInfo; methods: JavaMethodInfo[] }[]> => {
    if (depth > 8) return [];
    const key = `${normalizeRelative(file).toLowerCase()}#${typeName || "*"}`;
    if (visited.has(key)) return [];
    visited.add(key);

    const targetType = (typeName ? findNestedType(fileParsed.types, typeName) : undefined) || fileParsed.types[0];
    if (!targetType) return [];

    const matched = matchMethods(targetType.methods, methodName, argCount);
    if (matched.length) return [{ file, parsed: fileParsed, type: targetType, methods: matched }];

    const parents = [...targetType.extendsTypes, ...targetType.implementsTypes];
    const results: { file: string; parsed: JavaParsedFile; type: JavaTypeInfo; methods: JavaMethodInfo[] }[] = [];
    for (const parentName of parents) {
      const localNested = findNestedType(fileParsed.types, parentName);
      if (localNested) {
        results.push(...await findMethodInHierarchy(file, fileParsed, localNested.name, methodName, argCount, visited, depth + 1));
        continue;
      }
      const resolved = (await loadJavaIndex()).resolveTypeFile(parentName, fileParsed, file);
      if (!resolved.file) continue;
      const parentParsed = await readParsedJava(editorFiles, request.root, resolved.file, request.file, parsed);
      if (!parentParsed) continue;
      results.push(...await findMethodInHierarchy(resolved.file, parentParsed, parentName, methodName, argCount, visited, depth + 1));
      if (results.length) break;
    }
    return results;
  };

  const findFieldInHierarchy = async (
    file: string,
    fileParsed: JavaParsedFile,
    typeName: string | undefined,
    fieldName: string,
    visited: Set<string>,
    depth: number,
  ): Promise<{ file: string; parsed: JavaParsedFile; field: JavaFieldInfo } | null> => {
    if (depth > 8) return null;
    const key = `${normalizeRelative(file).toLowerCase()}#${typeName || "*"}`;
    if (visited.has(key)) return null;
    visited.add(key);

    const targetType = (typeName ? findNestedType(fileParsed.types, typeName) : undefined) || fileParsed.types[0];
    if (!targetType) return null;
    const direct = targetType.fields.find((field) => field.name === fieldName);
    if (direct) return { file, parsed: fileParsed, field: direct };

    for (const parentName of [...targetType.extendsTypes, ...targetType.implementsTypes]) {
      const resolved = (await loadJavaIndex()).resolveTypeFile(parentName, fileParsed, file);
      if (!resolved.file) continue;
      const parentParsed = await readParsedJava(editorFiles, request.root, resolved.file, request.file, parsed);
      if (!parentParsed) continue;
      const inherited = await findFieldInHierarchy(resolved.file, parentParsed, parentName, fieldName, visited, depth + 1);
      if (inherited) return inherited;
    }
    return null;
  };

  const findImplementations = async (
    baseTypeName: string,
    methodName?: string,
    argCount?: number,
  ): Promise<CodeJumpTarget[]> => {
    const candidateFiles = new Set<string>((await loadJavaIndex()).findConventionImpl(baseTypeName));
    try {
      const hits = await editorFiles.quickSearch(request.root, baseTypeName, 120, ["java"]);
      for (const hit of hits) {
        if (/\b(?:implements|extends)\b/.test(hit.text)) {
          candidateFiles.add(normalizeRelative(hit.file));
        }
      }
    } catch { /* Ripgrep optional */ }

    const implTargets: CodeJumpTarget[] = [];
    for (const candidate of candidateFiles) {
      const candParsed = await readParsedJava(editorFiles, request.root, candidate, request.file, parsed);
      if (!candParsed) continue;
      const scanTypes = (list: JavaTypeInfo[]) => {
        for (const type of list) {
          const matchesBase = type.implementsTypes.includes(baseTypeName) || type.extendsTypes.includes(baseTypeName);
          if (matchesBase && type.kind !== "interface") {
            if (methodName) {
              const matched = matchMethods(type.methods, methodName, argCount).filter((m) => m.hasBody);
              for (const m of matched) {
                implTargets.push(methodTarget(candidate, candParsed, m, "implementation"));
              }
            } else if (!type.isAbstract) {
              implTargets.push(typeTarget(candidate, candParsed, type, "implementation"));
            }
          }
          scanTypes(type.nestedTypes);
        }
      };
      scanTypes(candParsed.types);
    }
    return dedupeTargets(implTargets);
  };

  const inferExprType = async (
    expr: SyntaxNode | null,
    depth: number,
  ): Promise<{ typeName?: string; file?: string; parsed?: JavaParsedFile; external?: boolean }> => {
    if (!expr || depth > 3) return {};
    if (expr.name === "ParenthesizedExpression") {
      for (let child = expr.firstChild; child; child = child.nextSibling) {
        if (child.name !== "(" && child.name !== ")") return inferExprType(child, depth + 1);
      }
      return {};
    }
    if (expr.name === "CastExpression") {
      for (let child = expr.firstChild; child; child = child.nextSibling) {
        if (child.name === "(" || child.name === ")") continue;
        const t = extractSimpleTypeName(parsed.text, child);
        if (t) {
          const resolved = (await loadJavaIndex()).resolveTypeFile(t, parsed, request.file);
          const p = resolved.file ? await readParsedJava(editorFiles, request.root, resolved.file, request.file, parsed) : null;
          return { typeName: t, file: resolved.file, parsed: p || undefined, external: resolved.external };
        }
        break;
      }
      return {};
    }
    if (expr.name === "this") {
      return { typeName: enclosingType?.name, file: request.file, parsed };
    }
    if (expr.name === "super") {
      const superName = enclosingType?.extendsTypes[0];
      if (!superName) return {};
      const resolved = (await loadJavaIndex()).resolveTypeFile(superName, parsed, request.file);
      const p = resolved.file ? await readParsedJava(editorFiles, request.root, resolved.file, request.file, parsed) : null;
      return { typeName: superName, file: resolved.file, parsed: p || undefined, external: resolved.external };
    }
    if (expr.name === "ObjectCreationExpression") {
      for (let child = expr.firstChild; child; child = child.nextSibling) {
        if (child.name === "TypeName" || child.name === "GenericType" || child.name === "ScopedTypeName") {
          const t = extractSimpleTypeName(parsed.text, child);
          const resolved = (await loadJavaIndex()).resolveTypeFile(t, parsed, request.file);
          const p = resolved.file ? await readParsedJava(editorFiles, request.root, resolved.file, request.file, parsed) : null;
          return { typeName: t, file: resolved.file, parsed: p || undefined, external: resolved.external };
        }
      }
      return {};
    }
    if (expr.name === "Identifier" || expr.name === "TypeName") {
      const name = nodeText(parsed.text, expr);
      // 1. Local variable / parameter
      const local = findLocalBinding(parsed, expr.from, name);
      if (local) {
        if (local.typeName === "var" && local.initNode) return inferExprType(local.initNode, depth + 1);
        if (local.typeName) {
          const localNested = findNestedType(parsed.types, local.typeName);
          if (localNested) return { typeName: localNested.name, file: request.file, parsed };
          const resolved = (await loadJavaIndex()).resolveTypeFile(local.typeName, parsed, request.file);
          const p = resolved.file ? await readParsedJava(editorFiles, request.root, resolved.file, request.file, parsed) : null;
          return { typeName: local.typeName, file: resolved.file, parsed: p || undefined, external: resolved.external };
        }
      }
      // 2. Enclosing class (or outer class / superclass) field
      for (let i = enclosingChain.length - 1; i >= 0; i--) {
        const directField = enclosingChain[i].fields.find((f) => f.name === name);
        if (directField?.typeName) {
          const localNested = findNestedType(parsed.types, directField.typeName);
          if (localNested) return { typeName: localNested.name, file: request.file, parsed };
          const resolved = (await loadJavaIndex()).resolveTypeFile(directField.typeName, parsed, request.file);
          const p = resolved.file ? await readParsedJava(editorFiles, request.root, resolved.file, request.file, parsed) : null;
          return { typeName: directField.typeName, file: resolved.file, parsed: p || undefined, external: resolved.external };
        }
      }
      if (enclosingType) {
        const inherited = await findFieldInHierarchy(request.file, parsed, enclosingType.name, name, new Set(), 0);
        if (inherited?.field.typeName) {
          const resolved = (await loadJavaIndex()).resolveTypeFile(inherited.field.typeName, inherited.parsed, inherited.file);
          const p = resolved.file ? await readParsedJava(editorFiles, request.root, resolved.file, request.file, parsed) : null;
          return { typeName: inherited.field.typeName, file: resolved.file, parsed: p || undefined, external: resolved.external };
        }
      }
      // 3. Static / type name (e.g. CollectionUtils)
      const localNested = findNestedType(parsed.types, name);
      if (localNested) return { typeName: localNested.name, file: request.file, parsed };
      const resolved = (await loadJavaIndex()).resolveTypeFile(name, parsed, request.file);
      if (resolved.file || resolved.external) {
        const p = resolved.file ? await readParsedJava(editorFiles, request.root, resolved.file, request.file, parsed) : null;
        return { typeName: name, file: resolved.file, parsed: p || undefined, external: resolved.external };
      }
      return {};
    }
    if (expr.name === "FieldAccess") {
      const recv = getFieldAccessReceiver(expr);
      const member = expr.lastChild;
      if (!recv || !member || member.name !== "Identifier") return {};
      const recvInfo = await inferExprType(recv, depth + 1);
      if (!recvInfo.file || !recvInfo.parsed) return { external: recvInfo.external };
      const field = await findFieldInHierarchy(recvInfo.file, recvInfo.parsed, recvInfo.typeName, nodeText(parsed.text, member), new Set(), 0);
      if (!field?.field.typeName) return {};
      const resolved = (await loadJavaIndex()).resolveTypeFile(field.field.typeName, field.parsed, field.file);
      const p = resolved.file ? await readParsedJava(editorFiles, request.root, resolved.file, request.file, parsed) : null;
      return { typeName: field.field.typeName, file: resolved.file, parsed: p || undefined, external: resolved.external };
    }
    if (expr.name === "MethodInvocation") {
      const methodNameNode = expr.getChild("MethodName");
      const mName = nodeText(parsed.text, methodNameNode);
      if (!mName) return {};
      const argCount = countArguments(expr.getChild("ArgumentList"));
      const recv = getInvocationReceiver(expr);
      let hits: { file: string; parsed: JavaParsedFile; type: JavaTypeInfo; methods: JavaMethodInfo[] }[] = [];
      if (recv) {
        const recvInfo = await inferExprType(recv, depth + 1);
        if (!recvInfo.file || !recvInfo.parsed) return { external: recvInfo.external };
        hits = await findMethodInHierarchy(recvInfo.file, recvInfo.parsed, recvInfo.typeName, mName, argCount, new Set(), 0);
      } else if (enclosingType) {
        hits = await findMethodInHierarchy(request.file, parsed, enclosingType.name, mName, argCount, new Set(), 0);
      }
      const retType = hits[0]?.methods[0]?.returnType;
      if (!retType || retType === "void") return {};
      const ownerParsed = hits[0].parsed;
      const ownerFile = hits[0].file;
      const localNested = findNestedType(ownerParsed.types, retType);
      if (localNested) return { typeName: localNested.name, file: ownerFile, parsed: ownerParsed };
      const resolved = (await loadJavaIndex()).resolveTypeFile(retType, ownerParsed, ownerFile);
      const p = resolved.file ? await readParsedJava(editorFiles, request.root, resolved.file, request.file, parsed) : null;
      return { typeName: retType, file: resolved.file, parsed: p || undefined, external: resolved.external };
    }
    return {};
  };

  const queryLsp = async (): Promise<CodeResolveResult | null> => {
    if (!request.allowLsp || !lspResolver) return null;
    try {
      const raw = await lspResolver(kind, request.file, request.text, request.line, request.column);
      if (!raw?.length) return null;
      const resolvedTargets: CodeJumpTarget[] = [];
      const toFile = (uri: string): string => {
        if (uri.startsWith("jdt:")) return `jdt:${uri}`;
        if (!uri.startsWith("file:")) return "";
        try {
          const url = new URL(uri);
          const disk = decodeURIComponent(url.pathname).replace(/^\/([A-Za-z]:)/, "$1").replaceAll("/", "\\");
          const root = path.resolve(request.root).replaceAll("/", "\\").replace(/[\\/]$/, "");
          if (!disk.toLowerCase().startsWith(`${root.toLowerCase()}\\`)) return "";
          return disk.slice(root.length + 1).replaceAll("\\", "/");
        } catch {
          return "";
        }
      };
      for (const entry of raw) {
        const uri = entry.targetUri || entry.uri || "";
        const range = entry.targetSelectionRange || entry.range || entry.targetRange;
        if (!uri || !range) continue;
        const file = toFile(uri);
        if (!file) continue;
        const line = range.start.line + 1;
        const column = range.start.character + 1;
        if (sameRelativeFile(file, request.file) && line === request.line) continue;
        let snippet = "";
        if (sameRelativeFile(file, request.file)) {
          snippet = snippetAt(parsed.index, line);
        } else if (!file.startsWith("jdt:")) {
          const previews = await editorFiles.previews(request.root, [{ file, line }]);
          snippet = previews[0] || "";
        }
        resolvedTargets.push(makeTarget(
          request.file, file, line, column, snippet,
          kind === "implementation" ? "implementation" : "definition",
          uri.startsWith("jdt:") ? uri : undefined,
        ));
      }
      if (!resolvedTargets.length) return null;

      // If LSP definition landed on an interface/abstract method in project sources, also include concrete implementations
      if (kind === "definition" && resolvedTargets.length === 1 && !resolvedTargets[0].uri) {
        const first = resolvedTargets[0];
        if (/\.java$/i.test(first.file) && first.snippet && !first.snippet.includes("{") && first.snippet.includes(";")) {
          const implRaw = await lspResolver("implementation", request.file, request.text, request.line, request.column);
          if (implRaw?.length) {
            const implTargets: CodeJumpTarget[] = [];
            for (const entry of implRaw) {
              const uri = entry.targetUri || entry.uri || "";
              const range = entry.targetSelectionRange || entry.range || entry.targetRange;
              if (!uri || !range) continue;
              const file = toFile(uri);
              if (!file || (sameRelativeFile(file, first.file) && range.start.line + 1 === first.line)) continue;
              const line = range.start.line + 1;
              const column = range.start.character + 1;
              const snippet = sameRelativeFile(file, request.file)
                ? snippetAt(parsed.index, line)
                : file.startsWith("jdt:") ? "" : (await editorFiles.previews(request.root, [{ file, line }]))[0] || "";
              implTargets.push(makeTarget(request.file, file, line, column, snippet, "implementation", uri.startsWith("jdt:") ? uri : undefined));
            }
            if (implTargets.length) {
              first.role = "interface";
              return { symbol, targets: dedupeTargets([...implTargets, first]), source: "lsp" };
            }
          }
        }
      }
      return { symbol, targets: dedupeTargets(resolvedTargets), source: "lsp" };
    } catch {
      return null;
    }
  };

  // Helper: enrich interface/abstract method hit with concrete implementations
  const finalizeMethodHits = async (
    hits: { file: string; parsed: JavaParsedFile; type: JavaTypeInfo; methods: JavaMethodInfo[] }[],
    argCount?: number,
    isSuper = false,
  ): Promise<CodeResolveResult> => {
    const concrete: CodeJumpTarget[] = [];
    const abstracts: { target: CodeJumpTarget; typeName: string; methodName: string }[] = [];
    for (const hit of hits) {
      for (const method of hit.methods) {
        // Avoid jumping to self when already on this exact declaration
        if (sameRelativeFile(hit.file, request.file) && offset >= method.nameFrom && offset <= method.nameTo) continue;
        if (!method.hasBody) {
          abstracts.push({
            target: methodTarget(hit.file, hit.parsed, method, "interface"),
            typeName: hit.type.name,
            methodName: method.name,
          });
        } else {
          concrete.push(methodTarget(hit.file, hit.parsed, method, isSuper ? "super" : "definition"));
        }
      }
    }
    if (kind === "implementation") {
      const impls: CodeJumpTarget[] = [];
      for (const item of abstracts) {
        impls.push(...await findImplementations(item.typeName, item.methodName, argCount));
      }
      for (const hit of hits) {
        if (hit.type.kind === "class") {
          impls.push(...await findImplementations(hit.type.name, symbol, argCount));
        }
      }
      const list = dedupeTargets(impls.length ? impls : concrete);
      return {
        symbol, targets: list, source: "ast",
        notice: list.length ? undefined : `未找到 ${symbol} 的具体实现`,
      };
    }
    if (abstracts.length && !concrete.length) {
      const impls: CodeJumpTarget[] = [];
      for (const item of abstracts) {
        impls.push(...await findImplementations(item.typeName, item.methodName, argCount));
      }
      const combined = dedupeTargets([...impls, ...abstracts.map((item) => item.target)]);
      return { symbol, targets: combined, source: "ast" };
    }
    const combined = dedupeTargets([...concrete, ...abstracts.map((item) => item.target)]);
    return { symbol, targets: combined, source: "ast" };
  };

  // --- Syntactic Context Dispatch ---
  const parent = ident.parent;

  // 1. Cursor is on a declaration itself
  if (ident.name === "Definition" || parent?.name === "AnnotationTypeDeclaration") {
    if (parent?.name === "MethodDeclaration" && enclosingType) {
      const decl = enclosingType.methods.find((m) => m.nameFrom === ident.from && m.nameTo === ident.to);
      if (decl && (!decl.hasBody || kind === "implementation")) {
        const impls = await findImplementations(enclosingType.name, decl.name, decl.paramCount);
        if (impls.length) return { symbol, targets: impls, source: "ast" };
        if (kind === "implementation") return { symbol, targets: [], source: "ast", notice: `未找到 ${symbol} 的具体实现` };
      }
    }
    if ((parent?.name === "InterfaceDeclaration" || (parent?.name === "ClassDeclaration" && enclosingType?.isAbstract)) && enclosingType) {
      const impls = await findImplementations(enclosingType.name);
      if (impls.length) return { symbol, targets: impls, source: "ast" };
    }
    return { symbol, targets: [], source: "ast", notice: `当前位置已是 ${symbol} 的定义` };
  }

  // 2. Method Invocation: foo(...), obj.foo(...), Type.<T>foo(...), this.foo(...), super.foo(...)
  const methodNameNode = parent?.name === "MethodName" ? parent : (ident.name === "MethodName" ? ident : null);
  if (methodNameNode && methodNameNode.parent?.name === "MethodInvocation") {
    const invocation = methodNameNode.parent;
    const argCount = countArguments(invocation.getChild("ArgumentList"));
    const receiver = getInvocationReceiver(invocation);

    // 2a. Unqualified or this.foo(...) -> check same-file enclosing classes first (instant!)
    if (!receiver || receiver.name === "this") {
      for (let i = enclosingChain.length - 1; i >= 0; i--) {
        const matched = matchMethods(enclosingChain[i].methods, symbol, argCount);
        if (matched.length) {
          return finalizeMethodHits([{ file: request.file, parsed, type: enclosingChain[i], methods: matched }], argCount);
        }
      }
      // Static imports (import static a.b.C.foo / import static a.b.C.*)
      const staticHit = parsed.staticMemberImports.get(symbol);
      if (staticHit) {
        const targetFile = (await loadJavaIndex()).findByQualified(staticHit.className)
          || (await loadJavaIndex()).resolveTypeFile(staticHit.className.split(".").pop() || "", parsed, request.file).file;
        if (targetFile) {
          const targetParsed = await readParsedJava(editorFiles, request.root, targetFile, request.file, parsed);
          if (targetParsed) {
            const hits = await findMethodInHierarchy(targetFile, targetParsed, undefined, symbol, argCount, new Set(), 0);
            if (hits.length) return finalizeMethodHits(hits, argCount);
          }
        }
      }
      for (const staticOwner of parsed.staticWildcardImports) {
        const targetFile = (await loadJavaIndex()).findByQualified(staticOwner);
        if (!targetFile) continue;
        const targetParsed = await readParsedJava(editorFiles, request.root, targetFile, request.file, parsed);
        if (!targetParsed) continue;
        const hits = await findMethodInHierarchy(targetFile, targetParsed, undefined, symbol, argCount, new Set(), 0);
        if (hits.length) return finalizeMethodHits(hits, argCount);
      }
      // Inherited superclass / interface method (e.g. saveOrUpdate(...) in BaseServiceImpl)
      if (enclosingType) {
        const inherited = await findMethodInHierarchy(request.file, parsed, enclosingType.name, symbol, argCount, new Set(), 0);
        if (inherited.length) return finalizeMethodHits(inherited, argCount, true);
      }
    } else if (receiver.name === "super") {
      if (enclosingType) {
        for (const parentName of [...enclosingType.extendsTypes, ...enclosingType.implementsTypes]) {
          const resolved = (await loadJavaIndex()).resolveTypeFile(parentName, parsed, request.file);
          if (!resolved.file) continue;
          const parentParsed = await readParsedJava(editorFiles, request.root, resolved.file, request.file, parsed);
          if (!parentParsed) continue;
          const hits = await findMethodInHierarchy(resolved.file, parentParsed, parentName, symbol, argCount, new Set(), 0);
          if (hits.length) return finalizeMethodHits(hits, argCount, true);
        }
      }
    } else {
      // Qualified invocation: receiver.method(...)
      // Prefer already-ready LSP if available for cross-file precision, otherwise fast AST
      const recvInfo = await inferExprType(receiver, 0);
      if (recvInfo.file && recvInfo.parsed) {
        const hits = await findMethodInHierarchy(recvInfo.file, recvInfo.parsed, recvInfo.typeName, symbol, argCount, new Set(), 0);
        if (hits.length) return finalizeMethodHits(hits, argCount);
      }
      const lspResult = await queryLsp();
      if (lspResult) return lspResult;
      if (recvInfo.external) {
        return {
          symbol, targets: [], source: "ast",
          notice: `${recvInfo.typeName ? `${recvInfo.typeName}.` : ""}${symbol} 属于外部依赖库，请先打开代码编辑器待 Java 索引就绪后查看`,
        };
      }
    }

    // Try LSP before project-wide search
    const lspResult = await queryLsp();
    if (lspResult) return lspResult;

    // Fallback: project-wide Java method declaration search via ripgrep (verified by AST)
    if (!UBIQUITOUS_METHOD_NAMES.has(symbol) && symbol.length >= 3) {
      const fallback = await searchJavaMethodAcrossProject(request, editorFiles, parsed, symbol, argCount);
      if (fallback.length) return { symbol, targets: fallback, source: "search" };
    }
    return { symbol, targets: [], source: "ast", notice: `未找到 ${symbol} 的定义` };
  }

  // 3. Method Reference: Foo::bar / this::bar
  if (parent?.name === "MethodReference") {
    const { receiver, member } = getMethodRefParts(parent);
    if (member && ident.from >= member.from && ident.to <= member.to) {
      const recvInfo = receiver ? await inferExprType(receiver, 0) : { typeName: enclosingType?.name, file: request.file, parsed };
      if (recvInfo.file && recvInfo.parsed) {
        const hits = await findMethodInHierarchy(recvInfo.file, recvInfo.parsed, recvInfo.typeName, symbol, undefined, new Set(), 0);
        if (hits.length) return finalizeMethodHits(hits, undefined);
      }
      const lspResult = await queryLsp();
      if (lspResult) return lspResult;
      if (recvInfo.external) {
        return { symbol, targets: [], source: "ast", notice: `${recvInfo.typeName || "外部类"}.${symbol} 属于外部依赖库` };
      }
      if (!UBIQUITOUS_METHOD_NAMES.has(symbol) && symbol.length >= 3) {
        const fallback = await searchJavaMethodAcrossProject(request, editorFiles, parsed, symbol, undefined);
        if (fallback.length) return { symbol, targets: fallback, source: "search" };
      }
      return { symbol, targets: [], source: "ast", notice: `未找到 ${symbol} 的定义` };
    }
  }

  // 4. Constructor call: new Foo(...)
  const objectCreation = parent?.name === "ObjectCreationExpression"
    ? parent
    : (parent?.name === "GenericType" && parent.parent?.name === "ObjectCreationExpression" ? parent.parent : null);
  if (objectCreation && ident.name === "TypeName") {
    const argCount = countArguments(objectCreation.getChild("ArgumentList"));
    const localNested = findNestedType(parsed.types, symbol);
    if (localNested) {
      const ctors = matchMethods(localNested.constructors, symbol, argCount);
      const list = ctors.length
        ? ctors.map((c) => methodTarget(request.file, parsed, c, "definition"))
        : [typeTarget(request.file, parsed, localNested, "definition")];
      return { symbol, targets: dedupeTargets(list), source: "ast" };
    }
    const resolved = (await loadJavaIndex()).resolveTypeFile(symbol, parsed, request.file);
    if (resolved.file) {
      const targetParsed = await readParsedJava(editorFiles, request.root, resolved.file, request.file, parsed);
      const targetType = targetParsed ? (findNestedType(targetParsed.types, symbol) || targetParsed.types[0]) : undefined;
      if (targetParsed && targetType) {
        const ctors = matchMethods(targetType.constructors, symbol, argCount);
        const list = ctors.length
          ? ctors.map((c) => methodTarget(resolved.file!, targetParsed, c, "definition"))
          : [typeTarget(resolved.file, targetParsed, targetType, "definition")];
        return { symbol, targets: dedupeTargets(list), source: "ast" };
      }
    }
    const lspResult = await queryLsp();
    if (lspResult) return lspResult;
    if (resolved.external) {
      return { symbol, targets: [], source: "ast", notice: `${symbol} 属于外部依赖库，请先打开代码编辑器待 Java 索引就绪后查看` };
    }
    return { symbol, targets: [], source: "ast", notice: `未找到 ${symbol} 的定义` };
  }

  // 5. Field Access: obj.field / this.field / Constants.FOO
  if (parent?.name === "FieldAccess" && ident === parent.lastChild) {
    const receiver = getFieldAccessReceiver(parent);
    const recvInfo = await inferExprType(receiver, 0);
    if (recvInfo.file && recvInfo.parsed) {
      const hit = await findFieldInHierarchy(recvInfo.file, recvInfo.parsed, recvInfo.typeName, symbol, new Set(), 0);
      if (hit) return { symbol, targets: [fieldTarget(hit.file, hit.parsed, hit.field, "definition")], source: "ast" };
    }
    const lspResult = await queryLsp();
    if (lspResult) return lspResult;
    if (recvInfo.external) {
      return { symbol, targets: [], source: "ast", notice: `${recvInfo.typeName || "外部类"}.${symbol} 属于外部依赖库` };
    }
    return { symbol, targets: [], source: "ast", notice: `未找到 ${symbol} 的定义` };
  }

  // 6. Type Reference (TypeName in declarations, generics, extends, implements, casts, etc.)
  if (ident.name === "TypeName") {
    const localNested = findNestedType(parsed.types, symbol);
    if (localNested) {
      if (kind === "implementation" && (localNested.kind === "interface" || localNested.isAbstract)) {
        const impls = await findImplementations(localNested.name);
        if (impls.length) return { symbol, targets: impls, source: "ast" };
      }
      return { symbol, targets: [typeTarget(request.file, parsed, localNested, "definition")], source: "ast" };
    }
    const resolved = (await loadJavaIndex()).resolveTypeFile(symbol, parsed, request.file);
    if (resolved.file) {
      const targetParsed = await readParsedJava(editorFiles, request.root, resolved.file, request.file, parsed);
      const targetType = targetParsed ? (findNestedType(targetParsed.types, symbol) || targetParsed.types[0]) : undefined;
      if (targetParsed && targetType) {
        if (kind === "implementation" && (targetType.kind === "interface" || targetType.isAbstract)) {
          const impls = await findImplementations(targetType.name);
          if (impls.length) return { symbol, targets: impls, source: "ast" };
        }
        return { symbol, targets: [typeTarget(resolved.file, targetParsed, targetType, "definition")], source: "ast" };
      }
    }
    const lspResult = await queryLsp();
    if (lspResult) return lspResult;
    if (resolved.external) {
      return { symbol, targets: [], source: "ast", notice: `${symbol} 属于外部依赖库，请先打开代码编辑器待 Java 索引就绪后查看` };
    }
    return { symbol, targets: [], source: "ast", notice: `未找到类型 ${symbol} 的定义` };
  }

  // 7. Standalone Identifier (local var / parameter / class field / static import / receiver type name)
  const local = findLocalBinding(parsed, offset, symbol);
  if (local && (offset < local.nameFrom || offset > local.nameTo)) {
    const pos = offsetToPosition(parsed.index, local.nameFrom);
    return {
      symbol,
      targets: [makeTarget(request.file, request.file, pos.line, pos.column, snippetAt(parsed.index, pos.line), "declaration")],
      source: "ast",
    };
  }
  for (let i = enclosingChain.length - 1; i >= 0; i--) {
    const directField = enclosingChain[i].fields.find((f) => f.name === symbol);
    if (directField) {
      return { symbol, targets: [fieldTarget(request.file, parsed, directField, "declaration")], source: "ast" };
    }
  }
  if (enclosingType) {
    const inheritedField = await findFieldInHierarchy(request.file, parsed, enclosingType.name, symbol, new Set(), 0);
    if (inheritedField) {
      return { symbol, targets: [fieldTarget(inheritedField.file, inheritedField.parsed, inheritedField.field, "declaration")], source: "ast" };
    }
  }
  const staticHit = parsed.staticMemberImports.get(symbol);
  if (staticHit) {
    const targetFile = (await loadJavaIndex()).findByQualified(staticHit.className);
    if (targetFile) {
      const targetParsed = await readParsedJava(editorFiles, request.root, targetFile, request.file, parsed);
      if (targetParsed) {
        const field = await findFieldInHierarchy(targetFile, targetParsed, undefined, symbol, new Set(), 0);
        if (field) return { symbol, targets: [fieldTarget(field.file, field.parsed, field.field, "declaration")], source: "ast" };
      }
    }
  }
  // Maybe identifier is a class name (e.g. CollectionUtils in CollectionUtils.convertToMap)
  const typeResolved = (await loadJavaIndex()).resolveTypeFile(symbol, parsed, request.file);
  if (typeResolved.file) {
    const targetParsed = await readParsedJava(editorFiles, request.root, typeResolved.file, request.file, parsed);
    const targetType = targetParsed ? (findNestedType(targetParsed.types, symbol) || targetParsed.types[0]) : undefined;
    if (targetParsed && targetType) {
      return { symbol, targets: [typeTarget(typeResolved.file, targetParsed, targetType, "definition")], source: "ast" };
    }
  }
  const lspResult = await queryLsp();
  if (lspResult) return lspResult;
  if (typeResolved.external) {
    return { symbol, targets: [], source: "ast", notice: `${symbol} 属于外部依赖库，请先打开代码编辑器待 Java 索引就绪后查看` };
  }
  return { symbol, targets: [], source: "ast", notice: `未找到 ${symbol} 的定义` };
}

async function searchJavaMethodAcrossProject(
  request: NavigationRequest,
  editorFiles: EditorFiles,
  currentParsed: JavaParsedFile,
  methodName: string,
  argCount?: number,
): Promise<CodeJumpTarget[]> {
  let hits;
  try {
    hits = await editorFiles.quickSearch(request.root, `${methodName}(`, 160, ["java"]);
  } catch {
    return [];
  }
  const files = [...new Set(hits.map((hit) => normalizeRelative(hit.file)))].slice(0, 40);
  const currentDir = normalizeRelative(request.file).split("/").slice(0, -1).join("/").toLowerCase();
  const ranked: { target: CodeJumpTarget; score: number }[] = [];

  for (const file of files) {
    const fileParsed = await readParsedJava(editorFiles, request.root, file, request.file, currentParsed);
    if (!fileParsed) continue;
    const scanTypes = (types: JavaTypeInfo[]) => {
      for (const type of types) {
        const matched = matchMethods(type.methods, methodName, argCount);
        for (const method of matched) {
          if (sameRelativeFile(file, request.file) && method.nameFrom <= positionToOffset(currentParsed.index, request.line, request.column) &&
              method.nameTo >= positionToOffset(currentParsed.index, request.line, request.column)) continue;
          const pos = offsetToPosition(fileParsed.index, method.nameFrom);
          let score = 50;
          if (sameRelativeFile(file, request.file)) score += 40;
          if (method.hasBody) score += 25;
          if (argCount !== undefined && (!method.hasVarargs ? method.paramCount === argCount : argCount >= method.paramCount - 1)) score += 30;
          if (file.toLowerCase().startsWith(currentDir + "/")) score += 15;
          if (currentParsed.typeImports.has(type.name)) score += 35;
          ranked.push({
            score,
            target: makeTarget(
              request.file, file, pos.line, pos.column,
              snippetAt(fileParsed.index, pos.line),
              method.hasBody ? "definition" : "interface",
            ),
          });
        }
        scanTypes(type.nestedTypes);
      }
    };
    scanTypes(fileParsed.types);
  }
  ranked.sort((a, b) => b.score - a.score || a.target.file.localeCompare(b.target.file) || a.target.line - b.target.line);
  return dedupeTargets(ranked.map((item) => item.target)).slice(0, 30);
}

/* ==========================================================================
   JS / TS / Vue / HTML / JSP 符号定位
   ========================================================================== */

const SCRIPT_EXTENSIONS = ["ts", "tsx", "js", "jsx", "mjs", "cjs", "vue", "html", "htm", "jsp"];
const JS_KEYWORDS = new Set([
  "if", "else", "for", "while", "do", "switch", "case", "default", "break", "continue",
  "return", "throw", "try", "catch", "finally", "new", "delete", "typeof", "void",
  "in", "of", "instanceof", "this", "super", "class", "extends", "function", "async",
  "await", "yield", "import", "export", "from", "as", "const", "let", "var", "true",
  "false", "null", "undefined", "interface", "type", "enum", "public", "private",
  "protected", "readonly", "static", "implements", "get", "set",
]);

function isMarkupFile(file: string): boolean {
  return /\.(?:vue|html|htm|jsp)$/i.test(file);
}

function isScriptFamilyFile(file: string): boolean {
  return /\.(?:ts|tsx|js|jsx|mjs|cjs|vue|html|htm|jsp)$/i.test(file);
}

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

function extractWordAt(lineText: string, column: number): { word: string; start: number; end: number } | null {
  const index = Math.max(0, Math.min(lineText.length, column - 1));
  const isIdent = (ch: string | undefined) => !!ch && /[\w$]/.test(ch);
  let pos = index;
  if (!isIdent(lineText[pos]) && pos > 0 && isIdent(lineText[pos - 1])) pos--;
  if (!isIdent(lineText[pos])) return null;
  let start = pos;
  while (start > 0 && isIdent(lineText[start - 1])) start--;
  let end = pos + 1;
  while (end < lineText.length && isIdent(lineText[end])) end++;
  const word = lineText.slice(start, end);
  if (!/^[A-Za-z_$][\w$]*$/.test(word)) return null;
  return { word, start, end };
}

function templateHandlerAt(lineText: string, column: number): string | null {
  const pattern = /(?:@|v-on:|:)?[\w.:-]+\s*=\s*(["'])([^"']*)\1/g;
  let match: RegExpExecArray | null;
  const at = column - 1;
  while ((match = pattern.exec(lineText))) {
    const equals = lineText.indexOf("=", match.index);
    if (equals >= 0 && at >= match.index && at <= equals) {
      const handler = /^\s*([A-Za-z_$][\w$]*)/.exec(match[2]);
      if (handler) return handler[1];
    }
  }
  return null;
}

function scriptDefinitionScore(line: string, name: string): number {
  const trimmed = line.trim();
  if (!trimmed || /^(?:\/\/|\*|\/\*|<!--|#)/.test(trimmed)) return 0;
  const id = escapeRegExp(name);
  if (!new RegExp(`(^|[^\\w$])${id}(?=[^\\w$]|$)`).test(trimmed)) return 0;
  const pre = "(?:^|[^\\w$])";
  const patterns: [RegExp, number][] = [
    [new RegExp(`${pre}(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?function\\s*\\*?\\s*${id}\\s*(?:<[^>]*>)?\\s*\\(`), 100],
    [new RegExp(`${pre}(?:export\\s+)?(?:const|let|var)\\s+${id}\\s*(?::[^=]+)?=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`), 96],
    [new RegExp(`${pre}${id}\\s*:\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`), 92],
    [new RegExp(`^\\s*(?:export\\s+)?(?:public\\s+|private\\s+|protected\\s+)?(?:static\\s+)?(?:async\\s+)?(?:get\\s+|set\\s+)?${id}\\s*(?:<[^>]*>)?\\s*\\([^;{}]*\\)\\s*(?::[^{;]+)?\\{`), 88],
    [new RegExp(`${pre}(?:export\\s+)?(?:default\\s+)?(?:abstract\\s+)?(?:class|interface|type|enum)\\s+${id}\\b`), 86],
    [new RegExp(`${pre}(?:export\\s+)?(?:const|let|var)\\s+${id}\\s*(?::[^=]+)?=`), 78],
    [new RegExp(`${pre}${id}\\s*=\\s*(?:async\\s*)?(?:function\\b|\\([^)]*\\)\\s*=>|[A-Za-z_$][\\w$]*\\s*=>)`), 82],
  ];
  for (const [pattern, score] of patterns) {
    if (pattern.test(trimmed)) return score;
  }
  return 0;
}

interface ScriptImportBinding {
  local: string;
  imported: string; // "*" for namespace, "default" for default, or named identifier
  specifier: string;
}

function parseScriptImports(text: string): { bindings: ScriptImportBinding[]; scriptSrcs: string[] } {
  const bindings: ScriptImportBinding[] = [];
  const scriptSrcs: string[] = [];

  // ES imports: import Default, { a, b as c } from 'spec' | import * as ns from 'spec'
  const esImport = /import\s+(?:type\s+)?([\s\S]*?)\s+from\s*["']([^"']+)["']/g;
  let match: RegExpExecArray | null;
  while ((match = esImport.exec(text))) {
    const clause = match[1].trim();
    const specifier = match[2].trim();
    if (!clause || !specifier) continue;
    const ns = /\*\s+as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns) bindings.push({ local: ns[1], imported: "*", specifier });
    const named = /\{([\s\S]*?)\}/.exec(clause);
    if (named) {
      for (const entry of named[1].split(",")) {
        const clean = entry.replace(/^\s*type\s+/, "").trim();
        if (!clean) continue;
        const asMatch = /^([A-Za-z_$][\w$]*)\s+as\s+([A-Za-z_$][\w$]*)$/.exec(clean);
        if (asMatch) bindings.push({ local: asMatch[2], imported: asMatch[1], specifier });
        else if (/^[A-Za-z_$][\w$]*$/.test(clean)) bindings.push({ local: clean, imported: clean, specifier });
      }
    }
    const defClause = clause.replace(/\{[\s\S]*?\}/, "").replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, "").replace(/,/g, "").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(defClause)) {
      bindings.push({ local: defClause, imported: "default", specifier });
    }
  }

  // CommonJS require: const { a, b: c } = require('spec') | const x = require('spec')
  const cjsRequire = /(?:const|let|var)\s+(\{[^}]+\}|[A-Za-z_$][\w$]*)\s*=\s*require\(\s*["']([^"']+)["']\s*\)/g;
  while ((match = cjsRequire.exec(text))) {
    const lhs = match[1].trim();
    const specifier = match[2].trim();
    if (lhs.startsWith("{")) {
      for (const entry of lhs.slice(1, -1).split(",")) {
        const clean = entry.trim();
        const alias = /^([A-Za-z_$][\w$]*)\s*:\s*([A-Za-z_$][\w$]*)$/.exec(clean);
        if (alias) bindings.push({ local: alias[2], imported: alias[1], specifier });
        else if (/^[A-Za-z_$][\w$]*$/.test(clean)) bindings.push({ local: clean, imported: clean, specifier });
      }
    } else {
      bindings.push({ local: lhs, imported: "default", specifier });
    }
  }

  // HTML / JSP <script src="...">
  const srcRegex = /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((match = srcRegex.exec(text))) {
    scriptSrcs.push(match[1].trim());
  }

  return { bindings, scriptSrcs };
}

function resolveModuleSpecifier(
  specifier: string,
  currentFile: string,
  projectFileSet: Map<string, string>,
): string | undefined {
  const clean = specifier.split(/[?#]/)[0].trim();
  if (!clean || /^https?:\/\//i.test(clean)) return undefined;
  const bases: string[] = [];
  const currentDir = path.posix.dirname(normalizeRelative(currentFile));
  if (clean.startsWith("./") || clean.startsWith("../")) {
    bases.push(path.posix.normalize(path.posix.join(currentDir, clean)));
  } else if (clean.startsWith("@/")) {
    const rest = clean.slice(2);
    bases.push(`src/${rest}`, rest);
  } else if (clean.startsWith("/")) {
    const rest = clean.slice(1);
    bases.push(rest, `src/${rest}`, `WebRoot/${rest}`, `src/main/webapp/${rest}`);
  } else {
    return undefined;
  }

  const exts = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".vue", "/index.ts", "/index.tsx", "/index.js", "/index.jsx", "/index.vue"];
  for (const base of bases) {
    const normalizedBase = base.replace(/^\/+/, "");
    // Also strip .js -> try .ts when using NodeNext ESM imports
    const candidates = normalizedBase.endsWith(".js")
      ? [normalizedBase.slice(0, -3) + ".ts", normalizedBase.slice(0, -3) + ".tsx", normalizedBase]
      : exts.map((ext) => normalizedBase + ext);
    for (const candidate of candidates) {
      const hit = projectFileSet.get(candidate.toLowerCase());
      if (hit) return hit;
    }
  }
  return undefined;
}

function findDefinitionsInScriptText(
  text: string,
  file: string,
  name: string,
  skipLine?: number,
): { line: number; column: number; snippet: string; score: number }[] {
  const lines = text.split(/\r?\n/);
  const ranges = isMarkupFile(file) ? scriptBlockRanges(lines) : null;
  const hits: { line: number; column: number; snippet: string; score: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1;
    if (skipLine && lineNum === skipLine) continue;
    if (ranges && ranges.length && !ranges.some(([from, to]) => lineNum >= from && lineNum <= to)) continue;
    const score = scriptDefinitionScore(lines[i], name);
    if (!score) continue;
    const colMatch = new RegExp(`(?:^|[^\\w$])(${escapeRegExp(name)})(?=[^\\w$]|$)`).exec(lines[i]);
    const col = colMatch ? colMatch.index + colMatch[0].length - name.length + 1 : Math.max(1, lines[i].indexOf(name) + 1);
    hits.push({ line: lineNum, column: col, snippet: lines[i].trim().slice(0, 200), score });
  }
  return hits.sort((a, b) => b.score - a.score || a.line - b.line);
}

async function resolveScriptNavigation(
  request: NavigationRequest,
  editorFiles: EditorFiles,
): Promise<CodeResolveResult> {
  const index = buildLineIndex(request.text);
  const lineText = index.lines[request.line - 1] || "";
  const wordHit = extractWordAt(lineText, request.column);
  const templateName = isMarkupFile(request.file) ? templateHandlerAt(lineText, request.column) : null;
  const symbol = templateName || wordHit?.word || "";
  if (!symbol || JS_KEYWORDS.has(symbol)) return { symbol: "", targets: [], source: "ast" };

  // Detect qualifier before `.` (e.g. api.getUser or this.handleSave)
  let qualifier = "";
  if (!templateName && wordHit) {
    const prefix = lineText.slice(0, wordHit.start);
    const qualMatch = /([A-Za-z_$][\w$]*)\s*\.\s*$/.exec(prefix);
    if (qualMatch) qualifier = qualMatch[1];
  }

  let fileMapPromise: Promise<Map<string, string>> | undefined;
  const loadFileMap = () => (fileMapPromise ??= editorFiles.files(request.root).then((allFiles) => {
    const map = new Map<string, string>();
    for (const f of allFiles) {
      const norm = normalizeRelative(f);
      map.set(norm.toLowerCase(), norm);
    }
    return map;
  }));
  const { bindings, scriptSrcs } = parseScriptImports(request.text);

  // 1. If cursor is already on this symbol's definition line in the same file
  if (!qualifier && scriptDefinitionScore(lineText, symbol) > 0 && !/^\s*import\b/.test(lineText)) {
    return { symbol, targets: [], source: "ast", notice: `当前位置已是 ${symbol} 的定义` };
  }

  // 2. Qualified call: qualifier.symbol (excluding `this.symbol`)
  if (qualifier && qualifier !== "this") {
    const binding = bindings.find((item) => item.local === qualifier);
    if (binding) {
      const targetFile = resolveModuleSpecifier(binding.specifier, request.file, await loadFileMap());
      if (targetFile) {
        try {
          const disk = await editorFiles.read(request.root, targetFile);
          const defs = findDefinitionsInScriptText(disk.text, targetFile, symbol);
          if (defs.length) {
            return {
              symbol,
              targets: defs.map((d) => makeTarget(request.file, targetFile, d.line, d.column, d.snippet, "definition")),
              source: "ast",
            };
          }
        } catch { /* fall through */ }
      }
    }
  }

  // 3. Unqualified or this.symbol -> check same-file definitions first!
  if (!qualifier || qualifier === "this") {
    const localDefs = findDefinitionsInScriptText(request.text, request.file, symbol, request.line);
    if (localDefs.length) {
      return {
        symbol,
        targets: localDefs.map((d) => makeTarget(request.file, request.file, d.line, d.column, d.snippet, "definition")),
        source: "ast",
      };
    }
    // Check explicit import binding for `symbol`
    const binding = bindings.find((item) => item.local === symbol);
    if (binding) {
      const targetFile = resolveModuleSpecifier(binding.specifier, request.file, await loadFileMap());
      if (targetFile) {
        try {
          const disk = await editorFiles.read(request.root, targetFile);
          if (binding.imported !== "default" && binding.imported !== "*") {
            const defs = findDefinitionsInScriptText(disk.text, targetFile, binding.imported);
            if (defs.length) {
              return {
                symbol,
                targets: defs.map((d) => makeTarget(request.file, targetFile, d.line, d.column, d.snippet, "definition")),
                source: "ast",
              };
            }
          } else {
            const namedDefs = findDefinitionsInScriptText(disk.text, targetFile, symbol);
            if (namedDefs.length) {
              return {
                symbol,
                targets: namedDefs.map((d) => makeTarget(request.file, targetFile, d.line, d.column, d.snippet, "definition")),
                source: "ast",
              };
            }
            const lines = disk.text.split(/\r?\n/);
            const defaultLine = lines.findIndex((l) => /\bexport\s+default\b/.test(l)) + 1;
            const targetLine = defaultLine > 0 ? defaultLine : 1;
            return {
              symbol,
              targets: [makeTarget(request.file, targetFile, targetLine, 1, (lines[targetLine - 1] || "").trim().slice(0, 200), "definition")],
              source: "ast",
            };
          }
        } catch { /* fall through */ }
      }
    }
    // Check <script src="..."> in HTML/JSP
    for (const src of scriptSrcs) {
      const targetFile = resolveModuleSpecifier(src, request.file, await loadFileMap());
      if (!targetFile) continue;
      try {
        const disk = await editorFiles.read(request.root, targetFile);
        const defs = findDefinitionsInScriptText(disk.text, targetFile, symbol);
        if (defs.length) {
          return {
            symbol,
            targets: defs.map((d) => makeTarget(request.file, targetFile, d.line, d.column, d.snippet, "definition")),
            source: "ast",
          };
        }
      } catch { /* ignore */ }
    }
  }

  // 4. Fallback project-wide search via ripgrep
  if (symbol.length >= 2) {
    try {
      const hits = await editorFiles.quickSearch(request.root, symbol, 250, SCRIPT_EXTENSIONS);
      const htmlSource = /\.(?:html|htm|jsp)$/i.test(request.file);
      const ranked: { target: CodeJumpTarget; score: number }[] = [];
      for (const hit of hits) {
        if (/<[a-z][\w-]*\b/i.test(hit.text)) continue;
        if (sameRelativeFile(hit.file, request.file) && hit.line === request.line) continue;
        const score = scriptDefinitionScore(hit.text, symbol);
        if (!score) continue;
        const bonus = sameRelativeFile(hit.file, request.file) ? 20
          : htmlSource ? (/\.(?:js|mjs|cjs|ts|tsx)$/i.test(hit.file) ? 15 : -10) : 0;
        ranked.push({
          score: score + bonus,
          target: makeTarget(request.file, hit.file, hit.line, hit.column, hit.text, "definition"),
        });
      }
      ranked.sort((a, b) => b.score - a.score || a.target.file.localeCompare(b.target.file) || a.target.line - b.target.line);
      if (ranked.length) {
        if (ranked.length > 1 && ranked[0].score - ranked[1].score >= 20) {
          return { symbol, targets: [ranked[0].target], source: "search" };
        }
        return { symbol, targets: dedupeTargets(ranked.map((r) => r.target)).slice(0, 30), source: "search" };
      }
    } catch { /* ignore */ }
  }
  return { symbol, targets: [], source: "ast", notice: `未找到 ${symbol} 的定义` };
}

/* ==========================================================================
   通用入口
   ========================================================================== */

export async function resolveCodeNavigation(
  request: NavigationRequest,
  editorFiles: EditorFiles,
  lspResolver?: LspResolver,
): Promise<CodeResolveResult> {
  if (!request.file || typeof request.text !== "string") {
    return { symbol: "", targets: [], source: "ast" };
  }
  if (/\.java$/i.test(request.file)) {
    return resolveJavaNavigation(request, editorFiles, lspResolver);
  }
  if (isScriptFamilyFile(request.file)) {
    return resolveScriptNavigation(request, editorFiles);
  }
  // Lightweight same-file fallback for other code languages (SQL, Python, Go, Shell, etc.)
  const index = buildLineIndex(request.text);
  const lineText = index.lines[request.line - 1] || "";
  const wordHit = extractWordAt(lineText, request.column);
  if (!wordHit) return { symbol: "", targets: [], source: "ast" };
  const id = escapeRegExp(wordHit.word);
  const genericDecl = new RegExp(`(?:^|\\s)(?:def|func|function|procedure|create\\s+(?:or\\s+replace\\s+)?(?:function|procedure))\\s+${id}\\b`, "i");
  const targets: CodeJumpTarget[] = [];
  for (let i = 0; i < index.lines.length; i++) {
    if (i + 1 === request.line) continue;
    if (genericDecl.test(index.lines[i])) {
      const col = Math.max(1, index.lines[i].indexOf(wordHit.word) + 1);
      targets.push(makeTarget(request.file, request.file, i + 1, col, index.lines[i].trim().slice(0, 200), "definition"));
    }
  }
  return {
    symbol: wordHit.word,
    targets,
    source: "ast",
    notice: targets.length ? undefined : `当前文件类型暂不支持自动跳转 ${wordHit.word}`,
  };
}

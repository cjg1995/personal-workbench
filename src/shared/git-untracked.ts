export interface GitUntrackedFilter {
  include?: string[];
  exclude?: string[];
}

const defaultExclude = ["*.rar", "*.zip", "*.bak", "*.tmp"];
const uniAppInclude = [
  "pages/",
  "components/",
  "api/",
  "static/",
  "store/",
  "utils/",
  "lib/",
  "nativeplugins/",
];

export const defaultUntrackedRuleByProject: Record<
  string,
  { include: string[]; exclude: string[] }
> = {
  homeproject: {
    include: ["src/", "WebRoot/"],
    exclude: [...defaultExclude],
  },
  "homeproject-ai": {
    include: ["src/", "WebRoot/"],
    exclude: [...defaultExclude],
  },
  employee: { include: [...uniAppInclude], exclude: [...defaultExclude] },
  projectman: { include: [...uniAppInclude], exclude: [...defaultExclude] },
  worker: { include: [...uniAppInclude], exclude: [...defaultExclude] },
  driver: { include: [...uniAppInclude], exclude: [...defaultExclude] },
  wecom: {
    include: [
      "pages/",
      "components/",
      "api/",
      "static/",
      "store/",
      "utils/",
      "plugins/",
      "mixins/",
      "uni_modules/",
    ],
    exclude: [...defaultExclude],
  },
  customer: {
    include: [
      "module/",
      "components/",
      "assets/",
      "assets-mdq/",
      "utils/",
      "skin/",
    ],
    exclude: [...defaultExclude],
  },
  refsys: {
    include: ["src/main/", "pom.xml"],
    exclude: [...defaultExclude],
  },
  "refsys-ui": {
    include: ["src/"],
    exclude: [...defaultExclude],
  },
  "refsys-wechat": {
    include: [
      "pages/",
      "components/",
      "api/",
      "static/",
      "store/",
      "utils/",
      "plugins/",
      "uni_modules/",
    ],
    exclude: [...defaultExclude],
  },
};

function escapeRegex(text: string) {
  return text.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
}

function cleanPattern(raw: string) {
  return raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^(?:\.\/)+/, "")
    .replace(/^\/+/, "");
}

export function parseUntrackedInput(text: string): string[] {
  return text
    .split(/[,，\r\n]+/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function formatUntrackedList(entries?: string[]): string {
  return entries?.length ? entries.join(", ") : "";
}

export function normalizeUntrackedPattern(raw: unknown, label: string): string {
  if (typeof raw !== "string") throw new Error(`${label}格式无效`);
  if (/[\0\r\n]/.test(raw)) throw new Error(`${label}不能包含换行或非法控制字符`);
  const trimmed = raw.trim();
  if (!trimmed) return "";
  if (trimmed.length > 500) throw new Error(`${label}单条规则过长`);
  if (/^[a-zA-Z]:/.test(trimmed))
    throw new Error(`${label}必须使用相对路径：${trimmed}`);
  const normalized = cleanPattern(trimmed);
  if (!normalized || normalized === ".")
    throw new Error(`${label}包含无效路径：${trimmed}`);
  if (normalized.split("/").includes(".."))
    throw new Error(`${label}不能包含上级目录（..）：${trimmed}`);
  return normalized;
}

export function normalizeUntrackedList(entries: unknown, label: string): string[] {
  if (!Array.isArray(entries)) throw new Error(`${label}格式无效`);
  if (entries.length > 200) throw new Error(`${label}规则数量过多`);
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of entries) {
    const normalized = normalizeUntrackedPattern(item, label);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    result.push(normalized);
  }
  return result;
}

export function compileUntrackedPattern(
  pattern: string,
  caseInsensitive: boolean,
): (file: string) => boolean {
  const normalized = cleanPattern(pattern);
  if (!normalized) return () => false;
  if (normalized === "*" || normalized === "**") return () => true;

  if (!normalized.includes("*")) {
    const rule = caseInsensitive ? normalized.toLowerCase() : normalized;
    const isDir = rule.endsWith("/");
    return (file: string) => {
      const target = caseInsensitive ? file.toLowerCase() : file;
      return isDir ? target.startsWith(rule) : target === rule;
    };
  }

  const flags = caseInsensitive ? "i" : "";
  if (!normalized.includes("/")) {
    const body = normalized
      .replace(/\*+/g, "*")
      .split("*")
      .map(escapeRegex)
      .join(".*");
    const regex = new RegExp(`^${body}$`, flags);
    return (file: string) => {
      const slash = file.lastIndexOf("/");
      const basename = slash >= 0 ? file.slice(slash + 1) : file;
      return regex.test(basename);
    };
  }

  let body = "";
  for (let i = 0; i < normalized.length; ) {
    if (normalized.startsWith("**/", i)) {
      body += "(?:.+/)?";
      i += 3;
    } else if (normalized.startsWith("**", i)) {
      body += ".*";
      i += 2;
    } else if (normalized[i] === "*") {
      body += "[^/]*";
      i += 1;
    } else {
      body += escapeRegex(normalized[i]);
      i += 1;
    }
  }
  const suffix = normalized.endsWith("/") ? ".*" : "";
  const regex = new RegExp(`^${body}${suffix}$`, flags);
  return (file: string) => regex.test(file);
}

export function compileUntrackedMatchers(
  patterns: string[] | undefined,
  caseInsensitive: boolean,
): ((file: string) => boolean)[] | undefined {
  if (!patterns?.length) return undefined;
  const matchers = patterns
    .map((pattern) => cleanPattern(pattern))
    .filter(Boolean)
    .map((pattern) => compileUntrackedPattern(pattern, caseInsensitive));
  return matchers.length ? matchers : undefined;
}

export function isMatchAllPattern(pattern: string): boolean {
  const normalized = cleanPattern(pattern);
  return normalized === "*" || normalized === "**";
}

export function describeUntrackedRule(filter?: GitUntrackedFilter): string {
  const include = filter?.include?.filter(Boolean) || [];
  const exclude = filter?.exclude?.filter(Boolean) || [];
  if (exclude.some(isMatchAllPattern)) {
    return "当前项目已配置隐藏全部未跟踪文件。";
  }
  const base = include.length
    ? include.some(isMatchAllPattern)
      ? "当前项目默认显示全部未跟踪文件"
      : `当前项目仅显示指定范围内的未跟踪文件（${include.join("、")}）`
    : "项目根目录及全新子目录中的未跟踪文件默认隐藏";
  return exclude.length ? `${base}；已排除：${exclude.join("、")}。` : `${base}。`;
}

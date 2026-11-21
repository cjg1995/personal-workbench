export interface PromptToken {
  raw: string;
  name?: string;
  offset: number;
  length: number;
}

const VARIABLE_PATTERN = /(?<!\{)\{\{([^{}\r\n]+)\}\}(?!\})/gu;

/**
 * Single-pass template tokenizer:
 * - Recognizes {{name}} on a single line with non-empty trimmed name and no inner braces.
 * - Trims leading/trailing whitespace inside braces so {{项目名称}} and {{ 项目名称 }} share the same name.
 * - Leaves empty placeholders, malformed markers, multiline braces, and ordinary code braces as raw text.
 */
export function tokenizePrompt(body: string): PromptToken[] {
  const text = typeof body === "string" ? body : "";
  const result: PromptToken[] = [];
  let cursor = 0;
  for (const match of text.matchAll(VARIABLE_PATTERN)) {
    const index = match.index ?? 0;
    const raw = match[0];
    const name = match[1].trim();
    if (!name) continue;
    if (index > cursor) {
      const plain = text.slice(cursor, index);
      result.push({ raw: plain, offset: cursor, length: plain.length });
    }
    result.push({ raw, name, offset: index, length: raw.length });
    cursor = index + raw.length;
  }
  if (cursor < text.length) {
    const tail = text.slice(cursor);
    result.push({ raw: tail, offset: cursor, length: tail.length });
  }
  return result;
}

/**
 * Returns unique variable names in order of first appearance.
 */
export function extractPromptVariables(body: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const token of tokenizePrompt(body)) {
    if (token.name && !seen.has(token.name)) {
      seen.add(token.name);
      names.push(token.name);
    }
  }
  return names;
}

export function hasPromptVariables(body: string): boolean {
  return extractPromptVariables(body).length > 0;
}

export function hasActualVariableValue(value: string | undefined | null): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Single-pass literal replacement:
 * - Never re-parses replacement text (so {{保留原样}} remains literal).
 * - Never interprets replacement patterns (so $&, $$, $1 remain literal).
 * - Preserves newlines, quotes, angle brackets, spaces, and indentation verbatim.
 */
export function replacePromptVariables(
  body: string,
  values: ReadonlyMap<string, string> | Record<string, string>,
): string {
  const isMap = values instanceof Map;
  const record = isMap ? null : (values as Record<string, string>);
  return tokenizePrompt(body)
    .map((token) => {
      if (!token.name) return token.raw;
      const value = isMap
        ? values.get(token.name)
        : record && Object.prototype.hasOwnProperty.call(record, token.name)
          ? record[token.name]
          : undefined;
      return value === undefined ? token.raw : value;
    })
    .join("");
}

/**
 * Trims tags, removes blanks, and deduplicates case-insensitively while preserving first casing/order.
 */
export function normalizePromptTags(tags: readonly string[]): string[] {
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const raw of tags) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const key = trimmed.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push(trimmed);
  }
  return normalized;
}

export function promptCharCount(text: string): number {
  return Array.from(text || "").length;
}

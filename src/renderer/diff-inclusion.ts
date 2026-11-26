import type { FileComparison } from "../shared/git-client";
import type { editor } from "monaco-editor/editor/editor.api";

export type Inclusion = { included: boolean; token: string; hunk: number };
type Span = [start: number, count: number];

function spans(header: string): [Span, Span] {
  const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(header)!;
  const span = (i: number): Span => {
    const count = Number(match[i + 1] ?? 1);
    return [Number(match[i]) - (count ? 1 : 0), count];
  };
  return [span(1), span(3)];
}

/** A Git patch may group multiple screen changes, or include hidden whitespace edits.
 * Offer it on a single checkbox only if exactly that displayed change would be applied. */
export function matchInclusions(display: FileComparison, changes: editor.ILineChange[], sources: { file: FileComparison; included: boolean }[]) {
  const result = new Map<number, Inclusion>();
  if (!sources.length || !changes.length) return result;
  const left = display.oldText.split(/\r\n|\r|\n/), right = display.newText.split(/\r\n|\r|\n/);
  for (const { file, included } of sources) {
    if (!file.canPatch) continue;
    const a = file.oldText.split(/\r\n|\r|\n/), b = file.newText.split(/\r\n|\r|\n/);
    const shared = included ? 0 : 1;
    const raw = file.revertHunks.map(hunk => spans(hunk.header));
    const candidates = new Map<string, { regions: [Span, Span]; hunk: number }>();
    let i = 0;
    for (const hunk of file.hunks) {
      const [start, length] = spans(hunk.header)[shared];
      while (i < raw.length && raw[i][shared][0] < start) i++;
      const first = i;
      while (i < raw.length && raw[i][shared][0] + raw[i][shared][1] <= start + length) i++;
      if (i === first + 1) candidates.set(raw[first][shared].join(","), { regions: raw[first], hunk: hunk.index });
    }
    for (const [index, change] of changes.entries()) {
      const span = (start: number, end: number): Span => end ? [start - 1, end - start + 1] : [start, 0];
      const visible = [span(change.originalStartLineNumber, change.originalEndLineNumber), span(change.modifiedStartLineNumber, change.modifiedEndLineNumber)];
      const match = candidates.get(visible[shared].join(","));
      if (!match) continue;
      const same = ([start, count]: Span, [at, n]: Span, actual: string[], expected: string[]) =>
        count === n && actual.slice(start, start + count).every((line, offset) => line === expected[at + offset]);
      if (same(match.regions[0], visible[0], a, left) && same(match.regions[1], visible[1], b, right))
        result.set(index, { included, token: file.token, hunk: match.hunk });
    }
  }
  return result;
}

export interface RevertLines {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

const splitLines = (text: string) => text.split(/\r\n|\n|\r/);
const endsInNewline = (text: string) => /[\r\n]$/.test(text);

function lineEnding(original: string, modified: string) {
  return modified.includes("\r\n") || (!modified.includes("\n") && original.includes("\r\n")) ? "\r\n" : "\n";
}

/** Replace a live document block with the corresponding original lines. */
export function revertLines(original: string, modified: string, change: RevertLines) {
  const before = splitLines(original), after = splitLines(modified);
  const eol = lineEnding(original, modified);
  const originalEnds = endsInNewline(original), modifiedEnds = endsInNewline(modified);
  const oldLength = original ? before.length - (originalEnds ? 1 : 0) : 0;
  const newLength = modified ? after.length - (modifiedEnds ? 1 : 0) : 0;
  after.splice(change.newStart - 1, change.newCount,
    ...before.slice(change.oldStart - 1, change.oldStart - 1 + change.oldCount));
  let text = after.join(eol);
  if (change.oldStart + change.oldCount - 1 >= oldLength &&
      change.newStart + change.newCount - 1 >= newLength) {
    // Git's line ranges omit the final-newline marker. Restore it with the EOF block.
    if (!originalEnds && text.endsWith(eol)) text = text.slice(0, -eol.length);
    else if (originalEnds && !text.endsWith(eol)) text += eol;
  }
  return text;
}

/** Insert the original block after its modified counterpart. */
export function appendDiffLines(original: string, modified: string, change: RevertLines) {
  if (!original || !modified || !change.oldCount || !change.newCount) return modified;
  const source = splitLines(original), target = splitLines(modified);
  const trailingNewline = endsInNewline(modified);
  // The editor's last empty line represents the final newline, not another line to append.
  if (endsInNewline(original)) source.pop();
  if (trailingNewline) target.pop();
  const oldBlock = source.slice(change.oldStart - 1, change.oldStart - 1 + change.oldCount);
  if (!oldBlock.length || change.newStart > target.length) return modified;
  const insertAt = change.newStart - 1 + change.newCount;
  const eol = lineEnding(original, modified);
  const lines = target.slice(0, insertAt).concat(oldBlock, target.slice(insertAt));
  return lines.join(eol) + (trailingNewline ? eol : "");
}

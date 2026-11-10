export interface RevertLines {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

/** Replace a live document block with the corresponding original lines. */
export function revertLines(original: string, modified: string, change: RevertLines) {
  const split = (text: string) => text.split(/\r\n|\n|\r/);
  const before = split(original), after = split(modified);
  const eol = modified.includes("\r\n") || (!modified.includes("\n") && original.includes("\r\n")) ? "\r\n" : "\n";
  const originalEnds = /[\r\n]$/.test(original), modifiedEnds = /[\r\n]$/.test(modified);
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

export interface ConflictBlock {
  start: number;
  end: number;
  ours: string;
  theirs: string;
  startLine: number;
  endLine: number;
}
// Offsets always refer to the current editor model, including its actual EOLs.
// Diff3 ancestor sections belong to neither side.
export function conflictBlocks(text: string): ConflictBlock[] {
  const lines = text.match(/[^\n]*\n|[^\n]+$/g) || [],
    blocks: ConflictBlock[] = [];
  let offset = 0,
    start = -1,
    startLine = 0,
    side: "ours" | "base" | "theirs" = "ours",
    ours = "",
    theirs = "";
  lines.forEach((line, index) => {
    if (/^<{7}( |\r?$)/.test(line)) {
      start = offset;
      startLine = index + 1;
      side = "ours";
      ours = "";
      theirs = "";
    } else if (start >= 0 && /^\|{7}( |\r?$)/.test(line)) side = "base";
    else if (start >= 0 && /^={7}\r?\n?$/.test(line)) side = "theirs";
    else if (start >= 0 && /^>{7}( |\r?$)/.test(line)) {
      blocks.push({
        start,
        end: offset + line.length,
        ours,
        theirs,
        startLine,
        endLine: index + 1,
      });
      start = -1;
    } else if (start >= 0) {
      if (side === "ours") ours += line;
      else if (side === "theirs") theirs += line;
    }
    offset += line.length;
  });
  return blocks;
}

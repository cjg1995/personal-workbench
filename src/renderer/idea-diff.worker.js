import { MyersDiffAlgorithm } from "monaco-editor/editor/common/diff/defaultLinesDiffComputer/algorithms/myersDiffAlgorithm.js";
import { DateTimeout } from "monaco-editor/editor/common/diff/defaultLinesDiffComputer/algorithms/diffAlgorithm.js";

const myers = new MyersDiffAlgorithm();

// Half-open ranges into the two sequences. Keep common edges even on timeout.
function differences(left, right, timeout) {
  let start = 0, a = left.length, b = right.length;
  while (start < a && start < b && left[start] === right[start]) start++;
  while (start < a && start < b && left[a - 1] === right[b - 1]) { a--; b--; }
  if (a === start && b === start) return [];
  if (a === start || b === start || !timeout.isValid()) return [[start, a, start, b]];
  const sequence = (items, end) => ({ length: end - start, getElement: i => items[start + i] });
  return myers.compute(sequence(left, a), sequence(right, b), timeout).diffs.map(({ seq1Range, seq2Range }) =>
    [start + seq1Range.start, start + seq1Range.endExclusive, start + seq2Range.start, start + seq2Range.endExclusive]);
}

function matchingItems(left, right, timeout, visit) {
  let a = 0, b = 0;
  for (const [a0, a1, , b1] of differences(left, right, timeout)) {
    while (a < a0) visit(a++, b++);
    a = a1; b = b1;
  }
  while (a < left.length) visit(a++, b++);
}

function words(lines, start, end) {
  const tokens = [], positions = [];
  for (let row = start; row < end; row++) {
    for (const match of lines[row].matchAll(/[\p{L}\p{M}\p{N}_$]+|[^\S\n]+|===?|!==?|&&|\|\||>=|<=|=>|->|::|\+\+|--|[^\s]/gu)) {
      positions.push([row + 1, match.index + 1]);
      tokens.push(match[0]);
    }
    if (row + 1 < end) {
      positions.push([row + 1, lines[row].length + 1]);
      tokens.push("\n");
    }
  }
  positions.push([end, lines[end - 1].length + 1]);
  return { tokens, positions };
}

function wordRange(lines, positions, i, j, ignore) {
  let [first, start] = positions[i], [last, end] = positions[j];
  if (ignore && i < j) {
    if (first < last && start === lines[first - 1].length + 1) {
      first++;
      start = first === last ? (lines[first - 1].match(/^\s*/u)[0].length + 1) : 1;
    }
    const floor = first === last ? Math.min(start, end) : 1;
    start = first === last ? floor : start;
    while (end > floor && /\s/u.test(lines[last - 1][end - 2])) end--;
  }
  return [first, start, last, end];
}

function wordChanges(left, a0, a1, right, b0, b1, timeout, ignore) {
  if (a0 === a1 || b0 === b1 || !timeout.isValid()) return;
  const size = (lines, start, end) => {
    let length = 0;
    for (let row = start; row < end; row++) length += 1 + lines[row].length;
    return length;
  };
  if (size(left, a0, a1) + size(right, b0, b1) > 100000) return;
  const a = words(left, a0, a1), b = words(right, b0, b1);
  const edits = [];
  for (const edit of differences(a.tokens, b.tokens, timeout)) {
    const previous = edits.at(-1);
    if (previous && a.tokens.slice(previous[1], edit[0]).every(token => /^\s+$/u.test(token) && token !== "\n")) {
      previous[1] = edit[1]; previous[3] = edit[3];
    } else {
      edits.push(edit);
    }
  }
  return edits.map(([i, j, k, l]) => {
    const [oldFirst, oldStart, oldLast, oldEnd] = wordRange(left, a.positions, i, j, ignore);
    const [newFirst, newStart, newLast, newEnd] = wordRange(right, b.positions, k, l, ignore);
    let trim = 0;
    if (j === i + 1 && l === k + 1 && /^[!=<>]+$/.test(a.tokens[i]) && /^[!=<>]+$/.test(b.tokens[k])) {
      while (trim < Math.min(a.tokens[i].length, b.tokens[k].length) && a.tokens[i].at(-1 - trim) === b.tokens[k].at(-1 - trim)) trim++;
    }
    return {
      originalStartLineNumber: oldFirst, originalStartColumn: oldStart,
      originalEndLineNumber: oldLast, originalEndColumn: oldEnd - trim,
      modifiedStartLineNumber: newFirst, modifiedStartColumn: newStart,
      modifiedEndLineNumber: newLast, modifiedEndColumn: newEnd - trim,
    };
  });
}

export function compareLines(left, right, whitespace) {
  const timeout = new DateTimeout(1800);
  const normalize = line => whitespace === "ignore" ? line.replace(/\s+/gu, "") : whitespace === "trim" ? line.trim() : line;
  const keys = [left.map(normalize), right.map(normalize)];
  const anchors = keys.map(lines => lines.flatMap((text, index) => /[\p{L}\p{N}_$]/u.test(text) ? [index] : []));
  const changes = [];
  function add(a, b, c, d) {
    if (whitespace === "ignore" && keys[0].slice(a, b).every(line => !line) && keys[1].slice(c, d).every(line => !line)) return;
    changes.push({
      originalStartLineNumber: a === b ? a : a + 1, originalEndLineNumber: a === b ? 0 : b,
      modifiedStartLineNumber: c === d ? c : c + 1, modifiedEndLineNumber: c === d ? 0 : d,
      charChanges: wordChanges(left, a, b, right, c, d, timeout, whitespace === "ignore"),
    });
  }
  let old = 0, next = 0;
  function gap(oldEnd, newEnd) {
    if (old < oldEnd || next < newEnd) {
      // Match statement lines first so an incidental brace in an insertion cannot split a change.
      let a = old, b = next, endA = oldEnd, endB = newEnd;
      while (a < endA && b < endB && left[endA - 1] === right[endB - 1]) { endA--; endB--; }
      for (const [i, j, k, l] of differences(keys[0].slice(a, endA), keys[1].slice(b, endB), timeout)) {
        add(a + i, a + j, b + k, b + l);
      }
    }
    old = oldEnd + 1; next = newEnd + 1;
  }
  matchingItems(anchors[0].map(i => keys[0][i]), anchors[1].map(i => keys[1][i]), timeout,
    (a, b) => gap(anchors[0][a], anchors[1][b]));
  gap(left.length, right.length);
  return changes;
}

self.onmessage = ({ data }) => {
  const { id, original, modified, whitespace } = data;
  self.postMessage({ id, changes: compareLines(original, modified, whitespace) });
};

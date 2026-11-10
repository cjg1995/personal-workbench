import test from "node:test";
import assert from "node:assert/strict";
import { revertLines } from "../src/shared/diff-edit.js";

test("Revert 当前行块保留其他修改，支持增删行和文件首尾", () => {
  assert.equal(revertLines("a\nb\nc\n", "a\nadded\nb\nchanged c\n",
    { oldStart: 1, oldCount: 0, newStart: 2, newCount: 1 }), "a\nb\nchanged c\n");
  assert.equal(revertLines("a\nb\nc\n", "a\nc\n",
    { oldStart: 2, oldCount: 1, newStart: 2, newCount: 0 }), "a\nb\nc\n");
  assert.equal(revertLines("a\nb", "a\nchanged b\n",
    { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }), "a\nb");
  assert.equal(revertLines("a\nb\n", "a\nb",
    { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }), "a\nb\n");
  assert.equal(revertLines("", "added\n", { oldStart: 1, oldCount: 0, newStart: 1, newCount: 1 }), "");
});

test("Revert CRLF 和没有末尾换行的文件保持字节形式，不串改相邻块", () => {
  assert.equal(revertLines("a\r\nb\r\n", "", { oldStart: 1, oldCount: 2, newStart: 1, newCount: 0 }), "a\r\nb\r\n");
  assert.equal(revertLines("a\r\nb\r\nc", "changed a\r\nadded\r\nb\r\nc",
    { oldStart: 2, oldCount: 0, newStart: 2, newCount: 1 }), "changed a\r\nb\r\nc");
  assert.equal(revertLines("a\r\nb\r\n", "a\r\nchanged b",
    { oldStart: 2, oldCount: 1, newStart: 2, newCount: 1 }), "a\r\nb\r\n");
});

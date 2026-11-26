import test from "node:test";
import assert from "node:assert/strict";
import { appendDiffLines, revertLines } from "../src/shared/diff-edit.js";

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

test("追加把左侧原有行插在右侧修改块之后，保留工作区换行格式", () => {
  const middle = { oldStart: 2, oldCount: 2, newStart: 2, newCount: 1 };
  assert.equal(
    appendDiffLines("a\nold 1\nold 2\nz\n", "a\r\nnew\r\nz\r\n", middle),
    "a\r\nnew\r\nold 1\r\nold 2\r\nz\r\n",
  );
  const end = { oldStart: 2, oldCount: 2, newStart: 2, newCount: 1 };
  assert.equal(appendDiffLines("a\nold\n", "a\nnew", end), "a\nnew\nold");
  assert.equal(appendDiffLines("a\nold\n", "a\nnew\n", end), "a\nnew\nold\n");
  assert.equal(appendDiffLines("a\n", "a\nnew", { ...end, oldCount: 1 }), "a\nnew");
  assert.equal(appendDiffLines("a\nb", "a", { ...end, oldCount: 1, newCount: 0 }), "a");
  assert.equal(appendDiffLines("a", "a\nb", { ...end, oldCount: 0 }), "a\nb");
});

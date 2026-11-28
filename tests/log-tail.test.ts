import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { readLogTail } from "../src/core/log-tail.js";

test("日志尾部按偏移增量读取，截断后整段替换", () => {
  const file = path.join(os.tmpdir(), `workbench-log-${Date.now()}.log`);
  fs.writeFileSync(file, "one\n");
  const first = readLogTail(file, 0);
  assert.equal(first.text, "one\n");
  assert.equal(first.reset, false);
  fs.appendFileSync(file, "two\n");
  const next = readLogTail(file, first.offset);
  assert.equal(next.text, "two\n");
  assert.equal(next.reset, false);
  fs.writeFileSync(file, "fresh\n");
  const reset = readLogTail(file, next.offset);
  assert.equal(reset.reset, true);
  assert.equal(reset.text, "fresh\n");
  fs.rmSync(file);
});

test("任务日志按最后 2 MiB 的字节边界显示，并保留截断标记", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "workbench-log-"));
  const file = path.join(dir, "task.log"), capacity = 2 * 1024 * 1024;
  try {
    const text = "中".repeat(Math.ceil(capacity / 3) + 8);
    const bytes = Buffer.from(text);
    fs.writeFileSync(file, bytes);
    const tail = readLogTail(file, 0, capacity);
    assert.equal(tail.text, bytes.subarray(-capacity).toString("utf8"));
    assert.equal(tail.reset, true);
    assert.equal(tail.offset, bytes.length);
    fs.truncateSync(file, capacity);
    assert.equal(readLogTail(file, 0, capacity).reset, false);
  } finally {
    fs.unlinkSync(file);
    fs.rmdirSync(dir);
  }
});

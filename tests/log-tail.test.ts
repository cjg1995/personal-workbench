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

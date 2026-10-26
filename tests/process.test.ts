import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { command, CommandError } from "../src/core/process.js";
import { createHash } from "node:crypto";
import { redact } from "../src/core/util.js";
test("普通日志过滤 JSON、Groovy、XML、命令行字段与 URL 凭据", () => {
  for (const text of [
    "password=private-value",
    '"password":"private-value"',
    "storePassword 'private-value'",
    "<token>private-value</token>",
    "https://user:private-value@localhost/a",
    "https://private-value@localhost/a",
    '"Authorization":"Bearer private-value"',
    "Cookie: session=private-value; other=value",
    "api_key=private-value",
    '"privateKey":"private-value and continuation"',
  ]) {
    const out = redact(text);
    assert.ok(!out.includes("private-value"), out);
    assert.ok(out.includes("[已隐藏]"), out);
  }
});
test("截断的工具输出不能用于写入前核对，全流指纹仍覆盖末尾变化；预先取消不启动命令", async () => {
  const content = "prefix".repeat(1000) + "tail";
  const result = await command(
    process.execPath,
    ["-e", "process.stdout.write(" + JSON.stringify(content) + ")"],
    { maxBytes: 32 },
  );
  assert.equal(result.truncated, true);
  assert.equal(
    result.stdoutSha256,
    createHash("sha256").update(content).digest("hex"),
  );
  await assert.rejects(
    () =>
      command(
        process.execPath,
        ["-e", "process.stdout.write(" + JSON.stringify(content) + ")"],
        { maxBytes: 32, requireFullOutput: true },
      ),
    /不完整/,
  );
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    () => command("does-not-exist.exe", [], { signal: controller.signal }),
    /未启动/,
  );
  const error = new CommandError(
    {
      code: 1,
      stdout: "actual failure",
      stderr: "password=hidden-value warning",
    },
    "tool.exe",
    [],
  );
  assert.match(error.message, /actual failure/);
  assert.ok(!error.message.includes("hidden-value"));
});
test("分块 UTF-8、中文 GBK 与最后一行正确读取，返回原文而日志脱敏", async () => {
  const dir = path.resolve(".local", "process-tests");
  fs.mkdirSync(dir, { recursive: true });
  const log = path.join(dir, "stdout.log");
  const result = await command(
    process.execPath,
    [
      "-e",
      `process.stdout.write(Buffer.from([0xe4]));setTimeout(()=>{process.stdout.write(Buffer.from([0xb8,0xad,0x0a]));process.stdout.write(Buffer.from([0xd6,0xd0,0xce,0xc4,0x0a]));process.stdout.write('"password":"private-value"');},20);`,
    ],
    { logPath: log },
  );
  assert.match(result.stdout, /中\n中文\n/);
  assert.ok(result.stdout.includes("private-value"));
  assert.ok(!fs.readFileSync(log, "utf8").includes("private-value"));
});

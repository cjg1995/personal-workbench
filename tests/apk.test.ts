import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { zipSync, strToU8 } from "fflate";
import {
  apkHashes,
  compareResources,
  offlineCacheMiss,
  resourceHashes,
  syncResources,
  wwwPath,
} from "../src/core/apk.js";
import { hash } from "../src/core/util.js";
const root = path.resolve(".local", "apk-fixtures", randomUUID());
fs.mkdirSync(root, { recursive: true });
function write(file: string, text: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}
test("资源安全同步：删除旧文件、目录/文件冲突、中文路径、保留原生工程", () => {
  const source = path.join(root, "source"),
    android = path.join(root, "android"),
    www = wwwPath(android, "__UNI__TEST");
  write(path.join(source, "app-service.js"), "new");
  write(path.join(source, "static", "中文 [资源].txt"), "resource");
  write(path.join(source, "logo.txt"), "logo");
  write(path.join(www, "app-service.js", "old.txt"), "stale");
  write(path.join(www, "LOGO.TXT"), "old case");
  write(path.join(android, "keep.txt"), "native config");
  const expected = syncResources(source, android, "__UNI__TEST");
  compareResources(expected, resourceHashes(www), "宿主");
  assert.equal(
    fs.readFileSync(path.join(android, "keep.txt"), "utf8"),
    "native config",
  );
  assert.equal(
    hash(Buffer.from("abc")),
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  const wrong = Object.fromEntries(
    Object.entries(expected).map(([k, v]) => [k.toUpperCase(), v]),
  );
  assert.throws(() => compareResources(expected, wrong, "大小写"), /不一致/);
});
test("空输出、AppID 越界、资源损坏均阻断", () => {
  const empty = path.join(root, "empty");
  fs.mkdirSync(empty);
  const android = path.join(root, "android");
  const before = resourceHashes(wwwPath(android, "__UNI__TEST"));
  assert.throws(() => syncResources(empty, android, "__UNI__TEST"), /空资源/);
  compareResources(
    before,
    resourceHashes(wwwPath(android, "__UNI__TEST")),
    "空输出保护",
  );
  assert.throws(() => wwwPath(android, "../escape"), /AppID/);
  write(
    path.join(wwwPath(android, "__UNI__TEST"), "app-service.js"),
    "corrupt",
  );
  assert.throws(
    () =>
      compareResources(
        before,
        resourceHashes(wwwPath(android, "__UNI__TEST")),
        "损坏",
      ),
    /不一致/,
  );
});
test("APK 逐资源校验及重复路径拒绝", () => {
  const file = path.join(root, "test.apk");
  fs.writeFileSync(
    file,
    zipSync({
      "assets/apps/__UNI__TEST/www/app-service.js": strToU8("one"),
      "assets/apps/__UNI__TEST/www/bpp-service.js": strToU8("two"),
    }),
  );
  assert.equal(Object.keys(apkHashes(file, "__UNI__TEST")).length, 2);
  assert.equal(Object.keys(apkHashes(file, "__UNI__OTHER")).length, 0);
  const buffer = fs.readFileSync(file);
  const search = Buffer.from("bpp-service.js");
  let offset = buffer.indexOf(search);
  while (offset >= 0) {
    buffer.write("app-service.js", offset, "utf8");
    offset = buffer.indexOf(search, offset + search.length);
  }
  fs.writeFileSync(file, buffer);
  assert.throws(() => apkHashes(file, "__UNI__TEST"), /重复/);
});
test("离线重试只接受明确缓存缺失，不将编译错误当作联网问题", () => {
  assert.equal(
    offlineCacheMiss(
      "No cached version of test:dependency:1 available for offline mode.",
    ),
    true,
  );
  assert.equal(
    offlineCacheMiss("No cached resource available for offline mode"),
    true,
  );
  assert.equal(
    offlineCacheMiss("Compilation failed. Could not resolve symbol."),
    false,
  );
  assert.equal(offlineCacheMiss("Connection refused"), false);
});
test("链接与断开的链接目录都在同步前拒绝，不触及链接外目录", () => {
  const source = path.join(root, "linked-source"),
    android = path.join(root, "linked-host"),
    external = path.join(root, "external");
  write(path.join(source, "app-service.js"), "safe");
  write(path.join(external, "keep.txt"), "external keep");
  const app = path.dirname(wwwPath(android, "__UNI__LINK"));
  fs.mkdirSync(app, { recursive: true });
  fs.symlinkSync(external, path.join(app, "www"), "junction");
  assert.throws(() => syncResources(source, android, "__UNI__LINK"), /链接/);
  assert.equal(
    fs.readFileSync(path.join(external, "keep.txt"), "utf8"),
    "external keep",
  );
  fs.unlinkSync(path.join(app, "www"));
  fs.symlinkSync(
    path.join(root, "missing-target"),
    path.join(app, "www"),
    "junction",
  );
  assert.throws(() => syncResources(source, android, "__UNI__LINK"), /链接/);
  fs.unlinkSync(path.join(app, "www"));
});

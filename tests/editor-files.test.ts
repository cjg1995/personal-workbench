import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import iconv from "iconv-lite";
import { EditorFiles, projectFile } from "../src/core/editor-files.js";

test("代码编辑保留编码与换行，并阻止覆盖外部修改", async () => {
  const root = path.resolve(".local/editor-file-tests", randomUUID());
  fs.mkdirSync(root, { recursive: true });
  const files = new EditorFiles();
  try {
    const utf8 = path.join(root, "Demo.java");
    fs.writeFileSync(utf8, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("class Demo {\r\n}\r\n")]));
    const original = await files.read(root, "Demo.java");
    assert.equal(original.encoding, "utf8");
    assert.equal(original.bom, true);
    assert.equal(original.eol, "\r\n");
    const saved = await files.save(root, { ...original, text: "class Demo {\r\n  int x;\r\n}\r\n" });
    assert.equal(saved.conflict, false);
    assert.equal(fs.readFileSync(utf8).subarray(0, 3).toString("hex"), "efbbbf");
    fs.writeFileSync(utf8, "external edit\n");
    const conflict = await files.save(root, { ...original, text: "editor edit\r\n", version: saved.version! });
    assert.equal(conflict.conflict, true);
    assert.equal(fs.readFileSync(utf8, "utf8"), "external edit\n");

    const gbk = path.join(root, "Legacy.java");
    fs.writeFileSync(gbk, iconv.encode("// 中文\r\nclass Legacy {}\r\n", "gb18030"));
    const legacy = await files.read(root, "Legacy.java");
    assert.equal(legacy.encoding, "gb18030");
    await files.save(root, { ...legacy, text: "// 中文\r\nclass Legacy { int x; }\r\n" });
    assert.equal(iconv.decode(fs.readFileSync(gbk), "gb18030"), "// 中文\r\nclass Legacy { int x; }\r\n");

    fs.mkdirSync(path.join(root, "target"));
    fs.writeFileSync(path.join(root, "target", "Generated.java"), "class Generated {}");
    const tree = await files.tree(root);
    assert.equal(tree.some((entry) => entry.name === "target"), false);
    assert.deepEqual(await files.findFiles(root, "legacy"), ["Legacy.java"]);
    assert.equal((await files.search(root, "int x")).length, 1);
    const fast = new EditorFiles(path.resolve("node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe"));
    assert.deepEqual(await fast.findFiles(root, "legacy"), ["Legacy.java"]);
    assert.equal((await fast.search(root, "int x"))[0]?.file, "Legacy.java");
    fs.writeFileSync(path.join(root, "Path.java"), "// path C:\\source\\code\n");
    assert((await fast.search(root, "path"))[0]?.text.includes("C:\\source\\code"));
    const latest = await Promise.all([fast.search(root, "missing"), fast.search(root, "int x")]);
    assert.equal(latest[1][0]?.file, "Legacy.java");
    assert.throws(() => projectFile(root, "../outside.java"), /超出项目/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

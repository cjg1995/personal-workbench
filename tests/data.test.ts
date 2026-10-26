import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { Store } from "../src/core/store.js";
import { RecordsService } from "../src/core/records.js";
import { TaskManager } from "../src/core/tasks.js";
import { BackupService } from "../src/core/backup.js";
import { exportWord } from "../src/core/documents.js";
import { hash } from "../src/core/util.js";
import * as requireXml from "@xmldom/xmldom";

const root = path.resolve(".local", "data-fixtures", randomUUID());
fs.mkdirSync(root, { recursive: true });
let sequence = 0;
function fixture(beforeRestore?: () => Promise<void>) {
  const dir = path.join(root, String(++sequence));
  fs.mkdirSync(dir);
  const store = new Store(path.join(dir, "data.sqlite"));
  const records = new RecordsService(store, dir),
    tasks = new TaskManager(store, dir),
    backup = new BackupService(store, tasks, dir, beforeRestore);
  return { dir, store, records, tasks, backup };
}
test("记录内容唯一必填；编辑保留 ID；待办完成独立；软删除可恢复；重启保留", () => {
  const f = fixture();
  const idea = f.records.save({ kind: "idea", text: "想法" });
  f.records.complete(idea.id, true);
  assert.equal(f.records.list("work").length, 0);
  assert.ok(f.records.get(idea.id).completedAt);
  f.records.complete(idea.id, false);
  assert.equal(f.records.get(idea.id).completedAt, null);
  const work = f.records.save({ kind: "work", text: "已发生工作" });
  const updated = f.records.save({ ...work, text: "编辑后的工作" });
  assert.equal(updated.id, work.id);
  assert.equal(f.records.list("work").length, 1);
  f.records.remove(work.id);
  assert.equal(f.records.list("work").length, 0);
  f.records.restore(work.id);
  assert.equal(f.records.list("work")[0].id, work.id);
  f.store.close();
  const reopened = new Store(path.join(f.dir, "data.sqlite"));
  assert.equal(reopened.get<any>("note", work.id).text, "编辑后的工作");
  reopened.close();
});
test("月份边界、无日期与来源变更保留人工月报；重复来源明确拒绝", () => {
  const f = fixture();
  const sept = f.records.save({
      kind: "work",
      text: "九月末",
      happenedOn: "2026-09-30",
    }),
    oct = f.records.save({
      kind: "work",
      text: "十月初",
      happenedOn: "2026-10-01",
    });
  f.records.save({ kind: "work", text: "无日期", happenedOn: null });
  f.records.save({ kind: "idea", text: "未来待办" });
  f.records.save({ kind: "work", text: "跨年", happenedOn: "2027-01-01" });
  assert.deepEqual(
    f.records.month("2026-10").map((n) => n.id),
    [oct.id],
  );
  assert.equal(f.records.month("2026-09")[0].id, sept.id);
  const draft = f.records.addSources("2026-10", "陈嘉庚", "主要工作", [oct.id]);
  draft.entries[0].text = "人工编辑成果";
  f.records.saveDraft(draft);
  assert.throws(
    () => f.records.addSources("2026-10", "陈嘉庚", "其他", [oct.id]),
    /已在正文/,
  );
  f.records.save({ ...oct, text: "源记录已修改" });
  assert.equal(f.records.draft("2026-10").entries[0].text, "人工编辑成果");
  assert.equal(f.records.sources(draft)[0].sources[0].changed, true);
  f.records.remove(oct.id);
  assert.equal(f.records.sources(draft)[0].sources[0].deleted, true);
  assert.equal(f.records.draft("2026-10").entries[0].text, "人工编辑成果");
  f.store.close();
});
test("TXT 字节、物理行、BOM、括号和正文空格保持；默认去重不推断日期状态", async () => {
  const f = fixture();
  const file = path.join(f.dir, "原文 [待办].txt");
  const bytes = Buffer.from(
    "\uFEFF想法（完成初版）\r\n\r\n  保留 空格  \r\n想法（完成初版）\r\n",
    "utf8",
  );
  fs.writeFileSync(file, bytes);
  const p = f.records.previewImport(file, "idea");
  assert.equal(p.lines.length, 3);
  assert.equal(p.lines[1].text, "  保留 空格  ");
  assert.equal(p.lines[2].duplicate, true);
  const first = await f.records.import(
    p.id,
    p.lines.filter((l) => l.selected).map((l) => l.line),
  );
  assert.equal(first.added, 2);
  assert.equal(first.skipped, 1);
  assert.equal(first.records[0].completedAt, null);
  assert.equal(first.records[0].happenedOn, null);
  assert.equal(hash(fs.readFileSync(file)), hash(bytes));
  assert.equal(hash(fs.readFileSync(first.snapshot)), hash(bytes));
  const second = f.records.previewImport(file, "idea");
  assert.equal(second.lines.filter((l) => l.selected).length, 0);
  f.records.save({ kind: "idea", text: "手工同文" });
  const file2 = path.join(f.dir, "same.txt");
  fs.writeFileSync(file2, "手工同文");
  assert.equal(
    f.records.previewImport(file2, "idea").lines[0].duplicate,
    false,
  );
  f.store.close();
});
test("GBK、UTF-8 BOM、特殊符号正确解码；乱码与二进制不导入", () => {
  const f = fixture();
  const gbk = path.join(f.dir, "gbk.txt");
  fs.writeFileSync(gbk, Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 0x0d, 0x0a]));
  assert.equal(f.records.previewImport(gbk, "work").lines[0].text, "中文");
  const bom = path.join(f.dir, "bom.txt");
  fs.writeFileSync(bom, "\uFEFF中文 & <原文>");
  assert.equal(
    f.records.previewImport(bom, "work").lines[0].text,
    "中文 & <原文>",
  );
  const binary = path.join(f.dir, "binary.txt");
  fs.writeFileSync(binary, Buffer.from([0, 1, 2, 3]));
  assert.throws(
    () => f.records.previewImport(binary, "work"),
    /二进制|编码|乱码/,
  );
  f.store.close();
});
test("TXT 批次事务失败不留下半批数据，原文快照保留且可重试", async () => {
  const f = fixture();
  const source = path.join(f.dir, "batch.txt");
  fs.writeFileSync(source, "一\n二\n三");
  const p = f.records.previewImport(source, "work");
  const original = f.store.set.bind(f.store);
  let count = 0;
  f.store.set = (...args: any[]) => {
    if (args[0] === "note" && ++count === 2)
      throw new Error("模拟实际保存失败");
    return (original as any)(...args);
  };
  await assert.rejects(() => f.records.import(p.id, [1, 2, 3]), /保存失败/);
  assert.equal(f.records.list("work").length, 0);
  assert.equal(f.store.list("import").length, 0);
  assert.equal(fs.readFileSync(source, "utf8"), "一\n二\n三");
  f.store.set = original;
  const result = await f.records.import(p.id, [1, 2, 3]);
  assert.equal(result.added, 3);
  assert.equal(
    f.records.list("work").every((n) => n.happenedOn === null),
    true,
  );
  f.store.close();
});
test("SQLite WAL 一致备份、恢复预览、保护副本、恢复后任务中断与数据原样", async () => {
  const f = fixture();
  const n = f.records.save({
    kind: "work",
    text: "备份时记录",
    happenedOn: "2026-10-24",
  });
  f.records.addSources("2026-10", "陈嘉庚", "主要工作", [n.id]);
  const task = f.tasks.create(
    "app",
    "备份中的中断任务",
    "employee",
    "fixture-lock",
    {},
  );
  const file = path.join(f.dir, "backup.zip");
  const saved = await f.backup.create(file);
  assert.equal(saved.manifest.counts.note, 1);
  task.state = "cancelled";
  f.tasks.save(task);
  f.records.save({ ...n, text: "后来的记录" });
  const p = f.backup.preview(file);
  assert.equal(p.counts.note, 1);
  const restored = await f.backup.restore(p.token);
  assert.ok(fs.existsSync(restored.protectedBackup));
  assert.equal(f.records.get(n.id).text, "备份时记录");
  assert.equal(f.records.draft("2026-10").entries.length, 1);
  assert.equal(f.tasks.get(task.id).state, "interrupted");
  f.store.close();
});
test("恢复被运行任务阻断；损坏、缺文件、越界备份均拒绝并保留原数据", async () => {
  const f = fixture();
  f.records.save({ kind: "work", text: "保留当前数据" });
  const file = path.join(f.dir, "backup.zip");
  await f.backup.create(file);
  const p = f.backup.preview(file);
  f.tasks.create("apk", "运行中", null, "test", {});
  await assert.rejects(() => f.backup.restore(p.token), /运行/);
  assert.equal(f.records.list("work")[0].text, "保留当前数据");
  const bad = path.join(f.dir, "bad.zip"),
    entries = unzipSync(fs.readFileSync(file));
  entries["../escape.txt"] = strToU8("wrong");
  fs.writeFileSync(bad, zipSync(entries));
  assert.throws(() => f.backup.preview(bad), /不允许/);
  delete entries["../escape.txt"];
  entries["database.sqlite"][0] ^= 0xff;
  fs.writeFileSync(bad, zipSync(entries));
  assert.throws(() => f.backup.preview(bad), /校验/);
  assert.equal(f.records.list("work").length, 1);
  f.store.close();
});
test("月报 Word 无顶部标题或大框；截图只留空行；学习和计划多条分别编号", () => {
  const f = fixture();
  const n = f.records.save({
    kind: "work",
    text: "中文 & <标签>\n换行",
    happenedOn: "2026-10-24",
  });
  const draft = f.records.addSources("2026-10", "陈嘉庚", "主要工作", [n.id]);
  for (const section of ["个人学习和成长", "个人工作计划、学习目标"]) {
    for (const text of ["第一条", "第二条"])
      draft.entries.push({
        id: randomUUID(),
        section,
        text: section + text,
        sourceIds: [],
        sourceVersions: {},
        manual: true,
      });
  }
  const output = path.join(f.dir, "可编辑月报.docx");
  exportWord(path.resolve("assets/monthly-template.docx"), draft, output);
  const entries = unzipSync(fs.readFileSync(output));
  const xml = strFromU8(entries["word/document.xml"]);
  assert.doesNotMatch(xml, /2026年10月工作总结-陈嘉庚/);
  assert.match(xml, /中文 &amp; &lt;标签&gt;/);
  assert.match(xml, /w:br/);
  assert.doesNotMatch(xml, /w:tbl/);
  const { DOMParser } = requireXml;
  const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const paragraphs = Array.from(document.getElementsByTagNameNS(ns, "p"));
  assert.match(paragraphs[0].textContent!, /工作成果/);
  assert.equal(paragraphs[1].textContent, "");
  const ids: string[] = [];
  for (const section of ["个人学习和成长", "个人工作计划、学习目标"]) {
    const entries = paragraphs.filter((p) =>
      p.textContent?.includes(section + "第"),
    );
    assert.equal(entries.length, 2);
    const a = entries[0]
      .getElementsByTagNameNS(ns, "numId")[0]
      .getAttribute("w:val")!;
    const b = entries[1]
      .getElementsByTagNameNS(ns, "numId")[0]
      .getAttribute("w:val")!;
    assert.equal(a, b);
    const work = paragraphs.find((p) =>
      p.textContent?.includes("中文 & <标签>"),
    )!;
    const workIndent = work.getElementsByTagNameNS(ns, "ind")[0];
    for (const entry of entries) {
      const indent = entry.getElementsByTagNameNS(ns, "ind")[0];
      for (const attribute of [
        "left",
        "leftChars",
        "firstLine",
        "firstLineChars",
      ])
        assert.equal(
          indent.getAttribute("w:" + attribute),
          workIndent.getAttribute("w:" + attribute),
        );
    }
    ids.push(a);
  }
  assert.notEqual(ids[0], ids[1]);
  const numbering = new DOMParser().parseFromString(
    strFromU8(entries["word/numbering.xml"]),
    "application/xml",
  );
  for (const id of ids) {
    const instance = Array.from(
      numbering.getElementsByTagNameNS(ns, "num"),
    ).find((n) => n.getAttribute("w:numId") === id)!;
    assert.equal(
      instance
        .getElementsByTagNameNS(ns, "startOverride")[0]
        .getAttribute("w:val"),
      "1",
    );
  }
  assert.ok(!xml.includes("{{"));
  assert.ok(!xml.includes("资源回收提醒20260828"));
  assert.ok(!Object.keys(entries).some((n) => n.startsWith("word/media/")));
  for (const text of [
    "主要工作",
    "其他",
    "个人学习和成长",
    "个人工作计划",
    "部门工作",
  ])
    assert.ok(xml.includes(text));
  f.store.close();
});
test("恢复替换后打开失败，数据库与原文快照回到恢复前", async () => {
  const f = fixture();
  const file = path.join(f.dir, "source.txt");
  fs.writeFileSync(file, "原始内容");
  const p = f.records.previewImport(file, "work");
  await f.records.import(p.id, [1]);
  const zip = path.join(f.dir, "backup.zip");
  await f.backup.create(zip);
  const original = f.records.list("work")[0];
  f.records.save({ ...original, text: "恢复前的较新正文" });
  const preview = f.backup.preview(zip);
  const reopen = f.store.reopen.bind(f.store);
  let first = true;
  f.store.reopen = () => {
    if (first) {
      first = false;
      throw new Error("模拟打开替换库失败");
    }
    return reopen();
  };
  await assert.rejects(() => f.backup.restore(preview.token), /原数据已恢复/);
  assert.equal(f.records.get(original.id).text, "恢复前的较新正文");
  assert.equal(
    fs.readFileSync(path.join(f.dir, "snapshots", p.id, "source.txt"), "utf8"),
    "原始内容",
  );
  f.store.close();
});

test("超出可恢复大小时拒绝创建备份，不写目标或改变原库", async () => {
  const f = fixture(),
    target = path.join(f.dir, "too-large.zip"),
    before = fs.readFileSync(f.store.file);
  let staged = "";
  f.store.snapshot = async (file) => {
    staged = file;
    fs.writeFileSync(file, "");
    fs.truncateSync(file, 128 * 1024 * 1024 + 1);
  };
  try {
    await assert.rejects(() => f.backup.create(target), /128 MB/);
    assert.equal(fs.existsSync(target), false);
    assert.deepEqual(fs.readFileSync(f.store.file), before);
  } finally {
    if (staged && fs.existsSync(staged)) fs.unlinkSync(staged);
    f.store.close();
  }
});

test("恢复保护备份期间出现新任务时停止替换，保留当前记录与任务", async () => {
  const f = fixture();
  try {
    const note = f.records.save({ kind: "work", text: "backup version" });
    const file = path.join(f.dir, "backup.zip");
    await f.backup.create(file);
    f.records.save({ ...note, text: "current version" });
    const preview = f.backup.preview(file);
    const create = f.backup.create.bind(f.backup);
    let taskId = "";
    f.backup.create = async (destination) => {
      const result = await create(destination);
      taskId = f.tasks.create(
        "app",
        "保护期间开始的任务",
        null,
        "new-task",
        {},
      ).id;
      return result;
    };
    await assert.rejects(() => f.backup.restore(preview.token), /任务/);
    assert.equal(f.records.get(note.id).text, "current version");
    assert.equal(f.tasks.get(taskId).state, "running");
  } finally {
    f.store.close();
  }
});

test("恢复前和保护备份后均核对自有服务；恢复期间拒绝重复恢复", async () => {
  let owned = false;
  const f = fixture(async () => {
    if (owned) throw new Error("请先停止自有服务");
  });
  try {
    const note = f.records.save({ kind: "work", text: "backup version" });
    const file = path.join(f.dir, "backup.zip");
    await f.backup.create(file);
    f.records.save({ ...note, text: "current version" });
    const preview = f.backup.preview(file);
    owned = true;
    await assert.rejects(() => f.backup.restore(preview.token), /自有服务/);
    assert.equal(f.records.get(note.id).text, "current version");
    owned = false;
    const create = f.backup.create.bind(f.backup);
    f.backup.create = async (destination) => {
      const result = await create(destination);
      owned = true;
      return result;
    };
    await assert.rejects(() => f.backup.restore(preview.token), /自有服务/);
    assert.equal(f.records.get(note.id).text, "current version");
    owned = false;
    f.backup.create = create;

    const snapshot = f.store.snapshot.bind(f.store);
    let entered!: () => void, release!: () => void;
    const checked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    f.store.snapshot = async (destination) => {
      entered();
      await gate;
      return snapshot(destination);
    };
    const first = f.backup.restore(preview.token);
    await checked;
    try {
      await assert.rejects(() => f.backup.restore(preview.token), /正在进行/);
    } finally {
      release();
    }
    await first;
    assert.equal(f.records.get(note.id).text, "backup version");
  } finally {
    f.store.close();
  }
});

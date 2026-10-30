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
test("月报截图写入 Word 图片并落在工作成果标题下", () => {
  const f = fixture();
  const draft = f.records.saveDraft({
    month: "2026-10",
    name: "陈嘉庚",
    entries: [
      {
        id: randomUUID(),
        section: "主要工作",
        text: "主要工作正文",
        sourceIds: [],
        sourceVersions: {},
        manual: true,
      },
    ],
    images: [
      {
        id: randomUUID(),
        name: "工作内容汇总截图1",
        mime: "image/png",
        width: 800,
        height: 400,
        data:
          "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      },
    ],
    updatedAt: new Date().toISOString(),
  });
  assert.equal(f.records.draft("2026-10").images!.length, 1);
  const output = path.join(f.dir, "带截图月报.docx");
  exportWord(path.resolve("assets/monthly-template.docx"), draft, output);
  const entries = unzipSync(fs.readFileSync(output));
  assert.ok(entries["word/media/monthly-1.png"]?.length);
  const { DOMParser } = requireXml;
  const rels = new DOMParser().parseFromString(
    strFromU8(entries["word/_rels/document.xml.rels"]),
    "application/xml",
  );
  const relationship = Array.from(rels.getElementsByTagName("Relationship")).find(
    (n) => n.getAttribute("Target") === "media/monthly-1.png",
  )!;
  assert.ok(relationship);
  const rid = relationship.getAttribute("Id");
  const xml = strFromU8(entries["word/document.xml"]);
  assert.ok(xml.includes(`r:embed="${rid}"`));
  const ns = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
  const document = new DOMParser().parseFromString(xml, "application/xml");
  const paragraphs = Array.from(document.getElementsByTagNameNS(ns, "p"));
  const picture = paragraphs.findIndex((p) => p.getElementsByTagNameNS(ns, "drawing").length);
  const heading = paragraphs.findIndex((p) => p.textContent?.includes("工作成果"));
  const work = paragraphs.findIndex((p) => p.textContent?.includes("主要工作"));
  assert.ok(heading >= 0 && picture > heading && picture < work);
  assert.match(paragraphs[picture + 1].textContent || "", /主要工作/);
  assert.ok(!xml.includes("{{"));
  const extent = paragraphs[picture]
    .getElementsByTagNameNS(
      "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing",
      "extent",
    )[0];
  const cx = Number(extent.getAttribute("cx")),
    cy = Number(extent.getAttribute("cy"));
  assert.ok(cx > 0 && cx <= 5_274_310);
  assert.ok(Math.abs(cy / cx - 0.5) < 0.02);
  f.store.close();
});
test("月报截图格式无效时拒绝保存", () => {
  const f = fixture();
  const base = {
    month: "2026-10",
    name: "陈嘉庚",
    entries: [],
    updatedAt: new Date().toISOString(),
  };
  assert.throws(
    () =>
      f.records.saveDraft({
        ...base,
        images: [
          { id: "a", name: "x", mime: "image/gif", width: 10, height: 10, data: "AA" },
        ],
      }),
    /截图格式无效/,
  );
  assert.throws(
    () =>
      f.records.saveDraft({
        ...base,
        images: Array.from({ length: 9 }, (_, index) => ({
          id: String(index),
          name: "x",
          mime: "image/png",
          width: 10,
          height: 10,
          data: "AA",
        })),
      }),
    /只保留一张/,
  );
  f.store.close();
});
test("恢复替换后打开失败，数据库与原文快照回到恢复前", async () => {
  const f = fixture();
  f.records.save({
    kind: "work",
    text: "恢复前记录",
    happenedOn: "2026-10-24",
  });
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

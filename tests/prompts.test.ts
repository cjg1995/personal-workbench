import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { Store } from "../src/core/store.js";
import { PromptsService } from "../src/core/prompts.js";
import { RecordsService } from "../src/core/records.js";
import { TaskManager } from "../src/core/tasks.js";
import { BackupService } from "../src/core/backup.js";
import {
  extractPromptVariables,
  hasActualVariableValue,
  normalizePromptTags,
  replacePromptVariables,
  tokenizePrompt,
} from "../src/shared/prompt-template.js";

const root = path.resolve(".local", "prompt-fixtures", randomUUID());
fs.mkdirSync(root, { recursive: true });
let seq = 0;

function fixture() {
  const dir = path.join(root, String(++seq));
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "workbench.sqlite");
  const store = new Store(dbPath);
  const prompts = new PromptsService(store);
  const records = new RecordsService(store, dir);
  const tasks = new TaskManager(store, dir);
  const backup = new BackupService(store, tasks, dir);
  return { dir, dbPath, store, prompts, records, tasks, backup };
}

test("模板解析：支持中文与首尾空格归一，忽略空占位符、不完整标记和代码花括号", () => {
  const body = [
    "请为 {{项目名称}} 和 {{ 项目名称 }} 整理清单。",
    "紧邻：{{A}}{{B}}",
    "忽略空：{{}} {{   }}",
    "忽略未闭合：{{未闭合",
    "忽略未开启：未开启}}",
    "忽略三花括号：{{{raw}}} {{{half}} {{half}}}",
    "忽略跨行：{{第一行\n第二行}}",
    "忽略嵌套：{{a{b}c}}",
    "代码：function f() { return { ok: true, nested: { v: 1 } }; }",
  ].join("\n");

  assert.deepEqual(extractPromptVariables(body), ["项目名称", "A", "B"]);

  const tokens = tokenizePrompt(body);
  const varTokens = tokens.filter((t) => t.name);
  assert.equal(varTokens.length, 4);
  assert.equal(varTokens[0].raw, "{{项目名称}}");
  assert.equal(varTokens[0].name, "项目名称");
  assert.equal(varTokens[1].raw, "{{ 项目名称 }}");
  assert.equal(varTokens[1].name, "项目名称");
  assert.equal(varTokens[2].name, "A");
  assert.equal(varTokens[3].name, "B");
});

test("变量替换：同名变量同步替换，按字面值一次替换，保留换行、$&、<文本> 和 {{保留原样}}", () => {
  const template =
    "项目：{{项目名称}}\n摘要：{{内容}}\n再次确认项目：{{ 项目名称 }}";
  const tricky = '第一行\n$& $$ $1 "引号" \'单引号\' <文本> {{保留原样}}';
  const rendered = replacePromptVariables(template, {
    项目名称: "个人工作台",
    内容: tricky,
  });

  assert.equal(
    rendered,
    `项目：个人工作台\n摘要：${tricky}\n再次确认项目：个人工作台`,
  );
  // 确认不会二次解析替换值中的 {{保留原样}}
  assert.ok(rendered.includes("{{保留原样}}"));
  assert.equal(hasActualVariableValue(""), false);
  assert.equal(hasActualVariableValue("   \n\t "), false);
  assert.equal(hasActualVariableValue("{{保留原样}}"), true);
});

test("标签规范化：去首尾空格、去空项、忽略大小写去重并保留首次顺序", () => {
  assert.deepEqual(
    normalizePromptTags(["  开发 ", "", "   ", "Git", "git", "开发", "周报"]),
    ["开发", "Git", "周报"],
  );
});

test("提示词存储：正文保留缩进与空白、标题校验、收藏/删除/恢复保留原编辑时间、排序与重启持久", async () => {
  const f = fixture();
  try {
    // 空白标题与空白正文均拒绝
    assert.throws(
      () => f.prompts.save({ title: "   ", body: "有效正文" }),
      /标题不能为空/,
    );
    assert.throws(
      () => f.prompts.save({ title: "有效标题", body: " \n\t  " }),
      /提示词正文不能为空/,
    );

    const multilineBody =
      "  第一行保留前导空格\n\n    const x = { a: 1 };\n  第三行  \n";
    const created = f.prompts.save({
      title: "  代码审查模板  ",
      body: multilineBody,
      tags: [" 开发 ", "git", "GIT", "  "],
    });
    assert.equal(created.title, "代码审查模板");
    assert.equal(created.body, multilineBody);
    assert.deepEqual(created.tags, ["开发", "git"]);
    assert.equal(created.starred, false);
    assert.equal(created.deletedAt, null);

    // 等待数毫秒确保若时间戳被误改可检出
    await new Promise((r) => setTimeout(r, 15));

    // 收藏/取消收藏不改变 updatedAt 和正文
    const starred = f.prompts.star(created.id, true);
    assert.equal(starred.starred, true);
    assert.equal(starred.updatedAt, created.updatedAt);
    assert.equal(starred.body, multilineBody);

    // 软删除不改变 updatedAt、收藏状态和正文
    const removed = f.prompts.remove(created.id);
    assert.ok(removed.deletedAt);
    assert.equal(removed.updatedAt, created.updatedAt);
    assert.equal(removed.starred, true);
    assert.equal(removed.body, multilineBody);
    assert.equal(f.prompts.list(false).length, 0);
    assert.equal(f.prompts.list(true).length, 1);

    // 已删除状态禁止直接编辑或收藏
    assert.throws(
      () => f.prompts.save({ id: created.id, title: "新", body: "新" }),
      /已删除/,
    );
    assert.throws(() => f.prompts.star(created.id, false), /已删除/);

    // 恢复不改变 updatedAt、收藏状态和正文
    const restored = f.prompts.restore(created.id);
    assert.equal(restored.deletedAt, null);
    assert.equal(restored.updatedAt, created.updatedAt);
    assert.equal(restored.starred, true);
    assert.equal(restored.body, multilineBody);

    // 编辑保留 id / createdAt / starred，更新 updatedAt
    await new Promise((r) => setTimeout(r, 15));
    const edited = f.prompts.save({
      id: created.id,
      title: "代码审查模板 v2",
      body: multilineBody + "追加一行",
      tags: ["开发"],
    });
    assert.equal(edited.id, created.id);
    assert.equal(edited.createdAt, created.createdAt);
    assert.equal(edited.starred, true);
    assert.notEqual(edited.updatedAt, created.updatedAt);

    // 排序：正常按 updatedAt 倒序，删除按 deletedAt 倒序
    await new Promise((r) => setTimeout(r, 15));
    const second = f.prompts.save({ title: "较新提示词", body: "正文2" });
    assert.deepEqual(
      f.prompts.list(false).map((p) => p.id),
      [second.id, edited.id],
    );

    f.prompts.remove(second.id);
    await new Promise((r) => setTimeout(r, 15));
    f.prompts.remove(edited.id);
    assert.deepEqual(
      f.prompts.list(true).map((p) => p.id),
      [edited.id, second.id],
    );

    // 重启打开后数据完整
    f.store.close();
    const reopened = new Store(f.dbPath);
    const reopenedService = new PromptsService(reopened);
    assert.equal(reopenedService.get(edited.id).body, multilineBody + "追加一行");
    assert.equal(reopenedService.get(edited.id).starred, true);
    assert.ok(reopenedService.get(edited.id).deletedAt);
    reopened.close();
  } finally {
    try {
      f.store.close();
    } catch {}
  }
});

test("备份与恢复完整保留提示词状态；兼容不含提示词数据的旧备份；拒绝损坏提示词备份", async () => {
  const f = fixture();
  try {
    const active = f.prompts.save({
      title: "周报模板",
      body: "为{{汇报对象}}写周报\n  缩进行",
      tags: ["周报", "工作总结"],
    });
    f.prompts.star(active.id, true);
    const trashed = f.prompts.save({
      title: "待恢复提示词",
      body: "旧正文",
      tags: ["归档"],
    });
    f.prompts.remove(trashed.id);

    const backupZip = path.join(f.dir, "with-prompts.zip");
    const created = await f.backup.create(backupZip);
    assert.equal(created.manifest.counts.prompt, 2);

    // 修改当前数据后恢复备份
    f.prompts.save({ id: active.id, title: "已被改动", body: "改后正文" });
    f.prompts.restore(trashed.id);

    const preview = f.backup.preview(backupZip);
    assert.equal(preview.counts.prompt, 2);
    assert.equal(preview.currentCounts.prompt, 2);

    await f.backup.restore(preview.token);
    const restoredActive = f.prompts.get(active.id);
    assert.equal(restoredActive.title, "周报模板");
    assert.equal(restoredActive.body, "为{{汇报对象}}写周报\n  缩进行");
    assert.deepEqual(restoredActive.tags, ["周报", "工作总结"]);
    assert.equal(restoredActive.starred, true);
    assert.equal(restoredActive.deletedAt, null);

    const restoredTrashed = f.prompts.get(trashed.id);
    assert.ok(restoredTrashed.deletedAt);
    assert.equal(restoredTrashed.body, "旧正文");

    // 构造旧版本备份（无 prompt 记录且 manifest.counts 缺少 prompt 字段）
    const legacyDir = path.join(f.dir, "legacy");
    fs.mkdirSync(legacyDir, { recursive: true });
    const legacyStore = new Store(path.join(legacyDir, "legacy.sqlite"));
    const legacyRecords = new RecordsService(legacyStore, legacyDir);
    const legacyNote = legacyRecords.save({
      kind: "work",
      text: "旧备份工作记录",
      happenedOn: "2026-10-20",
    });
    const legacyTasks = new TaskManager(legacyStore, legacyDir);
    const legacyBackupSvc = new BackupService(legacyStore, legacyTasks, legacyDir);
    const legacyZip = path.join(f.dir, "legacy-backup.zip");
    await legacyBackupSvc.create(legacyZip);
    legacyStore.close();

    // 删除 manifest.counts.prompt 模拟老版本打包出的备份
    const legacyEntries = unzipSync(fs.readFileSync(legacyZip));
    const legacyManifest = JSON.parse(strFromU8(legacyEntries["manifest.json"]));
    delete legacyManifest.counts.prompt;
    legacyEntries["manifest.json"] = strToU8(
      JSON.stringify(legacyManifest, null, 2),
    );
    fs.writeFileSync(legacyZip, zipSync(legacyEntries));

    const legacyPreview = f.backup.preview(legacyZip);
    assert.equal(legacyPreview.counts.prompt, 0);
    assert.equal(legacyPreview.counts.note, 1);

    await f.backup.restore(legacyPreview.token);
    assert.equal(f.prompts.list(false).length, 0);
    assert.equal(f.prompts.list(true).length, 0);
    assert.equal(f.records.get(legacyNote.id).text, "旧备份工作记录");

    // 验证损坏的 prompt 记录会被 Store.inspect 拦截
    const corruptDbPath = path.join(f.dir, "corrupt.sqlite");
    const corruptStore = new Store(corruptDbPath);
    corruptStore.set("prompt", "bad-id", {
      id: "bad-id",
      title: "   ",
      body: "x",
      tags: [],
      starred: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      deletedAt: null,
    });
    corruptStore.close();
    assert.throws(() => Store.inspect(corruptDbPath), /备份提示词无效/);
  } finally {
    try {
      f.store.close();
    } catch {}
  }
});

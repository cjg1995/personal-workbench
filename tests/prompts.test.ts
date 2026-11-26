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

test("提示词存储：保留正文空白，收藏保留编辑时间，删除永久移除并在重启后生效", async () => {
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

    // 等待数毫秒确保若时间戳被误改可检出
    await new Promise((r) => setTimeout(r, 15));

    // 收藏/取消收藏不改变 updatedAt 和正文
    const starred = f.prompts.star(created.id, true);
    assert.equal(starred.starred, true);
    assert.equal(starred.updatedAt, created.updatedAt);
    assert.equal(starred.body, multilineBody);

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

    // 列表按正文编辑时间倒序
    await new Promise((r) => setTimeout(r, 15));
    const second = f.prompts.save({ title: "较新提示词", body: "正文2" });
    assert.deepEqual(
      f.prompts.list().map((p) => p.id),
      [second.id, edited.id],
    );

    assert.equal(f.prompts.remove(second.id).id, second.id);
    assert.equal(f.store.get("prompt", second.id), undefined);
    assert.deepEqual(f.prompts.list(), [edited]);
    assert.throws(
      () => f.prompts.save({ id: second.id, title: "新", body: "新" }),
      /不存在/,
    );
    assert.throws(() => f.prompts.star(second.id, false), /不存在/);

    // 重启打开后数据完整
    f.store.close();
    const reopened = new Store(f.dbPath);
    const reopenedService = new PromptsService(reopened);
    assert.equal(reopenedService.get(edited.id).body, multilineBody + "追加一行");
    assert.equal(reopenedService.get(edited.id).starred, true);
    assert.throws(() => reopenedService.get(second.id), /不存在/);
    reopened.close();
  } finally {
    try {
      f.store.close();
    } catch {}
  }
});

test("备份恢复保留现存提示词，兼容无提示词的旧备份并拒绝损坏的提示词数据", async () => {
  const f = fixture();
  try {
    const active = f.prompts.save({
      title: "周报模板",
      body: "为{{汇报对象}}写周报\n  缩进行",
      tags: ["周报", "工作总结"],
    });
    f.prompts.star(active.id, true);
    const removed = f.prompts.save({
      title: "备份前删除的提示词",
      body: "旧正文",
      tags: ["归档"],
    });
    f.prompts.remove(removed.id);

    const backupZip = path.join(f.dir, "with-prompts.zip");
    const created = await f.backup.create(backupZip);
    assert.equal(created.manifest.counts.prompt, 1);

    // 修改当前数据后恢复备份
    f.prompts.save({ id: active.id, title: "已被改动", body: "改后正文" });
    f.prompts.save({ title: "备份后新增", body: "新正文" });

    const preview = f.backup.preview(backupZip);
    assert.equal(preview.counts.prompt, 1);
    assert.equal(preview.currentCounts.prompt, 2);

    await f.backup.restore(preview.token);
    const restoredActive = f.prompts.get(active.id);
    assert.equal(restoredActive.title, "周报模板");
    assert.equal(restoredActive.body, "为{{汇报对象}}写周报\n  缩进行");
    assert.deepEqual(restoredActive.tags, ["周报", "工作总结"]);
    assert.equal(restoredActive.starred, true);
    assert.deepEqual(f.prompts.list(), [restoredActive]);
    assert.equal(f.store.get("prompt", removed.id), undefined);

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
    assert.equal(f.prompts.list().length, 0);
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

test("升级和旧备份恢复时清理历史删除标记，保留现存提示词和记录", async () => {
  const f = fixture();
  try {
    const prompt = f.prompts.save({ title: "保留提示词", body: "现存正文" });
    const note = f.records.save({ kind: "work", text: "保留工作记录" });
    const deletedAt = new Date().toISOString();
    f.store.set("prompt", prompt.id, { ...prompt, deletedAt: null });
    f.store.set("prompt", "old-prompt", {
      ...prompt,
      id: "old-prompt",
      deletedAt,
    });
    f.store.set("note", "old-note", { ...note, id: "old-note", deletedAt });

    const file = path.join(f.dir, "old-deleted-entries.zip");
    const { manifest } = await f.backup.create(file);
    const archive = unzipSync(fs.readFileSync(file));
    archive["manifest.json"] = strToU8(
      JSON.stringify({ ...manifest, counts: f.store.counts() }),
    );
    fs.writeFileSync(file, zipSync(archive));

    const reopened = new Store(f.dbPath);
    try {
      assert.equal(reopened.get("prompt", "old-prompt"), undefined);
      assert.equal(reopened.get("note", "old-note"), undefined);
    } finally {
      reopened.close();
    }

    const preview = f.backup.preview(file);
    assert.equal(preview.manifest.counts.prompt, 2);
    assert.equal(preview.manifest.counts.note, 2);
    assert.equal(preview.counts.prompt, 1);
    assert.equal(preview.counts.note, 1);
    const restored = await f.backup.restore(preview.token);
    assert.deepEqual(restored.counts, preview.counts);
    assert.equal(f.store.get("prompt", "old-prompt"), undefined);
    assert.equal(f.store.get("note", "old-note"), undefined);
    assert.deepEqual(f.prompts.get(prompt.id), { ...prompt, deletedAt: null });
    assert.deepEqual(f.records.get(note.id), note);
  } finally {
    f.store.close();
  }
});

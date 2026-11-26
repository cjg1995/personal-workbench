import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { ConfigService } from "../src/core/config.js";
import { PromptsService } from "../src/core/prompts.js";
import { RecordsService } from "../src/core/records.js";
import { Store } from "../src/core/store.js";
import { localDate } from "../src/core/util.js";
import { WorkbenchTools } from "../src/core/workbench-tools.js";

function fixture(t: TestContext) {
  const root = path.resolve(".local", "data-fixtures");
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, "mcp-"));
  const store = new Store(path.join(dir, "workbench.sqlite"));
  t.after(() => store.close());
  const records = new RecordsService(store, dir);
  const prompts = new PromptsService(store);
  const config = new ConfigService(store, dir);
  const tools = new WorkbenchTools(store, records, prompts, config);
  return { records, prompts, tools };
}

test("工作记录写入保留原文，重试不重复新增，编辑拒绝旧版本", (t) => {
  const { tools, records } = fixture(t);
  const text = "核对项目启动失败（原因是启动参数缺失，已补充参数并验证启动）\n";
  const args = { text, project: "homeproject", requestId: "new-work" };
  const added = tools.call("add_work_record", args);
  assert.deepEqual(tools.call("add_work_record", args), added);
  assert.throws(() => tools.call("add_work_record", { ...args, text: "另一条" }), /请求 ID/);
  assert.equal(records.list("work").length, 1);
  assert.deepEqual(records.list("work").map((record) => record.text), [text]);
  assert.equal(records.list("work")[0].happenedOn, localDate());

  const changed = tools.call("edit_work_record", {
    id: added.id, revision: added.revision, happenedOn: "2026-11-21",
  });
  assert.equal(changed.id, added.id);
  assert.equal(records.list("work")[0].text, text);
  assert.equal(records.list("work")[0].projectId, "homeproject");
  assert.equal(records.list("work")[0].happenedOn, "2026-11-21");
  assert.throws(() => tools.call("delete_entry", {
    module: "work", id: added.id, revision: added.revision,
  }), /已更新/);
  assert.equal(records.list("work").length, 1);

  const remove = { module: "work", id: changed.id, revision: changed.revision, requestId: "remove-work" };
  const deleted = tools.call("delete_entry", remove);
  assert.equal(deleted.deleted, true);
  assert.deepEqual(tools.call("delete_entry", remove), deleted);
  assert.equal(records.list("work").length, 0);
});

test("纠正已有记录时保留待办完成状态、日期未知和提示词变量", (t) => {
  const { tools, records, prompts } = fixture(t);
  const idea = tools.call("add_idea", { text: "更新使用说明" });
  const ideaId = String(idea.id);
  records.complete(ideaId, true);
  const lookup = tools.call("find_entries", { module: "idea", id: ideaId });
  const [ideaEntry] = lookup.entries as { revision: string }[];
  const savedIdea = tools.call("edit_idea", {
    id: ideaId, revision: ideaEntry.revision, text: "更新安装说明",
  });
  assert.ok(records.get(ideaId).completedAt);
  assert.equal(records.get(ideaId).text, "更新安装说明");
  assert.throws(() => tools.call("delete_entry", { ...savedIdea, module: "work" }), /没有该条目/);
  tools.call("delete_entry", savedIdea);
  assert.throws(() => records.get(ideaId), /不存在/);

  const datedLater = tools.call("add_work_record", { text: "检查日志", happenedOn: null });
  tools.call("edit_work_record", {
    id: datedLater.id, revision: datedLater.revision, text: "检查运行日志",
  });
  assert.equal(records.list("work")[0].happenedOn, null);
  assert.equal(records.list("work")[0].text, "检查运行日志");
  assert.equal((tools.call("find_entries", { module: "work", query: "运行" }).entries as []).length, 1);

  const body = "请根据 {{记录}} 写一份周报\n";
  const prompt = tools.call("add_prompt", { title: "总结", body, tags: ["周报"] });
  const edited = tools.call("edit_prompt", {
    id: prompt.id, revision: prompt.revision, title: "工作周报",
  });
  assert.equal(prompts.get(String(prompt.id)).body, body);
  assert.deepEqual(prompts.get(String(prompt.id)).tags, ["周报"]);
  tools.call("delete_entry", edited);
  assert.equal(prompts.list().length, 0);
  assert.throws(() => prompts.get(String(prompt.id)), /不存在/);
  assert.deepEqual(tools.call("find_entries", { module: "prompt" }).entries, []);
});

test("查询默认返回全部匹配记录，支持显式请求超过 10 条", (t) => {
  const { tools, records } = fixture(t);
  for (let index = 1; index <= 18; index++) {
    records.save({ kind: "work", text: "核对记录 " + index });
  }
  records.save({ kind: "work", text: "其他工作" });
  records.save({ kind: "idea", text: "核对记录待办" });
  const params = { module: "work", query: "核对记录" };
  const matches = records.list("work").filter((entry) => entry.text.includes(params.query));
  const all = tools.call("find_entries", params).entries as { id: string }[];
  const limited = tools.call("find_entries", { ...params, limit: 15 }).entries as { id: string }[];
  assert.equal(all.length, 18);
  assert.deepEqual(all.map((entry) => entry.id), matches.map((entry) => entry.id));
  assert.equal(limited.length, 15);
  assert.deepEqual(limited, all.slice(0, 15));
});

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Store } from "../src/core/store.js";
import { Git, appPathRule } from "../src/core/git.js";
import { TaskManager } from "../src/core/tasks.js";
import { SubmitService } from "../src/core/submit.js";
import { GitClientService } from "../src/core/git-client.js";
import { submitPolicyForProject } from "../src/shared/submit-policy.js";
const root = path.resolve(
  ".local",
  "fixtures",
  "native 提交 [回归] " + randomUUID(),
);
fs.mkdirSync(root, { recursive: true });
function git(repo: string, ...args: string[]) {
  const r = spawnSync(
    "git",
    [
      "-c",
      "core.quotepath=false",
      "-c",
      "core.autocrlf=false",
      "-C",
      repo,
      ...args,
    ],
    {
      encoding: "utf8",
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_MERGE_AUTOEDIT: "no",
      },
    },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trimEnd();
}
function write(repo: string, file: string, text: string) {
  const p = path.join(repo, file);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, text);
}
let count = 0;
function fixture(branch = "dev", configFile = "store/index.js") {
  const dir = path.join(root, String(++count));
  fs.mkdirSync(dir);
  const remote = path.join(dir, "remote.git");
  const seed = path.join(dir, "seed"),
    client = path.join(dir, "client 中文 [路径]");
  const hooks = path.join(dir, "empty-hooks");
  fs.mkdirSync(hooks);
  fs.mkdirSync(seed);
  git(dir, "init", "--bare", "--initial-branch=" + branch, remote);
  git(dir, "-c", "core.hooksPath=" + hooks, "clone", remote, seed);
  const setup = (repo: string) => {
    git(repo, "config", "user.name", "原生回归");
    git(repo, "config", "user.email", "native@example.invalid");
    git(repo, "config", "commit.gpgsign", "false");
    git(repo, "config", "core.autocrlf", "false");
    git(repo, "config", "core.hooksPath", hooks);
  };
  setup(seed);
  for (const f of [
    ...(configFile ? [configFile] : []),
    "pages/index.vue",
    "api/remove.js",
    "mixin.js",
    "tests/existing.cjs",
    "package.json",
  ])
    write(seed, f, "base " + f + "\n");
  git(seed, "add", ".");
  git(seed, "commit", "-m", "初始");
  git(seed, "push", "origin", branch);
  git(dir, "clone", remote, client);
  setup(client);
  const db = new Store(path.join(dir, "data.sqlite"));
  const tasks = new TaskManager(db, dir);
  const service = new SubmitService(new Git(), tasks, dir);
  return { dir, remote, seed, client, db, tasks, service, setup };
}
async function prepare(f: ReturnType<typeof fixture>, projectId = "employee") {
  const check = await f.service.check(f.client, submitPolicyForProject(projectId));
  assert.equal(check.valid, true, JSON.stringify(check.checks));
  const t = await f.service.prepareApp(projectId, f.client, check.fingerprint);
  return f.tasks.wait(t.id);
}
async function finish(
  f: ReturnType<typeof fixture>,
  taskId: string,
  message = '中文说明 "quotes" & %PATH% ! $() ` literal',
) {
  await f.service.finishApp(taskId, message);
  return f.tasks.wait(taskId);
}

test("提测预览编辑沿用任务锁，连续保存更新暂存和指纹，保留提交说明与配置", async () => {
  const f = fixture();
  const client = new GitClientService(f.service.git, f.tasks, f.dir);
  try {
    const file = "pages/index.vue";
    write(f.client, file, "initial working edit\n");
    const check = await f.service.check(f.client, submitPolicyForProject("employee"), true);
    const t = await f.service.prepareApp("employee", f.client, check.fingerprint, true, "预览中填写的说明");
    await f.tasks.wait(t.id);
    assert.equal(f.tasks.get(t.id).state, "awaiting");
    assert.equal(f.tasks.get(t.id).params.message, "预览中填写的说明");
    let content = await client.content(f.client, { mode: "local" }, file);
    await assert.rejects(client.save(f.client, content.token, "blocked\n"), /已有写任务/);
    const originalConfig = fs.readFileSync(path.join(f.client, "store/index.js"));
    let token = content.token;
    for (const text of ["saved first\n", "base pages/index.vue\n", "saved second\n"]) {
      const result = await f.service.editAppPreview(t.id, "employee", file, (afterSave) =>
        client.save(f.client, token, text, { taskId: t.id, file, afterSave }));
      token = result.value.token;
      assert.equal(fs.readFileSync(path.join(f.client, file), "utf8"), text);
      assert.equal(git(f.client, "show", ":" + file), text.trimEnd());
      assert.equal(result.check.fingerprint, f.tasks.get(t.id).result.preparedFingerprint);
    }
    await assert.rejects(f.service.editAppPreview(t.id, "refsys-ui", file, async () => ({})), /待确认/);
    await assert.rejects(f.service.editAppPreview(t.id, "employee", "store/index.js", async () => ({})), /受保护/);
    write(f.client, file, "external IDEA edit\n");
    await assert.rejects(f.service.editAppPreview(t.id, "employee", file, (afterSave) =>
      client.save(f.client, token, "must not overwrite\n", { taskId: t.id, file, afterSave })), /变化/);
    assert.equal(fs.readFileSync(path.join(f.client, file), "utf8"), "external IDEA edit\n");
    write(f.client, file, "saved second\n");
    assert.equal((await finish(f, t.id, "最终编辑说明")).state, "success");
    assert.equal(git(f.remote, "show", "dev:" + file), "saved second");
    assert.equal(git(f.remote, "log", "-1", "--format=%s", "dev"), "最终编辑说明");
    assert.deepEqual(fs.readFileSync(path.join(f.client, "store/index.js")), originalConfig);
  } finally { f.db.close(); }
});
test("提测预览编辑不吸收保存期间的其他外部修改", async () => {
  const f = fixture();
  const client = new GitClientService(f.service.git, f.tasks, f.dir);
  try {
    write(f.client, "pages/index.vue", "before preview\n");
    const check = await f.service.check(f.client, submitPolicyForProject("employee"), true);
    const t = await f.service.prepareApp("employee", f.client, check.fingerprint, true);
    await f.tasks.wait(t.id);
    const fingerprint = f.tasks.get(t.id).result.preparedFingerprint;
    const content = await client.content(f.client, { mode: "local" }, "pages/index.vue");
    await assert.rejects(f.service.editAppPreview(t.id, "employee", "pages/index.vue", (afterSave) => {
      write(f.client, "api/remove.js", "concurrent external change\n");
      return client.save(f.client, content.token, "saved preview\n", { taskId: t.id, file: "pages/index.vue", afterSave });
    }), /其他文件被外部修改/);
    assert.equal(f.tasks.get(t.id).result.preparedFingerprint, fingerprint);
    assert.equal(fs.readFileSync(path.join(f.client, "api/remove.js"), "utf8"), "concurrent external change\n");
    assert.equal(fs.readFileSync(path.join(f.client, "pages/index.vue"), "utf8"), "saved preview\n");
    await assert.rejects(f.service.finishApp(t.id, "must not commit"), /变化/);
    assert.equal(git(f.remote, "show", "dev:api/remove.js"), "base api/remove.js");
  } finally { f.db.close(); }
});

test("APP 原文件纳入规则与已跟踪/新 package.json 差异", () => {
  for (const p of [
    "pages/customer/new.vue",
    "api/new.js",
    "js/new.js",
    "static/new.png",
    "components/a/index.vue",
    "nativeplugins/new/package.json",
  ])
    assert.equal(appPathRule(p, false).included, true, p);
  for (const p of [
    "store/index.js",
    "tests/check.cjs",
    "api/__tests__/a.js",
    "api/a.test.js",
    "pages/.idea/a.js",
    ".vscode/settings.json",
    "unpackage/new.js",
    "static/app.apk",
    ".env.local",
    "package.json",
    "pages/README.md",
  ])
    assert.equal(appPathRule(p, false).included, false, p);
  assert.equal(appPathRule("tests/old.js", true).included, false);
  assert.equal(appPathRule("package.json", true).included, true);
});

test("推荐官后台管理仅使用 main，更新、筛选、提交和远端核对完整执行", async () => {
  const f = fixture("main", "");
  try {
    const policy = submitPolicyForProject("refsys-ui");
    assert.equal(policy.kind, "app");
    write(f.client, "src/views/referrer/new.vue", "new admin page");
    write(f.client, "src/store/index.js", "admin business state");
    write(f.client, "src/api/config.js", "admin business api");
    write(f.client, "public/logo.svg", "admin logo");
    write(f.client, "tests/existing.cjs", "local test modification");
    git(f.client, "add", "tests/existing.cjs");
    write(f.client, "dist.rar", "local build output");
    write(f.client, ".env.production", "local environment");
    write(f.seed, "remote.txt", "main remote update");
    git(f.seed, "add", ".");
    git(f.seed, "commit", "-m", "main 更新");
    git(f.seed, "push");
    const prepared = await prepare(f, "refsys-ui");
    assert.equal(prepared.state, "awaiting", prepared.error || "");
    assert.equal(prepared.title, "推荐官后台管理提交");
    assert.equal(prepared.params.target, "origin/main");
    assert.equal(fs.readFileSync(path.join(f.client, "remote.txt"), "utf8"), "main remote update");
    const result = await finish(f, prepared.id, "推荐官后台管理页面");
    assert.equal(result.state, "success", result.error || "");
    assert.equal(result.result.verified, true);
    assert.equal(git(f.client, "branch", "--show-current"), "main");
    assert.equal(git(f.remote, "show", "main:src/views/referrer/new.vue"), "new admin page");
    assert.equal(git(f.remote, "show", "main:src/store/index.js"), "admin business state");
    assert.equal(git(f.remote, "show", "main:src/api/config.js"), "admin business api");
    assert.equal(git(f.remote, "show", "main:tests/existing.cjs"), "base tests/existing.cjs");
    assert.doesNotMatch(git(f.remote, "ls-tree", "-r", "--name-only", "main"), /dist\.rar|\.env\.production/);
    assert.equal(git(f.client, "stash", "list"), "");
    const nochange = await prepare(f, "refsys-ui");
    const head = git(f.remote, "rev-parse", "main");
    const skipped = await finish(f, nochange.id, "");
    assert.equal(skipped.state, "success", skipped.error || "");
    assert.equal(skipped.result.commitSkipped, true);
    assert.equal(git(f.remote, "rev-parse", "main"), head);

    for (const branch of ["dev", "feature-wrong"]) {
      git(f.client, "switch", "-c", branch);
      const check = await f.service.check(f.client, policy);
      assert.equal(check.valid, false);
      assert.equal(check.target, "origin/main");
      await assert.rejects(() => f.service.prepareApp("refsys-ui", f.client, check.fingerprint), /固定 main/);
      assert.equal(git(f.client, "branch", "--show-current"), branch);
    }
  } finally {
    f.db.close();
  }
});

test("推荐官小程序保护 config.js 字节和 Git 双标志，允许 store 与 UniApp 源码提交", async () => {
  const f = fixture("dev", "config.js");
  try {
    const localConfig = "本地测试地址\r\n保留原始字节\r\n";
    write(f.client, "config.js", localConfig);
    git(f.client, "add", "config.js");
    git(f.client, "update-index", "--skip-worktree", "config.js");
    git(f.client, "update-index", "--assume-unchanged", "config.js");
    for (const file of ["store/index.js", "plugins/auth.js", "uni_modules/uni-example/components/example.vue", "permission.js"])
      write(f.client, file, "mini business " + file);
    write(f.client, "pages/index.vue", "mini page change");
    write(f.client, "project.private.config.json", "local developer settings");
    write(f.seed, "config.js", "remote production config\n");
    git(f.seed, "add", ".");
    git(f.seed, "commit", "-m", "远程配置更新");
    git(f.seed, "push");
    const prepared = await prepare(f, "refsys-wechat");
    assert.equal(prepared.state, "awaiting", prepared.error || "");
    assert.equal(prepared.title, "推荐官小程序提交");
    assert.equal(prepared.params.target, "origin/dev");
    assert.equal(fs.readFileSync(path.join(f.client, "config.js"), "utf8"), localConfig);
    assert.match(git(f.client, "ls-files", "-v", "--", "config.js"), /^s /);
    const check = prepared.result.check as import("../src/shared/types.js").SubmitCheck;
    assert.equal(check.files.find((file) => file.path === "project.private.config.json")?.included, false);
    assert.doesNotMatch(git(f.client, "diff", "--cached", "--name-only"), /^config\.js$/m);
    const result = await finish(f, prepared.id, "推荐官小程序功能");
    assert.equal(result.state, "success", result.error || "");
    assert.equal(result.result.verified, true);
    assert.equal(git(f.remote, "show", "dev:config.js"), "remote production config");
    assert.equal(git(f.remote, "show", "dev:store/index.js"), "mini business store/index.js");
    assert.equal(git(f.remote, "show", "dev:plugins/auth.js"), "mini business plugins/auth.js");
    assert.equal(git(f.remote, "show", "dev:permission.js"), "mini business permission.js");
    assert.equal(fs.readFileSync(path.join(f.client, "config.js"), "utf8"), localConfig);
    assert.match(git(f.client, "ls-files", "-v", "--", "config.js"), /^s /);
    git(f.client, "switch", "-c", "main");
    assert.equal((await f.service.check(f.client, submitPolicyForProject("refsys-wechat"))).valid, false);
  } finally {
    f.db.close();
  }
});

test("推荐官小程序阻断待推送 config.js 历史及预览后的隐藏配置修改", async () => {
  const f = fixture("dev", "config.js");
  try {
    const policy = submitPolicyForProject("refsys-wechat");
    const original = git(f.remote, "rev-parse", "dev");
    git(f.client, "update-index", "--assume-unchanged", "config.js");
    const before = await f.service.check(f.client, policy);
    write(f.client, "config.js", "hidden local configuration changed");
    await assert.rejects(() => f.service.prepareApp("refsys-wechat", f.client, before.fingerprint), /变化/);
    assert.equal(git(f.client, "stash", "list"), "");
    git(f.client, "update-index", "--no-assume-unchanged", "config.js");
    git(f.client, "add", "config.js");
    git(f.client, "commit", "-m", "不允许的配置修改");
    const prepared = await prepare(f, "refsys-wechat");
    assert.equal(prepared.state, "failed");
    assert.match(prepared.error || "", /config\.js/);
    assert.equal(git(f.remote, "rev-parse", "dev"), original);
    assert.equal(fs.readFileSync(path.join(f.client, "config.js"), "utf8"), "hidden local configuration changed");
  } finally {
    f.db.close();
  }
});

test("推荐官小程序停止后从对应备份恢复 config.js 和标志，保留 stash 供核实", async () => {
  const f = fixture("dev", "config.js");
  try {
    const localConfig = "小程序恢复配置\r\n";
    write(f.client, "config.js", localConfig);
    git(f.client, "update-index", "--skip-worktree", "config.js");
    write(f.client, "pages/index.vue", "mini work before stop");
    let stopped = false;
    f.tasks.changed = () => {
      if (stopped) return;
      const task = f.tasks.list().find((task) => task.stages.find((stage) => stage.name === "保存本地改动")?.state === "done");
      if (task) {
        stopped = true;
        f.tasks.cancel(task.id);
      }
    };
    const prepared = await prepare(f, "refsys-wechat");
    assert.equal(prepared.state, "cancelled");
    const recovery = (await f.service.recoveries(f.client))[0];
    assert.equal(recovery.protectedFile, "config.js");
    assert.equal(recovery.stashExists, true);
    write(f.client, "config.js", "overwritten after interruption");
    await f.service.recoverConfig(f.client, recovery.id);
    assert.equal(fs.readFileSync(path.join(f.client, "config.js"), "utf8"), localConfig);
    assert.match(git(f.client, "ls-files", "-v", "--", "config.js"), /^S /);
    git(f.client, "stash", "apply", "--index", recovery.stashId);
    await f.service.acknowledgeRecovery(f.client, recovery.id);
    f.tasks.changed = () => {};
    const next = await prepare(f, "refsys-wechat");
    assert.equal(next.state, "awaiting", next.error || "");
    f.tasks.cancel(next.id);
  } finally {
    f.db.close();
  }
});

test("推荐官 main 提交在提交后切换分支时停止，不推送其他分支", async () => {
  const f = fixture("main", "");
  try {
    write(f.client, "src/views/new.vue", "approved main change");
    const prepared = await prepare(f, "refsys-ui");
    assert.equal(prepared.state, "awaiting", prepared.error || "");
    const original = git(f.remote, "rev-parse", "main");
    const run = f.service.git.run.bind(f.service.git);
    f.service.git.run = async (repo, args, options) => {
      const result = await run(repo, args, options);
      if (args.includes("commit")) git(repo, "switch", "-c", "feature-external");
      return result;
    };
    const result = await finish(f, prepared.id, "main 提交");
    assert.equal(result.state, "partial");
    assert.match(result.error || "", /分支已变化/);
    assert.equal(git(f.remote, "rev-parse", "main"), original);
  } finally {
    f.db.close();
  }
});

test("升级后仍能恢复旧版 APP 的 store-index.js 配置备份", async () => {
  const f = fixture();
  try {
    const localConfig = "旧版备份原始配置\r\n";
    write(f.client, "store/index.js", localConfig);
    git(f.client, "update-index", "--assume-unchanged", "store/index.js");
    const prepared = await prepare(f);
    assert.equal(prepared.state, "awaiting", prepared.error || "");
    f.tasks.cancel(prepared.id);
    const recovery = (await f.service.recoveries(f.client))[0];
    const recordFile = path.join(recovery.directory, "recovery.json");
    const legacyRecord = JSON.parse(fs.readFileSync(recordFile, "utf8"));
    delete legacyRecord.protectedFile;
    fs.writeFileSync(recordFile, JSON.stringify(legacyRecord));
    fs.renameSync(
      path.join(recovery.directory, "local-config.js"),
      path.join(recovery.directory, "store-index.js"),
    );
    write(f.client, "store/index.js", "different current configuration");
    await f.service.recoverConfig(f.client, recovery.id);
    assert.equal(fs.readFileSync(path.join(f.client, "store/index.js"), "utf8"), localConfig);
    assert.match(git(f.client, "ls-files", "-v", "--", "store/index.js"), /^h /);
  } finally {
    f.db.close();
  }
});

for (const prefix of ["feature-", "hotfix-"]) {
  test(`推荐官后端 ${prefix} 分支提交并合入已占用的 test 工作树`, async () => {
    const f = fixture("test", "");
    try {
      const branch = prefix + "推荐官回归";
      git(f.client, "switch", "-c", branch);
      git(f.client, "push", "-u", "origin", branch);
      const target = path.join(f.dir, "refsys test 工作树");
      git(f.client, "worktree", "add", target, "test");
      write(f.client, "pages/index.vue", "refsys tracked change");
      write(f.client, "new-source.java", "refsys staged source");
      git(f.client, "add", "new-source.java");
      write(f.client, "local-only.txt", "untracked stays local");
      const check = await f.service.check(f.client, submitPolicyForProject("refsys"));
      assert.equal(check.valid, true, JSON.stringify(check.checks));
      assert.equal(check.defaultMessage, "推荐官回归");
      const task = await f.service.startErp("refsys", f.client, check.defaultMessage, check.fingerprint);
      const result = await f.tasks.wait(task.id);
      assert.equal(result.state, "success", result.error || "");
      assert.equal(result.title, "推荐官后端提交");
      assert.equal(result.result.testPushed, true);
      assert.equal(git(f.client, "branch", "--show-current"), branch);
      assert.equal(git(f.remote, "show", "test:pages/index.vue"), "refsys tracked change");
      assert.equal(git(f.remote, "show", "test:new-source.java"), "refsys staged source");
      assert.doesNotMatch(git(f.remote, "ls-tree", "-r", "--name-only", "test"), /local-only\.txt/);
    } finally {
      f.db.close();
    }
  });
}
test("APP 正常闭环保护字节、assume-unchanged、用户 stash、特殊路径与排除内容", async () => {
  const f = fixture();
  write(f.client, "mixin.js", "user existing stash");
  git(f.client, "stash", "push", "-m", "existing-user-stash");
  const old = git(f.client, "rev-parse", "refs/stash");
  const city = "本地测试城市\r\n保持字节不变\r\n";
  write(f.client, "store/index.js", city);
  git(f.client, "add", "store/index.js");
  git(f.client, "update-index", "--assume-unchanged", "store/index.js");
  write(f.client, "pages/index.vue", "local feature");
  write(f.client, "pages/新增 [详情].vue", "<template>新</template>");
  write(f.client, "tests/new.cjs", "local test");
  write(f.client, "tests/existing.cjs", "edited local test");
  git(f.client, "add", "tests/existing.cjs");
  write(f.client, "static/new.png", "image-bytes");
  write(f.client, ".vscode/settings.json", "{}");
  write(f.client, "package.json", '{"changed":true}');
  fs.unlinkSync(path.join(f.client, "api/remove.js"));
  write(f.seed, "store/index.js", "remote city v2\n");
  write(f.seed, "remote.txt", "remote update");
  git(f.seed, "add", ".");
  git(f.seed, "commit", "-m", "远程更新");
  git(f.seed, "push", "origin", "dev");
  const prepared = await prepare(f);
  assert.equal(prepared.state, "awaiting", prepared.error || "");
  assert.equal(
    fs.readFileSync(path.join(f.client, "store/index.js"), "utf8"),
    city,
  );
  assert.match(git(f.client, "ls-files", "-v", "--", "store/index.js"), /^h /);
  const result = await finish(f, prepared.id);
  assert.equal(result.state, "success", result.error || "");
  assert.equal(result.result.verified, true);
  assert.equal(git(f.remote, "show", "dev:store/index.js"), "remote city v2");
  assert.equal(
    git(f.remote, "show", "dev:pages/新增 [详情].vue"),
    "<template>新</template>",
  );
  assert.equal(git(f.remote, "show", "dev:package.json"), '{"changed":true}');
  assert.equal(
    git(f.remote, "show", "dev:tests/existing.cjs"),
    "base tests/existing.cjs",
  );
  assert.equal(git(f.client, "rev-parse", "refs/stash"), old);
  assert.equal(git(f.client, "stash", "list").split("\n").length, 1);
  assert.equal(
    fs.readFileSync(path.join(f.client, "store/index.js"), "utf8"),
    city,
  );
  assert.equal(
    git(f.remote, "log", "-1", "--format=%B", "dev"),
    '中文说明 "quotes" & %PATH% ! $() ` literal',
  );
  const paths = git(f.remote, "ls-tree", "-r", "--name-only", "dev");
  assert.ok(!paths.includes("tests/new.cjs"));
  assert.ok(!paths.includes("api/remove.js"));
  const head = git(f.client, "rev-parse", "HEAD");
  const nochange = await prepare(f);
  assert.equal((await finish(f, nochange.id, "")).state, "success");
  assert.equal(git(f.client, "rev-parse", "HEAD"), head);
  f.db.close();
});
test("新 package.json 不自动纳入，取消保留更新和本地内容", async () => {
  const f = fixture();
  git(f.client, "rm", "package.json");
  git(f.client, "commit", "-m", "移除依赖文件");
  git(f.client, "push");
  git(f.seed, "pull", "--ff-only");
  write(f.client, "package.json", "new local dependency");
  write(f.client, "pages/index.vue", "cancel work");
  write(f.seed, "remote.txt", "updated");
  git(f.seed, "add", ".");
  git(f.seed, "commit", "-m", "远程");
  git(f.seed, "push");
  const p = await prepare(f);
  assert.equal(p.state, "awaiting", p.error || "");
  assert.equal(
    git(f.client, "diff", "--cached", "--name-only"),
    "pages/index.vue",
  );
  f.tasks.cancel(p.id);
  assert.equal(f.tasks.get(p.id).state, "cancelled");
  assert.equal(
    fs.readFileSync(path.join(f.client, "pages/index.vue"), "utf8"),
    "cancel work",
  );
  assert.equal(
    fs.readFileSync(path.join(f.client, "remote.txt"), "utf8"),
    "updated",
  );
  f.db.close();
});
test("推送被拒保留提交，重新检查后推送同一个提交", async () => {
  const f = fixture();
  write(f.client, "pages/index.vue", "to push");
  write(f.remote, "hooks/pre-receive", "#!/bin/sh\nexit 1\n");
  const p = await prepare(f);
  const failed = await finish(f, p.id);
  assert.equal(failed.state, "partial");
  const pending = git(f.client, "rev-parse", "HEAD");
  assert.notEqual(pending, git(f.remote, "rev-parse", "dev"));
  fs.unlinkSync(path.join(f.remote, "hooks/pre-receive"));
  const p2 = await prepare(f);
  assert.equal((await finish(f, p2.id, "")).state, "success");
  assert.equal(git(f.remote, "rev-parse", "dev"), pending);
  assert.equal(git(f.client, "rev-parse", "HEAD"), pending);
  f.db.close();
});
test("stash apply 冲突保留 stash、skip-worktree 和配置；不能自动重试", async () => {
  const f = fixture();
  const city = "自用城市\r\n";
  write(f.client, "store/index.js", city);
  git(f.client, "update-index", "--skip-worktree", "store/index.js");
  write(f.client, "pages/index.vue", "local conflict");
  write(f.seed, "pages/index.vue", "remote conflict");
  git(f.seed, "add", ".");
  git(f.seed, "commit", "-m", "冲突来源");
  git(f.seed, "push");
  const remote = git(f.remote, "rev-parse", "dev");
  const p = await prepare(f);
  assert.equal(p.state, "partial");
  assert.match(p.error || "", /失败/);
  assert.equal(
    git(f.client, "show", "stash:pages/index.vue"),
    "local conflict",
  );
  assert.equal(
    fs.readFileSync(path.join(f.client, "store/index.js"), "utf8"),
    city,
  );
  assert.match(git(f.client, "ls-files", "-v", "store/index.js"), /^S /);
  assert.equal(git(f.remote, "rev-parse", "dev"), remote);
  assert.equal((await f.service.check(f.client, "app")).valid, false);
  f.db.close();
});
test("错误分支与待推送历史 store 修改均阻断", async () => {
  const f = fixture();
  git(f.client, "switch", "-c", "feature-wrong");
  assert.equal((await f.service.check(f.client, "app")).valid, false);
  git(f.client, "switch", "dev");
  write(f.client, "store/index.js", "bad city");
  git(f.client, "add", ".");
  git(f.client, "commit", "-m", "禁止的本地城市");
  const p = await prepare(f);
  assert.equal(p.state, "failed");
  assert.match(p.error || "", /store\/index.js/);
  f.db.close();
});
test("Git 管理 ERP 提测提交暂存与已跟踪修改，在原目录切换 test，不新建工作树", async () => {
  const f = fixture("test");
  try {
    git(f.client, "switch", "-c", "feature-暂存提测");
    git(f.client, "push", "-u", "origin", "feature-暂存提测");
    write(f.client, "pages/index.vue", "staged page\nbase line\n");
    git(f.client, "add", "pages/index.vue");
    write(f.client, "pages/index.vue", "staged page\nunstaged line\n");
    write(f.client, "api/remove.js", "unstaged other file\n");
    write(f.client, "new-folder/中文 [暂存].txt", "explicitly staged\n");
    git(f.client, "add", "new-folder/中文 [暂存].txt");
    write(f.client, "new-folder/中文 [暂存].txt", "latest staged new file\n");
    fs.unlinkSync(path.join(f.client, "mixin.js"));
    write(f.client, "AGENTS.md", "hidden untracked\n");
    const check = await f.service.check(f.client, "erp", true);
    assert.equal(check.valid, true, JSON.stringify(check.checks));
    assert.deepEqual(check.files.filter((file) => file.included).map((file) => file.path).sort(),
      ["api/remove.js", "mixin.js", "new-folder/中文 [暂存].txt", "pages/index.vue"]);
    const task = await f.service.startErp("refsys", f.client, "提测暂存与本次修改", check.fingerprint, true);
    const result = await f.tasks.wait(task.id);
    assert.equal(result.state, "success", result.error || "");
    assert.equal(git(f.remote, "show", "test:pages/index.vue"), "staged page\nunstaged line");
    assert.equal(git(f.remote, "show", "test:api/remove.js"), "unstaged other file");
    assert.equal(git(f.remote, "show", "test:new-folder/中文 [暂存].txt"), "latest staged new file");
    assert.doesNotMatch(git(f.remote, "ls-tree", "-r", "--name-only", "test"), /^mixin\.js$/m);
    assert.doesNotMatch(git(f.remote, "ls-tree", "-r", "--name-only", "test"), /AGENTS\.md/);
    assert.equal(fs.readFileSync(path.join(f.client, "pages/index.vue"), "utf8"), "staged page\nunstaged line\n");
    assert.equal(fs.readFileSync(path.join(f.client, "api/remove.js"), "utf8"), "unstaged other file\n");
    assert.equal(fs.readFileSync(path.join(f.client, "AGENTS.md"), "utf8"), "hidden untracked\n");
    assert.equal(git(f.client, "branch", "--show-current"), "test");
    assert.equal(path.resolve(String(result.result.testPath)), path.resolve(f.client));
    assert.equal((git(f.client, "worktree", "list", "--porcelain").match(/^worktree /gm) || []).length, 1);
    assert.equal(git(f.client, "diff", "--cached", "--name-only"), "");
    assert.doesNotMatch(git(f.client, "worktree", "list", "--porcelain"), /test-worktree/);
    git(f.client, "switch", "feature-暂存提测");
    const empty = await f.service.check(f.client, "erp", true);
    const next = await f.service.startErp("refsys", f.client, "", empty.fingerprint, true);
    const skipped = await f.tasks.wait(next.id);
    assert.equal(skipped.state, "success", skipped.error || "");
    assert.equal(skipped.result.commitSkipped, true);
  } finally { f.db.close(); }
});

test("Git 管理固定分支提测纳入暂存与已跟踪修改，保留远程更新和本地配置保护", async () => {
  const f = fixture();
  try {
    write(f.client, "pages/index.vue", "staged page\nbase line\n");
    git(f.client, "add", "pages/index.vue");
    write(f.client, "pages/index.vue", "staged page\nunstaged line\n");
    write(f.client, "tests/existing.cjs", "unstaged tests\n");
    write(f.client, "pages/说明 [新].md", "explicit staged document\n");
    git(f.client, "add", "pages/说明 [新].md");
    write(f.client, "store/index.js", "protected local city\r\n");
    git(f.client, "add", "store/index.js");
    write(f.client, "AGENTS.md", "hidden untracked\n");
    write(f.seed, "api/remove.js", "remote update\n");
    git(f.seed, "add", ".");
    git(f.seed, "commit", "-m", "remote update");
    git(f.seed, "push");
    const policy = submitPolicyForProject("employee");
    const check = await f.service.check(f.client, policy, true);
    assert.equal(check.files.find((f) => f.path === "store/index.js")?.included, false);
    const task = await f.service.prepareApp("employee", f.client, check.fingerprint, true);
    const prepared = await f.tasks.wait(task.id);
    assert.equal(prepared.state, "awaiting", prepared.error || "");
    const final = prepared.result.check as import("../src/shared/types.js").SubmitCheck;
    assert.equal(final.fromGit, true);
    assert.deepEqual(final.files.filter((f) => f.included).map((f) => f.path).sort(),
      ["pages/index.vue", "pages/说明 [新].md", "tests/existing.cjs"]);
    assert.equal(git(f.client, "show", ":pages/index.vue"), "staged page\nunstaged line");
    const result = await finish(f, task.id, "提交暂存与本次修改");
    assert.equal(result.state, "success", result.error || "");
    assert.equal(result.result.verified, true);
    assert.equal(git(f.remote, "show", "dev:pages/index.vue"), "staged page\nunstaged line");
    assert.equal(git(f.remote, "show", "dev:pages/说明 [新].md"), "explicit staged document");
    assert.equal(git(f.remote, "show", "dev:tests/existing.cjs"), "unstaged tests");
    assert.equal(git(f.remote, "show", "dev:api/remove.js"), "remote update");
    assert.equal(git(f.remote, "show", "dev:store/index.js"), "base store/index.js");
    assert.equal(fs.readFileSync(path.join(f.client, "pages/index.vue"), "utf8"), "staged page\nunstaged line\n");
    assert.equal(fs.readFileSync(path.join(f.client, "store/index.js"), "utf8"), "protected local city\r\n");
    assert.equal(fs.readFileSync(path.join(f.client, "AGENTS.md"), "utf8"), "hidden untracked\n");
    assert.equal(git(f.client, "diff", "--cached", "--name-only"), "");
  } finally { f.db.close(); }
});

test("Git 管理提测预览纳入未暂存修改，预览后工作区或 Index 变化仍会拦截", async () => {
  const f = fixture("test");
  try {
    git(f.client, "switch", "-c", "feature-stale-index");
    git(f.client, "push", "-u", "origin", "feature-stale-index");
    write(f.client, "pages/index.vue", "unstaged only\n");
    const check = await f.service.check(f.client, "erp", true);
    assert.equal(check.files.some((f) => f.included), true);
    git(f.client, "add", "pages/index.vue");
    await assert.rejects(() => f.service.startErp("homeproject", f.client, "stale", check.fingerprint, true), /变化/);
    const refreshed = await f.service.check(f.client, "erp", true);
    write(f.client, "pages/index.vue", "new edit after preview\n");
    await assert.rejects(() => f.service.startErp("homeproject", f.client, "stale", refreshed.fingerprint, true), /变化/);
    assert.equal(git(f.remote, "show", "test:pages/index.vue"), "base pages/index.vue");
  } finally { f.db.close(); }
});

test("ERP 已跟踪改动及已暂存新文件纳入，未暂存新文件保持", async () => {
  const f = fixture("test");
  git(f.client, "switch", "-c", "feature-需求示例");
  git(f.client, "push", "-u", "origin", "feature-需求示例");
  write(f.client, "pages/index.vue", "tracked");
  write(f.client, "staged new.txt", "staged");
  git(f.client, "add", "staged new.txt");
  write(f.client, "untracked.txt", "stay local");
  const c = await f.service.check(f.client, "erp");
  assert.equal(c.valid, true, JSON.stringify(c.checks));
  assert.equal(c.defaultMessage, "需求示例");
  const t = await f.service.startErp(
    "homeproject",
    f.client,
    c.defaultMessage,
    c.fingerprint,
  );
  const r = await f.tasks.wait(t.id);
  assert.equal(r.state, "success", r.error || "");
  assert.equal(git(f.client, "branch", "--show-current"), "test");
  const paths = git(f.remote, "ls-tree", "-r", "--name-only", "test");
  assert.ok(paths.includes("staged new.txt"));
  assert.ok(!paths.includes("untracked.txt"));
  f.db.close();
});
test("ERP 占用 test 的 worktree 与无变更分支，脏 test 阻断", async () => {
  const f = fixture("test");
  git(f.client, "switch", "-c", "hotfix-补丁");
  git(f.client, "push", "-u", "origin", "hotfix-补丁");
  const target = path.join(f.dir, "test 工作树");
  git(f.client, "worktree", "add", target, "test");
  let c = await f.service.check(f.client, "erp");
  assert.equal(path.resolve(c.testPath!), path.resolve(target));
  assert.equal(c.valid, true);
  const approvedFingerprint = c.fingerprint;
  write(
    f.client,
    "untracked-build-output.txt",
    "excluded output before commit",
  );
  assert.equal(
    (await f.service.check(f.client, "erp")).fingerprint,
    approvedFingerprint,
  );
  write(
    f.client,
    "untracked-build-output.txt",
    "compiler refreshed excluded output",
  );
  assert.equal(
    (await f.service.check(f.client, "erp")).fingerprint,
    approvedFingerprint,
  );
  const head = c.head;
  const t = await f.service.startErp(
    "homeproject-ai",
    f.client,
    "",
    c.fingerprint,
  );
  const r = await f.tasks.wait(t.id);
  assert.equal(r.state, "success", r.error || "");
  assert.equal(git(f.client, "rev-parse", "HEAD"), head);
  assert.equal(git(f.client, "branch", "--show-current"), "hotfix-补丁");
  write(target, "pages/index.vue", "dirty test");
  c = await f.service.check(f.client, "erp");
  assert.equal(c.valid, false);
  f.db.close();
});
test("预览后代码变化不执行写操作；任务重开为中断", async () => {
  const f = fixture();
  const c = await f.service.check(f.client, "app");
  const before = git(f.client, "rev-parse", "HEAD");
  write(f.client, "pages/index.vue", "changed since preview");
  await assert.rejects(
    () => f.service.prepareApp("employee", f.client, c.fingerprint),
    /变化/,
  );
  assert.equal(git(f.client, "rev-parse", "HEAD"), before);
  const t = f.tasks.create("app", "中断测试", "employee", "test-lock", {});
  const restored = new TaskManager(f.db, f.dir);
  assert.equal(restored.get(t.id).state, "interrupted");
  f.db.close();
});
for (const fromGit of [false, true]) {
test(`${fromGit ? "Git 管理" : "ERP"} 提测冲突留在原目录，保留 MERGE_HEAD 并可由 IDEA/Git 正常解决`, async () => {
  const f = fixture("test");
  git(f.client, "switch", "-c", "feature-冲突");
  git(f.client, "push", "-u", "origin", "feature-冲突");
  write(f.client, "pages/index.vue", "feature conflict");
  write(f.seed, "pages/index.vue", "test conflict");
  git(f.seed, "add", ".");
  git(f.seed, "commit", "-m", "test 更新");
  git(f.seed, "push", "origin", "test");
  const remote = git(f.remote, "rev-parse", "test");
  const c = await f.service.check(f.client, "erp", fromGit);
  const task = await f.service.startErp(
    "homeproject",
    f.client,
    "冲突",
    c.fingerprint,
    fromGit,
  );
  const result = await f.tasks.wait(task.id);
  assert.equal(result.state, "partial");
  assert.equal(result.result.developmentPushed, true);
  assert.equal(result.result.testUpdated, true);
  assert.ok(!result.result.testPushed);
  assert.equal(git(f.remote, "rev-parse", "test"), remote);
  assert.ok(fs.existsSync(path.join(f.client, ".git", "MERGE_HEAD")));
  assert.equal((result.result.conflicts as any[])[0].file, "pages/index.vue");
  assert.equal(result.result.finalBranch, "test");
  assert.equal(path.resolve((result.result.conflicts as any[])[0].repo), path.resolve(f.client));
  assert.equal((git(f.client, "worktree", "list", "--porcelain").match(/^worktree /gm) || []).length, 1);
  assert.match(fs.readFileSync(path.join(f.client, "pages/index.vue"), "utf8"), /<<<<<<<|=======|>>>>>>>/);
  write(f.client, "pages/index.vue", "resolved in original project\n");
  git(f.client, "add", "pages/index.vue");
  git(f.client, "commit", "--no-edit");
  assert.equal(fs.existsSync(path.join(f.client, ".git", "MERGE_HEAD")), false);
  assert.equal(git(f.client, "show", "HEAD:pages/index.vue"), "resolved in original project");
  f.db.close();
});
}
test("APP 分叉正常合并，恢复 assume-unchanged 与 skip-worktree 双标志", async () => {
  const f = fixture();
  const city = "双标志本地城市\r\n";
  write(f.client, "store/index.js", city);
  git(f.client, "update-index", "--skip-worktree", "store/index.js");
  git(f.client, "update-index", "--assume-unchanged", "store/index.js");
  write(f.client, "api/pending.js", "pending");
  git(f.client, "add", "api/pending.js");
  git(f.client, "commit", "-m", "待推送");
  write(f.seed, "store/index.js", "remote city v3");
  git(f.seed, "add", ".");
  git(f.seed, "commit", "-m", "远程城市更新");
  git(f.seed, "push");
  const p = await prepare(f);
  assert.equal(p.state, "awaiting", p.error || "");
  const result = await finish(f, p.id, "");
  assert.equal(result.state, "success", result.error || "");
  assert.equal(git(f.remote, "show", "dev:store/index.js"), "remote city v3");
  assert.equal(git(f.remote, "show", "dev:api/pending.js"), "pending");
  assert.equal(
    fs.readFileSync(path.join(f.client, "store/index.js"), "utf8"),
    city,
  );
  assert.match(git(f.client, "ls-files", "-v", "store/index.js"), /^s /);
  f.db.close();
});
test("APP 在 stash 后请求停止：命令边界停止、配置恢复、stash 保留并要求人工核实", async () => {
  const f = fixture();
  write(f.client, "store/index.js", "停止时配置");
  write(f.client, "pages/index.vue", "local before stop");
  let stopped = false;
  f.tasks.changed = () => {
    if (stopped) return;
    const t = f.tasks
      .list()
      .find(
        (t) =>
          t.type === "app" &&
          t.stages.find((s) => s.name === "保存本地改动")?.state === "done",
      );
    if (t) {
      stopped = true;
      f.tasks.cancel(t.id);
    }
  };
  const p = await prepare(f);
  assert.equal(p.state, "cancelled");
  assert.equal(
    fs.readFileSync(path.join(f.client, "store/index.js"), "utf8"),
    "停止时配置",
  );
  const r = (await f.service.recoveries(f.client))[0];
  assert.equal(r.stashExists, true);
  assert.equal(r.restored, true);
  const c = await f.service.check(f.client, "app");
  await assert.rejects(
    () => f.service.prepareApp("employee", f.client, c.fingerprint),
    /恢复记录/,
  );
  git(f.client, "stash", "apply", "--index", r.stashId);
  await f.service.acknowledgeRecovery(f.client, r.id);
  f.tasks.changed = () => {};
  const ready = await prepare(f);
  assert.equal(ready.state, "awaiting", ready.error || "");
  f.tasks.cancel(ready.id);
  assert.ok(git(f.client, "stash", "list", "--format=%H").includes(r.stashId));
  f.db.close();
});
test("APP 子进程真实异常退出后重开：不自动重跑，能从原批次恢复配置并核对 stash", async () => {
  const f = fixture();
  const city = "重启恢复原始配置\r\n";
  write(f.client, "store/index.js", city);
  git(f.client, "update-index", "--skip-worktree", "store/index.js");
  write(f.client, "pages/index.vue", "crash local work");
  const child = path.join(f.dir, "interrupt.cjs");
  const module = (name: string) =>
    pathToFileURL(path.resolve(".local/tests/src/core/" + name + ".js")).href;
  fs.writeFileSync(
    child,
    `(async()=>{const {Store}=await import(${JSON.stringify(module("store"))});const {TaskManager}=await import(${JSON.stringify(module("tasks"))});const {SubmitService}=await import(${JSON.stringify(module("submit"))});const {Git}=await import(${JSON.stringify(module("git"))});const s=new Store(${JSON.stringify(path.join(f.dir, "data.sqlite"))});const tasks=new TaskManager(s,${JSON.stringify(f.dir)});tasks.changed=()=>{const t=tasks.list().find(t=>t.stages.find(s=>s.name==='保存本地改动')?.state==='done');if(t)process.exit(33)};const service=new SubmitService(new Git(),tasks,${JSON.stringify(f.dir)});const c=await service.check(${JSON.stringify(f.client)},'app');await service.prepareApp('employee',${JSON.stringify(f.client)},c.fingerprint)})().catch(e=>{console.error(e);process.exit(1)});`,
  );
  const exit = spawnSync(process.execPath, [child], {
    encoding: "utf8",
    windowsHide: true,
  });
  assert.equal(exit.status, 33, exit.stderr);
  const reopened = new TaskManager(f.db, f.dir);
  const task = reopened.list().find((t) => t.type === "app")!;
  assert.equal(task.state, "interrupted");
  const recovery = (await f.service.recoveries(f.client)).find(
    (r) => r.id === task.id,
  )!;
  assert.equal(recovery.restored, false);
  assert.equal(recovery.stashExists, true);
  await f.service.recoverConfig(f.client, recovery.id);
  assert.equal(
    fs.readFileSync(path.join(f.client, "store/index.js"), "utf8"),
    city,
  );
  assert.match(git(f.client, "ls-files", "-v", "store/index.js"), /^S /);
  assert.equal(
    git(f.client, "show", recovery.stashId + ":pages/index.vue"),
    "crash local work",
  );
  f.db.close();
});

test("APP 最终确认校验期间重复确认只能启动一次，取消不会被旧请求重新启动", async () => {
  const f = fixture();
  try {
    write(f.client, "pages/index.vue", "one confirmation only");
    const prepared = await prepare(f);
    assert.equal(prepared.state, "awaiting", prepared.error || "");
    const fingerprint = f.service.git.fingerprint.bind(f.service.git);
    let entered!: () => void, release!: () => void;
    let checked = new Promise<void>((resolve) => { entered = resolve; });
    let gate = new Promise<void>((resolve) => { release = resolve; });
    f.service.git.fingerprint = async (...args) => {
      entered();
      await gate;
      return fingerprint(...args);
    };
    let launches = 0;
    // Keep the actual repository unchanged while observing whether writes would be launched twice.
    f.tasks.launch = (task) => { launches++; return task; };
    const first = f.service.finishApp(prepared.id, "确认一次");
    await checked;
    const second = f.service.finishApp(prepared.id, "重复确认");
    const results = Promise.allSettled([first, second]);
    release();
    const settled = await results;
    assert.equal(settled.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(launches, 1);

    prepared.state = "awaiting";
    f.tasks.save(prepared);
    checked = new Promise<void>((resolve) => { entered = resolve; });
    gate = new Promise<void>((resolve) => { release = resolve; });
    const pending = f.service.finishApp(prepared.id, "校验期间取消");
    const rejected = assert.rejects(pending, /取消|待确认|状态/);
    await checked;
    f.tasks.cancel(prepared.id);
    release();
    await rejected;
    assert.equal(f.tasks.get(prepared.id).state, "cancelled");
    assert.equal(launches, 1);
  } finally {
    f.db.close();
  }
});

test("APP fetch 期间切换分支在配置备份和合并前阻断", async () => {
  const f = fixture();
  try {
    write(f.client, "store/index.js", "local configuration must survive\r\n");
    write(f.client, "pages/index.vue", "local work");
    const run = f.service.git.run.bind(f.service.git);
    f.service.git.run = async (repo, args, options) => {
      const result = await run(repo, args, options);
      if (args[0] === "fetch") git(repo, "switch", "-c", "feature-external");
      return result;
    };
    const check = await f.service.check(f.client, "app");
    const task = await f.service.prepareApp("employee", f.client, check.fingerprint);
    const result = await f.tasks.wait(task.id);
    assert.notEqual(result.state, "awaiting");
    assert.match(result.error || "", /变化|分支/);
    assert.equal(result.stages.find((s) => s.name === "备份与保护本地配置")?.state, "failed");
    assert.equal(fs.readFileSync(path.join(f.client, "store/index.js"), "utf8"), "local configuration must survive\r\n");
    assert.equal(git(f.client, "stash", "list"), "");
    assert.equal(git(f.client, "diff", "--cached", "--name-only"), "");
  } finally {
    f.db.close();
  }
});

test("ERP test 工作树在开发推送期间切到其他分支时不能拉取或合并", async () => {
  const f = fixture("test");
  try {
    git(f.client, "switch", "-c", "feature-target-guard");
    git(f.client, "push", "-u", "origin", "feature-target-guard");
    const target = path.join(f.dir, "test worktree");
    git(f.client, "worktree", "add", target, "test");
    write(f.client, "pages/index.vue", "feature change");
    const targetHead = git(target, "rev-parse", "HEAD");
    const run = f.service.git.run.bind(f.service.git);
    f.service.git.run = async (repo, args, options) => {
      const result = await run(repo, args, options);
      if (repo === f.client && args[0] === "push")
        git(target, "switch", "-c", "unrelated-branch");
      return result;
    };
    const check = await f.service.check(f.client, "erp");
    const task = await f.service.startErp("homeproject", f.client, "保护 test 工作树", check.fingerprint);
    const result = await f.tasks.wait(task.id);
    assert.equal(result.state, "partial");
    assert.match(result.error || "", /分支|test/);
    assert.equal(result.result.developmentPushed, true);
    assert.ok(!result.result.testUpdated);
    assert.equal(git(target, "rev-parse", "HEAD"), targetHead);
    assert.equal(git(f.remote, "rev-parse", "test"), targetHead);
  } finally {
    f.db.close();
  }
});

test("APP 链接工作树的手工恢复遵守公共仓库锁", async () => {
  const f = fixture();
  try {
    git(f.client, "switch", "-c", "feature-original");
    const target = path.join(f.dir, "dev worktree");
    git(f.client, "worktree", "add", target, "dev");
    write(target, "store/index.js", "linked worktree local configuration");
    const check = await f.service.check(target, "app");
    const task = await f.service.prepareApp("employee", target, check.fingerprint);
    assert.equal((await f.tasks.wait(task.id)).state, "awaiting");
    const recovery = (await f.service.recoveries(target))[0];
    assert.equal(recovery.restored, true);
    await assert.rejects(() => f.service.recoverConfig(target, recovery.id), /已有写任务/);
    await assert.rejects(() => f.service.acknowledgeRecovery(target, recovery.id), /已有写任务/);
    f.tasks.cancel(task.id);
    assert.equal((await f.service.recoverConfig(target, recovery.id)).configRestored, true);
  } finally {
    f.db.close();
  }
});

test("APP 本地提交后切换到其他分支时不推送该分支到 dev", async () => {
  const f = fixture();
  try {
    write(f.client, "pages/index.vue", "approved local commit");
    const prepared = await prepare(f);
    const remoteHead = git(f.remote, "rev-parse", "dev");
    let switched = false;
    f.tasks.changed = () => {
      const task = f.tasks.get(prepared.id);
      if (switched || task.stages.find((s) => s.name === "本地提交")?.state !== "done") return;
      switched = true;
      git(f.client, "switch", "-c", "feature-external-after-commit");
      write(f.client, "pages/index.vue", "unapproved external commit");
      git(f.client, "add", "pages/index.vue");
      git(f.client, "commit", "-m", "external change");
    };
    const result = await finish(f, prepared.id);
    assert.equal(result.state, "partial");
    assert.match(result.error || "", /分支已变化/);
    assert.equal(result.result.commitCreated, true);
    assert.ok(!result.result.pushCompleted);
    assert.equal(git(f.remote, "rev-parse", "dev"), remoteHead);
  } finally {
    f.db.close();
  }
});

test("APP 提交前只读校验期间取消，在下一写命令前停止", async () => {
  const f = fixture();
  try {
    write(f.client, "pages/index.vue", "cancel before commit");
    const prepared = await prepare(f);
    const head = git(f.client, "rev-parse", "HEAD");
    const run = f.service.git.run.bind(f.service.git);
    let cancelled = false;
    f.service.git.run = async (repo, args, options) => {
      const result = await run(repo, args, options);
      if (!cancelled && args[0] === "log") {
        cancelled = true;
        f.tasks.cancel(prepared.id);
      }
      return result;
    };
    const result = await finish(f, prepared.id);
    assert.equal(cancelled, true);
    assert.equal(result.state, "cancelled");
    assert.ok(!result.result.commitCreated);
    assert.equal(git(f.client, "rev-parse", "HEAD"), head);
    assert.equal(git(f.remote, "rev-parse", "dev"), head);
  } finally {
    f.db.close();
  }
});

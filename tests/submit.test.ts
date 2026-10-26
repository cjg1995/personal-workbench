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
function fixture(branch = "dev") {
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
    "store/index.js",
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
async function prepare(f: ReturnType<typeof fixture>) {
  const check = await f.service.check(f.client, "app");
  assert.equal(check.valid, true, JSON.stringify(check.checks));
  const t = await f.service.prepareApp("employee", f.client, check.fingerprint);
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
test("ERP 开发分支已推送、test 合并冲突时保留部分结果和真实冲突文件", async () => {
  const f = fixture("test");
  git(f.client, "switch", "-c", "feature-冲突");
  git(f.client, "push", "-u", "origin", "feature-冲突");
  write(f.client, "pages/index.vue", "feature conflict");
  write(f.seed, "pages/index.vue", "test conflict");
  git(f.seed, "add", ".");
  git(f.seed, "commit", "-m", "test 更新");
  git(f.seed, "push", "origin", "test");
  const remote = git(f.remote, "rev-parse", "test");
  const c = await f.service.check(f.client, "erp");
  const task = await f.service.startErp(
    "homeproject",
    f.client,
    "冲突",
    c.fingerprint,
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
  f.db.close();
});
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

import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Git } from "../src/core/git.js";
import { GitClientService } from "../src/core/git-client.js";
import { ConfigService, defaults } from "../src/core/config.js";
import { Store } from "../src/core/store.js";
import { TaskManager } from "../src/core/tasks.js";
import { conflictBlocks } from "../src/shared/conflicts.js";
import {
  defaultUntrackedRuleByProject,
  describeUntrackedRule,
  parseUntrackedInput,
  type GitUntrackedFilter,
} from "../src/shared/git-untracked.js";
const root = path.resolve(".local/git-client-fixtures", randomUUID());
fs.mkdirSync(root, { recursive: true });
let sequence = 0;
function git(repo: string, ...args: string[]) {
  const r = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (r.status) throw new Error(r.stderr || r.stdout);
  return r.stdout.trimEnd();
}
function write(repo: string, file: string, text: string | Buffer) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), text);
}
function fixture(
  unborn = false,
  untrackedFilter?: GitUntrackedFilter | string[],
) {
  const repo = path.join(root, String(++sequence));
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "dev");
  git(repo, "config", "user.name", "Git Client Test");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "core.autocrlf", "false");
  git(repo, "config", "commit.gpgsign", "false");
  const hooks = path.join(repo, ".git/empty-hooks");
  fs.mkdirSync(hooks);
  git(repo, "config", "core.hooksPath", hooks);
  const data = path.join(repo, ".git/client-data");
  fs.mkdirSync(data);
  const store = new Store(path.join(data, "test.sqlite")),
    tasks = new TaskManager(store, data),
    client = new GitClientService(new Git(), tasks, data, () => untrackedFilter);
  if (!unborn) {
    write(
      repo,
      "文件 [1].txt",
      Array.from({ length: 35 }, (_, i) => `line ${i + 1}\n`).join(""),
    );
    write(repo, "other.js", "base\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "base");
  }
  return { repo, store, tasks, client };
}
test("未跟踪文件根据完整 Index 目录树分类，包含未修改文件和祖先目录，新增子目录不误匹配", async () => {
  const f = fixture();
  try {
    write(f.repo, "已有目录/子目录/known.ts", "unchanged\n");
    write(f.repo, "prefix/keep.ts", "unchanged\n");
    git(f.repo, "add", ".");
    git(f.repo, "commit", "-m", "tracked tree");
    const expected: Record<string, boolean> = {
      "已有目录/子目录/new.ts": true,
      "已有目录/parent.txt": true,
      "root-new.txt": false,
      "AGENTS.md": false,
      "已有目录/新建目录/new.ts": false,
      "全新目录/new.ts": false,
      "prefix-extra/new.ts": false,
    };
    for (const file of Object.keys(expected)) write(f.repo, file, "new\n");
    const index = fs.readFileSync(path.join(f.repo, ".git/index"));
    for (const rows of [
      (await f.client.status(f.repo)).files,
      await f.client.files(f.repo, { mode: "local" }),
    ]) {
      for (const [file, allowed] of Object.entries(expected)) {
        assert.equal(
          rows.find((row) => row.path === file)?.inTrackedDirectory,
          allowed,
          file,
        );
      }
    }
    assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git/index")), index);
    write(f.repo, "全新目录/keep.ts", "stage explicitly\n");
    await f.client.execute(f.repo, "stage", { files: ["全新目录/keep.ts"] });
    assert.equal(
      (await f.client.status(f.repo)).files.find(
        (file) => file.path === "全新目录/new.ts",
      )?.inTrackedDirectory,
      true,
    );
    await f.client.execute(f.repo, "unstage", { files: ["全新目录/keep.ts"] });
    assert.equal(
      (await f.client.status(f.repo)).files.find(
        (file) => file.path === "全新目录/new.ts",
      )?.inTrackedDirectory,
      false,
    );
  } finally {
    f.store.close();
  }
});
test("refsys 范围显示 src/main 全部新文件与根 pom.xml，范围外新文件隐藏，保留已跟踪修改", async () => {
  const f = fixture(false, ["src/main/", "pom.xml"]);
  try {
    const expected: Record<string, boolean> = {
      "src/main/java/com/ruoyi/project/monitor/domain/req/CustomerPhoneLogQuery.java": true,
      "src/main/java/com/ruoyi/project/monitor/domain/resp/CustomerPhoneLogExportResp.java": true,
      "src/main/resources/new/config.properties": true,
      "src/main/new-package/new.txt": true,
      "pom.xml": true,
      "src/test/java/NewTest.java": false,
      "src/main-other/No.java": false,
      "docs/pom.xml": false,
      ".codex/hooks/new.ps1": false,
      "AGENTS.md": false,
    };
    for (const file of Object.keys(expected)) write(f.repo, file, "new\n");
    write(f.repo, "other.js", "tracked edit outside scope\n");
    const index = fs.readFileSync(path.join(f.repo, ".git/index"));
    for (const rows of [(await f.client.status(f.repo)).files, await f.client.files(f.repo, { mode: "local" })]) {
      for (const [file, visible] of Object.entries(expected)) {
        assert.equal(rows.find((row) => row.path === file)?.untracked, true, file);
        assert.equal(rows.find((row) => row.path === file)?.inTrackedDirectory, visible, file);
      }
      assert.equal(rows.find((row) => row.path === "other.js")?.untracked, false);
    }
    assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git/index")), index);
    await f.client.execute(f.repo, "stage", { files: ["pom.xml", "src/main/java/com/ruoyi/project/monitor/domain/req/CustomerPhoneLogQuery.java"] });
    const staged = (await f.client.status(f.repo)).files.filter((file) => file.staged).map((file) => file.path);
    assert.deepEqual(staged.sort(), ["pom.xml", "src/main/java/com/ruoyi/project/monitor/domain/req/CustomerPhoneLogQuery.java"]);
  } finally { f.store.close(); }
});

test("refsys-ui 范围显示 src 下的新 Vue 页面，范围外新文件隐藏，页面可实际暂存", async () => {
  const f = fixture(false, ["src/"]);
  try {
    const pages = ["src/views/monitor/customerPhoneLog/index.vue", "src/views/system/loginIpBlock/index.vue"];
    const expected: Record<string, boolean> = {
      [pages[0]]: true,
      [pages[1]]: true,
      "src/api/new-directory/api.js": true,
      "public/new-images/logo.svg": false,
      "package.json": false,
      "vue.config.js": false,
      "src-other/index.vue": false,
      "scripts/test-security-optimization.cjs": false,
      "dist.rar": false,
      "AGENTS.md": false,
    };
    for (const file of Object.keys(expected)) write(f.repo, file, "new\n");
    for (const rows of [(await f.client.status(f.repo)).files, await f.client.files(f.repo, { mode: "local" })])
      for (const [file, visible] of Object.entries(expected))
        assert.equal(rows.find((row) => row.path === file)?.inTrackedDirectory, visible, file);
    await f.client.execute(f.repo, "stage", { files: pages });
    assert.deepEqual((await f.client.status(f.repo)).files.filter((file) => file.staged).map((file) => file.path).sort(), pages.sort());
    assert.deepEqual(git(f.repo, "diff", "--cached", "--name-only").split("\n").sort(), pages);
  } finally { f.store.close(); }
});

test("真实 Index：混合暂存状态、整文件 Stage/Unstage 和仅提交 Index", async () => {
  const f = fixture();
  try {
    write(f.repo, "other.js", "staged\n");
    await f.client.execute(f.repo, "stage", { files: ["other.js"] });
    write(f.repo, "other.js", "working\n");
    const state = await f.client.status(f.repo);
    assert.ok(state.files[0].staged && state.files[0].unstaged);
    assert.equal(
      (await f.client.content(f.repo, { mode: "staged" }, "other.js")).newText,
      "staged\n",
    );
    assert.equal(
      (await f.client.content(f.repo, { mode: "unstaged" }, "other.js"))
        .oldText,
      "staged\n",
    );
    await f.client.execute(f.repo, "commit", { message: "index only" });
    assert.equal(git(f.repo, "show", "HEAD:other.js"), "staged");
    assert.equal(
      fs.readFileSync(path.join(f.repo, "other.js"), "utf8"),
      "working\n",
    );
    await f.client.execute(f.repo, "stage", { files: ["other.js"] });
    await f.client.execute(f.repo, "unstage", { files: ["other.js"] });
    assert.equal(git(f.repo, "diff", "--cached"), "");
    assert.equal((await f.client.status(f.repo)).files[0].unstaged, true);
  } finally {
    f.store.close();
  }
});
test("切换分支保留无冲突未跟踪文件，阻止覆盖未跟踪文件与未提交修改", async () => {
  const f = fixture();
  try {
    await f.client.execute(f.repo, "create-branch", {
      name: "topic/中文",
      ref: "HEAD",
    });
    write(f.repo, "generated/untracked.txt", "preserve\n");
    await f.client.execute(f.repo, "checkout", { branch: "topic/中文" });
    assert.equal((await f.client.status(f.repo)).branch, "topic/中文");
    assert.equal(
      fs.readFileSync(path.join(f.repo, "generated/untracked.txt"), "utf8"),
      "preserve\n",
    );
    write(f.repo, "collision.txt", "tracked topic\n");
    git(f.repo, "add", "collision.txt");
    git(f.repo, "commit", "-m", "topic file");
    await f.client.execute(f.repo, "checkout", { branch: "dev" });
    write(f.repo, "collision.txt", "local untracked\n");
    await assert.rejects(
      f.client.execute(f.repo, "checkout", { branch: "topic/中文" }),
    );
    assert.equal((await f.client.status(f.repo)).branch, "dev");
    assert.equal(
      fs.readFileSync(path.join(f.repo, "collision.txt"), "utf8"),
      "local untracked\n",
    );
    write(f.repo, "other.js", "dirty\n");
    await assert.rejects(
      f.client.execute(f.repo, "checkout", { branch: "topic/中文" }),
      /先提交或 Stash/,
    );
    assert.equal(
      fs.readFileSync(path.join(f.repo, "other.js"), "utf8"),
      "dirty\n",
    );
  } finally {
    f.store.close();
  }
});
test("逐块暂存/取消暂存/回滚通过 Git Apply，保留其他块", async () => {
  const f = fixture();
  try {
    const target = path.join(f.repo, "文件 [1].txt"),
      original = fs.readFileSync(target, "utf8");
    fs.writeFileSync(
      target,
      original
        .replace("line 2\n", "changed 2\n")
        .replace("line 30\n", "changed 30\n"),
    );
    let d = await f.client.content(
      f.repo,
      { mode: "unstaged" },
      "文件 [1].txt",
    );
    assert.equal(d.hunks.length, 2);
    await f.client.patch(f.repo, d.token, 0, "stage");
    assert.match(git(f.repo, "show", ":文件 [1].txt"), /changed 2/);
    assert.doesNotMatch(git(f.repo, "show", ":文件 [1].txt"), /changed 30/);
    d = await f.client.content(f.repo, { mode: "staged" }, "文件 [1].txt");
    await f.client.patch(f.repo, d.token, 0, "unstage");
    assert.equal(git(f.repo, "diff", "--cached"), "");
    d = await f.client.content(f.repo, { mode: "unstaged" }, "文件 [1].txt");
    await f.client.patch(f.repo, d.token, 1, "rollback");
    const text = fs.readFileSync(target, "utf8");
    assert.match(text, /changed 2/);
    assert.doesNotMatch(text, /changed 30/);
  } finally {
    f.store.close();
  }
});
test("Revert 差异处：HEAD 比较相邻修改独立回滚，Index 保持不变", async () => {
  const f = fixture();
  try {
    const original = fs.readFileSync(path.join(f.repo, "文件 [1].txt"), "utf8");
    write(
      f.repo,
      "文件 [1].txt",
      original
        .replace("line 2\n", "first edit\n")
        .replace("line 4\n", "second edit\n"),
    );
    const data = await f.client.content(
      f.repo,
      { mode: "local" },
      "文件 [1].txt",
    );
    assert.equal(data.revertHunks.length, 2);
    const index = fs.readFileSync(path.join(f.repo, ".git/index"));
    await f.client.revertHunk(f.repo, data.token, 0);
    const text = fs.readFileSync(path.join(f.repo, "文件 [1].txt"), "utf8");
    assert.match(text, /line 2\n/);
    assert.match(text, /second edit\n/);
    assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git/index")), index);
    await assert.rejects(
      f.client.revertHunk(f.repo, data.token, 1),
      /过期|外部修改/,
    );
  } finally {
    f.store.close();
  }
});
test("Revert 比较来源准确，混合暂存和外部修改受到保护", async () => {
  const f = fixture();
  try {
    write(f.repo, "other.js", "staged\nkeep\nkeep\nkeep\nlast\n");
    git(f.repo, "commit", "-am", "long base");
    write(f.repo, "other.js", "index edit\nkeep\nkeep\nkeep\nlast\n");
    await f.client.execute(f.repo, "stage", { files: ["other.js"] });
    write(f.repo, "other.js", "working edit\nkeep\nkeep\nkeep\nlast edited\n");
    let data = await f.client.content(f.repo, { mode: "local" }, "other.js");
    assert.equal(
      (await f.client.revertPreview(f.repo, data.token, 0)).source,
      "HEAD",
    );
    await f.client.revertHunk(f.repo, data.token, 0);
    assert.match(
      fs.readFileSync(path.join(f.repo, "other.js"), "utf8"),
      /^staged\n/,
    );
    assert.match(git(f.repo, "show", ":other.js"), /^index edit/);
    data = await f.client.content(f.repo, { mode: "unstaged" }, "other.js");
    assert.match(
      (await f.client.revertPreview(f.repo, data.token, 0)).source,
      /暂存区/,
    );
    await f.client.revertHunk(f.repo, data.token, 0);
    assert.match(
      fs.readFileSync(path.join(f.repo, "other.js"), "utf8"),
      /^index edit\n/,
    );
    data = await f.client.content(f.repo, { mode: "local" }, "other.js");
    write(f.repo, "other.js", "external\n");
    await assert.rejects(
      f.client.revertHunk(f.repo, data.token, 0),
      /外部修改/,
    );
    assert.equal(
      fs.readFileSync(path.join(f.repo, "other.js"), "utf8"),
      "external\n",
    );
  } finally {
    f.store.close();
  }
});
test("Revert 可处理 CRLF、增删行和末尾没有换行", async () => {
  const f = fixture();
  try {
    git(f.repo, "config", "core.autocrlf", "true");
    const original = Array.from({ length: 20 }, (_, i) => `same ${i}\r\n`).join(
      "",
    );
    write(f.repo, "eol.txt", original);
    git(f.repo, "add", "eol.txt");
    git(f.repo, "commit", "-m", "eol");
    write(
      f.repo,
      "eol.txt",
      original
        .replace("same 2\r\n", "inserted\r\nsame 2\r\n")
        .replace("same 10\r\n", "")
        .replace(/\r\n$/, ""),
    );
    for (let i = 0; i < 3; i++) {
      const data = await f.client.content(f.repo, { mode: "local" }, "eol.txt");
      await f.client.revertHunk(f.repo, data.token, 0);
    }
    assert.equal(
      fs.readFileSync(path.join(f.repo, "eol.txt"), "utf8"),
      original,
    );
  } finally {
    f.store.close();
  }
});

test("编辑保存后返回可续用的身份：最后差异消失仍可撤销重做，过期身份和外部修改受保护", async () => {
  const f = fixture();
  try {
    const target = path.join(f.repo, "other.js"), index = fs.readFileSync(path.join(f.repo, ".git/index"));
    write(f.repo, "other.js", "changed\n");
    const content = await f.client.content(f.repo, { mode: "local" }, "other.js");
    const reverted = await f.client.save(f.repo, content.token, "base\n");
    assert.equal(fs.readFileSync(target, "utf8"), "base\n");
    assert.equal((await f.client.files(f.repo, { mode: "local" })).some((file) => file.path === "other.js"), false);
    await assert.rejects(f.client.save(f.repo, content.token, "old token\n"), /过期/);
    const undone = await f.client.save(f.repo, reverted.value.token, "changed\n");
    const redone = await f.client.save(f.repo, undone.value.token, "base\n");
    assert.equal(fs.readFileSync(target, "utf8"), "base\n");
    assert.deepEqual(fs.readFileSync(path.join(f.repo, ".git/index")), index);
    write(f.repo, "other.js", "external\n");
    await assert.rejects(f.client.save(f.repo, redone.value.token, "must not overwrite\n"), /外部修改/);
    assert.equal(fs.readFileSync(target, "utf8"), "external\n");
  } finally { f.store.close(); }
});
test("LF/CRLF、相邻块、重复上下文及过期 token 不覆盖外部修改", async () => {
  const f = fixture();
  try {
    git(f.repo, "config", "core.autocrlf", "true");
    write(
      f.repo,
      "crlf.txt",
      Array.from({ length: 40 }, (_, i) => `same ${i % 5}\r\n`).join(""),
    );
    git(f.repo, "add", "crlf.txt");
    git(f.repo, "commit", "-m", "crlf");
    const original = fs.readFileSync(path.join(f.repo, "crlf.txt"), "utf8");
    write(
      f.repo,
      "crlf.txt",
      original
        .replace("same 1\r\n", "changed one\r\n")
        .replace("same 2\r\n", "changed two\r\n"),
    );
    let d = await f.client.content(f.repo, { mode: "unstaged" }, "crlf.txt");
    assert.equal(d.hunks.length, 1);
    await f.client.patch(f.repo, d.token, 0, "stage");
    assert.match(git(f.repo, "show", ":crlf.txt"), /changed one/);
    await f.client.execute(f.repo, "unstage", { files: ["crlf.txt"] });
    d = await f.client.content(f.repo, { mode: "unstaged" }, "crlf.txt");
    write(f.repo, "crlf.txt", "external\r\n");
    await assert.rejects(
      f.client.patch(f.repo, d.token, 0, "rollback"),
      /外部修改/,
    );
    await assert.rejects(
      f.client.save(f.repo, d.token, "overwrite"),
      /外部修改/,
    );
    assert.equal(
      fs.readFileSync(path.join(f.repo, "crlf.txt"), "utf8"),
      "external\r\n",
    );
  } finally {
    f.store.close();
  }
});
test("初始仓库、中文重命名、新增/删除文件与二进制安全降级", async () => {
  const f = fixture(true);
  try {
    write(f.repo, "中文.txt", "new\n");
    await f.client.execute(f.repo, "stage", { files: ["中文.txt"] });
    assert.equal(
      (await f.client.content(f.repo, { mode: "staged" }, "中文.txt")).oldText,
      "",
    );
    await f.client.execute(f.repo, "unstage", { files: ["中文.txt"] });
    assert.equal((await f.client.status(f.repo)).files[0].untracked, true);
    await f.client.execute(f.repo, "stage", { files: ["中文.txt"] });
    await f.client.execute(f.repo, "commit", { message: "root" });
    git(f.repo, "mv", "中文.txt", "新 名称.txt");
    const state = await f.client.status(f.repo);
    assert.equal(state.files[0].oldPath, "中文.txt");
    const diff = await f.client.content(
      f.repo,
      { mode: "staged" },
      "新 名称.txt",
    );
    assert.equal(diff.oldText, "new\n");
    assert.equal(diff.canPatch, false);
    await f.client.execute(f.repo, "unstage", { files: ["新 名称.txt"] });
    assert.equal(git(f.repo, "diff", "--cached"), "");
    await f.client.execute(f.repo, "stage", {
      files: ["中文.txt", "新 名称.txt"],
    });
    write(f.repo, "binary.dat", Buffer.from([0, 1, 2]));
    assert.equal(
      (await f.client.content(f.repo, { mode: "local" }, "binary.dat")).binary,
      true,
    );
    await assert.rejects(
      f.client.execute(f.repo, "rollback", { files: ["binary.dat"] }),
      /未跟踪/,
    );
    await f.client.execute(f.repo, "commit", { message: "rename" });
    fs.unlinkSync(path.join(f.repo, "新 名称.txt"));
    assert.equal(
      (await f.client.content(f.repo, { mode: "unstaged" }, "新 名称.txt"))
        .newText,
      "",
    );
    await f.client.execute(f.repo, "rollback", { files: ["新 名称.txt"] });
    assert.equal(
      fs.readFileSync(path.join(f.repo, "新 名称.txt"), "utf8"),
      "new\n",
    );
  } finally {
    f.store.close();
  }
});
test("分支、历史、两个版本、Revert、Cherry-pick、Amend 与安全 Undo", async () => {
  const f = fixture();
  try {
    const base = git(f.repo, "rev-parse", "HEAD");
    await f.client.execute(f.repo, "create-branch", {
      name: "feature/test",
      ref: "HEAD",
    });
    await f.client.execute(f.repo, "checkout", { branch: "feature/test" });
    write(f.repo, "other.js", "feature\n");
    await f.client.execute(f.repo, "stage", { files: ["other.js"] });
    await f.client.execute(f.repo, "commit", { message: "feature" });
    const commit = git(f.repo, "rev-parse", "HEAD");
    assert.equal((await f.client.log(f.repo))[0].subject, "feature");
    const details = await f.client.commitDetails(f.repo, commit);
    assert.equal(details.base, base);
    assert.equal(
      (
        await f.client.files(f.repo, { mode: "versions", base, target: commit })
      )[0].path,
      "other.js",
    );
    await f.client.execute(f.repo, "revert", { ref: commit });
    assert.equal(git(f.repo, "show", "HEAD:other.js"), "base");
    await f.client.execute(f.repo, "checkout", { branch: "dev" });
    await f.client.execute(f.repo, "cherry-pick", { ref: commit });
    await f.client.execute(f.repo, "commit", {
      message: "amended",
      amend: true,
    });
    assert.equal(git(f.repo, "log", "-1", "--format=%s"), "amended");
    const head = git(f.repo, "rev-parse", "HEAD");
    await f.client.execute(f.repo, "undo-last", { head });
    assert.ok((await f.client.status(f.repo)).files[0].staged);
    assert.equal(git(f.repo, "rev-parse", "HEAD"), base);
    assert.ok(
      (await f.client.branches(f.repo)).some((b) => b.name === "feature/test"),
    );
  } finally {
    f.store.close();
  }
});
test("Stash Push/Apply/Pop/Drop 及未跟踪文件保留", async () => {
  const f = fixture();
  try {
    write(f.repo, "other.js", "stash\n");
    write(f.repo, "untracked.txt", "saved\n");
    await f.client.execute(f.repo, "stash-push", {
      message: "temporary",
      untracked: true,
    });
    let list = await f.client.stashes(f.repo);
    assert.equal(list.length, 1);
    assert.equal((await f.client.status(f.repo)).files.length, 0);
    assert.equal(
      (
        await f.client.files(f.repo, {
          mode: "versions",
          base: `${list[0].hash}^1`,
          target: list[0].hash,
        })
      ).length,
      1,
    );
    assert.equal(
      (
        await f.client.files(f.repo, {
          mode: "versions",
          base: "__empty__",
          target: `${list[0].hash}^3`,
        })
      )[0].path,
      "untracked.txt",
    );
    await f.client.execute(f.repo, "stash-apply", list[0]);
    assert.equal((await f.client.stashes(f.repo)).length, 1);
    await f.client.execute(f.repo, "stash-drop", list[0]);
    await f.client.execute(f.repo, "stash-push", {
      message: "pop",
      untracked: true,
    });
    list = await f.client.stashes(f.repo);
    await f.client.execute(f.repo, "stash-pop", list[0]);
    assert.equal((await f.client.stashes(f.repo)).length, 0);
    assert.equal(
      fs.readFileSync(path.join(f.repo, "untracked.txt"), "utf8"),
      "saved\n",
    );
  } finally {
    f.store.close();
  }
});
async function makeConflict(f: ReturnType<typeof fixture>) {
  git(f.repo, "branch", "incoming");
  write(f.repo, "other.js", "local\n");
  git(f.repo, "commit", "-am", "local");
  git(f.repo, "switch", "incoming");
  write(f.repo, "other.js", "incoming\n");
  git(f.repo, "commit", "-am", "incoming");
  git(f.repo, "switch", "dev");
}
test("Merge 冲突三方内容、保存、暂存、Continue 和 Abort", async () => {
  const f = fixture();
  try {
    await makeConflict(f);
    await assert.rejects(
      f.client.execute(f.repo, "merge", { ref: "incoming" }),
    );
    assert.equal((await f.client.status(f.repo)).operation, "merge");
    let c = await f.client.conflict(f.repo, "other.js");
    assert.equal(c.base, "base\n");
    assert.equal(c.ours, "local\n");
    assert.equal(c.theirs, "incoming\n");
    assert.equal(conflictBlocks(c.result).length, 1);
    await assert.rejects(
      f.client.resolve(f.repo, c.token, c.result),
      /冲突标记/,
    );
    await f.client.resolve(f.repo, c.token, "resolved\n");
    await f.client.execute(f.repo, "continue");
    assert.equal((await f.client.status(f.repo)).operation, "");
    assert.equal(git(f.repo, "show", "HEAD:other.js"), "resolved");
  } finally {
    f.store.close();
  }
  const a = fixture();
  try {
    await makeConflict(a);
    const head = git(a.repo, "rev-parse", "HEAD");
    await assert.rejects(
      a.client.execute(a.repo, "merge", { ref: "incoming" }),
    );
    await a.client.execute(a.repo, "abort");
    assert.equal(git(a.repo, "rev-parse", "HEAD"), head);
    assert.equal((await a.client.status(a.repo)).files.length, 0);
  } finally {
    a.store.close();
  }
});
test("Rebase 真实冲突及 stage 2/3 语义、Continue/Skip/Abort", async () => {
  for (const recovery of ["continue", "skip", "abort"]) {
    const f = fixture();
    try {
      await makeConflict(f);
      const head = git(f.repo, "rev-parse", "HEAD");
      await assert.rejects(
        f.client.execute(f.repo, "rebase", { ref: "incoming" }),
      );
      assert.equal((await f.client.status(f.repo)).operation, "rebase");
      if (recovery === "continue") {
        const c = await f.client.conflict(f.repo, "other.js");
        assert.match(c.oursLabel, /目标及已重放/);
        assert.equal(c.ours, "incoming\n");
        assert.equal(c.theirs, "local\n");
        await f.client.resolve(f.repo, c.token, "rebased\n");
      }
      await f.client.execute(f.repo, recovery);
      assert.equal((await f.client.status(f.repo)).operation, "");
      if (recovery === "abort")
        assert.equal(git(f.repo, "rev-parse", "HEAD"), head);
    } finally {
      f.store.close();
    }
  }
});
test("Revert 冲突后 Continue 和 Abort", async () => {
  for (const recovery of ["continue", "abort"]) {
    const f = fixture();
    try {
      write(f.repo, "other.js", "first\n");
      git(f.repo, "commit", "-am", "first");
      const commit = git(f.repo, "rev-parse", "HEAD");
      write(f.repo, "other.js", "second\n");
      git(f.repo, "commit", "-am", "second");
      await assert.rejects(f.client.execute(f.repo, "revert", { ref: commit }));
      assert.equal((await f.client.status(f.repo)).operation, "revert");
      if (recovery === "continue") {
        const c = await f.client.conflict(f.repo, "other.js");
        await f.client.resolve(f.repo, c.token, "resolved revert\n");
      }
      await f.client.execute(f.repo, recovery);
      assert.equal((await f.client.status(f.repo)).operation, "");
    } finally {
      f.store.close();
    }
  }
});
test("本地 bare Remote：Push、Fetch、明确 Pull Merge/Rebase、拒绝丢弃脏工作区", async () => {
  const f = fixture();
  try {
    const remote = path.join(root, "remote-" + randomUUID());
    fs.mkdirSync(remote);
    git(remote, "init", "--bare");
    git(f.repo, "remote", "add", "origin", remote);
    const preview = await f.client.pushPreview(f.repo, "origin", "dev");
    await f.client.execute(f.repo, "push", {
      remote: "origin",
      branch: "dev",
      head: preview.head,
    });
    assert.equal((await f.client.status(f.repo)).upstream, "origin/dev");
    const other = path.join(root, "clone-" + randomUUID());
    git(root, "clone", "-b", "dev", remote, other);
    git(other, "config", "user.name", "Remote");
    git(other, "config", "user.email", "remote@example.invalid");
    git(other, "config", "commit.gpgsign", "false");
    for (const strategy of ["merge", "rebase"]) {
      write(other, `remote-${strategy}.txt`, strategy + "\n");
      git(other, "add", ".");
      git(other, "commit", "-m", strategy);
      git(other, "push");
      await f.client.execute(f.repo, "fetch");
      assert.equal((await f.client.status(f.repo)).behind, 1);
      await f.client.execute(f.repo, "pull", { strategy });
      assert.equal(
        fs.readFileSync(path.join(f.repo, `remote-${strategy}.txt`), "utf8"),
        strategy + "\n",
      );
    }
    write(f.repo, "other.js", "dirty\n");
    await assert.rejects(
      f.client.execute(f.repo, "pull", { strategy: "merge" }),
      /先提交或 Stash/,
    );
    assert.equal(
      fs.readFileSync(path.join(f.repo, "other.js"), "utf8"),
      "dirty\n",
    );
    await assert.rejects(
      f.client.execute(f.repo, "undo-last", {
        head: git(f.repo, "rev-parse", "HEAD"),
      }),
    );
  } finally {
    f.store.close();
  }
});
test("旧编码/大文件只读、路径防护和已有提测写锁互斥", async () => {
  const f = fixture();
  try {
    write(f.repo, "legacy.txt", Buffer.from([0xd6, 0xd0, 0xce, 0xc4, 10]));
    let diff = await f.client.content(f.repo, { mode: "local" }, "legacy.txt");
    assert.equal(diff.editable, false);
    assert.match(diff.newText, /中文/);
    write(f.repo, "big.txt", Buffer.alloc(4 * 1024 * 1024 + 1, 65));
    diff = await f.client.content(f.repo, { mode: "local" }, "big.txt");
    assert.equal(diff.limited, true);
    assert.equal(diff.newText, "");
    await assert.rejects(
      f.client.content(f.repo, { mode: "local" }, "../outside"),
      /路径/,
    );
    await assert.rejects(
      f.client.execute(f.repo, "stage", { files: [".GiT/config"] }),
      /路径/,
    );
    const active = f.tasks.create(
      "erp",
      "existing submit",
      null,
      "git:" + (await new Git().commonDir(f.repo)),
      {},
    );
    await assert.rejects(
      f.client.execute(f.repo, "stage", { files: ["legacy.txt"] }),
      /已有写任务/,
    );
    active.state = "success";
    f.tasks.save(active);
    await f.client.execute(f.repo, "stage", { files: ["legacy.txt"] });
    assert.deepEqual(
      Buffer.from(git(f.repo, "show", ":legacy.txt"), "utf8").length > 0,
      true,
    );
  } finally {
    f.store.close();
  }
});
test("上万个变更仅加载状态，正文仍按单文件读取", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 10020; i++)
      write(f.repo, `generated/file-${i}.txt`, "content\n");
    const state = await f.client.status(f.repo);
    assert.equal(state.files.length, 10020);
    assert.ok(!("newText" in state.files[0]));
    const data = await f.client.content(
      f.repo,
      { mode: "local" },
      "generated/file-9999.txt",
    );
    assert.equal(data.newText, "content\n");
  } finally {
    f.store.close();
  }
});
test("冲突块准确解析 Diff3、CRLF、重复文本和末尾无换行", () => {
  const text =
    "keep\r\n<<<<<<< HEAD\r\nsame\r\n||||||| base\r\nbase\r\n=======\r\nincoming\r\n>>>>>>> branch\r\nend\r\n<<<<<<< HEAD\r\nleft\r\n=======\r\nright\r\n>>>>>>> branch";
  const blocks = conflictBlocks(text);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].ours, "same\r\n");
  assert.equal(blocks[0].theirs, "incoming\r\n");
  assert.equal(
    text.slice(blocks[1].start, blocks[1].end).endsWith(">>>>>>> branch"),
    true,
  );
});
test("确认后外部变化阻断整文件回滚；并发暂存串行，BOM 与 CRLF 保存保留", async () => {
  const f = fixture();
  try {
    write(f.repo, "other.js", "changed\n");
    const expected = await f.client.rollbackPreview(f.repo, ["other.js"]);
    write(f.repo, "other.js", "external\n");
    await assert.rejects(
      f.client.execute(f.repo, "rollback", { files: ["other.js"], expected }),
      /确认期间/,
    );
    assert.equal(
      fs.readFileSync(path.join(f.repo, "other.js"), "utf8"),
      "external\n",
    );
    write(f.repo, "bom.txt", Buffer.from("\ufefffirst\r\n", "utf8"));
    await Promise.all([
      f.client.execute(f.repo, "stage", { files: ["other.js"] }),
      f.client.execute(f.repo, "stage", { files: ["bom.txt"] }),
    ]);
    assert.equal(
      (await f.client.status(f.repo)).files.filter((f) => f.staged).length,
      2,
    );
    write(f.repo, "bom.txt", Buffer.from("\ufeffsecond\r\n", "utf8"));
    const d = await f.client.content(f.repo, { mode: "unstaged" }, "bom.txt");
    await f.client.save(f.repo, d.token, "third\r\n");
    assert.deepEqual(
      fs.readFileSync(path.join(f.repo, "bom.txt")),
      Buffer.from("\ufeffthird\r\n"),
    );
  } finally {
    f.store.close();
  }
});
test("Commit and Push 使用明确 Upstream；Hook 失败保留 Index 和真实输出", async () => {
  const f = fixture();
  try {
    const remote = path.join(root, "commit-push-" + randomUUID());
    fs.mkdirSync(remote);
    git(remote, "init", "--bare");
    git(f.repo, "remote", "add", "origin", remote);
    await f.client.execute(f.repo, "push", {
      remote: "origin",
      branch: "dev",
      head: git(f.repo, "rev-parse", "HEAD"),
    });
    git(f.repo, "config", "push.default", "matching");
    write(f.repo, "other.js", "commit push\n");
    await f.client.execute(f.repo, "stage", { files: ["other.js"] });
    await f.client.execute(f.repo, "commit", {
      message: "commit push",
      push: true,
    });
    assert.equal(
      git(remote, "rev-parse", "refs/heads/dev"),
      git(f.repo, "rev-parse", "HEAD"),
    );
    const hook = path.join(f.repo, ".git/empty-hooks/pre-commit");
    fs.writeFileSync(
      hook,
      "#!/bin/sh\necho 'fixture hook rejected' >&2\nexit 1\n",
    );
    write(f.repo, "other.js", "rejected\n");
    await f.client.execute(f.repo, "stage", { files: ["other.js"] });
    await assert.rejects(
      f.client.execute(f.repo, "commit", { message: "rejected" }),
      /fixture hook rejected/,
    );
    assert.equal((await f.client.status(f.repo)).files[0].staged, true);
  } finally {
    f.store.close();
  }
});
test("版本重命名和初始 Commit Diff、Log 真正按 150 条分页", async () => {
  const f = fixture();
  try {
    const base = git(f.repo, "rev-parse", "HEAD");
    git(f.repo, "mv", "other.js", "renamed.js");
    git(f.repo, "commit", "-m", "rename");
    const diff = await f.client.content(
      f.repo,
      { mode: "versions", base, target: "HEAD" },
      "renamed.js",
    );
    assert.equal(diff.oldText, "base\n");
    assert.equal(diff.newText, "base\n");
    const root = await f.client.content(
      f.repo,
      { mode: "versions", base: "__empty__", target: base },
      "other.js",
    );
    assert.equal(root.oldText, "");
    assert.equal(root.newText, "base\n");
    const historicalPath = "文件 [1].txt";
    const original = fs.readFileSync(path.join(f.repo, historicalPath), "utf8");
    write(
      f.repo,
      historicalPath,
      original.replace("line 2\n", "history change\n"),
    );
    git(f.repo, "commit", "-am", "historical change");
    assert.equal((await f.client.status(f.repo)).files.length, 0);
    const historical = await f.client.content(
      f.repo,
      { mode: "history", base, file: historicalPath },
      historicalPath,
    );
    assert.equal(historical.oldText, original);
    assert.match(historical.newText, /history change/);
    let input = "";
    for (let i = 0; i < 160; i++)
      input += `commit refs/heads/bulk\nmark :${i + 1}\nauthor Bulk <bulk@example.invalid> ${1700000000 + i} +0000\ncommitter Bulk <bulk@example.invalid> ${1700000000 + i} +0000\ndata ${Buffer.byteLength("commit " + i)}\ncommit ${i}\n${i ? "from :" + i + "\n" : "from " + base + "\n"}\n`;
    const imported = spawnSync(
      "git",
      ["-C", f.repo, "fast-import", "--quiet"],
      { input, encoding: "utf8", windowsHide: true },
    );
    assert.equal(imported.status, 0, imported.stderr);
    const first = await f.client.log(f.repo, { ref: "bulk" }),
      second = await f.client.log(f.repo, { ref: "bulk", offset: 150 });
    assert.equal(first.length, 150);
    assert.equal(second.length, 11);
    assert.equal(first[0].subject, "commit 159");
    assert.equal(second[0].subject, "commit 9");
  } finally {
    f.store.close();
  }
});
test("修改/删除冲突可明确接受删除并完成 Merge", async () => {
  const f = fixture();
  try {
    git(f.repo, "branch", "incoming");
    write(f.repo, "other.js", "local edit\n");
    git(f.repo, "commit", "-am", "local");
    git(f.repo, "switch", "incoming");
    git(f.repo, "rm", "other.js");
    git(f.repo, "commit", "-m", "delete");
    git(f.repo, "switch", "dev");
    await assert.rejects(
      f.client.execute(f.repo, "merge", { ref: "incoming" }),
    );
    const conflict = await f.client.conflict(f.repo, "other.js");
    assert.equal(conflict.theirsDeleted, true);
    assert.equal(conflict.oursDeleted, false);
    await f.client.resolve(f.repo, conflict.token, "", true);
    assert.equal(fs.existsSync(path.join(f.repo, "other.js")), false);
    await f.client.execute(f.repo, "continue");
    assert.equal((await f.client.status(f.repo)).operation, "");
  } finally {
    f.store.close();
  }
});
test("Git Log 支持按文件名/路径模糊筛选、分支范围生效与精确文件重命名跟踪", async () => {
  const f = fixture();
  try {
    write(f.repo, "src/pages/CustomerController.java", "v1\n");
    write(f.repo, "src/reports/itemPlan.jrxml", "r1\n");
    git(f.repo, "add", ".");
    git(f.repo, "commit", "-m", "add controller and report");
    git(f.repo, "switch", "-c", "feature/contract");
    write(f.repo, "WebRoot/WEB-INF/jsp/ContractDetail.jsp", "c1\n");
    git(f.repo, "add", ".");
    git(f.repo, "commit", "-m", "add contract jsp");
    git(f.repo, "switch", "dev");
    git(f.repo, "mv", "src/reports/itemPlan.jrxml", "src/reports/itemPlanV2.jrxml");
    git(f.repo, "commit", "-m", "rename itemPlan report");
    write(f.repo, "src/pages/CustomerController.java", "v2\n");
    git(f.repo, "commit", "-am", "update controller");

    // 模糊文件名与大小写不敏感
    assert.deepEqual(
      (await f.client.log(f.repo, { file: "customercontroller", all: false })).map(
        (c) => c.subject,
      ),
      ["update controller", "add controller and report"],
    );
    // 反斜杠路径片段与通配符
    assert.deepEqual(
      (await f.client.log(f.repo, { file: "pages\\Customer", all: false })).map(
        (c) => c.subject,
      ),
      ["update controller", "add controller and report"],
    );
    assert.deepEqual(
      (await f.client.log(f.repo, { file: "*.java", all: false })).map(
        (c) => c.subject,
      ),
      ["update controller", "add controller and report"],
    );
    // 方括号字符按字面匹配，不误触发字符类
    assert.deepEqual(
      (await f.client.log(f.repo, { file: "[1].txt", all: false })).map(
        (c) => c.subject,
      ),
      ["base"],
    );
    // 文件筛选同时尊重当前分支 / 全部分支范围
    assert.deepEqual(
      (await f.client.log(f.repo, { file: "ContractDetail", all: false })).map(
        (c) => c.subject,
      ),
      [],
    );
    assert.deepEqual(
      (await f.client.log(f.repo, { file: "ContractDetail", all: true })).map(
        (c) => c.subject,
      ),
      ["add contract jsp"],
    );
    // 组合提交说明 + 模糊文件名筛选
    assert.deepEqual(
      (
        await f.client.log(f.repo, {
          query: "update",
          file: "Controller.java",
          all: true,
        })
      ).map((c) => c.subject),
      ["update controller"],
    );
    // 精确文件历史支持 --follow 跟踪重命名
    assert.deepEqual(
      (
        await f.client.log(f.repo, {
          file: "src/reports/itemPlanV2.jrxml",
          follow: true,
          all: false,
        })
      ).map((c) => c.subject),
      ["rename itemPlan report", "add controller and report"],
    );
    // 非法控制字符被拒绝
    await assert.rejects(
      f.client.log(f.repo, { file: "bad\0name" }),
      /文件筛选条件无效/,
    );
  } finally {
    f.store.close();
  }
});
test("项目未跟踪规则支持显示范围、排除规则、通配符与 * 兜底", async () => {
  // 1) 默认受跟踪目录 + 排除压缩包（典型 homeproject 场景）
  const f1 = fixture(false, {
    exclude: ["*.rar", "*.zip", "WebRoot/WEB-INF/temp/"],
  });
  try {
    write(f1.repo, "WebRoot/WEB-INF/web.xml", "<web-app/>\n");
    git(f1.repo, "add", ".");
    git(f1.repo, "commit", "-m", "track web-inf");
    const expected: Record<string, boolean> = {
      "WebRoot/WEB-INF/jsp.rar": false,
      "WebRoot/WEB-INF/LIB.RAR": false,
      "WebRoot/WEB-INF/archive.zip": false,
      "WebRoot/WEB-INF/temp/debug.jsp": false,
      "WebRoot/WEB-INF/new.jsp": true,
      "WebRoot/WEB-INF/newsub/page.jsp": false,
      "root.txt": false,
    };
    for (const file of Object.keys(expected)) write(f1.repo, file, "new\n");
    const rows = (await f1.client.status(f1.repo)).files;
    for (const [file, visible] of Object.entries(expected)) {
      assert.equal(
        rows.find((row) => row.path === file)?.inTrackedDirectory,
        visible,
        file,
      );
    }
  } finally {
    f1.store.close();
  }

  // 2) 白名单 + 排除叠加（排除优先于包含，支持路径通配和 **/ 目录匹配）
  const f2 = fixture(false, {
    include: ["src/", "WebRoot/WEB-INF/"],
    exclude: ["*.rar", "WebRoot/WEB-INF/*.bak", "**/cache/"],
  });
  try {
    const expected: Record<string, boolean> = {
      "src/newpkg/Service.java": true,
      "src/cache/tmp.java": false,
      "WebRoot/WEB-INF/jsp/index.jsp": true,
      "WebRoot/WEB-INF/jsp.rar": false,
      "WebRoot/WEB-INF/web.xml.bak": false,
      "WebRoot/WEB-INF/sub/keep.bak": true,
      "docs/readme.md": false,
    };
    for (const file of Object.keys(expected)) write(f2.repo, file, "new\n");
    const rows = (await f2.client.status(f2.repo)).files;
    for (const [file, visible] of Object.entries(expected)) {
      assert.equal(
        rows.find((row) => row.path === file)?.inTrackedDirectory,
        visible,
        file,
      );
    }
  } finally {
    f2.store.close();
  }

  // 3) include: ["*"] 显示全部（除 exclude）与 exclude: ["*"] 全部隐藏（保留已跟踪修改）
  const f3 = fixture(false, { include: ["*"], exclude: ["*.rar"] });
  try {
    write(f3.repo, "root-new.txt", "new\n");
    write(f3.repo, "brand-new/file.ts", "new\n");
    write(f3.repo, "brand-new/dump.rar", "new\n");
    const rows = (await f3.client.status(f3.repo)).files;
    assert.equal(rows.find((r) => r.path === "root-new.txt")?.inTrackedDirectory, true);
    assert.equal(rows.find((r) => r.path === "brand-new/file.ts")?.inTrackedDirectory, true);
    assert.equal(rows.find((r) => r.path === "brand-new/dump.rar")?.inTrackedDirectory, false);
  } finally {
    f3.store.close();
  }

  const f4 = fixture(false, { include: ["src/"], exclude: ["*"] });
  try {
    write(f4.repo, "src/App.java", "new\n");
    write(f4.repo, "other.js", "tracked edit\n");
    const rows = (await f4.client.status(f4.repo)).files;
    assert.equal(rows.find((r) => r.path === "src/App.java")?.inTrackedDirectory, false);
    assert.equal(rows.find((r) => r.path === "other.js")?.untracked, false);
  } finally {
    f4.store.close();
  }
});
test("ConfigService 自动迁移全部项目默认未跟踪规则、保留用户清空与校验非法路径", () => {
  const dir = path.join(root, "config-" + ++sequence);
  fs.mkdirSync(dir, { recursive: true });
  const dbPath = path.join(dir, "workbench.sqlite");
  // 模拟旧版本已落盘配置（未包含 gitUntrackedInclude / gitUntrackedExclude 字段）
  const legacyStore = new Store(dbPath);
  const legacy = defaults(dir);
  for (const project of legacy.projects) {
    delete project.gitUntrackedInclude;
    delete project.gitUntrackedExclude;
  }
  legacyStore.set("config", "main", legacy);
  legacyStore.close();

  const store1 = new Store(dbPath);
  try {
    const cfg1 = new ConfigService(store1, dir);
    const loaded = cfg1.get();
    for (const project of loaded.projects) {
      const preset = defaultUntrackedRuleByProject[project.id];
      assert.ok(preset, `missing preset for ${project.id}`);
      assert.deepEqual(project.gitUntrackedInclude, preset.include, project.id);
      assert.deepEqual(project.gitUntrackedExclude, preset.exclude, project.id);
    }
    assert.deepEqual(
      loaded.projects.find((p) => p.id === "homeproject")?.gitUntrackedInclude,
      ["src/", "WebRoot/"],
    );
    assert.deepEqual(
      loaded.projects.find((p) => p.id === "refsys")?.gitUntrackedInclude,
      ["src/main/", "pom.xml"],
    );

    // 清洗、去重；手动清空 include 与 exclude 后均持久保留空数组
    const hp = loaded.projects.find((p) => p.id === "homeproject")!;
    hp.gitUntrackedExclude = [" *.rar ", ".\\WebRoot\\WEB-INF\\temp\\", "*.rar"];
    const refsys = loaded.projects.find((p) => p.id === "refsys")!;
    refsys.gitUntrackedInclude = [];
    refsys.gitUntrackedExclude = [];
    const saved = cfg1.save(loaded);
    assert.deepEqual(
      saved.projects.find((p) => p.id === "homeproject")?.gitUntrackedExclude,
      ["*.rar", "WebRoot/WEB-INF/temp/"],
    );
    assert.deepEqual(
      saved.projects.find((p) => p.id === "refsys")?.gitUntrackedInclude,
      [],
    );
    assert.deepEqual(
      saved.projects.find((p) => p.id === "refsys")?.gitUntrackedExclude,
      [],
    );

    // 非法规则被拦截
    const invalid = cfg1.get();
    invalid.projects[0].gitUntrackedExclude = ["../outside"];
    assert.throws(() => cfg1.save(invalid), /不能包含上级目录/);

    invalid.projects[0].gitUntrackedExclude = ["D:/abs/path"];
    assert.throws(() => cfg1.save(invalid), /必须使用相对路径/);

    invalid.projects[0].gitUntrackedExclude = ["/"];
    assert.throws(() => cfg1.save(invalid), /包含无效路径/);
  } finally {
    store1.close();
  }

  // 重新打开数据库后，用户手动清空的 refsys 仍保持 []，不被默认规则覆盖
  const store2 = new Store(dbPath);
  try {
    const cfg2 = new ConfigService(store2, dir);
    assert.deepEqual(
      cfg2.get().projects.find((p) => p.id === "refsys")?.gitUntrackedInclude,
      [],
    );
    assert.deepEqual(
      cfg2.get().projects.find((p) => p.id === "refsys")?.gitUntrackedExclude,
      [],
    );
  } finally {
    store2.close();
  }

  assert.deepEqual(
    parseUntrackedInput("src/main/, pom.xml，*.rar\n*.zip"),
    ["src/main/", "pom.xml", "*.rar", "*.zip"],
  );
  assert.match(
    describeUntrackedRule({ include: ["src/"], exclude: ["*.rar"] }),
    /src\/.*已排除：\*\.rar/,
  );
  assert.match(
    describeUntrackedRule({ exclude: ["*"] }),
    /隐藏全部未跟踪文件/,
  );
});

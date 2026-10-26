import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { Git } from "../src/core/git.js";
import { Store } from "../src/core/store.js";
import { ReviewService } from "../src/core/review.js";
import { RecordsService } from "../src/core/records.js";
import { hash } from "../src/core/util.js";

const root = path.resolve(".local", "review-fixtures", randomUUID());
fs.mkdirSync(root, { recursive: true });
let seq = 0;
function git(repo: string, ...args: string[]) {
  const r = spawnSync(
    "git",
    ["-c", "core.autocrlf=false", "-C", repo, ...args],
    { encoding: "utf8", windowsHide: true },
  );
  if (r.status) throw new Error(r.stderr);
  return r.stdout.trim();
}
function write(repo: string, file: string, content: string | Buffer) {
  fs.mkdirSync(path.dirname(path.join(repo, file)), { recursive: true });
  fs.writeFileSync(path.join(repo, file), content);
}
function fixture() {
  const repo = path.join(root, String(++seq));
  fs.mkdirSync(repo);
  git(repo, "init", "-b", "dev");
  git(repo, "config", "user.name", "Review Test");
  git(repo, "config", "user.email", "test@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  git(repo, "config", "core.autocrlf", "false");
  const hooks = path.join(repo, ".git", "empty-hooks");
  fs.mkdirSync(hooks);
  git(repo, "config", "core.hooksPath", hooks);
  write(repo, "旧文件.txt", "one\ntwo\n");
  write(repo, "binary.bin", Buffer.from([1, 0, 2]));
  write(repo, "other.js", "base\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "base");
  const base = git(repo, "rev-parse", "HEAD");
  const store = new Store(path.join(repo, ".git", "review.sqlite"));
  return {
    repo,
    base,
    store,
    service: new ReviewService(
      new Git(),
      store,
      new RecordsService(store, repo),
    ),
  };
}
test("暂存、未暂存、全部本地、未跟踪及二进制/重命名准确，审查不改变 Git", async () => {
  const f = fixture();
  git(f.repo, "mv", "旧文件.txt", "中文 [新文件].txt");
  git(f.repo, "add", ".");
  write(f.repo, "other.js", "unstaged\n");
  write(f.repo, "未跟踪.txt", "new\n");
  write(f.repo, "binary.bin", Buffer.from([3, 0, 4]));
  const index = hash(fs.readFileSync(path.join(f.repo, ".git", "index")));
  const status = git(f.repo, "status", "--porcelain");
  const staged = await f.service.open("p", { repo: f.repo, scope: "staged" });
  assert.equal(staged.files.length, 1);
  assert.match(staged.files[0].status, /R/);
  assert.equal(staged.files[0].oldPath, "旧文件.txt");
  const unstaged = await f.service.open("p", {
    repo: f.repo,
    scope: "unstaged",
  });
  assert.deepEqual(unstaged.files.map((f) => f.path).sort(), [
    "binary.bin",
    "other.js",
  ]);
  assert.equal(
    unstaged.files.find((f) => f.path === "binary.bin")!.binary,
    true,
  );
  const local = await f.service.open("p", { repo: f.repo, scope: "local" });
  assert.equal(
    local.files.some((f) => f.path === "未跟踪.txt" && f.untracked),
    true,
  );
  assert.equal(git(f.repo, "status", "--porcelain"), status);
  assert.equal(
    hash(fs.readFileSync(path.join(f.repo, ".git", "index"))),
    index,
  );
  f.store.close();
});
test("人工意见和已看状态持久化；代码变化失效，旧定位与不采纳原因保留", async () => {
  const f = fixture();
  write(f.repo, "other.js", "new text\n");
  let s = await f.service.open("p", { repo: f.repo, scope: "local" });
  s = await f.service.seen(s.id, "other.js", true);
  assert.equal(Object.keys(s.seen).length, 1);
  s = f.service.issue(s.id, {
    file: "other.js",
    side: "new",
    line: 1,
    text: "核对真实业务预期",
  });
  assert.throws(
    () => f.service.updateIssue(s.id, s.issues[0].id, "declined", ""),
    /原因/,
  );
  const oldHash = s.issues[0].snapshotHash;
  const todo = f.service.todo(s.id, s.issues[0].id);
  assert.equal(f.service.todo(s.id, s.issues[0].id).id, todo.id);
  write(f.repo, "other.js", "changed again\n");
  const check = await f.service.validate(s.id);
  assert.equal(check.changed, true);
  assert.equal(Object.keys(check.snapshot.seen).length, 0);
  await assert.rejects(() => f.service.conclude(s.id, "已完成", ""), /变化/);
  const next = await f.service.open(
    "p",
    { repo: f.repo, scope: "local" },
    s.id,
  );
  assert.notEqual(next.id, s.id);
  assert.equal(next.issues[0].snapshotHash, oldHash);
  assert.notEqual(next.files.find((f) => f.path === "other.js")!.hash, oldHash);
  assert.equal(next.conclusion, null);
  f.store.close();
});
test("两版本最终比较与共同祖先范围分别计算；大文件明确限制；空差异不自动通过", async () => {
  const f = fixture();
  git(f.repo, "switch", "-c", "feature");
  write(f.repo, "feature.js", "feature");
  git(f.repo, "add", ".");
  git(f.repo, "commit", "-m", "feature");
  const feature = git(f.repo, "rev-parse", "HEAD");
  git(f.repo, "switch", "dev");
  write(f.repo, "dev.js", "dev");
  git(f.repo, "add", ".");
  git(f.repo, "commit", "-m", "dev");
  const final = await f.service.open("p", {
    repo: f.repo,
    scope: "versions",
    base: "dev",
    target: "feature",
  });
  const ancestor = await f.service.open("p", {
    repo: f.repo,
    scope: "ancestor",
    base: "dev",
    target: "feature",
  });
  assert.notEqual(final.baseCommit, ancestor.baseCommit);
  assert.equal(ancestor.baseCommit, f.base);
  assert.equal(ancestor.targetCommit, feature);
  assert.deepEqual(
    ancestor.files.map((f) => f.path),
    ["feature.js"],
  );
  const empty = await f.service.open("p", {
    repo: f.repo,
    scope: "versions",
    base: "HEAD",
    target: "HEAD",
  });
  assert.equal(empty.files.length, 0);
  assert.equal(empty.conclusion, null);
  write(f.repo, "big.txt", "x".repeat(600000));
  const big = await f.service.open("p", { repo: f.repo, scope: "local" });
  assert.equal(big.files.find((f) => f.path === "big.txt")!.limited, true);
  f.store.close();
});

test("大目录快照正文总量受限，大文件使用元数据并能感知后续变化", async () => {
  const f = fixture();
  try {
    for (let n = 0; n < 65; n++)
      write(
        f.repo,
        `bulk/${String(n).padStart(3, "0")}.txt`,
        "x".repeat(256 * 1024),
      );
    const large = path.join(f.repo, "large.txt");
    write(f.repo, "large.txt", "z".repeat(1024 * 1024));
    const snapshot = await f.service.open("p", {
      repo: f.repo,
      scope: "local",
    });
    assert.equal(snapshot.files.length, 66);
    assert.ok(
      snapshot.files.some(
        (file) => file.path.startsWith("bulk/") && file.limited,
      ),
    );
    assert.ok(
      snapshot.files.reduce(
        (sum, file) =>
          sum +
          Buffer.byteLength(file.oldText) +
          Buffer.byteLength(file.newText) +
          Buffer.byteLength(file.patch),
        0,
      ) <=
        16 * 1024 * 1024,
    );
    const original = snapshot.files.find((file) => file.path === "large.txt")!;
    assert.ok(original.limited);
    assert.equal(original.newText, "");
    const later = new Date(Date.now() + 3000);
    fs.utimesSync(large, later, later);
    assert.equal((await f.service.validate(snapshot.id)).changed, true);
  } finally {
    f.store.close();
  }
});

test("后台差异读取保持主线程响应，可取消并重试；历史列表不传递正文", async () => {
  const f = fixture();
  try {
    for (let i = 0; i < 400; i++)
      write(f.repo, `many/${i}.txt`, "line\n".repeat(100));
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    timer.unref();
    const pending = f.service.open("p", { repo: f.repo, scope: "local" });
    setTimeout(() => f.service.cancel(), 20);
    await assert.rejects(pending, /取消/);
    assert.equal(f.store.list("review").length, 0);
    const snapshot = await f.service.open("p", {
      repo: f.repo,
      scope: "local",
    });
    clearInterval(timer);
    assert.ok(
      ticks > 5,
      "filesystem and hashing must not occupy the main event loop",
    );
    assert.equal(snapshot.files.length, 400);
    const history = f.service.history() as any[];
    assert.equal(history[0].fileCount, 400);
    assert.equal(history[0].files, undefined);
    assert.equal(snapshot.files[0].deferred, true);
    assert.equal(snapshot.files[0].newText, "");
    const loaded = await f.service.fileContent(
      snapshot.id,
      snapshot.files[0].path,
    );
    assert.match(loaded.newText, /line/);
    assert.ok(loaded.contentHash);
    await f.service.seen(snapshot.id, loaded.path, true);
    assert.equal((await f.service.validate(snapshot.id)).changed, false);
    const unread = snapshot.files.find((file) => file.path !== loaded.path)!;
    write(f.repo, unread.path, "changed before reading\n");
    await assert.rejects(
      () => f.service.fileContent(snapshot.id, unread.path),
      /已变化/,
    );
    assert.equal((await f.service.validate(snapshot.id)).changed, true);
    for (let n = 0; n < 201; n++)
      f.store.set("review", "older:" + n, {
        ...snapshot,
        id: "older:" + n,
        projectId: "older",
        files: [],
      });
    assert.equal(f.service.history("p").length, 1);
    assert.equal(f.service.history("older").length, 200);
    assert.equal(f.service.history("older", 200).length, 1);
    assert.equal(
      f.service.get(String(f.service.history("older", 200)[0].id)).projectId,
      "older",
    );
  } finally {
    f.store.close();
  }
});

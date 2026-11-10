const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { spawnSync } = require("node:child_process");
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
}
const root = path.resolve(__dirname, ".."),
  dir = path.join(root, ".local", "git-ui-" + Date.now()),
  repo = path.join(dir, "仓库 with spaces");
fs.mkdirSync(repo, { recursive: true });
const errors = [],
  checks = [];
let app, page, diff;
function git(...args) {
  const result = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (result.status) throw new Error(result.stderr || result.stdout);
  return result.stdout.trimEnd();
}
function write(file, text) {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
async function api(target, name, payload) {
  const response = await target.evaluate(
    ({ name, payload }) => window.workbench.call(name, payload),
    { name, payload },
  );
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
async function until(fn, label, timeout = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 120));
  }
  throw new Error("Timed out: " + label);
}
async function capture(target, name) {
  const session = await target.context().newCDPSession(target);
  const data = await session.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: false,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(
    path.join(dir, name + ".png"),
    Buffer.from(data.data, "base64"),
  );
  await session.detach();
}
async function nav(name) {
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function main() {
  try {
    git("init", "-b", "dev");
    git("config", "user.name", "UI Test");
    git("config", "user.email", "test@example.invalid");
    git("config", "core.autocrlf", "false");
    git("config", "commit.gpgsign", "false");
    const hooks = path.join(repo, ".git/hooks-empty");
    fs.mkdirSync(hooks);
    git("config", "core.hooksPath", hooks);
    const source = Array.from(
      { length: 45 },
      (_, i) => `const line${i + 1} = ${i + 1};\n`,
    ).join("");
    write("src/中文 [文件].ts", source);
    write("other.vue", "<template><div>base</div></template>\n");
    git("add", ".");
    git("commit", "-m", "base");
    write(
      "src/中文 [文件].ts",
      source
        .replace("line2 = 2", "line2 = 200")
        .replace("line40 = 40", "line40 = 400"),
    );
    write("other.vue", "<template><div>updated</div></template>\n");
    write("src/new.ts", "export const newFile = true;\n");
    write("AGENTS.md", "untracked root file\n");
    write("src/new-folder/new.ts", "new directory\n");
    for (let i = 0; i < 10020; i++) write(`bulk/file-${i}.txt`, "generated\n");
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const exe = process.env.WORKBENCH_GIT_EXE;
    app = await playwright._electron.launch({
      executablePath: exe || require("electron"),
      args: [...(exe ? [] : [root]), "--data-dir=" + path.join(dir, "data")],
      env,
      timeout: 60000,
    });
    page = await app.firstWindow();
    if (exe)
      assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    await page.context().setOffline(true);
    page.on("pageerror", (e) => errors.push(e.message));
    await page.waitForSelector('[data-page="work"]');
    await app.evaluate(({ dialog }) => {
      globalThis.gitConfirmations = [];
      dialog.showMessageBox = async (_window, options) => {
        globalThis.gitConfirmations.push(options);
        return { response: 1 };
      };
    });
    const config = (await api(page, "bootstrap")).config;
    config.projects.find((p) => p.id === "homeproject").path = repo;
    await api(page, "settings.save", config);
    assert.equal(await page.getByRole("navigation").getByRole("button", { name: "一键提测", exact: true }).count(), 0);
    checks.push("一键提测入口迁入 Git 管理");
    await nav("Git 管理");
    await until(
      async () =>
        (await page.locator(".git-file-footer").count()) &&
        (await page.locator(".git-tabs").textContent()).includes("3"),
      "10k status",
    );
    assert.equal(await page.getByLabel("仅显示已跟踪目录下的未跟踪文件", { exact: true }).count(), 0);
    await until(async () => (await page.locator(".git-file-row").count()) === 3, "fixed folder filter");
    assert.ok((await page.locator(".git-file-path").allTextContents()).includes("other.vue"));
    assert.ok(!(await page.locator(".git-file-path").allTextContents()).includes("AGENTS.md"));
    await page.getByLabel("变更范围", { exact: true }).selectOption("untracked");
    assert.deepEqual(await page.locator(".git-file-path").allTextContents(), ["src/new.ts"]);
    await page.getByLabel("变更范围", { exact: true }).selectOption("all");
    await capture(page, "git-management");
    checks.push("固定目录过滤，无复选框；10,022 个根目录/新子目录未跟踪文件隐藏，已跟踪根文件保留");
    await page.getByLabel("搜索变更文件").fill("中文");
    const opened = app.waitForEvent("window");
    await page.locator(".git-file-row").first().dblclick();
    diff = await opened;
    diff.on("pageerror", (e) => errors.push(e.message));
    diff.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await diff.waitForSelector(".monaco-diff-editor");
    assert.equal(await diff.locator(".diff-files").isVisible(), false);
    await diff.getByTitle("显示 / 隐藏文件列表").click();
    assert.equal(await diff.getByLabel("仅显示已跟踪目录下的未跟踪文件", { exact: true }).count(), 0);
    await diff.getByLabel("搜索对比文件", { exact: true }).fill("AGENTS.md");
    assert.equal(await diff.locator(".git-file-row").count(), 0);
    await diff.getByLabel("搜索对比文件", { exact: true }).fill("bulk/");
    assert.equal(await diff.locator(".git-file-row").count(), 0);
    await diff.getByLabel("搜索对比文件", { exact: true }).fill("");
    checks.push("独立 Diff 文件栏固定目录过滤，与主页面一致");
    await until(
      async () =>
        (await diff.locator(".diff-statusbar").textContent()).includes(
          "2 处差异",
        ),
      "Monaco worker computes two changes",
    );
    assert.equal(await diff.getByRole("navigation").count(), 0);
    assert.ok(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((w) => w.getTitle().includes("Git 对比"))
          .isMaximized(),
      ),
    );
    assert.equal(
      await diff.locator(".diff-action-toggle input").count(),
      0,
    );
    checks.push("独立最大化窗口、Monaco Worker、完整双栏差异、默认编辑");
    await diff.getByRole("button", { name: "设置 ⚙" }).click();
    await diff.getByLabel("深色主题").uncheck();
    await diff.getByLabel("字号").fill("15");
    await diff.getByLabel("折叠未修改区域").check();
    await diff.getByRole("button", { name: "设置 ⚙" }).click();
    await diff.getByLabel("对比布局").selectOption({ label: "单栏对比" });
    await diff.getByLabel("对比布局").selectOption({ label: "双栏对比" });
    await diff.getByTitle("显示 / 隐藏文件列表").click();
    assert.equal(await diff.locator(".diff-files").isVisible(), false);
    await diff.getByTitle("显示 / 隐藏文件列表").click();
    await diff.keyboard.press("F11");
    await until(
      () =>
        app.evaluate(({ BrowserWindow }) =>
          BrowserWindow.getAllWindows().some((w) => w.isFullScreen()),
        ),
      "F11 enters",
    );
    await diff.keyboard.press("F11");
    checks.push("主题字号、折叠、单/双栏、文件栏收起和 F11");
    await diff.getByLabel("比较来源").selectOption("unstaged");
    await until(
      async () =>
        (await diff.locator(".diff-version-labels").textContent()).includes(
          "暂存区",
        ),
      "index comparison",
    );
    await diff.getByTitle("Git 操作", { exact: true }).click();
    await diff.getByRole("button", { name: "Stage 此块", exact: true }).click();
    await until(
      () => Promise.resolve(git("diff", "--cached").includes("line2 = 200")),
      "hunk staged",
    );
    assert.ok(!git("diff", "--cached").includes("line40 = 400"));
    checks.push("从 Diff 逐块 Stage 修改真实 Index，保留另一块未暂存");
    await until(
      async () =>
        await diff
          .getByRole("button", { name: "Stage 此块", exact: true })
          .isEnabled(),
      "write finished",
    );
    await capture(diff, "diff-viewer");
    await diff.getByLabel("比较来源").selectOption("staged");
    await until(
      async () =>
        await diff
          .getByRole("button", { name: "Unstage 此块", exact: true })
          .count(),
      "staged hunk ready",
    );
    await diff
      .getByRole("button", { name: "Unstage 此块", exact: true })
      .click();
    await until(
      () => Promise.resolve(git("diff", "--cached") === ""),
      "hunk unstaged",
    );
    checks.push("从 Diff 逐块 Unstage 修改真实 Index");
    await until(
      () => diff.getByTitle("刷新（F5）").isEnabled(),
      "unstage and refresh finished",
    );
    await api(page, "git.diff-open", {
      projectId: "homeproject",
      comparison: { mode: "local" },
      file: "other.vue",
    });
    await until(
      async () =>
        (await diff.locator(".diff-current-path").textContent()) ===
        "other.vue",
      "window reuse",
    );
    assert.equal((await app.windows()).length, 2);
    await until(
      async () =>
        (await diff.locator(".diff-statusbar").textContent()).includes(
          "1 处差异",
        ),
      "Vue diff",
    );
    assert.ok((await diff.locator(".mtk1,.mtk2,.mtk3").count()) > 0);
    checks.push("同项目文件切换复用窗口、Vue 语法高亮");
    write("other.vue", "<template><div>external edit</div></template>\n");
    await until(
      async () =>
        (await diff
          .locator(".diff-alert")
          .filter({ hasText: "外部变化" })
          .count()) > 0,
      "external file watcher",
    );
    checks.push("外部修改当前文件时显示过期内容提示");
    const denied = await diff.evaluate(() =>
      window.workbench.call("git.erp", { projectId: "homeproject" }),
    );
    assert.equal(denied.ok, false);
    const cross = await diff.evaluate(() =>
      window.workbench.call("git.status", { projectId: "employee" }),
    );
    assert.equal(cross.ok, false);
    assert.equal(await diff.evaluate(() => typeof window.require), "undefined");
    checks.push("子窗口 IPC 白名单、项目绑定、Node 隔离");
    await diff.close();
    await page.bringToFront();
    await api(page, "git.execute", {
      projectId: "homeproject",
      operation: "stage",
      files: ["src/中文 [文件].ts"],
    });
    await page.getByLabel("本地提交说明").fill("UI staged commit");
    await page
      .getByRole("button", { name: "Commit", exact: true })
      .last()
      .click();
    await until(
      () =>
        Promise.resolve(git("log", "-1", "--format=%s") === "UI staged commit"),
      "UI commit",
    );
    assert.ok(git("status", "--porcelain").includes("other.vue"));
    await until(
      async () =>
        (
          await api(page, "git.status", { projectId: "homeproject" })
        ).files.every((f) => !f.staged),
      "commit refresh",
    );
    checks.push("UI Commit 仅提交暂存内容，保留其他工作区和未跟踪文件");
    await page.getByRole("tab", { name: "Git Log", exact: true }).click();
    await page.locator(".git-log-row").first().click();
    await page.locator(".git-log-detail code").waitFor();
    assert.ok((await page.locator(".git-graph circle").count()) > 0);
    checks.push("Git Log 拓扑、Commit 详情和增量历史");
    // Create a real conflict only in this disposable fixture.
    git("add", "other.vue");
    git("commit", "-m", "vue");
    git("branch", "incoming");
    write("other.vue", "local\n");
    git("commit", "-am", "local");
    git("switch", "incoming");
    write("other.vue", "incoming\n");
    git("commit", "-am", "incoming");
    git("switch", "dev");
    spawnSync("git", ["-C", repo, "merge", "incoming"], {
      windowsHide: true,
      encoding: "utf8",
    });
    const conflictOpen = app.waitForEvent("window");
    await api(page, "git.diff-open", {
      projectId: "homeproject",
      comparison: { mode: "local" },
      file: "other.vue",
      conflict: true,
    });
    diff = await conflictOpen;
    diff.on("pageerror", (e) => errors.push(e.message));
    await until(
      async () =>
        (await diff.locator(".diff-merge-toolbar").filter({ hasText: "未解决冲突" }).textContent()).includes(
          "未解决冲突 1 个",
        ),
      "three-way conflict",
    );
    await capture(diff, "three-way-conflict");
    assert.ok((await diff.locator(".git-conflict-side").count()) > 0);
    await diff.getByRole("button", { name: "接受左侧", exact: true }).click();
    await diff
      .getByRole("button", { name: "保存并标记解决", exact: true })
      .click();
    await until(
      () => Promise.resolve(git("ls-files", "-u") === ""),
      "conflict stage",
    );
    await diff.getByRole("button", { name: "Continue", exact: true }).click();
    await until(
      async () =>
        !(await api(page, "git.status", { projectId: "homeproject" }))
          .operation,
      "merge continue",
    );
    assert.equal(git("show", "HEAD:other.vue"), "local");
    checks.push("三方冲突接受左侧、保存暂存、Merge Continue 全流程");
    await capture(diff, "conflict-resolved");
    assert.deepEqual(errors, []);
    await until(
      () => diff.getByTitle("刷新（F5）").isEnabled(),
      "final write finished",
    );
    const closed = app.waitForEvent("close", { timeout: 20000 });
    await app
      .evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()
          .find((window) => window.webContents.getURL().endsWith("/index.html"))
          .close(),
      )
      .catch(() => {});
    await closed;
    app = undefined;
    checks.push("离线加载本地 Monaco 资源；主窗口正常关闭时释放 Diff 子窗口");
    const report = { passed: true, packaged: !!exe, dir, checks, errors };
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify(report, null, 2),
    );
    console.log(JSON.stringify(report));
  } catch (error) {
    console.error(error);
    if (page)
      try {
        await capture(page, "failure-main");
      } catch {}
    if (diff)
      try {
        await capture(diff, "failure-diff");
      } catch {}
    console.error(JSON.stringify({ dir, errors, checks }));
    process.exitCode = 1;
  } finally {
    if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  }
}
void main();

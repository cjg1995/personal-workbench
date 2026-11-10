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
  dir = path.join(root, ".local", "diff-idea-" + Date.now()),
  repo = path.join(dir, "repo");
fs.mkdirSync(repo, { recursive: true });
let app, page, diff;
const errors = [],
  checks = [];
function git(...args) {
  const value = spawnSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    windowsHide: true,
  });
  if (value.status) throw new Error(value.stderr);
  return value.stdout.trimEnd();
}
function write(file, text) {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
function read(file) {
  return fs.readFileSync(path.join(repo, file), "utf8");
}
async function api(target, name, payload) {
  const response = await target.evaluate(
    ({ name, payload }) => window.workbench.call(name, payload),
    { name, payload },
  );
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
async function until(fn, label, timeout = 30000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Timed out: " + label);
}
async function capture(name, target = diff) {
  const cdp = await target.context().newCDPSession(target);
  const value = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: false,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(
    path.join(dir, name + ".png"),
    Buffer.from(value.data, "base64"),
  );
  await cdp.detach();
}
async function current(file, count) {
  await until(
    async () =>
      (await diff.locator(".diff-current-path").textContent()) === file &&
      (count === undefined ||
        (await diff.locator(".diff-statusbar").textContent()).includes(
          `${count} 处差异`,
        )),
    file + " ready",
  );
  await until(
    () => diff.getByTitle("刷新（F5）").isEnabled(),
    file + " write complete",
  );
}
async function next() {
  await diff.locator('[data-action="next-difference"]').click();
  if (await diff.locator(".diff-cross-file-hint").count())
    await diff.locator('[data-action="next-difference"]').click();
}
async function previous() {
  await diff.locator('[data-action="previous-difference"]').click();
  if (await diff.locator(".diff-cross-file-hint").count())
    await diff.locator('[data-action="previous-difference"]').click();
}
async function select(file, count) {
  await diff
    .locator(".git-file-row")
    .filter({
      has: diff.locator(".git-file-path", {
        hasText: new RegExp("^" + file.replaceAll(".", "\\.") + "$"),
      }),
    })
    .click();
  await current(file, count);
}
async function response(value) {
  await app.evaluate(
    (_electron, value) => globalThis.diffResponses.push(value),
    value,
  );
}
(async () => {
  try {
    git("init", "-b", "dev");
    git("config", "user.name", "Diff Test");
    git("config", "user.email", "diff@example.invalid");
    git("config", "core.autocrlf", "false");
    git("config", "commit.gpgsign", "false");
    fs.mkdirSync(path.join(repo, ".git/empty-hooks"));
    git("config", "core.hooksPath", path.join(repo, ".git/empty-hooks"));
    const yaml =
      "spring:\n  datasource:\n    druid:\n      statViewServlet:\n        enabled: true\n        login-username: admin\n        login-password: example\n" +
      Array.from({ length: 25 }, (_, i) => `# context ${i}\n`).join("");
    const source = Array.from(
      { length: 42 },
      (_, i) => `const line${i + 1} = ${i + 1};\n`,
    ).join("");
    write("a.yml", yaml);
    write("b.ts", source);
    write("c.ts", "const value = 1;\n");
    write("d.txt", "same\nleft\nsame\nright\nsame\n");
    git("add", ".");
    git("commit", "-m", "base");
    git("branch", "topic/中文");
    const remote = path.join(dir, "remote.git");
    const initialized = spawnSync("git", ["init", "--bare", remote], {
      encoding: "utf8",
      windowsHide: true,
    });
    assert.equal(initialized.status, 0, initialized.stderr);
    git("remote", "add", "origin", remote);
    git("push", "-u", "origin", "dev");
    git("push", "origin", "HEAD:refs/heads/remote-only");
    const modifyFiles = () => {
      write("a.yml", yaml.replace("enabled: true", "enabled: false"));
      write(
        "b.ts",
        source
          .replace("line2 = 2", "line2 = 200")
          .replace("line35 = 35", "line35 = 350"),
      );
      write("c.ts", "const value = 1;\nconst added = 2;\n");
      write("d.txt", "same\nleft edited\nsame\nright edited\nsame\n");
      write("generated/new.txt", "untracked\n");
    };
    write("generated/keep.txt", "preserve while switching\n");
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
    if(exe)assert.equal(await app.evaluate(({app})=>app.isPackaged),true);
    await page.waitForSelector('[data-page="work"]');
    await page.context().setOffline(true);
    await page.context().addInitScript(() => {
      localStorage.setItem(
        "git-diff-settings",
        JSON.stringify({ dark: true, fontSize: 14 }),
      );
      localStorage.removeItem("git-diff-settings-v2");
    });
    await app.evaluate(({ dialog }) => {
      globalThis.diffResponses = [];
      globalThis.diffConfirmations = [];
      dialog.showMessageBox = async (_window, options) => {
        globalThis.diffConfirmations.push(options);
        return { response: globalThis.diffResponses.shift() ?? 1 };
      };
    });
    const config = (await api(page, "bootstrap")).config;
    config.projects.find((p) => p.id === "homeproject").path = repo;
    await api(page, "settings.save", config);
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "Git 管理", exact: true })
      .click();
    await until(
      async () =>
        (
          await page
            .getByRole("button", { name: "切换分支", exact: true })
            .textContent()
        ).includes("dev"),
      "current branch loaded",
    );
    const switchButton = page.getByRole("button", {
      name: "切换分支",
      exact: true,
    });
    async function switchQuick(query) {
      await switchButton.click();
      const input = page.getByRole("combobox", { name: "搜索并切换分支" });
      await input.fill(query);
      await until(
        () =>
          page
            .getByRole("option", {
              name: new RegExp(query.replaceAll("/", "\\/")),
            })
            .count(),
        "branch options loaded",
      );
      await input.press("Enter");
    }
    await switchButton.click();
    await until(
      () => page.getByRole("option", { name: /topic\/中文/ }).count(),
      "branch menu rendered",
    );
    await capture("quick-branches", page);
    await page
      .getByRole("combobox", { name: "搜索并切换分支" })
      .fill("topic/中文");
    assert.equal(
      await page
        .getByRole("tab", { name: "本地变更" })
        .getAttribute("aria-selected"),
      "true",
    );
    await page
      .getByRole("combobox", { name: "搜索并切换分支" })
      .press("Escape");
    assert.equal(
      await page.getByRole("combobox", { name: "搜索并切换分支" }).count(),
      0,
    );
    await switchQuick("topic/中文");
    await until(
      async () =>
        (await api(page, "git.status", { projectId: "homeproject" })).branch ===
        "topic/中文",
      "quick local checkout",
    );
    assert.equal(read("generated/keep.txt"), "preserve while switching\n");
    assert.equal(
      await page
        .getByRole("tab", { name: "本地变更" })
        .getAttribute("aria-selected"),
      "true",
    );
    await switchQuick("origin/remote-only");
    await until(
      async () =>
        (await api(page, "git.status", { projectId: "homeproject" })).branch ===
        "remote-only",
      "quick remote checkout",
    );
    assert.equal(
      (await api(page, "git.status", { projectId: "homeproject" })).upstream,
      "origin/remote-only",
    );
    await switchQuick("dev");
    await until(
      async () =>
        (await api(page, "git.status", { projectId: "homeproject" })).branch ===
        "dev",
      "back to dev",
    );
    modifyFiles();
    await switchQuick("topic/中文");
    await until(
      () =>
        page.getByRole("alert").filter({ hasText: "先提交或 Stash" }).count(),
      "dirty checkout protected",
    );
    assert.equal(
      (await api(page, "git.status", { projectId: "homeproject" })).branch,
      "dev",
    );
    checks.push(
      "当前分支下拉可搜索并键盘切换本地/远程分支，不切页签；保留未跟踪文件并阻止脏工作区切换",
    );
    const opened = app.waitForEvent("window");
    await api(page, "git.diff-open", {
      projectId: "homeproject",
      comparison: { mode: "local" },
      file: "a.yml",
    });
    diff = await opened;
    diff.on("pageerror", (error) => errors.push(error.message));
    diff.on("console", (event) => {
      if (event.type() === "error") errors.push(event.text());
    });
    await current("a.yml", 1);
    assert.equal(await diff.locator(".diff-window.diff-light").count(), 1);
    assert.equal(await diff.getByLabel("操作模式").count(), 0);
    assert.equal(await diff.locator(".diff-files").isVisible(), false);
    await diff.getByTitle("显示 / 隐藏文件列表").click();
    const filters = await diff.locator(".diff-file-filters").boundingBox();
    assert.ok(filters.height < 180);
    assert.equal(await diff.locator(".diff-untracked-filter input").count(), 0);
    checks.push("旧默认深色设置迁移为浅色，文件栏默认隐藏，可手动展开，过滤栏尺寸正常");
    assert.ok((await diff.locator(".git-revert-glyph").count()) > 0);
    await capture("idea-light");
    await next();
    await current("b.ts", 2);
    assert.ok(
      (await diff.locator(".diff-difference-position").textContent()).includes(
        "1 / 2",
      ),
    );
    await next();
    assert.ok(
      (await diff.locator(".diff-difference-position").textContent()).includes(
        "2 / 2",
      ),
    );
    await diff.keyboard.press("F7");
    await diff.keyboard.press("F7");
    await current("c.ts", 1);
    assert.ok((await diff.locator(".idea-added-line").count()) > 0);
    await capture("idea-added-lines");
    await diff.keyboard.press("Shift+F7");
    await diff.keyboard.press("Shift+F7");
    await current("b.ts", 2);
    assert.ok(
      (await diff.locator(".diff-difference-position").textContent()).includes(
        "2 / 2",
      ),
    );
    checks.push("按钮及 F7/Shift+F7 在文件边界顺序跨文件并定位首末差异");
    await diff.getByLabel("搜索对比文件", { exact: true }).fill(".ts");
    await next();
    await current("c.ts", 1);
    await next();
    assert.equal(
      await diff.locator(".diff-current-path").textContent(),
      "c.ts",
    );
    assert.ok(
      (await diff.locator(".diff-status-result").textContent()).includes(
        "最后一个",
      ),
    );
    await previous();
    await current("b.ts", 2);
    await previous();
    await previous();
    assert.equal(
      await diff.locator(".diff-current-path").textContent(),
      "b.ts",
    );
    checks.push("跨文件顺序遵守搜索过滤，列表两端不循环");
    await diff.getByLabel("搜索对比文件", { exact: true }).fill("");
    await diff
      .locator(".monaco-diff-editor .editor.modified .view-lines")
      .click({ position: { x: 160, y: 20 } });
    await diff.keyboard.press("Control+End");
    await diff.keyboard.insertText("\n// unsaved edit");
    await until(
      async () =>
        (await diff.locator(".diff-statusbar").textContent()).includes(
          "3 处差异",
        ),
      "unsaved model diff",
    );
    await response(0);
    await next();
    assert.equal(
      await diff.locator(".diff-current-path").textContent(),
      "b.ts",
    );
    assert.ok(
      (await diff.locator(".diff-statusbar").textContent()).includes(
        "尚未保存",
      ),
    );
    await response(1);
    await next();
    await current("c.ts", 1);
    assert.ok(!read("b.ts").includes("unsaved edit"));
    checks.push("跨文件遵守未保存编辑确认，取消保留编辑，确认后仅丢弃模型");
    await select("d.txt", 2);
    assert.equal(
      await diff.locator(".git-revert-glyph:not(.git-revert-disabled)").count(),
      2,
    );
    const index = fs.readFileSync(path.join(repo, ".git/index"));
    await diff
      .locator(".git-revert-glyph:not(.git-revert-disabled)")
      .first()
      .click();
    await until(
      () =>
        Promise.resolve(
          read("d.txt") === "same\nleft\nsame\nright edited\nsame\n",
        ),
      "first exact revert",
    );
    await current("d.txt", 1);
    assert.deepEqual(fs.readFileSync(path.join(repo, ".git/index")), index);
    await capture("revert-adjacent");
    await diff
      .locator(".git-revert-glyph:not(.git-revert-disabled)")
      .first()
      .click();
    await until(
      () =>
        Promise.resolve(read("d.txt") === "same\nleft\nsame\nright\nsame\n"),
      "second exact revert",
    );
    await current("d.txt", 0);
    checks.push("点击差异行 Revert 真实回滚，相邻差异独立且 Index 字节不变");
    await select("a.yml", 1);
    await diff.locator('[data-action="revert-current"]').click();
    await until(
      () => Promise.resolve(read("a.yml") === yaml),
      "toolbar revert",
    );
    await current("a.yml", 0);
    checks.push(
      "HEAD ↔ 工作区工具栏 Revert 可用，文件完成后保留当前文档供撤销",
    );
    await select("c.ts", 1);
    await diff
      .locator(".git-revert-glyph:not(.git-revert-disabled)")
      .first()
      .click();
    await current("c.ts", 0);
    assert.equal(read("c.ts"), "const value = 1;\n");
    checks.push("Revert 无需弹框确认，直接写入工作区");
    await diff.keyboard.press("Control+z");
    await current("c.ts", 1);
    write("c.ts", "external edit\n");
    await until(
      () => diff.locator(".diff-alert").filter({ hasText: "外部变化" }).count(),
      "stale content",
    );
    assert.equal(
      await diff.locator('[data-action="revert-current"]').isDisabled(),
      true,
    );
    checks.push("外部修改后禁止使用过期差异 Revert");
    assert.deepEqual(errors, []);
    const result = { passed: true, packaged: !!exe, dir, checks, errors };
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error);
    if (diff)
      try {
        await capture("failure");
      } catch {}
    console.error(JSON.stringify({ dir, errors, checks }));
    process.exitCode = 1;
  } finally {
    if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {});
  }
})();

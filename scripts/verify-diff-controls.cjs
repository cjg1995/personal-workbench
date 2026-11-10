const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"); }
const root = path.resolve(__dirname, ".."),
  dir = path.join(root, ".local", "diff-controls-" + Date.now()),
  repo = path.join(dir, "repo");
fs.mkdirSync(repo, { recursive: true });
let app, page, diff;
const errors = [], checks = [];
function git(...args) {
  return execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8", windowsHide: true, stdio: "pipe",
  }).trimEnd();
}
async function api(name, payload) {
  const response = await page.evaluate(({ name, payload }) => window.workbench.call(name, payload), { name, payload });
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
async function until(fn, label) {
  const start = Date.now();
  while (Date.now() - start < 15000) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  throw new Error("Timed out: " + label);
}
async function capture(name) {
  const cdp = await diff.context().newCDPSession(diff);
  const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: false, captureBeyondViewport: false });
  fs.writeFileSync(path.join(dir, name + ".png"), Buffer.from(result.data, "base64"));
  await cdp.detach();
}
async function openFile(file) {
  await api("git.diff-open", { projectId: "homeproject", file, comparison: { mode: "local" } });
  await until(async () => (await diff.locator(".diff-current-path").textContent()) === file, file);
  await until(async () => !(await diff.locator(".diff-loading").count()) &&
    (await diff.locator(".diff-statusbar").textContent()).includes("1 处差异"), file + " editor ready");
}
async function closeFindWithMouse(side, label) {
  const widget = diff.locator(`.editor.${side} .find-widget.visible`);
  await widget.waitFor();
  const close = widget.locator(".codicon-widget-close");
  await close.hover();
  const box = await close.boundingBox();
  const tooltip = diff.locator(".monaco-hover.workbench-hover.compact.with-pointer").filter({ hasText: "关闭 (Escape)" });
  await tooltip.waitFor({ state: "visible" });
  await until(() => close.evaluate((element) => {
    const button = element.getBoundingClientRect();
    const hit = document.elementFromPoint(button.x + button.width / 2, button.y + button.height / 2);
    const hint = [...document.querySelectorAll(".monaco-hover.workbench-hover.compact.with-pointer")]
      .find((node) => node.textContent.includes("关闭 (Escape)") && node.getBoundingClientRect().width);
    if (!hint) return false;
    const bounds = hint.getBoundingClientRect();
    return (hit === element || element.contains(hit)) &&
      (bounds.bottom <= button.top || bounds.top >= button.bottom || bounds.right <= button.left || bounds.left >= button.right);
  }), label + " tooltip leaves close button accessible");
  await capture(label);
  // A raw mouse click reproduces the reported failure; locator.click retries can hide the tooltip.
  await diff.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await until(async () => !(await widget.count()), label + " mouse closes find");
}
(async () => {
  try {
    git("init", "-b", "dev");
    for (const [key, value] of Object.entries({ "user.name": "Diff Controls", "user.email": "test@example.invalid", "core.autocrlf": "false", "commit.gpgsign": "false" })) git("config", key, value);
    const hooks = path.join(repo, ".git", "empty-hooks");
    fs.mkdirSync(hooks);
    git("config", "core.hooksPath", hooks);
    for (const file of ["a.ts", "b.ts"]) fs.writeFileSync(path.join(repo, file), "const value = 1;\nconst original = true;\n");
    git("add", "."); git("commit", "-m", "base");
    for (const file of ["a.ts", "b.ts"]) fs.writeFileSync(path.join(repo, file), "const value = 2;\nconst original = true;\n");
    const indexBefore = fs.readFileSync(path.join(repo, ".git", "index"));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const exe = process.env.WORKBENCH_GIT_EXE;
    app = await playwright._electron.launch({ executablePath: exe || require("electron"), args: [...(exe ? [] : [root]), "--data-dir=" + path.join(dir, "data")], env, timeout: 60000 });
    if (exe) assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
    page = await app.firstWindow();
    await page.waitForSelector('[data-page="work"]');
    await page.context().setOffline(true);
    const config = (await api("bootstrap")).config;
    config.projects.find((project) => project.id === "homeproject").path = repo;
    await api("settings.save", config);
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "Git 管理", exact: true }).click();
    await page.locator(".git-file-row").first().waitFor();
    assert.equal(await page.getByLabel("本地提交说明", { exact: true }).count(), 1);
    await page.locator(".git-file-row").first().click({ button: "right" });
    const menu = page.getByRole("menu");
    const menuText = await menu.textContent();
    for (const label of ["打开对比", "查看文件历史", "复制相对路径", "在文件资源管理器中打开"])
      assert.ok(menuText.includes(label), label);
    assert.doesNotMatch(menuText, /Show|History|Copy|Open|Explorer|Rollback/);
    await page.keyboard.press("Escape");
    await page.locator(".git-toolbar").getByRole("button", { name: "Push", exact: true }).click();
    assert.equal(await page.getByLabel("远程仓库", { exact: true }).count(), 1);
    await page.locator(".git-dialog").getByRole("button", { name: "取消", exact: true }).click();
    await page.locator(".git-toolbar").getByRole("button", { name: "Stash", exact: true }).click();
    assert.equal(await page.getByLabel("包含未跟踪文件", { exact: true }).count(), 1);
    await page.locator(".git-dialog").getByRole("button", { name: "取消", exact: true }).click();
    checks.push("Git 主页面的提交说明、右键菜单和远程/暂存弹窗使用中文，保留 Git 指令名");
    const opened = app.waitForEvent("window");
    await api("git.diff-open", { projectId: "homeproject", file: "a.ts", comparison: { mode: "local" } });
    diff = await opened;
    diff.on("pageerror", (error) => errors.push(error.message));
    await diff.waitForSelector(".monaco-diff-editor");
    assert.deepEqual(await diff.getByLabel("比较来源").locator("option").allTextContents(),
      ["HEAD ↔ 工作区", "HEAD ↔ 暂存区", "暂存区 ↔ 工作区"]);
    assert.equal(await diff.locator(".diff-files").isVisible(), false);
    assert.equal(await diff.locator(".diff-resize").isVisible(), false);
    assert.equal(await diff.getByTitle("显示 / 隐藏文件列表").getAttribute("aria-pressed"), "false");
    await capture("default-files-hidden");
    await diff.getByTitle("显示 / 隐藏文件列表").click();
    assert.equal(await diff.locator(".diff-files").isVisible(), true);
    await openFile("b.ts");
    assert.equal(await diff.locator(".diff-files").isVisible(), true);
    await diff.getByTitle("显示 / 隐藏文件列表").click();
    await openFile("a.ts");
    assert.equal(await diff.locator(".diff-files").isVisible(), false);
    checks.push("新窗口默认收起文件栏和分隔条；手动展开/收起后切换文件保留选择");
    for (const [width, dark] of [[1390, false], [1100, true]]) {
      await app.evaluate(({ BrowserWindow }, width) => {
        const window = BrowserWindow.getAllWindows().find((window) => window.getTitle().includes("Git 对比"));
        window.unmaximize(); window.setContentSize(width, 800);
      }, width);
      await diff.getByRole("button", { name: "设置 ⚙", exact: true }).click();
      await diff.getByLabel("深色主题").setChecked(dark);
      await diff.getByRole("button", { name: "设置 ⚙", exact: true }).click();
      await diff.getByRole("button", { name: "查找", exact: true }).click();
      const input = diff.locator(".editor.modified .find-widget textarea").first();
      assert.match(await input.getAttribute("placeholder"), /^查找/);
      await input.fill("没有这段内容_93842");
      await until(async () => (await diff.locator(".editor.modified .find-widget .matchesCount").textContent()).includes("无结果"), "localized no results");
      await closeFindWithMouse("modified", `find-${width}-modified`);
      if (!dark) {
        await diff.locator(".editor.original .view-lines").click({ position: { x: 140, y: 15 } });
        await diff.keyboard.press("Control+f");
        await closeFindWithMouse("original", `find-${width}-original`);
      }
    }
    checks.push("浅色/深色、宽/窄窗口和左右两侧查找，悬停提示不覆盖关闭按钮，真实鼠标点击可关闭");
    await diff.getByLabel("对比布局").selectOption({ label: "单栏对比" });
    await diff.getByRole("button", { name: "查找", exact: true }).click();
    await closeFindWithMouse("modified", "find-inline");
    await diff.getByRole("button", { name: "查找", exact: true }).click();
    await diff.locator(".editor.modified .find-widget textarea").first().press("Escape");
    await until(async () => !(await diff.locator(".editor.modified .find-widget.visible").count()), "Escape closes find");
    checks.push("单栏模式鼠标关闭和 Escape 键关闭均正常");
    await diff.close();
    const reopened = app.waitForEvent("window");
    await api("git.diff-open", { projectId: "homeproject", file: "b.ts", comparison: { mode: "local" } });
    diff = await reopened;
    await diff.waitForSelector(".monaco-diff-editor");
    assert.equal(await diff.locator(".diff-files").isVisible(), false);
    assert.deepEqual(fs.readFileSync(path.join(repo, ".git", "index")), indexBefore);
    assert.equal(fs.readFileSync(path.join(repo, "a.ts"), "utf8"), "const value = 2;\nconst original = true;\n");
    checks.push("重新打开窗口仍默认收起文件栏；查找和显示切换不修改 Index 或源文件");
    assert.deepEqual(errors, []);
    const result = { passed: true, packaged: !!exe, dir, checks, errors };
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error);
    if (diff) await capture("failure").catch(() => {});
    console.error(JSON.stringify({ dir, checks, errors }));
    process.exitCode = 1;
  } finally { if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); }
})();

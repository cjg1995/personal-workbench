const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), { execFileSync } = require("node:child_process");
let pw;
try { pw = require("playwright"); } catch { pw = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"); }
const root = path.resolve(__dirname, ".."), dir = path.join(root, ".local", "diff-scrollbars-" + Date.now()), repo = path.join(dir, "repo");
fs.mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true, stdio: "pipe" }).trimEnd();
const read = (file) => fs.readFileSync(path.join(repo, file), "utf8");
const write = (file, text) => fs.writeFileSync(path.join(repo, file), text);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const checks = [], errors = [];
let app, page, diff;
async function until(fn, label) { const start = Date.now(); while (Date.now() - start < 30000) { if (await fn()) return; await delay(80); } throw new Error("Timed out: " + label); }
async function api(name, payload) { const result = await page.evaluate(({ name, payload }) => window.workbench.call(name, payload), { name, payload }); if (!result.ok) throw new Error(result.error); return result.data; }
async function capture(name) { const cdp = await diff.context().newCDPSession(diff); const image = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: false, captureBeyondViewport: false }); fs.writeFileSync(path.join(dir, name + ".png"), Buffer.from(image.data, "base64")); await cdp.detach(); }
const left = () => diff.getByRole("scrollbar", { name: "原始代码垂直滚动条" });
const right = () => diff.getByRole("scrollbar", { name: "工作区代码垂直滚动条" });
const value = (bar) => bar.getAttribute("aria-valuenow").then(Number);
async function edges() {
  await until(() => diff.evaluate(() => {
    const bar = document.querySelector(".idea-scrollbar-modified"), pane = document.querySelector(".editor.modified"), host = document.querySelector(".diff-main > .diff-editor");
    if (!bar || !pane || !host) return false;
    const a = bar.getBoundingClientRect(), b = pane.getBoundingClientRect(), c = host.getBoundingClientRect();
    return Math.abs(a.right - b.right) < 2 && Math.abs(a.right - c.right) < 2;
  }), "editor resize layout settled");
  assert.equal(await diff.locator(".diffOverview").count(), 0);
  assert.equal(await diff.getByRole("scrollbar").count(), 2);
  const a = await left().boundingBox(), b = await right().boundingBox();
  const original = await diff.locator(".editor.original").boundingBox(), modified = await diff.locator(".editor.modified").boundingBox();
  const host = await diff.locator(".diff-main > .diff-editor").boundingBox();
  assert.ok(Math.abs(a.x - original.x) < 2);
  assert.ok(Math.abs(b.x + b.width - (modified.x + modified.width)) < 2);
  assert.ok(Math.abs(b.x + b.width - (host.x + host.width)) < 2, "no extra track at right");
  assert.equal(a.width, 14); assert.equal(b.width, 14);
  const natives = await diff.locator(".diff-editor .scrollbar.vertical").evaluateAll((nodes) => nodes.filter((node) => {
    const style = getComputedStyle(node), box = node.getBoundingClientRect(); return box.width > 0 && box.height > 0 && Number(style.opacity) > 0 && style.visibility !== "hidden";
  }).length);
  assert.equal(natives, 0, "no native scrollbars in middle or right");
}
async function synced() { await until(async () => Math.abs(await value(left()) - await value(right())) < 3, "both panes aligned"); }
(async () => {
  try {
    git("init", "-b", "dev"); git("config", "user.name", "Scrollbar QA"); git("config", "user.email", "scroll@example.invalid"); git("config", "core.autocrlf", "false"); git("config", "commit.gpgsign", "false");
    fs.mkdirSync(path.join(repo, ".git/hooks-empty")); git("config", "core.hooksPath", path.join(repo, ".git/hooks-empty"));
    const lines = ["public class ScrollDemo {"];
    for (let i = 1; i <= 350; i++) lines.push(`    public static final int LINE_${i} = ${i}; // ${"业务说明 ".repeat(24)}`);
    lines.push("} // END_OF_FILE", "");
    const original = lines.join("\n");
    write("a.java", original); write("b.java", original); git("add", "."); git("commit", "-m", "base");
    const modified = original.replace("LINE_20 = 20", "LINE_20 = 2000").replace("LINE_120 = 120", "LINE_120 = 12000")
      .replace("    public static final int LINE_220", Array.from({ length: 25 }, (_, i) => `    // INSERTED_${i}\n`).join("") + "    public static final int LINE_220");
    write("a.java", modified); write("b.java", original.replace("LINE_30 = 30", "LINE_30 = 3000"));
    const index = fs.readFileSync(path.join(repo, ".git/index"));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const exe = process.env.WORKBENCH_GIT_EXE;
    app = await pw._electron.launch({ executablePath: exe || require("electron"), args: [...(exe ? [] : [root]), "--data-dir=" + path.join(dir, "data")], env, timeout: 60000 });
    page = await app.firstWindow(); await page.waitForSelector("[data-page=work]");
    const config = (await api("bootstrap")).config; config.projects.find((p) => p.id === "homeproject").path = repo; await api("settings.save", config);
    const opened = app.waitForEvent("window"); await api("git.diff-open", { projectId: "homeproject", comparison: { mode: "local" }, file: "a.java" }); diff = await opened;
    diff.on("pageerror", (error) => errors.push(error.message));
    await until(() => diff.locator(".idea-scrollbar-change").count(), "diff marker positions");
    await edges(); await capture("01-outer-scrollbars");
    checks.push("双栏仅保留最左与最右各一条滚动条，中央没有滚动条，右侧没有重复差异概览");

    await left().focus(); await diff.keyboard.press("Home"); await synced();
    const slider = await left().locator(".idea-scrollbar-thumb").boundingBox();
    await diff.mouse.move(slider.x + slider.width / 2, slider.y + slider.height / 2); await diff.mouse.down(); await diff.mouse.move(slider.x + slider.width / 2, slider.y + slider.height / 2 + 120, { steps: 8 }); await diff.mouse.up();
    await until(async () => await value(left()) > 500, "left thumb dragged"); await synced();
    const rightBounds = await right().boundingBox(), beforeWheel = await value(right());
    await diff.mouse.move(rightBounds.x + 7, rightBounds.y + 180); await diff.mouse.wheel(0, 700);
    await until(async () => await value(right()) > beforeWheel + 200, "right track wheel"); await synced();
    await right().focus(); await diff.keyboard.press("End"); await synced();
    await until(async () => (await diff.locator(".editor.modified .view-lines").textContent()).includes("END_OF_FILE"), "right reaches final line");
    assert.ok(Math.abs(await value(right()) - Number(await right().getAttribute("aria-valuemax"))) < 2);
    await left().focus(); await diff.keyboard.press("Home"); await synced();
    const track = await left().boundingBox(); await diff.mouse.click(track.x + 7, track.y + track.height * 0.5);
    const maximum = Number(await left().getAttribute("aria-valuemax"));
    await until(async () => await value(left()) > maximum * 0.3 && await value(left()) < maximum * 0.7, "left track jump"); await synced(); await capture("02-scroll-middle");
    checks.push("左右拖动/滚轮/轨道跳转和 Home/End 正常，原始与工作区滚动保持同步并能到达文件尾");

    await left().focus(); await diff.keyboard.press("Home"); await synced();
    const glyph = diff.locator(".git-revert-glyph:not(.git-revert-disabled)").first(); await glyph.hover();
    const icon = await glyph.evaluate((element) => { const css = getComputedStyle(element, "::before"), box = element.getBoundingClientRect(); const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2); return { width: css.width, height: css.height, image: css.backgroundImage, border: css.borderStyle, clickable: target === element || element.contains(target) }; });
    assert.equal(icon.width, "20px"); assert.equal(icon.height, "20px"); assert.equal(icon.border, "solid"); assert.ok(icon.image.includes("svg")); assert.ok(icon.clickable);
    await capture("03-visible-revert"); await glyph.click();
    await until(() => read("a.java").includes("LINE_20 = 20;") && read("a.java").includes("LINE_120 = 12000;"), "central revert works");
    await until(() => diff.getByTitle("刷新（F5）").isEnabled(), "revert saved");
    assert.deepEqual(fs.readFileSync(path.join(repo, ".git/index")), index); await edges();
    checks.push("中央 Revert 为 20×20 双箭头，带边框及悬停反馈，无遮挡且真实点击只回滚对应块");

    const sash = diff.locator(".monaco-diff-editor > .monaco-sash.vertical").first();
    const sashBounds = await sash.boundingBox();
    await diff.mouse.move(sashBounds.x + sashBounds.width / 2, sashBounds.y + 180); await diff.mouse.down(); await diff.mouse.move(sashBounds.x + 100, sashBounds.y + 180, { steps: 8 }); await diff.mouse.up();
    await edges();
    await app.evaluate(({ BrowserWindow }) => { const window = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes("Git 对比")); window.unmaximize(); window.setContentSize(1100, 780); });
    await edges(); await capture("04-resized");
    await diff.getByLabel("对比布局").selectOption({ label: "单栏对比" });
    await until(async () => await diff.getByRole("scrollbar").count() === 1, "inline one track");
    assert.equal(await diff.locator(".idea-scrollbar-original").isVisible(), false); assert.equal(await right().isVisible(), true); assert.equal(await diff.locator(".diffOverview").count(), 0);
    await diff.getByLabel("对比布局").selectOption({ label: "双栏对比" }); await edges();
    await api("git.diff-open", { projectId: "homeproject", comparison: { mode: "local" }, file: "b.java" });
    await until(async () => (await diff.locator(".diff-current-path").textContent()) === "b.java" && !(await diff.locator(".diff-loading").count()), "second file loaded"); await edges();
    await left().focus(); await diff.keyboard.press("End"); await synced(); await left().press("Home"); await synced();
    checks.push("拖动分栏、缩放窗口、单/双栏切换与切换文件后位置保持正确，不产生重复或失效滚动条");
    assert.deepEqual(errors, []);
    const result = { passed: true, packaged: !!exe, dir, checks, errors }; fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } catch (error) { console.error(error); if (diff) await capture("failure").catch(() => {}); console.error(JSON.stringify({ dir, checks, errors })); process.exitCode = 1; }
  finally { if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); }
})();

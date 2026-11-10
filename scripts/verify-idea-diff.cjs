const fs = require("node:fs"), path = require("node:path"), assert = require("node:assert/strict"), { execFileSync } = require("node:child_process");
let pw;
try { pw = require("playwright"); } catch { pw = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"); }
const root = path.resolve(__dirname, ".."), dir = path.join(root, ".local", "idea-diff-" + Date.now()), repo = path.join(dir, "repo");
fs.mkdirSync(repo, { recursive: true });
const git = (...args) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", windowsHide: true }).trimEnd();
const write = (file, text) => fs.writeFileSync(path.join(repo, file), text);
const read = (file) => fs.readFileSync(path.join(repo, file), "utf8");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app, page, diff;
const checks = [], errors = [];
async function until(fn, label, timeout = 30000) { const start = Date.now(); while (Date.now() - start < timeout) { if (await fn()) return; await delay(80); } throw new Error("Timed out: " + label); }
async function api(name, payload) { const result = await page.evaluate(({ name, payload }) => window.workbench.call(name, payload), { name, payload }); if (!result.ok) throw new Error(result.error); return result.data; }
async function settled() { await until(() => diff.getByTitle("刷新（F5）").isEnabled(), "save settled"); }
async function current(file, count) { await until(async () => (await diff.locator(".diff-current-path").textContent()) === file && (count === undefined || (await diff.locator(".diff-statusbar").textContent()).includes(`${count} 处差异`)) && !(await diff.locator(".diff-loading").count()), file + " loaded"); await settled(); }
async function open(file, mode = "local", count) { await api("git.diff-open", { projectId: "homeproject", file, comparison: { mode } }); await current(file, count); }
async function unchangedIndex(index) { assert.deepEqual(fs.readFileSync(path.join(repo, ".git/index")), index); }
async function capture(name) { const session = await diff.context().newCDPSession(diff); const result = await session.send("Page.captureScreenshot", { format: "png", fromSurface: false, captureBeyondViewport: false }); fs.writeFileSync(path.join(dir, name + ".png"), Buffer.from(result.data, "base64")); await session.detach(); }
async function hotkey(key, file, expected) { await diff.keyboard.press(key); await until(() => read(file) === expected, key + " persisted"); await settled(); }
(async () => {
  try {
    git("init", "-b", "dev"); git("config", "user.name", "Diff QA"); git("config", "user.email", "diff@example.invalid"); git("config", "core.autocrlf", "false"); git("config", "commit.gpgsign", "false");
    const lines = ["package example;", "", "public class CacheConstants {", "    /** 登录失败次数 */", '    public static final String PASSWORD_ERROR = "password_error";', ""];
    for (let i = 0; i < 35; i++) lines.push(`    // 业务说明 ${i + 1}`);
    lines.push("}", "");
    const original = lines.join("\n");
    write("a.java", original); write("b.txt", "before\n"); write("c.txt", "one\r\ntwo");
    git("add", "."); git("commit", "-m", "base");
    write("c.txt", "one\r\nstaged two"); git("add", "c.txt");
    write("c.txt", "one\r\nextra\r\nstaged two");
    const modified = original.replace("    // 业务说明 1\n", '    public static final String ADDED = "login_ip_fail";\n    // 业务说明 1\n').replace("    // 业务说明 28", "    public static int modified = 28;");
    write("a.java", modified); write("b.txt", "after\n");
    const index = fs.readFileSync(path.join(repo, ".git/index"));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const exe = process.env.WORKBENCH_GIT_EXE;
    app = await pw._electron.launch({ executablePath: exe || require("electron"), args: [...(exe ? [] : [root]), "--data-dir=" + path.join(dir, "data")], env, timeout: 60000 });
    page = await app.firstWindow(); await page.waitForSelector("[data-page=work]");
    await app.evaluate(({ dialog }) => { globalThis.__diffDialogs = []; dialog.showMessageBox = async (_window, options) => { globalThis.__diffDialogs.push(options.message); return { response: 1 }; }; });
    const config = (await api("bootstrap")).config; config.projects.find((p) => p.id === "homeproject").path = repo; await api("settings.save", config);
    const opened = app.waitForEvent("window"); await api("git.diff-open", { projectId: "homeproject", file: "a.java", comparison: { mode: "local" } }); diff = await opened;
    diff.on("pageerror", (error) => errors.push(error.message));
    await current("a.java", 2);
    assert.equal(await diff.getByLabel("操作模式", { exact: true }).count(), 0);
    assert.equal(await diff.locator(".diff-operation-toolbar").count(), 0);
    assert.ok(await diff.locator(".idea-original-gutter > span").count());
    assert.ok(await diff.locator(".idea-added-line").count());
    const colors = await diff.evaluate(() => {
      const styled = document.createElement('div');
      styled.className = 'char-insert';
      document.querySelector('.editor.modified .view-lines').append(styled);
      const insertedText = getComputedStyle(styled).backgroundColor;
      styled.remove();
      const theme = [...document.querySelectorAll('style')].map((element) => element.textContent).join('\n');
      return { insertedText, theme };
    });
    assert.match(colors.theme, /--vscode-diffEditor-insertedTextBackground:\s*#bfe6b9/i);
    assert.match(colors.theme, /--vscode-diffEditor-insertedLineBackground:\s*#d6e4f2/i);
    assert.equal(await diff.locator('.idea-added-line').first().evaluate((element) => getComputedStyle(element).backgroundColor), 'rgb(197, 229, 191)');
    assert.equal(await diff.locator('[data-action="revert-current"]').isEnabled(), true);
    await capture("01-idea-layout"); checks.push("默认编辑、无操作模式开关，紧凑工具栏、中央行号、IDEA 差异配色");
    const splitIcon = await diff.locator('.git-revert-glyph').first().evaluate((element) => getComputedStyle(element, '::before').backgroundImage);
    await diff.getByLabel('对比布局', { exact: true }).selectOption({ label: '单栏对比' });
    await until(() => diff.locator('.diff-window.diff-unified').count(), 'unified layout');
    const unified = await diff.evaluate(() => {
      const old = document.querySelector('.diff-version-labels > span:first-child').getBoundingClientRect();
      const next = document.querySelector('.diff-version-labels > span:last-child').getBoundingClientRect();
      const editor = document.querySelector('.editor.modified .monaco-editor');
      return { oldTop: old.top, newTop: next.top, left: old.left === next.left,
        added: getComputedStyle(editor).getPropertyValue('--vscode-diffEditor-insertedLineBackground').trim(),
        removed: getComputedStyle(editor).getPropertyValue('--vscode-diffEditor-removedLineBackground').trim(),
        icon: getComputedStyle(document.querySelector('.git-revert-glyph'), '::before').backgroundImage };
    });
    assert.ok(unified.newTop > unified.oldTop && unified.left, JSON.stringify(unified));
    assert.equal(unified.added, '#e5f4e4');
    assert.ok(['#eee', '#eeeeee'].includes(unified.removed));
    assert.notEqual(unified.icon, splitIcon);
    await capture('01b-idea-unified');
    await diff.getByLabel('对比布局', { exact: true }).selectOption({ label: '双栏对比' });
    checks.push('单栏按 IDEA 显示灰色旧行、浅绿新行、绿色新增文字、上下版本信息；双栏 >> 与单栏回退图标按布局统一');

    const line = diff.locator(".editor.modified .view-line").filter({ hasText: "ADDED" }).first();
    const bounds = await line.boundingBox(), pane = await diff.locator(".editor.modified").boundingBox();
    await diff.mouse.move(bounds.x + 12, bounds.y - 17); await diff.mouse.down();
    await diff.mouse.move(pane.x + pane.width - 90, bounds.y + bounds.height + 20, { steps: 12 }); await diff.mouse.up();
    await until(() => diff.locator(".editor.modified .idea-selected-text").filter({ hasText: "ADDED" }).count(), "selected insertion");
    const selection = await diff.locator(".editor.modified .idea-selected-text").filter({ hasText: "ADDED" }).first().evaluate((element) => getComputedStyle(element).backgroundColor);
    assert.equal(selection, "rgb(166, 210, 255)"); await capture("02-selected-insertion");
    checks.push("真实鼠标拖选新增绿色代码，选中内容显示统一蓝色并保持语法文字可读");

    await diff.locator(".editor.modified .view-lines").click({ position: { x: 180, y: 25 } }); await diff.keyboard.press("Control+End"); await diff.keyboard.insertText("\n// unsaved manual edit");
    await until(async () => (await diff.locator(".diff-statusbar").textContent()).includes("尚未保存"), "default edit");
    assert.equal(await diff.locator('[data-action="revert-current"]').isEnabled(), true);
    const beforeRevert = modified + "\n// unsaved manual edit";
    const afterRevert = beforeRevert.replace('    public static final String ADDED = "login_ip_fail";\n', "");
    await diff.keyboard.press("Control+Home");
    await diff.locator(".git-revert-glyph:not(.git-revert-disabled)").first().click();
    await until(() => read("a.java") === afterRevert, "dirty revert saved"); await settled();
    assert.deepEqual(await app.evaluate(() => globalThis.__diffDialogs), []);
    await hotkey("Control+z", "a.java", beforeRevert); await hotkey("Control+y", "a.java", afterRevert);
    await hotkey("Control+z", "a.java", beforeRevert);
    await unchangedIndex(index); checks.push("未保存编辑时也可直接 Revert，无确认框；Ctrl+Z/Ctrl+Y 撤销重做立即保存且保留其他编辑与 Index");

    await open("b.txt", "local", 1); await diff.locator(".git-revert-glyph:not(.git-revert-disabled)").first().click();
    await until(() => read("b.txt") === "before\n", "last change reverted"); await current("b.txt", 0);
    await hotkey("Control+z", "b.txt", "after\n"); await current("b.txt", 1);
    await hotkey("Control+y", "b.txt", "before\n"); await current("b.txt", 0);
    await hotkey("Control+z", "b.txt", "after\n"); await current("b.txt", 1);
    await diff.locator(".git-revert-glyph:not(.git-revert-disabled)").first().click();
    await diff.keyboard.press("Control+z"); await until(() => read("b.txt") === "after\n", "immediate undo during save"); await settled(); await current("b.txt", 1);
    checks.push("最后一处差异回滚后保留当前文档与撤销栈，文件恢复干净后仍可多次撤销重做");

    await diff.locator('[data-action="next-difference"]').click();
    assert.equal(await diff.locator(".diff-current-path").textContent(), "b.txt");
    assert.match(await diff.locator(".diff-cross-file-hint").textContent(), /再按一次跳到下一个文件/);
    await capture("03-next-file-hint"); await diff.keyboard.press("F7"); await current("c.txt");
    await diff.locator('[data-action="previous-difference"]').click();
    assert.equal(await diff.locator(".diff-current-path").textContent(), "c.txt");
    assert.match(await diff.locator(".diff-cross-file-hint").textContent(), /再按一次跳到上一个文件/);
    await diff.keyboard.press("Shift+F7"); await current("b.txt", 1);
    checks.push("上下跨文件均先给中文提示，再次点击或 F7/Shift+F7 才跳转");

    await open("c.txt", "unstaged", 1); await diff.locator('[data-action="revert-current"]').click();
    await until(() => read("c.txt") === "one\r\nstaged two", "index-side CRLF revert"); await settled();
    await hotkey("Control+z", "c.txt", "one\r\nextra\r\nstaged two");
    await hotkey("Control+y", "c.txt", "one\r\nstaged two"); await unchangedIndex(index);
    checks.push("暂存区对比的 Revert 使用左侧 Index，保留 CRLF 和文件末尾无换行，不改变暂存内容");

    await open("b.txt", "local", 1); write("b.txt", "external edit\n"); await page.bringToFront(); await diff.bringToFront();
    await until(() => diff.locator(".diff-alert").filter({ hasText: "外部变化" }).count(), "external identity guard");
    assert.equal(await diff.locator('[data-action="revert-current"]').isDisabled(), true);
    await diff.keyboard.press("Control+z"); assert.equal(read("b.txt"), "external edit\n");
    checks.push("外部修改使旧快照失效，直接 Revert 和撤销均不会覆盖外部新内容");
    await open("c.txt", "staged", 1);
    assert.equal(await diff.locator('[data-action="revert-current"]').count(), 0);
    const beforeReadOnly = read("c.txt"); await diff.locator(".editor.modified .view-lines").click({ position: { x: 140, y: 15 } }); await diff.keyboard.insertText("must not edit"); await diff.keyboard.press("Control+s");
    assert.equal(read("c.txt"), beforeReadOnly); await unchangedIndex(index);
    await app.evaluate(({ BrowserWindow }) => { const target = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes("Git 对比")); target.unmaximize(); target.setContentSize(1100, 780); });
    await capture("04-staged-readonly"); checks.push("暂存区和版本对比保持只读，工具栏与编辑行为按实际比较来源决定");
    assert.deepEqual(errors, []);
    const result = { passed: true, packaged: !!exe, dir, checks, errors }; fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } catch (error) { console.error(error); if (diff) await capture("failure").catch(() => {}); console.error(JSON.stringify({ dir, checks, errors })); process.exitCode = 1; }
  finally { if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); }
})();

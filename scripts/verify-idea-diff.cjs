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
async function assertRibbonSeams(kind, emptySide, placement) {
  await diff.locator(`.editor.${emptySide} .view-overlays .idea-empty-${kind}.${placement}`).waitFor();
  await diff.getByTitle("刷新（F5）").focus();
  const { runs, color } = await diff.evaluate(({ kind, emptySide, placement }) => {
    const gutter = document.querySelector(".idea-diff-gutter").getBoundingClientRect();
    const fullSide = emptySide === "original" ? "modified" : "original";
    const emptyRule = document.querySelector(`.editor.${emptySide} .view-overlays .idea-empty-${kind}.${placement}`).getBoundingClientRect();
    const filled = document.querySelector(`.editor.${fullSide} .view-overlays .idea-${kind}-line`);
    const filledRow = filled.getBoundingClientRect();
    const ruleY = placement === "before" ? emptyRule.top : emptyRule.bottom - 2;
    const physicalY = y => Math.round(y * devicePixelRatio);
    const first = physicalY(ruleY), end = physicalY(ruleY + 2);
    const seam = (side, y) => {
      const edge = side === "original" ? gutter.left : gutter.right;
      return [Math.floor((edge - 2) * devicePixelRatio), Math.floor((edge + 3) * devicePixelRatio), y];
    };
    return {
      runs: [
        ...Array.from({ length: end - first }, (_, i) => seam(emptySide, first + i)),
        seam(fullSide, physicalY(filledRow.top)), seam(fullSide, physicalY(filledRow.bottom) - 1),
      ],
      color: getComputedStyle(filled).backgroundColor,
    };
  }, { kind, emptySide, placement });
  const screenshot = await diff.screenshot();
  const pixels = await app.evaluate(({ nativeImage }, { screenshot, runs }) => {
    const image = nativeImage.createFromBuffer(Buffer.from(screenshot, "base64"));
    const bitmap = image.toBitmap(), { width } = image.getSize();
    return runs.map(([start, end, y]) => {
      const samples = [];
      for (let x = start; x <= end; x++) {
        const offset = (y * width + x) * 4;
        samples.push(`rgb(${bitmap[offset + 2]}, ${bitmap[offset + 1]}, ${bitmap[offset]})`);
      }
      return samples;
    });
  }, { screenshot: screenshot.toString("base64"), runs });
  assert.ok(pixels.flat().every(pixel => pixel === color),
    `${kind} ribbon must join both panes: expected ${color}, got ${JSON.stringify({ runs, pixels })}`);
}
async function caretAt(text, blink = false, editor = diff.locator(".editor.modified .monaco-editor")) {
  const state = () => editor.evaluate((code, text) => {
    const cursor = code.querySelector(".cursors-layer > .cursor");
    const row = [...code.querySelectorAll(".view-lines > .view-line")].find(line => line.textContent.replace(/\s+/g, " ").includes(text));
    if (!cursor || !row || !code.contains(document.activeElement)) return "elsewhere";
    const caret = cursor.getBoundingClientRect(), line = row.getBoundingClientRect(), pane = code.getBoundingClientRect();
    if (!caret.width || !caret.height || caret.left < pane.left || caret.right > pane.right ||
        caret.top < pane.top || caret.bottom > pane.bottom ||
        caret.top + caret.height / 2 < line.top || caret.top + caret.height / 2 >= line.bottom) return "elsewhere";
    const style = getComputedStyle(cursor);
    return style.visibility === "visible" && Number(style.opacity) > 0 ? "visible" : "hidden";
  }, text);
  await until(async () => await state() === "visible", `caret visible at ${text}`, 4000);
  if (blink) await until(async () => await state() === "hidden", `caret blinking at ${text}`, 4000);
}
(async () => {
  try {
    git("init", "-b", "dev"); git("config", "user.name", "Diff QA"); git("config", "user.email", "diff@example.invalid"); git("config", "core.autocrlf", "false"); git("config", "commit.gpgsign", "false");
    const lines = ["package example;", "", "public class CacheConstants {", "    /** 登录失败次数 */", '    public static final String PASSWORD_ERROR = "password_error";', ""];
    for (let i = 0; i < 35; i++) lines.push(`    // 业务说明 ${i + 1}`);
    lines.push("}", "");
    const original = lines.join("\n");
    const originalBlocks = ["start();", "if (invalid) {", "    report();", "    stop();", "}", "    use();", "}", "finish();",
      "save(items.get(i), now);", "next();", ""].join("\n");
    const newBlocks = ["start();", "if (valid) {", "        use();", "    }", "}", "finish();",
      "Item item = items.get(i);", "String name = item.name;", "if (name == null) {", "    read(item);", "}", "save(item, now);", "next();", ""].join("\n");
    write("a.java", original); write("b.txt", "before\n"); write("c.txt", "one\r\ntwo");
    write("y.java", original); write("z.java", originalBlocks); write("eof.txt", "keep\nlast\nremoved");
    git("add", "."); git("commit", "-m", "base");
    write("c.txt", "one\r\nstaged two"); git("add", "c.txt");
    write("c.txt", "one\r\nextra\r\nstaged two");
    const modified = original.replace("    // 业务说明 1\n", '    public static final String ADDED = "login_ip_fail";\n    // 业务说明 1\n').replace("    // 业务说明 28", "    public static int modified = 28;");
    write("a.java", modified); write("b.txt", "after\n");
    write("y.java", modified); write("z.java", newBlocks);
    const index = fs.readFileSync(path.join(repo, ".git/index"));
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE;
    const exe = process.env.WORKBENCH_GIT_EXE;
    app = await pw._electron.launch({ executablePath: exe || require("electron"), args: [...(exe ? [] : [root]), "--data-dir=" + path.join(dir, "data")], env, timeout: 60000 });
    if (exe) assert.equal(await app.evaluate(({ app }) => app.isPackaged), true);
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
    const geometry = await diff.evaluate(() => {
      const color = selector => getComputedStyle(document.querySelector(selector)).backgroundColor;
      const y = (side, n) => [...document.querySelectorAll(`.idea-${side}-gutter > span`)]
        .find(span => span.textContent === String(n)).getBoundingClientRect().top;
      const ribbon = document.querySelector('.idea-ribbon-added');
      return { added: color('.idea-added-line'), ribbon: getComputedStyle(ribbon).fill,
        path: ribbon.getAttribute('d'), leftStep: y('original', 8) - y('original', 7),
        rightStep: y('modified', 9) - y('modified', 7), placeholders: document.querySelectorAll('.diagonal-fill').length,
        font: document.fonts.check('13px "Workbench JetBrains Mono"') };
    });
    assert.equal(geometry.added, 'rgb(190, 230, 190)');
    assert.equal(geometry.ribbon, geometry.added);
    assert.match(geometry.path, /C/);
    assert.deepEqual([geometry.leftStep, geometry.rightStep, geometry.placeholders, geometry.font], [22, 44, 0, true]);
    await assertRibbonSeams("added", "original", "before");
    assert.equal(await diff.locator('[data-action="revert-current"]').isEnabled(), true);
    await capture("01-idea-layout"); checks.push("默认编辑、无操作模式开关，紧凑工具栏、中央行号、IDEA 差异配色");
    const previous = diff.locator('[data-action="previous-difference"]'), next = diff.locator('[data-action="next-difference"]');
    await next.click();
    await caretAt("public static int modified");
    await previous.click();
    await caretAt("String ADDED", true);
    await diff.keyboard.press("F7");
    await caretAt("public static int modified");
    await diff.keyboard.press("Shift+F7");
    await caretAt("String ADDED");
    checks.push("双栏用按钮和 F7 前后跳转时，实际输入光标移动到对应差异行并闪烁");
    const splitIcon = await diff.locator('.git-revert-glyph').first().evaluate((element) => getComputedStyle(element, '::before').backgroundImage);
    await diff.getByLabel('对比布局', { exact: true }).selectOption({ label: '单栏对比' });
    await until(() => diff.locator('.diff-window.diff-unified').count(), 'unified layout');
    await diff.locator('.diff-unified .git-revert-glyph').first().waitFor();
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
    await next.click();
    await caretAt("public static int modified");
    await previous.click();
    await caretAt("String ADDED");
    await diff.getByLabel('对比布局', { exact: true }).selectOption({ label: '双栏对比' });
    await diff.locator('.idea-gutter-actions .git-revert-glyph').first().waitFor();
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
    await caretAt("extra");
    await diff.locator('[data-action="previous-difference"]').click();
    assert.equal(await diff.locator(".diff-current-path").textContent(), "c.txt");
    assert.match(await diff.locator(".diff-cross-file-hint").textContent(), /再按一次跳到上一个文件/);
    await diff.keyboard.press("Shift+F7"); await current("b.txt", 1);
    await caretAt("after");
    checks.push("跨文件继续导航时，光标落到目标文件的第一处或最后一处差异");

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
    await app.evaluate(({ BrowserWindow }) => { const target = BrowserWindow.getAllWindows().find((w) => w.getTitle().includes("Git 对比")); target.unmaximize(); target.setContentSize(1101, 780); });
    await capture("04-staged-readonly"); checks.push("暂存区和版本对比保持只读，工具栏与编辑行为按实际比较来源决定");
    await open("z.java", "local", 3);
    await diff.locator(".idea-gutter-actions button").last().waitFor();
    const blocks = await diff.locator(".idea-diff-gutter path").evaluateAll(nodes =>
      nodes.map(node => {
        const box = node.getBBox(), heightAt = x => {
          let height = 0;
          for (let y = Math.floor(box.y); y < box.y + box.height; y++)
            if (node.isPointInFill(new DOMPoint(x, y + 0.5))) height++;
          return height;
        };
        return [node.getAttribute("class"), heightAt(2), heightAt(box.width - 2)];
      }));
    assert.deepEqual(blocks, [["idea-ribbon-changed", 88, 22], ["idea-ribbon-added", 2, 22], ["idea-ribbon-changed", 22, 132]]);
    const changeButtons = diff.locator(".idea-gutter-actions .git-revert-glyph");
    const actionAppearance = () => changeButtons.evaluateAll(buttons =>
      buttons.map(button => ({
        icon: getComputedStyle(button, "::before").backgroundImage,
        title: button.title,
      })),
    );
    const normal = await actionAppearance();
    assert.equal(new Set(normal.map(item => item.icon)).size, 1);
    assert.ok(normal.every(item => item.title.startsWith("Revert")));
    await diff.keyboard.down("Control");
    try {
      const pressing = await actionAppearance();
      assert.equal(pressing[0].icon, pressing[2].icon);
      assert.notEqual(pressing[0].icon, normal[0].icon);
      assert.match(pressing[0].title, /^追加第 1 处/);
      assert.deepEqual(pressing[1], normal[1]);
      await capture("05-append-arrow");
    } finally {
      await diff.keyboard.up("Control");
    }
    assert.deepEqual(await actionAppearance(), normal);
    const appended = newBlocks.replace("save(item, now);\nnext();", "save(item, now);\nsave(items.get(i), now);\nnext();");
    await changeButtons.last().click({ modifiers: ["Control"] });
    await until(() => read("z.java") === appended, "Ctrl-click appends the original lines");
    await settled();
    await hotkey("Control+z", "z.java", newBlocks);
    await current("z.java", 3);
    await hotkey("Control+y", "z.java", appended);
    await hotkey("Control+z", "z.java", newBlocks);
    await current("z.java", 3);
    await unchangedIndex(index);
    checks.push("双栏直箭头执行回退，按 Ctrl 仅修改块切换为追加图标，Ctrl+点击追加对应左侧代码并可撤销重做");
    await changeButtons.last().click();
    await until(() => read("z.java").endsWith("finish();\nsave(items.get(i), now);\nnext();\n"), "one-to-six hunk reverted");
    assert.ok(read("z.java").includes("if (valid)"));
    await hotkey("Control+z", "z.java", newBlocks);
    await unchangedIndex(index);
    checks.push("四行对应一行、一行对应六行及单侧空范围均按实际行高连线，回退和撤销作用于对应范围");
    write("eof.txt", "keep\nlast");
    await open("eof.txt", "local", 1);
    await assertRibbonSeams("deleted", "modified", "after");
    checks.push("截图逐像素验证新增行和文件末尾删除线在两侧栏缝连续");
    await open("y.java", "local", 2);
    const include = diff.getByRole("checkbox", { name: "纳入提交 · 第 1 处差异", exact: true });
    await until(() => include.isEnabled(), "independent patch available");
    await include.click();
    await until(() => git("show", ":y.java").includes("String ADDED"), "selected insertion staged");
    assert.ok(!git("show", ":y.java").includes("int modified = 28"));
    assert.equal(read("y.java"), modified);
    const exclude = diff.getByRole("checkbox", { name: "移出提交 · 第 1 处差异", exact: true });
    await until(() => exclude.isEnabled(), "staged patch available");
    assert.ok(await exclude.isChecked());
    await exclude.click();
    await until(() => git("diff", "--cached", "--", "y.java") === "", "only chosen block unstaged");
    assert.equal(read("y.java"), modified);
    await settled();
    checks.push("中央勾选框按 Git 暂存状态显示，单独纳入和移出一处修改，工作区与相邻差异保留");
    git("add", "--", "z.java");
    await open("z.java", "staged", 3);
    await diff.emulateMedia({ reducedMotion: "no-preference" });
    await next.click();
    await next.click();
    await caretAt("Item item =", true);
    await diff.emulateMedia({ reducedMotion: "reduce" });
    await caretAt("Item item =");
    assert.equal(await diff.locator(".editor.modified .cursors-layer > .cursor").evaluate(cursor => getComputedStyle(cursor).animationName), "none");
    checks.push("只读暂存区对比跳转也显示光标，使用减少动态效果时显示稳定的定位光标");
    await page.bringToFront();
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "Git 管理", exact: true }).click();
    await page.getByRole("button", { name: "一键提测", exact: true }).click();
    const submit = page.getByRole("dialog", { name: "一键提测" });
    await submit.locator(".file-item").filter({ hasText: "y.java" }).click();
    const submitCode = submit.locator(".editor.modified .monaco-editor");
    const submitNext = submit.getByRole("button", { name: "下一个差异" });
    await submitNext.click();
    await caretAt("String ADDED", false, submitCode);
    await submitNext.click();
    await caretAt("public static int modified", false, submitCode);
    await submit.getByRole("button", { name: "上一个差异" }).click();
    await caretAt("String ADDED", false, submitCode);
    checks.push("提测预览前后跳转也将光标移到对应的差异行");
    assert.deepEqual(errors, []);
    const result = { passed: true, packaged: !!exe, dir, checks, errors }; fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
  } catch (error) { console.error(error); if (diff) await capture("failure").catch(() => {}); console.error(JSON.stringify({ dir, checks, errors })); process.exitCode = 1; }
  finally { if (app) await app.evaluate(({ app }) => app.exit(0)).catch(() => {}); }
})();

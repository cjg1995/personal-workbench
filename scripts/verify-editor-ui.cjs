const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"); }
const { _electron } = playwright;
const root = path.resolve(__dirname, "..");
const fixture = path.join(root, ".local", "editor-ui-project-" + Date.now());
const dataDir = path.join(root, ".local", "editor-ui-data-" + Date.now());
fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
fs.writeFileSync(path.join(fixture, "src", "Alpha.java"), "package sample;\r\nclass Alpha { int marker = 7; }\r\n");
fs.writeFileSync(path.join(fixture, "src", "Beta.java"), "package sample;\nclass Beta { Alpha value; }\n");
const alphaFile = path.join(fixture, "src", "Alpha.java");
const betaFile = path.join(fixture, "src", "Beta.java");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let application;
const errors = [];
async function api(page, name, payload) {
  const result = await page.evaluate(async ({ name, payload }) => window.workbench.call(name, payload), { name, payload });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
async function until(fn, label, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}`);
}
(async () => {
  try {
    application = await _electron.launch({ executablePath: require("electron"), args: [root, `--data-dir=${dataDir}`], env, timeout: 30000 });
    const main = await application.firstWindow();
    main.on("pageerror", (error) => errors.push(error.message));
    await main.waitForSelector('[data-page="work"]');
    const bootstrap = await api(main, "bootstrap");
    const config = bootstrap.config;
    config.projects.find((project) => project.id === "refsys-ui").path = fixture;
    await api(main, "settings.save", config);
    await api(main, "projects.editor", { projectId: "refsys-ui" });
    await until(async () => (await application.windows()).length === 2, "editor window");
    const editor = (await application.windows()).find((page) => page !== main);
    editor.on("pageerror", (error) => errors.push(error.message));
    await editor.waitForSelector(".editor-tree-row");
    assert.match(await editor.title(), /代码编辑器/);
    await editor.locator('.editor-tree-row[data-file="src"]').click();
    await editor.locator('.editor-tree-row[data-file="src/Alpha.java"]').click();
    await until(async () => await editor.locator(".editor-tab").count() === 1, "first tab");
    await editor.locator(".editor-tab.active").waitFor();
    await editor.locator(".monaco-editor .view-line").first().click();
    await editor.keyboard.press("Control+End");
    await editor.keyboard.type("// edited in Workbench");
    assert.equal(await editor.locator(".editor-dirty").count(), 1);
    await editor.keyboard.press("Control+s");
    await until(() => fs.readFileSync(path.join(fixture, "src", "Alpha.java"), "utf8").includes("edited in Workbench"), "save");
    await editor.keyboard.press("Control+z");
    assert.equal(await editor.locator(".editor-dirty").count(), 1);
    await editor.keyboard.press("Control+y");
    await editor.keyboard.press("Control+s");
    await editor.keyboard.press("Control+Shift+r");
    await editor.locator(".editor-palette input").fill("Beta");
    await editor.locator(".editor-palette-list button").first().waitFor();
    await editor.keyboard.press("Enter");
    await until(async () => await editor.locator(".editor-tab").count() === 2, "second tab");
    await editor.keyboard.press("Control+Shift+f");
    await editor.locator(".editor-search-bar input").fill("marker");
    await editor.locator(".editor-search-bar input").dispatchEvent("input");
    await editor.locator(".editor-search-hit").first().waitFor({ timeout: 10000 });
    await editor.locator(".editor-search-hit").first().click();
    assert.equal(await editor.locator(".editor-tab.active .editor-tab-name").textContent(), "Alpha.java");
    await editor.keyboard.press("Alt+ArrowLeft");
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "Beta.java", "jump history");
    await editor.locator(".editor-tab").filter({ hasText: "Alpha.java" }).click();
    await editor.locator(".monaco-editor .view-line").first().click();
    await editor.keyboard.press("Control+End");
    await editor.keyboard.type("// pending conflict");
    assert.equal(await editor.locator(".editor-dirty").count(), 1);
    fs.writeFileSync(path.join(fixture, "src", "Alpha.java"), "external edit\r\n");
    await editor.keyboard.press("Control+s");
    const conflictDialog = editor.getByRole("alertdialog", { name: "文件已变化" });
    await conflictDialog.getByRole("button", { name: "取消", exact: true }).click();
    await editor.locator(".editor-stale").waitFor();
    assert.equal(fs.readFileSync(path.join(fixture, "src", "Alpha.java"), "utf8"), "external edit\r\n");
    await editor.keyboard.press("Control+s");
    await conflictDialog.getByRole("button", { name: "覆盖外部修改", exact: true }).click();
    await until(() => fs.readFileSync(path.join(fixture, "src", "Alpha.java"), "utf8").includes("pending conflict"), "explicit overwrite");
    await editor.locator(".editor-tab").filter({ hasText: "Beta.java" }).click();
    await editor.locator(".monaco-editor .view-line").first().click();
    await editor.keyboard.press("Control+End");
    await editor.keyboard.type("// unsaved");
    // 自动保存：不再弹出保存确认框，关闭标签前内容已落盘
    await until(() => fs.readFileSync(betaFile, "utf8").includes("// unsaved"), "auto save before close");
    await editor.locator(".editor-tab.active .close-button").click();
    await until(async () => await editor.locator(".editor-tab").count() === 1, "close auto-saved tab");
    await editor.locator(".monaco-editor .view-line").first().click();
    await editor.keyboard.press("Control+End");
    await editor.keyboard.type("// exit guard");
    await until(() => fs.readFileSync(alphaFile, "utf8").includes("// exit guard"), "auto save before exit");
    // 自动保存后关闭窗口不再需要保存确认：直接核验窗口仍可用且内容已落盘
    assert.equal((await application.windows()).length, 2);
    assert.equal(await editor.locator(".editor-dirty").count(), 0);
    assert.equal(await editor.locator(".editor-header-actions button").count(), 2);
    await editor.screenshot({ path: path.join(root, ".local", "editor-ui.png") });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ tabs: await editor.locator(".editor-tab").count(), searchHits: await editor.locator(".editor-search-hit").count(), screenshot: ".local/editor-ui.png" }));
  } finally {
    if (application) await application.evaluate(({ app }) => app.exit(0));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

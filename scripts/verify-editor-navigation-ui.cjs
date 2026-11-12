const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"); }
const { _electron } = playwright;
const root = path.resolve(__dirname, "..");
const fixtures = path.join(root, ".local", "editor-language-tests");
const fixture = fs.readdirSync(fixtures).map((name) => path.join(fixtures, name))
  .filter((directory) => fs.existsSync(path.join(directory, "pom.xml")))
  .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
assert(fixture, "Run verify-editor-language.cjs first");
const dataDir = path.join(root, ".local", "editor-navigation-ui-data-" + Date.now());
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let application;
let restoreFirst;
const errors = [];
async function api(page, name, payload) {
  const result = await page.evaluate(async ({ name, payload }) => window.workbench.call(name, payload), { name, payload });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
async function until(fn, label, count = 120) {
  for (let i = 0; i < count; i++) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`Timed out: ${label}`);
}
async function openFile(editor, query) {
  await editor.keyboard.press("Control+Shift+r");
  await editor.locator(".editor-palette input").fill(query);
  await editor.locator(".editor-palette-list button").first().waitFor({ timeout: 10000 });
  await editor.keyboard.press("Enter");
  await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === query, `open ${query}`);
}
async function caret(editor, line, column) {
  await editor.locator(".monaco-editor .view-line").first().click();
  await editor.keyboard.press("Control+Home");
  for (let i = 1; i < line; i++) await editor.keyboard.press("ArrowDown");
  const read = async () => {
    const value = await editor.locator(".editor-statusbar span:last-child").textContent();
    const match = /^(\d+):(\d+)/.exec(value);
    return match ? { line: Number(match[1]), column: Number(match[2]) } : null;
  };
  let actual = await read();
  assert.equal(actual?.line, line);
  while (actual.column < column) { await editor.keyboard.press("ArrowRight"); actual = await read(); }
  while (actual.column > column) { await editor.keyboard.press("ArrowLeft"); actual = await read(); }
}
async function clickSymbol(page, line, symbol, modifiers) {
  const point = await page.locator(".monaco-editor .view-line").nth(line - 1).evaluate((element, name) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node, text = "";
    while ((node = walker.nextNode())) { nodes.push({ node, start: text.length, end: text.length + node.textContent.length }); text += node.textContent; }
    const index = text.indexOf(name);
    if (index < 0) return null;
    const start = nodes.find((item) => item.start <= index && item.end > index);
    const end = nodes.find((item) => item.start < index + name.length && item.end >= index + name.length);
    if (!start || !end) return null;
    const range = document.createRange();
    range.setStart(start.node, index - start.start);
    range.setEnd(end.node, index + name.length - end.start);
    const box = range.getBoundingClientRect();
    return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  }, symbol);
  assert(point, `symbol ${symbol} not visible`);
  for (const modifier of modifiers) await page.keyboard.down(modifier);
  try { await page.mouse.click(point.x, point.y); }
  finally { for (const modifier of modifiers.reverse()) await page.keyboard.up(modifier); }
}
(async () => {
  try {
    const installed = process.env.PWB_TEST_EXE;
    application = await _electron.launch({ executablePath: installed || require("electron"),
      args: installed ? [`--data-dir=${dataDir}`] : [root, `--data-dir=${dataDir}`], env, timeout: 30000 });
    const main = await application.firstWindow();
    main.on("pageerror", (error) => errors.push(error.message));
    await main.waitForSelector('[data-page="work"]');
    const bootstrap = await api(main, "bootstrap");
    if (installed) assert.equal(bootstrap.version, require(path.join(root, "package.json")).version);
    const config = bootstrap.config;
    config.projects.find((project) => project.id === "homeproject").path = fixture;
    await api(main, "settings.save", config);
    await api(main, "projects.editor", { projectId: "homeproject" });
    await until(async () => (await application.windows()).length === 2, "Java editor window", 40);
    const editor = (await application.windows()).find((page) => page !== main);
    editor.on("pageerror", (error) => errors.push(error.message));
    await editor.waitForSelector(".editor-tree-row");
    await until(async () => (await editor.locator(".editor-statusbar").textContent()).includes("Java 已就绪"), "Java indexing", 240);
    await openFile(editor, "Caller.java");
    await caret(editor, 6, 18);
    await editor.keyboard.press("Control+b");
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "Gateway.java", "cross-module Ctrl+B");
    assert.match(await editor.locator(".editor-statusbar span:last-child").textContent(), /^3:/);
    await editor.keyboard.press("Alt+ArrowLeft");
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "Caller.java", "history back");
    await editor.locator(".editor-tab").filter({ hasText: "Gateway.java" }).click();
    await caret(editor, 3, 14);
    await editor.keyboard.press("Control+Alt+b");
    await editor.locator(".editor-palette-list button").first().waitFor({ timeout: 20000 });
    assert.equal(await editor.locator(".editor-palette-list button").count(), 2);
    await editor.keyboard.press("ArrowDown");
    await editor.keyboard.press("Enter");
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "SecondGateway.java", "choose implementation");
    await editor.keyboard.press("Control+u");
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "Gateway.java", "super method");
    await caret(editor, 3, 14);
    await editor.keyboard.press("Alt+F7");
    await editor.locator(".editor-palette-list button").first().waitFor({ timeout: 20000 });
    assert.equal(await editor.locator(".editor-palette-list button").count(), 2);
    assert((await editor.locator(".editor-palette-list").textContent()).includes("Caller.java"));
    await editor.keyboard.press("Escape");
    await caret(editor, 3, 7);
    await editor.keyboard.press("Control+b");
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "String.java", "JDK virtual source");
    assert((await editor.locator(".monaco-editor .view-lines").textContent()).includes("String"));
    await editor.keyboard.press("Alt+ArrowLeft");
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "Gateway.java", "return from library");
    await clickSymbol(editor, 3, "send", ["Control", "Shift"]);
    await editor.locator(".editor-palette-list button").first().waitFor({ timeout: 20000 });
    assert.equal(await editor.locator(".editor-palette-list button").count(), 2);
    await editor.keyboard.press("Escape");
    await editor.locator(".editor-tab").filter({ hasText: "Caller.java" }).click();
    await clickSymbol(editor, 6, "send", ["Control"]);
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "Gateway.java", "Ctrl+Click definition");
    const firstFile = path.join(fixture, "impl/src/main/java/sample/impl/FirstGateway.java");
    const firstText = fs.readFileSync(firstFile, "utf8");
    restoreFirst = () => fs.writeFileSync(firstFile, firstText);
    fs.writeFileSync(firstFile, "package sample.impl;\npublic class FirstGateway extends Base {}\n");
    await until(async () => {
      const result = await api(editor, "editor.lsp-request", {
        kind: "implementation", file: "api/src/main/java/sample/api/Gateway.java", line: 3, column: 14,
      });
      return Array.isArray(result) && result.length === 1;
    }, "external change in closed Java file");
    restoreFirst();
    restoreFirst = undefined;
    await editor.screenshot({ path: path.join(root, ".local", "editor-navigation-ui.png") });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, fixture: path.basename(fixture), screenshot: ".local/editor-navigation-ui.png" }));
  } finally {
    restoreFirst?.();
    if (application) await application.evaluate(({ app }) => app.exit(0));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

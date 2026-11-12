const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"); }
const { _electron } = playwright;
const root = path.resolve(__dirname, "..");
const fixture = path.join(root, ".local", "editor-ts-project-" + Date.now());
fs.mkdirSync(path.join(fixture, "src"), { recursive: true });
fs.writeFileSync(path.join(fixture, "tsconfig.json"), '{"compilerOptions":{"target":"ES2020","module":"ESNext"}}');
fs.writeFileSync(path.join(fixture, "src", "models.ts"), 'export interface User { name: string; }\nexport function makeUser(name: string): User { return { name }; }\n');
fs.writeFileSync(path.join(fixture, "src", "main.ts"), 'import { makeUser, User } from "./models";\nconst user: User = makeUser("x");\nconsole.log(user.name);\n');
const dataDir = path.join(root, ".local", "editor-ts-ui-data-" + Date.now());
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
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out: ${label}`);
}
async function openFile(page, name) {
  await page.keyboard.press("Control+Shift+r");
  await page.locator(".editor-palette input").fill(name);
  await page.locator(".editor-palette-list button").first().waitFor();
  await page.keyboard.press("Enter");
  await until(async () => (await page.locator(".editor-tab.active .editor-tab-name").textContent()) === name, `open ${name}`);
}
async function caret(page, line, column) {
  await page.locator(".monaco-editor .view-line").first().click();
  await page.keyboard.press("Control+Home");
  for (let i = 1; i < line; i++) await page.keyboard.press("ArrowDown");
  const current = async () => Number((await page.locator(".editor-statusbar span:last-child").textContent()).match(/^\d+:(\d+)/)?.[1]);
  let actual = await current();
  while (actual < column) { await page.keyboard.press("ArrowRight"); actual = await current(); }
  while (actual > column) { await page.keyboard.press("ArrowLeft"); actual = await current(); }
}
(async () => {
  try {
    application = await _electron.launch({ executablePath: require("electron"), args: [root, `--data-dir=${dataDir}`], env, timeout: 30000 });
    const main = await application.firstWindow();
    main.on("pageerror", (error) => errors.push(error.message));
    await main.waitForSelector('[data-page="work"]');
    const config = (await api(main, "bootstrap")).config;
    config.projects.find((project) => project.id === "refsys-ui").path = fixture;
    await api(main, "settings.save", config);
    await api(main, "projects.editor", { projectId: "refsys-ui" });
    await until(async () => (await application.windows()).length === 2, "TS editor");
    const page = (await application.windows()).find((window) => window !== main);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForSelector(".editor-tree-row");
    await until(async () => (await page.locator(".editor-statusbar").textContent()).includes("TS/JS 已索引 2 个文件"), "TS index");
    await openFile(page, "main.ts");
    await caret(page, 2, 21);
    await page.keyboard.press("Control+b");
    await until(async () => (await page.locator(".editor-tab.active .editor-tab-name").textContent()) === "models.ts", "TS cross-file definition");
    assert.match(await page.locator(".editor-statusbar span:last-child").textContent(), /^2:/);
    await page.keyboard.press("Alt+ArrowLeft");
    await until(async () => (await page.locator(".editor-tab.active .editor-tab-name").textContent()) === "main.ts", "TS history");
    await page.screenshot({ path: path.join(root, ".local", "editor-ts-ui.png") });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, screenshot: ".local/editor-ts-ui.png" }));
  } finally {
    if (application) await application.evaluate(({ app }) => app.exit(0));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

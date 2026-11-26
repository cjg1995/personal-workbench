const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"); }

const root = path.resolve(__dirname, "..");
const fixture = fs.mkdtempSync(path.join(root, ".local", "java-editing-ui-"));
const project = path.join(fixture, "project");
const source = path.join(project, "src/main/java/sample/ShortcutFixture.java");
fs.mkdirSync(path.dirname(source), { recursive: true });
fs.writeFileSync(path.join(project, "pom.xml"), '<project xmlns="http://maven.apache.org/POM/4.0.0"><modelVersion>4.0.0</modelVersion><groupId>sample</groupId><artifactId>shortcuts</artifactId><version>1</version><properties><maven.compiler.source>1.8</maven.compiler.source><maven.compiler.target>1.8</maven.compiler.target></properties></project>');
fs.writeFileSync(source, [
  "package sample;",
  "public class ShortcutFixture {",
  "    void clear() {}",
  "    String formatName(String name, int count) { return name + count; }",
  "    String formatName(int count) { return String.valueOf(count); }",
  "    void check(String input) {",
  "        // normal-completion",
  "        // existing-parentheses",
  "        // parameter-completion",
  "        // stdout-template",
  "        // if-block",
  "    }",
  "    // method-body",
  "}",
  "",
].join("\n"));

async function api(page, name, payload) {
  const result = await page.evaluate(({ name, payload }) => window.workbench.call(name, payload), { name, payload });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

(async () => {
  const installed = process.env.PWB_TEST_EXE;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const data = "--data-dir=" + path.join(fixture, "data");
  const app = await playwright._electron.launch({ executablePath: installed || require("electron"),
    args: installed ? [data] : [root, data], env, timeout: 60000 });
  let code;
  try {
    const main = await app.firstWindow();
    await main.waitForSelector('[data-page="work"]');
    const { config, version } = await api(main, "bootstrap");
    assert.equal(version, require("../package.json").version);
    config.projects.find((item) => item.id === "homeproject").path = project;
    await api(main, "settings.save", config);
    const opening = app.waitForEvent("window");
    await api(main, "projects.editor", { projectId: "homeproject" });
    code = await opening;
    const errors = [];
    code.on("pageerror", (error) => errors.push(error.message));
    await code.locator(".editor-statusbar").getByText("Java 已就绪", { exact: true }).waitFor({ timeout: 120000 });
    await code.keyboard.press("Control+Shift+r");
    await code.locator(".editor-palette input").fill("ShortcutFixture.java");
    await code.locator(".editor-palette-list button").first().waitFor();
    await code.keyboard.press("Enter");
    const selectedFile = code.locator('.editor-tree-row.active[data-file="src/main/java/sample/ShortcutFixture.java"]');
    await selectedFile.waitFor();
    const selectionStyle = await selectedFile.evaluate((element) => {
      const { backgroundColor, borderLeftWidth, boxShadow } = getComputedStyle(element);
      return { backgroundColor, borderLeftWidth, boxShadow };
    });
    assert.notEqual(selectionStyle.backgroundColor, "rgba(0, 0, 0, 0)");
    assert.equal(selectionStyle.borderLeftWidth, "0px");
    assert.equal(selectionStyle.boxShadow, "none");

    const lines = code.locator(".monaco-editor .view-line");
    const line = (text) => lines.filter({ hasText: text });
    async function replace(anchor, text) {
      await line("// " + anchor).click();
      await code.keyboard.press("Home");
      await code.keyboard.press("Shift+End");
      await code.keyboard.insertText(text);
      await line(text).waitFor();
    }
    async function suggest(label) {
      await code.keyboard.press("Control+Space");
      const item = code.locator(".suggest-widget .monaco-list-row").filter({ hasText: label }).first();
      await item.waitFor({ timeout: 20000 });
      return item;
    }
    const params = code.locator(".editor-parameter-hints");
    const signatures = params.locator(".editor-parameter-signature");

    await replace("normal-completion", "this.cl");
    await suggest(/clear\(\)/);
    await code.keyboard.press("Enter");
    await line("this.clear();").first().waitFor();
    console.log("Java method completion includes ()");

    await replace("existing-parentheses", "this.cl();");
    await code.keyboard.press("ArrowLeft");
    await code.keyboard.press("ArrowLeft");
    await code.keyboard.press("ArrowLeft");
    await suggest(/clear\(\)/);
    await code.keyboard.press("Enter");
    await line("this.cl();").waitFor({ state: "detached", timeout: 8000 });
    assert.equal(await line(/^\s*this\.clear\(\);\s*$/).count(), 2);

    await replace("parameter-completion", "String value = this.form");
    await (await suggest(/formatName\(String name, int count\)/)).click();
    await line("String value = this.formatName(name, count)").waitFor();
    await params.waitFor();
    await code.keyboard.insertText("input");
    await code.keyboard.press("Tab");
    await code.keyboard.insertText("7");
    await line("String value = this.formatName(input, 7)").waitFor();
    await code.keyboard.press("Escape");
    await code.keyboard.press("Escape");
    await params.waitFor({ state: "hidden" });
    await code.keyboard.press("Control+p");
    await signatures.filter({ hasText: /formatName\(String name, int count\)/ }).waitFor();
    await signatures.filter({ hasText: /formatName\(int count\)/ }).waitFor();
    assert.equal(await signatures.count(), 2);
    const currentParameter = params.locator("[aria-current='true'] .editor-parameter-current");
    await currentParameter.filter({ hasText: /^int count$/ }).waitFor();
    assert.match(await params.locator("[aria-current='true']").textContent(), /formatName\(String name, int count\)/);
    assert.equal(await code.locator(".parameter-hints-widget .overloads").count(), 0);
    assert.match((await code.locator(".monaco-alert").allTextContents()).join(" "), /int count，参数提示/);
    await code.screenshot({ path: path.join(fixture, "parameter-hints.png") });
    await code.keyboard.press("Escape");
    await params.waitFor({ state: "hidden" });
    console.log("Ctrl+P shows both Java overloads together and highlights the current parameter");

    await code.keyboard.press("Control+Shift+Enter");
    await line("String value = this.formatName(input, 7);").waitFor();
    await replace("stdout-template", "sout");
    await code.keyboard.press("Tab");
    await line("System.out.println();").waitFor();
    await code.keyboard.insertText("input");
    await line("System.out.println(input);").waitFor();
    console.log("Tab expands sout with the caret inside parentheses");

    await replace("if-block", "if (true)");
    await code.keyboard.press("Control+Shift+Enter");
    await line("if (true) {").waitFor();
    await code.keyboard.insertText("clear();");
    await replace("method-body", "void completed(");
    await code.keyboard.press("Control+Shift+Enter");
    await line("void completed() {").waitFor();
    await code.keyboard.insertText("clear();");
    await code.keyboard.press("Control+s");
    for (let attempts = 0; attempts < 60 && !fs.readFileSync(source, "utf8").includes("void completed() {\n        clear();"); attempts++)
      await new Promise((resolve) => setTimeout(resolve, 100));
    const text = fs.readFileSync(source, "utf8").replaceAll("\r\n", "\n");
    assert.match(text, /if \(true\) \{\n {12}clear\(\);\n {8}\}/);
    assert.match(text, /void completed\(\) \{\n {8}clear\(\);\n {4}\}/);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ version, installed: !!installed, verified: ["file-tree selection", "method brackets", "existing brackets", "parameter hints",
      "sout", "statement terminator", "control block", "method body"] }));
  } catch (error) {
    if (code) console.error(await code.locator(".monaco-editor .view-lines").first().innerText().catch(() => ""));
    throw error;
  } finally {
    await app.evaluate(({ app }) => app.exit(0));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const { zipSync } = require("fflate");
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"); }

const root = path.resolve(__dirname, "..");
const local = path.join(root, ".local");
fs.mkdirSync(local, { recursive: true });
const output = fs.mkdtempSync(path.join(local, "editor-idea-java-"));
const project = path.join(output, "project");
const write = (file, value) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
};
const save = (name, text) => write(path.join(project, name), text);
const classpath = '<classpath><classpathentry kind="src" path="src"/><classpathentry kind="lib" path="lib/old.jar"/><classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/><classpathentry kind="output" path="bin"/></classpath>';
save(".classpath", classpath);
save(".project", "<projectDescription><name>legacy</name><natures><nature>org.eclipse.jdt.core.javanature</nature></natures></projectDescription>");
save(".idea/modules.xml", '<project><component name="ProjectModuleManager"><modules><module filepath="$PROJECT_DIR$/Demo.iml"/></modules></component></project>');
save("Demo.iml", '<module type="JAVA_MODULE"><component name="NewModuleRootManager" LANGUAGE_LEVEL="JDK_1_8"><content url="file://$MODULE_DIR$"><sourceFolder url="file://$MODULE_DIR$/src"/><sourceFolder url="file://$MODULE_DIR$/check" isTestSource="true"/></content><orderEntry type="library" name="deps" level="project"/></component></module>');
save(".idea/libraries/deps.xml", '<component name="libraryTable"><library name="deps"><CLASSES><root url="file://$PROJECT_DIR$/lib"/></CLASSES><jarDirectory url="file://$PROJECT_DIR$/lib" recursive="false"/></library></component>');
save("src/sample/Example.java", [
  "package sample;",
  "import fixtures.Dependency;",
  '@SuppressWarnings("serial")',
  "public class Example {",
  "    java.util.List<String> use() {",
  "        return Dependency.values();",
  "    }",
  "    int check(String input) {",
  "        if (input == null) return input.length();",
  "        return 0;",
  "    }",
  "}",
  "",
].join("\n"));
save("src/sample/Contract.java", "package sample;\npublic interface Contract {}\n");
save("src/sample/State.java", "package sample;\npublic enum State { READY }\n");
save("src/sample/Settings.java", "package sample;\npublic @interface Settings {}\n");
save("src/sample/AbstractWorker.java", "package sample;\npublic abstract class AbstractWorker {}\n");
save("check/sample/TestExample.java", "package sample;\nclass TestExample {}\n");
for (const name of ["editor.html", "log4j.properties", "plugins.xml", "stencilset.json", "sample.ttf"]) save(name, "");

const runtime = path.join(root, ".local", "editor-runtime");
const plugins = path.join(runtime, "jdtls", "plugins");
const compiler = fs.readdirSync(plugins).find((name) => /^org\.eclipse\.jdt\.core\.compiler\.batch_.*\.jar$/.test(name));
assert(compiler, "Packaged Eclipse compiler is required");
const dependency = path.join(output, "Dependency.java");
const classes = path.join(output, "classes");
write(dependency, "package fixtures; public class Dependency { public static java.util.List values() { return null; } }");
const compile = spawnSync(path.join(runtime, "jre", "bin", "java.exe"), [
  "-jar", path.join(plugins, compiler), "-proc:none", "-source", "8", "-target", "8", "-d", classes, dependency,
], { encoding: "utf8", windowsHide: true });
assert.equal(compile.status, 0, compile.stderr || compile.error?.message);
save("lib/dependency.jar", zipSync({ "fixtures/Dependency.class": fs.readFileSync(path.join(classes, "fixtures/Dependency.class")) }));

async function api(page, name, payload) {
  const result = await page.evaluate(({ name, payload }) => window.workbench.call(name, payload), { name, payload });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

(async () => {
  const installed = process.env.PWB_TEST_EXE;
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const data = "--data-dir=" + path.join(output, "data");
  const app = await playwright._electron.launch({ executablePath: installed || require("electron"),
    args: installed ? [data] : [root, data], env, timeout: 100000 });
  try {
    const main = await app.firstWindow();
    await main.waitForSelector('[data-page="work"]', { timeout: 60000 });
    const { config, version } = await api(main, "bootstrap");
    assert.equal(version, require("../package.json").version);
    config.projects.find((entry) => entry.id === "homeproject").path = project;
    await api(main, "settings.save", config);
    const opening = app.waitForEvent("window");
    await api(main, "projects.editor", { projectId: "homeproject" });
    const code = await opening;
    await code.locator(".editor-statusbar").getByText("Java 已就绪", { exact: true }).waitFor({ timeout: 120000 });
    await code.evaluate(() => {
      window.probeJavaDiagnostics = [];
      window.workbench.onEditorLsp((method, payload) => {
        if (method === "diagnostics" && payload.uri.endsWith("/Example.java"))
          window.probeJavaDiagnostics = payload.diagnostics;
      });
    });
    const row = (file) => code.locator('.editor-tree-row[data-file="' + file + '"]');
    await row("src").click();
    await row("src/sample").click();
    await row("src/sample/Example.java").click();
    const assigned = {
      src: "nodes/sourceRoot", check: "nodes/testRoot", "src/sample": "nodes/package", lib: "nodes/libraryFolder",
      "src/sample/Example.java": "nodes/class", "src/sample/Contract.java": "nodes/interface",
      "src/sample/State.java": "nodes/enum", "src/sample/Settings.java": "nodes/annotation",
      "src/sample/AbstractWorker.java": "nodes/classAbstract",
      "editor.html": "fileTypes/html", "log4j.properties": "fileTypes/properties", "plugins.xml": "fileTypes/xml",
      "stencilset.json": "fileTypes/json", "sample.ttf": "fileTypes/font",
    };
    for (const [file, icon] of Object.entries(assigned)) {
      const image = row(file).locator(".file-type-icon");
      assert.equal(await image.getAttribute("data-icon"), icon, file);
      assert(await image.evaluate((element) => {
        const url = getComputedStyle(element).backgroundImage.slice(5, -2);
        return new Promise((resolve) => {
          const iconImage = new Image();
          iconImage.onload = () => resolve(iconImage.naturalWidth === 16);
          iconImage.onerror = () => resolve(false);
          iconImage.src = url;
        });
      }), icon);
    }
    assert.equal(await code.locator(".editor-tab.active .file-type-icon").getAttribute("data-icon"), "nodes/class");
    await code.waitForFunction(() => window.probeJavaDiagnostics.some((item) => String(item.code) === "16777748"));
    const published = await code.evaluate(() => window.probeJavaDiagnostics);
    assert(!published.some((item) => item.severity === 1), JSON.stringify(published));
    assert(published.some((item) => String(item.code) === "536871363"), JSON.stringify(published));
    const editor = code.locator(".monaco-editor");
    await editor.locator(".squiggly-warning").first().waitFor();
    assert.equal(await editor.locator(".squiggly-warning").count(), 1);
    assert.equal(await editor.locator(".squiggly-info, .squiggly-error").count(), 0);
    await code.screenshot({ path: path.join(output, "tree.png") });
    await editor.locator(".view-line").filter({ hasText: "return Dependency.values();" }).click();
    await code.keyboard.press("End");
    await code.keyboard.insertText(" Dependency.();");
    await editor.locator(".squiggly-error").first().waitFor();
    assert.equal(fs.readFileSync(path.join(project, ".classpath"), "utf8"), classpath);
    console.log(JSON.stringify({ version, installed: !!installed, icons: Object.keys(assigned).length,
      indexedIdeaJar: true, realWarningsAndErrorsVisible: true, screenshot: path.join(output, "tree.png") }));
  } finally { await app.evaluate(({ app }) => app.exit(0)); }
})().catch((error) => { console.error(error); process.exitCode = 1; });

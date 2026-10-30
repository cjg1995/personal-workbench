const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const assert = require("node:assert/strict");
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
}
const root = path.resolve(__dirname, "..");
const defaultExe = process.env.LOCALAPPDATA
  ? path.join(
      process.env.LOCALAPPDATA,
      "Programs",
      "PersonalWorkbench",
      "个人工作台.exe",
    )
  : path.join(root, ".local", "installed-app", "个人工作台.exe");
const exe = process.env.WORKBENCH_VERIFY_EXE || defaultExe;
const infoPath = path.join(root, ".local", "installation-probe.json");
const mode = process.argv[2] || "seed";
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const previous =
  mode === "check" ? JSON.parse(fs.readFileSync(infoPath, "utf8")) : null;
const base = path.join(
  root,
  ".local",
  "installation-" + mode + "-" + Date.now(),
);
const dataDir = previous?.dataDir || path.join(base, "data");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
let app,
  page,
  owned = false;
async function launch() {
  app = await playwright._electron.launch({
    executablePath: exe,
    args: ["--data-dir=" + dataDir],
    env,
    timeout: 90000,
  });
  page = await app.firstWindow();
  await page.waitForSelector("[data-page=work]", { timeout: 60000 });
}
async function call(name, payload) {
  const r = await page.evaluate(
    ({ name, payload }) => window.workbench.call(name, payload),
    { name, payload },
  );
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
async function close() {
  if (!app) return;
  const closed = app.waitForEvent("close", { timeout: 10000 }).catch(() => {});
  await app
    .evaluate(({ app }) => {
      setTimeout(() => app.exit(0), 30);
      return true;
    })
    .catch(() => {});
  await closed;
  app = null;
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}
(async () => {
  try {
    await launch();
    let info;
    if (mode === "seed") {
      const record = await call("record.save", {
        kind: "work",
        text: "安装升级保留验证",
        happenedOn: "2026-10-24",
      });
      await call("monthly.add", {
        month: "2026-10",
        name: "陈嘉庚",
        section: "主要工作",
        ids: [record.id],
      });
      const b = await call("bootstrap");
      info = {
        passed: true,
        mode,
        version: b.version,
        recordId: record.id,
        dataDir,
        exe,
      };
      fs.writeFileSync(infoPath, JSON.stringify(info, null, 2));
    } else if (mode === "check") {
      const b = await call("bootstrap");
      assert.equal(
        b.notes.find((n) => n.id === previous.recordId)?.text,
        "安装升级保留验证",
      );
      const m = await call("monthly.get", { month: "2026-10" });
      assert.equal(m.draft.entries[0].sourceIds[0], previous.recordId);
      assert.notEqual(
        b.version,
        previous.version,
        "upgrade must change version",
      );
      info = {
        passed: true,
        mode,
        previousVersion: previous.version,
        version: b.version,
        recordId: previous.recordId,
        dataDir,
        exe,
      };
      fs.writeFileSync(
        path.join(root, ".local", "installation-upgrade-result.json"),
        JSON.stringify(info, null, 2),
      );
    } else if (mode === "runtime") {
      const source = path.join(base, "source"),
        cli = path.join(base, "fixture-cli.cjs"),
        port = await unusedPort();
      fs.mkdirSync(source, { recursive: true });
      fs.writeFileSync(
        path.join(source, "manifest.json"),
        JSON.stringify({ h5: { devServer: { port } } }),
      );
      fs.writeFileSync(
        cli,
        `require('node:http').createServer((q,r)=>r.end('packaged native runner ready')).listen(${port},'127.0.0.1',()=>console.log('Local: http://127.0.0.1:${port}/'));`,
      );
      const b = await call("bootstrap");
      b.config.projects.find((p) => p.id === "employee").path = source;
      b.config.tools.hbNode = process.execPath;
      b.config.tools.hbCli = cli;
      await call("settings.save", b.config);
      await call("projects.inspect", { projectId: "homeproject" });
      assert.ok(
        fs.existsSync(
          path.join(dataDir, "runtime", "tomcat", "WorkbenchTomcat.class"),
        ),
        "Java helper extracted from ASAR",
      );
      await app.evaluate(({ shell, dialog }) => {
        shell.openPath = async (file) => {
          globalThis.__previewPath = file;
          return "";
        };
        shell.openExternal = async (url) => {
          globalThis.__openedServiceUrl = url;
        };
        dialog.showSaveDialog = async () => ({
          canceled: false,
          filePath: globalThis.__wordOutput,
        });
      });
      const preview = await call("settings.template");
      assert.ok(!preview.path.includes(".asar"));
      assert.ok(fs.existsSync(preview.path));
      const word = path.join(base, "已安装版本导出.docx");
      await app.evaluate((_, file) => {
        globalThis.__wordOutput = file;
      }, word);
      const record = await call("record.save", {
        kind: "work",
        text: "已安装版本原生运行验证 & 中文",
        happenedOn: "2026-10-25",
      });
      await call("monthly.add", {
        month: "2026-10",
        name: "陈嘉庚",
        section: "主要工作",
        ids: [record.id],
      });
      await call("monthly.export", {
        month: "2026-10",
        format: "docx",
        range: "draft",
      });
      assert.ok(fs.existsSync(word));
      const started = await call("projects.start", { projectId: "employee" });
      owned = true;
      let task;
      for (let attempt = 0; attempt < 120; attempt++) {
        task = (await call("bootstrap")).tasks.find(
          (t) => t.id === started.taskId,
        );
        if (!["running", "cancelling"].includes(task.state)) break;
        await sleep(300);
      }
      assert.equal(task.state, "success", task.error || "");
      assert.equal(task.result.browserOpened, true);
      const running = await call("projects.inspect", { projectId: "employee" });
      assert.equal(running.state, "running");
      assert.ok(running.canStop);
      assert.match(
        await (await fetch(running.url)).text(),
        /packaged native runner ready/,
      );
      await close();
      await launch();
      const adopted = await call("projects.inspect", { projectId: "employee" });
      assert.equal(adopted.pid, running.pid);
      assert.ok(adopted.canStop);
      assert.equal(
        (await call("projects.start", { projectId: "employee" })).reused,
        true,
      );
      const stopped = await call("projects.stop", { projectId: "employee" });
      owned = false;
      assert.equal(stopped.state, "stopped");
      assert.equal(
        (await call("bootstrap")).notes.find((n) => n.id === record.id)?.text,
        record.text,
      );
      info = {
        passed: true,
        mode,
        version: b.version,
        dataDir,
        exe,
        word,
        templatePreview: preview.path,
        checks: [
          "ASAR template preview",
          "packaged Word export",
          "Java helper extraction",
          "packaged detached supervisor",
          "real HTTP readiness and listener identity",
          "restart ownership",
          "repeat start reuse",
          "owned stop",
          "same record ID",
        ],
      };
      fs.writeFileSync(
        path.join(root, ".local", "installation-runtime-result.json"),
        JSON.stringify(info, null, 2),
      );
    } else throw new Error("Unknown verification mode");
    console.log(JSON.stringify(info));
    await close();
    process.exit(0);
  } catch (error) {
    console.error(error);
    if (owned && app)
      await call("projects.stop", { projectId: "employee" }).catch(() => {});
    await close();
    process.exit(1);
  }
})();

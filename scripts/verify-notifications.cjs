// Native desktop acceptance: waits for a Windows notification click/COM activation.
const fs = require("node:fs"),
  path = require("node:path"),
  net = require("node:net"),
  assert = require("node:assert/strict");
let pw;
try {
  pw = require("playwright");
} catch {
  pw = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
}
const root = path.resolve(__dirname, ".."),
  dir = path.join(root, ".local", "notification-ui-" + Date.now()),
  env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(dir, { recursive: true });
const live = path.join(root, ".local", "notification-live.json");
let app,
  page,
  owned = false;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(name, payload) {
  const r = await page.evaluate(
    ({ name, payload }) => window.workbench.call(name, payload),
    { name, payload },
  );
  if (!r.ok) throw Error(r.error);
  return r.data;
}
async function until(fn, timeout = 60000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const r = await fn();
    if (r) return r;
    await sleep(200);
  }
  throw Error("Notification acceptance timeout");
}
async function port() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, "127.0.0.1", r));
  const p = s.address().port;
  await new Promise((r) => s.close(r));
  return p;
}
(async () => {
  try {
    const exe =
      process.env.WORKBENCH_VERIFY_EXE ||
      path.join(root, "release", "win-unpacked", "个人工作台.exe");
    app = await pw._electron.launch({
      executablePath: exe,
      args: ["--data-dir=" + path.join(dir, "data")],
      env,
      timeout: 45000,
    });
    page = await app.firstWindow();
    await page.waitForSelector("[data-page=work]");
    // Keep browser-open verification separate from native notification verification.
    await app.evaluate(({ shell }) => {
      shell.openExternal = async () => {};
    });
    const source = path.join(dir, "source");
    fs.mkdirSync(source);
    const chosen = await port();
    fs.writeFileSync(
      path.join(source, "manifest.json"),
      JSON.stringify({ h5: { devServer: { port: chosen } } }),
    );
    const cli = path.join(dir, "cli.cjs");
    fs.writeFileSync(
      cli,
      `require('node:http').createServer((q,r)=>r.end('notification QA ready')).listen(${chosen},'127.0.0.1',()=>console.log('Local: http://127.0.0.1:${chosen}/'));`,
    );
    const config = (await api("bootstrap")).config;
    config.projects.find((p) => p.id === "wecom").path = source;
    config.projects.find((p) => p.id === "wecom").name = "通知验收本地服务";
    config.tools.hbNode = process.execPath;
    config.tools.hbCli = cli;
    await api("settings.save", config);
    const started = await api("projects.start", { projectId: "wecom" });
    owned = true;
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].minimize(),
    );
    const task = await until(async () => {
      const t = (await api("bootstrap")).tasks.find(
        (t) => t.id === started.taskId,
      );
      return t?.result.notification ? t : false;
    });
    assert.equal(task.state, "success", task.error || "");
    fs.writeFileSync(
      live,
      JSON.stringify(
        {
          dir,
          taskId: task.id,
          notification: task.result.notification,
          exe,
          clsid: await app.evaluate(({ app }) => app.toastActivatorCLSID),
          ready: true,
        },
        null,
        2,
      ),
    );
    console.log(
      JSON.stringify({
        dir,
        taskId: task.id,
        notification: task.result.notification,
        ready: true,
      }),
    );
    assert.equal(
      task.result.notification.state,
      "shown",
      JSON.stringify(task.result.notification),
    );
    await until(async () => {
      return (
        (await page
          .locator("[data-page=tasks] .task-select.selected")
          .count()) &&
        (await page
          .locator("[data-page=tasks] .task-select.selected")
          .innerText()
          .then((s) => s.includes("通知验收本地服务")))
      );
    }, 300000);
    assert.equal(
      await app.evaluate(({ BrowserWindow }) =>
        BrowserWindow.getAllWindows()[0].isMinimized(),
      ),
      false,
    );
    const details = await page.locator("[data-page=tasks]").innerText();
    assert.match(details, /通知验收本地服务/);
    const result = {
      passed: true,
      dir,
      taskId: task.id,
      notification: task.result.notification,
      checks: [
        "actual isolated HTTP process became ready",
        "OS notification show event",
        "Windows notification activation restored window",
        "correct task selected in task center",
      ],
    };
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
    await sleep(1500);
  } catch (error) {
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify({ passed: false, dir, error: error.stack }, null, 2),
    );
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    if (app) {
      if (owned)
        await api("projects.stop", { projectId: "wecom" }).catch(() => {});
      const closed = app
        .waitForEvent("close", { timeout: 10000 })
        .catch(() => {});
      await app
        .evaluate(({ app }) => {
          setTimeout(() => app.exit(0), 30);
          return true;
        })
        .catch(() => {});
      await closed;
    }
  }
})();

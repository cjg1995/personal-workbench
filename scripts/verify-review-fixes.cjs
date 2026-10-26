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
const dir = path.join(root, ".local", "review-fixes-" + Date.now());
const source = path.join(dir, "source");
fs.mkdirSync(source, { recursive: true });
const checks = [], errors = [];
let application, page, serviceStarted = false;
async function raw(name, payload) {
  return page.evaluate(
    ({ name, payload }) => window.workbench.call(name, payload),
    { name, payload },
  );
}
async function api(name, payload) {
  const response = await raw(name, payload);
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
async function until(fn, label) {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 180));
  }
  throw new Error("Timed out: " + label);
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
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    application = await playwright._electron.launch({
      executablePath: require("electron"),
      args: [root, "--data-dir=" + path.join(dir, "data")],
      env,
      timeout: 30000,
    });
    page = await application.firstWindow();
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForSelector('[data-page="home"]');
    const note = await api("record.save", {
      kind: "work", text: "审查回归中的已保存记录", happenedOn: "2026-10-25",
    });
    await page.getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name: "工作记录", exact: true }).click();
    await page.getByRole("button", { name: /审查回归中的已保存记录/ }).click();
    const editor = page.locator(".note-detail textarea").first();
    await editor.fill("页面中尚未保存的修改");
    await page.getByRole("button", { name: "快速记录", exact: true }).click();
    await page.locator("dialog[open]").waitFor();
    await application.evaluate(({ dialog }) => {
      globalThis.reviewTitles = [];
      globalThis.reviewResponses = [0];
      dialog.showMessageBox = async (_window, options) => {
        globalThis.reviewTitles.push(options.title);
        return { response: globalThis.reviewResponses.shift() ?? 0 };
      };
    });
    assert.equal(await page.evaluate(() => window.__workbenchCanClose()), false);
    assert.deepEqual(await application.evaluate(() => globalThis.reviewTitles), ["有未保存修改"]);
    await page.locator("dialog textarea").first().fill("弹窗中尚未保存的记录");
    await application.evaluate(() => {
      globalThis.reviewTitles = [];
      globalThis.reviewResponses = [1, 0];
    });
    assert.equal(await page.evaluate(() => window.__workbenchCanClose()), false);
    assert.deepEqual(await application.evaluate(() => globalThis.reviewTitles), [
      "有未保存的记录输入", "有未保存修改",
    ]);
    assert.equal(await editor.inputValue(), "页面中尚未保存的修改");
    await application.evaluate(() => { globalThis.reviewResponses = [1]; });
    await page.locator("dialog").getByRole("button", { name: "取消", exact: true }).click();
    await page.locator("dialog").waitFor({ state: "detached" });
    assert.equal(await page.evaluate(() => window.__workbenchCanClose()), false);
    await editor.fill(note.text);
    checks.push("quick-record dialog preserves the underlying page's unsaved-input guard");

    const port = await unusedPort();
    fs.writeFileSync(path.join(source, "manifest.json"), JSON.stringify({ h5: { devServer: { port } } }));
    const cli = path.join(dir, "cli.cjs");
    fs.writeFileSync(cli, `require('node:http').createServer((q,r)=>r.end('review fixture')).listen(${port},'127.0.0.1',()=>console.log('Local: http://127.0.0.1:${port}/'));`);
    const config = (await api("bootstrap")).config;
    config.projects.find((p) => p.id === "employee").path = source;
    config.tools.hbNode = process.execPath;
    config.tools.hbCli = cli;
    await api("settings.save", config);
    const archive = path.join(dir, "backup.zip");
    await application.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
      dialog.showMessageBox = async () => ({ response: 1 });
    }, archive);
    await api("backup.create");
    const preview = await api("backup.preview");
    const newer = await api("record.save", { kind: "work", text: "恢复前的当前记录" });
    const started = await api("projects.start", { projectId: "employee" });
    serviceStarted = true;
    await until(async () => {
      const task = (await api("bootstrap")).tasks.find((t) => t.id === started.taskId);
      if (["failed", "partial", "cancelled"].includes(task?.state)) throw new Error(task.error);
      return task?.state === "success";
    }, "isolated service readiness");
    const run = await api("projects.inspect", { projectId: "employee" });
    assert.equal(run.canStop, true);
    const blocked = await raw("backup.restore", { token: preview.token });
    assert.equal(blocked.ok, false);
    assert.match(blocked.error, /自有服务/);
    assert.ok((await api("bootstrap")).notes.some((n) => n.id === newer.id));
    assert.equal((await api("projects.inspect", { projectId: "employee" })).pid, run.pid);
    checks.push("restore refuses a live owned service after its startup task has completed");
    await api("projects.stop", { projectId: "employee" });
    serviceStarted = false;

    await application.evaluate(({ dialog }) => {
      globalThis.reviewRestoreResolve = null;
      dialog.showMessageBox = async () => new Promise((resolve) => {
        globalThis.reviewRestoreResolve = resolve;
      });
    });
    const waiting = raw("backup.restore", { token: preview.token });
    await until(() => application.evaluate(() => !!globalThis.reviewRestoreResolve), "restore confirmation");
    const write = await raw("record.save", { kind: "idea", text: "恢复时不能写入" });
    const repeat = await raw("backup.restore", { token: preview.token });
    assert.equal((await raw("bootstrap")).ok, true);
    assert.equal(write.ok, false);
    assert.match(write.error, /独占/);
    assert.equal(repeat.ok, false);
    await application.evaluate(() => globalThis.reviewRestoreResolve({ response: 0 }));
    assert.equal((await waiting).ok, true);
    assert.ok((await api("bootstrap")).notes.some((n) => n.id === newer.id));
    checks.push("restore excludes concurrent writes and repeated restore requests; cancelling retains current data");

    await application.evaluate(({ dialog }) => {
      dialog.showMessageBox = async () => ({ response: 1 });
    });
    const restored = await api("backup.restore", { token: preview.token });
    assert.equal(restored.restored, true);
    assert.ok(fs.existsSync(restored.protectedBackup));
    const notes = (await api("bootstrap")).notes;
    assert.ok(notes.some((n) => n.id === note.id));
    assert.ok(!notes.some((n) => n.id === newer.id));
    checks.push("restore succeeds after stopping the owned service and keeps the protective backup");
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ passed: true, dir, checks, errors }, null, 2));
    console.log(JSON.stringify({ passed: true, dir, checks }));
  } catch (error) {
    console.error(error);
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ passed: false, dir, checks, errors, error: error.message }, null, 2));
    process.exitCode = 1;
  } finally {
    if (application) {
      if (serviceStarted) await api("projects.stop", { projectId: "employee" }).catch(console.error);
      await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
    }
  }
})();

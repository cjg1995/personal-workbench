const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");
const { setTimeout: delay } = require("node:timers/promises");
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"); }

const root = path.resolve(__dirname, "..");
const local = path.join(root, ".local");
fs.mkdirSync(local, { recursive: true });
const data = fs.mkdtempSync(path.join(local, "todo-notifications-"));
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

async function until(check, label) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await check()) return;
    await delay(100);
  }
  throw new Error(`Timed out: ${label}`);
}

async function api(page, action, payload) {
  const response = await page.evaluate(({ action, payload }) => window.workbench.call(action, payload), { action, payload });
  if (!response.ok) throw new Error(response.error);
  return response.data;
}

(async () => {
  const installed = process.env.PWB_TEST_EXE;
  const application = await playwright._electron.launch({ executablePath: installed || require("electron"),
    args: [...(installed ? [] : [root]), "--data-dir=" + data], env, timeout: 60000 });
  let db;
  try {
    const page = await application.firstWindow();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.waitForSelector("[data-page=work]");
    const { version } = await api(page, "bootstrap");
    assert.equal(version, require("../package.json").version);
    await application.evaluate(({ Notification }, useNative) => {
      const show = Notification.prototype.show;
      globalThis.todoToasts = [];
      Notification.prototype.show = function () {
        if (!this.toastXml?.includes("workbench:todo:")) return show.call(this);
        const toast = { notification: this, xml: this.toastXml, shown: false, failed: "" };
        globalThis.todoToasts.push(toast);
        this.once("show", () => { toast.shown = true; });
        this.once("failed", (_event, reason) => { toast.failed = reason; });
        if (useNative) {
          this.silent = true;
          show.call(this);
        } else this.emit("show");
      };
    }, !!installed);
    const dueAt = new Date(Date.now() + 5000).toISOString();
    await api(page, "record.save", { kind: "idea", text: "无截止时间", dueAt: null });
    const completed = await api(page, "record.save", { kind: "idea", text: "提前完成", dueAt });
    await api(page, "record.complete", { id: completed.id, done: true });
    const unfinished = await api(page, "record.save", { kind: "idea", text: "待办通知验证 <&>", dueAt });
    await api(page, "window.close");
    await until(() => application.evaluate(({ BrowserWindow }) => !BrowserWindow.getAllWindows()[0]?.isVisible()), "close to tray");
    const state = () => application.evaluate(() => globalThis.todoToasts.map(({ xml, shown, failed }) => ({ xml, shown, failed })));
    await until(async () => {
      const toasts = await state();
      if (toasts.some((toast) => toast.failed)) throw new Error(JSON.stringify(toasts));
      return toasts.some((toast) => toast.shown);
    }, "Windows notification show event");
    const toasts = await state();
    assert.equal(toasts.length, 1);
    assert.match(toasts[0].xml, new RegExp("workbench:todo:" + unfinished.id));
    assert.match(toasts[0].xml, /&lt;&amp;&gt;/);
    db = new DatabaseSync(path.join(data, "workbench.sqlite"), { readOnly: true });
    const receipt = db.prepare("select value from objects where kind='meta' and id=?");
    await until(() => !!receipt.get(`todo-reminder:${unfinished.id}:${dueAt}`), "persistent receipt");
    assert.equal(receipt.get(`todo-reminder:${completed.id}:${dueAt}`), undefined);
    await application.evaluate(() => globalThis.todoToasts[0].notification.emit("click"));
    await page.locator("[data-page=ideas] .idea-detail h3").filter({ hasText: "待办通知验证 <&>" }).waitFor();
    assert.equal(await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].isVisible()), true);
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ version, installed: !!installed, nativeShown: !!installed, background: true, unique: true, clickRoute: true }));
  } finally {
    db?.close();
    await application.evaluate(({ app }) => app.exit(0)).catch(() => {});
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

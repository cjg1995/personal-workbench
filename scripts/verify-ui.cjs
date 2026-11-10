const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");
let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
}
const { _electron, expect } = playwright;
const root = path.resolve(__dirname, ".."),
  dir = path.join(root, ".local", "ui-smoke-" + Date.now());
fs.mkdirSync(dir, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
let application;
const errors = [];
async function launch() {
  application = await _electron.launch({
    executablePath: require("electron"),
    args: [root, "--data-dir=" + path.join(dir, "data")],
    env,
    timeout: 30000,
  });
  const page = await application.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector('[data-page="work"]', { timeout: 20000 });
  return page;
}
async function api(page, name, payload) {
  const r = await page.evaluate(
    async ({ name, payload }) => window.workbench.call(name, payload),
    { name, payload },
  );
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
async function until(fn, label) {
  for (let n = 0; n < 60; n++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Timed out: " + label);
}
async function nav(page, name) {
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function capture(page, file) {
  const cdp = await page.context().newCDPSession(page);
  const result = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: false,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(file, Buffer.from(result.data, "base64"));
  await cdp.detach();
}
(async () => {
  try {
    let page = await launch();
    await application.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
    );
    await nav(page, "灵感待办");
    await page.getByLabel("新记录内容").fill("界面回归：一句话灵感");
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await until(
      async () => !(await page.getByLabel("新记录内容").inputValue()),
      "quick-save",
    );
    await page.getByRole("button", { name: /界面回归：一句话灵感/ }).click();
    await page.locator(".note-detail textarea").fill("界面回归：编辑后的灵感");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await until(
      async () =>
        (await api(page, "bootstrap")).notes.some(
          (n) => n.text === "界面回归：编辑后的灵感",
        ),
      "edit persisted",
    );
    await page.getByRole("button", { name: "标记完成", exact: true }).click();
    await until(
      async () => (await api(page, "bootstrap")).notes[0].completedAt,
      "completed",
    );
    let data = await api(page, "bootstrap");
    assert.equal(
      data.notes.filter((n) => n.kind === "work").length,
      0,
      "completing idea must not create work",
    );
    const ideaId = data.notes[0].id;
    await nav(page, "工作记录");
    await page
      .getByLabel("新记录内容")
      .fill("界面回归：真实发生的工作 & <原文>");
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await until(
      async () =>
        (await api(page, "bootstrap")).notes.some((n) => n.kind === "work"),
      "work-save",
    );
    const work = (await api(page, "bootstrap")).notes.find(
      (n) => n.kind === "work",
    );
    await page
      .getByRole("button", { name: /界面回归：真实发生的工作/ })
      .click();
    await page.locator(".note-detail input[type=date]").fill("2026-09-30");
    await page.getByRole("button", { name: "保存修改", exact: true }).click();
    await until(
      async () =>
        (await api(page, "bootstrap")).notes.find((n) => n.id === work.id)
          .happenedOn === "2026-09-30",
      "date update",
    );
    await nav(page, "月度总结");
    await until(
      async () => await page.locator(".monthly-layout").count(),
      "monthly open",
    );
    assert.equal(
      await page.locator(".material").count(),
      0,
      "September material must not leak into October",
    );
    await page.getByLabel("月报月份").fill("2026-09");
    await until(
      async () => (await page.locator(".material").count()) === 1,
      "September material",
    );
    await page.locator(".material input[type=checkbox]").check();
    await page.getByRole("button", { name: "加入正文 1", exact: true }).click();
    await until(
      async () => (await page.locator(".monthly-entry textarea").count()) === 1,
      "source added",
    );
    await page
      .locator(".monthly-entry textarea")
      .fill("人工核对后的正文 & <特殊符号>\n第二行，保留换行。");
    await until(
      async () =>
        (await api(page, "monthly.get", { month: "2026-09" })).draft.entries[0]
          ?.text === "人工核对后的正文 & <特殊符号>\n第二行，保留换行。",
      "auto-save",
    );
    const output = path.join(dir, "月报回归.docx");
    await application.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
    }, output);
    await page.getByRole("button", { name: "导出 Word", exact: true }).click();
    await until(async () => fs.existsSync(output), "Word export");
    assert.ok(fs.statSync(output).size > 1000);
    await capture(page, path.join(dir, "monthly-1280.png"));
    await nav(page, "工作记录");
    await page.getByLabel("新记录内容").fill("x".repeat(100001));
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await page.getByRole("status").filter({ hasText: "内容过长" }).waitFor();
    assert.equal(
      (await page.getByLabel("新记录内容").inputValue()).length,
      100001,
      "failed save keeps input",
    );
    await page.getByLabel("新记录内容").fill("");
    await page.getByRole("button", { name: "关闭提示" }).click();
    await capture(page, path.join(dir, "work-1280.png"));
    for (const name of [
      "APK 打包",
      "Git 管理",
      "项目运行",
    ]) {
      await nav(page, name);
      await page.waitForTimeout(700);
      await capture(
        page,
        path.join(
          dir,
          {
            "APK 打包": "apk",
            "Git 管理": "review",
            项目运行: "projects",
          }[name] + "-1280.png",
        ),
      );
    }
    await until(
      async () => (await page.locator(".table .click-row").count()) === 11,
      "all work directories",
    );
    await page.waitForTimeout(4000);
    await capture(page, path.join(dir, "projects-1280.png"));
    const oldProcess = application.process();
    await application.evaluate(({ app }) => app.exit(0));
    if (oldProcess.exitCode === null)
      await new Promise((resolve) => oldProcess.once("exit", resolve));
    page = await launch();
    data = await api(page, "bootstrap");
    assert.ok(
      data.notes.find((n) => n.id === ideaId && n.completedAt),
      "same idea ID after restart",
    );
    assert.equal(
      data.notes.find((n) => n.id === work.id).happenedOn,
      "2026-09-30",
    );
    const draft = await api(page, "monthly.get", { month: "2026-09" });
    assert.equal(
      draft.draft.entries[0].text,
      "人工核对后的正文 & <特殊符号>\n第二行，保留换行。",
    );
    assert.equal(data.notes.length, 2);
    assert.deepEqual(errors, [], "no renderer exceptions");
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify(
        {
          passed: true,
          checks: [
            "quick record",
            "edit",
            "complete boundary",
            "work date",
            "month boundary",
            "source insertion",
            "autosave",
            "Word export",
            "failed input retention",
            "navigation",
            "11 directories listed",
            "restart persistence",
          ],
          errors,
          output,
          dir,
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ passed: true, dir, output }));
    await application.evaluate(({ app }) => app.exit(0));
  } catch (error) {
    console.error(error);
    if (application) {
      try {
        const windows = await application.windows();
        if (windows[0])
          await capture(windows[0], path.join(dir, "failure.png"));
        await application.evaluate(({ app }) => app.exit(1));
      } catch {}
    }
    process.exitCode = 1;
  }
})();

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
  const installed = process.env.PWB_TEST_EXE;
  application = await _electron.launch({
    executablePath: installed || require("electron"),
    args: [...(installed ? [] : [root]), "--data-dir=" + path.join(dir, "data")],
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
async function assertWorkspaceTop(page, name, selector) {
  const workspace = page.getByRole("main", { name, exact: true });
  const surface = workspace.locator(selector).first();
  await surface.waitFor();
  assert.equal(await workspace.locator("h1, .page-head").count(), 0, name);
  const geometry = await surface.evaluate((element) => {
    const main = element.closest(".workarea");
    const viewport = main.getBoundingClientRect();
    const { paddingLeft, paddingTop } = getComputedStyle(main);
    const rect = element.getBoundingClientRect();
    return {
      top: rect.top - viewport.top - parseFloat(paddingTop),
      left: rect.left - viewport.left - parseFloat(paddingLeft),
    };
  });
  assert.ok(Math.abs(geometry.top) <= 1 && Math.abs(geometry.left) <= 1, `${name}: ${JSON.stringify(geometry)}`);
}
async function assertComposerWidth(page, layout) {
  const form = await page.locator(".quick-entry").boundingBox();
  const panels = await page.locator(layout).boundingBox();
  assert.ok(Math.abs(form.x - panels.x) <= 1 && Math.abs(form.width - panels.width) <= 1, layout);
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
    await nav(page, "待办事项");
    await assertWorkspaceTop(page, "待办事项", ".quick-entry");
    await assertComposerWidth(page, ".ideas-layout");
    await capture(page, path.join(dir, "ideas-1280.png"));
    const ideaInput = page.getByLabel("新待办内容");
    const oneLineHeight = (await ideaInput.boundingBox()).height;
    await ideaInput.fill("第一行\n第二行\n第三行");
    await until(async () => (await ideaInput.boundingBox()).height > oneLineHeight, "composer expands with text");
    const deadline = page.getByLabel("新待办截止时间");
    assert.equal(await deadline.inputValue(), "");
    const future = new Date();
    future.setDate(future.getDate() + 7);
    future.setHours(14, 35, 0, 0);
    const deadlineInput = new Date(future.getTime() - future.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    await deadline.fill(deadlineInput);
    await page.getByLabel("新待办内容").fill("界面回归：一句话灵感");
    await page.getByRole("button", { name: "添加待办", exact: true }).click();
    await until(
      async () => !(await page.getByLabel("新待办内容").inputValue()),
      "quick-save",
    );
    await page.locator(".idea-line", { hasText: "界面回归：一句话灵感" }).click();
    assert.equal(await deadline.inputValue(), "");
    assert.equal(await page.locator(".idea-detail time").getAttribute("datetime"), future.toISOString());
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    const editDeadline = page.locator(".idea-detail").getByLabel("截止时间", { exact: true });
    assert.equal(await editDeadline.inputValue(), deadlineInput);
    await editDeadline.fill("");
    await page.locator(".detail-edit-form textarea").fill("界面回归：编辑后的灵感");
    await page.getByRole("button", { name: "保存修改", exact: true }).first().click();
    await until(
      async () =>
        (await api(page, "bootstrap")).notes.some(
          (n) => n.text === "界面回归：编辑后的灵感" && n.dueAt === null,
        ),
      "edit persisted",
    );
    await page.getByRole("button", { name: "标记完成", exact: true }).click();
    await until(
      async () => (await api(page, "bootstrap")).notes[0].completedAt,
      "completed",
    );
    let data = await api(page, "bootstrap");
    assert.equal(data.version, require("../package.json").version);
    assert.equal(
      data.notes.filter((n) => n.kind === "work").length,
      0,
      "completing idea must not create work",
    );
    const ideaId = data.notes[0].id;
    await nav(page, "工作记录");
    await assertWorkspaceTop(page, "工作记录", ".quick-entry");
    await assertComposerWidth(page, ".work-layout");
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
      .locator(".work-item", { hasText: "界面回归：真实发生的工作" })
      .click();
    await page.getByRole("button", { name: "编辑记录", exact: true }).click();
    await page.locator(".detail-edit-form input[type=date]").fill("2026-09-30");
    await page.getByRole("button", { name: "保存修改", exact: true }).first().click();
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
    await assertWorkspaceTop(page, "月度总结", ".monthly-layout");
    assert.equal(
      await page.locator(".material-item").count(),
      0,
      "September material must not leak into current month",
    );
    await page.getByRole("button", { name: "选择月报月份" }).click();
    await page.getByLabel("月报月份", { exact: true }).fill("2026-09");
    await until(
      async () => (await page.locator(".material-item").count()) === 1,
      "September material",
    );
    await page.locator(".material-item input[type=checkbox]").check();
    await page.getByRole("button", { name: "加入正文", exact: true }).click();
    await until(
      async () => (await page.locator(".doc-entry").count()) === 1,
      "source added",
    );
    await page.getByRole("img", { name: "已加入正文", exact: true }).waitFor();
    await page.locator(".doc-entry").getByRole("button", { name: /编辑条目/ }).click();
    await page
      .locator(".doc-entry textarea")
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
    for (const [name, surface, file] of [
      ["APK 打包", ".apk-layout", "apk"],
      ["Git 管理", ".repo-bar", "review"],
      ["项目管理", ".project-layout", "projects"],
      ["提示词库", ".prompts-empty-card", "prompts-empty"],
    ]) {
      await nav(page, name);
      await assertWorkspaceTop(page, name, surface);
      await page.waitForTimeout(700);
      await capture(page, path.join(dir, file + "-1280.png"));
    }
    await page.getByRole("button", { name: "任务中心", exact: true }).click();
    await assertWorkspaceTop(page, "任务中心", ".tasks-empty-card");
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await assertWorkspaceTop(page, "设置", ".settings-card");
    await page.getByText("v" + data.version, { exact: true }).waitFor();
    await nav(page, "项目管理");
    await until(
      async () => (await page.locator(".project-item").count()) === 11,
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

    // Row deletion targets the clicked work record and keeps other drafts open.
    const current = await api(page, "record.save", { kind: "work", text: "保留当前记录" });
    const other = await api(page, "record.save", { kind: "work", text: "从列表删除记录" });
    await page.locator(`.work-item[data-note-id="${current.id}"] .note-select`).click();
    await page.getByRole("button", { name: "编辑记录", exact: true }).click();
    await page.locator(".detail-edit-form textarea").fill("保留未保存的编辑");
    assert.equal(
      await page.locator(".note-detail").getByRole("button", { name: /删除/ }).count(),
      0,
    );
    const otherRow = page.locator(`.work-item[data-note-id="${other.id}"]`);
    await otherRow.getByRole("button", { name: /删除工作记录/ }).click();
    await page.locator(".ui-msg-dialog[open]").getByRole("button", { name: "删除这条记录" }).click();
    await otherRow.waitFor({ state: "detached" });
    assert.equal(await page.locator(".detail-edit-form textarea").inputValue(), "保留未保存的编辑");
    assert.ok(!(await api(page, "bootstrap")).notes.some((n) => n.id === other.id));
    await page.locator(".note-detail").getByRole("button", { name: "取消", exact: true }).click();

    // Completed ideas have the same row action, with no delete in the detail.
    await nav(page, "待办事项");
    await page.getByRole("tab", { name: /^已完成/ }).click();
    const ideaRow = page.locator(".idea-line", { hasText: "界面回归：编辑后的灵感" });
    await ideaRow.locator(".note-select").click();
    assert.equal(
      await page.locator(".idea-detail").getByRole("button", { name: /删除/ }).count(),
      0,
    );
    await ideaRow.getByRole("button", { name: /删除待办/ }).click();
    await page.locator(".ui-msg-dialog[open]").getByRole("button", { name: "删除这条待办" }).click();
    await ideaRow.waitFor({ state: "detached" });
    assert.ok(!(await api(page, "bootstrap")).notes.some((n) => n.id === ideaId));

    assert.deepEqual(errors, [], "no renderer exceptions");
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify(
        {
          passed: true,
          checks: [
            "quick record",
            "optional todo deadline and clearing it",
            "edit",
            "complete boundary",
            "work date",
            "month boundary",
            "source insertion",
            "autosave",
            "Word export",
            "failed input retention",
            "navigation",
            "no large titles and full-width composers",
            "11 directories listed",
            "restart persistence",
            "permanent deletion from work and completed idea rows",
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

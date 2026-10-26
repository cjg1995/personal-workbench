const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict");
let pw;
try {
  pw = require("playwright");
} catch {
  pw = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
}
const root = path.resolve(__dirname, ".."),
  dir = path.join(root, ".local", "large-repo-ui-" + Date.now()),
  env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(dir, { recursive: true });
let app, page;
const errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn) {
  for (let n = 0; n < 600; n++) {
    if (await fn()) return;
    await sleep(250);
  }
  throw new Error("Large repository UI timeout");
}
async function capture(file) {
  const cdp = await page.context().newCDPSession(page);
  const r = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: false,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(path.join(dir, file), Buffer.from(r.data, "base64"));
  await cdp.detach();
}
(async () => {
  try {
    app = await pw._electron.launch({
      executablePath: require("electron"),
      args: [root, "--data-dir=" + path.join(dir, "data")],
      env,
      timeout: 90000,
    });
    page = await app.firstWindow();
    page.on("pageerror", (e) => errors.push(e.message));
    await page.waitForSelector("[data-page=home]");
    await app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0].setContentSize(1280, 800),
    );
    const nav = (name) =>
      page
        .getByRole("navigation", { name: "主导航" })
        .getByRole("button", { name, exact: true })
        .click();
    await nav("代码提交");
    const start = Date.now();
    await page
      .getByRole("button", { name: "检查仓库与预览", exact: true })
      .click();
    await page
      .getByRole("button", { name: "继续推送并合并", exact: true })
      .waitFor({ timeout: 60000 });
    await page.getByRole("button", { name: /^未跟踪 \/ 跳过/ }).click();
    assert.equal(await page.locator(".file-list .file-item").count(), 200);
    await page
      .getByRole("button", { name: "再显示 200 个文件", exact: true })
      .click();
    assert.equal(await page.locator(".file-list .file-item").count(), 400);
    await page
      .getByLabel("搜索提交文件")
      .fill("no-file-matches-this-probe-123456");
    assert.equal(await page.locator(".file-list .file-item").count(), 0);
    await page.getByLabel("搜索提交文件").fill("");
    await capture("submit.png");
    const previewSeconds = (Date.now() - start) / 1000;
    await nav("代码审查");
    const reviewStart = Date.now();
    await page.locator(".review-layout").waitFor({ timeout: 150000 });
    await until(() =>
      page
        .getByRole("button", { name: "读取 / 刷新差异", exact: true })
        .isEnabled(),
    );
    const count = await page
      .locator(".review-layout > section")
      .first()
      .locator(".file-item")
      .count();
    assert.equal(count, 200);
    const heading = await page
      .locator(".review-layout > section")
      .first()
      .locator("h2")
      .innerText();
    await page
      .getByRole("button", { name: "再显示 200 个文件", exact: true })
      .click();
    assert.equal(
      await page
        .locator(".review-layout > section")
        .first()
        .locator(".file-item")
        .count(),
      400,
    );
    await capture("review.png");
    assert.deepEqual(errors, []);
    const result = {
      passed: true,
      dir,
      previewSeconds,
      reviewSeconds: (Date.now() - reviewStart) / 1000,
      heading,
      checks: [
        "real ERP read-only preview",
        "200 then 400 visible rows",
        "search across actual list",
        "real ERP review snapshot",
        "bounded scrollable review list",
        "no renderer exceptions",
      ],
      errors,
    };
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify(result, null, 2),
    );
    console.log(JSON.stringify(result));
  } catch (error) {
    console.error(error.message);
    if (page) await capture("failure.png").catch(() => {});
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify(
        { passed: false, dir, error: error.message, errors },
        null,
        2,
      ),
    );
    process.exitCode = 1;
  } finally {
    if (app) {
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

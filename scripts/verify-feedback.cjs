const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
let pw;
try {
  pw = require("playwright");
} catch {
  pw = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
}
const root = path.resolve(__dirname, ".."),
  dir = path.join(root, ".local", "feedback-ui-" + Date.now());
fs.mkdirSync(dir, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [],
  errors = [];
let app, page;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function api(name, payload) {
  const r = await page.evaluate(
    ({ name, payload }) => window.workbench.call(name, payload),
    { name, payload },
  );
  if (!r.ok) throw Error(r.error);
  return r.data;
}
async function until(fn, label) {
  for (let n = 0; n < 250; n++) {
    if (await fn()) return;
    await sleep(150);
  }
  throw Error("Timed out: " + label);
}
async function nav(name) {
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name, exact: true })
    .click();
}
async function capture(name) {
  const c = await page.context().newCDPSession(page);
  const r = await c.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: false,
    captureBeyondViewport: false,
  });
  fs.writeFileSync(
    path.join(dir, name + ".png"),
    Buffer.from(r.data, "base64"),
  );
  await c.detach();
}
async function close() {
  if (!app) return;
  const closed = app.waitForEvent("close", { timeout: 10000 }).catch(() => {});
  await app.evaluate(({ app }) => {
    setTimeout(() => app.exit(0), 30);
    return true;
  });
  await closed;
  app = null;
}
async function launch() {
  app = await pw._electron.launch({
    executablePath: process.env.WORKBENCH_VERIFY_EXE || require("electron"),
    args: [
      ...(process.env.WORKBENCH_VERIFY_EXE ? [] : [root]),
      "--data-dir=" + path.join(dir, "data"),
    ],
    env,
    timeout: 30000,
  });
  page = await app.firstWindow();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.waitForSelector("[data-page=work]");
}
(async () => {
  try {
    await launch();
    await app.evaluate(() => {
      globalThis.feedbackHeartbeat = { last: Date.now(), max: 0 };
      setInterval(() => {
        const p = globalThis.feedbackHeartbeat,
          t = Date.now();
        p.max = Math.max(p.max, t - p.last);
        p.last = t;
      }, 50);
    });
    await nav("代码审查");
    await page.getByRole("button", { name: "取消读取", exact: true }).waitFor();
    const cancelledAt = Date.now();
    await page.getByRole("button", { name: "取消读取", exact: true }).click();
    await until(
      () =>
        page
          .getByRole("button", { name: "读取 / 刷新差异", exact: true })
          .isEnabled(),
      "read cancellation",
    );
    assert.equal((await api("review.history")).length, 0);
    checks.push({
      name: "real ERP scan cancellation keeps UI responsive and saves no partial snapshot",
      seconds: (Date.now() - cancelledAt) / 1000,
    });
    const begin = Date.now();
    await page
      .getByRole("button", { name: "读取 / 刷新差异", exact: true })
      .click();
    await page.locator(".review-layout").waitFor({ timeout: 45000 });
    await until(
      () =>
        page
          .getByRole("button", { name: "读取 / 刷新差异", exact: true })
          .isEnabled(),
      "read finished",
    );
    const history = await api("review.history");
    assert.ok(history[0].fileCount > 10000);
    assert.equal(history[0].files, undefined);
    await until(async () => {
      const snapshot = await api("review.get", { id: history[0].id });
      return !snapshot.files[0].deferred || !!snapshot.files[0].contentHash;
    }, "selected file content loaded from packaged app");
    const heartbeat = await app.evaluate(() => globalThis.feedbackHeartbeat);
    assert.ok(heartbeat.max < 2500, JSON.stringify(heartbeat));
    assert.equal(await page.locator(".review-layout .file-item").count(), 200);
    checks.push({
      name: "real ERP full read with bounded main-thread delay and summary-only history",
      seconds: (Date.now() - begin) / 1000,
      fileCount: history[0].fileCount,
      maxMainDelayMs: heartbeat.max,
    });
    await capture("real-review");
    await nav("月度总结");
    await page.locator(".monthly-layout").waitFor();
    assert.equal(
      await page.getByRole("button", { name: /TXT|原始记录/ }).count(),
      0,
    );
    assert.equal(
      await page.getByRole("button", { name: "复制正文", exact: true }).count(),
      0,
    );
    const draft = (await api("monthly.get", { month: "2026-10" })).draft;
    for (const section of [
      "主要工作",
      "其他",
      "个人学习和成长",
      "个人工作计划、学习目标",
    ])
      for (const text of ["第一条中文 & <符号>", "第二条正文"])
        draft.entries.push({
          id: require("node:crypto").randomUUID(),
          section,
          text: section + "：" + text,
          sourceIds: [],
          sourceVersions: {},
          manual: true,
        });
    await api("monthly.save", draft);
    const output = path.join(dir, "月报新排版.docx");
    await app.evaluate(({ dialog }, output) => {
      dialog.showSaveDialog = async () => ({
        canceled: false,
        filePath: output,
      });
    }, output);
    await api("monthly.export", { month: "2026-10" });
    assert.ok(fs.statSync(output).size > 1000);
    await assert.rejects(
      () => api("monthly.export", { month: "2026-10", format: "txt" }),
      /仅支持 Word/,
    );
    checks.push({
      name: "monthly TXT controls removed and Word-only IPC; existing draft data preserved",
      output,
    });
    const repo = path.join(dir, "review-source");
    fs.mkdirSync(repo);
    const git = (...args) =>
      execFileSync("git", ["-c", "core.autocrlf=false", "-C", repo, ...args], {
        windowsHide: true,
        stdio: "pipe",
        encoding: "utf8",
      });
    git("init", "-b", "dev");
    git("config", "user.name", "Feedback QA");
    git("config", "user.email", "qa@example.invalid");
    git("config", "commit.gpgsign", "false");
    fs.writeFileSync(path.join(repo, "base.txt"), "base\n");
    git("add", ".");
    git("commit", "-m", "base");
    fs.writeFileSync(
      path.join(repo, "many-lines.txt"),
      Array.from({ length: 12000 }, (_, n) => "line " + (n + 1)).join("\n"),
    );
    fs.writeFileSync(path.join(repo, "long-line.txt"), "x".repeat(20000));
    const config = (await api("bootstrap")).config;
    config.projects.find((p) => p.id === "homeproject").path = repo;
    await api("settings.save", config);
    await nav("代码审查");
    await page.locator(".review-layout").waitFor();
    await until(
      () =>
        page
          .getByRole("button", { name: "读取 / 刷新差异", exact: true })
          .isEnabled(),
      "fixture read",
    );
    await page.getByRole("button", { name: /many-lines\.txt/ }).click();
    assert.ok((await page.locator(".diff tr").count()) <= 300);
    await page.getByRole("button", { name: "下一页差异", exact: true }).click();
    assert.match(await page.locator(".diff").innerText(), /line 30[0-9]/);
    await page.getByRole("button", { name: "下一变更", exact: true }).click();
    assert.ok((await page.locator(".diff tr").count()) <= 300);
    await page.getByRole("button", { name: /long-line\.txt/ }).click();
    assert.match(await page.locator(".diff").innerText(), /本行过长/);
    assert.ok((await page.locator(".diff").innerText()).length < 5000);
    checks.push({
      name: "12000-line diff paginates, navigation reaches pages, long lines do not freeze rendering",
    });
    await capture("large-diff");
    const seenTarget = (await api("review.history"))[0];
    const seenSnapshot = await api("review.get", { id: seenTarget.id });
    await api("review.seen", {
      id: seenTarget.id,
      file: seenSnapshot.files[0].path,
      viewed: true,
    });
    await until(
      async () =>
        Object.keys((await api("review.get", { id: seenTarget.id })).seen)
          .length === 1,
      "seen save",
    );
    const latest = (await api("review.history"))[0];
    await close();
    await launch();
    assert.equal((await api("review.get", { id: latest.id })).files.length, 2);
    assert.equal(
      (await api("monthly.get", { month: "2026-10" })).draft.entries.length,
      8,
    );
    checks.push({
      name: "restart preserves complete review and monthly draft",
    });
    assert.deepEqual(errors, []);
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify({ passed: true, dir, checks, errors }, null, 2),
    );
    console.log(JSON.stringify({ passed: true, dir, checks, errors }));
  } catch (error) {
    await capture("failure").catch(() => {});
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify(
        { passed: false, dir, error: error.stack, checks, errors },
        null,
        2,
      ),
    );
    console.error(error.stack);
    process.exitCode = 1;
  } finally {
    await close().catch(() => app?.process().kill());
  }
})();

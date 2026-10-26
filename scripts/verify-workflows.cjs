const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { execFileSync } = require("node:child_process");
let pw;
try {
  pw = require("playwright");
} catch {
  pw = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
}
const root = path.resolve(__dirname, ".."),
  dir = path.join(root, ".local", "ui-workflows-" + Date.now()),
  env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(dir, { recursive: true });
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
};
function git(repo, ...args) {
  return execFileSync(
    "git",
    [
      "-c",
      "core.quotepath=false",
      "-c",
      "core.autocrlf=false",
      "-C",
      repo,
      ...args,
    ],
    {
      windowsHide: true,
      stdio: "pipe",
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
        GIT_MERGE_AUTOEDIT: "no",
      },
    },
  ).trimEnd();
}
function fixture(name, branch) {
  const folder = path.join(dir, name),
    remote = path.join(folder, "remote.git"),
    repo = path.join(folder, "client 中文 [路径]");
  fs.mkdirSync(folder, { recursive: true });
  git(folder, "init", "--bare", "--initial-branch=" + branch, remote);
  git(folder, "clone", remote, repo);
  git(repo, "config", "user.name", "界面验收");
  git(repo, "config", "user.email", "ui@example.invalid");
  git(repo, "config", "commit.gpgsign", "false");
  const hooks = path.join(folder, "empty-hooks");
  fs.mkdirSync(hooks);
  git(repo, "config", "core.hooksPath", hooks);
  write(path.join(repo, "store/index.js"), "remote configuration\n");
  write(path.join(repo, "pages/index.vue"), "<template>base</template>\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "初始");
  git(repo, "push", "-u", "origin", branch);
  return { folder, remote, repo };
}
let app, page;
const checks = [],
  errors = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function launch() {
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
async function api(name, payload) {
  const r = await page.evaluate(
    ({ name, payload }) => window.workbench.call(name, payload),
    { name, payload },
  );
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
async function until(fn, label, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const result = await fn();
    if (result) return result;
    await sleep(180);
  }
  throw new Error("Timed out: " + label);
}
async function nav(name) {
  if (name === "设置")
    await page.getByRole("button", { name, exact: true }).click();
  else
    await page
      .getByRole("navigation", { name: "主导航" })
      .getByRole("button", { name, exact: true })
      .click();
}
async function task(type, state) {
  return until(
    async () => {
      const t = (await api("bootstrap")).tasks.find((t) => t.type === type);
      return t?.state === state ? t : false;
    },
    type + " " + state,
    60000,
  );
}
async function dialogs({ open, save, response = 0 } = {}) {
  await app.evaluate(
    ({ dialog }, settings) => {
      dialog.showOpenDialog = async () =>
        settings.open
          ? { canceled: false, filePaths: [settings.open] }
          : { canceled: true, filePaths: [] };
      dialog.showSaveDialog = async () =>
        settings.save
          ? { canceled: false, filePath: settings.save }
          : { canceled: true };
      dialog.showMessageBox = async () => ({
        response: settings.response,
        checkboxChecked: false,
      });
    },
    { open, save, response },
  );
}
async function screenshot(name) {
  const cdp = await page.context().newCDPSession(page);
  const out = await cdp.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: false,
    captureBeyondViewport: false,
  });
  write(path.join(dir, name + ".png"), Buffer.from(out.data, "base64"));
  await cdp.detach();
}
(async () => {
  try {
    const appRepo = fixture("app", "dev"),
      erp = fixture("erp", "test");
    git(erp.repo, "switch", "-c", "feature-界面验收");
    git(erp.repo, "push", "-u", "origin", "feature-界面验收");
    const testTree = path.join(erp.folder, "test 工作树");
    git(erp.repo, "worktree", "add", testTree, "test");
    const city = "本地城市配置\r\n保持原字节\r\n";
    write(path.join(appRepo.repo, "store/index.js"), city);
    git(appRepo.repo, "update-index", "--assume-unchanged", "store/index.js");
    write(
      path.join(appRepo.repo, "pages/index.vue"),
      "<template>本地修改</template>\n",
    );
    write(path.join(appRepo.repo, "tests/ignored.cjs"), "本地测试不应提交");
    write(
      path.join(erp.repo, "pages/index.vue"),
      "<template>ERP 修改</template>\n",
    );
    write(path.join(erp.repo, "untracked.txt"), "ERP 未暂存新文件");
    await launch();
    await dialogs();
    let data = await api("bootstrap");
    data.config.projects.find((p) => p.id === "employee").path = appRepo.repo;
    data.config.projects.find((p) => p.id === "homeproject").path = erp.repo;
    await api("settings.save", data.config);
    await page.reload();
    await page.waitForSelector("[data-page=home]");
    await nav("代码提交");
    await page.getByRole("button", { name: "APP 提交", exact: true }).click();
    await page
      .getByRole("button", { name: "检查仓库与预览", exact: true })
      .click();
    await page
      .getByRole("button", { name: "确认更新并保护本地配置", exact: true })
      .click();
    const cancelled = await task("app", "awaiting");
    await page
      .getByRole("button", { name: "取消本次提交", exact: true })
      .click();
    await task("app", "cancelled");
    assert.equal(
      git(appRepo.repo, "rev-parse", "HEAD"),
      git(appRepo.remote, "rev-parse", "dev"),
    );
    assert.equal(
      fs.readFileSync(path.join(appRepo.repo, "store/index.js"), "utf8"),
      city,
    );
    checks.push(
      "APP prepare cancellation preserves local bytes and does not commit",
    );
    await page
      .getByRole("button", { name: "检查仓库与预览", exact: true })
      .click();
    await page
      .getByRole("button", { name: "确认更新并保护本地配置", exact: true })
      .click();
    await task("app", "awaiting");
    await page
      .getByRole("textbox", { name: "提交说明", exact: true })
      .fill("界面原生 APP 提交 & 中文");
    await page.getByRole("button", { name: "提交并推送", exact: true }).click();
    const submitted = await task("app", "success");
    assert.equal(submitted.result.verified, true);
    assert.equal(
      git(appRepo.remote, "show", "dev:pages/index.vue"),
      "<template>本地修改</template>",
    );
    assert.equal(
      fs.readFileSync(path.join(appRepo.repo, "store/index.js"), "utf8"),
      city,
    );
    assert.match(
      git(appRepo.repo, "ls-files", "-v", "--", "store/index.js"),
      /^h /,
    );
    assert.throws(() => git(appRepo.remote, "show", "dev:tests/ignored.cjs"));
    await screenshot("app-success");
    checks.push(
      "APP UI submit, actual remote verification and protected configuration",
    );
    await page.getByRole("button", { name: "ERP 提交", exact: true }).click();
    await page
      .getByRole("button", { name: "检查仓库与预览", exact: true })
      .click();
    await page
      .getByRole("button", { name: "确认提交并合并", exact: true })
      .click();
    const erpTask = await task("erp", "success");
    assert.equal(
      erpTask.result.testPath.replaceAll("\\", "/"),
      testTree.replaceAll("\\", "/"),
    );
    assert.equal(
      git(erp.remote, "show", "test:pages/index.vue"),
      "<template>ERP 修改</template>",
    );
    assert.equal(git(erp.repo, "branch", "--show-current"), "feature-界面验收");
    assert.ok(fs.existsSync(path.join(erp.repo, "untracked.txt")));
    checks.push("ERP UI submit and test worktree merge");
    write(
      path.join(appRepo.repo, "pages/index.vue"),
      "<template>审查新版本</template>\n",
    );
    await nav("代码审查");
    await page.locator(".toolbar select").first().selectOption("employee");
    await page
      .getByRole("button", { name: "读取 / 刷新差异", exact: true })
      .click();
    await page
      .getByRole("button", { name: "标记此文件已看", exact: true })
      .click();
    await page.getByLabel("审查意见内容").fill("核对异常分支的空值处理");
    await page.getByLabel("意见行号").fill("1");
    await page.getByRole("button", { name: "添加问题", exact: true }).click();
    await until(async () => {
      const row = (await api("review.history")).find(
        (r) => r.projectId === "employee",
      );
      return row && (await api("review.get", { id: row.id })).issues.length;
    }, "review issue");
    let reviewRow = (await api("review.history")).find(
      (r) => r.projectId === "employee",
    );
    let review = await api("review.get", { id: reviewRow.id });
    await page.getByLabel("问题处理状态").selectOption("declined");
    await page
      .getByRole("button", { name: "保存问题状态", exact: true })
      .click();
    await until(
      async () =>
        /不采纳.*原因/.test(await page.getByRole("status").innerText()),
      "decline requires reason",
    );
    assert.equal(
      (await api("review.get", { id: review.id })).issues[0].state,
      "open",
    );
    await page.getByLabel("不采纳原因").fill("已核对调用方约束，保留现状");
    await page
      .getByRole("button", { name: "保存问题状态", exact: true })
      .click();
    await until(
      async () =>
        (await api("review.get", { id: review.id })).issues[0].state ===
        "declined",
      "decline saved",
    );
    await page.getByRole("button", { name: "转为待办", exact: true }).click();
    await until(
      async () => (await api("review.get", { id: review.id })).issues[0].todoId,
      "linked todo",
    );
    checks.push(
      "manual review status validation, persisted reason and linked todo",
    );
    await page.getByLabel("审查意见内容").fill("尚未保存的意见");
    await nav("今日概览");
    assert.ok(await page.locator("[data-page=review]").count());
    assert.equal(
      await page.getByLabel("审查意见内容").inputValue(),
      "尚未保存的意见",
    );
    await page.getByLabel("审查意见内容").fill("");
    await page
      .getByLabel("人工审查结论")
      .selectOption({ label: "仍有待处理项" });
    await page.getByLabel("人工审查总结").fill("人工完成核对，保留待办跟进");
    await page.getByRole("button", { name: "结束审查", exact: true }).click();
    await until(
      async () =>
        (await api("review.get", { id: review.id })).conclusion ===
        "仍有待处理项",
      "review conclusion",
    );
    write(
      path.join(appRepo.repo, "pages/index.vue"),
      "<template>再次变化</template>\n",
    );
    await api("review.validate", { id: review.id });
    await page
      .getByRole("button", { name: "读取 / 刷新差异", exact: true })
      .click();
    await until(
      async () =>
        await page
          .getByText("位置已变化，保留原定位，不绑定到当前同号行。")
          .count(),
      "stale issue marker",
    );
    await screenshot("review-stale");
    checks.push(
      "unsaved review guard and original issue location after code changes",
    );
    const txt = path.join(dir, "导入 原文.txt"),
      raw = Buffer.from(
        "\ufeff第一条（保留标点）\r\n\r\n 第二条 & <原文> \r\n",
        "utf8",
      );
    write(txt, raw);
    await nav("设置");
    await page
      .getByRole("button", { name: "复制导入…", exact: true })
      .nth(1)
      .click();
    await dialogs({ open: txt });
    await page
      .getByRole("button", { name: "选择 TXT 文件", exact: true })
      .click();
    assert.equal(await page.getByRole("checkbox").count(), 2);
    await page
      .getByRole("button", { name: "确认复制导入 2 条", exact: true })
      .click();
    await until(
      async () => (await api("bootstrap")).imports.length === 1,
      "import persisted",
    );
    assert.deepEqual(fs.readFileSync(txt), raw);
    data = await api("bootstrap");
    assert.equal(data.notes.filter((n) => n.kind === "work").length, 2);
    assert.ok(
      data.notes
        .filter((n) => n.kind === "work")
        .every((n) => n.happenedOn === null),
    );
    await page.getByRole("button", { name: "更换文件", exact: true }).click();
    assert.equal(
      await page.getByRole("checkbox", { checked: true }).count(),
      0,
    );
    checks.push(
      "TXT UI copy import, exact bytes, undated boundary and duplicate default skip",
    );
    await nav("设置");
    const backupFile = path.join(dir, "完整备份.zip");
    await dialogs({ save: backupFile });
    await page.getByRole("button", { name: "创建备份", exact: true }).click();
    await until(() => fs.existsSync(backupFile), "backup exists");
    const beforeNotes = (await api("bootstrap")).notes.map((n) => n.id).sort();
    const extra = await api("record.save", {
      kind: "work",
      text: "仅恢复前存在的记录",
      happenedOn: "2026-10-24",
    });
    await dialogs({ open: backupFile, response: 0 });
    await page
      .getByRole("button", { name: "选择备份并预览", exact: true })
      .click();
    await page.getByRole("button", { name: "取消恢复", exact: true }).click();
    assert.ok((await api("bootstrap")).notes.find((n) => n.id === extra.id));
    await page
      .getByRole("button", { name: "选择备份并预览", exact: true })
      .click();
    await dialogs({ open: backupFile, response: 1 });
    await page
      .getByRole("button", { name: "保留当前备份并恢复此数据", exact: true })
      .click();
    await until(
      async () =>
        !(await api("bootstrap")).notes.find((n) => n.id === extra.id),
      "restore replaced isolated data",
    );
    assert.deepEqual(
      (await api("bootstrap")).notes.map((n) => n.id).sort(),
      beforeNotes,
    );
    checks.push(
      "backup preview, cancel, current-data protection and actual restoration",
    );
    await nav("今日概览");
    await page.locator("#quick-text").fill("重启后仍保留的未保存输入");
    await until(
      async () =>
        (await api("bootstrap")).formDrafts.home?.text ===
        "重启后仍保留的未保存输入",
      "form draft saved",
    );
    await close();
    await launch();
    await dialogs();
    assert.equal(
      await page.locator("#quick-text").inputValue(),
      "重启后仍保留的未保存输入",
    );
    const reopened = await api("bootstrap");
    assert.equal(
      reopened.tasks.find((t) => t.id === submitted.id).state,
      "success",
    );
    assert.equal(
      reopened.tasks.find((t) => t.id === cancelled.id).state,
      "cancelled",
    );
    assert.ok((await api("review.get", { id: review.id })).issues[0]?.todoId);
    checks.push(
      "restart preserves form draft, task result IDs and linked review",
    );
    for (const factor of [1.25, 1.5]) {
      await app.evaluate(
        ({ BrowserWindow }, factor) =>
          BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(factor),
        factor,
      );
      await page
        .getByRole("button", { name: "保存", exact: true })
        .scrollIntoViewIfNeeded();
      assert.equal(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= window.innerWidth,
        ),
        true,
      );
      await screenshot("home-zoom-" + factor);
    }
    checks.push("1280x800 at 125% and 150% content scaling");
    assert.deepEqual(errors, []);
    write(
      path.join(dir, "result.json"),
      JSON.stringify({ passed: true, dir, checks, errors }, null, 2),
    );
    console.log(JSON.stringify({ passed: true, dir, checks }));
    await close();
    process.exit(0);
  } catch (error) {
    console.error(error);
    write(
      path.join(dir, "result.json"),
      JSON.stringify(
        { passed: false, dir, checks, errors, error: error.message },
        null,
        2,
      ),
    );
    if (page) await screenshot("failure").catch(() => {});
    await close();
    process.exit(1);
  }
})();

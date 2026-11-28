const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { zipSync, unzipSync, strToU8, strFromU8 } = require("fflate");

let playwright;
try {
  playwright = require("playwright");
} catch {
  playwright = require(
    "C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright",
  );
}
const { _electron } = playwright;

const root = path.resolve(__dirname, "..");
const runDir = path.join(root, ".local", "verify-prompts-" + Date.now());
const dataDir = path.join(runDir, "data");
const screenshotDir = path.join(runDir, "screenshots");
fs.mkdirSync(dataDir, { recursive: true });
fs.mkdirSync(screenshotDir, { recursive: true });

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

let application;
const pageErrors = [];

async function launch(customDataDir = dataDir) {
  application = await _electron.launch({
    executablePath: require("electron"),
    args: [root, "--data-dir=" + customDataDir],
    env,
    timeout: 30000,
  });
  const page = await application.firstWindow();
  page.on("pageerror", (e) => pageErrors.push(e.message));
  await page.waitForSelector('[data-page="work"]', { timeout: 20000 });
  return page;
}

async function closeApp() {
  if (!application) return;
  const proc = application.process();
  await application.evaluate(({ app }) => app.exit(0));
  if (proc.exitCode === null) {
    await new Promise((resolve) => proc.once("exit", resolve));
  }
  application = null;
}

async function api(page, name, payload) {
  const res = await page.evaluate(
    async ({ name, payload }) => window.workbench.call(name, payload),
    { name, payload },
  );
  if (!res.ok) throw new Error(res.error || "IPC failed: " + name);
  return res.data;
}

async function nav(page, label) {
  await page
    .getByRole("navigation", { name: "主导航" })
    .getByRole("button", { name: label, exact: true })
    .click();
}

async function until(fn, label, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Timed out: " + label);
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

async function readClipboard() {
  return application.evaluate(({ clipboard }) => clipboard.readText());
}

async function confirmPromptDeletion(page, title) {
  await page.getByRole("button", { name: "删除提示词 · " + title, exact: true }).click();
  assert.equal(await page.locator(".ui-msg-dialog[open]").count(), 0);
  await page.getByRole("status").filter({ hasText: "提示词已删除" }).waitFor();
}

(async () => {
  try {
    // =========================================================================
    // Part A: Full Functional & Edge-Case Verification in Isolated Directory
    // =========================================================================
    let page = await launch(dataDir);
    await application.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(1440, 860);
    });
    await nav(page, "提示词库");
    await page.waitForSelector('[data-page="prompts"]', { timeout: 10000 });

    // 0. First-use empty state
    assert.equal(
      await page.locator(".prompt-row").count(),
      0,
      "fresh DB must start with 0 prompts",
    );
    await page.getByText("还没有提示词").waitFor();
    await page.getByRole("button", { name: "新建提示词" }).waitFor();

    // 1. Validation: blank title / blank body cannot save + IME Enter safety
    await page.getByRole("button", { name: "新建提示词" }).click();
    await page.locator("#prompt-edit-title").waitFor();
    const saveBtn = page.getByRole("button", { name: "保存提示词" });
    assert.equal(await saveBtn.isDisabled(), true, "empty form disables save");

    await page.locator("#prompt-edit-title").fill("   ");
    await page.locator("#prompt-edit-body").fill("   \n\t  ");
    assert.equal(
      await saveBtn.isDisabled(),
      true,
      "whitespace-only title & body disable save",
    );

    // Try Ctrl+Enter on whitespace-only -> must NOT save
    await page.locator("#prompt-edit-body").press("Control+Enter");
    await page.waitForTimeout(250);
    assert.equal(
      await page.locator("#prompt-edit-title").count(),
      1,
      "Ctrl+Enter must not save blank prompt",
    );

    // Valid title + blank body still disabled
    await page.locator("#prompt-edit-title").fill("多行代码审查");
    assert.equal(
      await saveBtn.isDisabled(),
      true,
      "blank body must keep save disabled",
    );

    // Test IME composition Enter in tag box does not prematurely commit
    const tagBox = page.locator("#prompt-edit-tag");
    await tagBox.fill("kaifa");
    await tagBox.evaluate((el) => {
      const ev = new KeyboardEvent("keydown", {
        key: "Enter",
        bubbles: true,
        cancelable: true,
        isComposing: true,
      });
      el.dispatchEvent(ev);
    });
    assert.equal(
      await tagBox.inputValue(),
      "kaifa",
      "IME composing Enter must not swallow candidate text",
    );

    // Add tags with spaces and duplicates
    await tagBox.fill("  开发 , Git ， git , 代码审查 ");
    await tagBox.press("Enter");
    const chipTexts = await page
      .locator(".tag-editor .tag-chip")
      .allInnerTexts();
    assert.deepEqual(
      chipTexts.map((t) => t.trim()),
      ["开发", "Git", "代码审查"],
      "tags trimmed and deduplicated case-insensitively",
    );

    // Scenario 1: Multiline + indented body saved with Ctrl + Enter
    const multilineBody =
      "请审查以下改动：\n\n    function check(a) {\n      return { ok: true, value: a };\n    }\n  保留前导缩进与尾部空行。\n";
    await page.locator("#prompt-edit-body").fill(multilineBody);
    assert.equal(await saveBtn.isDisabled(), false, "valid form enables save");
    await page.locator("#prompt-edit-body").press("Control+Enter");
    await page.locator(".library-layout").waitFor({ timeout: 10000 });
    await page.getByRole("status").filter({ hasText: "提示词已保存" }).waitFor();

    // Verify restart persistence + exact clipboard match
    await closeApp();
    page = await launch(dataDir);
    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 860);
    });
    await nav(page, "提示词库");
    await page.locator(".prompt-row", { hasText: "多行代码审查" }).waitFor();

    const savedBeforeCopy = (await api(page, "bootstrap")).prompts.find(
      (p) => p.title === "多行代码审查",
    );
    assert.equal(
      savedBeforeCopy.body,
      multilineBody,
      "restarted DB preserves exact multiline indented body",
    );

    await page.getByRole("button", { name: "复制提示词" }).click();
    await page.getByRole("status").filter({ hasText: "已复制到剪贴板" }).waitFor();
    const clipPlain = await readClipboard();
    assert.equal(
      clipPlain,
      multilineBody,
      "clipboard content matches saved multiline body character-for-character",
    );

    // Confirm copying did not change updatedAt
    const savedAfterCopy = (await api(page, "bootstrap")).prompts.find(
      (p) => p.id === savedBeforeCopy.id,
    );
    assert.equal(
      savedAfterCopy.updatedAt,
      savedBeforeCopy.updatedAt,
      "copying preserves original updatedAt",
    );

    // 2. Scenario 2: Search (body keyword + case-insensitive English), tag filter, favorite stacking, edit, delete, restore
    await page.getByRole("button", { name: "新建提示词" }).click();
    await page.locator("#prompt-edit-title").fill("会议行动项整理");
    await page.locator("#prompt-edit-tag").fill("会议");
    await page.locator("#prompt-edit-tag").press("Enter");
    await page
      .locator("#prompt-edit-body")
      .fill("提取会议中的 AlphaBeta 关键字与负责人清单。");
    await page.getByRole("button", { name: "保存提示词" }).click();
    await page.locator(".library-layout").waitFor();

    // Star the first prompt ("多行代码审查") and check updatedAt preserved
    await page.waitForTimeout(30);
    const reviewRow = page.locator(".prompt-row", { hasText: "多行代码审查" });
    await reviewRow.locator(".star-button").click();
    await until(
      async () =>
        (await api(page, "bootstrap")).prompts.find(
          (p) => p.id === savedBeforeCopy.id,
        )?.starred === true,
      "star persisted",
    );
    const savedAfterStar = (await api(page, "bootstrap")).prompts.find(
      (p) => p.id === savedBeforeCopy.id,
    );
    assert.equal(
      savedAfterStar.updatedAt,
      savedBeforeCopy.updatedAt,
      "starring preserves original updatedAt",
    );

    // Search body keyword (case-insensitive English)
    const searchInput = page.getByLabel("搜索提示词");
    await searchInput.fill("alphabeta");
    await until(
      async () => (await page.locator(".prompt-row").count()) === 1,
      "body keyword case-insensitive search",
    );
    assert.ok(
      await page.locator(".prompt-row", { hasText: "会议行动项整理" }).isVisible(),
    );

    // No match + clear filter
    await searchInput.fill("完全不存在的关键字XYZ");
    await page.getByText("没有匹配的提示词").waitFor();
    await page.getByRole("button", { name: "清除筛选" }).click();
    await until(
      async () => (await page.locator(".prompt-row").count()) === 2,
      "clear filters restores all rows",
    );

    // Stack search + tag + favorites
    await page.getByLabel("按标签筛选").selectOption("Git");
    await page.locator('.filter-tab[data-tab="favorites"]').click();
    await searchInput.fill("function");
    await until(
      async () => (await page.locator(".prompt-row").count()) === 1,
      "stacked tag + favorites + body search",
    );
    assert.ok(
      await page.locator(".prompt-row", { hasText: "多行代码审查" }).isVisible(),
    );
    await searchInput.fill("");
    await page.getByLabel("按标签筛选").selectOption("");
    await page.locator('.filter-tab[data-tab="all"]').click();

    // Edit a prompt and verify the selection, then permanently delete it
    await page.locator(".prompt-row", { hasText: "会议行动项整理" }).click();
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.locator("#prompt-edit-title").fill("会议行动项整理（已更新）");
    await page.getByRole("button", { name: "保存提示词" }).click();
    await page.locator(".library-layout").waitFor();
    assert.equal(
      (await page.locator(".read-title").innerText()).trim(),
      "会议行动项整理（已更新）",
      "edited prompt remains selected after save",
    );

    const deletedTitle = "会议行动项整理（已更新）";
    const deletedId = (await api(page, "bootstrap")).prompts.find(
      (p) => p.title === deletedTitle,
    ).id;
    await page.getByRole("button", { name: "查看 多行代码审查", exact: true }).click();
    assert.equal(
      await page.getByLabel("提示词详情").getByRole("button", { name: /删除提示词/ }).count(),
      0,
    );
    await page.getByRole("button", { name: "删除提示词 · " + deletedTitle, exact: true }).click();
    assert.equal(await page.locator(".ui-msg-dialog[open]").count(), 0);
    await page.getByRole("status").filter({ hasText: "提示词已删除" }).waitFor();
    assert.equal(
      (await page.locator(".read-title").innerText()).trim(),
      "多行代码审查",
      "deleting another row keeps the current detail",
    );
    // 撤销恢复
    await page.locator(".toast .toast-action", { hasText: "撤销" }).click();
    await until(
      async () =>
        (await page.locator('.filter-tab[data-tab="all"] .count').innerText()).trim() ===
          "2",
      "counts restored after undo",
    );
    // 回到原选中再删一次并关闭 Toast 彻底清理
    await page.getByRole("button", { name: "查看 多行代码审查", exact: true }).click();
    await confirmPromptDeletion(page, deletedTitle);
    await until(
      async () =>
        (await page.locator('.filter-tab[data-tab="all"] .count').innerText()).trim() ===
          "1",
      "counts updated after delete",
    );
    assert.equal(
      (await page.locator(".read-title").innerText()).trim(),
      "多行代码审查",
      "deleting another row keeps the current detail",
    );
    await page.getByRole("button", { name: "关闭提示" }).click();

    assert.deepEqual(
      await page.locator(".filter-tab").evaluateAll((tabs) =>
        tabs.map((tab) => tab.dataset.tab),
      ),
      ["all", "favorites"],
    );
    assert.ok(
      !(await api(page, "bootstrap")).prompts.some((p) => p.id === deletedId),
    );
    await until(async () => {
      const restore = await page.evaluate(
        (id) => window.workbench.call("prompt.restore", { id }),
        deletedId,
      );
      return restore.ok === false;
    }, "prompt purged after toast dismiss");

    // 3 & 4. Scenarios 3 & 4: {{项目名称}} + {{ 项目名称 }}, insert variable, click variable locate,
    //    tricky value with newline + $& + <文本> + {{保留原样}}, clipboard verification, transient clear, raw copy
    await page.getByRole("button", { name: "新建提示词" }).click();
    await page.locator("#prompt-edit-title").fill("双占位符与特殊值测试");
    const templateBody =
      "主项目：{{项目名称}}\n说明：{{说明}}\n重复引用：{{ 项目名称 }}\n代码保留：{ a: 1 } {{}} {{{raw}}}";
    await page.locator("#prompt-edit-body").fill(templateBody);

    // Check recognized variable chips in live preview: only 2 unique variables
    const recognizedVars = await page
      .locator(".variable-tags button")
      .allInnerTexts();
    assert.deepEqual(
      recognizedVars.map((s) => s.trim()),
      ["项目名称", "说明"],
      "duplicate whitespace-variant variable merges into one",
    );

    // Click variable pill locates it in textarea
    await page.locator(".variable-tags button", { hasText: "项目名称" }).click();
    const selText = await page.locator("#prompt-edit-body").evaluate((el) =>
      el.value.slice(el.selectionStart, el.selectionEnd),
    );
    assert.equal(selText, "{{项目名称}}", "clicking variable pill selects placeholder");

    // Test insert variable button at cursor (put cursor at end, insert, then revert so body stays clean)
    await page.locator("#prompt-edit-body").evaluate((el) => {
      el.selectionStart = el.selectionEnd = el.value.length;
    });
    await page.getByRole("button", { name: "插入变量" }).click();
    assert.ok(
      (await page.locator("#prompt-edit-body").inputValue()).endsWith("{{变量名}}"),
      "insert variable inserts placeholder at cursor",
    );
    await page.locator("#prompt-edit-body").fill(templateBody);

    await page.getByRole("button", { name: "保存提示词" }).click();
    await page.locator(".library-layout").waitFor();

    // Test 复制原文 preserves raw placeholders
    await page.getByRole("button", { name: "复制原文" }).click();
    await page.getByRole("status").filter({ hasText: "已复制到剪贴板" }).waitFor();
    assert.equal(await readClipboard(), templateBody, "raw copy preserves placeholders");

    // Open 填写变量并复制
    await page.getByRole("button", { name: "填写变量并复制" }).click();
    await page.locator("dialog.prompt-dialog[open]").waitFor();
    assert.equal(
      await page.locator("[data-var-input]").count(),
      2,
      "modal renders exactly 2 inputs for {{项目名称}}, {{ 项目名称 }}, {{说明}}",
    );
    const fillCopyBtn = page
      .locator("dialog.prompt-dialog[open]")
      .getByRole("button", { name: "复制到剪贴板" });
    assert.equal(
      await fillCopyBtn.isDisabled(),
      true,
      "copy disabled until all variables filled",
    );

    // Fill with whitespace only -> still disabled
    await page.locator('[data-var-name="项目名称"]').fill("个人工作台");
    await page.locator('[data-var-name="说明"]').fill("   \n ");
    assert.equal(
      await fillCopyBtn.isDisabled(),
      true,
      "whitespace-only value must not enable copy",
    );

    // Fill tricky literal value: newline, $&, <文本>, {{保留原样}}
    const trickyVal = "第一行内容\n包含 $& 和 <文本> 以及 {{保留原样}}";
    await page.locator('[data-var-name="说明"]').fill(trickyVal);
    assert.equal(await fillCopyBtn.isDisabled(), false, "copy enabled when all filled");

    const expectedFilled =
      `主项目：个人工作台\n说明：${trickyVal}\n重复引用：个人工作台\n代码保留：{ a: 1 } {{}} {{{raw}}}`;
    const previewText = await page.locator("[data-fill-preview]").innerText();
    assert.equal(
      previewText,
      expectedFilled,
      "preview matches expected single-pass literal replacement",
    );
    // Verify two replacement spans for 项目名称 + one for 说明 = 3 replacement highlights
    assert.equal(
      await page.locator("[data-fill-preview] .replacement").count(),
      3,
      "both {{项目名称}} and {{ 项目名称 }} highlighted as replaced",
    );

    // 5a. Simulate clipboard write failure -> keeps inputs, shows retry & manual copy, no success toast
    await application.evaluate(({ clipboard }) => {
      globalThis.__origWriteText = clipboard.writeText.bind(clipboard);
      clipboard.writeText = () => {
        throw new Error("模拟剪贴板锁定失败");
      };
    });
    await fillCopyBtn.click();
    await page.locator("#copy-error-title").waitFor({ timeout: 5000 });
    assert.equal(
      await page.locator(".manual-copy-area").inputValue(),
      expectedFilled,
      "manual copy fallback textarea has exact rendered text",
    );
    // Close manual copy dialog -> verify fill modal inputs are preserved
    await page
      .locator("dialog.small-dialog[open]")
      .getByRole("button", { name: "关闭", exact: true })
      .click();
    assert.equal(
      await page.locator('[data-var-name="说明"]').inputValue(),
      trickyVal,
      "fill modal preserves user input after copy failure",
    );

    // Trigger failure again, then restore clipboard and click 重试复制
    await fillCopyBtn.click();
    await page.locator("#copy-error-title").waitFor();
    await application.evaluate(({ clipboard }) => {
      clipboard.writeText = globalThis.__origWriteText;
    });
    await page
      .locator("dialog.small-dialog[open]")
      .getByRole("button", { name: "重试复制" })
      .click();
    await page.getByRole("status").filter({ hasText: "已复制到剪贴板" }).waitFor();
    assert.equal(
      await readClipboard(),
      expectedFilled,
      "actual clipboard matches preview after retry",
    );

    // Reopen template -> inputs must be cleared and original placeholders intact
    await page.getByRole("button", { name: "填写变量并复制" }).click();
    await page.locator("dialog.prompt-dialog[open]").waitFor();
    assert.equal(
      await page.locator('[data-var-name="项目名称"]').inputValue(),
      "",
      "transient variable cleared after close",
    );
    assert.equal(
      await page.locator('[data-var-name="说明"]').inputValue(),
      "",
      "transient variable cleared after close",
    );
    await page
      .locator("dialog.prompt-dialog[open]")
      .getByRole("button", { name: "取消" })
      .click();
    assert.equal(
      (await api(page, "bootstrap")).prompts.find(
        (p) => p.title === "双占位符与特殊值测试",
      ).body,
      templateBody,
      "saved template preserves original placeholders",
    );

    // 5b. Long text & narrow window (960x640) usability check
    await page.getByRole("button", { name: "新建提示词" }).click();
    const longBody = Array.from(
      { length: 65 },
      (_, i) => `第 ${i + 1} 行：这是一段用于验证长正文滚动与底部操作按钮可达性的测试文本。`,
    ).join("\n");
    await page.locator("#prompt-edit-title").fill("超长提示词滚动验证");
    await page.locator("#prompt-edit-body").fill(longBody);
    await page.getByRole("button", { name: "保存提示词" }).click();
    await page.locator(".library-layout").waitFor();

    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(960, 640);
    });
    await page.waitForTimeout(250);
    const readBodyMetrics = await page.locator(".read-body").evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    assert.ok(
      readBodyMetrics.scrollHeight > readBodyMetrics.clientHeight,
      "long prompt body scrolls vertically",
    );
    const copyBtnBox = await page
      .getByRole("button", { name: "复制提示词" })
      .boundingBox();
    const editBtnBox = await page
      .getByRole("button", { name: "编辑", exact: true })
      .boundingBox();
    assert.ok(
      copyBtnBox && copyBtnBox.y + copyBtnBox.height <= 640,
      "copy button remains visible in 960x640 narrow window",
    );
    assert.ok(
      editBtnBox && editBtnBox.y >= 0 && editBtnBox.x + editBtnBox.width <= 960,
      "edit button remains visible in 960x640 narrow window",
    );

    await application.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1440, 860);
    });

    // 5c. Leave guard on navigation AND window close
    await page.getByRole("button", { name: "编辑", exact: true }).click();
    await page.locator("#prompt-edit-title").fill("未保存的新标题");
    await page.locator(".form-status").filter({ hasText: /^未保存$/ }).waitFor();

    // Try navigating to 工作记录 -> confirm dialog appears -> cancel stays on editor
    await nav(page, "工作记录");
    await page.locator(".ui-msg-dialog[open]").waitFor();
    await page
      .locator(".ui-msg-dialog[open]")
      .getByRole("button", { name: "取消" })
      .click();
    assert.equal(
      await page.locator("#prompt-edit-title").inputValue(),
      "未保存的新标题",
      "cancelling leave guard preserves editor content",
    );

    // Test window close guard (__workbenchCanClose)
    const closePromise = page.evaluate(() => window.__workbenchCanClose());
    await page.locator(".ui-msg-dialog[open]").waitFor();
    await page
      .locator(".ui-msg-dialog[open]")
      .getByRole("button", { name: "取消" })
      .click();
    assert.equal(
      await closePromise,
      false,
      "window close blocked when user cancels leave guard",
    );

    // Confirm discarding changes when navigating to 设置
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.locator(".ui-msg-dialog[open]").waitFor();
    await page
      .locator(".ui-msg-dialog[open]")
      .getByRole("button", { name: "放弃修改" })
      .click();
    await page.waitForSelector('[data-page="settings"]', { timeout: 10000 });

    // 5d. Backup & Restore through Settings UI + legacy backup compatibility
    const backupFile = path.join(runDir, "prompts-backup.zip");
    await application.evaluate(({ dialog }, file) => {
      dialog.showSaveDialog = async () => ({ canceled: false, filePath: file });
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, backupFile);

    await page.getByRole("button", { name: "创建备份" }).click();
    await until(() => fs.existsSync(backupFile), "backup zip created");

    // Mutate prompts after backup (delete another prompt)
    await nav(page, "提示词库");
    await page.locator(".prompt-row", { hasText: "双占位符与特殊值测试" }).click();
    await confirmPromptDeletion(page, "双占位符与特殊值测试");

    // Preview & Restore via Settings UI
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "选择备份并预览" }).click();
    await page.getByText("恢复预览").waitFor();
    const promptRowCells = await page
      .locator(".notice table tbody tr", { hasText: "提示词" })
      .locator("td")
      .allInnerTexts();
    assert.deepEqual(
      promptRowCells.map((s) => s.trim()),
      ["提示词", "2", "3"],
      "backup preview displays prompt counts",
    );
    await page.getByRole("button", { name: "保留当前备份并恢复此数据" }).click();
    await page
      .locator(".ui-msg-dialog[open]")
      .getByRole("button", { name: "备份当前数据并恢复" })
      .click();
    await page.getByRole("status").filter({ hasText: "恢复完成" }).waitFor();

    // Restore the prompts present in the backup, including their favorites
    await nav(page, "提示词库");
    await until(
      async () =>
        (await page.locator('.filter-tab[data-tab="all"] .count').innerText()).trim() ===
          "3" &&
        (
          await page.locator('.filter-tab[data-tab="favorites"] .count').innerText()
        ).trim() === "1",
      "prompt and favorite counts restored",
    );
    assert.ok(
      !(await api(page, "bootstrap")).prompts.some((p) => p.id === deletedId),
    );

    // Legacy backup (genuine v0.1.71 structure: config + note, NO prompt records, manifest.counts lacks prompt) via Settings UI
    const legacyZip = path.join(runDir, "legacy-backup.zip");
    const { DatabaseSync } = require("node:sqlite");
    const currentConfig = (await api(page, "bootstrap")).config;
    const tmpLegacyDb = path.join(runDir, "legacy.sqlite");
    const db = new DatabaseSync(tmpLegacyDb);
    db.exec(`
      create table objects (kind text not null, id text not null, value text not null check(json_valid(value)), updated_at text not null, primary key(kind,id));
      pragma user_version=1;
    `);
    db.prepare(
      "insert into objects(kind,id,value,updated_at) values(?,?,?,?)",
    ).run("config", "main", JSON.stringify(currentConfig), "2026-10-15T10:00:00.000Z");
    const noteObj = {
      id: "legacy-note-1",
      kind: "work",
      text: "旧备份的工作记录",
      projectId: null,
      happenedOn: "2026-10-15",
      result: "",
      createdAt: "2026-10-15T10:00:00.000Z",
      updatedAt: "2026-10-15T10:00:00.000Z",
      completedAt: null,
      deletedAt: null,
      sourceId: null,
      importBatch: null,
      sourceLine: null,
      originalText: null,
    };
    db.prepare(
      "insert into objects(kind,id,value,updated_at) values(?,?,?,?)",
    ).run("note", noteObj.id, JSON.stringify(noteObj), noteObj.updatedAt);
    db.close();
    const crypto = require("node:crypto");
    const dbBytes = fs.readFileSync(tmpLegacyDb);
    const dbHash = crypto.createHash("sha256").update(dbBytes).digest("hex");
    const legacyManifest = {
      format: "personal-workbench",
      version: 1,
      createdAt: "2026-10-15T12:00:00.000Z",
      counts: {
        note: 1,
        config: 1,
        task: 0,
        review: 0,
        monthly: 0,
        import: 0,
        run: 0,
        meta: 0,
      },
      files: { "database.sqlite": dbHash },
      referencesOnly: [],
    };
    fs.writeFileSync(
      legacyZip,
      zipSync({
        "database.sqlite": dbBytes,
        "manifest.json": strToU8(JSON.stringify(legacyManifest, null, 2)),
      }),
    );

    // Dismiss any lingering toast before second restore
    const closeToastBtn = page.getByRole("button", { name: "关闭提示" });
    if (await closeToastBtn.isVisible().catch(() => false)) {
      await closeToastBtn.click();
    }

    await application.evaluate(({ dialog }, file) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [file] });
    }, legacyZip);
    await page.getByRole("button", { name: "设置", exact: true }).click();
    await page.getByRole("button", { name: "选择备份并预览" }).click();
    await page.getByText("恢复预览").waitFor();
    const legacyRowCells = await page
      .locator(".notice table tbody tr", { hasText: "提示词" })
      .locator("td")
      .allInnerTexts();
    assert.deepEqual(
      legacyRowCells.map((s) => s.trim()),
      ["提示词", "3", "0"],
      "legacy backup preview reports 0 prompts",
    );
    await page.getByRole("button", { name: "保留当前备份并恢复此数据" }).click();
    await page
      .locator(".ui-msg-dialog[open]")
      .getByRole("button", { name: "备份当前数据并恢复" })
      .click();
    await page.getByRole("status").filter({ hasText: "恢复完成" }).waitFor();

    await nav(page, "提示词库");
    await page.getByText("还没有提示词").waitFor();
    assert.equal(
      await page.locator(".prompt-row").count(),
      0,
      "legacy backup restores empty prompt library",
    );

    await closeApp();

    // =========================================================================
    // Part B: 1440 x 860 Visual Verification Screenshots with 6 Demo Prompts
    // =========================================================================
    const visualDir = path.join(runDir, "visual-data");
    fs.mkdirSync(visualDir, { recursive: true });
    const visualDbPath = path.join(visualDir, "workbench.sqlite");
    const vdb = new DatabaseSync(visualDbPath);
    vdb.exec(`
      pragma journal_mode=WAL;
      create table objects (kind text not null, id text not null, value text not null check(json_valid(value)), updated_at text not null, primary key(kind,id));
      pragma user_version=1;
    `);
    const demoPrompts = [
      {
        id: "weekly",
        title: "将工作记录整理成周报",
        tags: ["工作总结", "周报"],
        body: "请根据以下工作记录，为{{汇报对象}}整理一份周报。\n\n工作记录\n{{工作记录}}\n\n输出要求\n1. 按项目归并相关工作，每项写清行动和结果。\n2. 把待确认的问题和下一步安排列在「待跟进」下。\n3. 引用记录中已有的信息，缺失项标记为「待补充」。",
        starred: true,
        createdAt: "2026-11-07T08:20:00+08:00",
        updatedAt: "2026-11-21T09:40:00+08:00",
        deletedAt: null,
      },
      {
        id: "review",
        title: "审查本次 Git 变更",
        tags: ["开发", "代码审查"],
        body: "请审查当前工作区的 Git 变更，优先关注行为回归、异常路径和数据一致性。\n\n按影响程度列出发现，注明对应的文件和位置。每项说明触发条件、影响以及最小修复建议。\n\n最后单列已验证的行为和仍需验证的场景。",
        starred: true,
        createdAt: "2026-11-07T08:20:00+08:00",
        updatedAt: "2026-11-20T09:40:00+08:00",
        deletedAt: null,
      },
      {
        id: "tasks",
        title: "把零散想法整理成待办",
        tags: ["日常整理"],
        body: "请将以下零散想法整理为可执行的待办。\n\n{{原始想法}}\n\n每条待办以一个具体动作开头。保留原文给出的截止日期，把需要我做决定的问题单独列出。",
        starred: false,
        createdAt: "2026-11-07T08:20:00+08:00",
        updatedAt: "2026-11-19T09:40:00+08:00",
        deletedAt: null,
      },
      {
        id: "minutes",
        title: "提炼会议纪要与行动项",
        tags: ["会议", "办公写作"],
        body: "从我接下来提供的会议记录中提取三部分内容。\n\n一、已达成的一致意见。\n二、后续行动、负责人和约定时间。\n三、仍需确认的问题。\n\n合并重复讨论并保留关键分歧，缺失的负责人或日期标为「待确认」。",
        starred: false,
        createdAt: "2026-11-07T08:20:00+08:00",
        updatedAt: "2026-11-18T09:40:00+08:00",
        deletedAt: null,
      },
      {
        id: "copy",
        title: "复查界面文案",
        tags: ["设计", "文案"],
        body: "请检查这组界面文案能否帮助用户判断下一步操作。\n\n逐项给出原文、建议稿和修改理由。按钮使用明确的动作，错误提示说明如何恢复，并保持同一功能的叫法一致。",
        starred: false,
        createdAt: "2026-11-07T08:20:00+08:00",
        updatedAt: "2026-11-16T09:40:00+08:00",
        deletedAt: null,
      },
      {
        id: "handoff",
        title: "整理项目交接清单",
        tags: ["开发", "交接"],
        body: "请为{{项目名称}}整理一份交接清单。\n\n交接资料\n{{交接要点}}\n\n将运行环境、启动步骤、关键依赖和待处理事项分开整理。每项写出接手人需要核对的具体内容。",
        starred: false,
        createdAt: "2026-11-07T08:20:00+08:00",
        updatedAt: "2026-11-14T09:40:00+08:00",
        deletedAt: null,
      },
    ];
    const insertStmt = vdb.prepare(
      "insert into objects(kind,id,value,updated_at) values(?,?,?,?)",
    );
    for (const item of demoPrompts) {
      insertStmt.run("prompt", item.id, JSON.stringify(item), item.updatedAt);
    }
    vdb.close();

    page = await launch(visualDir);
    await application.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(1440, 860);
    });
    await nav(page, "提示词库");
    await page.locator(".prompt-row", { hasText: "将工作记录整理成周报" }).waitFor();
    await page.waitForTimeout(300);

    // Screenshot 1: List & Detail
    const shot1 = path.join(screenshotDir, "01-prompts-list-detail.png");
    await capture(page, shot1);

    // Screenshot 3: Fill Variable Modal (matching prototype 03)
    await page.getByRole("button", { name: "填写变量并复制" }).click();
    await page.locator("dialog.prompt-dialog[open]").waitFor();
    await page.locator('[data-var-name="汇报对象"]').fill("项目组负责人");
    await page
      .locator('[data-var-name="工作记录"]')
      .fill(
        "完成工作台五个页面的浅色原型。\n梳理提示词库的保存与复制流程。\n待确认月度总结页的导出样式。",
      );
    await page.waitForTimeout(250);
    const shot3 = path.join(screenshotDir, "03-prompts-fill-modal.png");
    await capture(page, shot3);
    await page
      .locator("dialog.prompt-dialog[open]")
      .getByRole("button", { name: "取消" })
      .click();

    // Screenshot 2: Create / Edit Page (matching prototype 02)
    await page.getByRole("button", { name: "新建提示词" }).click();
    await page.locator("#prompt-edit-title").fill("生成需求评审纪要");
    await page.locator("#prompt-edit-tag").fill("需求评审, 会议");
    await page.locator("#prompt-edit-tag").press("Enter");
    await page
      .locator("#prompt-edit-body")
      .fill(
        "请为{{项目名称}}整理一份需求评审纪要。\n\n评审记录\n{{评审记录}}\n\n分别列出已确认的结论、待澄清的问题和后续事项。\n每项后续事项写明负责人和计划日期，缺失项标记为「待确认」。",
      );
    await page.locator("#prompt-edit-body").focus();
    await page.waitForTimeout(250);
    const shot2 = path.join(screenshotDir, "02-prompts-editor.png");
    await capture(page, shot2);

    assert.deepEqual(pageErrors, [], "zero uncaught renderer errors");
    await closeApp();

    console.log(
      JSON.stringify(
        {
          passed: true,
          runDir,
          screenshots: {
            listDetail: shot1,
            editor: shot2,
            fillModal: shot3,
          },
          pageErrors,
        },
        null,
        2,
      ),
    );
  } catch (err) {
    console.error(err);
    if (application) {
      try {
        const wins = await application.windows();
        if (wins[0]) {
          await capture(wins[0], path.join(runDir, "failure.png"));
        }
        await application.evaluate(({ app }) => app.exit(1));
      } catch {}
    }
    process.exitCode = 1;
  }
})();

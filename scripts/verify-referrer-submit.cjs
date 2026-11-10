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
const root = path.resolve(__dirname, "..");
const dir = path.join(root, ".local", "referrer-submit-ui-" + Date.now());
fs.mkdirSync(dir, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const checks = [], errors = [];
let application, page;
async function launch() {
  const exe = process.env.WORKBENCH_GIT_EXE;
  application = await pw._electron.launch({ executablePath: exe || require("electron"), args: [...(exe ? [] : [root]), "--data-dir=" + path.join(dir, "data")], env, timeout: 60000 });
  if (exe) assert.equal(await application.evaluate(({ app }) => app.isPackaged), true);
  page = await application.firstWindow();
  page.on("pageerror", (error) => errors.push(error.message));
  await page.waitForSelector("[data-page=work]");
  await application.evaluate(({ dialog }) => {
    globalThis.workflowConfirmations = [];
    globalThis.workflowResponses = [];
    dialog.showMessageBox = async (_window, options) => {
      globalThis.workflowConfirmations.push(options);
      return { response: globalThis.workflowResponses.shift() ?? 0 };
    };
  });
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].setContentSize(1280, 800));
}
async function close() {
  if (!application) return;
  const closed = application.waitForEvent("close", { timeout: 10000 }).catch(() => {});
  await application.evaluate(({ app }) => {
    setTimeout(() => app.exit(0), 30);
    return true;
  }).catch(() => {});
  await closed;
  application = null;
}
function write(repo, file, text) {
  const target = path.join(repo, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}
function git(repo, ...args) {
  return execFileSync("git", ["--no-optional-locks", "-c", "core.quotepath=false", "-C", repo, ...args], {
    encoding: "utf8", windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
    stdio: "pipe",
  }).trimEnd();
}
function fixture(name, branch, file) {
  const folder = path.join(dir, name), remote = path.join(folder, "remote.git"), repo = path.join(folder, "client 中文 [路径]");
  fs.mkdirSync(folder);
  git(folder, "init", "--bare", "--initial-branch=" + branch, remote);
  git(folder, "clone", remote, repo);
  const hooks = path.join(folder, "empty-hooks");
  fs.mkdirSync(hooks);
  for (const [key, value] of Object.entries({ "user.name": "推荐官界面验收", "user.email": "referrer@example.invalid", "core.autocrlf": "false", "commit.gpgsign": "false", "core.hooksPath": hooks }))
    git(repo, "config", key, value);
  write(repo, file, "base source\n");
  if (name === "refsys-wechat") write(repo, "config.js", "remote config\n");
  if (name === "employee") write(repo, "store/index.js", "remote uniapp config\n");
  if (name === "refsys") for (let i = 0; i < 90; i++) write(repo, `src/scroll-${String(i).padStart(3, "0")}.java`, "base scroll\n");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "初始");
  git(repo, "push", "-u", "origin", branch);
  write(repo, file, name + " business change\n");
  return { repo, remote, folder, file };
}
async function rawApi(action, payload) {
  return page.evaluate(({ action, payload }) => window.workbench.call(action, payload), { action, payload });
}
async function api(action, payload) {
  const response = await rawApi(action, payload);
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
async function until(fn, label, timeout = 60000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error("Timed out: " + label);
}
async function task(projectId, state) {
  return until(async () => {
    const task = (await api("bootstrap")).tasks.find((task) => task.projectId === projectId);
    if (task && ["failed", "partial"].includes(task.state)) throw new Error(task.error);
    return task?.state === state ? task : false;
  }, projectId + " " + state);
}
const button = (name) => page.getByRole("button", { name, exact: true });
async function inspect() {
  await button("检查仓库与预览").click();
  await page.getByRole("heading", { name: "检查项", exact: true }).waitFor();
}
async function screenshot(name) {
  const cdp = await page.context().newCDPSession(page);
  const result = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: false, captureBeyondViewport: false });
  fs.writeFileSync(path.join(dir, name + ".png"), Buffer.from(result.data, "base64"));
  await cdp.detach();
}
async function nav(name) {
  await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name, exact: true }).click();
}
async function selectProject(id) {
  await page.getByLabel("Git 项目", { exact: true }).selectOption(id);
  await until(async () => (await page.locator(".git-current-branch").textContent()) === git(fixtures[id].repo, "branch", "--show-current"), "selected project status");
}
async function openSubmit() {
  await page.getByTitle('刷新（F5）').click();
  await page.locator(".git-toolbar").getByRole("button", { name: "一键提测", exact: true }).click();
  await page.locator(".git-submit-dialog .check-list").waitFor();
}
async function editorReady(file) {
  await until(async () => (await page.locator('.submit-diff-path').textContent()).startsWith(file) &&
    !(await page.locator('.submit-diff-host').getAttribute('aria-busy') === 'true') &&
    await page.locator('.submit-diff-host .editor.modified .view-lines:not(.line-delete)').count(), 'inline editor ' + file);
}
async function editInline(text) {
  await until(async () => (await page.locator('.submit-diff-toolbar button').last().textContent()).trim() !== '保存中…', 'previous save complete');
  await page.locator('.submit-diff-host .editor.modified .view-lines:not(.line-delete) > .view-line').last().click({ position: { x: 110, y: 10 } });
  await page.keyboard.press('Control+End');
  await page.keyboard.insertText(text);
  await until(async () => (await page.locator('.submit-diff-path').textContent()).includes('未保存'), 'editor dirty');
  await until(async () => (await page.locator('.submit-diff-host .editor.modified .view-lines:not(.line-delete)').textContent()).replaceAll('\u00a0',' ').includes(text.trim()), 'typed editor text appears');
}
async function answer(response) { await application.evaluate((_e, value) => globalThis.workflowResponses.push(value), response); }
async function checkSubmitFooter() {
  const toast = page.locator('.toast-close');
  await toast.evaluateAll((elements) => elements.forEach((element) => element.click()));
  for (const zoom of [1, 1.25, 1.5]) {
    await application.evaluate(({ BrowserWindow }, zoom) => {
      const win = BrowserWindow.getAllWindows()[0];
      win.setContentSize(1366, 768);
      win.webContents.setZoomFactor(zoom);
    }, zoom);
    await page.waitForTimeout(150);
    const before = await page.locator('.submit-footer').evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const button = element.querySelector('button.primary').getBoundingClientRect();
      return { top: rect.top, bottom: rect.bottom, height: innerHeight, button: { top: button.top, bottom: button.bottom, left: button.left, right: button.right }, width: innerWidth };
    });
    assert.ok(before.top >= 0 && before.bottom <= before.height, JSON.stringify({ zoom, before }));
    assert.ok(before.button.top >= 0 && before.button.bottom <= before.height && before.button.left >= 0 && before.button.right <= before.width);
    const layout = await page.locator('.git-submit-dialog').evaluate((dialog) => {
      const body = dialog.querySelector('.submit-body');
      const content = dialog.querySelector('.git-submit-content');
      const workspace = dialog.querySelector('.submit-workspace').getBoundingClientRect();
      const flow = dialog.querySelector('.submit-flow').getBoundingClientRect();
      const repository = dialog.querySelector('.submit-repository').getBoundingClientRect();
      return {
        outerOverflow: dialog.scrollHeight - dialog.clientHeight,
        bodyOverflow: body.scrollHeight - body.clientHeight,
        contentOverflow: content.scrollHeight - content.clientHeight,
        bodyOverflowY: getComputedStyle(body).overflowY,
        workspaceHeight: workspace.height,
        flowTop: flow.top, repositoryTop: repository.top,
        collapsed: dialog.querySelectorAll('details').length,
      };
    });
    assert.ok(layout.outerOverflow <= 1 && layout.bodyOverflow <= 1 && layout.contentOverflow <= 1, JSON.stringify({ zoom, layout }));
    assert.equal(layout.bodyOverflowY, 'hidden');
    assert.ok(layout.workspaceHeight >= 90, JSON.stringify({ zoom, layout }));
    assert.ok(Math.abs(layout.flowTop - layout.repositoryTop) < 1, 'flow uses the upper space beside repository information');
    assert.equal(layout.collapsed, 0, 'flow and checks are shown directly');
    for (const selector of ['.file-list']) {
      const scrolled = await page.locator('.git-submit-dialog ' + selector).evaluate((element) => {
        element.scrollTop = element.scrollHeight;
        return element.scrollTop;
      });
      assert.ok(scrolled > 0, selector + ' scrolls independently');
    }
    const bounds = await page.locator('.submit-diff-host').boundingBox();
    await page.mouse.move(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2);
    await page.mouse.wheel(0, 1300);
    await until(async () => Number(await page.locator('.submit-diff-host .idea-outer-scrollbar').getAttribute('aria-valuenow')) > 0, 'code scrolls independently');
    const after = await page.locator('.submit-footer').boundingBox();
    assert.ok(Math.abs(after.y - before.top) < 1, 'confirmation footer stays visible while panels scroll');
    for (const selector of ['.file-list'])
      await page.locator('.git-submit-dialog ' + selector).evaluate((element) => { element.scrollTop = 0; });
    await screenshot('submit-footer-' + zoom);
  }
  await application.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.setZoomFactor(1));
  await page.locator('.submit-body').evaluate((element) => { element.scrollTop = 0; });
  checks.push('1366×768 下 100%/125%/150% 无弹窗整体滚动；上方直接显示流程和全部检查项，文件与长差异独立滚动，确认栏固定可见');
}
const fixtures = {};
(async () => {
  try {
    const backend = fixtures.refsys = fixture("refsys", "test", "src/Referrer.java");
    const admin = fixtures["refsys-ui"] = fixture("refsys-ui", "main", "src/views/referrer/index.vue");
    const mini = fixtures["refsys-wechat"] = fixture("refsys-wechat", "dev", "pages/index.vue");
    const employee = fixtures.employee = fixture('employee', 'dev', 'pages/index.vue');
    git(backend.repo, "switch", "-c", "hotfix-推荐官界面验收");
    git(backend.repo, "push", "-u", "origin", "hotfix-推荐官界面验收");
    const localConfig = "本地推荐官测试配置\r\n保持原字节\r\n";
    write(mini.repo, "config.js", localConfig);
    git(mini.repo, "update-index", "--assume-unchanged", "config.js");
    for (const f of Object.values(fixtures)) write(f.repo, "AGENTS.md", "hidden untracked\n");
    await launch();
    const config = (await api("bootstrap")).config;
    for (const [id, f] of Object.entries(fixtures)) config.projects.find((p) => p.id === id).path = f.repo;
    await api("settings.save", config);
    await nav("Git 管理");
    if (process.env.WORKBENCH_SUBMIT_REVERT_ONLY) {
      await selectProject('refsys-ui');
      git(admin.repo, 'add', admin.file);
      await openSubmit();
      await page.getByRole('textbox', { name: '提交说明', exact: true }).fill('单栏 Revert 与撤销验收');
      await button('确认更新并预览提交').click();
      await task('refsys-ui', 'awaiting');
      await editorReady(admin.file);
      await editInline('// final editor draft\n');
      await page.keyboard.press('Control+s');
      await until(async () => !(await page.locator('.submit-diff-path').textContent()).includes('未保存'), 'focused save');
      const expected=fs.readFileSync(path.join(admin.repo,admin.file),'utf8');
      await page.keyboard.press('Control+Home');
      await page.locator('.submit-diff-host .git-revert-glyph').first().click();
      await until(() => git(admin.repo,'show',':'+admin.file)==='base source','focused Revert');
      await until(async () => !(await page.locator('.submit-diff-path').textContent()).includes('未保存') &&
        !(await page.locator('.submit-diff-toolbar button').last().textContent()).includes('保存中'), 'focused Revert saved');
      await page.keyboard.press('Control+z');
      await until(async () => (await page.locator('.submit-diff-path').textContent()).includes('未保存'), 'focused Undo');
      await page.keyboard.press('Control+s');
      await until(() => git(admin.repo,'show',':'+admin.file)===expected.trimEnd(),'focused Undo save re-stages file');
      await page.keyboard.press('Control+Home');
      await screenshot('inline-revert-unified');
      await button('提交并推送').click();
      await task('refsys-ui','success');
      assert.equal(git(admin.remote,'show','main:'+admin.file),expected.trimEnd());
      assert.deepEqual(errors,[]);
      const result={passed:true,checks:['提测单栏回退图标 Revert 立即保存和暂存；Ctrl+Z 后 Ctrl+S 可重新纳入已变干净的文件；最终推送保留代码与说明'],errors,dir};
      fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
      console.log(JSON.stringify(result));
      return;
    }
    await selectProject("refsys");
    assert.equal(await page.getByRole("navigation").getByRole("button", { name: "一键提测", exact: true }).count(), 0);
    assert.equal(await page.getByLabel("仅显示已跟踪目录下的未跟踪文件", { exact: true }).count(), 0);
    for (let i = 0; i < 90; i++) write(backend.repo, `src/scroll-${String(i).padStart(3, "0")}.java`, "unstaged scroll\n");
    await page.getByTitle("刷新（F5）").click();
    await until(async () => (await page.locator(".git-selectionbar label").textContent()).includes("91 个文件"), "scroll files ready");
    await page.locator(".git-virtual-files").evaluate((element) => { element.scrollTop = 1300; });
    await until(async () => (await page.locator(".git-virtual-files").evaluate((element) => element.scrollTop)) === 1300, "scroll ready");
    await nav("工作记录");
    await nav("Git 管理");
    await until(async () => (await page.locator(".git-virtual-files").evaluate((element) => element.scrollTop)) === 1300, "scroll restored");
    checks.push("离开再返回保留本地变更虚拟列表滚动位置");
    await page.getByLabel("搜索变更文件").fill("Referrer");
    await page.getByLabel("文件排序").selectOption("status");
    await page.getByLabel("选择当前列表全部文件").check();
    await page.locator(".git-file-row").first().click();
    await page.getByLabel("本地提交说明").fill("保留的提交说明");
    await nav("工作记录");
    await nav("Git 管理");
    assert.equal(await page.getByLabel("Git 项目").inputValue(), "refsys");
    assert.equal(await page.getByLabel("搜索变更文件").inputValue(), "Referrer");
    assert.equal(await page.getByLabel("文件排序").inputValue(), "status");
    assert.equal(await page.getByLabel("选择当前列表全部文件").isChecked(), true);
    assert.equal(await page.getByLabel("本地提交说明").inputValue(), "保留的提交说明");
    assert.equal(await application.evaluate(() => globalThis.workflowConfirmations.length), 0);
    assert.equal(await page.evaluate(() => window.__workbenchCanClose()), false);
    assert.equal(await application.evaluate(() => globalThis.workflowConfirmations.length), 1);
    checks.push("离开再返回保留所选项目、查询、排序、勾选、当前文件和提交说明；导航不提示丢弃，关闭应用仍保护未提交说明");
    await page.getByRole("tab", { name: "Git Log", exact: true }).click();
    await page.locator(".git-log-row").first().click();
    await page.locator(".git-log-detail code").waitFor();
    const selectedHash = await page.locator(".git-log-detail code").first().textContent();
    await nav("APK 打包");
    await nav("Git 管理");
    assert.equal(await page.getByRole("tab", { name: "Git Log", exact: true }).getAttribute("aria-selected"), "true");
    assert.equal(await page.locator(".git-log-detail code").first().textContent(), selectedHash);
    checks.push("Git 内部页签与选中提交详情保留");
    await page.locator(".git-toolbar").getByRole("button", { name: /^Commit/ }).click();
    const commit = page.getByRole("dialog", { name: "本地提交", exact: true });
    await commit.waitFor();
    assert.equal(await commit.getByRole("button", { name: "Commit", exact: true }).isDisabled(), true);
    await commit.getByRole("button", { name: "暂存当前列表", exact: true }).click();
    await until(() => commit.getByRole("button", { name: "Commit", exact: true }).isEnabled(), "staged commit enabled");
    await commit.getByLabel("本地提交说明").fill("界面本地提交");
    await commit.getByRole("button", { name: "Commit", exact: true }).click();
    await until(async () => !(await commit.count()), "commit modal closes");
    assert.equal(git(backend.repo, "log", "-1", "--format=%s"), "界面本地提交");
    assert.equal(fs.readFileSync(path.join(backend.repo, "AGENTS.md"), "utf8"), "hidden untracked\n");
    checks.push("顶部 Commit 打开提交窗口，暂存当前列表后真实创建本地 Commit");
    write(backend.repo, backend.file, "backend staged version\n");
    git(backend.repo, "add", backend.file);
    const backendLatest = "backend staged version\nlatest tracked edit\n" + Array.from({ length: 500 }, (_, i) => 'preview line ' + i).join('\n') + '\n';
    write(backend.repo, backend.file, backendLatest);
    write(backend.repo, 'src/NewReferrer.java', 'explicit new source\n');
    git(backend.repo, 'add', 'src/NewReferrer.java');
    await openSubmit();
    assert.equal(await page.locator(".git-submit-dialog select").count(), 0);
    await page.locator(".git-submit-dialog .file-item").filter({ hasText: backend.file }).click();
    await editorReady(backend.file);
    assert.match((await page.locator('.submit-diff-host .editor.modified .view-lines:not(.line-delete)').textContent()).replaceAll('\u00a0', ' '), /backend staged version/);
    assert.match((await page.locator('.submit-diff-host .editor.modified .view-lines:not(.line-delete)').textContent()).replaceAll('\u00a0', ' '), /latest tracked edit/);
    assert.equal(await page.locator('.git-submit-dialog .file-item').count(), 92);
    await page.getByRole("textbox", { name: "提交说明", exact: true }).fill("后端提测暂存与本次修改");
    await checkSubmitFooter();
    await screenshot("backend-tracked-preview");
    await button("确认提交并合并").click();
    await task("refsys", "success");
    assert.equal(git(backend.remote, "show", "test:" + backend.file), backendLatest.trimEnd());
    assert.equal(git(backend.remote, 'show', 'test:src/NewReferrer.java'), 'explicit new source');
    assert.equal(git(backend.repo, "branch", "--show-current"), "test");
    assert.equal((git(backend.repo, 'worktree', 'list', '--porcelain').match(/^worktree /gm) || []).length, 1);
    assert.equal(git(backend.remote, "show", "test:src/scroll-000.java"), "unstaged scroll");
    assert.equal(fs.readFileSync(path.join(backend.repo, backend.file), "utf8"), backendLatest);
    assert.equal(git(backend.repo, 'diff', '--name-only'), '');
    await button("关闭提测窗口").click();
    checks.push("后端提测纳入暂存与全部已跟踪修改，在原项目目录切换 test，不创建额外 worktree");
    git(admin.repo, "add", admin.file);
    write(admin.repo, admin.file, "refsys-ui business change\nunstaged admin\n");
    const adminPages = ['src/views/monitor/customerPhoneLog/index.vue', 'src/views/system/loginIpBlock/index.vue'];
    for (const file of adminPages) write(admin.repo, file, 'new admin page ' + file + '\n');
    write(admin.repo, 'dist.rar', 'local build artifact\n');
    await selectProject("refsys-ui");
    await page.getByLabel('变更范围').selectOption('all');
    for (const file of adminPages) {
      await page.getByLabel('搜索变更文件').fill(file);
      const row = page.locator('.git-file-row').filter({ hasText: file });
      await row.waitFor();
      await row.locator('input[type=checkbox]').check();
      await button('Stage').click();
      await until(() => git(admin.repo, 'diff', '--cached', '--name-only').includes(file), file + ' staged from UI');
    }
    await page.getByLabel("搜索变更文件").fill("nothing matches");
    await openSubmit();
    assert.equal(await page.locator(".git-submit-dialog .file-item").filter({ hasText: admin.file }).count(), 1);
    for (const file of adminPages)
      assert.equal(await page.locator('.git-submit-dialog .file-item').filter({ hasText: file }).count(), 1);
    const messageInput = () => page.getByRole('textbox', { name: '提交说明', exact: true });
    await messageInput().fill('前端更新前填写的提交说明');
    await page.locator('.git-submit-dialog .file-item').filter({ hasText: admin.file }).click();
    await editorReady(admin.file);
    await editInline('// Ctrl+S saved\n');
    await page.keyboard.press('Control+s');
    await until(() => fs.readFileSync(path.join(admin.repo, admin.file), 'utf8').includes('// Ctrl+S saved'), 'Ctrl+S writes working copy');
    assert.equal(git(admin.repo, 'show', ':' + admin.file), 'refsys-ui business change', 'initial save preserves existing index');
    await editInline('// blur saved\n');
    await messageInput().click();
    await until(() => fs.readFileSync(path.join(admin.repo, admin.file), 'utf8').includes('// blur saved'), 'blur saves after confirmation');
    await editInline('// cancelled draft\n');
    await answer(2);
    await page.locator('.git-submit-dialog .file-item').filter({ hasText: adminPages[0] }).click();
    await until(async () => (await page.locator('.submit-diff-path').textContent()).includes('未保存'), 'cancel keeps draft');
    assert.ok((await page.locator('.submit-diff-path').textContent()).startsWith(admin.file));
    await answer(2);
    assert.equal(await page.evaluate(() => window.__workbenchCanClose()), false, 'application close protects editor');
    await answer(2);
    await page.keyboard.press('Escape');
    await until(async () => (await application.evaluate(() => globalThis.workflowResponses.length)) === 0, 'Escape answered');
    assert.equal(await page.locator('.git-submit-dialog').count(), 1, 'Escape cancellation retains modal');
    await answer(1);
    await page.locator('.git-submit-dialog .file-item').filter({ hasText: adminPages[0] }).click();
    await editorReady(adminPages[0]);
    assert.doesNotMatch(fs.readFileSync(path.join(admin.repo, admin.file), 'utf8'), /cancelled draft/);
    await button('关闭提测窗口').click();
    await openSubmit();
    assert.equal(await messageInput().inputValue(), '前端更新前填写的提交说明');
    checks.push('前端初始预览显示并保存提交说明；单页编辑 Ctrl+S、离焦保存、取消切换、丢弃、Esc 与应用关闭保护均验证');
    await button("确认更新并预览提交").click();
    await task("refsys-ui", "awaiting");
    assert.equal(await messageInput().inputValue(), '前端更新前填写的提交说明');
    await page.locator('.git-submit-dialog .file-item').filter({ hasText: admin.file }).click();
    await editorReady(admin.file);
    for (const text of ['// final preview save one\n', '// final preview save two\n']) {
      await editInline(text);
      await page.keyboard.press('Control+s');
      await until(() => git(admin.repo, 'show', ':' + admin.file).includes(text.trim()), 'awaiting save updates index');
      await until(async () => !(await page.locator('.submit-diff-path').textContent()).includes('未保存'), 'save complete');
    }
    const expectedAdmin = fs.readFileSync(path.join(admin.repo, admin.file), 'utf8');
    await page.keyboard.press('Control+Home');
    await screenshot('admin-inline-edit-preview');
    await page.locator('.submit-diff-host .git-revert-glyph').first().click();
    await until(() => git(admin.repo, 'show', ':' + admin.file) === 'base source', 'inline Revert saves and stages HEAD content');
    await until(async () => !(await page.locator('.submit-diff-path').textContent()).includes('未保存') &&
      !(await page.locator('.submit-diff-toolbar button').last().textContent()).includes('保存中'), 'Revert saved');
    await page.keyboard.press('Control+z');
    await until(async () => (await page.locator('.submit-diff-path').textContent()).includes('未保存'), 'Revert is undoable');
    await page.keyboard.press('Control+s');
    await until(() => fs.readFileSync(path.join(admin.repo, admin.file), 'utf8') === expectedAdmin &&
      git(admin.repo, 'show', ':' + admin.file) === expectedAdmin.trimEnd(), 'undo after clean preview re-enters final index');
    checks.push('提测单栏回退图标实际保存 Revert；撤销后 Ctrl+S 重新纳入提交，保持连续保存能力');
    await page.getByRole("textbox", { name: "提交说明", exact: true }).fill("后台管理提交暂存与修改");
    await button("提交并推送").click();
    await task("refsys-ui", "success");
    assert.equal(git(admin.remote, "show", "main:" + admin.file), expectedAdmin.trimEnd());
    for (const file of adminPages)
      assert.equal(git(admin.remote, 'show', 'main:' + file), 'new admin page ' + file);
    assert.doesNotMatch(git(admin.remote, 'ls-tree', '-r', '--name-only', 'main'), /dist\.rar|AGENTS\.md/);
    assert.equal(fs.readFileSync(path.join(admin.repo, admin.file), "utf8"), expectedAdmin);
    await screenshot("admin-staged-success");
    await button("关闭提测窗口").click();
    checks.push("refsys-ui 新源码目录页面在主列表可见，实际通过 Stage 进入提测并推送；产物保持隐藏，搜索不影响提交范围");
    git(mini.repo, "add", mini.file);
    write(mini.repo, mini.file, "refsys-wechat business change\nunstaged mini\n");
    await selectProject("refsys-wechat");
    await openSubmit();
    await page.getByRole('textbox', { name: '提交说明', exact: true }).fill('小程序更新前的可编辑说明');
    await button("确认更新并保护本地配置").click();
    await task("refsys-wechat", "awaiting");
    assert.equal(await page.getByRole('textbox', { name: '提交说明', exact: true }).inputValue(), '小程序更新前的可编辑说明');
    await button("关闭提测窗口").click();
    await page.getByTitle("任务中心", { exact: true }).click();
    await page.locator(".task-select").filter({ hasText: "推荐官小程序提交" }).click();
    await button("返回核对并继续").click();
    await page.getByRole("dialog", { name: "一键提测", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Git 项目").inputValue(), "refsys-wechat");
    await page.getByRole("textbox", { name: "提交说明", exact: true }).fill("小程序提交暂存与修改");
    await button("提交并推送").click();
    await task("refsys-wechat", "success");
    assert.equal(git(mini.remote, "show", "dev:" + mini.file), "refsys-wechat business change\nunstaged mini");
    assert.equal(git(mini.remote, "show", "dev:config.js"), "remote config");
    assert.equal(fs.readFileSync(path.join(mini.repo, "config.js"), "utf8"), localConfig);
    assert.equal(fs.readFileSync(path.join(mini.repo, mini.file), "utf8"), "refsys-wechat business change\nunstaged mini\n");
    assert.match(git(mini.repo, "ls-files", "-v", "--", "config.js"), /^h /);
    await screenshot("mini-staged-success");
    checks.push("任务中心返回 Git 管理继续待确认提测，小程序 config.js 字节和标志保持");
    await button('关闭提测窗口').click();
    await selectProject('employee');
    await openSubmit();
    await page.getByRole('textbox', { name: '提交说明', exact: true }).fill('UniApp 更新前编辑的说明');
    await editorReady(employee.file);
    await editInline('// UniApp editor save\n');
    await page.keyboard.press('Control+s');
    await until(() => fs.readFileSync(path.join(employee.repo, employee.file), 'utf8').includes('UniApp editor save'), 'UniApp editor saved');
    await button('确认更新并保护本地配置').click();
    await task('employee', 'awaiting');
    assert.equal(await page.getByRole('textbox', { name: '提交说明', exact: true }).inputValue(), 'UniApp 更新前编辑的说明');
    await button('提交并推送').click();
    await task('employee', 'success');
    assert.equal(git(employee.remote, 'log', '-1', '--format=%s', 'dev'), 'UniApp 更新前编辑的说明');
    assert.match(git(employee.remote, 'show', 'dev:' + employee.file), /UniApp editor save/);
    assert.equal(git(employee.remote, 'show', 'dev:store/index.js'), 'remote uniapp config');
    checks.push('UniApp 从初始预览即可编辑说明和单页代码，保存后更新远程、保留说明并实际提交，受保护配置保持');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ passed: true, checks, errors, dir }, null, 2));
    console.log(JSON.stringify({ passed: true, checks, dir }, null, 2));
  } catch (error) {
    console.error(error);
    if (page) await screenshot("failure").catch(() => {});
    fs.writeFileSync(path.join(dir, "result.json"), JSON.stringify({ passed: false, checks, errors, error: error.stack, dir }, null, 2));
    process.exitCode = 1;
  } finally { await close(); }
})();

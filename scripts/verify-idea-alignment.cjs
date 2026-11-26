const path = require("node:path");
const fs = require("node:fs");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");
let playwright;
try { playwright = require("playwright"); }
catch { playwright = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"); }
const { _electron } = playwright;
const root = path.resolve(__dirname, "..");
const fixture = path.join(root, ".local", "idea-align-project-" + Date.now());
const second = path.join(root, ".local", "idea-align-second-" + Date.now());
const dataDir = path.join(root, ".local", "idea-align-data-" + Date.now());
for (const dir of [fixture, second]) fs.mkdirSync(path.join(dir, "src"), { recursive: true });
const mainJava = path.join(fixture, "src", "Main.java");
fs.writeFileSync(mainJava, [
  "package sample;",
  "",
  "import java.util.List;",
  "import java.util.Map;",
  "",
  "@RestController",
  "public class Main {",
  "  private CustomerService customerService;",
  "  public String label = \"hello\";",
  "  public void run() {",
  "    if (customerService != null) {",
  "      customerService.run();",
  "    }",
  "  }",
  "}",
  "",
  ...Array.from({ length: 100 }, (_, index) => `// History line ${index + 17}`),
  "",
].join("\n"));
fs.writeFileSync(path.join(fixture, "src", "App.vue"), [
  "<template>",
  '  <view @click="handleTap">点我</view>',
  "</template>",
  "<script>",
  "export default {",
  "  methods: {",
  "    handleTap() { this.fetchData(); },",
  "    fetchData() { console.log('tap'); }",
  "  }",
  "};",
  "</script>",
  "",
].join("\n"));
fs.writeFileSync(path.join(fixture, "src", "utils.js"), "export function fetchData(id) { return id; }\n");
fs.writeFileSync(path.join(fixture, "src", "page.html"), "<html><body>\n  <button onclick=\"fetchData()\">go</button>\n</body></html>\n");
for (let i = 0; i < 12; i++)
  fs.writeFileSync(path.join(fixture, "src", `Extra${i}.java`), `package sample;\nimport java.util.List;\n\npublic class Extra${i} {\n  private String value;\n}\n`);
fs.writeFileSync(second + path.sep + "src" + path.sep + "Second.java", "package sample2;\npublic class Second {}\n");
// 初始化 Git 仓库，供单文件提交历史（blame）验证使用
const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "tester", GIT_AUTHOR_EMAIL: "tester@example.com",
  GIT_AUTHOR_DATE: "2025-07-01T12:00:00+08:00",
  GIT_COMMITTER_NAME: "Tester", GIT_COMMITTER_EMAIL: "tester@example.com",
  GIT_COMMITTER_DATE: "2026-02-06T12:00:00+08:00",
};
execFileSync("git", ["-C", fixture, "init", "-q"], { env: gitEnv, stdio: "pipe" });
execFileSync("git", ["-C", fixture, "add", "-A"], { env: gitEnv, stdio: "pipe" });
execFileSync("git", ["-C", fixture, "commit", "-q", "-m", "initial import"], { env: gitEnv, stdio: "pipe" });
fs.writeFileSync(mainJava, fs.readFileSync(mainJava, "utf8").replace("// History line 72", "// Updated history line 72"));
execFileSync("git", ["-C", fixture, "commit", "-qam", "update line 72"], {
  env: { ...gitEnv, GIT_AUTHOR_NAME: "reviewer", GIT_AUTHOR_DATE: "2026-02-05T12:00:00+08:00" },
  stdio: "pipe",
});
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const blameOnly = process.argv.includes("--blame-only");
let application;
const errors = [];
async function api(page, name, payload) {
  const result = await page.evaluate(async ({ name, payload }) => window.workbench.call(name, payload), { name, payload });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
async function until(fn, label, attempts = 60) {
  for (let i = 0; i < attempts; i++) {
    if (await fn()) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`Timed out: ${label}`);
}
async function sendEditorCommand(command) {
  await application.evaluate(({ BrowserWindow }, name) => {
    const target = BrowserWindow.getAllWindows().find((win) => win.webContents.getURL().includes("/editor.html"));
    target?.emit("app-command", {}, name);
  }, command);
}
async function ctrlClickWord(page, text) {
  let point = null;
  for (let i = 0; i < 30 && !point; i++) {
    point = await page.evaluate((needle) => {
      for (const line of document.querySelectorAll(".monaco-editor .view-line")) {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const at = node.textContent.indexOf(needle);
          if (at < 0) continue;
          const range = document.createRange();
          range.setStart(node, at);
          range.setEnd(node, Math.min(node.textContent.length, at + Math.max(1, needle.length)));
          const rect = range.getBoundingClientRect();
          if (rect.width && rect.height) return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
        }
      }
      return null;
    }, text);
    if (!point) await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.ok(point, "找不到代码中的词：" + text);
  await page.keyboard.down("Control");
  await page.mouse.click(point.x, point.y);
  await page.keyboard.up("Control");
}
(async () => {
  try {
    application = await _electron.launch({ executablePath: require("electron"), args: [root, `--data-dir=${dataDir}`], env, timeout: 30000 });
    const main = await application.firstWindow();
    main.on("pageerror", (error) => errors.push(error.message));
    await main.waitForSelector('[data-page="work"]');

    if (!blameOnly) {
      // 1. 动作按钮统一淡蓝
      const buttons = await main.evaluate(() => [...document.querySelectorAll("button")]
        .filter((b) => !b.className.includes("link") && !b.className.includes("close"))
        .map((b) => getComputedStyle(b).backgroundColor));
      assert.ok(buttons.includes("rgb(234, 241, 255)"), `主界面按钮未统一为淡蓝：${JSON.stringify(buttons.slice(0, 8))}`);

      // 2. 项目页按钮顺序与文案
      await main.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "项目管理", exact: true }).click();
      await main.locator(".projects-actions button").first().waitFor();
      const actionLabels = await main.locator(".projects-actions button").allTextContents();
      const clean = actionLabels.map((s) => s.trim());
      assert.ok(!clean.includes("启动"), "项目操作区仍显示启动按钮");
      assert.ok(clean.indexOf("查看日志") < clean.indexOf("打开目录"), "查看日志未放到打开目录前");
      assert.ok(!clean.includes("打开开发者工具"), "详情区仍显示旧文案");
      const leftLabels = await main.locator(".project-item-actions button").allTextContents();
      assert.ok(!leftLabels.some((s) => s.includes("打开开发者工具")), "左列表仍有打开开发者工具");
      await main.locator(".project-item").filter({ hasText: "推荐官小程序" }).click();
      const wechatLabels = await main.locator(".projects-actions button").allTextContents();
      assert.ok(wechatLabels.some((s) => s.includes("打开微信开发者工具")), "详情区未改为打开微信开发者工具");

      // 3. 分支下拉框是白色下拉样式，不是淡蓝按钮
      await main.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "Git 管理", exact: true }).click();
      await main.locator(".git-branch-button").waitFor();
      const dropdownColor = await main.locator(".git-branch-button").evaluate((el) => getComputedStyle(el).backgroundColor);
      assert.equal(dropdownColor, "rgb(255, 255, 255)", `分支下拉框背景色错误：${dropdownColor}`);
    }

    const bootstrap = await api(main, "bootstrap");
    const config = bootstrap.config;
    config.projects.find((project) => project.id === "refsys-ui").path = fixture;
    config.projects.find((project) => project.id === "homeproject").path = second;
    await api(main, "settings.save", config);
    await api(main, "projects.editor", { projectId: "refsys-ui" });
    await until(async () => (await application.windows()).length === 2, "editor window");
    const editor = (await application.windows()).find((page) => page !== main);
    editor.on("pageerror", (error) => errors.push(error.message));
    await editor.waitForSelector(".editor-tree-row");
    await editor.locator('.editor-tree-row[data-file="src"]').click();
    await editor.locator('.editor-tree-row[data-file="src/Main.java"]').click();
    await until(async () => await editor.locator(".editor-tab.active").count() === 1, "open Main.java");

    // 4. IDEA 主题：关键字 / 字符串 / 注解 / 字段紫色 / null 蓝色 / 括号黑色
    const theme = await editor.evaluate(() => [...document.querySelectorAll("style")].map((s) => s.textContent).join("\n"));
    assert.match(theme, /color:\s*#0033b3/i, "关键字配色未对齐 IDEA");
    assert.match(theme, /color:\s*#067d17/i, "字符串配色未对齐 IDEA");
    assert.match(theme, /color:\s*#9e880d/i, "注解配色未对齐 IDEA");
    assert.match(theme, /--vscode-editorBracketHighlight-foreground1:\s*#000000/i, "括号彩虹配色未关闭");
    await until(async () => await editor.locator(".idea-java-field").count() > 0, "Java 字段紫色");
    await until(async () => await editor.locator(".idea-java-null").count() > 0, "null 蓝色关键字");
    const nullColor = await editor.locator(".idea-java-null").first().evaluate((el) => getComputedStyle(el).color);
    assert.equal(nullColor, "rgb(0, 51, 179)");

    // 5. 折叠箭头：import 常显、方法悬停才显示；印号与代码行垂直对齐
    await until(async () => await editor.locator(".cldr[class*='folding']").count() > 0, "折叠标记");
    await until(async () => await editor.locator(".idea-fold-import").count() > 0, "import 折叠行标记");
    const alignment = await editor.evaluate(() => {
      const icons = [...document.querySelectorAll(".margin-view-overlays .cldr[class*='folding']")];
      const importIcon = icons.find((icon) => icon.parentElement?.querySelector(":scope > .idea-fold-import"));
      const otherIcon = icons.find((icon) => icon !== importIcon && icon.classList.contains("codicon-folding-expanded"));
      const box = importIcon?.getBoundingClientRect();
      const lines = [...document.querySelectorAll(".monaco-editor .view-lines .view-line")];
      const nearest = box ? lines.reduce((best, line) => {
        const rect = line.getBoundingClientRect();
        const delta = Math.abs((rect.top + rect.bottom) / 2 - (box.top + box.bottom) / 2);
        return !best || delta < best.delta ? { delta } : best;
      }, null) : null;
      const before = importIcon ? getComputedStyle(importIcon, "::before") : null;
      const style = importIcon ? getComputedStyle(importIcon) : null;
      return {
        importOpacity: importIcon ? getComputedStyle(importIcon).opacity : null,
        otherOpacity: otherIcon ? getComputedStyle(otherIcon).opacity : null,
        fontSize: style?.fontSize, iconWidth: style?.width,
        glyph: before?.content, font: before?.fontFamily,
        delta: nearest?.delta,
      };
    });
    assert.equal(alignment.importOpacity, "1", "import 折叠箭头未常显");
    assert.equal(alignment.otherOpacity, "0", "方法折叠箭头不应常显（应悬停显示）");
    assert.equal(alignment.fontSize, "11px", "折叠箭头字号错误");
    assert.equal(alignment.iconWidth, "14px", "折叠箭头宽度错误");
    assert.ok(alignment.glyph && !["none", '""', "normal"].includes(alignment.glyph), "折叠箭头缺少字形");
    assert.match(alignment.font || "", /codicon/i, "折叠箭头未使用 IDEA 细箭头字体");
    assert.ok(alignment.delta <= 2, `折叠标记与代码行未对齐：${alignment.delta}px`);
    const hiddenLine = await editor.evaluate(() => [...document.querySelectorAll(".margin-view-overlays .line-numbers")]
      .some((item) => item.textContent.trim() === "4"));
    assert.equal(hiddenLine, false, "import 区域未默认折叠");
    // 方法折叠箭头：悬停 gutter 行时才出现
    await until(async () => {
      const index = await editor.evaluate(() => [...document.querySelectorAll(".margin-view-overlays > div")]
        .findIndex((line) => !line.querySelector(":scope > .idea-fold-import")
          && line.querySelector(".cldr.codicon-folding-expanded")));
      if (index < 0) return false;
      await editor.locator(".margin-view-overlays > div").nth(index).hover();
      return await editor.evaluate(() => {
        const icons = [...document.querySelectorAll(".margin-view-overlays .cldr[class*='folding']")];
        const target = icons.find((icon) => !icon.parentElement?.querySelector(":scope > .idea-fold-import")
          && icon.classList.contains("codicon-folding-expanded"));
        return target ? getComputedStyle(target).opacity === "1" : false;
      });
    }, "方法折叠箭头悬停显示", 30);
    await editor.screenshot({ path: path.join(root, ".local", "idea-alignment-java.png") });

    // 6. 文件图标按类型区分
    const icons = await editor.evaluate(() => [...document.querySelectorAll(".editor-tree-scroll .file-type-icon")]
      .map((item) => item.textContent.trim()).filter(Boolean));
    assert.ok(new Set(icons).size >= 4, `文件图标未区分：${JSON.stringify(icons)}`);

    // 6a. 文件搜索面板：图标不拉伸、行高正常
    await editor.keyboard.press("Control+Shift+R");
    await editor.locator(".editor-palette").waitFor();
    await editor.locator(".editor-palette input").fill("Main");
    await until(async () => await editor.locator(".editor-palette-list button").count() > 0, "文件搜索结果");
    const paletteRow = await editor.evaluate(() => {
      const row = document.querySelector(".editor-palette-list button");
      const icon = row?.querySelector(".file-type-icon");
      return {
        height: row?.getBoundingClientRect().height,
        iconWidth: icon?.getBoundingClientRect().width,
        text: row?.textContent?.trim() || "",
      };
    });
    assert.equal(paletteRow.height, 30, `文件搜索结果行高异常：${paletteRow.height}`);
    assert.ok(paletteRow.iconWidth <= 20, `文件图标被拉伸：${paletteRow.iconWidth}`);
    assert.ok(paletteRow.text.includes("Main.java"), "搜索结果内容错误");
    await editor.keyboard.press("Escape");

    // 6a2. Ctrl+G 转到指定行
    await editor.locator(".monaco-editor .view-line").first().click();
    await editor.keyboard.press("Control+g");
    await editor.locator(".editor-goto").waitFor();
    await editor.locator(".editor-goto input").fill("3");
    await editor.keyboard.press("Enter");
    await until(async () => (await editor.locator(".editor-statusbar span:last-child").textContent()).trim().startsWith("3:"),
      "Ctrl+G 转到指定行");

    // 6a3. 全局搜索：结果列表 + 文件类型筛选（无预览区）
    await editor.keyboard.press("Control+Shift+F");
    await editor.locator(".editor-search-panel").waitFor();
    await editor.locator(".editor-search-panel input").first().fill("Main");
    await until(async () => await editor.locator(".editor-search-hit").count() > 0, "全局搜索结果");
    assert.equal(await editor.locator(".editor-search-preview").count(), 0, "搜索面板仍有预览区");
    await editor.locator(".editor-search-hit").first().click();
    await until(async () => await editor.locator(".editor-jump-highlight").count() > 0, "点击搜索结果跳转");
    await editor.locator(".editor-search-filter").click();
    await editor.locator(".editor-search-types").waitFor();
    assert.equal(await editor.locator(".editor-search-types-list input[value='java']").count(), 1, "文件类型筛选缺少 java");
    await editor.locator(".editor-search-types-backdrop").click({ position: { x: 5, y: 5 } });
    await editor.keyboard.press("Escape");
    await until(async () => await editor.locator(".editor-search-panel").count() === 0, "关闭全局搜索");

    // 6b. 标签右键菜单：关闭 / 关闭其他 / 关闭左边 / 关闭右边 / 全部关闭（不含提交历史）
    await editor.locator(".editor-tab.active").click({ button: "right" });
    await editor.locator(".editor-tab-menu").waitFor();
    const tabMenuText = await editor.locator(".editor-tab-menu").textContent();
    for (const label of ["关闭其他", "关闭左边", "关闭右边", "关闭所有"]) {
      assert.ok(tabMenuText.includes(label), `标签右键菜单缺少：${label}`);
    }
    assert.ok(!tabMenuText.includes("提交历史"), "标签右键菜单仍有提交历史");
    await editor.keyboard.press("Escape");
    await editor.screenshot({ path: path.join(root, ".local", "idea-tab-menu.png") });

    // 6c. 单文件提交历史：右键 gutter 开启，每行显示、版本配色；右键标注列关闭
    await editor.locator(".margin-view-overlays .line-numbers").filter({ hasText: /^3$/ }).click({ button: "right" });
    await editor.locator(".editor-blame-menu").waitFor();
    assert.match(await editor.locator(".editor-blame-menu").textContent(), /显示提交历史/);
    await editor.locator(".editor-blame-menu button").click();
    await editor.locator('.editor-blame-row[data-line="3"]').waitFor();
    assert.equal(await editor.locator('.editor-blame-row[data-line="4"]').count(), 0, "折叠行出现历史标注");

    await editor.keyboard.press("Control+g");
    await editor.locator(".editor-goto input").fill("72");
    await editor.keyboard.press("Enter");
    const updatedRow = editor.locator('.editor-blame-row[data-line="72"]');
    await updatedRow.waitFor();
    assert.equal(await updatedRow.locator(".editor-blame-date").textContent(), "2026/2/5");
    assert.equal(await updatedRow.locator(".editor-blame-author").textContent(), "Reviewer");
    const previousRow = editor.locator('.editor-blame-row[data-line="71"]');
    assert.equal(await previousRow.locator(".editor-blame-date").textContent(), "2025/7/1");
    assert.equal(await previousRow.locator(".editor-blame-author").textContent(), "Tester");
    const background = (row) => row.evaluate((node) => getComputedStyle(node).backgroundColor);
    assert.equal(await background(updatedRow), "rgb(161, 190, 247)", "选中代码行覆盖了近期提交的底色");
    assert.equal(await background(previousRow), "rgb(243, 245, 250)", "较早提交底色不正确");
    await editor.keyboard.press("ArrowUp");
    await until(async () => (await editor.locator(".editor-statusbar span:last-child").textContent()).trim().startsWith("71:"),
      "移动到较早提交的代码行");
    assert.equal(await background(previousRow), "rgb(243, 245, 250)", "移动光标覆盖了较早提交的底色");
    assert.equal(await background(updatedRow), "rgb(161, 190, 247)", "移动光标改变了近期提交的底色");

    const blameBox = await editor.locator(".editor-blame").boundingBox();
    const beforeWheel = await updatedRow.boundingBox();
    await editor.mouse.move(blameBox.x + 25, blameBox.y + 100);
    await editor.mouse.wheel(0, 105);
    await until(async () => {
      const row = await updatedRow.boundingBox();
      return row && row.y < beforeWheel.y - 50;
    }, "从提交标注列滚动代码");
    const alignedRows = await editor.evaluate(() => {
      const lineNumbers = [...document.querySelectorAll(".margin-view-overlays .line-numbers")];
      const offsets = new Map(lineNumbers.map((line) => [line.textContent.trim(), line.getBoundingClientRect().top]));
      const rows = [...document.querySelectorAll(".editor-blame-row")];
      return rows.length > 10 && rows.every((row) => Math.abs(row.getBoundingClientRect().top - offsets.get(row.dataset.line)) <= 1);
    });
    assert.ok(alignedRows, "滚动后提交标注未与行号对齐");
    await editor.screenshot({ path: path.join(root, ".local", "idea-alignment-blame.png") });
    await updatedRow.click();
    await until(async () => (await application.windows()).length === 3, "blame 差异窗口");
    const diffPage = (await application.windows()).find((page) => page !== main && page !== editor);
    await diffPage.waitForSelector(".diff-window");
    await diffPage.close();
    await until(async () => (await application.windows()).length === 2, "关闭差异窗口");
    await editor.keyboard.press("Control+g");
    await editor.locator(".editor-goto input").fill("72");
    await editor.keyboard.press("Enter");
    await editor.keyboard.press("Enter");
    await updatedRow.locator(".editor-blame-local").waitFor();
    assert.equal(await editor.locator('.editor-blame-row[data-line="73"] .editor-blame-author').textContent(), "Reviewer");
    await editor.keyboard.press("Control+z");
    await until(async () => (await updatedRow.locator(".editor-blame-author").allTextContents())[0] === "Reviewer", "撤销后恢复提交归属");

    await editor.mouse.click(blameBox.x + 40, blameBox.y + 40, { button: "right" });
    await editor.locator(".editor-blame-menu").waitFor();
    assert.match(await editor.locator(".editor-blame-menu").textContent(), /关闭提交历史/);
    await editor.locator(".editor-blame-menu button").click();
    await until(async () => await editor.locator(".editor-blame-row").count() === 0, "关闭提交历史");
    if (blameOnly) {
      assert.deepEqual(errors, []);
      console.log(JSON.stringify({ passed: true, screenshot: ".local/idea-alignment-blame.png" }));
      return;
    }
    await editor.locator(".editor-tab.active").click();
    await editor.keyboard.press("Control+Home");
    await editor.locator(".monaco-editor .view-line").filter({ hasText: /\bcustomerService\b/ }).first().waitFor();

    // 6d. Ctrl 悬停可跳转代码：变蓝 + 手型光标
    const hoverPoint = await editor.evaluate(() => {
      for (const line of document.querySelectorAll(".monaco-editor .view-line")) {
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          const index = node.textContent.indexOf("customerService");
          if (index < 0) continue;
          const range = document.createRange();
          range.setStart(node, index);
          range.setEnd(node, index + 6);
          const rect = range.getBoundingClientRect();
          if (rect.width) return { x: rect.left + 2, y: rect.top + rect.height / 2 };
        }
      }
      return null;
    });
    assert.ok(hoverPoint, "找不到 customerService");
    await editor.keyboard.down("Control");
    await editor.mouse.move(hoverPoint.x, hoverPoint.y);
    await until(async () => await editor.locator(".idea-ctrl-link").count() > 0, "Ctrl 悬停高亮");
    const linkStyle = await editor.locator(".idea-ctrl-link").first().evaluate((el) => getComputedStyle(el).color);
    assert.equal(linkStyle, "rgb(17, 85, 204)");
    const hoverCursor = await editor.locator(".monaco-editor .view-lines").evaluate((el) => getComputedStyle(el).cursor);
    assert.equal(hoverCursor, "pointer");
    await editor.keyboard.up("Control");

    // 7. Ctrl+D 删除当前行 + 自动保存（无保存按钮）
    assert.equal(await editor.locator(".editor-header-actions button").count(), 2, "保存按钮未移除");
    const before = fs.readFileSync(mainJava, "utf8");
    await editor.locator(".monaco-editor .view-line").filter({ hasText: "public String label" }).first().click();
    await editor.keyboard.press("Control+d");
    await until(() => fs.readFileSync(mainJava, "utf8") !== before, "Ctrl+D + 自动保存");
    assert.ok(!fs.readFileSync(mainJava, "utf8").includes('public String label = "hello";'), "Ctrl+D 未删除目标行");
    await until(async () => await editor.locator(".editor-dirty").count() === 0, "自动保存后清除脏标记");

    // 8. Ctrl+Tab 切换上个文件
    await editor.locator('.editor-tree-row[data-file="src/App.vue"]').click();
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "App.vue", "open App.vue");
    await editor.keyboard.press("Control+Tab");
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "Main.java", "Ctrl+Tab 切换上个文件");

    // 9. uni-app：template @click -> <script> 定义；HTML onclick -> 外部 JS
    await editor.locator('.editor-tab').filter({ hasText: "App.vue" }).click();
    await ctrlClickWord(editor, "handleTap");
    await until(async () => await editor.locator(".editor-jump-highlight").count() > 0, "Vue @click 跳转定义");
    await editor.locator('.editor-tree-row[data-file="src/page.html"]').click();
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "page.html", "open page.html");
    await ctrlClickWord(editor, "onclick");
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "utils.js", "HTML onclick 跳转外部 JS");

    // 9b. Ctrl+Tab 不松手：默认上次打开，继续 Tab 向下循环，松开才切换
    await editor.keyboard.down("Control");
    await editor.keyboard.press("Tab");
    await editor.locator(".editor-switcher").waitFor();
    const firstPick = (await editor.locator(".editor-switcher-row.selected .editor-switcher-name").textContent()).trim();
    assert.equal(firstPick, "page.html", `切换器默认项错误：${firstPick}`);
    await editor.keyboard.press("Tab");
    const secondPick = (await editor.locator(".editor-switcher-row.selected .editor-switcher-name").textContent()).trim();
    assert.equal(secondPick, "App.vue", `切换器未向下循环：${secondPick}`);
    await editor.screenshot({ path: path.join(root, ".local", "idea-switcher.png") });
    await editor.keyboard.up("Control");
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "App.vue", "松开 Ctrl 才切换文件");

    // 9c. 标签右键菜单的实际关闭范围
    const appTab = editor.locator(".editor-tab").filter({ hasText: "App.vue" });
    await appTab.click({ button: "right" });
    await editor.locator(".editor-tab-menu button").filter({ hasText: "关闭右边" }).click();
    await until(async () => await editor.locator(".editor-tab").count() === 2, "关闭右边");
    await appTab.click({ button: "right" });
    await editor.locator(".editor-tab-menu button").filter({ hasText: "关闭左边" }).click();
    await until(async () => await editor.locator(".editor-tab").count() === 1, "关闭左边");

    // 9d. 标签溢出：无滚动条，右侧箭头下拉选择
    for (let i = 0; i < 12; i++) {
      await editor.locator(`.editor-tree-row[data-file="src/Extra${i}.java"]`).click();
      await new Promise((r) => setTimeout(r, 150));
    }
    await until(async () => await editor.locator(".editor-tab-more").count() === 1, "标签溢出箭头");
    const tabOverflow = await editor.locator(".editor-tabs").evaluate((el) => getComputedStyle(el).scrollbarWidth);
    assert.equal(tabOverflow, "none", "标签栏仍有滚动条");
    await editor.locator(".editor-tab-more").click();
    await editor.locator(".editor-tab-list").waitFor();
    const totalTabs = await editor.locator(".editor-tab").count();
    const tabListCount = await editor.locator(".editor-tab-list button").count();
    assert.ok(tabListCount > 0 && tabListCount < totalTabs,
      `标签下拉应只列出未显示的标签：${tabListCount}/${totalTabs}`);
    await editor.locator(".editor-tab-list button").filter({ hasText: "Extra0.java" }).click();
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "Extra0.java", "从标签下拉切换");

    // 9e. 鼠标侧键：跨文件回到上个光标位置
    await editor.locator(".editor-tab").filter({ hasText: "App.vue" }).click();
    await editor.locator(".monaco-editor .view-line").first().click();
    await new Promise((r) => setTimeout(r, 500));
    await editor.locator(".editor-tab").filter({ hasText: "Extra0.java" }).click();
    await editor.locator(".monaco-editor .view-line").first().click();
    await new Promise((r) => setTimeout(r, 500));
    await sendEditorCommand("browser-backward");
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "App.vue", "侧键后退");
    await new Promise((r) => setTimeout(r, 300));
    await sendEditorCommand("browser-forward");
    await until(async () => (await editor.locator(".editor-tab.active .editor-tab-name").textContent()) === "Extra0.java", "侧键前进");

    // 10. 编辑器窗口按钮淡蓝
    const editorButton = await editor.locator(".editor-header-actions button").first().evaluate((el) => getComputedStyle(el).backgroundColor);
    assert.equal(editorButton, "rgb(234, 241, 255)");

    // 11. 项目切换面板：本窗口 / 新窗口
    await editor.locator(".editor-project-title").click();
    await editor.locator(".editor-project-picker").waitFor();
    const currentProject = editor.locator('.editor-project-row[aria-current="true"]');
    assert.equal(await currentProject.locator(".editor-project-info strong").textContent(), "refsys-ui");
    assert.equal(await editor.locator(".editor-project-count").count(), 0);
    assert.ok((await editor.locator(".editor-project-picker").textContent()).includes("本窗口切换"));
    assert.ok((await editor.locator(".editor-project-picker").textContent()).includes("新窗口打开"));
    const rows = editor.locator(".editor-project-row");
    await until(async () => (await rows.count()) >= 2, "项目列表");
    const targetRow = rows.filter({ hasText: "homeproject" }).first();
    await targetRow.locator("button").filter({ hasText: "本窗口切换" }).click();
    await until(async () => (await editor.locator(".editor-project-title strong").textContent()) === "homeproject", "本窗口切换项目");
    await until(async () => await editor.locator(".editor-tree-row").count() > 0, "切换后加载目录");
    // 新窗口打开：切换后再次打开选择器，另开一个窗口
    await editor.locator(".editor-project-title").click();
    await editor.locator(".editor-project-picker").waitFor();
    assert.equal(await currentProject.locator(".editor-project-info strong").textContent(), "homeproject");
    await rows.filter({ hasText: "refsys-ui" }).first().locator("button").filter({ hasText: "新窗口打开" }).click();
    await until(async () => (await application.windows()).length === 3, "新窗口打开项目");
    await editor.screenshot({ path: path.join(root, ".local", "idea-alignment.png") });
    assert.deepEqual(errors, []);
    console.log(JSON.stringify({ passed: true, screenshot: ".local/idea-alignment.png" }));
  } finally {
    if (application) await application.evaluate(({ app }) => app.exit(0));
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });

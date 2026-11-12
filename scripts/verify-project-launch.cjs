const fs = require("node:fs"), path = require("node:path"), http = require("node:http"), assert = require("node:assert/strict");
let pw;
try { pw = require("playwright"); }
catch { pw = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright"); }
const root = path.resolve(__dirname, ".."), dir = path.join(root, ".local", "project-launch-" + Date.now()), data = path.join(dir, "data");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const write = (file, value) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, value); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function port() {
  const server = http.createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const value = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return value;
}
async function cdp(url) {
  const socket = new WebSocket(url), pending = new Map();
  let id = 0;
  await new Promise((resolve, reject) => { socket.addEventListener("open", resolve, { once: true }); socket.addEventListener("error", reject, { once: true }); });
  socket.addEventListener("message", ({ data }) => {
    const message = JSON.parse(data), item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id);
    clearTimeout(item.timer);
    message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
  });
  return {
    close: () => socket.close(),
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const seq = ++id;
        const timer = setTimeout(() => { pending.delete(seq); reject(new Error("CDP timeout: " + method)); }, 15000);
        pending.set(seq, { resolve, reject, timer });
        socket.send(JSON.stringify({ id: seq, method, params, sessionId }));
      });
    },
  };
}
let app, page;
const browsers = [], owned = [], report = { checks: [], apps: [] };
async function api(name, payload) {
  const result = await page.evaluate(({ name, payload }) => window.workbench.call(name, payload), { name, payload });
  if (!result.ok) throw new Error(result.error);
  return result.data;
}
async function task(id) {
  for (let i = 0; i < 800; i++) {
    const result = (await api("bootstrap")).tasks.find((item) => item.id === id);
    if (!["running", "cancelling"].includes(result.state)) {
      assert.equal(result.state, "success", result.error || "");
      return result;
    }
    await sleep(250);
  }
  throw new Error("Task timed out");
}
(async () => {
  try {
    const { browserProfile } = await import("../dist/core/project-browser.js");
    app = await pw._electron.launch({ executablePath: process.env.WORKBENCH_VERIFY_EXE || require("electron"), args: [...(process.env.WORKBENCH_VERIFY_EXE ? [] : [root]), "--data-dir=" + data], env, timeout: 45000 });
    page = await app.firstWindow();
    await page.waitForSelector("[data-page=work]");
    await app.evaluate(({ shell }) => {
      globalThis.__openedProjectUrls = [];
      shell.openExternal = async (url) => { globalThis.__openedProjectUrls.push(url); };
    });
    const config = (await api("bootstrap")).config;
    const cli = path.join(dir, "uni-cli.cjs");
    write(cli, `const fs=require('node:fs'),path=require('node:path');if(process.env.BROWSER!=='none')process.exit(8);if(process.env.UNI_PLATFORM==='mp-weixin'){const out=process.env.UNI_OUTPUT_DIR;fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'app.json'),'{}');fs.writeFileSync(path.join(out,'project.config.json'),'{}');console.log('Compiled successfully');setInterval(()=>{},1000);}else{const p=JSON.parse(fs.readFileSync(path.join(process.env.UNI_INPUT_DIR,'manifest.json'))).h5.devServer.port;require('node:http').createServer((q,r)=>{r.setHeader('Content-Type','text/html; charset=utf-8');r.end('<meta name="viewport" content="width=device-width,initial-scale=1"><title>APP 调试验收</title><h1>手机调试</h1><p>320 × 652</p>')}).listen(p,'127.0.0.1',()=>console.log('Local: http://127.0.0.1:'+p+'/'));}`);
    config.tools.hbNode = process.execPath;
    config.tools.hbCli = cli;
    const tools = path.join(dir, "wechat-tools");
    fs.mkdirSync(tools, { recursive: true });
    write(path.join(tools, "package.json"), JSON.stringify({ type: "commonjs" }));
    fs.copyFileSync(process.execPath, path.join(tools, "node.exe"));
    const wechatCalls = path.join(dir, "wechat-calls.jsonl");
    write(path.join(tools, "cli.js"), `require('node:fs').appendFileSync(${JSON.stringify(wechatCalls)},JSON.stringify(process.argv.slice(2))+'\\n');`);
    config.tools.wechat = path.join(tools, "wechat.exe");
    for (const project of config.projects) {
      project.path = path.join(dir, "projects", project.id);
      fs.mkdirSync(project.path, { recursive: true });
      if (["h5", "uni-wechat"].includes(project.type))
        write(path.join(project.path, "manifest.json"), JSON.stringify({ h5: { devServer: { port: await port() } } }));
      if (project.type === "wechat")
        write(path.join(project.path, "project.config.json"), JSON.stringify({ compileType: "miniprogram" }));
    }
    const vue = config.projects.find((p) => p.id === "refsys-ui");
    const vuePort = await port();
    write(path.join(vue.path, "package.json"), JSON.stringify({ scripts: { dev: "vue-cli-service serve" } }));
    write(path.join(vue.path, "vue.config.js"), `const port = process.env.port || ${vuePort}; module.exports = { devServer: { port, open: true } };`);
    // Exercise the installed Vue CLI's actual openBrowser implementation with open:true.
    const originalOpenBrowser = "D:/IdeaProjects/refsys-ui/node_modules/@vue/cli-shared-utils/lib/openBrowser.js";
    assert.ok(fs.existsSync(originalOpenBrowser));
    write(path.join(vue.path, "node_modules/@vue/cli-service/bin/vue-cli-service.js"), `if(require(${JSON.stringify(originalOpenBrowser)}).openBrowser('http://127.0.0.1:${vuePort}/')!==false)process.exit(9);require('node:http').createServer((q,r)=>r.end('vue ready')).listen(${vuePort},'127.0.0.1',()=>console.log('Local: http://127.0.0.1:${vuePort}/'));`);
    await api("settings.save", config);
    await page.getByRole("navigation", { name: "主导航" }).getByRole("button", { name: "项目运行", exact: true }).click();
    for (const name of ["客户小程序", "推荐官小程序"]) {
      const row = page.locator(".project-item").filter({ has: page.locator(".project-name", { hasText: name }) });
      assert.equal(await row.getByRole("button", { name: "打开 IDE", exact: true }).count(), 0);
      assert.equal(await row.getByRole("button", { name: "打开开发者工具", exact: true }).count(), 1);
    }
    report.checks.push("两个小程序均无打开 IDE，均有打开开发者工具");
    console.log("Verified mini-program actions");
    const vueStart = await api("projects.start", { projectId: vue.id });
    owned.push(vue.id);
    await task(vueStart.taskId);
    assert.equal((await app.evaluate(() => globalThis.__openedProjectUrls)).length, 1);
    await api("projects.start", { projectId: vue.id });
    assert.equal((await app.evaluate(() => globalThis.__openedProjectUrls)).length, 1);
    report.checks.push("refsys-ui 的 open:true 被禁用，工作台只打开一次，重复启动复用");
    console.log("Verified single refsys-ui open");
    for (const id of ["employee", "projectman", "worker", "driver"]) {
      const project = config.projects.find((p) => p.id === id);
      const started = await api("projects.start", { projectId: id });
      owned.push(id);
      await task(started.taskId);
      const profile = browserProfile(data, project);
      const [debugPort, browserPath] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
      const connection = await cdp(`ws://127.0.0.1:${debugPort}${browserPath}`);
      browsers.push(connection);
      const browser = await pw.chromium.connectOverCDP(`http://127.0.0.1:${debugPort}`);
      const target = browser.contexts()[0].pages().find((p) => p.url().startsWith(started.run.url || "http://127.0.0.1:"));
      assert.ok(target, id + " page");
      await target.waitForFunction(() => screen.width === 320 && screen.height === 652 && innerWidth === 320 && navigator.maxTouchPoints > 0);
      const metrics = await target.evaluate((id) => {
        document.cookie = "projectSession=" + id;
        return { width: screen.width, height: screen.height, viewport: innerWidth, touch: navigator.maxTouchPoints, ua: navigator.userAgent, cookie: document.cookie };
      }, id);
      assert.match(metrics.ua, /Mobile/);
      const getDevtools = async () => (await connection.send("Target.getTargets")).targetInfos.find((item) => item.url.startsWith("devtools://"));
      let devtools;
      for (let i = 0; i < 60 && !devtools; i++) { devtools = await getDevtools(); if (!devtools) await sleep(100); }
      assert.ok(devtools, "DevTools auto opened");
      const { sessionId } = await connection.send("Target.attachToTarget", { targetId: devtools.targetId, flatten: true });
      const result = await connection.send("Runtime.evaluate", {
        expression: `(async()=>{const C=await import('./core/common/common.js');const U=await import('./ui/legacy/legacy.js');const settings=C.Settings.Settings.instance();return {dock:U.DockController.DockController.instance().dockSide(),panel:settings.createSetting('panel-selected-tab','').get(),device:settings.createSetting('emulation.show-device-mode',false).get(),text:document.body.innerText.slice(0,1500)}})()`,
        awaitPromise: true, returnByValue: true,
      }, sessionId);
      assert.ok(!result.exceptionDetails, JSON.stringify(result.exceptionDetails));
      const settings = result.result.value;
      assert.equal(settings.dock, "right");
      assert.equal(settings.panel, "network");
      assert.equal(settings.device, true);
      const appPages = (targets) => targets.filter((t) => t.type === "page" && !t.url.startsWith("devtools://"));
      const targetsBefore = appPages((await connection.send("Target.getTargets")).targetInfos).length;
      await Promise.all([api("projects.url", { projectId: id }), api("projects.url", { projectId: id })]);
      assert.equal(appPages((await connection.send("Target.getTargets")).targetInfos).length, targetsBefore);
      assert.equal(targetsBefore, 1);
      report.apps.push({ id, profile, metrics, settings, pages: targetsBefore });
      console.log("Verified mobile browser: " + id);
      // Disconnect Playwright without closing the independently launched browser.
      await browser.close();
    }
    report.checks.push("四个 APP 独立配置与实例，320×652、触摸、手机 UA、右侧 DevTools 网络面板，重复打开无新增标签");
    for (const item of report.apps) {
      const connection = browsers[report.apps.indexOf(item)];
      const target = (await connection.send("Target.getTargets")).targetInfos.find((t) => t.type === "page" && !t.url.startsWith("devtools://"));
      const { sessionId } = await connection.send("Target.attachToTarget", { targetId: target.targetId, flatten: true });
      const result = await connection.send("Runtime.evaluate", { expression: "document.cookie", returnByValue: true }, sessionId);
      assert.equal(result.result.value, "projectSession=" + item.id);
    }
    report.checks.push("四个 APP 同一主机的 Cookie 相互隔离");
    const mini = await api("projects.start", { projectId: "refsys-wechat" });
    owned.push("refsys-wechat");
    const miniTask = await task(mini.taskId);
    assert.equal(miniTask.stages.at(-1).name, "打开微信开发者工具");
    const expected = path.join(config.projects.find((p) => p.id === "refsys-wechat").path, "unpackage/dist/dev/mp-weixin");
    assert.deepEqual(JSON.parse(fs.readFileSync(wechatCalls, "utf8").trim()), ["open", "--project", expected]);
    assert.equal((await api("projects.inspect", { projectId: "refsys-wechat" })).state, "watching");
    report.checks.push("推荐官小程序启动后自动打开微信 CLI 并传递实际 mp-weixin 编译目录");
    report.success = true;
    console.log(JSON.stringify({ dir, checks: report.checks, apps: report.apps.map(({ id, metrics, settings, pages }) => ({ id, metrics, settings, pages })) }, null, 2));
  } catch (error) {
    report.error = error.stack;
    console.error(error);
    process.exitCode = 1;
  } finally {
    for (const connection of browsers) {
      try { await connection.send("Browser.close"); } catch {}
      connection.close();
    }
    for (const id of owned) { try { await api("projects.stop", { projectId: id }); } catch {} }
    if (app) {
      await app.evaluate(({ dialog }) => { dialog.showMessageBox = async () => ({ response: 1 }); }).catch(() => {});
      await app.close();
    }
    write(path.join(dir, "result.json"), JSON.stringify(report, null, 2));
  }
})();

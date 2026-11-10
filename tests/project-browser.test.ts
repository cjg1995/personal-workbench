import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { defaults } from "../src/core/config.js";
import { ProjectBrowser, browserProfile } from "../src/core/project-browser.js";

test("四个 APP 按项目及工作目录隔离浏览器配置，其他项目使用默认浏览器并校验协议", async () => {
  const dir = path.resolve(".local/browser-tests", randomUUID());
  const config = defaults(dir), opened: string[] = [];
  const browser = new ProjectBrowser(dir, async (url) => { opened.push(url); });
  const apps = config.projects.filter((p) => ["employee", "projectman", "worker", "driver"].includes(p.id));
  assert.equal(new Set(apps.map((p) => browserProfile(dir, p))).size, 4);
  assert.notEqual(browserProfile(dir, apps[0]), browserProfile(dir, { ...apps[0], path: apps[0].path + "-worktree" }));
  for (const id of ["refsys-ui", "wecom", "homeproject"])
    await browser.open(config.projects.find((p) => p.id === id)!, "http://localhost:8080/");
  assert.equal(opened.length, 3);
  await assert.rejects(browser.open(apps[0], "file:///C:/test"), /协议/);
  assert.equal(fs.existsSync(path.join(dir, "browsers")), false);
});

test("已运行 APP 重复或并发打开只激活原页面，保留当前路由与浏览器配置", async () => {
  const dir = path.resolve(".local/browser-tests", randomUUID());
  const project = defaults(dir).projects.find((p) => p.id === "employee")!;
  const profile = browserProfile(dir, project), calls: string[] = [];
  const browserPath = "/devtools/browser/" + randomUUID();
  const server = http.createServer((req, res) => {
    calls.push(req.method + " " + req.url);
    res.setHeader("Content-Type", "application/json");
    if (req.url === "/json/version") res.end(JSON.stringify({ webSocketDebuggerUrl: `ws://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}${browserPath}` }));
    else if (req.url === "/json/list") res.end(JSON.stringify([{ id: "app-tab", type: "page", url: "http://localhost:8082/#/logged-in" }]));
    else if (req.url === "/json/activate/app-tab") res.end("Target activated");
    else { res.statusCode = 400; res.end("unexpected request"); }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    fs.mkdirSync(path.join(profile, "Default"), { recursive: true });
    const preferences = path.join(profile, "Default/Preferences");
    fs.writeFileSync(preferences, "active profile: must not rewrite");
    fs.writeFileSync(path.join(profile, "DevToolsActivePort"), `${(server.address() as import("node:net").AddressInfo).port}\n${browserPath}`);
    const browser = new ProjectBrowser(dir, async () => { throw new Error("must not use default browser"); });
    await Promise.all([browser.open(project, "http://localhost:8082/"), browser.open(project, "http://localhost:8082/")]);
    assert.equal(calls.filter((call) => call.includes("/json/activate/")).length, 1);
    await new ProjectBrowser(dir, async () => {}).open(project, "http://localhost:8082/");
    assert.equal(calls.filter((call) => call.includes("/json/activate/")).length, 2);
    assert.equal(calls.some((call) => call.includes("/json/new")), false);
    assert.equal(fs.readFileSync(preferences, "utf8"), "active profile: must not rewrite");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

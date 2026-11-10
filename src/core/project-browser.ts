import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { ProjectConfig } from "../shared/types.js";
import { atomicWrite, hash } from "./util.js";
import { processes } from "./process.js";

const mobileProjects = new Set(["employee", "projectman", "worker", "driver"]);
interface Target {
  id: string;
  type: string;
  url: string;
}

export function chromeExecutable() {
  const executable = [
    path.join(process.env.PROGRAMFILES || "C:/Program Files", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env["PROGRAMFILES(X86)"] || "C:/Program Files (x86)", "Google/Chrome/Application/chrome.exe"),
    path.join(process.env.LOCALAPPDATA || "", "Google/Chrome/Application/chrome.exe"),
  ].find((file) => fs.existsSync(file));
  if (!executable) throw new Error("未找到 Google Chrome，请安装后重新打开 APP 页面");
  return executable;
}

export function browserProfile(dataDir: string, project: ProjectConfig) {
  return path.join(dataDir, "browsers", `${project.id}-${hash(path.resolve(project.path).toLowerCase()).slice(0, 12)}`);
}

function prepareProfile(profile: string) {
  const file = path.join(profile, "Default", "Preferences");
  // Only update our own inactive profile, preserving cookies and other preferences.
  const preferences = fs.existsSync(file)
    ? JSON.parse(fs.readFileSync(file, "utf8"))
    : {};
  preferences.devtools ??= {};
  preferences.devtools.preferences = {
    ...preferences.devtools.preferences,
    currentDockState: JSON.stringify("right"),
    "panel-selected-tab": JSON.stringify("network"),
    "emulation.show-device-mode": "true",
    "emulation.device-mode-value": JSON.stringify({ device: "", orientation: "", mode: "" }),
    "emulation.device-width": "320",
    "emulation.device-height": "652",
    "emulation.device-scale": "1",
    "emulation.device-ua": JSON.stringify("Mobile"),
    "emulation.auto-adjust-scale": "true",
    "inspector-view.split-view-state": JSON.stringify({ vertical: { size: 1000 } }),
  };
  preferences.session = { ...preferences.session, restore_on_startup: 5 };
  preferences.browser = { ...preferences.browser, check_default_browser: false };
  atomicWrite(file, JSON.stringify(preferences));
}

async function request(endpoint: string, route: string, method = "GET") {
  const response = await fetch(endpoint + route, {
    method,
    signal: AbortSignal.timeout(1500),
  });
  if (!response.ok) throw new Error(`调试浏览器响应失败（${response.status}）`);
  return response;
}

async function activeEndpoint(profile: string) {
  try {
    const [port, browserPath] = fs.readFileSync(path.join(profile, "DevToolsActivePort"), "utf8").trim().split(/\r?\n/);
    if (!/^\d+$/.test(port) || !browserPath?.startsWith("/devtools/browser/")) return;
    const endpoint = `http://127.0.0.1:${Number(port)}`;
    const version = await (await request(endpoint, "/json/version")).json() as { webSocketDebuggerUrl?: string };
    // A stale port file must never activate an unrelated browser at a reused port.
    if (version.webSocketDebuggerUrl === `ws://127.0.0.1:${Number(port)}${browserPath}`)
      return endpoint;
  } catch {
    // Closed browsers leave a stale DevToolsActivePort file behind.
  }
}

async function activate(endpoint: string, url: URL) {
  const targets = await (await request(endpoint, "/json/list")).json() as Target[];
  const existing = targets.find((target) => {
    try {
      return target.type === "page" && new URL(target.url).origin === url.origin;
    } catch {
      return false;
    }
  });
  if (existing)
    await request(endpoint, "/json/activate/" + encodeURIComponent(existing.id));
  else
    await request(endpoint, "/json/new?" + encodeURIComponent(url.href), "PUT");
}

export class ProjectBrowser {
  private opening = new Map<string, Promise<void>>();
  constructor(
    private dataDir: string,
    private openExternal: (url: string) => Promise<void>,
  ) {}

  async open(project: ProjectConfig, address: string) {
    const url = new URL(address);
    if (!["http:", "https:"].includes(url.protocol))
      throw new Error("服务地址协议无效");
    if (project.type !== "h5" || !mobileProjects.has(project.id)) {
      await this.openExternal(address);
      return;
    }
    const profile = browserProfile(this.dataDir, project);
    const pending = this.opening.get(profile);
    if (pending) return pending;
    const opening = this.openMobile(profile, url);
    this.opening.set(profile, opening);
    try {
      await opening;
    } finally {
      this.opening.delete(profile);
    }
  }

  private async openMobile(profile: string, url: URL) {
    const endpoint = await activeEndpoint(profile);
    if (endpoint) {
      await activate(endpoint, url);
      return;
    }
    const normalized = profile.replaceAll("\\", "/").toLowerCase();
    if ((await processes()).some((item) => {
      const line = item.commandLine?.replaceAll("\\", "/").toLowerCase() || "";
      return line.includes("--user-data-dir=") && line.includes(normalized);
    }))
      throw new Error("该 APP 的独立浏览器仍在运行但暂时无响应，请关闭该浏览器后重试");
    const executable = chromeExecutable();
    prepareProfile(profile);
    const child = spawn(executable, [
      `--user-data-dir=${profile}`,
      "--remote-debugging-port=0",
      "--remote-debugging-address=127.0.0.1",
      "--no-first-run",
      "--no-default-browser-check",
      "--auto-open-devtools-for-tabs",
      "--new-window",
      "--start-maximized",
      url.href,
    ], { detached: true, windowsHide: true, stdio: "ignore", shell: false });
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("spawn", resolve);
    });
    child.unref();
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      const ready = await activeEndpoint(profile);
      if (ready) {
        // Startup already navigates to the URL; do not create a second tab.
        const targets = await (await request(ready, "/json/list")).json() as Target[];
        if (targets.some((target) => {
          try {
            return target.type === "page" && new URL(target.url).origin === url.origin;
          } catch {
            return false;
          }
        })) return;
      }
      if (child.exitCode !== null && child.exitCode !== 0)
        throw new Error(`Chrome 启动失败（${child.exitCode}）`);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    throw new Error("APP 调试浏览器打开超时；服务仍保留运行，可稍后重新打开页面");
  }
}

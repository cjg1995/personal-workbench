import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { ZodType } from "zod/v4";
import {
  requestWorkbench,
  WorkbenchUnavailable,
} from "../core/workbench-mcp-pipe.js";
import {
  workbenchMcpInstructions,
  workbenchToolDefinitions,
} from "../core/workbench-tools.js";
import { errorText, readJson, redact } from "../core/util.js";

const appRoot = path.resolve(fileURLToPath(new URL("../../", import.meta.url)));
const packaged = path.basename(appRoot) === "app.asar";
const dataDirOverride = process.argv.slice(2)
  .find((arg) => arg.startsWith("--data-dir="))?.slice(11);
const localAppData = process.env.LOCALAPPDATA || process.env.APPDATA;
const dataDir = dataDirOverride
  ? path.resolve(dataDirOverride)
  : path.join(localAppData || "", "PersonalWorkbench");
const { version } = readJson<{ version: string }>(path.join(appRoot, "package.json"));

function startWorkbench() {
  const executable = packaged
    ? process.execPath
    : path.join(appRoot, "node_modules", "electron", "dist", "electron.exe");
  const args = packaged ? [] : [appRoot];
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return new Promise<void>((resolve, reject) => {
    const child = spawn(executable, [...args, "--mcp-start", "--data-dir=" + dataDir], {
      cwd: path.dirname(executable),
      detached: true,
      env,
      stdio: "ignore",
      windowsHide: true,
    });
    child.once("error", reject);
    child.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}

const startupTimeout = 8_000;
let launchTime = 0;
async function invoke(name: string, args: Record<string, unknown>) {
  if (!dataDirOverride && !localAppData) {
    throw new Error("找不到本机数据目录，请配置 --data-dir");
  }
  try {
    return await requestWorkbench(dataDir, name, args);
  } catch (error) {
    if (!(error instanceof WorkbenchUnavailable)) throw error;
  }
  if (Date.now() - launchTime >= startupTimeout) {
    launchTime = Date.now();
    try {
      await startWorkbench();
    } catch (error) {
      launchTime = 0;
      throw new Error("无法启动个人工作台，请检查安装路径", { cause: error });
    }
  }
  const deadline = Date.now() + startupTimeout;
  do {
    await delay(160);
    try {
      return await requestWorkbench(dataDir, name, args);
    } catch (error) {
      if (!(error instanceof WorkbenchUnavailable)) throw error;
    }
  } while (Date.now() < deadline);
  throw new Error("个人工作台的接入服务未就绪，请打开工作台后重试");
}

const server = new McpServer(
  { name: "personal-workbench", version },
  { instructions: workbenchMcpInstructions },
);
for (const [name, definition] of Object.entries(workbenchToolDefinitions)) {
  server.registerTool<never, ZodType<Record<string, unknown>>>(name, definition, async (input) => {
    const args = name === "find_entries"
      ? input
      : { ...input, requestId: input.requestId ?? randomUUID() };
    const data = await invoke(name, args);
    return {
      content: [{ type: "text", text: JSON.stringify(data) }],
      structuredContent: data,
    };
  });
}

try {
  await server.connect(new StdioServerTransport());
} catch (error) {
  console.error(redact(errorText(error)));
  process.exitCode = 1;
}

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const { version } = require(path.join(root, "package.json"));
const target = path.join(
  process.env.LOCALAPPDATA || "",
  "Programs",
  "PersonalWorkbench",
);
const setup = path.join(
  root,
  "release",
  `PersonalWorkbench-${version}-Setup.exe`,
);
const exeName = "个人工作台.exe";
const sleep = (ms) =>
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (!process.env.LOCALAPPDATA) {
  console.error("未找到 LOCALAPPDATA，无法确定安装目录。");
  process.exit(1);
}
if (!fs.existsSync(setup)) {
  console.error(`未找到安装包：${setup}\n请先运行 npm run package。`);
  process.exit(1);
}

console.log(`关闭已运行的工作台…`);
spawnSync("taskkill", ["/IM", exeName], { stdio: "ignore" });
sleep(1200);
spawnSync("taskkill", ["/IM", exeName, "/F"], { stdio: "ignore" });

console.log(`安装 ${version} → ${target}`);
const result = spawnSync(setup, ["/S", `/D=${target}`], { stdio: "inherit" });
if (result.status !== 0) {
  console.error(
    `安装失败，退出码 ${result.status ?? "unknown"}。请确认工作台已完全退出后重试。`,
  );
  process.exit(result.status || 1);
}

const exe = path.join(target, exeName);
if (!fs.existsSync(exe)) {
  console.error(`安装结束但未找到主程序：${exe}`);
  process.exit(1);
}
console.log(`安装完成：${exe}`);

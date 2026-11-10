const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");
const launch = JSON.parse(process.env.WORKBENCH_SERVICE_LAUNCH || "null");
delete process.env.WORKBENCH_SERVICE_LAUNCH;
if (!launch || !process.argv.some((a) => a === "--marker=" + launch.marker))
  process.exit(2);
const redact = require("../shared/redact.cjs");
const output = fs.createWriteStream(launch.logPath, { flags: "a" });
output.on("error", () => process.exit(3));
const env = { ...process.env, ...launch.env };
delete env.ELECTRON_RUN_AS_NODE;
function decode(data) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    return new TextDecoder("gb18030").decode(data);
  }
}
function read(stream) {
  let pending = Buffer.alloc(0);
  stream.on("data", (data) => {
    pending = Buffer.concat([pending, data]);
    let at = 0;
    for (
      let end = pending.indexOf(10, at);
      end >= 0;
      end = pending.indexOf(10, at)
    ) {
      output.write(redact(decode(pending.subarray(at, end + 1))));
      at = end + 1;
    }
    pending = pending.subarray(at);
  });
  stream.on("end", () => {
    if (pending.length) output.write(redact(decode(pending)));
  });
}
function finish(code) {
  output.end(() => process.exit(code || 0));
}
function start(exe, args, closed) {
  const child = spawn(exe, args, {
    cwd: launch.cwd,
    env,
    windowsHide: true,
    shell: false,
    stdio: ["ignore", "pipe", "pipe"],
  });
  read(child.stdout);
  read(child.stderr);
  child.on("error", (error) => output.write(redact(error.message) + "\n"));
  child.on("close", (code) => closed(code ?? 1));
}
function launchService() {
  try {
    const args = [...launch.args];
    if (launch.prepare) {
      const dependencies = fs
        .readFileSync(launch.prepare.classpathFile, "utf8")
        .replace(/^\uFEFF/, "")
        .trim();
      const at = args.indexOf("-classpath");
      if (
        at < 0 ||
        !dependencies ||
        dependencies
          .split(path.delimiter)
          .some((file) => !path.isAbsolute(file) || !fs.existsSync(file))
      )
        throw new Error("Maven 未生成完整可用的运行依赖，未启动应用");
      args[at + 1] += path.delimiter + dependencies;
      output.write("WORKBENCH_SPRING_PREPARED Maven 已退出，直接启动应用（保留 DevTools）\n");
    }
    start(launch.exe, args, finish);
  } catch (error) {
    output.write(redact(error.message) + "\n");
    finish(1);
  }
}
if (launch.prepare) {
  fs.mkdirSync(path.dirname(launch.prepare.classpathFile), { recursive: true });
  fs.rmSync(launch.prepare.classpathFile, { force: true });
  output.write("正在编译并解析运行依赖，完成后释放 Maven 进程…\n");
  start(launch.prepare.exe, launch.prepare.args, (code) => {
    if (code !== 0) finish(code);
    else launchService();
  });
} else launchService();

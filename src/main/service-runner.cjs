const fs = require("node:fs");
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
const child = spawn(launch.exe, launch.args, {
  cwd: launch.cwd,
  env,
  windowsHide: true,
  shell: false,
  stdio: ["ignore", "pipe", "pipe"],
});
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
read(child.stdout);
read(child.stderr);
child.on("error", (error) => output.write(redact(error.message) + "\n"));
child.on("close", (code) => output.end(() => process.exit(code || 0)));

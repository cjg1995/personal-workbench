const { spawn } = require("node:child_process");
const path = require("node:path");
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const proc = spawn(
  require("electron"),
  [path.resolve(__dirname, ".."), ...process.argv.slice(2)],
  { stdio: "inherit", env, windowsHide: false },
);
proc.on("exit", (code) => process.exit(code || 0));

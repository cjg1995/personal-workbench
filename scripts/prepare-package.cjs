const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
for (const file of [
  path.join(root, "node_modules", "electron", "dist", "debug.log"),
  path.join(root, "release", "win-unpacked", "debug.log"),
]) {
  try {
    fs.rmSync(file, { force: true });
  } catch {
    // 日志不存在或正被占用时忽略，不阻断打包。
  }
}

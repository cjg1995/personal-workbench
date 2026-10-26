const fs = require("node:fs"),
  path = require("node:path"),
  { spawnSync } = require("node:child_process"),
  { createHash } = require("node:crypto");
const root = path.resolve(__dirname, ".."),
  source = path.join(root, "src/native/WorkbenchTomcat.java"),
  output = path.join(root, "assets/runtime/tomcat");
fs.mkdirSync(output, { recursive: true });
const candidates = [
  process.env.JAVA_HOME && path.join(process.env.JAVA_HOME, "bin/javac.exe"),
  "C:/Program Files/Java/jdk1.8.0_131/bin/javac.exe",
];
const javac = candidates.find((p) => p && fs.existsSync(p)) || "javac";
const result = spawnSync(
  javac,
  ["-encoding", "UTF-8", "-source", "8", "-target", "8", "-d", output, source],
  { stdio: "inherit", windowsHide: true },
);
if (result.status !== 0)
  throw new Error("Java 8-compatible helper compilation failed");
fs.writeFileSync(
  path.join(output, "source.sha256"),
  createHash("sha256").update(fs.readFileSync(source)).digest("hex"),
);

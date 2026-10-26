const fs = require("node:fs");
fs.mkdirSync("dist", { recursive: true });
fs.copyFileSync("src/main/preload.cjs", "dist/preload.cjs");
fs.copyFileSync("src/main/service-runner.cjs", "dist/main/service-runner.cjs");
if (fs.existsSync("dist/service-runner.cjs"))
  fs.unlinkSync("dist/service-runner.cjs");
const { createHash } = require("node:crypto");
if (
  createHash("sha256")
    .update(fs.readFileSync("src/native/WorkbenchTomcat.java"))
    .digest("hex") !==
  fs.readFileSync("assets/runtime/tomcat/source.sha256", "utf8").trim()
)
  throw new Error(
    "Tomcat helper source changed; run npm run build:tomcat with a JDK",
  );
fs.mkdirSync("dist/runtime/tomcat", { recursive: true });
fs.copyFileSync(
  "assets/runtime/tomcat/WorkbenchTomcat.class",
  "dist/runtime/tomcat/WorkbenchTomcat.class",
);

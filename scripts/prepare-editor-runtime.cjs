const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { pipeline } = require("node:stream/promises");
const { Readable } = require("node:stream");
const { spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..", ".local", "editor-runtime");
const archives = [
  {
    name: "jdtls",
    file: "jdtls.tar.gz",
    url: "https://download.eclipse.org/jdtls/snapshots/jdt-language-server-1.64.0-202611062158.tar.gz",
    sha256: "932da268d8af89362d7349e746341e77eb6d9bc50c2f850da40d42641731160e",
    marker: path.join("plugins", "org.eclipse.equinox.launcher_1.8.0.v20260804-1928.jar"),
  },
  {
    name: "jre",
    file: "jre25.zip",
    url: "https://github.com/adoptium/temurin25-binaries/releases/download/jdk-25.0.5%2B8/OpenJDK25U-jre_x64_windows_hotspot_25.0.5_8.zip",
    sha256: "da78d54a2fcdbba1e92d5e3f07dd30236f96297891c4a21a781c3f38f5c0beae",
    marker: path.join("bin", "java.exe"),
    version: 'JAVA_VERSION="25.0.5"',
  },
];

async function ensure(archive) {
  const destination = path.join(root, archive.name);
  if (!destination.startsWith(root + path.sep)) throw new Error("运行时目录越界");
  if (archive.name !== "jdtls" && fs.existsSync(path.join(destination, archive.marker)) &&
      (!archive.version || fs.readFileSync(path.join(destination, "release"), "utf8").includes(archive.version))) return;
  const downloadDir = path.join(root, "downloads");
  fs.mkdirSync(downloadDir, { recursive: true });
  const downloaded = path.join(downloadDir, archive.file);
  const valid = () => fs.existsSync(downloaded) &&
    crypto.createHash("sha256").update(fs.readFileSync(downloaded)).digest("hex") === archive.sha256;
  if (!valid()) {
    const response = await fetch(archive.url);
    if (!response.ok || !response.body) throw new Error(`下载 ${archive.name} 失败：HTTP ${response.status}`);
    const temporary = downloaded + ".partial";
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(temporary));
    fs.renameSync(temporary, downloaded);
  }
  if (!valid()) throw new Error(`${archive.name} SHA-256 校验失败`);
  const staging = path.join(root, `${archive.name}-extract`);
  if (!staging.startsWith(root + path.sep)) throw new Error("解压目录越界");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  const extracted = spawnSync("tar", ["-xf", downloaded, "-C", staging], { stdio: "inherit" });
  if (extracted.status !== 0) throw new Error(`${archive.name} 解压失败`);
  const source = archive.name === "jre"
    ? path.join(staging, "jdk-25.0.5+8-jre")
    : staging;
  if (!fs.existsSync(path.join(source, archive.marker))) {
    if (archive.name === "jdtls") {
      const launcher = fs.readdirSync(path.join(source, "plugins")).find((file) => file.startsWith("org.eclipse.equinox.launcher_") && file.endsWith(".jar"));
      if (!launcher) throw new Error("JDT LS 缺少启动器");
    } else throw new Error("Java 21 运行时缺少 java.exe");
  }
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(source, destination);
  if (source !== staging) fs.rmSync(staging, { recursive: true, force: true });
}

Promise.all(archives.map(ensure)).catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

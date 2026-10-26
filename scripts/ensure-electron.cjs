const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");
const target = path.join(root, "node_modules/electron");
const version = require(path.join(target, "package.json")).version;
function matching(folder) {
  if (
    !fs.existsSync(path.join(folder, "electron.exe")) ||
    !fs.existsSync(path.join(folder, "version"))
  )
    return false;
  if (
    fs
      .readFileSync(path.join(folder, "version"), "utf8")
      .trim()
      .replace(/^v/, "") !== version
  )
    return false;
  const file = fs.readFileSync(path.join(folder, "electron.exe"));
  const offset = file.length > 64 ? file.readUInt32LE(0x3c) : -1;
  return (
    offset >= 0 &&
    offset + 6 <= file.length &&
    file.readUInt16LE(offset + 4) ===
      (process.arch === "arm64" ? 0xaa64 : 0x8664)
  );
}
if (process.platform === "win32" && matching(path.join(target, "dist"))) {
  fs.writeFileSync(path.join(target, "path.txt"), "electron.exe");
} else if (
  process.platform !== "win32" ||
  !matching(path.join(target, "dist"))
) {
  const tested = path.join(root, ".spike/node_modules/electron/dist");
  if (process.platform === "win32" && matching(tested)) {
    fs.cpSync(tested, path.join(target, "dist"), { recursive: true });
    fs.writeFileSync(path.join(target, "path.txt"), "electron.exe");
  } else if (process.platform === "win32") {
    if (
      !/^\d+\.\d+\.\d+$/.test(version) ||
      !["x64", "arm64"].includes(process.arch)
    )
      throw new Error("Unsupported Electron runtime target");
    const name = `electron-v${version}-win32-${process.arch}.zip`;
    const expected = require(path.join(target, "checksums.json"))[name];
    if (!/^[a-f0-9]{64}$/i.test(expected || ""))
      throw new Error("Electron checksum missing");
    const quoted = (value) => "'" + value.replaceAll("'", "''") + "'";
    const cache = path.join(root, ".local", "downloads"),
      archive = path.join(cache, name);
    const script = `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; [void][IO.Directory]::CreateDirectory(${quoted(cache)}); $zip=${quoted(archive)}; $expected=${quoted(expected)}; if(-not (Test-Path -LiteralPath $zip) -or (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $expected) { Invoke-WebRequest -Uri ${quoted("https://github.com/electron/electron/releases/download/v" + version + "/" + name)} -OutFile $zip -TimeoutSec 180 }; if((Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash -ne $expected){throw 'Electron SHA256 mismatch'}; Expand-Archive -LiteralPath $zip -DestinationPath ${quoted(path.join(target, "dist"))} -Force; [IO.File]::WriteAllText(${quoted(path.join(target, "path.txt"))},'electron.exe')`;
    const result = spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-NonInteractive",
        "-EncodedCommand",
        Buffer.from(script, "utf16le").toString("base64"),
      ],
      { stdio: "inherit", windowsHide: true, timeout: 240000 },
    );
    if (result.status !== 0)
      throw new Error(
        "Electron runtime download failed: " +
          (result.error?.message || result.status),
      );
  } else {
    const result = spawnSync(
      process.execPath,
      [path.join(target, "install.js")],
      { stdio: "inherit" },
    );
    if (result.status !== 0) process.exit(result.status || 1);
  }
}

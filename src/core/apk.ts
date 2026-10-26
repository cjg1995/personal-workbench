import fs from "node:fs";
import path from "node:path";
import { unzipSync } from "fflate";
import { DOMParser } from "@xmldom/xmldom";
import type { BuildConfig, ProjectConfig } from "../shared/types.js";
import { ConfigService } from "./config.js";
import { TaskManager } from "./tasks.js";
import { command, CommandError } from "./process.js";
import {
  assertNoLinks,
  ensureDir,
  hash,
  id,
  requireInside,
  walk,
} from "./util.js";
export function resourceHashes(dir: string) {
  return Object.fromEntries(
    walk(dir).map((file) => [
      path.relative(dir, file).replaceAll("\\", "/"),
      hash(fs.readFileSync(file)),
    ]),
  );
}
export function compareResources(
  expected: Record<string, string>,
  actual: Record<string, string>,
  label: string,
) {
  if (Object.keys(expected).length !== Object.keys(actual).length)
    throw new Error(`${label}资源数量不一致`);
  for (const key of Object.keys(expected))
    if (expected[key] !== actual[key])
      throw new Error(`${label}资源不一致：${key}`);
}
export function wwwPath(android: string, appId: string) {
  if (!/^__UNI__[A-Z0-9]+$/.test(appId)) throw new Error("AppID 无效");
  return requireInside(
    android,
    path.join(
      android,
      "simpleDemo",
      "src",
      "main",
      "assets",
      "apps",
      appId,
      "www",
    ),
  );
}
export function syncResources(source: string, android: string, appId: string) {
  const target = wwwPath(android, appId);
  assertNoLinks(target);
  const expected = resourceHashes(source);
  if (!Object.keys(expected).length) throw new Error("拒绝同步空资源");
  ensureDir(target);
  const current = resourceHashes(target);
  for (const name of Object.keys(current))
    if (!Object.hasOwn(expected, name)) {
      const p = requireInside(target, path.join(target, name));
      fs.unlinkSync(p);
    }
  const directories: string[] = [];
  const collect = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }))
      if (entry.isDirectory()) {
        const p = path.join(dir, entry.name);
        collect(p);
        directories.push(p);
      }
  };
  collect(target);
  for (const dir of directories)
    if (!fs.readdirSync(dir).length) fs.rmdirSync(requireInside(target, dir));
  for (const name of Object.keys(expected)) {
    const destination = requireInside(target, path.join(target, name));
    ensureDir(path.dirname(destination));
    fs.copyFileSync(path.join(source, name), destination);
  }
  compareResources(expected, resourceHashes(target), "宿主");
  return expected;
}
export function apkHashes(file: string, appId: string) {
  const bytes = fs.readFileSync(file),
    prefix = `assets/apps/${appId}/www/`;
  const names = new Set<string>();
  // Inspect the central directory before decompression: duplicate names must not be silently overwritten.
  let end = -1;
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 65557);
    at--
  )
    if (bytes.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  if (end < 0) throw new Error("APK ZIP 目录无效");
  let offset = bytes.readUInt32LE(end + 16);
  const count = bytes.readUInt16LE(end + 10);
  for (let n = 0; n < count; n++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50)
      throw new Error("APK ZIP 目录损坏");
    const len = bytes.readUInt16LE(offset + 28),
      extra = bytes.readUInt16LE(offset + 30),
      comment = bytes.readUInt16LE(offset + 32);
    const name = bytes
      .subarray(offset + 46, offset + 46 + len)
      .toString("utf8");
    if (name.startsWith(prefix) && !name.endsWith("/")) {
      if (names.has(name)) throw new Error("APK 资源路径重复：" + name);
      names.add(name);
    }
    offset += 46 + len + extra + comment;
  }
  const extracted = unzipSync(bytes, {
    filter: (e) => e.name.startsWith(prefix) && !e.name.endsWith("/"),
  });
  return Object.fromEntries(
    Object.entries(extracted).map(([name, content]) => [
      name.slice(prefix.length),
      hash(content),
    ]),
  );
}
export const offlineCacheMiss = (output: string) =>
  /No cached (version|resource)[\s\S]*?available\s+for\s+offline\s+mode/i.test(
    output,
  );
function capture(source: string, pattern: RegExp, label: string) {
  const match = pattern.exec(source);
  if (!match) throw new Error("无法读取工程配置：" + label);
  return match[1];
}
export class ApkService {
  constructor(
    private config: ConfigService,
    private tasks: TaskManager,
    private dataDir: string,
  ) {}
  inspect(projectId: string): BuildConfig {
    const p = this.config.project(projectId),
      tools = this.config.get().tools;
    if (!p.android || !p.appId || !p.packageName)
      throw new Error("该项目未配置 APK 映射");
    const android = path.resolve(p.android),
      source = path.resolve(p.path);
    const manifest = fs.readFileSync(
        path.join(source, "manifest.json"),
        "utf8",
      ),
      gradle = fs.readFileSync(
        path.join(android, "simpleDemo", "build.gradle"),
        "utf8",
      );
    const sourceId = capture(manifest, /"appid"\s*:\s*"([^"]+)"/, "源码 AppID");
    const control = new DOMParser().parseFromString(
      fs.readFileSync(
        path.join(
          android,
          "simpleDemo",
          "src",
          "main",
          "assets",
          "data",
          "dcloud_control.xml",
        ),
        "utf8",
      ),
      "application/xml",
    );
    const apps = Array.from(control.getElementsByTagName("app")).map((n) =>
      n.getAttribute("appid"),
    );
    const packageName = capture(
      gradle,
      /^\s*applicationId\s+["']([^"']+)["']/m,
      "包名",
    );
    if (
      sourceId !== p.appId ||
      apps.length !== 1 ||
      apps[0] !== p.appId ||
      packageName !== p.packageName
    )
      throw new Error("AppID、包名与 Android 工程映射不一致，已停止");
    const localProperties = fs.readFileSync(
      path.join(android, "local.properties"),
      "utf8",
    );
    const sdk = capture(localProperties, /^\s*sdk\.dir\s*=\s*(.+)/m, "SDK 路径")
      .trim()
      .replace(/\\(.)/g, "$1");
    if (!path.isAbsolute(sdk)) throw new Error("SDK 需要绝对路径");
    const result: BuildConfig = {
      projectId,
      name: p.name,
      source,
      android,
      appId: p.appId,
      packageName,
      versionName: capture(
        gradle,
        /^\s*versionName\s+["']([^"']+)["']/m,
        "版本名称",
      ),
      versionCode: capture(gradle, /^\s*versionCode\s+(\d+)/m, "版本号"),
      www: wwwPath(android, p.appId),
      sdk,
      java: tools.buildJava,
      aapt: path.join(sdk, "build-tools", "30.0.3", "aapt.exe"),
      signerJar: path.join(
        sdk,
        "build-tools",
        "30.0.3",
        "lib",
        "apksigner.jar",
      ),
      wrapperJar: path.join(android, "gradle", "wrapper", "gradle-wrapper.jar"),
      cli: tools.hbCli,
      node: tools.hbNode,
    };
    for (const file of [
      result.java,
      result.aapt,
      result.signerJar,
      result.wrapperJar,
      result.cli,
      result.node,
    ])
      if (!fs.existsSync(file)) throw new Error("缺少构建工具：" + file);
    if (!fs.existsSync(result.www))
      throw new Error("宿主资源目录不存在：" + result.www);
    assertNoLinks(result.www);
    return result;
  }
  async start(projectId: string, variant: "Release" | "Debug") {
    if (!["Release", "Debug"].includes(variant))
      throw new Error("构建类型无效");
    const cfg = this.inspect(projectId);
    const task = this.tasks.create(
      "apk",
      `${cfg.name} · ${variant}`,
      projectId,
      "apk:" + cfg.android.toLowerCase(),
      { projectId, variant, source: cfg.source, android: cfg.android },
      ["编译 UniApp 资源", "同步 Android 工程资源", "Gradle 构建", "校验 APK"],
    );
    const abort = new AbortController();
    this.tasks.aborts.set(task.id, abort);
    this.tasks.launch(task, async (ctx) => {
      const output = ensureDir(path.join(this.dataDir, "builds", task.id)),
        exported = path.join(output, "www");
      const javaHome = path.dirname(path.dirname(cfg.java));
      const environment = {
        UNI_INPUT_DIR: cfg.source,
        UNI_OUTPUT_DIR: exported,
        UNI_PLATFORM: "app-plus",
        NODE_ENV: "production",
        UNI_MINIMIZE: "true",
        JAVA_HOME: javaHome,
        JAVA_TOOL_OPTIONS: "-Djava.net.preferIPv4Stack=true",
      };
      let expected: Record<string, string> = {};
      const before = hash(
        fs.readFileSync(path.join(cfg.android, "simpleDemo", "build.gradle")),
      );
      ctx.result({ config: cfg, output });
      await ctx.step("编译 UniApp 资源", async () => {
        await command(cfg.node, [cfg.cli], {
          cwd: path.dirname(path.dirname(cfg.cli)),
          env: environment,
          logPath: task.logPath,
          signal: abort.signal,
        });
        for (const file of ["manifest.json", "app-service.js", "app-view.js"]) {
          const p = path.join(exported, file);
          if (!fs.existsSync(p) || fs.statSync(p).size === 0)
            throw new Error("编译资源缺失或为空：" + file);
        }
        const manifest = JSON.parse(
          fs.readFileSync(path.join(exported, "manifest.json"), "utf8"),
        );
        if (manifest.id !== cfg.appId)
          throw new Error("导出 AppID 与映射不一致");
      });
      await ctx.step("同步 Android 工程资源", async () => {
        expected = syncResources(exported, cfg.android, cfg.appId);
        ctx.result({ resourceFiles: Object.keys(expected).length });
      });
      await ctx.step("Gradle 构建", async () => {
        const args = [
          "-classpath",
          cfg.wrapperJar,
          "org.gradle.wrapper.GradleWrapperMain",
          "--no-daemon",
          "--offline",
          `:simpleDemo:assemble${variant}`,
        ];
        try {
          await command(cfg.java, args, {
            cwd: cfg.android,
            env: environment,
            logPath: task.logPath,
            signal: abort.signal,
          });
        } catch (e) {
          if (
            e instanceof CommandError &&
            offlineCacheMiss(e.result.stdout + "\n" + e.result.stderr)
          ) {
            ctx.log("明确检测到离线依赖缓存缺失，联网补齐一次");
            ctx.result({ onlineRetry: true });
            await command(
              cfg.java,
              args.filter((a) => a !== "--offline"),
              {
                cwd: cfg.android,
                env: environment,
                logPath: task.logPath,
                signal: abort.signal,
              },
            );
          } else throw e;
        }
      });
      await ctx.step("校验 APK", async () => {
        const original = path.join(
          cfg.android,
          "simpleDemo",
          "build",
          "outputs",
          "apk",
          variant.toLowerCase(),
          `simpleDemo-${variant.toLowerCase()}.apk`,
        );
        if (!fs.existsSync(original)) throw new Error("未找到 Gradle APK 输出");
        compareResources(expected, resourceHashes(exported), "导出");
        compareResources(expected, resourceHashes(cfg.www), "宿主");
        compareResources(expected, apkHashes(original, cfg.appId), "APK");
        const signature = await command(
          cfg.java,
          [
            "-jar",
            cfg.signerJar,
            "verify",
            "--verbose",
            "--print-certs",
            original,
          ],
          {
            cwd: cfg.android,
            env: environment,
            logPath: task.logPath,
            signal: abort.signal,
          },
        );
        const cert = capture(
          signature.stdout,
          /Signer #1 certificate SHA-256 digest:\s*([a-fA-F0-9]+)/,
          "APK 签名证书",
        );
        const expectedCertificate = await this.expectedCertificate(
          cfg,
          variant,
          environment,
          task.logPath,
          abort.signal,
        );
        if (cert.toLowerCase() !== expectedCertificate.toLowerCase())
          throw new Error("APK 签名证书与当前工程签名配置不一致");
        const badging = await command(cfg.aapt, ["dump", "badging", original], {
          cwd: cfg.android,
          logPath: task.logPath,
          signal: abort.signal,
        });
        const info =
          /package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/.exec(
            badging.stdout,
          );
        if (
          !info ||
          info[1] !== cfg.packageName ||
          info[2] !== cfg.versionCode ||
          info[3] !== cfg.versionName
        )
          throw new Error("APK 包名或版本校验失败");
        if (
          before !==
          hash(
            fs.readFileSync(
              path.join(cfg.android, "simpleDemo", "build.gradle"),
            ),
          )
        )
          throw new Error("构建过程中工程版本或签名配置已改变，须重新核对");
        const artifactDir = ensureDir(
            path.join(this.dataDir, "artifacts", task.id),
          ),
          artifact = path.join(
            artifactDir,
            `${projectId}-${cfg.versionName}-${variant}.apk`,
          );
        fs.copyFileSync(original, artifact);
        ctx.result({
          artifact,
          sha256: hash(fs.readFileSync(artifact)),
          packageName: cfg.packageName,
          versionName: cfg.versionName,
          versionCode: cfg.versionCode,
          resourceCheck: "通过",
          signatureCheck: "通过",
          versionCheck: "通过",
          certificateSha256: cert,
        });
      });
    });
    return task;
  }
  private async expectedCertificate(
    cfg: BuildConfig,
    variant: string,
    environment: NodeJS.ProcessEnv,
    logPath: string,
    signal: AbortSignal,
  ) {
    const gradle = fs.readFileSync(
      path.join(cfg.android, "simpleDemo", "build.gradle"),
      "utf8",
    );
    const name = capture(
      gradle,
      /signingConfig\s+signingConfigs\.(\w+)/,
      "签名配置名称",
    );
    const start = gradle.indexOf("signingConfigs");
    const block = gradle.slice(start);
    const config = capture(
      block,
      new RegExp("\\b" + name + "\\s*\\{([\\s\\S]*?)\\}"),
      "签名配置",
    );
    const keyPath = capture(
      config,
      /storeFile\s+file\(\s*["']([^"']+)["']\s*\)/,
      "签名文件",
    );
    const password = capture(
      config,
      /storePassword\s+["']([^"']*)["']/,
      "签名配置",
    );
    const alias = capture(config, /keyAlias\s+["']([^"']+)["']/, "签名别名");
    const keystore = path.resolve(cfg.android, "simpleDemo", keyPath),
      keytool = path.join(path.dirname(cfg.java), "keytool.exe");
    if (!fs.existsSync(keystore) || !fs.existsSync(keytool))
      throw new Error("无法核实签名文件或 keytool");
    const result = await command(
      keytool,
      [
        "-J-Duser.language=en",
        "-exportcert",
        "-rfc",
        "-alias",
        alias,
        "-keystore",
        keystore,
        "-storepass:env",
        "WORKBENCH_KEYSTORE_PASSWORD",
      ],
      {
        cwd: cfg.android,
        env: { ...environment, WORKBENCH_KEYSTORE_PASSWORD: password },
        signal,
      },
    );
    const pem = capture(
      result.stdout,
      /-----BEGIN CERTIFICATE-----([\s\S]*?)-----END CERTIFICATE-----/,
      "工程证书",
    );
    return hash(Buffer.from(pem.replace(/\s/g, ""), "base64"));
  }
  artifact(taskId: string) {
    const t = this.tasks.get(taskId);
    if (t.state !== "success" || typeof t.result.artifact !== "string")
      throw new Error("该任务没有成功 APK 产物");
    const file = t.result.artifact;
    if (!fs.existsSync(file)) throw new Error("任务产物已不存在");
    if (hash(fs.readFileSync(file)) !== t.result.sha256)
      throw new Error("历史产物被修改，SHA256 不符");
    return file;
  }
}

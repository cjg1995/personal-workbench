import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DOMParser } from "@xmldom/xmldom";
import type { ProjectConfig, RunInfo } from "../shared/types.js";
import { ConfigService } from "./config.js";
import { Git } from "./git.js";
import { TaskManager } from "./tasks.js";
import {
  command,
  processes,
  processEnvironments,
  listenerPids,
  sameProcess,
  terminateTree,
  type ProcessIdentity,
} from "./process.js";
import {
  atomicWrite,
  ensureDir,
  errorText,
  hash,
  id,
  now,
  redact,
} from "./util.js";
type XmlDoc = ReturnType<DOMParser["parseFromString"]>;
interface Launch {
  exe: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  port?: number;
  requiredPorts?: number[];
  context: string;
  description: string;
  kind: ProjectConfig["type"];
  deployment?: string;
  identity: string;
  prepare?: {
    exe: string;
    args: string[];
    classpathFile: string;
  };
}
const normalize = (s: string | undefined | null) =>
  (s || "").replaceAll("\\", "/").toLowerCase();
const xml = (file: string) =>
  new DOMParser().parseFromString(
    fs.readFileSync(file, "utf8"),
    "application/xml",
  );
const options = (node: Element | any) =>
  Object.fromEntries(
    Array.from(node.getElementsByTagName("option") as ArrayLike<any>)
      .filter((n: any) => n.hasAttribute("name"))
      .map((n: any) => [n.getAttribute("name"), n.getAttribute("value")]),
  );
function args(value: string) {
  const values: string[] = [];
  let token = "",
    quoted = false;
  for (const c of value) {
    if (c === '"') {
      quoted = !quoted;
      continue;
    }
    if (/\s/.test(c) && !quoted) {
      if (token) {
        values.push(token);
        token = "";
      }
    } else token += c;
  }
  if (quoted) throw new Error("VM 参数引号不匹配");
  if (token) values.push(token);
  return values;
}
function jsonc(source: string) {
  let result = "",
    inString = false,
    escape = false,
    line = false,
    block = false;
  for (let i = 0; i < source.length; i++) {
    const c = source[i],
      n = source[i + 1];
    if (line) {
      if (c === "\n") {
        line = false;
        result += c;
      }
      continue;
    }
    if (block) {
      if (c === "*" && n === "/") {
        block = false;
        i++;
      }
      continue;
    }
    if (!inString && c === "/" && n === "/") {
      line = true;
      i++;
      continue;
    }
    if (!inString && c === "/" && n === "*") {
      block = true;
      i++;
      continue;
    }
    result += c;
    if (inString) {
      if (escape) escape = false;
      else if (c === "\\") escape = true;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
  }
  return JSON.parse(result.replace(/,\s*([}\]])/g, "$1"));
}
async function freePort(port: number) {
  return new Promise<boolean>((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen(port, "127.0.0.1", () => server.close(() => resolve(true)));
  });
}
async function reachable(url: string) {
  try {
    const r = await fetch(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(2500),
    });
    return [200, 201, 204, 301, 302, 303, 307, 308, 401, 403].includes(
      r.status,
    );
  } catch {
    return false;
  }
}
export class ProjectService {
  starting = new Map<string, string>();
  private cache:
    | {
        at: number;
        items: ProcessIdentity[];
        envs: Awaited<ReturnType<typeof processEnvironments>>;
      }
    | undefined;
  constructor(
    private config: ConfigService,
    private git: Git,
    private tasks: TaskManager,
    private dataDir: string,
    private changed: () => void = () => {},
    private runnerFile?: string,
    private tomcatHelper?: string,
    private openReadyUrl?: (url: string, project: ProjectConfig) => Promise<void>,
  ) {}
  private ideaOptions() {
    const base = path.join(process.env.APPDATA || "", "JetBrains");
    if (!fs.existsSync(base)) throw new Error("未找到 IDEA 用户配置");
    const dirs = fs
      .readdirSync(base)
      .filter((n) => n.startsWith("IntelliJIdea"))
      .sort()
      .reverse();
    const selected =
      dirs.find((n) =>
        fs.existsSync(path.join(base, n, "options", "javaeeAppServers.xml")),
      ) || dirs[0];
    if (!selected) throw new Error("未找到 IDEA 配置目录");
    return {
      root: path.join(base, selected, "options"),
      system: path.join(process.env.LOCALAPPDATA || "", "JetBrains", selected),
    };
  }
  private jdk(name: string) {
    const roots = this.ideaOptions();
    const doc = xml(path.join(roots.root, "jdk.table.xml"));
    const node = Array.from(doc.getElementsByTagName("jdk")).find(
      (j) => j.getElementsByTagName("name")[0]?.getAttribute("value") === name,
    );
    const home = node
      ?.getElementsByTagName("homePath")[0]
      ?.getAttribute("value")
      ?.replace("$USER_HOME$", process.env.USERPROFILE || "");
    if (!home || home.includes("$")) throw new Error("无法解析 JDK：" + name);
    return path.join(home, "bin", "java.exe");
  }
  private hotReloadArgs(docs: XmlDoc[], java: string, vm: string[]) {
    const selected = docs.some((d) =>
      Array.from(d.getElementsByTagName("component")).some(
        (c) =>
          c.getAttribute("name") === "RebelAgentSelection" &&
          c.getElementsByTagName("selection")[0]?.textContent?.trim() === "jr",
      ),
    );
    if (
      !selected ||
      vm.some((v) => /^-(?:agentpath|javaagent):.*(?:jrebel|rebel)/i.test(v))
    )
      return [];
    const config = xml(path.join(this.ideaOptions().root, "javarebel.xml"));
    const jar = Array.from(config.getElementsByTagName("option"))
      .find((n) => n.getAttribute("name") === "javaRebelPath")
      ?.getAttribute("value");
    if (!jar || !fs.existsSync(jar))
      throw new Error(
        "原 IDEA 已启用 JRebel，但其代理路径无效，请先在原工具中处理",
      );
    const pe = fs.readFileSync(java);
    const offset = pe.length >= 64 ? pe.readUInt32LE(0x3c) : -1;
    if (
      offset < 0 ||
      offset + 6 > pe.length ||
      pe.toString("ascii", offset, offset + 4) !== "PE\0\0"
    )
      throw new Error("无法核实原 JRE 位数，未启动热更新代理");
    const machine = pe.readUInt16LE(offset + 4);
    if (machine !== 0x8664 && machine !== 0x14c)
      throw new Error("原 JRE 架构不受现有 JRebel 代理支持");
    const agent = path.join(
      path.dirname(jar),
      "lib",
      machine === 0x8664 ? "jrebel64.dll" : "jrebel32.dll",
    );
    if (!fs.existsSync(agent))
      throw new Error("原 JRebel 原生代理不存在：" + agent);
    return ["-agentpath:" + agent];
  }
  launchConfig(p: ProjectConfig, marker: string): Launch {
    if (!fs.existsSync(p.path)) throw new Error("工作目录不存在：" + p.path);
    const tools = this.config.get().tools;
    if (p.type === "tomcat") {
      const docs: XmlDoc[] = [];
      const shared = path.join(p.path, ".idea", "runConfigurations");
      if (fs.existsSync(shared))
        for (const f of fs.readdirSync(shared))
          if (f.endsWith(".xml")) docs.push(xml(path.join(shared, f)));
      const workspace = path.join(p.path, ".idea", "workspace.xml");
      if (fs.existsSync(workspace)) docs.push(xml(workspace));
      const run = docs
        .flatMap((d) => Array.from(d.getElementsByTagName("configuration")))
        .find(
          (c) =>
            c.getAttribute("type")?.includes("TomcatRunConfiguration") &&
            c.getAttribute("default") !== "true",
        );
      if (!run) throw new Error("未找到实际 Tomcat 运行配置");
      const opts = options(run);
      const roots = this.ideaOptions();
      const servers = xml(path.join(roots.root, "javaeeAppServers.xml"));
      const server = Array.from(servers.getElementsByTagName("ServerDK")).find(
        (s) =>
          s.getAttribute("NAME") ===
          run.getAttribute("APPLICATION_SERVER_NAME"),
      );
      if (!server) throw new Error("IDEA Tomcat 工具未配置");
      const home = p.catalinaHome || options(server).CATALINA_HOME;
      const base =
        p.catalinaBase ||
        path.join(roots.system, "tomcat", opts.BASE_DIRECTORY_NAME || "");
      const serverDoc = xml(path.join(base, "conf", "server.xml"));
      const connector = Array.from(
        serverDoc.getElementsByTagName("Connector"),
      ).find((c) => !c.getAttribute("protocol")?.includes("AJP"));
      const port = Number(connector?.getAttribute("port"));
      if (!port) throw new Error("无法读取 Tomcat HTTP 端口");
      if (p.expectedPort && p.expectedPort !== port)
        throw new Error(
          `核对端口 ${p.expectedPort} 与现有 server.xml 的 ${port} 不一致，请先在原配置中处理`,
        );
      const context = p.context || opts.CONTEXT_PATH || "/";
      const contextFile = path.join(
        base,
        "conf",
        "Catalina",
        "localhost",
        context.replace(/^\//, "") + ".xml",
      );
      const deployment =
        xml(contextFile)
          .getElementsByTagName("Context")[0]
          ?.getAttribute("docBase") || "";
      if (
        p.deployment &&
        normalize(path.resolve(p.deployment)) !==
          normalize(path.resolve(deployment))
      )
        throw new Error(
          "核对部署目录与现有 Tomcat 上下文不一致，请先在原工具中处理",
        );
      if (!deployment || !fs.existsSync(path.join(deployment, "WEB-INF")))
        throw new Error(
          "现有 exploded 部署未就绪，请先在 IDEA 构建：" + deployment,
        );
      if (
        !normalize(deployment).startsWith(normalize(path.resolve(p.path)) + "/")
      )
        throw new Error(
          "Tomcat 部署与当前工作目录不一致，停止以保护两个后端的隔离",
        );
      const java =
        p.java || this.jdk(run.getAttribute("ALTERNATIVE_JRE_PATH") || "");
      const vm = args(
        p.vmArgs?.trim() ? p.vmArgs : opts.COMMON_VM_ARGUMENTS || "",
      );
      const hotReload = this.hotReloadArgs(docs, java, vm);
      const helper =
        this.tomcatHelper ||
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          "../runtime/tomcat/WorkbenchTomcat.class",
        );
      if (!fs.existsSync(helper))
        throw new Error("工作台 Tomcat 运行组件缺失，请重新构建或安装工作台");
      const runtime = ensureDir(path.join(this.dataDir, "runtime", "tomcat"));
      const runtimeFile = path.join(runtime, "WorkbenchTomcat.class"),
        bytes = fs.readFileSync(helper);
      if (
        !fs.existsSync(runtimeFile) ||
        hash(fs.readFileSync(runtimeFile)) !== hash(bytes)
      )
        atomicWrite(runtimeFile, bytes);
      const requiredPorts = Array.from(
        new Set(
          [
            Number(serverDoc.documentElement?.getAttribute("port")),
            ...Array.from(serverDoc.getElementsByTagName("Connector")).map(
              (c) => Number(c.getAttribute("port")),
            ),
          ].filter((n) => Number.isInteger(n) && n > 0),
        ),
      );
      return {
        exe: java,
        args: [
          ...hotReload,
          ...vm,
          `-Dpersonal.workbench.instance=${marker}`,
          "-Djava.util.logging.config.file=" +
            path.join(base, "conf", "logging.properties"),
          "-Djava.util.logging.manager=org.apache.juli.ClassLoaderLogManager",
          "-Dcatalina.home=" + home,
          "-Dcatalina.base=" + base,
          "-Djava.io.tmpdir=" + path.join(base, "temp"),
          "-classpath",
          [
            runtime,
            path.join(home, "bin", "bootstrap.jar"),
            path.join(home, "bin", "tomcat-juli.jar"),
          ].join(path.delimiter),
          "WorkbenchTomcat",
          context,
          deployment,
          contextFile,
        ],
        cwd: home,
        env: {
          CATALINA_HOME: home,
          CATALINA_BASE: base,
          JAVA_HOME: path.dirname(path.dirname(java)),
        },
        port,
        requiredPorts,
        context,
        description:
          "复用 IDEA 的独立 Tomcat base、现有 exploded 部署" +
          (hotReload.length || vm.some((v) => /rebel/i.test(v))
            ? "与原 JRebel 代理、热更新配置"
            : "与原部署更新配置"),
        kind: p.type,
        deployment,
        identity: base,
      };
    }
    if (p.type === "spring") {
      const workspace = xml(path.join(p.path, ".idea", "workspace.xml"));
      const run = Array.from(
        workspace.getElementsByTagName("configuration"),
      ).find(
        (c) =>
          c.getAttribute("type") === "SpringBootApplicationConfigurationType" &&
          options(c).SPRING_BOOT_MAIN_CLASS === "com.ruoyi.RuoYiApplication",
      );
      if (!run) throw new Error("未找到 RuoYiApplication 运行配置");
      const opts = options(run);
      const misc = xml(path.join(p.path, ".idea", "misc.xml"));
      const jdkName = Array.from(misc.getElementsByTagName("component"))
        .find((c) => c.getAttribute("name") === "ProjectRootManager")
        ?.getAttribute("project-jdk-name");
      const java = p.java || this.jdk(jdkName || "");
      const pom = fs.readFileSync(path.join(p.path, "pom.xml"), "utf8");
      if (!pom.includes("spring-boot-maven-plugin"))
        throw new Error("项目缺少已配置的 Spring Boot Maven 插件");
      const maven = tools.maven;
      const boot = path.join(maven, "boot");
      const jar = fs
        .readdirSync(boot)
        .find((n) => /^plexus-classworlds.*\.jar$/.test(n));
      if (!jar) throw new Error("Maven 启动器不存在");
      const yaml = fs.readFileSync(
        path.join(p.path, "src", "main", "resources", "application.yml"),
        "utf8",
      );
      const serverBlock = (yaml.split(/^server:\s*\r?\n/m)[1] || "").split(
        /\r?\n(?=[^\s#])/,
      )[0];
      const port =
        p.expectedPort || Number(/^\s+port:\s*(\d+)/m.exec(serverBlock)?.[1]);
      const context =
        p.context || /^\s+context-path:\s*(\S+)/m.exec(serverBlock)?.[1] || "/";
      const profiles = p.springProfile || opts.ACTIVE_PROFILES || "";
      const vm = args(p.vmArgs?.trim() ? p.vmArgs : opts.VM_PARAMETERS || "");
      const classpathFile = path.join(
        this.dataDir,
        "runtime",
        "spring",
        hash(normalize(p.path)),
        "classpath.txt",
      );
      return {
        exe: java,
        args: [
          ...vm,
          `-Dpersonal.workbench.instance=${marker}`,
          "-classpath",
          path.join(p.path, "target", "classes"),
          "com.ruoyi.RuoYiApplication",
          ...(profiles ? ["--spring.profiles.active=" + profiles] : []),
        ],
        prepare: {
          exe: java,
          args: [
            "-Dmaven.home=" + maven,
            "-Dclassworlds.conf=" + path.join(maven, "bin", "m2.conf"),
            "-Dmaven.multiModuleProjectDirectory=" + p.path,
            "-classpath",
            path.join(boot, jar),
            "org.codehaus.plexus.classworlds.launcher.Launcher",
            "compile",
            "dependency:build-classpath",
            "-DskipTests",
            "-DincludeScope=runtime",
            "-Dmdep.outputFile=" + classpathFile,
          ],
          classpathFile,
        },
        cwd: p.path,
        env: { JAVA_HOME: path.dirname(path.dirname(java)) },
        port,
        context,
        description:
          "Maven 编译与解析依赖后退出，直接运行 RuoYiApplication，保留 JVM 参数、Spring Profile 与 DevTools 热更新",
        kind: p.type,
        identity: p.path,
      };
    }
    if (p.type === "vue") {
      const pkg = JSON.parse(
        fs.readFileSync(path.join(p.path, "package.json"), "utf8"),
      );
      if (pkg.scripts?.dev?.trim() !== "vue-cli-service serve")
        throw new Error("dev 入口已改变，请核对后再接入");
      const cli = path.join(
        p.path,
        "node_modules",
        "@vue",
        "cli-service",
        "bin",
        "vue-cli-service.js",
      );
      if (!fs.existsSync(cli))
        throw new Error("缺少项目已有 node_modules，请在原工具中安装依赖");
      const source = fs.readFileSync(
        path.join(p.path, "vue.config.js"),
        "utf8",
      );
      const port =
        p.expectedPort ||
        Number(/const port\s*=.*?\|\|\s*(\d+)/.exec(source)?.[1]);
      return {
        exe: tools.hbNode,
        args: [`--title=workbench-${marker}`, cli, "serve"],
        cwd: p.path,
        // Vue CLI honors BROWSER=none even when vue.config.js has open: true.
        env: { BROWSER: "none" },
        port,
        context: "/",
        description: "原 dev 入口 vue-cli-service serve",
        kind: p.type,
        identity: p.path,
      };
    }
    if (p.type === "wechat")
      return {
        exe: tools.wechat,
        args: [],
        cwd: p.path,
        env: {},
        context: "",
        description: "微信原生项目，由开发者工具承担编译和模拟器",
        kind: p.type,
        identity: p.path,
      };
    const manifest = jsonc(
      fs.readFileSync(path.join(p.path, "manifest.json"), "utf8"),
    );
    const platform = p.type === "uni-wechat" ? "mp-weixin" : "h5";
    const output = path.join(p.path, "unpackage", "dist", "dev", platform);
    const port =
      p.expectedPort ||
      (platform === "h5"
        ? Number(manifest.h5?.devServer?.port) || undefined
        : undefined);
    return {
      exe: tools.hbNode,
      args: [`--title=workbench-${marker}`, tools.hbCli],
      cwd: path.dirname(path.dirname(tools.hbCli)),
      env: {
        UNI_INPUT_DIR: p.path,
        UNI_OUTPUT_DIR: output,
        UNI_PLATFORM: platform,
        NODE_ENV: "development",
        BROWSER: "none",
      },
      port,
      context: "/",
      description:
        platform === "h5"
          ? "HBuilderX UniApp CLI H5 开发服务与原 H5 配置"
          : "HBuilderX 微信小程序编译监听，输出独立显示",
      kind: p.type,
      identity: p.path,
    };
  }
  private async inventory(refresh = false) {
    if (!refresh && this.cache && Date.now() - this.cache.at < 7000)
      return this.cache;
    const items = await processes();
    const cli = normalize(this.config.get().tools.hbCli);
    const nodes = items.filter(
      (p) =>
        p.commandLine &&
        (normalize(p.commandLine).includes(cli) ||
          /uniapp-cli/i.test(p.commandLine)) &&
        /node\.exe$/i.test(p.executable || ""),
    );
    let envs: Awaited<ReturnType<typeof processEnvironments>> = [];
    try {
      envs = await processEnvironments(nodes.map((p) => p.pid));
    } catch {
      /* Unconfirmed processes remain unknown, never treated as owned. */
    }
    this.cache = { at: Date.now(), items, envs };
    return this.cache;
  }
  private configurationFingerprint(cfg: Launch) {
    return hash(
      JSON.stringify([
        cfg.exe,
        cfg.args,
        cfg.cwd,
        cfg.env,
        cfg.port,
        cfg.context,
        cfg.deployment,
        ...(cfg.prepare ? [cfg.prepare] : []),
      ]),
    );
  }
  private async confirmedReady(
    p: ProjectConfig,
    cfg: Launch,
    run: RunInfo,
  ): Promise<{ state: "watching" | "running"; url?: string } | undefined> {
    if (!run.logPath || !fs.existsSync(run.logPath)) return;
    const file = fs.openSync(run.logPath, "r");
    let log: string;
    try {
      const size = fs.fstatSync(file).size,
        length = Math.min(size, 2 * 1024 * 1024),
        buffer = Buffer.alloc(length);
      fs.readSync(file, buffer, 0, length, size - length);
      log = buffer.toString("utf8").replace(/\x1b\[[0-9;]*m/g, "");
    } finally {
      fs.closeSync(file);
    }
    if (p.type === "uni-wechat") {
      if (
        /(DONE|编译成功|Compiled successfully)/i.test(log) &&
        fs.existsSync(path.join(String(cfg.env.UNI_OUTPUT_DIR), "app.json"))
      )
        return { state: "watching" };
      return;
    }
    let url: string | undefined;
    if (p.type === "tomcat") {
      if (/^WORKBENCH_TOMCAT_READY /m.test(log))
        url = `http://localhost:${cfg.port}${cfg.context}`;
    } else if (p.type === "spring") {
      const match = /Tomcat started on port(?:\(s\))?:?\s*(\d+)/i.exec(log);
      if (match) url = `http://localhost:${match[1]}${cfg.context}`;
      else if (
        cfg.port &&
        /Started RuoYiApplication in\s+[\d.]+\s+seconds/.test(log)
      )
        url = `http://localhost:${cfg.port}${cfg.context}`;
    } else {
      const match =
        /(?:Local:|本地[：:]?)\s*(https?:\/\/[^\s\x1b]+)/i.exec(log) ||
        /(https?:\/\/(?:localhost|127\.0\.0\.1):\d+[^\s\x1b]*)/.exec(log);
      if (match) url = match[1];
    }
    if (!url) return;
    const parsed = new URL(url),
      port = Number(parsed.port || (parsed.protocol === "https:" ? 443 : 80));
    if (cfg.port && port !== cfg.port)
      throw new Error(
        `工具实际端口 ${port} 与已核对的 ${cfg.port} 不一致，请处理占用后重新检查`,
      );
    if (!(await reachable(url))) return;
    const pids = await listenerPids(port),
      tree = await processes(),
      root = tree.find((a) => a.pid === run.pid);
    if (
      !root ||
      !sameProcess(run, root) ||
      !run.marker ||
      !root.commandLine?.includes(run.marker)
    )
      return;
    const ownedPids = new Set([run.pid!]);
    for (let count = 0; count < tree.length; count++) {
      const children = tree.filter(
        (child) =>
          ownedPids.has(child.parent) &&
          !ownedPids.has(child.pid) &&
          child.created >=
            (tree.find((parent) => parent.pid === child.parent)?.created || ""),
      );
      if (!children.length) break;
      children.forEach((child) => ownedPids.add(child.pid));
    }
    if (!pids.some((pid) => ownedPids.has(pid)))
      throw new Error(
        `地址有响应，但端口 ${port} 的监听进程不属于本次工具链，未标记就绪`,
      );
    return { state: "running", url };
  }
  async inspect(
    projectId: string,
    refresh = false,
  ): Promise<RunInfo & { configuration?: Launch }> {
    const p = this.config.project(projectId);
    const previous = this.tasks.store.get<RunInfo>("run", projectId);
    let branch = "";
    try {
      branch = await this.git.text(p.path, ["branch", "--show-current"]);
    } catch {}
    let cfg: Launch;
    try {
      cfg = this.launchConfig(p, previous?.marker || "preflight");
      if (!fs.existsSync(cfg.exe))
        throw new Error("运行工具不存在：" + cfg.exe);
    } catch (e) {
      if (previous?.pid && previous.marker) {
        const inventory = await this.inventory(refresh);
        const owned = inventory.items.some(
          (a) =>
            sameProcess(previous, a) &&
            a.commandLine?.includes(previous.marker!),
        );
        if (owned)
          return {
            ...previous,
            state: "unknown",
            canStop: true,
            message:
              "运行配置无法读取，原工具链进程仍在运行，请先停止该实例。" +
              errorText(e),
          };
      }
      return {
        projectId,
        state: "unconfigured",
        branch,
        message: errorText(e),
      };
    }
    const inventory = await this.inventory(refresh);
    const owned = previous?.pid
      ? inventory.items.find(
          (a) =>
            sameProcess(previous, a) &&
            !!previous.marker &&
            a.commandLine?.includes(previous.marker),
        )
      : undefined;
    if (owned) {
      const run = { ...previous!, branch, canStop: true };
      if (
        run.configurationFingerprint &&
        run.configurationFingerprint !== this.configurationFingerprint(cfg)
      ) {
        return {
          ...run,
          state: "unknown",
          branch: previous!.branch,
          message:
            "运行配置已改变，原实例仍在运行；请先停止后使用新配置重新启动",
          configuration: cfg,
        };
      }
      if (run.state === "starting" && !this.starting.has(projectId)) {
        run.state = "unknown";
        run.message =
          "工作台重新打开，仍检测到同一进程；上次启动结果需重新核实";
      }
      if (
        run.state === "running" &&
        (!run.url || !(await reachable(run.url)))
      ) {
        run.state = "unknown";
        run.message = "进程身份已核实，但原地址当前不可用，请查看日志";
      }
      if (run.state === "unknown") {
        try {
          const ready = await this.confirmedReady(p, cfg, run);
          if (ready) {
            Object.assign(run, ready, {
              message: "已重新核实原进程、工具输出与就绪状态",
            });
            this.save(run);
          }
        } catch (error) {
          run.message = errorText(error);
        }
      }
      return { ...run, configuration: cfg };
    }
    const external = inventory.items.find((a) => {
      const line = normalize(a.commandLine);
      if (p.type === "h5" || p.type === "uni-wechat") {
        const env = inventory.envs.find((e) => e.pid === a.pid);
        return (
          normalize(env?.input) === normalize(p.path) &&
          env?.platform === (p.type === "h5" ? "h5" : "mp-weixin")
        );
      }
      if (p.type === "tomcat")
        return (
          line.includes(normalize(cfg.identity)) &&
          (line.includes("org.apache.catalina.startup.bootstrap") ||
            /\bworkbenchtomcat\b/.test(line))
        );
      if (p.type === "spring")
        return (
          line.includes(normalize(p.path)) &&
          (line.includes("ruoyiapplication") ||
            line.includes("spring-boot:run"))
        );
      if (p.type === "vue")
        return (
          line.includes(normalize(p.path)) && line.includes("vue-cli-service")
        );
      return false;
    });
    if (external)
      return {
        projectId,
        branch,
        state: "external",
        pid: external.pid,
        created: external.created,
        executable: external.executable,
        message: "已核实外部实例，使用原工具管理；工作台不提供停止操作",
        configuration: cfg,
      };
    if (previous?.state === "tool-open" && p.type === "wechat")
      return {
        ...previous,
        branch,
        configuration: cfg,
        message: "上次已打开开发者工具；当前编译和模拟器状态请在工具中核对",
      };
    if (previous?.state === "starting" && this.starting.has(projectId))
      return { ...previous, branch, configuration: cfg };
    const occupied = cfg.port && !(await freePort(cfg.port));
    if (occupied)
      return {
        projectId,
        branch,
        state: "unknown",
        message: `端口 ${cfg.port} 已被占用，未能核实为本项目；请在原工具检查，工作台不自动终止或改端口`,
        configuration: cfg,
      };
    return {
      projectId,
      branch,
      state: previous?.state === "failed" ? "failed" : "stopped",
      message: previous?.state === "failed" ? previous.message : undefined,
      configuration: cfg,
    };
  }
  async list() {
    await this.inventory();
    return Promise.all(
      this.config.get().projects.map((p) =>
        this.inspect(p.id).catch((e) => ({
          projectId: p.id,
          state: "unknown" as const,
          branch: "",
          message: errorText(e),
        })),
      ),
    );
  }
  async start(projectId: string): Promise<{ run: RunInfo; taskId?: string; reused: boolean }> {
    const p = this.config.project(projectId),
      current = await this.inspect(projectId, true);
    if (["running", "watching", "starting", "external"].includes(current.state))
      return { run: current, reused: true };
    if (current.canStop)
      throw new Error(
        "原工具链进程仍在运行，请先查看日志并停止该实例后再启动；不会重复创建进程",
      );
    if (["unknown", "unconfigured"].includes(current.state))
      throw new Error(current.message || "请先检查运行配置");
    if (p.type === "wechat") {
      const opened = await this.openWechat(projectId);
      return { run: current, taskId: opened.taskId, reused: false };
    }
    const marker = id(),
      cfg = this.launchConfig(p, marker);
    const task = this.tasks.create(
      "run",
      `启动 ${p.name}`,
      projectId,
      "run:" + normalize(p.path),
      { projectId, description: cfg.description },
      [
        "检查配置与已有实例",
        "启动工具链",
        "确认就绪",
        ...(this.openReadyUrl && ["h5", "vue"].includes(p.type)
          ? ["打开实际地址"]
          : []),
        ...(p.type === "uni-wechat" ? ["打开微信开发者工具"] : []),
      ],
    );
    const run: RunInfo = {
      projectId,
      branch: current.branch,
      state: "starting",
      marker,
      logPath: task.logPath,
      configurationFingerprint: this.configurationFingerprint(cfg),
    };
    this.starting.set(projectId, task.id);
    this.save(run);
    this.tasks.launch(task, async (ctx) => {
      try {
        await ctx.step("检查配置与已有实例", async () => {
          for (const port of cfg.requiredPorts || (cfg.port ? [cfg.port] : []))
            if (!(await freePort(port)))
              throw new Error(
                `端口 ${port} 已被占用；未更改端口或结束其他进程`,
              );
          ctx.log(cfg.description);
        });
        await ctx.step("启动工具链", async () => {
          const runner =
            this.runnerFile ||
            path.resolve(
              path.dirname(fileURLToPath(import.meta.url)),
              "../main/service-runner.cjs",
            );
          const launch = { ...cfg, marker, logPath: task.logPath };
          const proc = spawn(process.execPath, [runner, "--marker=" + marker], {
            cwd: cfg.cwd,
            env: {
              ...process.env,
              ELECTRON_RUN_AS_NODE: "1",
              WORKBENCH_SERVICE_LAUNCH: JSON.stringify(launch),
            },
            windowsHide: true,
            shell: false,
            detached: true,
            stdio: "ignore",
          });
          proc.on("error", (e) => {
            run.state = "failed";
            run.message = e.message;
            this.save(run);
          });
          proc.on("exit", (code) => {
            run.state =
              run.state === "stopping"
                ? "stopped"
                : code === 0
                  ? "stopped"
                  : "failed";
            run.message = `工具链进程已退出（${code}）`;
            this.save(run);
          });
          proc.unref();
          if (!proc.pid) throw new Error("未能创建服务进程");
          run.pid = proc.pid;
          // Windows can briefly return a process before ExecutablePath is available.
          // Wait for a complete identity rather than persisting an unmanageable PID.
          let actual: ProcessIdentity | undefined;
          const identityDeadline = Date.now() + 10000;
          while (Date.now() < identityDeadline) {
            const candidate = (await processes()).find((x) => x.pid === proc.pid);
            if (candidate?.created && candidate.executable && candidate.commandLine?.includes(marker)) {
              actual = candidate;
              break;
            }
            if (proc.exitCode !== null)
              throw new Error("启动进程已退出，查看日志定位");
            ctx.checkStop();
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          if (!actual) throw new Error("未能核实启动进程的完整身份，查看日志定位");
          run.created = actual.created;
          run.executable = actual.executable;
          this.save(run);
          ctx.result({
            pid: run.pid,
            created: run.created,
            executable: run.executable,
            marker,
          });
        });
        await ctx.step("确认就绪", async () => {
          const started = Date.now();
          const timeout = p.type === "tomcat" ? 600000 : 180000;
          while (Date.now() - started < timeout) {
            ctx.checkStop();
            if (run.state === "failed" || run.state === "stopped")
              throw new Error(run.message || "进程提前退出");
            const ready = await this.confirmedReady(p, cfg, run);
            if (ready) {
              Object.assign(run, ready, {
                message:
                  ready.state === "watching"
                    ? "编译成功，监听中；正在打开微信开发者工具"
                    : "已从工具输出、HTTP 响应与监听进程确认就绪",
              });
              this.save(run);
              ctx.result(
                ready.state === "watching"
                  ? { output: cfg.env.UNI_OUTPUT_DIR, watching: true }
                  : { url: ready.url, ready: true },
              );
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 700));
          }
          throw new Error(
            "启动确认超时，进程与日志已保留；可核对后停止本工作台拥有的实例",
          );
        });
        if (this.openReadyUrl && ["h5", "vue"].includes(p.type))
          await ctx.step("打开实际地址", async () => {
            if (!run.url) throw new Error("服务没有经过核实的地址");
            await this.openReadyUrl!(run.url, p);
            ctx.result({ browserOpened: true, url: run.url });
          });
        if (p.type === "uni-wechat")
          await ctx.step("打开微信开发者工具", async () => {
            const target = await this.wechatTarget(p);
            const abort = new AbortController();
            this.tasks.aborts.set(task.id, abort);
            ctx.checkStop();
            await this.openWechatTarget(p, target, task.logPath, abort.signal);
            ctx.result({ target, clientOpened: true });
          });
      } catch (e) {
        if (run.state === "starting") {
          run.state = "unknown";
          run.message = errorText(e);
          this.save(run);
        } else if (p.type === "uni-wechat") {
          const current = this.tasks.store.get<RunInfo>("run", projectId);
          if (current?.state === "watching")
            this.save({
              ...current,
              message: "编译监听仍在运行，微信开发者工具未打开；可点击“打开开发者工具”重试。" + errorText(e),
            });
        }
        throw e;
      } finally {
        this.starting.delete(projectId);
        this.cache = undefined;
      }
    });
    return { run, taskId: task.id, reused: false };
  }
  private save(run: RunInfo) {
    this.tasks.store.set("run", run.projectId, run);
    this.changed();
  }
  async stop(projectId: string) {
    const run = this.tasks.store.get<RunInfo>("run", projectId);
    if (!run?.pid || !run.marker) throw new Error("没有工作台拥有的进程可停止");
    const actual = (await processes()).find((p) => p.pid === run.pid);
    if (
      !actual ||
      !sameProcess(run, actual) ||
      !actual.commandLine?.includes(run.marker)
    )
      throw new Error("进程身份已变化，拒绝按旧 PID 停止");
    const starting = this.starting.get(projectId);
    if (starting) this.tasks.cancel(starting);
    run.state = "stopping";
    this.save(run);
    await terminateTree(run.pid);
    const left = (await processes()).find((p) => sameProcess(run, p));
    if (left) {
      run.state = "unknown";
      run.message = "停止后仍检测到同一进程，请查看原工具";
      this.save(run);
      throw new Error(run.message);
    }
    run.state = "stopped";
    run.url = undefined;
    this.save(run);
    this.cache = undefined;
    return run;
  }
  async restart(projectId: string) {
    await this.stop(projectId);
    return this.start(projectId);
  }
  private async wechatTarget(p: ProjectConfig) {
    if (!["wechat", "uni-wechat"].includes(p.type))
      throw new Error("该项目不是小程序");
    let target = p.path;
    if (p.type === "uni-wechat") {
      const run = await this.inspect(p.id, true);
      if (run.state !== "watching" && run.state !== "external")
        throw new Error("请先完成微信小程序编译监听");
      target = path.join(p.path, "unpackage", "dist", "dev", "mp-weixin");
      if (!fs.existsSync(path.join(target, "app.json")))
        throw new Error("实际编译输出不存在");
      if (!fs.existsSync(path.join(target, "project.config.json")))
        throw new Error("微信小程序编译输出缺少 project.config.json");
    } else {
      const config = jsonc(
        fs.readFileSync(path.join(p.path, "project.config.json"), "utf8"),
      );
      if (config.compileType !== "miniprogram")
        throw new Error("原生项目类型不是 miniprogram");
    }
    return target;
  }
  private async openWechatTarget(
    p: ProjectConfig,
    target: string,
    logPath: string,
    signal?: AbortSignal,
  ) {
    const root = path.dirname(this.config.get().tools.wechat),
      node = path.join(root, "node.exe"),
      cli = path.join(root, "cli.js");
    if (!fs.existsSync(node) || !fs.existsSync(cli))
      throw new Error("缺少微信开发者工具原生 CLI");
    const result = await command(node, [cli, "open", "--project", target], {
      cwd: root,
      logPath,
      timeoutMs: 90000,
      signal,
    });
    // Some WeChat CLI versions report a project-open error but still exit with 0.
    const output = result.stdout + "\n" + result.stderr;
    if (/需要重新登录|未登录|not logged in|login required/i.test(output))
      throw new Error("微信开发者工具需要重新登录，请扫码登录后点击“打开开发者工具”重试");
    if (/(?:^|\n)\s*(?:\[error\]|(?:Error|错误)\s*[:：])/i.test(output))
      throw new Error("微信开发者工具未能打开项目，请查看任务日志后重试");
    const previous = this.tasks.store.get<RunInfo>("run", p.id);
    this.save({
      ...previous,
      projectId: p.id,
      state: p.type === "wechat" ? "tool-open" : previous?.state || "unknown",
      branch: previous?.branch || "",
      toolOpened: true,
      message: "开发者工具已打开，模拟器与业务结果在原工具内核对",
    });
  }
  async openWechat(projectId: string) {
    const p = this.config.project(projectId);
    if (p.type === "uni-wechat") {
      const run = await this.inspect(projectId, true);
      if (!["watching", "external"].includes(run.state))
        return this.start(projectId);
    }
    const target = await this.wechatTarget(p);
    const task = this.tasks.create(
      "wechat",
      `打开 ${p.name} 开发者工具`,
      projectId,
      null,
      { projectId, target },
      ["打开现有开发者工具"],
    );
    this.tasks.launch(task, async (ctx) => {
      await ctx.step("打开现有开发者工具", async () => {
        const abort = new AbortController();
        this.tasks.aborts.set(task.id, abort);
        ctx.checkStop();
        await this.openWechatTarget(p, target, task.logPath, abort.signal);
        ctx.result({ target, clientOpened: true });
      });
    });
    return { taskId: task.id, state: "opening" };
  }
  async owned() {
    const items = await processes();
    return this.tasks.store
      .list<RunInfo>("run")
      .filter(
        (r) =>
          r.pid &&
          r.marker &&
          items.some(
            (p) => sameProcess(r, p) && p.commandLine?.includes(r.marker!),
          ),
      );
  }
  async url(projectId: string) {
    const run = await this.inspect(projectId, true);
    if (run.state !== "running" || !run.url || !(await reachable(run.url)))
      throw new Error("当前没有经过核实的可用地址");
    return run.url;
  }
}

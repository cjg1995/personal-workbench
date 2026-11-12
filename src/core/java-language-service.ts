import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { pathToFileURL } from "node:url";
import type { ProjectConfig } from "../shared/types.js";
import { ensureDir, hash } from "./util.js";

type Notify = (method: string, params: any) => void;
type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };

function javaRuntimes(runtime: string, project: ProjectConfig) {
  const result: { name: string; path: string; default?: boolean }[] = [];
  const add = (candidate?: string) => {
    if (!candidate) return;
    const home = candidate.toLowerCase().endsWith("java.exe")
      ? path.dirname(path.dirname(candidate)) : candidate;
    if (!fs.existsSync(path.join(home, "bin", "java.exe"))) return;
    let version = "";
    try { version = /^JAVA_VERSION="([^"]+)"/m.exec(fs.readFileSync(path.join(home, "release"), "utf8"))?.[1] || ""; }
    catch { /* Older runtimes may lack a release file. */ }
    const major = version.startsWith("1.") ? Number(version.split(".")[1]) : Number(version.split(".")[0]);
    if (!Number.isInteger(major) || major < 7) return;
    const name = `JavaSE-${major === 7 || major === 8 ? `1.${major}` : major}`;
    if (!result.some((item) => item.name === name)) result.push({ name, path: home });
  };
  add(project.java);
  add(process.env.JAVA_HOME);
  add(process.env.JDK_HOME);
  for (const base of [
    path.join(process.env.PROGRAMFILES || "C:/Program Files", "Java"),
    path.join(process.env.PROGRAMFILES || "C:/Program Files", "Eclipse Adoptium"),
  ]) {
    try { for (const name of fs.readdirSync(base)) add(path.join(base, name)); }
    catch { /* Optional JDK directory. */ }
  }
  add(runtime);
  return result;
}

export class JavaLanguageService {
  private process?: ChildProcessWithoutNullStreams;
  private buffer = Buffer.alloc(0);
  private pending = new Map<number, Pending>();
  private nextId = 1;
  private startPromise?: Promise<void>;
  private active = false;
  private stopped = false;
  private stopPromise?: Promise<void>;
  private documents = new Map<string, { version: number; text: string }>();
  private settings: Record<string, any> = {};
  private lastError = "";
  status = "starting";

  constructor(
    private project: ProjectConfig,
    private runtimeRoot: string,
    private dataDir: string,
    private notifyClient: Notify,
    private mavenHome?: string,
  ) {}

  get root() { return path.resolve(this.project.path); }
  get ready() { return this.active; }
  get error() { return this.lastError; }

  private uri(file: string) { return pathToFileURL(file).href; }

  start() {
    if (!this.startPromise) this.startPromise = this.launch();
    return this.startPromise;
  }

  private send(message: any) {
    if (!this.process || this.process.killed) throw new Error("Java 语言服务未运行");
    const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...message }), "utf8");
    this.process.stdin.write(Buffer.concat([
      Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body,
    ]));
  }

  private requestRaw(method: string, params: any, timeoutMs = 45000): Promise<any> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        try { this.send({ method: "$/cancelRequest", params: { id } }); } catch { /* Already exited. */ }
        reject(new Error(`${method} 请求超时`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try { this.send({ id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  private notification(method: string, params: any) {
    if (this.active) this.send({ method, params });
  }

  private async launch() {
    const jdt = path.join(this.runtimeRoot, "jdtls");
    const javaHome = path.join(this.runtimeRoot, "jre");
    const java = path.join(javaHome, "bin", "java.exe");
    let launcher = "";
    try {
      launcher = fs.readdirSync(path.join(jdt, "plugins"))
        .find((file) => /^org\.eclipse\.equinox\.launcher_.*\.jar$/.test(file)) || "";
    } catch { /* Missing runtime is reported below. */ }
    if (!fs.existsSync(java) || !launcher) {
      this.status = "error";
      this.lastError = "Java 语言服务组件缺失，请重新安装完整版本";
      this.notifyClient("status", { status: this.status, message: this.lastError });
      throw new Error(this.lastError);
    }
    const data = ensureDir(path.join(this.dataDir, "java-workspaces", hash(this.root.toLowerCase()).slice(0, 16)));
    const configuration = ensureDir(path.join(data, "launcher-config"));
    const args = [
      "-Declipse.application=org.eclipse.jdt.ls.core.id1",
      "-Dosgi.bundles.defaultStartLevel=4",
      "-Declipse.product=org.eclipse.jdt.ls.core.product",
      "-Djava.import.generatesMetadataFilesAtProjectRoot=false",
      "-Dosgi.checkConfiguration=true",
      `-Dosgi.sharedConfiguration.area=${path.join(jdt, "config_win")}`,
      "-Dosgi.sharedConfiguration.area.readOnly=true",
      "-Dosgi.configuration.cascaded=true",
      "-Xms128m", "-Xmx2048m",
      "-Djdk.xml.maxGeneralEntitySizeLimit=0",
      "-Djdk.xml.totalEntitySizeLimit=0",
      "--add-modules=ALL-SYSTEM",
      "--add-opens", "java.base/java.util=ALL-UNNAMED",
      "--add-opens", "java.base/java.lang=ALL-UNNAMED",
      "-jar", path.join(jdt, "plugins", launcher),
      "-configuration", configuration,
      "-data", data,
    ];
    const env = { ...process.env };
    delete env.CLIENT_PORT;
    delete env.CLIENT_HOST;
    const child = spawn(java, args, {
      cwd: this.root,
      env,
      windowsHide: true,
      stdio: "pipe",
    });
    this.process = child;
    child.stdout.on("data", (chunk: Buffer) => this.consume(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      this.lastError = (this.lastError + chunk.toString("utf8")).slice(-3000);
    });
    child.on("error", (error) => this.fail(error));
    child.on("exit", (code) => this.fail(new Error(`Java 语言服务已退出（${code}）：${this.lastError}`)));
    const rootUri = this.uri(this.root);
    const settings = {
      java: {
        home: javaHome,
        configuration: { runtimes: javaRuntimes(javaHome, this.project), updateBuildConfiguration: "automatic",
          maven: {
            userSettings: fs.existsSync(path.join(process.env.USERPROFILE || "", ".m2", "settings.xml"))
              ? path.join(process.env.USERPROFILE || "", ".m2", "settings.xml") : null,
            globalSettings: this.mavenHome && fs.existsSync(path.join(this.mavenHome, "conf", "settings.xml"))
              ? path.join(this.mavenHome, "conf", "settings.xml") : null,
          } },
        import: { maven: { enabled: true }, gradle: { enabled: true }, generatesMetadataFilesAtProjectRoot: false, exclusions: [
          "**/node_modules/**", "**/target/**", "**/build/**", "**/.git/**",
        ] },
        maven: { downloadSources: false },
        autobuild: { enabled: false },
        signatureHelp: { enabled: true },
        referencesCodeLens: { enabled: false },
        implementationCodeLens: "all",
      },
    };
    this.settings = settings;
    try {
      await this.requestRaw("initialize", {
        processId: process.pid,
        clientInfo: { name: "Personal Workbench", version: "0.1" },
        rootUri,
        rootPath: this.root,
        workspaceFolders: [{ uri: rootUri, name: this.project.name }],
        initializationOptions: { bundles: [], workspaceFolders: [rootUri], settings,
          extendedClientCapabilities: { classFileContentsSupport: true, progressReportProvider: true } },
        capabilities: {
          workspace: { configuration: true, workspaceFolders: true, didChangeWatchedFiles: { dynamicRegistration: false } },
          window: { workDoneProgress: true },
          textDocument: {
            synchronization: { didSave: true, dynamicRegistration: false },
            definition: { linkSupport: true },
            implementation: { linkSupport: true },
            typeHierarchy: { dynamicRegistration: false },
            completion: { completionItem: { snippetSupport: false, documentationFormat: ["plaintext", "markdown"],
              resolveSupport: { properties: ["detail", "documentation", "additionalTextEdits"] } } },
            hover: { contentFormat: ["markdown", "plaintext"] },
            publishDiagnostics: { relatedInformation: true },
          },
        },
      }, 180000);
      if (this.stopped) return;
      this.active = true;
      this.status = "indexing";
      this.send({ method: "initialized", params: {} });
      for (const [uri, doc] of this.documents)
        this.send({ method: "textDocument/didOpen", params: {
          textDocument: { uri, languageId: "java", version: doc.version, text: doc.text },
        } });
      this.notifyClient("status", { status: this.status, message: "Java 工程索引中" });
    } catch (error) {
      this.status = "error";
      this.lastError = error instanceof Error ? error.message : String(error);
      this.notifyClient("status", { status: this.status, message: this.lastError });
      throw error;
    }
  }

  private fail(error: Error) {
    if (this.stopped) return;
    this.active = false;
    this.status = "error";
    this.lastError = error.message;
    this.notifyClient("status", { status: this.status, message: this.lastError });
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private consume(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      const end = this.buffer.indexOf("\r\n\r\n");
      if (end < 0) return;
      const header = this.buffer.subarray(0, end).toString("ascii");
      const match = /(?:^|\r\n)Content-Length:\s*(\d+)/i.exec(header);
      if (!match) { this.buffer = this.buffer.subarray(end + 4); continue; }
      const length = Number(match[1]);
      if (length > 32 * 1024 * 1024) { this.fail(new Error("Java 语言服务消息过大")); return; }
      if (this.buffer.length < end + 4 + length) return;
      const body = this.buffer.subarray(end + 4, end + 4 + length);
      this.buffer = this.buffer.subarray(end + 4 + length);
      try { this.handle(JSON.parse(body.toString("utf8"))); }
      catch (error) { this.lastError = String(error); }
    }
  }

  private handle(message: any) {
    if (message.id !== undefined && !message.method) {
      const pending = this.pending.get(Number(message.id));
      if (!pending) return;
      this.pending.delete(Number(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || "语言服务请求失败"));
      else pending.resolve(message.result);
      return;
    }
    if (message.id !== undefined) {
      let result: any = null;
      if (message.method === "workspace/configuration")
        result = (message.params?.items || []).map((item: any) => {
          if (!item.section) return this.settings;
          return String(item.section).split(".").reduce((value: any, key: string) => value?.[key], this.settings) ?? null;
        });
      if (message.method === "workspace/applyEdit") result = { applied: false };
      this.send({ id: message.id, result });
      return;
    }
    if (message.method === "language/status") {
      const type = String(message.params?.type || "");
      if (/ready/i.test(type)) this.status = "ready";
      else if (/starting|progress/i.test(type)) this.status = "indexing";
      this.notifyClient("status", { status: this.status, message: message.params?.message || "" });
    } else if (message.method === "textDocument/publishDiagnostics") {
      this.notifyClient("diagnostics", message.params);
    } else if (message.method === "$/progress") {
      this.notifyClient("progress", message.params);
    }
  }

  open(file: string, text: string) {
    const uri = this.uri(file);
    const existing = this.documents.get(uri);
    if (existing) return;
    this.documents.set(uri, { text, version: 1 });
    this.notification("textDocument/didOpen", {
      textDocument: { uri, languageId: "java", version: 1, text },
    });
  }

  change(file: string, text: string) {
    const uri = this.uri(file), current = this.documents.get(uri);
    if (!current) { this.open(file, text); return; }
    if (current.text === text) return;
    current.text = text;
    current.version++;
    this.notification("textDocument/didChange", {
      textDocument: { uri, version: current.version },
      contentChanges: [{ text }],
    });
  }

  save(file: string, text: string) {
    this.change(file, text);
    this.notification("textDocument/didSave", { textDocument: { uri: this.uri(file) }, text });
  }

  close(file: string) {
    const uri = this.uri(file);
    if (!this.documents.delete(uri)) return;
    this.notification("textDocument/didClose", { textDocument: { uri } });
  }

  watched(changes: { uri: string; type: number }[]) {
    if (changes.length) this.notification("workspace/didChangeWatchedFiles", { changes });
  }

  async request(method: string, params: any) {
    await this.start();
    if (!this.active) throw new Error(this.lastError || "Java 语言服务未就绪");
    return this.requestRaw(method, params);
  }

  stop() {
    if (!this.stopPromise) this.stopPromise = this.stopProcess();
    return this.stopPromise;
  }

  private async stopProcess() {
    this.stopped = true;
    const child = this.process;
    if (!child) return;
    try {
      if (this.active) {
        await this.requestRaw("shutdown", null, 3000);
        this.send({ method: "exit", params: null });
      }
    } catch { /* Process may have already exited. */ }
    this.active = false;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Java 语言服务已停止"));
    }
    this.pending.clear();
    if (child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { child.kill(); resolve(); }, 2000);
      child.once("exit", () => { clearTimeout(timer); resolve(); });
    });
  }
}

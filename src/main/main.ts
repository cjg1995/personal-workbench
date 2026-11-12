import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  shell,
  screen,
  Notification,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { Store } from "../core/store.js";
import { ConfigService } from "../core/config.js";
import { RecordsService } from "../core/records.js";
import { TaskManager } from "../core/tasks.js";
import { Git } from "../core/git.js";
import { GitClientService } from "../core/git-client.js";
import type { DiffWindowRequest } from "../shared/git-client.js";
import { gitOperationLabel } from "../shared/git-labels.js";
import { SubmitService } from "../core/submit.js";
import {
  submitPolicyForProject,
  submitProjectIds,
  submitTabForProject,
} from "../shared/submit-policy.js";
import { ApkService } from "../core/apk.js";
import { BackupService } from "../core/backup.js";
import { ReviewService } from "../core/review.js";
import { ProjectService } from "../core/projects.js";
import { readLogTail } from "../core/log-tail.js";
import { ProjectBrowser } from "../core/project-browser.js";
import { EditorFiles, projectFile } from "../core/editor-files.js";
import { JavaLanguageService } from "../core/java-language-service.js";
import {
  activateClientWindow,
  clientProcesses,
  visibleClientWindows,
} from "../core/process.js";
import { exportWord } from "../core/documents.js";
import {
  activationTask,
  notificationAppId,
  notificationClsid,
  projectNotification,
} from "../core/notifications.js";
import {
  atomicWrite,
  ensureDir,
  errorText,
  inside,
  hash,
  id,
  localDate,
  now,
  redact,
  requireText,
} from "../core/util.js";
import type {
  Configuration,
  MonthlyDraft,
  RecordKind,
  RunInfo,
} from "../shared/types.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const override = process.argv
  .find((v) => v.startsWith("--data-dir="))
  ?.slice(11);
const dataDir = ensureDir(
  override
    ? path.resolve(override)
    : path.join(
        process.env.LOCALAPPDATA || app.getPath("appData"),
        "PersonalWorkbench",
      ),
);
app.setPath("userData", dataDir);
app.setName("个人工作台");
function localIcon(name: string) {
  const source = path.resolve(here, "../../assets", name);
  const target = path.join(dataDir, name);
  try {
    fs.copyFileSync(source, target);
    return target;
  } catch {
    return source;
  }
}
const notificationIcon = localIcon("workbench-v2-64.png");
const windowIcon =
  process.platform === "win32"
    ? localIcon("workbench-v2.ico")
    : notificationIcon;
// Electron's development shortcut and toast server must not claim the installed app.
const windowsAppId = app.isPackaged
  ? notificationAppId
  : notificationAppId + ".dev";
const toastActivatorClsid = app.isPackaged
  ? notificationClsid
  : "{6F558728-F459-4FF1-9226-489EEA7A4842}";
if (process.platform === "win32") {
  app.setAppUserModelId(windowsAppId);
  app.setToastActivatorCLSID(toastActivatorClsid);
}
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  let win: BrowserWindow;
  let exiting = false,
    closeDialog = false;
  let restoringData = false,
    pendingActions = 0;
  let pendingNotificationTask: string | null = null;
  let focusNotificationOnReady = false;
  const notifications = new Map<string, Notification>();
  const diffWindows = new Map<
    string,
    {
      window: BrowserWindow;
      request: DiffWindowRequest;
      watchers?: fs.FSWatcher[];
      watchTimer?: ReturnType<typeof setTimeout>;
    }
  >();
  const editorWindows = new Map<string, {
    window: BrowserWindow;
    projectId: string;
    language?: JavaLanguageService;
    watchers: Map<string, fs.FSWatcher>;
    projectWatcher?: fs.FSWatcher;
    projectWatchTimer?: ReturnType<typeof setTimeout>;
  }>();
  const editorFiles = new EditorFiles(app.isPackaged
    ? path.join(process.resourcesPath, "editor-runtime", "rg.exe")
    : path.resolve(here, "../../node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe"));
  let lastActivation: { taskId: string; at: number } | undefined;
  let changedTimer: ReturnType<typeof setTimeout> | undefined;
  const store = new Store(path.join(dataDir, "workbench.sqlite"));
  const config = new ConfigService(store, dataDir);
  const changed = () => {
    if (!changedTimer)
      changedTimer = setTimeout(() => {
        changedTimer = undefined;
        if (win && !win.isDestroyed())
          win.webContents.send("workbench:changed");
        for (const item of diffWindows.values())
          if (!item.window.isDestroyed())
            item.window.webContents.send("workbench:changed");
      }, 120);
  };
  const projectBrowser = new ProjectBrowser(dataDir, (url) => shell.openExternal(url));
  const tasks = new TaskManager(store, dataDir, changed),
    records = new RecordsService(store, dataDir),
    git = new Git(config.get().tools.git),
    submit = new SubmitService(git, tasks, dataDir),
    apk = new ApkService(config, tasks, dataDir),
    review = new ReviewService(git, store, records, (message) => {
      if (win && !win.isDestroyed())
        win.webContents.send("workbench:review-progress", message);
    }),
    projects = new ProjectService(
      config,
      git,
      tasks,
      dataDir,
      changed,
      undefined,
      undefined,
      (url, project) => projectBrowser.open(project, url),
    );
  const backup = new BackupService(store, tasks, dataDir, async () => {
    if ((await projects.owned()).length)
      throw new Error(
        "仍有工作台拥有的项目进程，请先停止自有服务再恢复，以保留其停止与归属信息",
      );
  });
  const gitClient = new GitClientService(git, tasks, dataDir, (repo) => {
    const project = config.get().projects.find((project) =>
      path.resolve(project.path).toLowerCase() === path.resolve(repo).toLowerCase());
    if (project?.id === "refsys") return ["src/main/", "pom.xml"];
    if (project?.id === "refsys-ui")
      return ["src/"];
    return undefined;
  });
  const diffEntry = path.resolve(here, "../renderer/diff.html");
  const diffAllowed = pathToFileURL(diffEntry).href;
  const editorEntry = path.resolve(here, "../renderer/editor.html");
  const editorAllowed = pathToFileURL(editorEntry).href;
  const editorRuntime = app.isPackaged
    ? path.join(process.resourcesPath, "editor-runtime")
    : path.resolve(here, "../../.local/editor-runtime");
  async function watchDiff(
    source: BrowserWindow | undefined,
    repo: string,
    file: string,
  ) {
    const item = [...diffWindows.values()].find(
      (item) => item.window === source,
    );
    if (!item) return;
    item.watchers?.forEach((w) => w.close());
    item.watchers = [];
    clearTimeout(item.watchTimer);
    const notifyFile = () => {
      clearTimeout(item.watchTimer);
      item.watchTimer = setTimeout(() => {
        if (!item.window.isDestroyed())
          item.window.webContents.send("workbench:changed");
      }, 180);
    };
    for (const directory of [
      path.dirname(path.resolve(repo, file)),
      await git.gitDir(repo),
    ]) {
      try {
        const watcher = fs.watch(directory, notifyFile);
        watcher.on("error", () => {});
        item.watchers.push(watcher);
      } catch {}
    }
  }
  async function openDiff(request: DiffWindowRequest) {
    const project = knownProject(request.projectId);
    if (!request.comparison || typeof request.file !== "string")
      throw new Error("对比参数无效");
    const key = path.resolve(project.path).toLowerCase();
    const existing = diffWindows.get(key);
    if (existing && !existing.window.isDestroyed()) {
      if (
        !(await existing.window.webContents.executeJavaScript(
          "window.__workbenchCanClose ? window.__workbenchCanClose() : true",
        ))
      )
        return { cancelled: true };
      existing.request = request;
      existing.window.webContents.send("workbench:git-diff", request);
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.show();
      existing.window.focus();
      return { reused: true };
    }
    const child = new BrowserWindow({
      width: 1500,
      height: 950,
      minWidth: 850,
      minHeight: 550,
      title: `${project.name} · Git 对比`,
      icon: windowIcon,
      show: false,
      backgroundColor: "#ffffff",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(here, "../preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    diffWindows.set(key, { window: child, request });
    child.removeMenu();
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    child.webContents.on("will-navigate", (event, url) => {
      if (url !== diffAllowed) event.preventDefault();
    });
    child.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "F11") {
        event.preventDefault();
        child.setFullScreen(!child.isFullScreen());
      }
    });
    child.once("ready-to-show", () => {
      child.maximize();
      child.show();
      child.focus();
    });
    let closing = false;
    child.on("close", (event) => {
      if (exiting || closing) return;
      event.preventDefault();
      void child.webContents
        .executeJavaScript(
          "window.__workbenchCanClose ? window.__workbenchCanClose() : true",
        )
        .then((allowed) => {
          if (allowed && !child.isDestroyed()) {
            closing = true;
            child.close();
          }
        })
        .catch(() => {});
    });
    child.once("closed", () => {
      const item = diffWindows.get(key);
      item?.watchers?.forEach((w) => w.close());
      clearTimeout(item?.watchTimer);
      gitClient.release(project.path);
      diffWindows.delete(key);
    });
    await child.loadFile(diffEntry);
    return { opened: true };
  }
  async function openEditor(projectId: string) {
    const project = knownProject(projectId);
    if (!fs.existsSync(project.path) || !fs.statSync(project.path).isDirectory())
      throw new Error("项目目录不存在");
    const key = path.resolve(project.path).toLowerCase();
    const existing = editorWindows.get(key);
    if (existing && !existing.window.isDestroyed()) {
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.show();
      existing.window.focus();
      return { reused: true };
    }
    const child = new BrowserWindow({
      width: 1540,
      height: 940,
      minWidth: 820,
      minHeight: 530,
      title: `${project.name} · 代码编辑器`,
      icon: windowIcon,
      show: false,
      backgroundColor: "#f7f8fa",
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(here, "../preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    const item: (typeof editorWindows extends Map<string, infer T> ? T : never) = {
      window: child, projectId, watchers: new Map(),
    };
    editorWindows.set(key, item);
    if (["tomcat", "spring"].includes(project.type)) {
      item.language = new JavaLanguageService(project, editorRuntime, dataDir,
        (method, params) => {
          if (!child.isDestroyed()) child.webContents.send("workbench:editor-lsp", method, params);
        }, config.get().tools.maven);
      void item.language.start().catch(() => {});
      const fileEvents = new Map<string, number>();
      try {
        item.projectWatcher = fs.watch(project.path, { recursive: true }, (_event, filename) => {
          if (!filename) return;
          const relative = filename.toString().replaceAll("\\", "/");
          if (/(?:^|\/)(?:\.git|\.idea|\.settings|node_modules|target|build|dist)(?:\/|$)/.test(relative) ||
              !/\.(?:java|xml|gradle|kts|properties)$/.test(relative)) return;
          const target = path.resolve(project.path, relative);
          if (!inside(project.path, target)) return;
          fileEvents.set(pathToFileURL(target).href, fs.existsSync(target) ? 2 : 3);
          editorFiles.invalidate(project.path);
          clearTimeout(item.projectWatchTimer);
          item.projectWatchTimer = setTimeout(() => {
            item.language?.watched([...fileEvents].map(([uri, type]) => ({ uri, type })));
            fileEvents.clear();
          }, 250);
        });
        item.projectWatcher.on("error", () => {});
      } catch { /* Open-file watchers and save fingerprint checks remain available. */ }
    }
    child.removeMenu();
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    child.webContents.on("will-navigate", (event, url) => {
      if (url !== editorAllowed) event.preventDefault();
    });
    child.webContents.on("before-input-event", (event, input) => {
      if (input.type === "keyDown" && input.key === "F11") {
        event.preventDefault();
        child.setFullScreen(!child.isFullScreen());
      }
    });
    child.once("ready-to-show", () => {
      child.maximize();
      child.show();
      child.focus();
    });
    let closing = false;
    child.on("close", (event) => {
      if (exiting || closing) return;
      event.preventDefault();
      void child.webContents.executeJavaScript(
        "window.__workbenchCanClose ? window.__workbenchCanClose() : true",
      ).then((allowed) => {
        if (allowed && !child.isDestroyed()) { closing = true; child.close(); }
      }).catch(() => {});
    });
    child.once("closed", () => {
      for (const watcher of item.watchers.values()) watcher.close();
      item.projectWatcher?.close();
      clearTimeout(item.projectWatchTimer);
      editorFiles.cancelSearch(project.path);
      void item.language?.stop();
      editorWindows.delete(key);
    });
    await child.loadFile(editorEntry);
    return { opened: true };
  }
  const activateTask = (taskId: string) => {
    const task = store.get<import("../shared/types.js").Task>("task", taskId);
    if (!task || !["run", "wechat"].includes(task.type)) return;
    if (
      lastActivation?.taskId === taskId &&
      Date.now() - lastActivation.at < 1000
    )
      return;
    lastActivation = { taskId, at: Date.now() };
    task.result.notification = {
      ...((task.result.notification as object) || {}),
      activatedAt: now(),
    };
    tasks.save(task);
    pendingNotificationTask = taskId;
    focusNotificationOnReady = true;
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
      win.webContents.send("workbench:navigate", { taskId });
    }
  };
  tasks.finished = (task) => {
    const options = projectNotification(task);
    if (!options) return;
    const record = (state: string, error?: string) => {
      if (exiting) return;
      const current = tasks.get(task.id);
      current.result.notification = {
        state,
        at: now(),
        ...(error ? { error: redact(error) } : {}),
      };
      tasks.save(current);
    };
    if (!Notification.isSupported()) {
      record("unsupported");
      return;
    }
    const notification = new Notification({
      ...options,
      icon: notificationIcon,
      id: task.id,
      groupId: "project-startup",
    });
    notifications.set(task.id, notification);
    notification.once("show", () => record("shown"));
    notification.once("click", () => {
      activateTask(task.id);
      notifications.delete(task.id);
    });
    notification.on("close", (details) => {
      if (details.reason === "userCanceled") notifications.delete(task.id);
    });
    notification.once("failed", (_event, error) => {
      record("failed", error);
      notifications.delete(task.id);
    });
    notification.show();
    // Keep the click handler while the toast remains in Action Center.
    // Central activation also handles a later application restart.
  };
  const bundledTemplate = path.resolve(
    here,
    "../../assets/monthly-template.docx",
  );
  const knownProject = (v: unknown) =>
    config.project(requireText(v, "项目 ID", 100));
  const safeRun = (r: any) => {
    const { configuration, ...rest } = r;
    return {
      ...rest,
      description: configuration?.description,
      port: configuration?.port,
      deployment: configuration?.deployment,
    };
  };
  const ask = async (title: string, message: string, confirm = "确认") =>
    (
      await dialog.showMessageBox(win, {
        type: "question",
        title,
        message,
        buttons: ["取消", confirm],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
      })
    ).response === 1;
  const saveFile = async (defaultPath: string, extensions: string[]) => {
    const picked = await dialog.showSaveDialog(win, {
      defaultPath,
      filters: [{ name: extensions[0].toUpperCase(), extensions }],
      properties: ["createDirectory", "showOverwriteConfirmation"],
    });
    return picked.canceled ? null : picked.filePath || null;
  };
  const openPath = async (file: string) => {
    if (!fs.existsSync(file)) throw new Error("路径不存在：" + file);
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
    return { opened: true, path: file };
  };
  async function action(name: string, p: any = {}, source?: BrowserWindow) {
    switch (name) {
      case "editor.context": {
        const item = [...editorWindows.values()].find((value) => value.window === source);
        if (!item) throw new Error("代码编辑器窗口不存在");
        const project = knownProject(item.projectId);
        return { projectId: project.id, projectName: project.name, root: project.path,
          java: !!item.language, status: item.language?.status || "unavailable",
          error: item.language?.error || "" };
      }
      case "editor.tree":
      case "editor.read":
      case "editor.version":
      case "editor.save":
      case "editor.file-search":
      case "editor.code-files":
      case "editor.text-search":
      case "editor.previews":
      case "editor.watch":
      case "editor.unwatch":
      case "editor.lsp-open":
      case "editor.lsp-change":
      case "editor.lsp-save":
      case "editor.lsp-close":
      case "editor.lsp-resolve":
      case "editor.lsp-request":
      case "editor.lsp-classfile":
      case "editor.confirm-save":
      case "editor.confirm-conflict": {
        const item = [...editorWindows.values()].find((value) => value.window === source);
        if (!item) throw new Error("代码编辑器窗口不存在");
        const project = knownProject(item.projectId);
        const root = project.path;
        if (name === "editor.tree") return editorFiles.tree(root, String(p.directory || ""));
        if (name === "editor.file-search") return editorFiles.findFiles(root, String(p.query || ""));
        if (name === "editor.code-files") return (await editorFiles.files(root))
          .filter((file) => /\.(?:ts|tsx|js|jsx)$/i.test(file)).slice(0, 3000);
        if (name === "editor.text-search") return editorFiles.search(root, String(p.query || ""));
        if (name === "editor.previews") return editorFiles.previews(root, Array.isArray(p.locations) ? p.locations : []);
        if (name === "editor.confirm-save") {
          const result = await dialog.showMessageBox(source!, {
            type: "question", title: "保存修改", message: "文件有未保存的修改",
            detail: String(p.file || ""), buttons: ["保存", "放弃", "取消"],
            defaultId: 0, cancelId: 2, noLink: true,
          });
          return ["save", "discard", "cancel"][result.response] || "cancel";
        }
        if (name === "editor.confirm-conflict") {
          const result = await dialog.showMessageBox(source!, {
            type: "warning", title: "文件已变化", message: "文件已被其他程序修改",
            detail: `${String(p.file || "")}\n选择重新加载会放弃本编辑器中该文件的修改。`,
            buttons: ["取消", "重新加载", "覆盖外部修改"],
            defaultId: 0, cancelId: 0, noLink: true,
          });
          return ["cancel", "reload", "overwrite"][result.response] || "cancel";
        }
        if (name === "editor.lsp-classfile") {
          if (!item.language || typeof p.uri !== "string" || !p.uri.startsWith("jdt://") || p.uri.length > 4000)
            throw new Error("虚拟源文件请求无效");
          return item.language.request("java/classFileContents", { uri: p.uri });
        }
        const file = projectFile(root, String(p.file || ""));
        if (name === "editor.read") return editorFiles.read(root, String(p.file));
        if (name === "editor.version") return editorFiles.version(root, String(p.file));
        if (name === "editor.save") {
          if (typeof p.text !== "string" || p.text.length > 8 * 1024 * 1024 ||
            !/^[a-f\d]{64}$/i.test(String(p.version || ""))) throw new Error("保存参数无效");
          const result = await editorFiles.save(root, p);
          if (!result.conflict) item.language?.save(file, p.text);
          return result;
        }
        if (name === "editor.watch") {
          if (item.watchers.has(file)) return true;
          const watcher = fs.watch(path.dirname(file), (_event, filename) => {
            if (filename && filename.toString().toLowerCase() !== path.basename(file).toLowerCase()) return;
            if (!source?.isDestroyed()) source?.webContents.send("workbench:editor-disk", p.file);
          });
          watcher.on("error", () => {});
          item.watchers.set(file, watcher);
          return true;
        }
        if (name === "editor.unwatch") {
          item.watchers.get(file)?.close();
          item.watchers.delete(file);
          return true;
        }
        if (!item.language || !file.toLowerCase().endsWith(".java"))
          throw new Error("此文件没有 Java 语义服务");
        if (name === "editor.lsp-open") { item.language.open(file, String(p.text || "")); return true; }
        if (name === "editor.lsp-change") { item.language.change(file, String(p.text || "")); return true; }
        if (name === "editor.lsp-save") { item.language.save(file, String(p.text || "")); return true; }
        if (name === "editor.lsp-close") { item.language.close(file); return true; }
        if (name === "editor.lsp-resolve") return item.language.request("completionItem/resolve", p.item);
        if (name === "editor.lsp-request") {
          const position = { line: Number(p.line) - 1, character: Number(p.column) - 1 };
          if (!Number.isInteger(position.line) || position.line < 0 ||
            !Number.isInteger(position.character) || position.character < 0)
            throw new Error("代码位置无效");
          const positionParams = { textDocument: { uri: pathToFileURL(file).href }, position };
          const methods: Record<string, string> = {
            definition: "textDocument/definition",
            implementation: "textDocument/implementation",
            references: "textDocument/references",
            completion: "textDocument/completion",
            hover: "textDocument/hover",
            signature: "textDocument/signatureHelp",
            hierarchy: "textDocument/prepareTypeHierarchy",
            super: "java/findLinks",
            supertypes: "typeHierarchy/supertypes",
          };
          const method = methods[String(p.kind || "")];
          if (!method) throw new Error("不支持的语义请求");
          const params = p.kind === "references"
            ? { ...positionParams, context: { includeDeclaration: false } }
            : p.kind === "super"
              ? { type: "superImplementation", position: positionParams }
              : p.kind === "supertypes"
                ? { item: p.item }
              : positionParams;
          return item.language.request(method, params);
        }
        throw new Error("不支持的代码编辑操作");
      }
      case "git.window-context": {
        const item = [...diffWindows.values()].find((v) => v.window === source);
        if (!item) throw new Error("对比窗口不存在");
        const project = knownProject(item.request.projectId);
        return { request: item.request, projectName: project.name };
      }
      case "git.confirm-save": {
        const result = await dialog.showMessageBox(source || win, {
          type: "question",
          message: "代码已修改，是否保存？",
          detail: String(p.file || ""),
          buttons: ["保存", "不保存", "继续编辑"],
          defaultId: 0,
          cancelId: 2,
          noLink: true,
        });
        return ["save", "discard", "cancel"][result.response] || "cancel";
      }
      case "git.confirm-leave":
        return (
          (
            await dialog.showMessageBox(source || win, {
              type: "question",
              message: "编辑结果尚未保存，丢弃编辑并继续？",
              buttons: ["保留编辑", "丢弃编辑"],
              defaultId: 0,
              cancelId: 0,
            })
          ).response === 1
        );
      case "git.fullscreen":
        if (source && source !== win) {
          source.setFullScreen(!source.isFullScreen());
          return true;
        }
        return false;
      case "git.validate-token":
        return gitClient.validateToken(
          knownProject(p.projectId).path,
          p.token,
          !!p.conflict,
        );
      case "git.diff-open":
        return openDiff(p);
      case "git.status":
        return gitClient.status(knownProject(p.projectId).path);
      case "git.files":
        return gitClient.files(knownProject(p.projectId).path, p.comparison);
      case "git.content": {
        const repo = knownProject(p.projectId).path;
        const result = await gitClient.content(repo, p.comparison, p.file);
        await watchDiff(source, repo, p.file);
        return result;
      }
      case "git.branches":
        return gitClient.branches(knownProject(p.projectId).path);
      case "git.log":
        return gitClient.log(knownProject(p.projectId).path, p);
      case "git.commit-details":
        return gitClient.commitDetails(knownProject(p.projectId).path, p.ref);
      case "git.stashes":
        return gitClient.stashes(knownProject(p.projectId).path);
      case "git.conflict": {
        const repo = knownProject(p.projectId).path;
        const result = await gitClient.conflict(repo, p.file);
        await watchDiff(source, repo, p.file);
        return result;
      }
      case "git.copy":
        clipboard.writeText(requireText(p.text, "复制内容", 20000));
        return true;
      case "git.reveal": {
        const project = knownProject(p.projectId),
          target = path.resolve(
            project.path,
            requireText(p.file, "文件路径", 2000),
          );
        if (
          !inside(project.path, target) ||
          target === path.resolve(project.path)
        )
          throw new Error("路径越界");
        shell.showItemInFolder(target);
        return true;
      }
      case "git.push-preview":
        return gitClient.pushPreview(
          knownProject(p.projectId).path,
          p.remote,
          p.branch,
        );
      case "git.patch": {
        const project = knownProject(p.projectId);
        if (
          p.operation === "rollback" &&
          !(
            await dialog.showMessageBox(source || win, {
              type: "warning",
              message: "回滚当前差异块？",
              detail: `${await gitClient.tokenFile(project.path, p.token)} · 差异块 ${Number(p.hunk) + 1}\n仅撤销此块的未暂存修改，无法通过 Git 撤销。暂存区保留。`,
              buttons: ["取消", "回滚此块"],
              defaultId: 0,
              cancelId: 0,
            })
          ).response
        )
          return { cancelled: true };
        return gitClient.patch(project.path, p.token, p.hunk, p.operation);
      }
      case "git.revert-hunk": {
        const repo = knownProject(p.projectId).path;
        return gitClient.revertHunk(repo, p.token, p.hunk);
      }
      case "git.save":
        return gitClient.save(knownProject(p.projectId).path, p.token, p.text);
      case "git.resolve": {
        const file = await gitClient.tokenFile(
          knownProject(p.projectId).path,
          p.token,
          true,
        );
        if (
          !(
            await dialog.showMessageBox(source || win, {
              type: "question",
              message: "保存结果并标记冲突已解决？",
              detail: p.delete
                ? `${file}\n接受此冲突的删除结果，将移除工作区文件并暂存删除。不会自动继续当前操作。`
                : `${file}\n合并结果将写入工作区并暂存；不会自动继续当前操作。`,
              buttons: ["取消", "保存并暂存"],
              defaultId: 0,
              cancelId: 0,
            })
          ).response
        )
          return { cancelled: true };
        return gitClient.resolve(
          knownProject(p.projectId).path,
          p.token,
          p.text,
          !!p.delete,
        );
      }
      case "git.execute": {
        const project = knownProject(p.projectId),
          operation = requireText(p.operation, "Git 操作", 50);
        const expected =
          operation === "rollback"
            ? await gitClient.rollbackPreview(project.path, p.files)
            : undefined;
        let detail = "";
        if (operation === "rollback")
          detail = `回滚以下文件的未暂存修改，恢复至暂存区内容。已暂存修改保留。此操作会丢弃所列文件的未暂存代码。\n${(p.files || []).slice(0, 80).join("\n")}`;
        if (operation === "delete-branch")
          detail = `删除本地分支 ${p.branch}。仅允许删除 Git 判定已合并的分支。`;
        if (operation === "stash-drop")
          detail = `永久删除 ${p.ref} (${String(p.hash).slice(0, 8)})。`;
        if (operation === "rebase")
          detail = `将当前分支变基到 ${p.ref}。这会重写提交；如历史已推送，请先与协作者确认。不会自动强制推送。`;
        if (operation === "merge")
          detail = `将 ${p.ref} 合并到当前分支，策略为 ${p.noFF ? "创建合并提交" : "允许快进合并"}。`;
        if (operation === "revert")
          detail = `对提交 ${p.ref} 创建反向提交。`;
        if (operation === "cherry-pick")
          detail = `将提交 ${p.ref} 应用到当前分支。`;
        if (operation === "undo-last")
          detail = "撤销最后一个未推送提交，并将代码完整保留在暂存区。";
        if (operation === "abort")
          detail =
            "中止当前 Git 操作，Git 将尝试恢复操作前状态。操作期间的新修改可能影响恢复，请先核对。";
        if (operation === "skip")
          detail = "跳过当前提交，放弃该提交在本轮操作中的应用。";
        if (operation === "commit" && p.amend)
          detail =
            "修改最后一次提交（--amend）将替换最后一个提交，重写其提交号。请确认该历史尚未与他人共享。";
        if (operation === "commit" && p.push) {
          const target = await gitClient.upstreamTarget(project.path);
          const preview = await gitClient.pushPreview(
            project.path,
            target.remote,
            target.branch,
          );
          detail += `\nCommit 并 Push → ${target.remote}/${target.branch}\n新增提交说明：${p.message}\n已有待推送提交：\n${preview.commits || "无"}`;
        }
        if (operation === "pull") {
          const state = await gitClient.status(project.path);
          detail = `当前分支 ${state.branch}\n上游 ${state.upstream || "未配置"}\n策略 ${p.strategy === "rebase" ? "Rebase" : "Merge"}`;
        }
        if (operation === "push") {
          const preview = await gitClient.pushPreview(
            project.path,
            p.remote,
            p.branch,
          );
          if (preview.head !== p.head)
            throw new Error("待推送提交已变化，请重新预览");
          detail = `${preview.branch} → ${preview.remote}/${preview.target}\n${preview.newBranch ? "创建远程分支\n" : ""}待推送提交（最多显示 100 条）\n${preview.commits || "无新增提交"}`;
        }
        if (
          detail &&
          !(
            await dialog.showMessageBox(source || win, {
              type: "warning",
              message: `确认 Git · ${gitOperationLabel(operation)}`,
              detail,
              buttons: ["取消", "确认执行"],
              defaultId: 0,
              cancelId: 0,
              noLink: true,
            })
          ).response
        )
          return { cancelled: true };
        return gitClient.execute(project.path, operation, { ...p, expected });
      }
      case "bootstrap":
        return {
          config: config.get(),
          notes: store.list("note"),
          tasks: tasks.list(),
          dataDir,
          today: localDate(),
          version: app.getVersion(),
          imports: store.list("import"),
          runs: store.list("run"),
          formDrafts: store.get("meta", "form-drafts") || {},
        };
      case "notification.take": {
        const taskId = pendingNotificationTask;
        pendingNotificationTask = null;
        return taskId ? { taskId } : null;
      }
      case "form.save": {
        if (
          ![
            "home",
            "note-add-idea",
            "note-add-work",
            ...Object.keys(submitProjectIds).map((tab) => "submit-" + tab),
            ...Object.values(submitProjectIds).flat().map((id) => "submit-message-" + id),
          ].includes(p.key) ||
          !p.value ||
          typeof p.value !== "object" ||
          JSON.stringify(p.value).length > 2 * 1024 * 1024
        )
          throw new Error("表单草稿无效或过大");
        const drafts =
          store.get<Record<string, unknown>>("meta", "form-drafts") || {};
        drafts[p.key] = p.value;
        store.set("meta", "form-drafts", drafts);
        return { saved: true };
      }
      case "record.save": {
        if (p.projectId) knownProject(p.projectId);
        const n = records.save(p);
        changed();
        return n;
      }
      case "record.complete": {
        const n = records.complete(p.id, !!p.done);
        changed();
        return n;
      }
      case "record.delete": {
        const note = records.get(p.id);
        if (
          !(await ask(
            "删除记录",
            `将此记录移入已删除列表，可在工作台恢复。\n\n${note.text.slice(0, 300)}`,
            "删除这条记录",
          ))
        )
          return null;
        const n = records.remove(p.id);
        changed();
        return n;
      }
      case "record.restore": {
        const n = records.restore(p.id);
        changed();
        return n;
      }
      case "monthly.get": {
        const draft = records.draft(p.month, config.get().name);
        return {
          draft,
          materials: records.month(p.month, p.projectId),
          sources: records.sources(draft),
          undated: records.list("work").filter((n) => !n.happenedOn).length,
        };
      }
      case "monthly.save": {
        const draft = records.saveDraft(p);
        changed();
        return draft;
      }
      case "monthly.add": {
        const draft = records.addSources(p.month, p.name, p.section, p.ids);
        changed();
        return draft;
      }
      case "monthly.export": {
        if ((p.format && p.format !== "docx") || p.range === "raw")
          throw new Error("月报仅支持 Word 导出");
        const draft = records.draft(p.month, config.get().name);
        const title =
          `${Number(draft.month.slice(0, 4))}年${Number(draft.month.slice(5))}月工作总结-${draft.name}`.replace(
            /[<>:"/\\|?*]/g,
            "_",
          );
        const destination = await saveFile(
          path.join(config.get().tools.exportDir, title + ".docx"),
          ["docx"],
        );
        if (!destination) return null;
        return exportWord(
          config.get().tools.template || bundledTemplate,
          draft,
          destination,
        );
      }
      case "git.check": {
        const project = knownProject(p.projectId);
        if (!p.kind || submitTabForProject(project.id) !== p.kind)
          throw new Error("提交类型与项目不符");
        return submit.check(project.path, submitPolicyForProject(project.id), p.fromGit === true);
      }
      case "git.erp": {
        const project = knownProject(p.projectId);
        if (submitPolicyForProject(project.id).kind !== "erp")
          throw new Error("不是受支持的后端工作目录");
        return submit.startErp(
          project.id,
          project.path,
          p.message,
          p.fingerprint,
          p.fromGit === true,
        );
      }
      case "git.app.prepare": {
        const project = knownProject(p.projectId);
        if (submitPolicyForProject(project.id).kind !== "app")
          throw new Error("不是受支持的固定分支项目");
        return submit.prepareApp(project.id, project.path, p.fingerprint, p.fromGit === true, String(p.message || ""));
      }
      case "git.submit.save": {
        const project = knownProject(p.projectId);
        const policy = submitPolicyForProject(project.id);
        if (policy.kind === "app" && policy.protectedFile && p.file?.toLowerCase() === policy.protectedFile.toLowerCase())
          throw new Error("本地测试配置受保护，不能在提交预览中修改");
        if (p.taskId) return submit.editAppPreview(p.taskId, project.id, p.file,
          (afterSave) => gitClient.save(project.path, p.token, p.text, { taskId: p.taskId, file: p.file, afterSave }));
        const saved = await gitClient.save(project.path, p.token, p.text, { file: p.file });
        return { ...saved, check: await submit.check(project.path, policy, p.fromGit === true) };
      }
      case "git.app.finish":
        return submit.finishApp(p.taskId, p.message);
      case "git.recoveries":
        return submit.recoveries(knownProject(p.projectId).path);
      case "git.recover-config": {
        const project = knownProject(p.projectId);
        const policy = submitPolicyForProject(project.id);
        if (policy.kind !== "app" || !policy.protectedFile)
          throw new Error("此项目没有受保护的本地配置");
        if (
          !(await ask(
            "恢复本地配置保护",
            `工作目录：${project.path}\n恢复批次：${p.id}\n仅从对应备份恢复 ${policy.protectedFile} 和原 Git 标志。不会重复应用 stash、提交或推送。`,
            "恢复配置",
          ))
        )
          return null;
        return submit.recoverConfig(project.path, p.id);
      }
      case "git.recovery-ack": {
        const project = knownProject(p.projectId);
        if (
          !(await ask(
            "确认已在外部处理恢复事项",
            `工作目录：${project.path}\n批次：${p.id}\n请先在原工具核对本地改动完整性、合并状态和保留的 stash。此操作仅记录人工确认，不应用或删除 stash。`,
            "我已核对并处理",
          ))
        )
          return null;
        return submit.acknowledgeRecovery(project.path, p.id);
      }
      case "git.diff": {
        const project = knownProject(p.projectId);
        const valid = (await git.status(project.path)).find(
          (f) => f.path === p.file,
        );
        if (!valid) throw new Error("文件不在当前变更中");
        return { text: await git.diff(project.path, p.scope, valid.path) };
      }
      case "apk.inspect":
        return apk.inspect(knownProject(p.projectId).id);
      case "apk.start":
        return apk.start(knownProject(p.projectId).id, p.variant);
      case "apk.copy": {
        const file = apk.artifact(p.taskId);
        clipboard.writeText(file);
        return { copied: true, path: file };
      }
      case "apk.folder": {
        const file = apk.artifact(p.taskId);
        shell.showItemInFolder(file);
        return { opened: true };
      }
      case "task.log":
        return tasks.log(p.id);
      case "task.open-log":
        return openPath(tasks.get(p.id).logPath);
      case "task.conflict-open": {
        const task = tasks.get(p.id);
        if (!task.projectId) throw new Error("任务没有关联工作目录");
        const conflict = (
          Array.isArray(task.result.conflicts) ? task.result.conflicts : []
        ).find((c: any) => c.repo === p.repo && c.file === p.file) as
          | { repo: string; file: string }
          | undefined;
        if (!conflict) throw new Error("文件不在任务冲突清单内");
        if (
          (await git.commonDir(conflict.repo)) !==
          (await git.commonDir(knownProject(task.projectId).path))
        )
          throw new Error("项目路径已变化，请核对历史工作目录");
        const file = path.resolve(conflict.repo, conflict.file);
        if (!inside(conflict.repo, file) || !fs.existsSync(file))
          throw new Error("冲突文件路径无效");
        const exe = config.get().tools.idea;
        if (!exe || !fs.existsSync(exe))
          throw new Error("请配置实际编辑器路径");
        await new Promise<void>((resolve, reject) => {
          const child = spawn(exe, [file], {
            cwd: conflict.repo,
            windowsHide: false,
            detached: true,
            stdio: "ignore",
          });
          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
        });
        return { opened: true };
      }
      case "task.cancel": {
        const task = tasks.get(p.id);
        if (task.type === "run" && task.projectId) {
          const run = await projects.inspect(task.projectId, true);
          if (run.canStop) await projects.stop(task.projectId);
        }
        return ["running", "cancelling", "awaiting"].includes(
          tasks.get(p.id).state,
        )
          ? tasks.cancel(p.id)
          : tasks.get(p.id);
      }
      case "projects.list":
        return (await projects.list()).map(safeRun);
      case "projects.inspect":
        return safeRun(
          await projects.inspect(knownProject(p.projectId).id, true),
        );
      case "projects.start": {
        const r = await projects.start(knownProject(p.projectId).id);
        return { ...r, run: safeRun(r.run) };
      }
      case "projects.stop":
        return projects.stop(knownProject(p.projectId).id);
      case "projects.restart":
        return projects.restart(knownProject(p.projectId).id);
      case "projects.wechat":
        return projects.openWechat(knownProject(p.projectId).id);
      case "projects.url": {
        const project = knownProject(p.projectId);
        const url = await projects.url(project.id);
        await projectBrowser.open(project, url);
        return { url };
      }
      case "projects.folder":
        return openPath(knownProject(p.projectId).path);
      case "projects.editor":
        return openEditor(knownProject(p.projectId).id);
      case "projects.ide": {
        const project = knownProject(p.projectId),
          exe = config.get().tools.idea;
        if (!exe || !fs.existsSync(exe))
          throw new Error("请配置实际 IDEA 路径");
        await new Promise<void>((resolve, reject) => {
          const child = spawn(exe, [project.path], {
            cwd: path.dirname(exe),
            windowsHide: false,
            detached: true,
            stdio: "ignore",
          });
          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
        });
        return { opened: true };
      }
      case "projects.log": {
        const run = store.get<RunInfo>("run", knownProject(p.projectId).id);
        const active =
          !!run &&
          ["starting", "running", "watching", "stopping", "tool-open"].includes(
            run.state,
          );
        if (!run?.logPath || !fs.existsSync(run.logPath)) {
          if (active)
            return {
              text: "",
              offset: 0,
              path: run?.logPath || "",
              reset: false,
              active: true,
            };
          throw new Error("没有工作台日志，请在原工具查看外部实例");
        }
        const tail = readLogTail(run.logPath, Number(p.offset) || 0);
        return { ...tail, text: redact(tail.text), path: run.logPath, active };
      }
      case "review.open": {
        const project = knownProject(p.projectId);
        return review.open(
          project.id,
          {
            repo: project.path,
            scope: p.scope,
            base: p.base,
            target: p.target,
            context: p.context,
          },
          p.previousId,
        );
      }
      case "review.cancel":
        review.cancel();
        return { cancelling: true };
      case "review.validate": {
        const result = await review.validate(p.id);
        return { changed: result.changed };
      }
      case "review.seen":
        return review.seen(p.id, p.file, !!p.viewed);
      case "review.issue":
        return review.issue(p.id, p.issue);
      case "review.issue-state":
        return review.updateIssue(p.id, p.issueId, p.state, p.reason || "");
      case "review.todo": {
        const result = review.todo(p.id, p.issueId);
        changed();
        return result;
      }
      case "review.conclude":
        return review.conclude(p.id, p.conclusion, p.summary || "");
      case "review.copy":
        clipboard.writeText(review.copy(p.id));
        return { copied: true };
      case "review.history":
        return review.history(p.projectId || null, p.offset || 0);
      case "review.get":
        return review.get(p.id);
      case "review.file-content":
        return review.fileContent(p.id, p.file);
      case "review.fetch":
        return review.fetch(knownProject(p.projectId).path);
      case "review.rules": {
        const project = knownProject(p.projectId);
        return review.rules(
          project.path,
          project.group === "HomeProject" && project.type === "h5"
            ? "D:/git-project/employeeapp-uniapp-bak/.cursor/rules/employeeapp.mdc"
            : undefined,
        );
      }
      case "review.file": {
        const s = review.get(p.id),
          file = s.files.find((f) => f.path === p.file);
        if (!file) throw new Error("文件不在审查快照中");
        const target = path.resolve(s.repo, file.path);
        if (!inside(s.repo, target)) throw new Error("文件路径越界");
        if (!fs.existsSync(target))
          throw new Error("当前工作区已不存在此文件，可在历史差异中阅读");
        const exe = config.get().tools.idea;
        if (!exe || !fs.existsSync(exe))
          throw new Error("请先配置编辑器 / IDEA 路径");
        await new Promise<void>((resolve, reject) => {
          const child = spawn(exe, [target], {
            cwd: s.repo,
            detached: true,
            stdio: "ignore",
            windowsHide: false,
          });
          child.once("error", reject);
          child.once("spawn", () => {
            child.unref();
            resolve();
          });
        });
        return { opened: true };
      }
      case "tapd.open": {
        const tools = config.get().tools;
        if (!fs.existsSync(tools.tapd))
          throw new Error("TAPD 客户端路径不存在，请在设置 → 工具中配置后重试");
        const task = tasks.create(
          "tapd",
          "打开 TAPD 导入客户端",
          null,
          null,
          { path: tools.tapd, cwd: tools.tapdCwd },
          ["打开现有客户端"],
        );
        tasks.launch(task, async (ctx) => {
          await ctx.step("打开现有客户端", async () => {
            // 已在运行时只把原窗口还原并提到最前，避免再开一个实例。
            const running = await clientProcesses(tools.tapd);
            if (running.length) {
              const target = running.find((w) => w.handle) || running[0];
              const state = await activateClientWindow(
                target.pid,
                target.handle,
              );
              ctx.log(
                `客户端已在运行：pid=${target.pid} hwnd=${target.handle} 激活结果=${state}`,
              );
              ctx.result({
                clientOpened: true,
                pid: target.pid,
                reused: true,
                focused: state === "ok",
                raised: state === "raised",
                message:
                  state === "ok"
                    ? "客户端已在运行，已切换到前台"
                    : state === "raised"
                      ? "客户端已在运行，已提到最前；若仍未显示请从任务栏点开"
                      : state === "missing"
                        ? "客户端已在运行但未找到窗口，请从任务栏或托盘点开"
                        : "客户端已在运行，系统未允许自动前置，请从任务栏点开",
              });
              return;
            }
            await new Promise<void>((resolve, reject) => {
              const child = spawn(tools.tapd, [], {
                cwd: tools.tapdCwd,
                windowsHide: false,
                detached: true,
                stdio: "ignore",
              });
              child.once("error", reject);
              child.once("spawn", () => {
                child.unref();
                resolve();
              });
            });
            let windows: { pid: number; handle: number; title: string }[] = [];
            const started = Date.now();
            while (!windows.length && Date.now() - started < 20000) {
              ctx.checkStop();
              await new Promise((resolve) => setTimeout(resolve, 600));
              windows = await visibleClientWindows(tools.tapd);
            }
            if (!windows.length)
              throw new Error(
                "已发送启动请求，但未检测到 TAPD 主窗口，请核对客户端依赖或错误提示；未记录为打开成功",
              );
            ctx.result({
              clientOpened: true,
              pid: windows[0].pid,
              reused: false,
              message: "客户端已打开，导入结果请在原客户端核对",
            });
          });
        });
        // 复用分支很快，等一小会儿把真实结果带回界面提示。
        return (
          (await Promise.race([
            tasks.wait(task.id),
            new Promise<null>((resolve) =>
              setTimeout(() => resolve(null), 5000),
            ),
          ])) || task
        );
      }
      case "settings.check":
        return config.check(p);
      case "settings.save": {
        if (tasks.active().length)
          throw new Error("有运行或待确认任务，完成后再修改工具与项目配置");
        const result = config.save(p as Configuration);
        git.executable = result.tools.git;
        changed();
        return result;
      }
      case "settings.pick-path": {
        const target = p.target === "directory" ? "openDirectory" : "openFile";
        const result = await dialog.showOpenDialog(win, {
          properties: [target],
          defaultPath: typeof p.current === "string" ? p.current : undefined,
        });
        return result.canceled ? null : result.filePaths[0];
      }
      case "settings.data-folder":
        return openPath(dataDir);
      case "settings.template":
        if (config.get().tools.template)
          return openPath(config.get().tools.template);
        else {
          const bytes = fs.readFileSync(bundledTemplate),
            fingerprint = hash(bytes).slice(0, 12);
          let preview = path.join(
            dataDir,
            "previews",
            `月报空白模板-${fingerprint}.docx`,
          );
          if (
            fs.existsSync(preview) &&
            hash(fs.readFileSync(preview)) !== hash(bytes)
          )
            preview = path.join(
              dataDir,
              "previews",
              `月报空白模板-${fingerprint}-${id()}.docx`,
            );
          if (!fs.existsSync(preview)) atomicWrite(preview, bytes);
          return openPath(preview);
        }
      case "backup.create": {
        const file = await saveFile(
          path.join(
            config.get().tools.backupDir,
            `workbench-backup-${localDate()}-${Date.now()}.zip`,
          ),
          ["zip"],
        );
        if (!file) return null;
        const result = await backup.create(file);
        store.set("meta", "backup:" + now(), {
          path: file,
          at: now(),
          bytes: result.bytes,
        });
        changed();
        return result;
      }
      case "backup.list":
        return store.list<any>("meta").filter((v) => v.path && v.at && v.bytes);
      case "backup.preview": {
        const picked = await dialog.showOpenDialog(win, {
          properties: ["openFile"],
          defaultPath: config.get().tools.backupDir,
          filters: [{ name: "工作台备份", extensions: ["zip"] }],
        });
        return picked.canceled ? null : backup.preview(picked.filePaths[0]);
      }
      case "backup.restore": {
        const preview = backup.previews.get(p.token);
        if (!preview) throw new Error("恢复预览已失效");
        if (
          !(await ask(
            "恢复工作台数据",
            `备份：${preview.file}\n日期：${preview.manifest.createdAt}\n将替换记录、配置、月报、审查及任务历史，先保存当前完整备份。源码、远端、APK 和原 TXT 不受影响。`,
            "备份当前数据并恢复",
          ))
        )
          return null;
        const result = await backup.restore(p.token);
        git.executable = config.get().tools.git;
        changed();
        return result;
      }
      case "ui.confirm":
        return ask(
          String(p.title || "确认").slice(0, 100),
          String(p.message || "").slice(0, 4000),
          String(p.confirm || "确认").slice(0, 50),
        );
      case "ui.choose": {
        const buttons = (Array.isArray(p.buttons) ? p.buttons : ["取消"])
          .map((item: unknown) => String(item).slice(0, 20))
          .filter(Boolean)
          .slice(0, 4);
        if (!buttons.length) buttons.push("取消");
        const result = await dialog.showMessageBox(win, {
          type: "question",
          title: String(p.title || "确认").slice(0, 100),
          message: String(p.message || "").slice(0, 4000),
          buttons,
          defaultId: Math.min(
            Math.max(0, Number(p.defaultId ?? buttons.length - 1) || 0),
            buttons.length - 1,
          ),
          cancelId: 0,
          noLink: true,
        });
        return result.response;
      }
      case "clipboard.text":
        clipboard.writeText(String(p.text || ""));
        return { copied: true };
      case "window.minimize":
        win.minimize();
        return true;
      case "window.maximize":
        win.isMaximized() ? win.unmaximize() : win.maximize();
        return true;
      case "window.close":
        win.close();
        return true;
      default:
        throw new Error("未开放的业务动作");
    }
  }
  app.whenReady().then(() => {
    if (process.platform === "win32") {
      const shortcutName = app.isPackaged
        ? "个人工作台.lnk"
        : path.basename(process.execPath, ".exe") + ".lnk";
      const shortcuts = [
        path.join(
          app.getPath("appData"),
          "Microsoft/Windows/Start Menu/Programs",
          shortcutName,
        ),
        ...(app.isPackaged
          ? [path.join(app.getPath("desktop"), shortcutName)]
          : []),
      ];
      for (const shortcut of shortcuts) {
        try {
          if (!fs.existsSync(shortcut)) continue;
          const details = shell.readShortcutLink(shortcut);
          if (
            path.resolve(details.target).toLowerCase() !==
            path.resolve(process.execPath).toLowerCase()
          )
            continue;
          shell.writeShortcutLink(shortcut, "update", {
            target: process.execPath,
            cwd: path.dirname(process.execPath),
            args: app.isPackaged ? details.args : `"${app.getAppPath()}"`,
            icon: app.isPackaged ? process.execPath : windowIcon,
            iconIndex: 0,
            appUserModelId: windowsAppId,
            toastActivatorClsid,
          });
        } catch (error) {
          console.error("Windows 快捷方式更新失败：" + errorText(error));
        }
      }
    }
    // Register the COM server even when this launch came from an older toast.
    // Merely setting handleActivation does not initialize Electron's presenter.
    if (process.platform === "win32") Notification.isSupported();
    if (process.platform === "win32")
      Notification.handleActivation((details) => {
        const taskId = activationTask(details.arguments);
        if (taskId) activateTask(taskId);
      });
    const saved = store.get<{ width: number; height: number }>(
      "meta",
      "window",
    );
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    win = new BrowserWindow({
      width: Math.min(saved?.width || 1440, workArea.width),
      height: Math.min(saved?.height || 900, workArea.height),
      minWidth: Math.min(960, workArea.width),
      minHeight: Math.min(680, workArea.height),
      frame: false,
      title: "个人工作台",
      backgroundColor: "#f5f7fa",
      icon: windowIcon,
      show: false,
      webPreferences: {
        preload: path.join(here, "../preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    if (process.platform === "win32")
      win.setAppDetails({
        appId: windowsAppId,
        appIconPath: app.isPackaged ? process.execPath : windowIcon,
        appIconIndex: 0,
        relaunchCommand: app.isPackaged
          ? `"${process.execPath}"`
          : `"${process.execPath}" "${app.getAppPath()}"`,
        relaunchDisplayName: app.getName(),
      });
    const entry = path.resolve(here, "../renderer/index.html");
    const allowed = pathToFileURL(entry).href;
    ipcMain.handle("workbench:action", async (event, name, payload) => {
      const diff = [...diffWindows.values()].find(
        (item) => item.window.webContents === event.sender,
      );
      const editorWindow = [...editorWindows.values()].find(
        (item) => item.window.webContents === event.sender,
      );
      const source = diff?.window || editorWindow?.window || win;
      const diffActions = new Set([
        "git.window-context",
        "git.confirm-leave",
        "git.fullscreen",
        "git.validate-token",
        "git.status",
        "git.files",
        "git.content",
        "git.conflict",
        "git.copy",
        "git.reveal",
        "git.patch",
        "git.revert-hunk",
        "git.save",
        "git.resolve",
        "git.execute",
      ]);
      const validDiff =
        !!diff &&
        diffActions.has(name) &&
        (name === "git.window-context" ||
          payload?.projectId === diff.request.projectId);
      const validEditor = !!editorWindow && typeof name === "string" && name.startsWith("editor.");
      if (
        (event.sender !== win.webContents && !validDiff && !validEditor) ||
        event.senderFrame !== source.webContents.mainFrame ||
        event.senderFrame.url !== (diff ? diffAllowed : editorWindow ? editorAllowed : allowed)
      )
        return { ok: false, error: "请求来源无效" };
      // Bootstrap only reads synchronously; it can keep the UI current during the backup wait.
      if (
        (restoringData && name !== "bootstrap") ||
        (name === "backup.restore" && pendingActions > 0)
      )
        return {
          ok: false,
          error: "数据恢复需要独占操作，请等待当前操作完成后重试",
        };
      const restoring = name === "backup.restore";
      if (restoring) restoringData = true;
      pendingActions++;
      try {
        return { ok: true, data: await action(name, payload, source) };
      } catch (e) {
        return { ok: false, error: redact(errorText(e)) };
      } finally {
        pendingActions--;
        if (restoring) restoringData = false;
      }
    });
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event, url) => {
      if (url !== allowed) event.preventDefault();
    });
    win.webContents.session.setPermissionRequestHandler(
      (_webContents, _permission, callback) => callback(false),
    );
    let runLogKeys = false;
    ipcMain.on("workbench:run-log-keys", (event, active) => {
      if (event.sender !== win.webContents) {
        event.returnValue = false;
        return;
      }
      runLogKeys = !!active;
      event.returnValue = true;
    });
    win.webContents.on("before-input-event", (event, input) => {
      if (input.type !== "keyDown" || !runLogKeys) return;
      if (!input.control || input.alt || input.shift || input.meta) return;
      const key = input.key.toLowerCase();
      const command =
        key === "f" ? "find" : key === "home" ? "top" : key === "end" ? "bottom" : "";
      if (!command) return;
      event.preventDefault();
      win.webContents.send("workbench:run-log-command", command);
    });
    win.webContents.on("did-start-loading", () => {
      runLogKeys = false;
    });
    win.once("ready-to-show", () => {
      win.show();
      if (focusNotificationOnReady) {
        if (win.isMinimized()) win.restore();
        win.focus();
        focusNotificationOnReady = false;
      }
    });
    void win.loadFile(entry);
    win.on("close", (event) => {
      if (exiting) {
        store.set("meta", "window", win.getBounds());
        return;
      }
      event.preventDefault();
      if (closeDialog) return;
      closeDialog = true;
      void (async () => {
        try {
          if (
            win.webContents.getURL() === allowed &&
            !(await win.webContents.executeJavaScript(
              "window.__workbenchCanClose ? window.__workbenchCanClose() : true",
            ))
          )
            return;
          for (const item of diffWindows.values())
            if (
              !(await item.window.webContents.executeJavaScript(
                "window.__workbenchCanClose ? window.__workbenchCanClose() : true",
              ))
            )
              return;
          for (const item of editorWindows.values())
            if (
              !item.window.isDestroyed() &&
              !(await item.window.webContents.executeJavaScript(
                "window.__workbenchCanClose ? window.__workbenchCanClose() : true",
              ))
            )
              return;
          const active = tasks.active(),
            owned = await projects.owned();
          if (!active.length && !owned.length) {
            await Promise.all([...editorWindows.values()].map((item) => item.language?.stop()));
            exiting = true;
            win.close();
            return;
          }
          const result = await dialog.showMessageBox(win, {
            type: "question",
            title: "退出个人工作台",
            message: `仍有 ${active.length} 个运行或待确认任务，${owned.length} 个工作台拥有的项目进程。`,
            detail: [
              ...active.map((t) => t.title + "：" + t.state),
              ...owned.map(
                (r) => config.project(r.projectId).name + "：" + r.state,
              ),
              "Git 写命令将完成当前命令后停止后续步骤。外部实例不由工作台停止。",
            ].join("\n"),
            buttons: [
              "取消退出",
              "安全结束任务并停止自有服务",
              "安全结束任务，保留项目服务并退出",
            ],
            defaultId: 0,
            cancelId: 0,
            noLink: true,
          });
          if (result.response === 0) return;
          for (const t of active) tasks.cancel(t.id);
          await Promise.all([...tasks.running.values()]);
          if (result.response === 1)
            for (const r of owned) await projects.stop(r.projectId);
          await Promise.all([...editorWindows.values()].map((item) => item.language?.stop()));
          exiting = true;
          win.close();
        } catch (e) {
          await dialog.showMessageBox(win, {
            type: "error",
            message: "尚未退出，请核对任务状态",
            detail: redact(errorText(e)),
          });
        } finally {
          closeDialog = false;
        }
      })();
    });
    app.on("second-instance", () => {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    });
    win.on("closed", () => {
      for (const item of diffWindows.values())
        if (!item.window.isDestroyed()) item.window.close();
      for (const item of editorWindows.values())
        if (!item.window.isDestroyed()) item.window.close();
    });
    app.on("before-quit", (event) => {
      if (exiting || !win || win.isDestroyed()) return;
      event.preventDefault();
      win.close();
    });
  });
  app.on("window-all-closed", () => {
    store.close();
    app.quit();
  });
}

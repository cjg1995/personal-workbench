import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  ipcMain,
  Menu,
  shell,
  screen,
  Notification,
  powerMonitor,
  Tray,
} from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { setImmediate as nextTurn } from "node:timers/promises";
import { Store } from "../core/store.js";
import { ConfigService } from "../core/config.js";
import { RecordsService } from "../core/records.js";
import { TodoReminders } from "../core/todo-reminders.js";
import { PromptsService } from "../core/prompts.js";
import { startWorkbenchPipe } from "../core/workbench-mcp-pipe.js";
import { WorkbenchTools } from "../core/workbench-tools.js";
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
import { readProjectRules } from "../core/project-rules.js";
import { ProjectService } from "../core/projects.js";
import { readLogTail } from "../core/log-tail.js";
import { ProjectBrowser } from "../core/project-browser.js";
import { EditorFiles, encodeEditorText, projectFile } from "../core/editor-files.js";
import { JavaLanguageService } from "../core/java-language-service.js";
import { resolveCodeNavigation, type LspResolver } from "../core/code-navigation.js";
import {
  activateClientWindow,
  clientProcesses,
  visibleClientWindows,
} from "../core/process.js";
import { exportWord } from "../core/documents.js";
import {
  notificationActivation,
  notificationAppId,
  notificationClsid,
  projectNotification,
  todoNotification,
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
  EditorOpenTarget,
  MonthlyDraft,
  Note,
  RecordKind,
  RunInfo,
  UiDialogButton,
  UiDialogRequest,
  UiDialogTone,
} from "../shared/types.js";
const here = path.dirname(fileURLToPath(import.meta.url));
const override = process.argv
  .find((v) => v.startsWith("--data-dir="))
  ?.slice(11);
const startedForMcp = process.argv.includes("--mcp-start");
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
    quitRequested = false,
    closeDialog = false;
  let restoringData = false,
    pendingActions = 0;
  type NotificationDestination = { taskId: string } | { todoId: string };
  let pendingNotification: NotificationDestination | null = null;
  let focusNotificationOnReady = false;
  let reminderTray: Tray | undefined;
  let supportsTodoReminders = false;
  const notifications = new Map<string, Notification>();
  const commitDrafts = new Map<string, string>();
  const diffWindows = new Map<
    string,
    {
      window: BrowserWindow;
      request: DiffWindowRequest;
      watchers?: fs.FSWatcher[];
      watchTimer?: ReturnType<typeof setTimeout>;
    }
  >();
  interface EditorWindowEntry {
    window: BrowserWindow;
    projectId: string;
    ready: boolean;
    pendingOpen?: EditorOpenTarget;
    language?: JavaLanguageService;
    watchers: Map<string, fs.FSWatcher>;
    projectWatcher?: fs.FSWatcher;
    projectWatchTimer?: ReturnType<typeof setTimeout>;
    search?: AbortController;
  }
  // 键为窗口 ID：同一窗口可以切换项目，也允许多个窗口打开同一项目。
  const editorWindows = new Map<string, EditorWindowEntry>();
  const editorFiles = new EditorFiles(app.isPackaged
    ? path.join(process.resourcesPath, "editor-runtime", "rg.exe")
    : path.resolve(here, "../../node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe"));
  let lastActivation: { id: string; at: number } | undefined;
  let lastMonthlyExport = "";
  let changedTimer: ReturnType<typeof setTimeout> | undefined;
  let revision = 0, fullRevision = 0, gitChanged = false;
  const fieldRevisions = { notes: 0, prompts: 0, tasks: 0, runs: 0, formDrafts: 0 };
  const store = new Store(path.join(dataDir, "workbench.sqlite"));
  const config = new ConfigService(store, dataDir);
  let queuedDrafts: Record<string, unknown> = {};
  let draftWrite: Promise<void> | undefined;
  function persistDraft(key: string, value: unknown) {
    queuedDrafts[key] = value;
    // IPC inputs already waiting in the same turn share one durable commit.
    draftWrite ??= nextTurn().then(() => {
      try {
        const drafts = store.get<Record<string, unknown>>("meta", "form-drafts") || {};
        store.set("meta", "form-drafts", { ...drafts, ...queuedDrafts });
        fieldRevisions.formDrafts = ++revision;
      } finally {
        queuedDrafts = {};
        draftWrite = undefined;
      }
    });
    return draftWrite;
  }
  const changed = (field?: keyof typeof fieldRevisions | "other") => {
    ++revision;
    if (!field) fullRevision = revision;
    else if (field !== "other") fieldRevisions[field] = revision;
    gitChanged ||= !field || field === "tasks" || field === "runs";
    if (!changedTimer)
      changedTimer = setTimeout(() => {
        changedTimer = undefined;
        if (win && !win.isDestroyed())
          win.webContents.send("workbench:changed", revision, gitChanged);
        if (gitChanged) {
          for (const item of diffWindows.values())
            if (!item.window.isDestroyed())
              item.window.webContents.send("workbench:changed");
        }
        gitChanged = false;
      }, 120);
  };
  const projectBrowser = new ProjectBrowser(dataDir, (url) => shell.openExternal(url));
  const tasks = new TaskManager(store, dataDir, () => changed("tasks")),
    records = new RecordsService(store, dataDir),
    prompts = new PromptsService(store),
    git = new Git(config.get().tools.git),
    submit = new SubmitService(git, tasks, dataDir),
    apk = new ApkService(config, tasks, dataDir),
    projects = new ProjectService(
      config,
      git,
      tasks,
      dataDir,
      () => changed("runs"),
      undefined,
      undefined,
      (url, project) => projectBrowser.open(project, url),
    );
  const workbenchTools = new WorkbenchTools(store, records, prompts, config);
  const backup = new BackupService(store, tasks, dataDir, async () => {
    if ((await projects.owned()).length)
      throw new Error(
        "仍有工作台拥有的项目进程，请先停止自有服务再恢复，以保留其停止与归属信息",
      );
  });
  const gitClient = new GitClientService(git, tasks, dataDir, (repo) => {
    const project = config
      .get()
      .projects.find(
        (project) =>
          path.resolve(project.path).toLowerCase() ===
          path.resolve(repo).toLowerCase(),
      );
    if (!project) return undefined;
    return {
      include: project.gitUntrackedInclude,
      exclude: project.gitUntrackedExclude,
    };
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
      titleBarStyle: "hidden",
      titleBarOverlay: { color: "#00000000", symbolColor: "#818594", height: 38 },
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
    // 鼠标侧键后退/前进：与代码编辑器一致，便于跳转定义后返回原处
    let diffHistoryAt = 0, diffHistoryDir = 0;
    const sendDiffHistory = (direction: number) => {
      const at = Date.now();
      if (direction === diffHistoryDir && at - diffHistoryAt < 120) return;
      diffHistoryDir = direction;
      diffHistoryAt = at;
      if (!child.isDestroyed()) child.webContents.send("workbench:diff-history", direction);
    };
    child.on("app-command", (_event, command) => {
      if (command === "browser-backward") sendDiffHistory(-1);
      else if (command === "browser-forward") sendDiffHistory(1);
    });
    if (process.platform === "win32") {
      try {
        child.hookWindowMessage(0x020b, (wParam) => {
          const button = (wParam.readUInt32LE(0) >>> 16) & 0xffff;
          if (button === 1) sendDiffHistory(-1);
          else if (button === 2) sendDiffHistory(1);
        });
      } catch { /* 不支持窗口消息钩子时仅依赖 app-command */ }
    }
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
  function attachEditorLanguage(item: EditorWindowEntry, project: ReturnType<typeof knownProject>) {
    if (!["tomcat", "spring"].includes(project.type)) return;
    const language = new JavaLanguageService(project, editorRuntime, dataDir,
      (method, params) => {
        if (item.language === language && !item.window.isDestroyed())
          item.window.webContents.send("workbench:editor-lsp", method, params);
      }, config.get().tools.maven);
    item.language = language;
    void language.start().catch(() => {});
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
  function detachEditorLanguage(item: EditorWindowEntry) {
    for (const watcher of item.watchers.values()) watcher.close();
    item.watchers.clear();
    item.projectWatcher?.close();
    item.projectWatcher = undefined;
    clearTimeout(item.projectWatchTimer);
    item.projectWatchTimer = undefined;
    void item.language?.stop();
    item.language = undefined;
  }
  function normalizeEditorTarget(root: string, target?: EditorOpenTarget): EditorOpenTarget | undefined {
    if (!target) return undefined;
    const line = Math.max(1, Math.floor(Number(target.line) || 1));
    const column = Math.max(1, Math.floor(Number(target.column) || 1));
    if (typeof target.uri === "string" && target.uri.startsWith("jdt://") && target.uri.length <= 4000) {
      return { file: `jdt:${target.uri}`, uri: target.uri, line, column };
    }
    const full = projectFile(root, String(target.file || ""));
    const relative = path.relative(root, full).split(path.sep).join("/");
    return { file: relative, line, column };
  }
  async function openEditor(projectId: string, forceNew = false, target?: EditorOpenTarget) {
    const project = knownProject(projectId);
    if (!fs.existsSync(project.path) || !fs.statSync(project.path).isDirectory())
      throw new Error("项目目录不存在");
    const safeTarget = normalizeEditorTarget(project.path, target);
    const existing = forceNew ? undefined : [...editorWindows.values()].find(
      (item) => item.projectId === project.id && !item.window.isDestroyed(),
    );
    if (existing) {
      if (safeTarget) {
        if (existing.ready) existing.window.webContents.send("workbench:editor-open", safeTarget);
        else existing.pendingOpen = safeTarget;
      }
      if (existing.window.isMinimized()) existing.window.restore();
      existing.window.show();
      existing.window.focus();
      return { reused: true, target: safeTarget };
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
    const item: EditorWindowEntry = {
      window: child, projectId, ready: false, pendingOpen: safeTarget, watchers: new Map(),
    };
    const key = String(child.id);
    editorWindows.set(key, item);
    attachEditorLanguage(item, project);
    child.removeMenu();
    child.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    child.webContents.on("will-navigate", (event, url) => {
      if (url !== editorAllowed) event.preventDefault();
    });
    // 鼠标侧键：app-command（Windows 消息）+ WM_XBUTTONDOWN 双通道，避免不同鼠标/驱动下漏事件
    let historyAt = 0, historyDirection = 0;
    const sendHistory = (direction: number) => {
      const now = Date.now();
      if (direction === historyDirection && now - historyAt < 120) return;
      historyDirection = direction;
      historyAt = now;
      if (!child.isDestroyed()) child.webContents.send("workbench:editor-history", direction);
    };
    child.on("app-command", (_event, command) => {
      if (command === "browser-backward") sendHistory(-1);
      else if (command === "browser-forward") sendHistory(1);
    });
    if (process.platform === "win32") {
      try {
        child.hookWindowMessage(0x020b, (wParam) => {
          const button = (wParam.readUInt32LE(0) >>> 16) & 0xffff;
          if (button === 1) sendHistory(-1);
          else if (button === 2) sendHistory(1);
        });
      } catch { /* 不支持窗口消息钩子时仅依赖 app-command */ }
    }
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
      item.search?.abort();
      void item.language?.stop();
      editorWindows.delete(key);
    });
    await child.loadFile(editorEntry);
    return { opened: true };
  }
  function showMainWindow() {
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  }
  function activateNotification(destination: NotificationDestination) {
    const activationId = "taskId" in destination ? destination.taskId : destination.todoId;
    if (lastActivation?.id === activationId && Date.now() - lastActivation.at < 1000) return false;
    lastActivation = { id: activationId, at: Date.now() };
    pendingNotification = destination;
    focusNotificationOnReady = true;
    showMainWindow();
    if (win && !win.isDestroyed()) win.webContents.send("workbench:navigate", destination);
    return true;
  }
  const activateTask = (taskId: string) => {
    const task = store.get<import("../shared/types.js").Task>("task", taskId);
    if (!task || !["run", "wechat"].includes(task.type) || !activateNotification({ taskId })) return;
    task.result.notification = {
      ...((task.result.notification as object) || {}),
      activatedAt: now(),
    };
    tasks.save(task);
  };
  const activateTodo = (todoId: string) => {
    if (store.get<Note>("note", todoId)?.kind === "idea") activateNotification({ todoId });
  };
  const reminders = new TodoReminders(store, (note) => new Promise((resolve) => {
    const notificationId = hash(`${note.id}:${note.dueAt}`).slice(0, 24);
    const notification = new Notification({
      ...todoNotification(note),
      icon: notificationIcon,
      id: notificationId,
      groupId: "todo-deadline",
    });
    const finish = (shown: boolean) => {
      clearTimeout(timeout);
      if (!shown) notifications.delete(notificationId);
      resolve(shown);
    };
    const timeout = setTimeout(() => finish(false), 8000);
    notifications.set(notificationId, notification);
    notification.once("show", () => finish(true));
    notification.once("failed", () => finish(false));
    notification.once("close", () => notifications.delete(notificationId));
    notification.once("click", () => activateTodo(note.id));
    try { notification.show(); } catch { finish(false); }
  }));

  function hideForReminders() {
    if (!reminderTray) {
      reminderTray = new Tray(windowIcon);
      reminderTray.setToolTip("个人工作台");
      reminderTray.on("click", showMainWindow);
      reminderTray.setContextMenu(Menu.buildFromTemplate([
        { label: "打开个人工作台", click: showMainWindow },
        { label: "退出工作台", click: () => app.quit() },
      ]));
    }
    win.hide();
  }
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
    const hasLog = typeof r?.logPath === "string" && !!r.logPath && fs.existsSync(r.logPath);
    return {
      ...rest,
      hasLog,
      description: configuration?.description,
      port: configuration?.port,
      deployment: configuration?.deployment,
    };
  };
  const pendingDialogs = new Map<
    string,
    {
      senderId: number;
      cancelId: number;
      resolve: (result: { response: number }) => void;
      cleanup: () => void;
    }
  >();
  ipcMain.on("workbench:dialog-reply", (event, payload) => {
    const reqId = typeof payload?.id === "string" ? payload.id : "";
    const entry = pendingDialogs.get(reqId);
    if (!entry || entry.senderId !== event.sender.id) return;
    pendingDialogs.delete(reqId);
    entry.cleanup();
    const response = Number.isInteger(payload?.response)
      ? Number(payload.response)
      : entry.cancelId;
    entry.resolve({ response });
  });
  const showUiDialog = (
    target: BrowserWindow | undefined,
    options: {
      tone?: UiDialogTone;
      title: string;
      message: string;
      detail?: string;
      buttons: UiDialogButton[];
      defaultId?: number;
      cancelId?: number;
    },
  ): Promise<{ response: number }> => {
    const host = target && !target.isDestroyed() ? target : win;
    const buttons: UiDialogButton[] = options.buttons.length
      ? options.buttons
      : [{ label: "确定", variant: "primary" }];
    const clamp = (value: number | undefined, fallback: number) => {
      const n = Number.isInteger(value) ? Number(value) : fallback;
      return Math.min(Math.max(0, n), buttons.length - 1);
    };
    const defaultId = clamp(options.defaultId, 0);
    const cancelId = clamp(options.cancelId, 0);
    if (!host || host.isDestroyed() || host.webContents.isDestroyed()) {
      return Promise.resolve({ response: cancelId });
    }
    if (host.isMinimized()) host.restore();
    if (!host.isVisible()) host.show();
    host.focus();
    const reqId = id();
    const request: UiDialogRequest = {
      id: reqId,
      tone: options.tone || "question",
      title: options.title,
      message: options.message,
      detail: options.detail || undefined,
      buttons,
      defaultId,
      cancelId,
    };
    return new Promise((resolve) => {
      const onGone = () => {
        const entry = pendingDialogs.get(reqId);
        if (!entry) return;
        pendingDialogs.delete(reqId);
        entry.cleanup();
        resolve({ response: cancelId });
      };
      const cleanup = () => {
        if (!host.isDestroyed()) {
          host.removeListener("closed", onGone);
          if (!host.webContents.isDestroyed()) {
            host.webContents.removeListener("render-process-gone", onGone);
          }
        }
      };
      pendingDialogs.set(reqId, {
        senderId: host.webContents.id,
        cancelId,
        resolve,
        cleanup,
      });
      host.once("closed", onGone);
      host.webContents.once("render-process-gone", onGone);
      host.webContents.send("workbench:dialog", request);
    });
  };
  const ask = async (
    title: string,
    message: string,
    confirm = "确认",
    options: {
      detail?: string;
      tone?: UiDialogTone;
      danger?: boolean;
      target?: BrowserWindow;
    } = {},
  ) => {
    const isDanger =
      options.danger ?? /删除|移除|丢弃|回滚|清空|覆盖/.test(confirm);
    const tone: UiDialogTone =
      options.tone ||
      (isDanger
        ? /删除|移除|回滚/.test(confirm)
          ? "danger"
          : "warning"
        : "question");
    return (
      (
        await showUiDialog(options.target || win, {
          tone,
          title,
          message,
          detail: options.detail,
          buttons: [
            { label: "取消", variant: "default" },
            { label: confirm, variant: isDanger ? "danger" : "primary" },
          ],
          defaultId: 0,
          cancelId: 0,
        })
      ).response === 1
    );
  };
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
    if (draftWrite && name !== "form.save") await draftWrite.catch(() => {});
    switch (name) {
      case "editor.context": {
        const item = [...editorWindows.values()].find((value) => value.window === source);
        if (!item) throw new Error("代码编辑器窗口不存在");
        const project = knownProject(item.projectId);
        item.ready = true;
        const initialOpen = item.pendingOpen;
        item.pendingOpen = undefined;
        return { projectId: project.id, projectName: project.name, root: project.path,
          java: !!item.language, status: item.language?.status || "unavailable",
          error: item.language?.error || "", initialOpen };
      }
      case "code.resolve-definition": {
        const project = knownProject(p.projectId);
        const full = projectFile(project.path, String(p.file || ""));
        const relative = path.relative(project.path, full).split(path.sep).join("/");
        const text = typeof p.text === "string" ? p.text : "";
        if (text.length > 8 * 1024 * 1024) throw new Error("代码内容过大");
        const line = Math.max(1, Math.floor(Number(p.line) || 1));
        const column = Math.max(1, Math.floor(Number(p.column) || 1));
        const kind = p.kind === "implementation" ? "implementation" : "definition";
        const allowLsp = p.allowLsp !== false;
        const runningLang = [...editorWindows.values()].find(
          (entry) => entry.projectId === project.id && !entry.window.isDestroyed() &&
            entry.language?.ready && entry.language.status === "ready",
        )?.language;
        const lspResolver: LspResolver | undefined = runningLang && full.toLowerCase().endsWith(".java")
          ? async (reqKind, reqFile, reqText, reqLine, reqCol) => {
              const targetFull = projectFile(project.path, reqFile);
              const alreadyOpen = runningLang.hasDocument(targetFull);
              if (alreadyOpen && runningLang.documentText(targetFull) !== reqText) return null;
              if (!alreadyOpen) runningLang.open(targetFull, reqText);
              try {
                const method = reqKind === "implementation" ? "textDocument/implementation" : "textDocument/definition";
                const raw = await Promise.race([
                  runningLang.request(method, {
                    textDocument: { uri: pathToFileURL(targetFull).href },
                    position: { line: reqLine - 1, character: reqCol - 1 },
                  }),
                  new Promise<null>((resolve) => setTimeout(() => resolve(null), 2500)),
                ]);
                return Array.isArray(raw) ? raw : raw ? [raw] : null;
              } catch {
                return null;
              } finally {
                if (!alreadyOpen) runningLang.close(targetFull);
              }
            }
          : undefined;
        return resolveCodeNavigation(
          { root: project.path, file: relative, text, line, column, kind, allowLsp },
          editorFiles,
          lspResolver,
        );
      }
      case "code.open-in-editor": {
        const project = knownProject(p.projectId);
        return openEditor(project.id, false, {
          file: String(p.file || ""),
          uri: typeof p.uri === "string" ? p.uri : undefined,
          line: Math.max(1, Math.floor(Number(p.line) || 1)),
          column: Math.max(1, Math.floor(Number(p.column) || 1)),
        });
      }
      case "editor.projects":
      case "editor.switch-project":
      case "editor.tree":
      case "editor.read":
      case "editor.version":
      case "editor.save":
      case "editor.file-search":
      case "editor.code-files":
      case "editor.text-search":
      case "editor.search-start":
      case "editor.search-cancel":
      case "editor.file-types":
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
      case "editor.confirm-conflict":
      case "editor.blame":
      case "editor.blame-diff": {
        const item = [...editorWindows.values()].find((value) => value.window === source);
        if (!item) throw new Error("代码编辑器窗口不存在");
        const project = knownProject(item.projectId);
        const root = project.path;
        if (name === "editor.projects") return config.get().projects.map(
          ({ id, name: label, group, type, path: dir }) => ({ id, name: label, group, type, path: dir }));
        if (name === "editor.switch-project") {
          const target = knownProject(String(p.projectId || ""));
          if (!fs.existsSync(target.path) || !fs.statSync(target.path).isDirectory())
            throw new Error("项目目录不存在");
          if (String(p.mode) === "new") return openEditor(target.id, true);
          detachEditorLanguage(item);
          editorFiles.cancelSearch(root);
          editorFiles.invalidate(root);
          editorFiles.invalidate(target.path);
          item.projectId = target.id;
          item.ready = false;
          item.pendingOpen = undefined;
          item.window.setTitle(`${target.name} · 代码编辑器`);
          attachEditorLanguage(item, target);
          return { switched: true, projectId: target.id, projectName: target.name };
        }
        if (name === "editor.tree") return editorFiles.tree(root, String(p.directory || ""), item.language?.sourceFolders);
        if (name === "editor.file-search") return editorFiles.findFiles(root, String(p.query || ""));
        if (name === "editor.code-files") return (await editorFiles.files(root))
          .filter((file) => /\.(?:ts|tsx|js|jsx)$/i.test(file)).slice(0, 3000);
        if (name === "editor.text-search") return editorFiles.search(root, String(p.query || ""), 500,
          Array.isArray(p.extensions) ? p.extensions.slice(0, 100).map(String) : undefined);
        if (name === "editor.file-types") return editorFiles.fileTypes(root);
        if (name === "editor.search-start") {
          const requestId = String(p.requestId || "");
          if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) throw new Error("搜索请求无效");
          item.search?.abort();
          const controller = new AbortController();
          item.search = controller;
          const query = String(p.query || "").slice(0, 200);
          const extensions = Array.isArray(p.extensions) ? p.extensions.slice(0, 100).map(String) : undefined;
          const send = (payload: Record<string, unknown>) => {
            if (controller.signal.aborted || !source || source.isDestroyed()) return;
            source.webContents.send("workbench:editor-search", { requestId, ...payload });
          };
          void editorFiles.streamSearch(root, query, extensions, 500,
            (hits) => send({ hits }), controller.signal)
            .then(() => send({ done: true }))
            .catch((error) => send({ error: redact(errorText(error)) }));
          return { started: true };
        }
        if (name === "editor.search-cancel") {
          item.search?.abort();
          item.search = undefined;
          return true;
        }
        if (name === "editor.previews") return editorFiles.previews(root, Array.isArray(p.locations) ? p.locations : []);
        if (name === "editor.confirm-save") {
          const result = await showUiDialog(source, {
            tone: "question",
            title: "保存修改",
            message: "文件有未保存的修改，是否保存？",
            detail: String(p.file || ""),
            buttons: [
              { label: "保存", variant: "primary" },
              { label: "放弃", variant: "danger" },
              { label: "取消", variant: "default" },
            ],
            defaultId: 0,
            cancelId: 2,
          });
          return ["save", "discard", "cancel"][result.response] || "cancel";
        }
        if (name === "editor.confirm-conflict") {
          const result = await showUiDialog(source, {
            tone: "warning",
            title: "文件已变化",
            message: "文件已被其他程序修改。选择重新加载会放弃本编辑器中该文件的修改。",
            detail: String(p.file || ""),
            buttons: [
              { label: "取消", variant: "default" },
              { label: "重新加载", variant: "primary" },
              { label: "覆盖外部修改", variant: "danger" },
            ],
            defaultId: 0,
            cancelId: 0,
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
        if (name === "editor.blame") {
          const relative = path.relative(root, file).split(path.sep).join("/");
          if (p.text === undefined) return git.blame(root, relative);
          const { text, encoding, bom } = p;
          if (typeof text !== "string" || text.length > 8 * 1024 * 1024 ||
            (encoding !== "utf8" && encoding !== "utf16le" && encoding !== "utf16be" && encoding !== "gb18030") ||
            typeof bom !== "boolean") throw new Error("提交历史请求无效");
          return git.blame(root, relative, encodeEditorText(text, encoding, bom));
        }
        if (name === "editor.blame-diff") {
          const hash = String(p.hash || "");
          const relative = path.relative(root, file).split(path.sep).join("/");
          if (!/^[0-9a-f]{7,40}$/i.test(hash) || /^0+$/.test(hash))
            throw new Error("提交记录无效");
          const parent = await git.run(
            root,
            ["rev-parse", "--verify", "--end-of-options", `${hash}^`],
            { allowFailure: true },
          );
          const base = parent.code === 0 ? parent.stdout.trim() : "__empty__";
          return openDiff({
            projectId: project.id,
            comparison: { mode: "versions", base, target: hash, file: relative },
            file: relative,
          });
        }
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
      case "git.commit-draft": {
        const project = knownProject(p.projectId);
        if (p.message === undefined) return commitDrafts.get(project.id) || "";
        if (typeof p.message !== "string" || p.message.length > 20000) throw new Error("提交说明超过长度限制");
        if (p.message) commitDrafts.set(project.id, p.message);
        else commitDrafts.delete(project.id);
        const recipients = [win, ...[...diffWindows.values()].filter(item => item.request.projectId === project.id).map(item => item.window)];
        for (const target of recipients) {
          if (target && target !== source && !target.isDestroyed())
            target.webContents.send("workbench:commit-draft", { projectId: project.id, message: p.message });
        }
        return p.message;
      }
      case "git.window-context": {
        const item = [...diffWindows.values()].find((v) => v.window === source);
        if (!item) throw new Error("对比窗口不存在");
        const project = knownProject(item.request.projectId);
        return { request: item.request, projectName: project.name, projectPath: project.path };
      }
      case "git.confirm-save": {
        const result = await showUiDialog(source || win, {
          tone: "question",
          title: "保存代码修改",
          message: "代码已修改，是否保存？",
          detail: String(p.file || ""),
          buttons: [
            { label: "保存", variant: "primary" },
            { label: "不保存", variant: "danger" },
            { label: "继续编辑", variant: "default" },
          ],
          defaultId: 0,
          cancelId: 2,
        });
        return ["save", "discard", "cancel"][result.response] || "cancel";
      }
      case "git.confirm-leave": {
        if (p?.canSave) {
          const result = await showUiDialog(source || win, {
            tone: "warning",
            title: "有未保存编辑",
            message: "编辑结果尚未保存，是否先保存再继续？",
            detail: p.file ? String(p.file) : undefined,
            buttons: [
              { label: "保留编辑", variant: "default" },
              { label: "丢弃编辑", variant: "danger" },
              { label: "保存并继续", variant: "primary" },
            ],
            defaultId: 2,
            cancelId: 0,
          });
          return ["cancel", "discard", "save"][result.response] || "cancel";
        }
        return (
          (
            await showUiDialog(source || win, {
              tone: "warning",
              title: "有未保存编辑",
              message: "编辑结果尚未保存，丢弃编辑并继续？",
              buttons: [
                { label: "保留编辑", variant: "default" },
                { label: "丢弃编辑", variant: "danger" },
              ],
              defaultId: 0,
              cancelId: 0,
            })
          ).response === 1
        );
      }
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
        if (p.watch !== false) await watchDiff(source, repo, p.file);
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
            await showUiDialog(source || win, {
              tone: "danger",
              title: "回滚当前差异块",
              message: "仅撤销此块的未暂存修改，无法通过 Git 撤销，暂存区内容保留。",
              detail: `${await gitClient.tokenFile(project.path, p.token)} · 差异块 ${Number(p.hunk) + 1}`,
              buttons: [
                { label: "取消", variant: "default" },
                { label: "回滚此块", variant: "danger" },
              ],
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
            await showUiDialog(source || win, {
              tone: "question",
              title: "保存结果并标记冲突已解决",
              message: p.delete
                ? "接受此冲突的删除结果，将移除工作区文件并暂存删除。不会自动继续当前操作。"
                : "合并结果将写入工作区并暂存，不会自动继续当前操作。",
              detail: file,
              buttons: [
                { label: "取消", variant: "default" },
                { label: "保存并暂存", variant: "primary" },
              ],
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
          if (!p.confirmed) {
            detail = `${preview.branch} → ${preview.remote}/${preview.target}\n${preview.newBranch ? "创建远程分支\n" : ""}待推送提交（最多显示 100 条）\n${preview.commits || "无新增提交"}`;
          }
        }
        if (
          detail &&
          !(
            await showUiDialog(source || win, {
              tone: [
                "rollback",
                "delete-branch",
                "stash-drop",
                "rebase",
                "abort",
                "skip",
              ].includes(operation)
                ? "danger"
                : "warning",
              title: `确认 Git · ${gitOperationLabel(operation)}`,
              message: "请核对以下操作详情后再继续执行：",
              detail: detail.trim(),
              buttons: [
                { label: "取消", variant: "default" },
                {
                  label: "确认执行",
                  variant: [
                    "rollback",
                    "delete-branch",
                    "stash-drop",
                    "rebase",
                    "abort",
                    "skip",
                  ].includes(operation)
                    ? "danger"
                    : "primary",
                },
              ],
              defaultId: 0,
              cancelId: 0,
            })
          ).response
        )
          return { cancelled: true };
        return gitClient.execute(project.path, operation, { ...p, expected });
      }
      case "bootstrap": {
        // SQLite's counter also detects commits made by another connection.
        const { data_version: databaseVersion } = store.db.prepare("pragma data_version").get()!;
        const since = p?.revision;
        const full = !Number.isSafeInteger(since) || since < fullRevision || since > revision ||
          p?.databaseVersion !== databaseVersion;
        const needs = (field: keyof typeof fieldRevisions) => full || fieldRevisions[field] > since;
        return {
          ...(full && { config: config.get(), imports: store.list("import"), dataDir, version: app.getVersion() }),
          ...(needs("notes") && { notes: records.listAll() }),
          ...(needs("prompts") && { prompts: prompts.list() }),
          ...(needs("tasks") && { tasks: tasks.list() }),
          ...(needs("runs") && { runs: store.list("run") }),
          ...(needs("formDrafts") && { formDrafts: store.get("meta", "form-drafts") || {} }),
          today: localDate(),
          revision,
          databaseVersion,
        };
      }
      case "notification.take": {
        const destination = pendingNotification;
        pendingNotification = null;
        return destination;
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
        await persistDraft(p.key, p.value);
        return { saved: true };
      }
      case "record.save": {
        if (p.projectId) knownProject(p.projectId);
        const n = records.save(p);
        if (n.kind === "idea") reminders.refresh();
        changed("notes");
        return n;
      }
      case "record.complete": {
        const n = records.complete(p.id, !!p.done, p.edit);
        reminders.refresh();
        changed("notes");
        return n;
      }
      case "record.delete": {
        const n = records.softRemove(p.id);
        if (n.kind === "idea") reminders.refresh();
        changed("notes");
        return n;
      }
      case "record.restore": {
        const n = records.restore(p.id);
        if (n.kind === "idea") reminders.refresh();
        changed("notes");
        return n;
      }
      case "record.purge": {
        return { purged: records.purge(p.id) };
      }
      case "prompt.save": {
        const saved = prompts.save(p);
        changed("prompts");
        return saved;
      }
      case "prompt.star": {
        const updated = prompts.star(p.id, !!p.starred);
        changed("prompts");
        return updated;
      }
      case "prompt.delete": {
        const removed = prompts.softRemove(p.id);
        changed("prompts");
        return removed;
      }
      case "prompt.restore": {
        const restored = prompts.restore(p.id);
        changed("prompts");
        return restored;
      }
      case "prompt.purge": {
        return { purged: prompts.purge(p.id) };
      }
      case "monthly.get": {
        const draft = records.draft(p.month, config.get().name);
        const work = records.list("work");
        return {
          draft,
          materials: records.month(p.month, p.projectId, work),
          sources: records.sources(draft),
          undated: work.filter((n) => !n.happenedOn).length,
        };
      }
      case "monthly.save": {
        const draft = records.saveDraft(p);
        changed("other");
        return draft;
      }
      case "monthly.add": {
        const draft = records.addSources(p.month, p.name, p.section, p.ids);
        changed("other");
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
        const exported = exportWord(
          config.get().tools.template || bundledTemplate,
          draft,
          destination,
        );
        lastMonthlyExport = exported.path;
        return exported;
      }
      case "monthly.open-exported": {
        if (!lastMonthlyExport || !fs.existsSync(lastMonthlyExport))
          throw new Error("导出的月报文件已不存在");
        shell.showItemInFolder(lastMonthlyExport);
        return { opened: true };
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
            `仅从对应备份恢复 ${policy.protectedFile} 和原 Git 标志。不会重复应用 stash、提交或推送。`,
            "恢复配置",
            {
              detail: `工作目录：${project.path}\n恢复批次：${p.id}`,
              tone: "question",
            },
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
            "请先在原工具核对本地改动完整性、合并状态和保留的 stash。此操作仅记录人工确认，不应用或删除 stash。",
            "我已核对并处理",
            {
              detail: `工作目录：${project.path}\n批次：${p.id}`,
              tone: "warning",
            },
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
      case "review.rules": {
        const project = knownProject(p.projectId);
        return readProjectRules(
          project.path,
          project.group === "HomeProject" && project.type === "h5"
            ? "D:/git-project/employeeapp-uniapp-bak/.cursor/rules/employeeapp.mdc"
            : undefined,
        );
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
        changed("other");
        return result;
      }
      case "backup.list":
        return store.list<any>("meta").filter((v) => v.path && v.at && v.bytes);
      case "backup.preview": {
        if (typeof p?.file === "string" && p.file) {
          const known = store
            .list<any>("meta")
            .find((v) => v.path === p.file && v.at && v.bytes);
          if (!known) throw new Error("未在备份记录中找到该文件，请手动选择备份包");
          if (!fs.existsSync(known.path))
            throw new Error("备份文件已不存在：" + known.path);
          return backup.preview(known.path);
        }
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
            "将替换记录、提示词、配置、月报及任务历史，并先保存当前完整备份。源码、远端、APK 和原 TXT 不受影响。",
            "备份当前数据并恢复",
            {
              detail: `备份：${preview.file}\n日期：${preview.createdAt}`,
              tone: "warning",
            },
          ))
        )
          return null;
        await reminders.stop();
        let result;
        try {
          result = await backup.restore(p.token);
        } finally {
          if (supportsTodoReminders) reminders.start();
        }
        git.executable = config.get().tools.git;
        changed();
        return result;
      }
      case "ui.confirm":
        return ask(
          String(p.title || "确认").slice(0, 100),
          String(p.message || "").slice(0, 4000),
          String(p.confirm || "确认").slice(0, 50),
          {
            detail: p.detail ? String(p.detail).slice(0, 4000) : undefined,
            target: source || win,
          },
        );
      case "ui.choose": {
        const labels: string[] = (Array.isArray(p.buttons) ? p.buttons : ["取消"])
          .map((item: unknown) => String(item).slice(0, 20))
          .filter(Boolean)
          .slice(0, 4);
        if (!labels.length) labels.push("取消");
        const defaultId = Math.min(
          Math.max(0, Number(p.defaultId ?? labels.length - 1) || 0),
          labels.length - 1,
        );
        const buttons: UiDialogButton[] = labels.map((label, idx) => ({
          label,
          variant:
            idx === 0
              ? "default"
              : /删除|移除|丢弃|回滚/.test(label)
                ? "danger"
                : idx === defaultId
                  ? "primary"
                  : "default",
        }));
        const result = await showUiDialog(source || win, {
          tone: "question",
          title: String(p.title || "确认").slice(0, 100),
          message: String(p.message || "").slice(0, 4000),
          detail: p.detail ? String(p.detail).slice(0, 4000) : undefined,
          buttons,
          defaultId,
          cancelId: 0,
        });
        return result.response;
      }
      case "clipboard.text": {
        const text = typeof p?.text === "string" ? p.text : String(p?.text ?? "");
        clipboard.writeText(text);
        return { copied: true };
      }
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
    if (process.platform === "win32") {
      supportsTodoReminders = Notification.isSupported();
      Notification.handleActivation((details) => {
        const activation = notificationActivation(details.arguments);
        if (activation?.kind === "task") activateTask(activation.id);
        else if (activation?.kind === "todo") activateTodo(activation.id);
      });
    }
    const saved = store.get<{ width: number; height: number }>(
      "meta",
      "window",
    );
    const workArea = screen.getPrimaryDisplay().workAreaSize;
    win = new BrowserWindow({
      width: Math.min(saved?.width || 1440, workArea.width),
      height: Math.min(saved?.height || 860, workArea.height),
      minWidth: Math.min(960, workArea.width),
      minHeight: Math.min(640, workArea.height),
      frame: false,
      title: "个人工作台",
      backgroundColor: "#f9fafc",
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
        "git.commit-draft",
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
        "code.resolve-definition",
        "code.open-in-editor",
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
      if (!startedForMcp || focusNotificationOnReady) win.show();
      if (focusNotificationOnReady) {
        if (win.isMinimized()) win.restore();
        win.focus();
        focusNotificationOnReady = false;
      }
    });
    void win.loadFile(entry);
    if (supportsTodoReminders) {
      reminders.start();
      powerMonitor.on("resume", () => reminders.refresh());
    }
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
          if (!quitRequested && reminders.hasPending()) {
            hideForReminders();
            return;
          }
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
          const exitTaskLabels: Record<string, string> = {
            running: "执行中",
            awaiting: "待确认",
            cancelling: "正在安全停止",
          };
          const exitRunLabels: Record<string, string> = {
            starting: "启动中",
            running: "运行中",
            stopping: "停止中",
            watching: "编译监听中",
            "tool-open": "开发者工具已打开",
          };
          const result = await showUiDialog(win, {
            tone: "warning",
            title: "退出个人工作台",
            message: `仍有 ${active.length} 个运行或待确认任务，${owned.length} 个工作台拥有的项目进程。`,
            detail: [
              ...active.map((t) => `${t.title}：${exitTaskLabels[t.state] || t.state}`),
              ...owned.map(
                (r) => `${config.project(r.projectId).name}：${exitRunLabels[r.state] || r.state}`,
              ),
              "Git 写命令将完成当前命令后停止后续步骤。外部实例不由工作台停止。",
            ].join("\n"),
            buttons: [
              { label: "取消退出", variant: "default" },
              { label: "安全结束任务并停止自有服务", variant: "danger" },
              { label: "安全结束任务，保留项目服务并退出", variant: "primary" },
            ],
            defaultId: 0,
            cancelId: 0,
          });
          if (result.response === 0) return;
          for (const t of active) tasks.cancel(t.id);
          await Promise.all([...tasks.running.values()]);
          if (result.response === 1)
            for (const r of owned) await projects.stop(r.projectId);
          await Promise.all([...editorWindows.values()].map((item) => item.language?.stop()));
          if (draftWrite) await draftWrite;
          exiting = true;
          win.close();
        } catch (e) {
          await showUiDialog(win, {
            tone: "error",
            title: "尚未退出",
            message: "尚未退出，请核对任务状态。",
            detail: redact(errorText(e)),
            buttons: [{ label: "知道了", variant: "primary" }],
            defaultId: 0,
            cancelId: 0,
          });
        } finally {
          closeDialog = false;
          quitRequested = false;
        }
      })();
    });
    app.on("second-instance", (_event, args) => {
      if (args.includes("--mcp-start")) return;
      showMainWindow();
    });
    win.on("closed", () => {
      reminderTray?.destroy();
      reminderTray = undefined;
      for (const item of diffWindows.values())
        if (!item.window.isDestroyed()) item.window.close();
      for (const item of editorWindows.values())
        if (!item.window.isDestroyed()) item.window.close();
    });
    app.on("before-quit", (event) => {
      if (exiting || !win || win.isDestroyed()) return;
      event.preventDefault();
      quitRequested = true;
      win.close();
    });
    if (process.platform === "win32") {
      const closeMcp = startWorkbenchPipe(dataDir, (name, args) => {
        if (restoringData) throw new Error("正在恢复工作台数据，请稍后重试");
        if (exiting) throw new Error("工作台正在退出，请稍后重试");
        const result = workbenchTools.call(name, args);
        if (name !== "find_entries") {
          if (result.module === "idea") reminders.refresh();
          changed(result.module === "prompt" ? "prompts" : "notes");
        }
        return result;
      }, (error) => {
        console.error("工作台接入服务启动失败", redact(errorText(error)));
      });
      app.once("quit", closeMcp);
    }
  });
  app.on("window-all-closed", () => {
    void reminders.stop().finally(() => {
      try {
        store.purgeDeleted();
      } catch {}
      store.close();
      app.quit();
    });
  });
}

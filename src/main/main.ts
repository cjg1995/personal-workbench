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
import { SubmitService } from "../core/submit.js";
import { ApkService } from "../core/apk.js";
import { BackupService } from "../core/backup.js";
import { ReviewService } from "../core/review.js";
import { ProjectService } from "../core/projects.js";
import { visibleClientWindows } from "../core/process.js";
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
if (process.platform === "win32") {
  app.setAppUserModelId(notificationAppId);
  app.setToastActivatorCLSID(notificationClsid);
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
      }, 120);
  };
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
      async (url) => {
        const parsed = new URL(url);
        if (!["http:", "https:"].includes(parsed.protocol))
          throw new Error("服务地址协议无效");
        await shell.openExternal(url);
      },
    );
  const backup = new BackupService(store, tasks, dataDir, async () => {
    if ((await projects.owned()).length)
      throw new Error(
        "仍有工作台拥有的项目进程，请先停止自有服务再恢复，以保留其停止与归属信息",
      );
  });
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
      icon: path.resolve(here, "../../assets/workbench.ico"),
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
  async function action(name: string, p: any = {}) {
    switch (name) {
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
            "submit-erp",
            "submit-app",
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
      case "import.preview": {
        const selected = await dialog.showOpenDialog(win, {
          defaultPath:
            p.kind === "idea"
              ? path.join(config.get().tools.documents, "todo.txt")
              : path.join(config.get().tools.documents, "temp.txt"),
          properties: ["openFile"],
          filters: [{ name: "文本", extensions: ["txt"] }],
        });
        if (selected.canceled) return null;
        return records.previewImport(
          selected.filePaths[0],
          p.kind,
          p.encoding || "auto",
        );
      }
      case "import.encoding": {
        const existing = records.previews.get(p.id);
        if (!existing) throw new Error("请先选择文件");
        return records.previewImport(existing.path, existing.kind, p.encoding);
      }
      case "import.commit": {
        const result = await records.import(p.id, p.selected, p.dates);
        changed();
        return result;
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
      case "monthly.copy": {
        const draft = records.draft(p.month, config.get().name);
        clipboard.writeText(records.monthlyText(draft));
        return { copied: true };
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
        if (
          (p.kind === "erp" &&
            !["homeproject", "homeproject-ai"].includes(project.id)) ||
          (p.kind === "app" && !project.android) ||
          !["app", "erp"].includes(p.kind)
        )
          throw new Error("提交类型与项目不符");
        return submit.check(project.path, p.kind);
      }
      case "git.erp": {
        const project = knownProject(p.projectId);
        if (!["homeproject", "homeproject-ai"].includes(project.id))
          throw new Error("不是 ERP 工作目录");
        return submit.startErp(
          project.id,
          project.path,
          p.message,
          p.fingerprint,
        );
      }
      case "git.app.prepare": {
        const project = knownProject(p.projectId);
        if (!project.android) throw new Error("不是受支持的 APP");
        return submit.prepareApp(project.id, project.path, p.fingerprint);
      }
      case "git.app.finish":
        return submit.finishApp(p.taskId, p.message);
      case "git.recoveries":
        return submit.recoveries(knownProject(p.projectId).path);
      case "git.recover-config": {
        const project = knownProject(p.projectId);
        if (
          !(await ask(
            "恢复本地配置保护",
            `工作目录：${project.path}\n恢复批次：${p.id}\n仅从对应备份恢复 store/index.js 和原 Git 标志。不会重复应用 stash、提交或推送。`,
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
        const url = await projects.url(knownProject(p.projectId).id);
        await shell.openExternal(url);
        return { url };
      }
      case "projects.folder":
        return openPath(knownProject(p.projectId).path);
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
        if (!run?.logPath || !fs.existsSync(run.logPath))
          throw new Error("没有工作台日志，请在原工具查看外部实例");
        const bytes = fs.readFileSync(run.logPath);
        return {
          text: redact(
            bytes
              .subarray(Math.max(0, bytes.length - 1024 * 1024))
              .toString("utf8"),
          ),
          path: run.logPath,
        };
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
          throw new Error("TAPD 客户端路径不存在，请修改配置");
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
            const existing = await visibleClientWindows(tools.tapd);
            if (!existing.length)
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
            let windows = existing;
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
              reused: existing.length > 0,
              message: "客户端已打开，导入结果请在原客户端核对",
            });
          });
        });
        return task;
      }
      case "tapd.documents":
        return openPath(config.get().tools.documents);
      case "tapd.help":
        return openPath(path.join(config.get().tools.tapdCwd, "使用说明.txt"));
      case "settings.check":
        return config.check();
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
    if (process.platform === "win32" && app.isPackaged) {
      const shortcuts = [
        path.join(
          app.getPath("appData"),
          "Microsoft/Windows/Start Menu/Programs/个人工作台.lnk",
        ),
        path.join(app.getPath("desktop"), "个人工作台.lnk"),
      ];
      for (const shortcut of shortcuts) {
        try {
          if (
            fs.existsSync(shortcut) &&
            shell.readShortcutLink(shortcut).appUserModelId ===
              notificationAppId
          )
            shell.writeShortcutLink(shortcut, "update", {
              target: shell.readShortcutLink(shortcut).target,
              appUserModelId: notificationAppId,
              toastActivatorClsid: notificationClsid,
            });
        } catch (error) {
          console.error("通知快捷方式更新失败：" + errorText(error));
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
      minWidth: Math.min(1050, workArea.width),
      minHeight: Math.min(680, workArea.height),
      frame: false,
      title: "个人工作台",
      backgroundColor: "#ffffff",
      icon: path.resolve(here, "../../assets/workbench.ico"),
      show: false,
      webPreferences: {
        preload: path.join(here, "../preload.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true,
      },
    });
    const entry = path.resolve(here, "../renderer/index.html");
    const allowed = pathToFileURL(entry).href;
    ipcMain.handle("workbench:action", async (event, name, payload) => {
      if (
        event.sender !== win.webContents ||
        event.senderFrame !== win.webContents.mainFrame ||
        event.senderFrame.url !== allowed
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
        return { ok: true, data: await action(name, payload) };
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
          const active = tasks.active(),
            owned = await projects.owned();
          if (!active.length && !owned.length) {
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
  });
  app.on("window-all-closed", () => {
    store.close();
    app.quit();
  });
}

import fs from "node:fs";
import path from "node:path";
import type { Task } from "../shared/types.js";
import { Store } from "./store.js";
import { ensureDir, errorText, id, now, redact } from "./util.js";
export class StopRequested extends Error {
  constructor() {
    super("已在命令边界停止；已完成的操作保留");
  }
}
export class TaskContext {
  constructor(
    public task: Task,
    private manager: TaskManager,
  ) {}
  save() {
    this.manager.save(this.task);
  }
  log(text: string) {
    fs.appendFileSync(this.task.logPath, redact(text) + "\n");
  }
  checkStop() {
    if (this.manager.stops.has(this.task.id)) throw new StopRequested();
  }
  async step<T>(
    name: string,
    fn: () => Promise<T>,
    honorStop = true,
  ): Promise<T> {
    if (honorStop) this.checkStop();
    let stage = this.task.stages.find((s) => s.name === name);
    if (!stage) {
      stage = { name, state: "pending" };
      this.task.stages.push(stage);
    }
    stage.state = "running";
    stage.startedAt = now();
    this.save();
    try {
      const result = await fn();
      stage.state = "done";
      stage.endedAt = now();
      this.save();
      return result;
    } catch (e) {
      stage.state = "failed";
      stage.endedAt = now();
      stage.detail = errorText(e);
      this.save();
      throw e;
    }
  }
  result(value: Record<string, unknown>) {
    this.task.result = { ...this.task.result, ...value };
    this.save();
  }
}
export class TaskManager {
  stops = new Set<string>();
  aborts = new Map<string, AbortController>();
  running = new Map<string, Promise<void>>();
  constructor(
    public store: Store,
    private dataDir: string,
    public changed: () => void = () => {},
    public finished: (task: Task) => void = () => {},
  ) {
    this.reconcileInterrupted();
  }
  reconcileInterrupted() {
    for (const task of this.list())
      if (["running", "cancelling", "awaiting"].includes(task.state)) {
        task.state = "interrupted";
        task.error =
          "上次运行已中断，须重新核实仓库、配置保护和进程状态；未自动重试";
        task.endedAt = now();
        for (const s of task.stages) {
          if (s.state === "running") s.state = "failed";
          else if (s.state === "pending") s.state = "skipped";
        }
        this.save(task);
      }
  }
  list() {
    return this.store.list<Task>("task");
  }
  get(taskId: string) {
    const t = this.store.get<Task>("task", taskId);
    if (!t) throw new Error("任务不存在");
    return t;
  }
  save(task: Task) {
    if (this.stops.has(task.id) && task.state === "running")
      task.state = "cancelling";
    this.store.set("task", task.id, task);
    this.changed();
  }
  active() {
    return this.list().filter((t) =>
      ["running", "cancelling", "awaiting"].includes(t.state),
    );
  }
  assertUnlocked(lockKey: string, except?: string) {
    const other = this.active().find(
      (t) => t.lockKey === lockKey && t.id !== except,
    );
    if (other) throw new Error(`已有写任务：${other.title}（${other.id}）`);
  }
  create(
    type: string,
    title: string,
    projectId: string | null,
    lockKey: string | null,
    params: Record<string, unknown>,
    stages: string[] = [],
  ) {
    if (lockKey) this.assertUnlocked(lockKey);
    const taskId = id();
    const logPath = path.join(
      ensureDir(path.join(this.dataDir, "logs", taskId)),
      "task.log",
    );
    fs.writeFileSync(logPath, "");
    const task: Task = {
      id: taskId,
      type,
      title,
      projectId,
      lockKey,
      params,
      state: "running",
      startedAt: now(),
      endedAt: null,
      logPath,
      error: null,
      result: {},
      stages: stages.map((name) => ({ name, state: "pending" })),
    };
    this.save(task);
    return task;
  }
  launch(
    task: Task,
    fn: (ctx: TaskContext) => Promise<"awaiting" | void>,
    onError?: (ctx: TaskContext) => Promise<void>,
  ) {
    const work = (async () => {
      const context = new TaskContext(task, this);
      try {
        const state = await fn(context);
        task.state = state === "awaiting" ? "awaiting" : "success";
        if (state !== "awaiting") task.endedAt = now();
      } catch (e) {
        if (onError) {
          try {
            await onError(context);
          } catch (diagnosticError) {
            context.log("状态探测未完成：" + errorText(diagnosticError));
          }
        }
        task.error = redact(errorText(e));
        task.state =
          e instanceof StopRequested || this.stops.has(task.id)
            ? "cancelled"
            : task.stages.some((s) => s.state === "done")
              ? "partial"
              : "failed";
        task.endedAt = now();
        fs.appendFileSync(task.logPath, task.error + "\n");
      } finally {
        for (const s of task.stages)
          if (s.state === "pending" && task.state !== "awaiting")
            s.state = "skipped";
        this.save(task);
        this.running.delete(task.id);
        this.aborts.delete(task.id);
        this.stops.delete(task.id);
        if (task.state !== "awaiting") {
          try {
            this.finished(task);
          } catch (error) {
            context.log("完成通知未发送：" + errorText(error));
          }
        }
      }
    })();
    this.running.set(task.id, work);
    return task;
  }
  cancel(taskId: string) {
    const t = this.get(taskId);
    if (t.state === "awaiting") {
      t.state = "cancelled";
      t.endedAt = now();
      t.error = "已取消后续提交；已完成的更新和本地恢复保留";
      for (const stage of t.stages)
        if (stage.state === "pending") stage.state = "skipped";
      this.save(t);
      return t;
    }
    if (!["running", "cancelling"].includes(t.state))
      throw new Error("任务已经结束");
    this.stops.add(taskId);
    this.aborts.get(taskId)?.abort();
    t.state = "cancelling";
    this.save(t);
    return t;
  }
  async wait(taskId: string) {
    await this.running.get(taskId);
    return this.get(taskId);
  }
  log(taskId: string) {
    const t = this.get(taskId);
    const data = fs.readFileSync(t.logPath);
    return {
      text: data
        .subarray(Math.max(0, data.length - 2 * 1024 * 1024))
        .toString("utf8"),
      truncated: data.length > 2 * 1024 * 1024,
      path: t.logPath,
    };
  }
}

import { reactive, ref } from "vue";
import type {
  Configuration,
  Note,
  Prompt,
  Task,
  RunInfo,
  UiDialogTone,
  WorkbenchApi,
} from "../shared/types";
import { openUiDialog, type OpenDialogOptions } from "./dialog";
import { formatDateTime } from "./format";
declare global {
  interface Window {
    workbench: WorkbenchApi;
    __workbenchCanClose?: () => Promise<boolean>;
  }
}
export const model = reactive<{
  config: Configuration | null;
  notes: Note[];
  prompts: Prompt[];
  tasks: Task[];
  runs: RunInfo[];
  dataDir: string;
  today: string;
  version: string;
  imports: any[];
  formDrafts: Record<string, any>;
}>({
  config: null,
  notes: [],
  prompts: [],
  tasks: [],
  runs: [],
  dataDir: "",
  today: "",
  version: "",
  imports: [],
  formDrafts: {},
});
export interface ToastAction {
  label: string;
  run: () => Promise<void> | void;
}
export interface ToastState {
  id: number;
  text: string;
  error: boolean;
  action?: ToastAction;
  onDismiss?: () => void;
  duration: number;
  countdown: boolean;
  remainingSeconds: number;
  paused: boolean;
}
export interface NotifyOptions {
  error?: boolean;
  action?: ToastAction;
  duration?: number;
  countdown?: boolean;
  onDismiss?: () => void;
}
export const route = ref("work"),
  context = ref<Record<string, any>>({});
export const toast = ref<ToastState | null>(null);
type LeaveGuard = (reason?: "navigate" | "close") => Promise<boolean>;
export let leaveGuard: LeaveGuard | null = null;
export const setGuard = (guard: LeaveGuard | null) => {
  leaveGuard = guard;
};
let toastSeq = 0;
let toastTimer: ReturnType<typeof setTimeout> | undefined;
let toastTick: ReturnType<typeof setInterval> | undefined;
let toastRemainingMs = 0;
let toastStartedAt = 0;
let toastPaused = false;

function clearToastTimers() {
  if (toastTimer) clearTimeout(toastTimer);
  if (toastTick) clearInterval(toastTick);
  toastTimer = undefined;
  toastTick = undefined;
}

function updateCountdownSeconds() {
  const current = toast.value;
  if (!current || !current.countdown || toastPaused) return;
  const remaining = Math.max(0, toastRemainingMs - (Date.now() - toastStartedAt));
  current.remainingSeconds = Math.max(1, Math.ceil(remaining / 1000));
}

function scheduleToastDismiss(duration: number) {
  clearToastTimers();
  const current = toast.value;
  if (!current || current.error || toastPaused) return;
  toastRemainingMs = Math.max(0, duration);
  toastStartedAt = Date.now();
  if (current.countdown) {
    current.remainingSeconds = Math.max(1, Math.ceil(toastRemainingMs / 1000));
    toastTick = setInterval(updateCountdownSeconds, 100);
  }
  toastTimer = setTimeout(() => {
    dismissToast(false);
  }, toastRemainingMs);
}

export function pauseToast() {
  if (toastPaused) return;
  toastPaused = true;
  if (toastTimer) {
    toastRemainingMs = Math.max(0, toastRemainingMs - (Date.now() - toastStartedAt));
  }
  clearToastTimers();
  if (toast.value) {
    toast.value.paused = true;
    if (toast.value.countdown) {
      toast.value.remainingSeconds = Math.max(1, Math.ceil(toastRemainingMs / 1000));
    }
  }
}

export function resumeToast() {
  if (!toastPaused) return;
  toastPaused = false;
  const current = toast.value;
  if (!current) return;
  current.paused = false;
  if (!current.error) {
    const nextMs = current.countdown
      ? Math.max(200, toastRemainingMs)
      : Math.min(toastRemainingMs || current.duration, 2500);
    scheduleToastDismiss(nextMs);
  }
}

export function dismissToast(skipOnDismiss = false) {
  clearToastTimers();
  toastPaused = false;
  toastRemainingMs = 0;
  const previous = toast.value;
  toast.value = null;
  if (!skipOnDismiss) previous?.onDismiss?.();
}

export function notify(text: string, errorOrOptions: boolean | NotifyOptions = false) {
  const opts: NotifyOptions =
    typeof errorOrOptions === "boolean"
      ? { error: errorOrOptions }
      : errorOrOptions;
  dismissToast(false);
  const error = !!opts.error;
  const duration = opts.duration ?? (opts.action ? 6500 : 4500);
  const countdown =
    !error &&
    (opts.countdown ??
      (!!opts.action && (!!opts.onDismiss || opts.action.label === "撤销")));
  toastPaused = false;
  toast.value = {
    id: ++toastSeq,
    text,
    error,
    action: opts.action,
    onDismiss: opts.onDismiss,
    duration,
    countdown,
    remainingSeconds: Math.max(1, Math.ceil(duration / 1000)),
    paused: false,
  };
  scheduleToastDismiss(duration);
}
export async function call<T = any>(
  action: string,
  payload?: unknown,
): Promise<T> {
  const plain =
    payload === undefined ? undefined : JSON.parse(JSON.stringify(payload));
  const response = await window.workbench.call<T>(action, plain);
  if (!response.ok) throw new Error(response.error || "操作失败");
  return response.data as T;
}
export async function attempt<T>(
  fn: () => Promise<T>,
  success?: string,
): Promise<T | undefined> {
  try {
    const result = await fn();
    if (success) notify(success);
    return result;
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), true);
    return undefined;
  }
}
let loadedRevision = -1, loadedDatabaseVersion = -1, reloadRequest = 0;
let lastAppliedRequest = 0;
export async function reload(notifiedRevision?: number) {
  if (notifiedRevision !== undefined && notifiedRevision <= loadedRevision) return;
  const request = ++reloadRequest;
  const { revision, databaseVersion, ...data } = await call("bootstrap", {
    revision: loadedRevision, databaseVersion: loadedDatabaseVersion,
  });
  if (request < lastAppliedRequest) return;
  lastAppliedRequest = request;
  loadedRevision = revision;
  loadedDatabaseVersion = databaseVersion;
  Object.assign(model, data);
}
export function saveForm(key: string, value: unknown) {
  model.formDrafts[key] = value;
  void attempt(() => call("form.save", { key, value }));
}
export async function navigate(page: string, params: Record<string, any> = {}) {
  if (leaveGuard && !(await leaveGuard("navigate"))) return;
  if (page === "submit") {
    page = "review";
    params = { ...params, submit: true };
  }
  route.value = page;
  context.value = params;
}
export const confirm = (
  title: string,
  message: string,
  button = "确认",
  options: { detail?: string; tone?: UiDialogTone; danger?: boolean } = {},
) => {
  const isDanger =
    options.danger ?? /删除|移除|丢弃|回滚|清空|覆盖/.test(button);
  const tone: UiDialogTone =
    options.tone ||
    (isDanger
      ? /删除|移除|回滚/.test(button)
        ? "danger"
        : "warning"
      : "question");
  return openUiDialog({
    tone,
    title,
    message,
    detail: options.detail,
    buttons: [
      { label: "取消", variant: "default" },
      { label: button, variant: isDanger ? "danger" : "primary" },
    ],
    defaultId: 0,
    cancelId: 0,
  }).then((idx) => idx === 1);
};
export const choose = (options: OpenDialogOptions) => openUiDialog(options);
export function dateLabel(value: string | null | undefined) {
  return formatDateTime(value);
}
export const taskLabels: Record<string, string> = {
  running: "执行中",
  awaiting: "待确认",
  cancelling: "正在安全停止",
  success: "已完成",
  partial: "部分完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断 / 待核实",
};
export const runLabels: Record<string, string> = {
  unconfigured: "需要配置",
  stopped: "未启动",
  starting: "启动中",
  running: "运行中",
  external: "外部运行中",
  stopping: "停止中",
  failed: "启动失败",
  unknown: "状态未知",
  "tool-open": "开发者工具已打开",
  watching: "编译监听中",
};
export const projectName = (projectId: string | null) =>
  model.config?.projects.find((p) => p.id === projectId)?.name || "";

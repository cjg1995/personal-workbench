import { reactive, ref } from "vue";
import type {
  Configuration,
  Note,
  Task,
  RunInfo,
  WorkbenchApi,
} from "../shared/types";
declare global {
  interface Window {
    workbench: WorkbenchApi;
    __workbenchCanClose?: () => Promise<boolean>;
  }
}
export const model = reactive<{
  config: Configuration | null;
  notes: Note[];
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
  tasks: [],
  runs: [],
  dataDir: "",
  today: "",
  version: "",
  imports: [],
  formDrafts: {},
});
export const route = ref("work"),
  context = ref<Record<string, any>>({});
export const toast = ref<{ text: string; error: boolean } | null>(null);
export const recordModal = ref<Partial<Note> | null>(null);
export let leaveGuard: (() => Promise<boolean>) | null = null;
export const setGuard = (guard: (() => Promise<boolean>) | null) => {
  leaveGuard = guard;
};
let toastTimer: ReturnType<typeof setTimeout> | undefined;
export function notify(text: string, error = false) {
  toast.value = { text, error };
  if (toastTimer) clearTimeout(toastTimer);
  if (!error) toastTimer = setTimeout(() => (toast.value = null), 4500);
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
export async function reload() {
  const data = await call<any>("bootstrap");
  Object.assign(model, data);
}
export function saveForm(key: string, value: unknown) {
  model.formDrafts[key] = value;
  void attempt(() => call("form.save", { key, value }));
}
export async function navigate(page: string, params: Record<string, any> = {}) {
  if (leaveGuard && !(await leaveGuard())) return;
  route.value = page;
  context.value = params;
}
export const confirm = (title: string, message: string, button = "确认") =>
  call<boolean>("ui.confirm", { title, message, confirm: button });
export function openRecord(preset: Partial<Note> = {}) {
  recordModal.value = {
    kind: "work",
    text: "",
    projectId: null,
    happenedOn: model.today,
    result: "",
    ...preset,
  };
}
export function dateLabel(value: string | null | undefined) {
  return value
    ? new Date(value).toLocaleString("zh-CN", {
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      })
    : "未指定";
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

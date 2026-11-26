import type { Note, Task } from "../shared/types.js";

export const notificationAppId = "local.personal.workbench";
export const notificationClsid = "{D9AE913B-30E9-472E-A050-937E5D41C0F8}";
const escapeXml = (value: string) =>
  value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\ufffe\uffff]/g, "").replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&apos;",
      })[c]!,
  );
function notificationOptions(title: string, body: string, activation: string) {
  return {
    title,
    body,
    toastXml: `<toast launch="${escapeXml(activation)}"><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(body)}</text></binding></visual></toast>`,
  };
}

export function taskActivation(taskId: string) {
  return "workbench:task:" + taskId;
}

export function notificationActivation(value: string) {
  const match =
    /^workbench:(task|todo):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      value,
    );
  return match ? { kind: match[1] === "task" ? "task" as const : "todo" as const, id: match[2] } : null;
}

export function activationTask(value: string) {
  const activation = notificationActivation(value);
  return activation?.kind === "task" ? activation.id : null;
}

export function todoNotification(note: Note & { dueAt: string }) {
  const summary = note.text.trim().split(/\r?\n/, 1)[0].slice(0, 160);
  const deadline = new Date(note.dueAt).toLocaleString("zh-CN", { dateStyle: "medium", timeStyle: "short" });
  return notificationOptions("待办到期", `${summary}\n截止时间 ${deadline}`, "workbench:todo:" + note.id);
}
export function projectNotification(task: Task) {
  if (!["run", "wechat"].includes(task.type) || !task.endedAt) return null;
  const labels: Record<string, string> = {
    success: "已完成",
    partial: "部分完成，请核对",
    failed: "失败",
    cancelled: "已取消",
  };
  if (!labels[task.state]) return null;
  const title = task.title + " · " + labels[task.state];
  const body = task.error
    ? "点击查看实际结果与错误日志。"
    : task.result.watching
      ? "编译成功，监听中。点击查看任务详情。"
      : task.result.clientOpened
        ? "开发者工具已打开。点击查看任务详情。"
        : "点击查看就绪状态、实际地址与任务详情。";
  return notificationOptions(title, body, taskActivation(task.id));
}

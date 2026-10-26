import type { Task } from "../shared/types.js";

export const notificationAppId = "local.personal.workbench";
export const notificationClsid = "{D9AE913B-30E9-472E-A050-937E5D41C0F8}";
const escapeXml = (value: string) =>
  value.replace(
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
export function taskActivation(taskId: string) {
  return "workbench:task:" + taskId;
}
export function activationTask(value: string) {
  const match =
    /^workbench:task:([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.exec(
      value,
    );
  return match?.[1] || null;
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
  return {
    title,
    body,
    toastXml: `<toast launch="${escapeXml(taskActivation(task.id))}"><visual><binding template="ToastGeneric"><text>${escapeXml(title)}</text><text>${escapeXml(body)}</text></binding></visual></toast>`,
  };
}

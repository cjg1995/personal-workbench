export function localDeadline(iso: string | null | undefined) {
  if (!iso) return "";
  const date = new Date(iso);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function deadlineFromInput(value: string) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime()) || localDeadline(date.toISOString()) !== value)
    throw new Error("请选择有效的截止时间");
  return date.toISOString();
}

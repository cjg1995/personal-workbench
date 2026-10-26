import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
export { default as redact } from "../shared/redact.cjs";
export const id = () => randomUUID();
export const now = () => new Date().toISOString();
export function localDate(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
export function atomicWrite(file: string, data: string | Uint8Array) {
  ensureDir(path.dirname(file));
  const tmp = `${file}.${id()}.tmp`;
  try {
    fs.writeFileSync(tmp, data, { flag: "wx" });
    fs.renameSync(tmp, file);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}
export function inside(root: string, file: string) {
  const rel = path.relative(path.resolve(root), path.resolve(file));
  return (
    rel === "" ||
    (!rel.startsWith(".." + path.sep) && rel !== ".." && !path.isAbsolute(rel))
  );
}
export function requireInside(root: string, file: string) {
  if (!inside(root, file)) throw new Error(`路径越界：${file}`);
  return path.resolve(file);
}
export function assertNoLinks(file: string) {
  let current = path.resolve(file);
  for (;;) {
    try {
      if (fs.lstatSync(current).isSymbolicLink())
        throw new Error(`拒绝链接路径：${current}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}
export function walk(dir: string): string[] {
  assertNoLinks(dir);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isSymbolicLink()) throw new Error(`拒绝链接文件：${p}`);
    return e.isDirectory() ? walk(p) : [p];
  });
}
export const errorText = (e: unknown) =>
  e instanceof Error ? e.message : String(e);
export function validateDate(value: unknown): string | null {
  if (value == null || value === "") return null;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    new Date(value + "T12:00:00Z").toISOString().slice(0, 10) !== value
  )
    throw new Error("发生日期无效");
  return value;
}
export function requireText(value: unknown, label = "内容", limit = 100000) {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${label}不能为空`);
  if (value.length > limit) throw new Error(`${label}过长`);
  return value;
}
export function readJson<T>(file: string): T {
  return JSON.parse(fs.readFileSync(file, "utf8")) as T;
}

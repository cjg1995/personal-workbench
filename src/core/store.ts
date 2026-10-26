import { DatabaseSync, backup } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";
import { ensureDir, now } from "./util.js";
export const buckets = [
  "note",
  "config",
  "task",
  "review",
  "monthly",
  "import",
  "run",
  "meta",
] as const;
export type Bucket = (typeof buckets)[number];
export class Store {
  db: DatabaseSync;
  constructor(public file: string) {
    ensureDir(path.dirname(file));
    this.db = new DatabaseSync(file);
    this.db.exec(
      `pragma journal_mode=WAL; pragma foreign_keys=on; pragma busy_timeout=5000;`,
    );
    const version = (
      this.db.prepare("pragma user_version").get() as { user_version: number }
    ).user_version;
    if (version > 1)
      throw new Error("数据库来自更新版本的工作台，请使用对应版本打开");
    if (version === 0)
      this.db.exec(`begin immediate;
      create table objects (kind text not null, id text not null, value text not null check(json_valid(value)), updated_at text not null, primary key(kind,id));
      pragma user_version=1; commit;`);
    this.assertHealthy();
  }
  get<T>(kind: Bucket, key: string): T | undefined {
    const row = this.db
      .prepare("select value from objects where kind=? and id=?")
      .get(kind, key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  list<T>(kind: Bucket): T[] {
    return (
      this.db
        .prepare(
          "select value from objects where kind=? order by updated_at desc, id",
        )
        .all(kind) as { value: string }[]
    ).map((r) => JSON.parse(r.value) as T);
  }
  set<T>(kind: Bucket, key: string, value: T) {
    this.db
      .prepare(
        "insert into objects(kind,id,value,updated_at) values(?,?,?,?) on conflict(kind,id) do update set value=excluded.value,updated_at=excluded.updated_at",
      )
      .run(kind, key, JSON.stringify(value), now());
    return value;
  }
  delete(kind: Bucket, key: string) {
    this.db.prepare("delete from objects where kind=? and id=?").run(kind, key);
  }
  transaction<T>(fn: () => T): T {
    this.db.exec("begin immediate");
    try {
      const result = fn();
      if (result instanceof Promise)
        throw new Error("数据库事务内不能执行异步操作");
      this.db.exec("commit");
      return result;
    } catch (e) {
      this.db.exec("rollback");
      throw e;
    }
  }
  assertHealthy() {
    const r = this.db.prepare("pragma quick_check").get() as {
      quick_check: string;
    };
    if (r.quick_check !== "ok")
      throw new Error("本地数据库校验失败，请从已核实的备份恢复");
  }
  async snapshot(file: string) {
    ensureDir(path.dirname(file));
    await backup(this.db, file);
  }
  close() {
    this.db.close();
  }
  reopen() {
    this.db = new DatabaseSync(this.file);
    try {
      this.db.exec("pragma journal_mode=WAL; pragma busy_timeout=5000;");
      this.assertHealthy();
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  counts() {
    return Object.fromEntries(buckets.map((b) => [b, this.list(b).length]));
  }
  static inspect(file: string) {
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const check = db.prepare("pragma quick_check").get() as {
        quick_check: string;
      };
      if (check.quick_check !== "ok") throw new Error("备份数据库损坏");
      const v = (
        db.prepare("pragma user_version").get() as { user_version: number }
      ).user_version;
      if (v !== 1) throw new Error("备份数据版本不支持");
      const rows = db.prepare("select kind,id,value from objects").all() as {
        kind: string;
        id: string;
        value: string;
      }[];
      for (const row of rows) {
        if (!buckets.includes(row.kind as Bucket))
          throw new Error("备份包含不支持的数据类型");
        const value = JSON.parse(row.value);
        if (!value || typeof value !== "object")
          throw new Error("备份记录格式不正确");
        if (
          row.kind === "note" &&
          (!["idea", "work"].includes(value.kind) ||
            typeof value.text !== "string" ||
            value.id !== row.id)
        )
          throw new Error("备份工作记录无效");
      }
      return {
        version: v,
        counts: Object.fromEntries(
          buckets.map((b) => [b, rows.filter((r) => r.kind === b).length]),
        ),
      };
    } finally {
      db.close();
    }
  }
}

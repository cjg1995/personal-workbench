import fs from "node:fs";
import path from "node:path";
import { zip, unzip, strFromU8, strToU8 } from "fflate";
import { Store } from "./store.js";
import { TaskManager } from "./tasks.js";
import {
  assertNoLinks,
  atomicWrite,
  ensureDir,
  hash,
  id,
  now,
  walk,
} from "./util.js";
interface Manifest {
  format: "personal-workbench";
  version: 1;
  createdAt: string;
  counts: Record<string, number>;
  files: Record<string, string>;
  referencesOnly: string[];
}
export class BackupService {
  private restoring = false;
  previews = new Map<string, { file: string; hash: string; createdAt: string }>();
  constructor(
    private store: Store,
    private tasks: TaskManager,
    private dataDir: string,
    private beforeRestore: () => Promise<void> = async () => {},
  ) {}
  private async withTemporaryDatabase<T>(work: (file: string) => Promise<T>) {
    const staging = ensureDir(path.join(this.dataDir, "staging"));
    const dir = await fs.promises.mkdtemp(path.join(staging, "backup-"));
    try {
      return await work(path.join(dir, "database.sqlite"));
    } finally {
      await fs.promises.rm(dir, { recursive: true, force: true });
    }
  }
  async create(destination: string) {
    const data: Record<string, Uint8Array> = {};
    const counts = await this.withTemporaryDatabase(async (database) => {
      await this.store.snapshot(database);
      if (fs.statSync(database).size > 128 * 1024 * 1024)
        throw new Error(
          "数据库超过当前 128 MB 备份恢复上限，未生成无法恢复的备份；原数据保持不变",
        );
      data["database.sqlite"] = await fs.promises.readFile(database);
      return Store.inspect(database).counts;
    });
    const snapshots = path.join(this.dataDir, "snapshots");
    for (const file of walk(snapshots)) {
      if (file.endsWith("before-import.sqlite")) continue;
      const rel = path.relative(snapshots, file).replaceAll("\\", "/");
      data["snapshots/" + rel] = fs.readFileSync(file);
    }
    const manifest: Manifest = {
      format: "personal-workbench",
      version: 1,
      createdAt: now(),
      counts,
      files: Object.fromEntries(
        Object.entries(data).map(([n, v]) => [n, hash(v)]),
      ),
      referencesOnly: [
        "Git 源码与仓库",
        "构建工程与 APK 产物",
        "任务日志",
        "外部工具及运行配置所引用的文件",
      ],
    };
    data["manifest.json"] = strToU8(JSON.stringify(manifest, null, 2));
    if (
      Object.values(data).reduce((n, value) => n + value.length, 0) >
      256 * 1024 * 1024
    )
      throw new Error("备份展开内容超过 256 MB，未生成备份；原数据保持不变");
    const archive = await new Promise<Uint8Array>((resolve, reject) => {
      zip(data, { level: 6 }, (error, bytes) => error ? reject(error) : resolve(bytes));
    });
    if (archive.length > 128 * 1024 * 1024)
      throw new Error("备份包超过当前 128 MB 恢复上限，未写入目标文件");
    atomicWrite(destination, archive);
    return {
      path: destination,
      bytes: fs.statSync(destination).size,
      manifest,
    };
  }
  private async readArchive(file: string, expectedHash?: string) {
    const bytes = await fs.promises.readFile(file);
    const fingerprint = hash(bytes);
    if (expectedHash && fingerprint !== expectedHash)
      throw new Error("备份文件在预览后已变化");
    if (bytes.length > 128 * 1024 * 1024)
      throw new Error("备份包超过 128 MB，拒绝加载");
    const entries = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
      unzip(bytes, {
        filter: (entry) => {
          if (entry.originalSize > 128 * 1024 * 1024)
            throw new Error("备份条目过大");
          return true;
        },
      }, (error, files) => error ? reject(error) : resolve(files));
    });
    if (
      Object.values(entries).reduce((n, v) => n + v.length, 0) >
      256 * 1024 * 1024
    )
      throw new Error("备份展开内容过大");
    if (!entries["manifest.json"] || !entries["database.sqlite"])
      throw new Error("不是有效的工作台备份");
    const manifest = JSON.parse(
      strFromU8(entries["manifest.json"]),
    ) as Manifest;
    if (
      manifest.format !== "personal-workbench" ||
      manifest.version !== 1 ||
      !manifest.files
    )
      throw new Error("备份格式或版本不支持");
    for (const [name, bytes] of Object.entries(entries)) {
      if (name === "manifest.json") continue;
      if (
        name !== "database.sqlite" &&
        !/^snapshots\/[a-f0-9-]+\/(source\.txt|source\.json)$/.test(name)
      )
        throw new Error("备份含不允许的路径：" + name);
      if (hash(bytes) !== manifest.files[name])
        throw new Error("备份文件校验失败：" + name);
    }
    for (const name of Object.keys(manifest.files))
      if (!entries[name]) throw new Error("备份缺少文件：" + name);
    return { entries, manifest, fingerprint };
  }
  async preview(file: string) {
    const { entries, manifest, fingerprint } = await this.readArchive(file);
    const counts = await this.withTemporaryDatabase(async (database) => {
      await fs.promises.writeFile(database, entries["database.sqlite"]);
      return Store.inspect(database).counts;
    });
    const token = id();
    this.previews.set(token, { file, hash: fingerprint, createdAt: manifest.createdAt });
    return {
      token,
      manifest,
      counts,
      currentCounts: this.store.counts(),
      snapshotCount: Object.keys(entries).filter((n) =>
        n.endsWith("/source.txt"),
      ).length,
      impact:
        "替换工作台内的记录、提示词、配置、月报和任务历史；先保留当前完整备份。源码、远端、APK 和原 TXT 不在替换范围。",
    };
  }
  async restore(token: string) {
    if (this.restoring) throw new Error("数据恢复正在进行，请勿重复操作");
    this.restoring = true;
    try {
      return await this.restoreData(token);
    } finally {
      this.restoring = false;
    }
  }
  private async assertRestoreReady() {
    await this.beforeRestore();
    if (this.tasks.active().length || this.tasks.running.size)
      throw new Error("仍有运行或待确认任务，先安全结束任务再恢复");
  }
  private async restoreData(token: string) {
    const preview = this.previews.get(token);
    if (!preview) throw new Error("恢复预览已失效");
    await this.assertRestoreReady();
    const { entries } = await this.readArchive(preview.file, preview.hash);
    const guard = path.join(
      ensureDir(path.join(this.dataDir, "backups")),
      `before-restore-${id()}.zip`,
    );
    await this.create(guard);
    await this.assertRestoreReady();
    const dir = ensureDir(path.join(this.dataDir, "staging", "restore-" + id()));
    const replacement = ensureDir(path.join(dir, "snapshots"));
    for (const [name, content] of Object.entries(entries))
      if (name.startsWith("snapshots/")) atomicWrite(path.join(dir, name), content);
    const currentSnapshots = path.join(this.dataDir, "snapshots"),
      oldSnapshots = path.join(dir, "previous-snapshots"),
      oldDb = path.join(dir, "previous.sqlite");
    assertNoLinks(currentSnapshots);
    assertNoLinks(this.store.file);
    this.store.db.exec("pragma wal_checkpoint(truncate)");
    this.store.close();
    let databaseMoved = false,
      snapshotsMoved = false,
      newSnapshotsMoved = false,
      newOpened = false;
    try {
      fs.renameSync(this.store.file, oldDb);
      databaseMoved = true;
      atomicWrite(this.store.file, entries["database.sqlite"]);
      if (fs.existsSync(currentSnapshots)) {
        fs.renameSync(currentSnapshots, oldSnapshots);
        snapshotsMoved = true;
      }
      fs.renameSync(replacement, currentSnapshots);
      newSnapshotsMoved = true;
      this.store.reopen();
      newOpened = true;
      this.tasks.reconcileInterrupted();
      this.previews.delete(token);
      return {
        restored: true,
        protectedBackup: guard,
        counts: this.store.counts(),
      };
    } catch (e) {
      if (newOpened) this.store.close();
      if (databaseMoved) {
        if (fs.existsSync(this.store.file)) fs.unlinkSync(this.store.file);
        fs.renameSync(oldDb, this.store.file);
      }
      if (fs.existsSync(currentSnapshots) && newSnapshotsMoved) {
        const failed = path.join(dir, "failed-snapshots");
        fs.renameSync(currentSnapshots, failed);
      }
      if (snapshotsMoved) fs.renameSync(oldSnapshots, currentSnapshots);
      this.store.reopen();
      throw new Error(
        `恢复失败，原数据已恢复；保护备份：${guard}。${e instanceof Error ? e.message : e}`,
      );
    }
  }
}

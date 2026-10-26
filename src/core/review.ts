import fs from "node:fs";
import path from "node:path";
import type {
  DiffScope,
  ReviewIssue,
  ReviewSnapshot,
} from "../shared/types.js";
import { Git } from "./git.js";
import { Store } from "./store.js";
import { RecordsService } from "./records.js";
import { id, now, requireText } from "./util.js";
import { Worker } from "node:worker_threads";
import type { ReviewCapture } from "./review-capture.js";
import { decodeOutput } from "./process.js";
import { hash, inside } from "./util.js";
interface Range {
  repo: string;
  scope: DiffScope;
  base?: string;
  target?: string;
  context?: number;
  fingerprintOnly?: boolean;
  lazyUntracked?: boolean;
  contentChecks?: Record<string, string>;
}
export class ReviewService {
  constructor(
    private git: Git,
    private store: Store,
    private records: RecordsService,
    private progress: (message: string) => void = () => {},
  ) {}
  private activeCapture?: { worker: Worker; cancel: Int32Array };
  cancel() {
    if (this.activeCapture) {
      Atomics.store(this.activeCapture.cancel, 0, 1);
      this.activeCapture.worker.postMessage("cancel");
    }
  }
  private capture(range: Range) {
    if (this.activeCapture) throw new Error("差异仍在读取或取消中，请稍候");
    return new Promise<Awaited<ReturnType<ReviewCapture["capture"]>>>(
      (resolve, reject) => {
        const cancel = new Int32Array(new SharedArrayBuffer(4));
        const worker = new Worker(
          new URL("./review-worker.js", import.meta.url),
          {
            workerData: {
              range,
              executable: this.git.executable,
              cancel: cancel.buffer,
            },
          },
        );
        this.activeCapture = { worker, cancel };
        let settled = false;
        const finish = (error?: Error, value?: any) => {
          if (settled) return;
          settled = true;
          this.activeCapture = undefined;
          this.progress("");
          if (Atomics.load(cancel, 0))
            reject(new Error("已取消差异读取，原审查记录保留"));
          else if (error) reject(error);
          else resolve(value);
        };
        worker.on("message", (message) => {
          if (message.progress) this.progress(message.progress);
          else if (message.error) finish(new Error(message.error));
          else if (message.result) finish(undefined, message.result);
        });
        worker.once("error", (error) => finish(error));
        worker.once("exit", (code) => {
          if (!settled)
            finish(new Error(`差异读取进程退出（${code}），请重试`));
        });
      },
    );
  }
  async open(projectId: string, range: Range, previousId?: string) {
    const versions = ["versions", "ancestor"].includes(range.scope);
    const suppliedPrevious = previousId
      ? this.get(previousId)
      : this.latest(
          range.repo,
          range.scope,
          versions
            ? range.base || "HEAD"
            : range.scope === "unstaged"
              ? "暂存区"
              : "HEAD",
          versions
            ? range.target || "HEAD"
            : range.scope === "staged"
              ? "暂存区"
              : "工作区",
        );
    const { contentChanged, ...captured } = await this.capture({
      ...range,
      lazyUntracked: true,
      contentChecks: this.contentChecks(suppliedPrevious),
    });
    let previous = suppliedPrevious;
    if (
      previous &&
      (previous.repo !== range.repo ||
        previous.scope !== captured.scope ||
        previous.base !== captured.base ||
        previous.target !== captured.target)
    )
      previous = undefined;
    if (previous?.fingerprint === captured.fingerprint && !contentChanged) {
      const loaded = new Map(
        previous.files.filter((f) => f.contentHash).map((f) => [f.path, f]),
      );
      previous.files = captured.files.map((f) =>
        f.deferred && loaded.get(f.path)?.hash === f.hash
          ? loaded.get(f.path)!
          : f,
      );
      this.store.set("review", previous.id, previous);
      return previous;
    }
    const common = await this.git.commonDir(range.repo);
    const snapshot: ReviewSnapshot = {
      id: id(),
      projectId,
      repo: range.repo,
      ...captured,
      createdAt: now(),
      seen: {},
      issues: previous?.issues.map((i) => ({ ...i })) || [],
      conclusion: null,
      summary: "",
      stale: !!previous,
      fetchedAt:
        this.store.get<{ at: string }>("meta", "fetch:" + common)?.at || null,
    };
    this.store.set("review", snapshot.id, snapshot);
    return snapshot;
  }
  history(projectId: string | null = null, offset = 0) {
    if (!Number.isInteger(offset) || offset < 0)
      throw new Error("历史分页无效");
    return this.store.db
      .prepare(
        `select id, json_extract(value, '$.projectId') as projectId, json_extract(value, '$.createdAt') as createdAt, json_extract(value, '$.scope') as scope, json_extract(value, '$.conclusion') as conclusion, json_array_length(value, '$.files') as fileCount from objects where kind='review' and (? is null or json_extract(value, '$.projectId')=?) order by updated_at desc, id limit 200 offset ?`,
      )
      .all(projectId, projectId, offset);
  }
  private latest(repo: string, scope: string, base: string, target: string) {
    const row = this.store.db
      .prepare(
        `select id from objects where kind='review' and json_extract(value, '$.repo')=? and json_extract(value, '$.scope')=? and json_extract(value, '$.base')=? and json_extract(value, '$.target')=? order by updated_at desc, id limit 1`,
      )
      .get(repo, scope, base, target) as { id: string } | undefined;
    return row ? this.get(row.id) : undefined;
  }
  get(snapshotId: string) {
    const snapshot = this.store.get<ReviewSnapshot>("review", snapshotId);
    if (!snapshot) throw new Error("审查记录不存在");
    return snapshot;
  }
  private contentChecks(snapshot?: ReviewSnapshot) {
    return Object.fromEntries(
      (snapshot?.files || [])
        .filter((f) => f.deferred && f.contentHash)
        .map((f) => [f.path, f.contentHash!]),
    );
  }
  async fileContent(snapshotId: string, file: string) {
    const snapshot = this.get(snapshotId),
      original = snapshot.files.find((f) => f.path === file);
    if (!original) throw new Error("文件不在审查范围内");
    if (!original.deferred || original.contentHash || original.limited)
      return original;
    const target = path.resolve(snapshot.repo, file);
    if (!inside(snapshot.repo, target)) throw new Error("文件路径越界");
    const identity = async () => {
      const stat = await fs.promises.lstat(target);
      return hash(
        JSON.stringify({
          old: "absent",
          new: `metadata:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
          status: original.status,
          oldPath: original.oldPath,
        }),
      );
    };
    if ((await identity()) !== original.hash)
      throw new Error("文件已变化，请刷新差异后再读取");
    const bytes = await fs.promises.readFile(target);
    if ((await identity()) !== original.hash)
      throw new Error("读取期间文件已变化，请刷新差异");
    const current = this.get(snapshotId),
      index = current.files.findIndex(
        (f) => f.path === file && f.hash === original.hash,
      );
    if (index < 0) throw new Error("审查快照已刷新，请重新选择文件");
    const value = {
      ...current.files[index],
      contentHash: hash(bytes),
      binary: bytes.includes(0),
    };
    value.newText = value.binary ? "" : decodeOutput(bytes);
    value.patch = value.binary
      ? ""
      : `--- /dev/null\n+++ ${file}\n@@ -0,0 +1,${value.newText.split("\n").length} @@\n` +
        value.newText
          .split("\n")
          .map((line) => "+" + line)
          .join("\n");
    const used = current.files
      .filter((_, i) => i !== index)
      .reduce(
        (n, f) =>
          n +
          Buffer.byteLength(f.oldText) +
          Buffer.byteLength(f.newText) +
          Buffer.byteLength(f.patch),
        0,
      );
    if (
      used + Buffer.byteLength(value.newText) + Buffer.byteLength(value.patch) >
      16 * 1024 * 1024
    ) {
      value.limited = true;
      value.newText = "";
      value.patch = "";
    }
    current.files[index] = value;
    this.store.set("review", current.id, current);
    return value;
  }
  async validate(snapshotId: string) {
    const snapshot = this.get(snapshotId);
    const current = await this.capture({
      repo: snapshot.repo,
      scope: snapshot.scope,
      base: snapshot.base,
      target: snapshot.target,
      fingerprintOnly: true,
      lazyUntracked: snapshot.lazyUntracked,
      contentChecks: this.contentChecks(snapshot),
    });
    const changed =
      current.fingerprint !== snapshot.fingerprint || current.contentChanged;
    if (changed) {
      snapshot.stale = true;
      snapshot.seen = {};
      this.store.set("review", snapshot.id, snapshot);
    }
    return { changed, snapshot };
  }
  async seen(snapshotId: string, file: string, viewed: boolean) {
    const { changed, snapshot } = await this.validate(snapshotId);
    if (changed) throw new Error("代码已变化，需要刷新差异后复查");
    const f = snapshot.files.find((f) => f.path === file);
    if (!f) throw new Error("文件不在本次范围内");
    if (f.deferred && !f.contentHash)
      throw new Error("请先读取此文件正文再标记已看");
    if (viewed) snapshot.seen[file] = f.hash;
    else delete snapshot.seen[file];
    return this.store.set("review", snapshot.id, snapshot);
  }
  issue(
    snapshotId: string,
    input: {
      file: string;
      side: "old" | "new";
      line: number | null;
      text: string;
    },
  ) {
    const snapshot = this.get(snapshotId);
    const file = snapshot.files.find((f) => f.path === input.file);
    if (!file) throw new Error("文件不在本次差异内");
    if (input.line !== null && file.deferred && !file.contentHash)
      throw new Error("请先读取文件正文再添加行号意见");
    requireText(input.text, "审查意见");
    if (!["old", "new"].includes(input.side)) throw new Error("版本侧无效");
    if (
      input.line !== null &&
      (!Number.isInteger(input.line) ||
        input.line < 1 ||
        input.line >
          (input.side === "old" ? file.oldText : file.newText).split("\n")
            .length)
    )
      throw new Error("行号不在选定版本内");
    snapshot.issues.push({
      id: id(),
      file: input.file,
      side: input.side,
      line: input.line,
      text: input.text,
      state: "open",
      reason: "",
      snapshotHash: file.hash,
    });
    this.store.set("review", snapshot.id, snapshot);
    return snapshot;
  }
  updateIssue(
    snapshotId: string,
    issueId: string,
    state: ReviewIssue["state"],
    reason: string,
  ) {
    const s = this.get(snapshotId);
    const i = s.issues.find((i) => i.id === issueId);
    if (!i || !["open", "fixed", "resolved", "declined"].includes(state))
      throw new Error("问题状态无效");
    if (state === "declined") requireText(reason, "不采纳原因");
    i.state = state;
    i.reason = reason;
    return this.store.set("review", s.id, s);
  }
  todo(snapshotId: string, issueId: string) {
    const s = this.get(snapshotId),
      issue = s.issues.find((i) => i.id === issueId);
    if (!issue) throw new Error("审查问题不存在");
    if (issue.todoId) return this.records.get(issue.todoId);
    const note = this.records.save({
      kind: "idea",
      text: issue.text,
      projectId: s.projectId,
      sourceId: `review:${s.id}:${issue.id}`,
    });
    issue.todoId = note.id;
    this.store.set("review", s.id, s);
    return note;
  }
  async conclude(snapshotId: string, conclusion: string, summary: string) {
    if (!["已完成", "仍有待处理项"].includes(conclusion))
      throw new Error("请选择人工结论");
    const { snapshot, changed } = await this.validate(snapshotId);
    if (changed) throw new Error("代码已变化，先刷新并复查后结束审查");
    snapshot.conclusion = conclusion;
    snapshot.summary = summary;
    return this.store.set("review", snapshot.id, snapshot);
  }
  copy(snapshotId: string) {
    const s = this.get(snapshotId);
    return [
      `人工审查：${s.repo}`,
      `范围：${s.scope} ${s.base} → ${s.target}`,
      `提交：${s.baseCommit} → ${s.targetCommit}`,
      `结论：${s.conclusion || "尚未选择"}`,
      ...s.issues.map(
        (i) =>
          `${i.file}${i.line ? " " + (i.side === "old" ? "旧" : "新") + " L" + i.line : ""} [${i.state}] ${i.text}${i.reason ? "；原因：" + i.reason : ""}`,
      ),
      s.summary,
    ].join("\n");
  }
  async fetch(repo: string) {
    await this.git.run(repo, ["fetch", "origin"]);
    const common = await this.git.commonDir(repo);
    this.store.set("meta", "fetch:" + common, { at: now() });
    return { at: now() };
  }
  rules(repo: string, fallback?: string) {
    const candidates = [path.join(repo, "AGENTS.md")];
    const dir = path.join(repo, ".cursor", "rules");
    if (fs.existsSync(dir))
      for (const file of fs.readdirSync(dir))
        if (file.endsWith(".mdc") || file.endsWith(".md"))
          candidates.push(path.join(dir, file));
    if (fallback && !candidates.some((f) => f.endsWith(".mdc")))
      candidates.push(fallback);
    return candidates
      .filter((f) => fs.existsSync(f))
      .map((file) => ({ path: file, text: fs.readFileSync(file, "utf8") }));
  }
}

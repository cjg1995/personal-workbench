import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Git, inTrackedDirectory, trackedDirectoryTree } from "./git.js";
import { gitOperationLabel } from "../shared/git-labels.js";
import type { TaskManager } from "./tasks.js";
import { hash, inside, redact } from "./util.js";
import type {
  ChangeFile,
  ConflictContent,
  FileComparison,
  GitBranch,
  GitCommit,
  GitComparison,
  GitStash,
  RepositoryState,
} from "../shared/git-client.js";

const maxContent = 4 * 1024 * 1024;
const literal = (file: string) => `:(literal)${file}`;
const cleanOutput = (value: string) => redact(value).slice(-48000);
interface Snapshot {
  repo: string;
  file: string;
  comparison: GitComparison;
  fingerprint: string;
  patch: string;
  hunks: string[];
  canPatch: boolean;
  editable: boolean;
  revertPatch?: string;
  revertHunks?: string[];
  conflict?: boolean;
  at: number;
}
interface Content {
  text: string;
  bytes: Buffer;
  binary: boolean;
  limited: boolean;
  encoding: string;
  mode: string;
}
export class GitClientService {
  private snapshots = new Map<string, Snapshot>();
  private queues = new Map<string, Promise<unknown>>();
  private versionFiles = new Map<string, ChangeFile[]>();
  constructor(
    private git: Git,
    private tasks: TaskManager,
    private dataDir: string,
    private untrackedPaths?: (repo: string) => string[] | undefined,
  ) {}

  private async head(repo: string) {
    const result = await this.git.run(repo, ["rev-parse", "--verify", "HEAD"], {
      allowFailure: true,
    });
    return result.code ? "" : result.stdout.trim();
  }
  private async emptyTree(repo: string) {
    return this.git.text(repo, ["hash-object", "-t", "tree", "--stdin"], {
      input: Buffer.alloc(0),
    });
  }
  private async ref(repo: string, ref: unknown) {
    if (
      typeof ref !== "string" ||
      !ref ||
      ref.length > 1024 ||
      ref.startsWith("-") ||
      /[\0\r\n]/.test(ref)
    )
      throw new Error("版本引用无效");
    return this.git.text(repo, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${ref}^{commit}`,
    ]);
  }
  private async filePath(repo: string, file: unknown, writable = false) {
    if (
      typeof file !== "string" ||
      !file ||
      /[\0\r\n]/.test(file) ||
      file
        .split(/[\\/]/)
        .some((v) => v.toLowerCase() === ".git" || v === "..") ||
      path.isAbsolute(file)
    )
      throw new Error("文件路径无效");
    const target = path.resolve(repo, file);
    if (!inside(repo, target) || target === path.resolve(repo))
      throw new Error("文件路径越界");
    // Never follow a working-tree symlink or a junction into another directory.
    let current = path.resolve(repo);
    for (const part of path.relative(repo, target).split(path.sep)) {
      current = path.join(current, part);
      try {
        const stat = await fs.promises.lstat(current);
        if (stat.isSymbolicLink())
          throw new Error(
            "符号链接仅支持 Git 整文件暂存操作，不能读取或覆盖其目标",
          );
        if (writable && current === target && !stat.isFile())
          throw new Error("只允许修改普通文件");
      } catch (error: any) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    return target;
  }
  private async selected(repo: string, value: unknown) {
    if (!Array.isArray(value) || !value.length || value.length > 50000)
      throw new Error("请明确选择文件");
    const files = [...new Set(value)] as string[];
    const parents = new Set<string>();
    for (const file of files) {
      // Staging a symlink itself is safe. Validate the parent but do not follow the leaf.
      if (
        typeof file !== "string" ||
        !file ||
        file.includes("\0") ||
        path.isAbsolute(file) ||
        file
          .split(/[\\/]/)
          .some((p) => p.toLowerCase() === ".git" || p === "..")
      )
        throw new Error("文件路径无效");
      const parent = path.dirname(file);
      if (parent !== "." && !parents.has(parent)) {
        await this.filePath(repo, parent + "/__git_path_check__");
        parents.add(parent);
      }
    }
    const status = await this.status(repo);
    const changed = new Set(
      status.files.flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]),
    );
    if (files.some((f) => !changed.has(f)))
      throw new Error("文件状态已变化，请刷新后重新选择");
    return files;
  }
  private async changedFiles(
    repo: string,
    file?: string,
  ): Promise<ChangeFile[]> {
    if (file) await this.filePath(repo, file);
    const raw = await this.git.run(repo, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--renames",
      ...(file ? ["--", literal(file)] : []),
    ]);
    const tokens = raw.stdout.split("\0"),
      files: ChangeFile[] = [];
    for (let i = 0; i < tokens.length; i++) {
      if (!tokens[i]) continue;
      const x = tokens[i][0],
        y = tokens[i][1],
        name = tokens[i].slice(3);
      const oldPath = /[RC]/.test(x + y) ? tokens[++i] : undefined;
      files.push({
        path: name,
        oldPath,
        status: (x + y).trim(),
        x,
        y,
        staged: x !== " " && x !== "?",
        unstaged: y !== " ",
        conflicted: x === "U" || y === "U" || ["AA", "DD"].includes(x + y),
        untracked: x === "?",
      });
    }
    if (files.some((file) => file.untracked)) {
      const allowed = this.untrackedPaths?.(repo);
      const trackedPaths = allowed ? [] : await this.git.paths(repo, [
        "ls-files",
        "--cached",
        "-z",
      ]);
      // Git tracks files, so build the existing tree from every indexed path,
      // including unchanged files. Explicit project scopes take precedence.
      const trackedDirectories = trackedDirectoryTree(trackedPaths);
      for (const file of files)
        if (file.untracked)
          file.inTrackedDirectory = allowed
            ? allowed.some((entry) => entry.endsWith("/")
                ? file.path.startsWith(entry) : file.path === entry)
            : inTrackedDirectory(file.path, trackedDirectories);
    }
    return files;
  }
  async status(repo: string): Promise<RepositoryState> {
    const [files, branch, head, operations, upstreamResult, remotes] =
      await Promise.all([
        this.changedFiles(repo),
        this.git.text(repo, ["branch", "--show-current"]),
        this.head(repo),
        this.git.operation(repo),
        this.git.run(
          repo,
          ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
          { allowFailure: true },
        ),
        this.git.text(repo, ["remote"]),
      ]);
    const upstream = upstreamResult.code ? "" : upstreamResult.stdout.trim();
    let ahead = 0,
      behind = 0;
    if (head && upstream) {
      const counts = await this.git.run(
        repo,
        ["rev-list", "--left-right", "--count", `HEAD...${upstream}`],
        { allowFailure: true },
      );
      if (!counts.code)
        [ahead, behind] = counts.stdout.trim().split(/\s+/).map(Number);
    }
    let operation: RepositoryState["operation"] = "";
    if (operations.some((s) => s.startsWith("rebase-"))) operation = "rebase";
    else if (operations.includes("MERGE_HEAD")) operation = "merge";
    else if (operations.includes("CHERRY_PICK_HEAD")) operation = "cherry-pick";
    else if (operations.includes("REVERT_HEAD")) operation = "revert";
    else if (operations.includes("sequencer")) operation = "sequencer";
    return {
      branch,
      head,
      upstream,
      ahead,
      behind,
      operation,
      detached: !branch && !!head,
      files,
      remotes: remotes.split(/\r?\n/).filter(Boolean),
      locked: operations.includes("index.lock"),
    };
  }
  private async resolvedComparison(repo: string, c: GitComparison) {
    if (
      !["local", "staged", "unstaged", "versions", "history"].includes(c.mode)
    )
      throw new Error("比较模式无效");
    if (c.mode === "versions")
      return {
        base:
          c.base === "__empty__"
            ? await this.emptyTree(repo)
            : await this.ref(repo, c.base),
        target: await this.ref(repo, c.target),
      };
    if (c.mode === "history")
      return { base: await this.ref(repo, c.base), target: "" };
    return {
      base: (await this.head(repo)) || (await this.emptyTree(repo)),
      target: "",
    };
  }
  private diffArgs(c: GitComparison, refs: { base: string; target: string }) {
    return c.mode === "staged"
      ? ["--cached", refs.base]
      : ["local", "history"].includes(c.mode)
        ? [refs.base]
        : c.mode === "versions"
          ? [refs.base, refs.target]
          : [];
  }
  async files(repo: string, c: GitComparison): Promise<ChangeFile[]> {
    if (!["versions", "history"].includes(c.mode)) {
      const files = await this.changedFiles(repo, c.file);
      return files.filter(
        (f) =>
          (!c.file || f.path === c.file) &&
          (c.mode === "staged"
            ? f.staged
            : c.mode === "unstaged"
              ? f.unstaged
              : true),
      );
    }
    const refs = await this.resolvedComparison(repo, c);
    const key = repo + ":" + refs.base + ":" + refs.target,
      cached = this.versionFiles.get(key);
    if (cached && c.mode === "versions")
      return c.file ? cached.filter((f) => f.path === c.file) : cached;
    const raw = await this.git.run(repo, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-status",
      "-z",
      "--find-renames",
      ...this.diffArgs(c, refs),
    ]);
    const tokens = raw.stdout.split("\0"),
      files: ChangeFile[] = [];
    for (let i = 0; i < tokens.length && tokens[i]; ) {
      const status = tokens[i++];
      let file = tokens[i++],
        oldPath: string | undefined;
      if (/^[RC]/.test(status)) {
        oldPath = file;
        file = tokens[i++];
      }
      files.push({
        path: file,
        oldPath,
        status,
        x: " ",
        y: " ",
        staged: false,
        unstaged: false,
        untracked: false,
        conflicted: false,
      });
    }
    if (c.mode === "versions") {
      if (this.versionFiles.size >= 8)
        this.versionFiles.delete(this.versionFiles.keys().next().value!);
      this.versionFiles.set(key, files);
    } else {
      for (const file of await this.changedFiles(repo, c.file))
        if (file.untracked && !files.some((f) => f.path === file.path))
          files.push(file);
    }
    return c.file ? files.filter((f) => f.path === c.file) : files;
  }
  private decode(bytes: Buffer, mode = "100644", limited = false): Content {
    let text = "",
      encoding = "UTF-8",
      binary = bytes.includes(0) || mode === "120000" || mode === "160000";
    if (!binary && !limited) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        text = new TextDecoder("gb18030").decode(bytes);
        encoding = "GB18030（只读）";
      }
    }
    return { text, bytes, binary, limited, encoding, mode };
  }
  private async blob(repo: string, spec: string): Promise<Content> {
    const info = await this.git.run(repo, ["cat-file", "-s", spec], {
      allowFailure: true,
    });
    if (info.code) return this.decode(Buffer.alloc(0));
    if (Number(info.stdout) > maxContent)
      return this.decode(Buffer.alloc(0), "100644", true);
    const result = await this.git.run(repo, ["cat-file", "blob", spec], {
      raw: true,
      maxBytes: maxContent,
    });
    return this.decode(result.stdoutBytes!);
  }
  private async work(repo: string, file: string): Promise<Content> {
    const target = await this.filePath(repo, file);
    try {
      const st = await fs.promises.lstat(target);
      if (!st.isFile()) return this.decode(Buffer.alloc(0), "160000");
      if (st.size > maxContent)
        return this.decode(Buffer.alloc(0), "100644", true);
      return this.decode(await fs.promises.readFile(target));
    } catch (error: any) {
      if (error.code === "ENOENT") return this.decode(Buffer.alloc(0));
      throw error;
    }
  }
  private async workIdentity(repo: string, file: string) {
    const target = await this.filePath(repo, file);
    let content = "absent";
    try {
      const st = await fs.promises.lstat(target);
      content =
        st.isFile() && st.size <= maxContent
          ? hash(await fs.promises.readFile(target))
          : `${st.size}:${st.mtimeMs}:${st.mode}`;
    } catch (error: any) {
      if (error.code !== "ENOENT") throw error;
    }
    return content;
  }
  private async identity(repo: string, file: string) {
    const [head, index, content] = await Promise.all([
      this.head(repo),
      this.git.text(repo, ["ls-files", "--stage", "-z", "--", literal(file)]),
      this.workIdentity(repo, file),
    ]);
    return hash(JSON.stringify({ head, index, content }));
  }
  private remember(snapshot: Snapshot) {
    for (const [key, value] of this.snapshots)
      if (Date.now() - value.at > 60 * 60 * 1000) this.snapshots.delete(key);
    while (this.snapshots.size >= 24)
      this.snapshots.delete(this.snapshots.keys().next().value!);
    const token = randomUUID();
    this.snapshots.set(token, snapshot);
    return token;
  }
  private async checked(repo: string, token: string, conflict = false) {
    const snapshot = this.snapshots.get(token);
    if (
      !snapshot ||
      snapshot.repo !== repo ||
      !!snapshot.conflict !== conflict ||
      Date.now() - snapshot.at > 60 * 60 * 1000
    )
      throw new Error("对比已过期，请重新读取文件");
    if (snapshot.fingerprint !== (await this.identity(repo, snapshot.file)))
      throw new Error("文件、HEAD 或暂存区已被外部修改，请刷新；未覆盖新内容");
    return snapshot;
  }
  async validateToken(repo: string, token: string, conflict = false) {
    await this.checked(repo, token, conflict);
    return true;
  }
  async tokenFile(repo: string, token: string, conflict = false) {
    return (await this.checked(repo, token, conflict)).file;
  }
  release(repo: string) {
    for (const [token, snapshot] of this.snapshots)
      if (snapshot.repo === repo) this.snapshots.delete(token);
    for (const key of this.versionFiles.keys())
      if (key.startsWith(repo + ":")) this.versionFiles.delete(key);
  }
  async rollbackPreview(repo: string, files: unknown) {
    const selected = await this.selected(repo, files);
    return this.rollbackIdentity(repo, selected);
  }
  private async rollbackIdentity(repo: string, files: string[]) {
    const [head, index] = await Promise.all([
      this.head(repo),
      this.git.text(repo, ["ls-files", "--stage", "-z"]),
    ]);
    const content: Record<string, string> = {};
    for (let start = 0; start < files.length; start += 16)
      await Promise.all(
        files
          .slice(start, start + 16)
          .map(
            async (file) =>
              (content[file] = await this.workIdentity(repo, file)),
          ),
      );
    return { head, index: hash(index), files: content };
  }
  async upstreamTarget(repo: string) {
    const state = await this.status(repo);
    if (!state.branch || !state.upstream)
      throw new Error("当前分支尚未配置上游分支");
    const remote = await this.git.text(repo, [
      "config",
      "--get",
      `branch.${state.branch}.remote`,
    ]);
    const merge = await this.git.text(repo, [
      "config",
      "--get",
      `branch.${state.branch}.merge`,
    ]);
    if (
      !state.remotes.includes(remote) ||
      remote.startsWith("-") ||
      !merge.startsWith("refs/heads/")
    )
      throw new Error("上游分支不是可推送的远程分支，请使用 Push 面板");
    return { remote, branch: merge.slice(11), upstream: state.upstream };
  }
  async content(
    repo: string,
    c: GitComparison,
    file: string,
  ): Promise<FileComparison> {
    await this.filePath(repo, file);
    const before = await this.identity(repo, file),
      refs = await this.resolvedComparison(repo, c);
    // Rename source is resolved by Git, never inferred from a file name.
    const rename = (
      await this.files(repo, {
        ...c,
        base: c.base === "__empty__" ? "__empty__" : refs.base,
        target: refs.target,
        file,
      })
    ).find((f) => f.path === file);
    if (!rename) throw new Error("文件不在当前比较中，请刷新文件列表");
    // A path-limited status hides rename sources. Only additions need the
    // global tracked rename metadata; normal file switches remain path-limited.
    if (rename.x === "A" && ["local", "staged"].includes(c.mode)) {
      const names = (
        await this.git.run(repo, [
          "diff",
          "--cached",
          "--no-ext-diff",
          "--no-textconv",
          "--name-status",
          "-z",
          "--find-renames",
        ])
      ).stdout.split("\0");
      for (let i = 0; i < names.length && names[i]; ) {
        const status = names[i++],
          old = names[i++];
        if (/^[RC]/.test(status)) {
          const next = names[i++];
          if (next === file) {
            rename.oldPath = old;
            rename.status = status;
            break;
          }
        }
      }
    }
    const oldPath = rename.oldPath || file;
    const old =
      c.mode === "unstaged"
        ? await this.blob(repo, `:${file}`)
        : await this.blob(repo, `${refs.base}:${oldPath}`);
    const next =
      c.mode === "staged"
        ? await this.blob(repo, `:${file}`)
        : c.mode === "versions"
          ? await this.blob(repo, `${refs.target}:${file}`)
          : await this.work(repo, file);
    const binary = old.binary || next.binary,
      limited = old.limited || next.limited;
    const patch =
      !binary &&
      !limited &&
      ["staged", "unstaged"].includes(c.mode) &&
      !rename.untracked &&
      !rename.conflicted
        ? (
            await this.git.run(
              repo,
              [
                "diff",
                "--no-ext-diff",
                "--no-textconv",
                "--no-color",
                "--no-renames",
                "--full-index",
                "--unified=3",
                ...this.diffArgs(c, refs),
                "--",
                literal(file),
              ],
              { maxBytes: 8 * 1024 * 1024 },
            )
          ).stdout
        : "";
    const start = patch.indexOf("\n@@ ");
    const header = start < 0 ? "" : patch.slice(0, start + 1);
    const hunks =
      start < 0
        ? []
        : patch
            .slice(start + 1)
            .split(/(?=^@@ )/m)
            .filter((v) => v.startsWith("@@ "));
    const canPatch =
      ["staged", "unstaged"].includes(c.mode) &&
      !binary &&
      !limited &&
      !rename.oldPath &&
      !rename.conflicted &&
      !rename.untracked &&
      !/^(new file|deleted file|old mode|new mode|similarity|rename )/m.test(
        patch,
      ) &&
      old.encoding === "UTF-8" &&
      next.encoding === "UTF-8" &&
      hunks.length > 0;
    // Zero-context hunks keep neighbouring changes independent. Full-file
    // fingerprints and Git's own apply checks guard their exact line positions.
    let revertPatch = "",
      revertHunks: string[] = [];
    if (
      ["local", "unstaged"].includes(c.mode) &&
      !binary &&
      !limited &&
      !rename.oldPath &&
      !rename.conflicted &&
      !rename.untracked &&
      old.encoding === "UTF-8" &&
      next.encoding === "UTF-8"
    ) {
      const text = (
        await this.git.run(
          repo,
          [
            "diff",
            "--no-ext-diff",
            "--no-textconv",
            "--no-color",
            "--no-renames",
            "--full-index",
            "--unified=0",
            ...this.diffArgs(c, refs),
            "--",
            literal(file),
          ],
          { maxBytes: 8 * 1024 * 1024 },
        )
      ).stdout;
      const at = text.indexOf("\n@@ ");
      if (
        at >= 0 &&
        !/^(new file|deleted file|old mode|new mode|similarity|rename )/m.test(
          text,
        )
      ) {
        revertPatch = text.slice(0, at + 1);
        revertHunks = text
          .slice(at + 1)
          .split(/(?=^@@ )/m)
          .filter((value) => value.startsWith("@@ "));
      }
    }
    const after = await this.identity(repo, file);
    if (before !== after) throw new Error("读取期间文件发生变化，请重试");
    const editable =
      !binary &&
      !limited &&
      next.encoding === "UTF-8" &&
      !rename.conflicted &&
      ["local", "unstaged"].includes(c.mode) &&
      rename.y !== "D";
    const token = this.remember({
      repo,
      file,
      comparison: c,
      fingerprint: after,
      patch: header,
      hunks,
      canPatch,
      editable,
      revertPatch,
      revertHunks,
      at: Date.now(),
    });
    return {
      path: file,
      oldText: old.text,
      newText: next.text,
      token,
      canPatch,
      editable,
      binary,
      limited,
      oldLabel:
        c.mode === "unstaged"
          ? "暂存区"
          : `${["versions", "history"].includes(c.mode) ? (c.base === "__empty__" ? "空树" : c.base) : "HEAD"} · ${refs.base.slice(0, 8)}`,
      newLabel:
        c.mode === "staged"
          ? "暂存区"
          : c.mode === "versions"
            ? `${c.target} · ${refs.target.slice(0, 8)}`
            : "工作区",
      hunks: canPatch
        ? hunks.map((value, index) => {
            const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(value)!;
            return {
              index,
              header: value.split("\n")[0],
              oldStart: Number(match[1]),
              newStart: Number(match[2]),
            };
          })
        : [],
      revertHunks: revertHunks.map((value, index) => {
        const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(
          value,
        )!;
        return {
          index,
          header: value.split("\n")[0],
          oldStart: Number(match[1]),
          oldCount: Number(match[2] ?? 1),
          newStart: Number(match[3]),
          newCount: Number(match[4] ?? 1),
        };
      }),
      encoding: next.encoding,
      notice: limited
        ? "文件超过 4 MiB，已停止加载正文以保护性能。可以执行整文件操作。"
        : binary
          ? "二进制文件或特殊 Git 对象，使用整文件操作。"
          : rename.conflicted
            ? "文件有冲突，请使用三方冲突解决器。"
            : next.encoding !== "UTF-8"
              ? "旧编码文件仅供阅读，整文件暂存保留原始字节。"
              : "",
    };
  }
  private async write<T>(
    repo: string,
    title: string,
    fn: (log: string, checkStop: () => void) => Promise<T>,
    previewTaskId?: string,
  ): Promise<{ value: T; output: string; taskId: string }> {
    const key = await this.git.commonDir(repo),
      previous = this.queues.get(key) || Promise.resolve();
    const work = previous
      .catch(() => {})
      .then(async () => {
        if (previewTaskId) {
          const owner = this.tasks.get(previewTaskId);
          if (owner.type !== "app" || owner.state !== "awaiting" || !owner.result.ready ||
              path.resolve(String(owner.params.repo)).toLowerCase() !== path.resolve(repo).toLowerCase() ||
              owner.lockKey !== "git:" + key)
            throw new Error("提交预览已结束，请重新检查");
          this.tasks.assertUnlocked("git:" + key, owner.id);
          const checkStop = () => {
            if (this.tasks.get(owner.id).state !== "awaiting")
              throw new Error("提交预览已取消，未继续写入");
          };
          checkStop();
          return { value: await fn(owner.logPath, checkStop), output: "", taskId: owner.id };
        }
        const task = this.tasks.create(
          "git-client",
          title,
          null,
          "git:" + key,
          { repo },
        );
        let value!: T;
        this.tasks.launch(task, async (ctx) => {
          value = await ctx.step(title, () =>
            fn(task.logPath, () => ctx.checkStop()),
          );
        });
        await this.tasks.running.get(task.id);
        const finished = this.tasks.get(task.id);
        if (finished.state !== "success")
          throw new Error(finished.error || "Git 操作失败");
        return {
          value,
          output: cleanOutput(fs.readFileSync(task.logPath, "utf8")),
          taskId: task.id,
        };
      });
    this.queues.set(key, work);
    try {
      return await work;
    } finally {
      if (this.queues.get(key) === work) this.queues.delete(key);
    }
  }
  private async pathCommand(
    repo: string,
    args: string[],
    files: string[],
    logPath: string,
  ) {
    const file = path.join(this.dataDir, "git-client-paths-" + randomUUID());
    await fs.promises.writeFile(file, files.map(literal).join("\0") + "\0");
    try {
      return await this.git.run(
        repo,
        [...args, "--pathspec-from-file=" + file, "--pathspec-file-nul"],
        { logPath },
      );
    } finally {
      await fs.promises.rm(file, { force: true });
    }
  }
  async patch(
    repo: string,
    token: string,
    hunk: number,
    operation: "stage" | "unstage" | "rollback",
  ) {
    return this.write(
      repo,
      `差异块 ${gitOperationLabel(operation)}`,
      async (logPath, checkStop) => {
        const s = await this.checked(repo, token);
        if (!s.canPatch || !Number.isInteger(hunk) || !s.hunks[hunk])
          throw new Error("此文件不支持安全的逐块操作，请使用整文件操作");
        if (
          (operation === "stage" && s.comparison.mode !== "unstaged") ||
          (operation === "unstage" && s.comparison.mode !== "staged") ||
          (operation === "rollback" && s.comparison.mode !== "unstaged")
        )
          throw new Error("逐块操作与比较来源不一致");
        if (!["stage", "unstage", "rollback"].includes(operation))
          throw new Error("逐块操作无效");
        const args = [
          "apply",
          "--whitespace=nowarn",
          ...(operation === "rollback" ? [] : ["--cached"]),
          ...(operation === "stage" ? [] : ["--reverse"]),
        ];
        const input = Buffer.from(s.patch + s.hunks[hunk], "utf8");
        await this.git.run(repo, [...args, "--check", "-"], { input, logPath });
        await this.checked(repo, token);
        checkStop();
        await this.git.run(repo, [...args, "-"], { input, logPath });
        this.snapshots.delete(token);
      },
    );
  }
  async revertPreview(repo: string, token: string, hunk: number) {
    const snapshot = await this.checked(repo, token);
    if (!Number.isInteger(hunk) || !snapshot.revertHunks?.[hunk])
      throw new Error("该差异不能安全回滚，请刷新或使用整文件操作");
    return {
      file: snapshot.file,
      header: snapshot.revertHunks[hunk].split("\n")[0],
      source:
        snapshot.comparison.mode === "unstaged" ? "暂存区" : "HEAD",
    };
  }
  async revertHunk(repo: string, token: string, hunk: number) {
    return this.write(repo, "Revert 差异处", async (logPath, checkStop) => {
      await this.revertPreview(repo, token, hunk);
      const snapshot = await this.checked(repo, token);
      if (!["local", "unstaged"].includes(snapshot.comparison.mode))
        throw new Error("此比较仅支持只读查看");
      const input = Buffer.from(
        snapshot.revertPatch! + snapshot.revertHunks![hunk],
        "utf8",
      );
      const args = [
        "apply",
        "--reverse",
        "--unidiff-zero",
        "--whitespace=nowarn",
      ];
      await this.git.run(repo, [...args, "--check", "-"], { input, logPath });
      await this.checked(repo, token);
      checkStop();
      await this.git.run(repo, [...args, "-"], { input, logPath });
      this.snapshots.delete(token);
    });
  }
  private async saveWork(repo: string, s: Snapshot, text: string) {
    if (
      typeof text !== "string" ||
      Buffer.byteLength(text) > maxContent ||
      text.includes("\0")
    )
      throw new Error("保存内容无效或超过 4 MiB");
    const target = await this.filePath(repo, s.file, true);
    const original = await this.work(repo, s.file);
    if (original.binary || original.limited || original.encoding !== "UTF-8")
      throw new Error("此文件不能进行文本写入");
    let bytes = Buffer.from(text, "utf8");
    if (
      original.bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191])) &&
      !bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))
    )
      bytes = Buffer.concat([Buffer.from([239, 187, 191]), bytes]);
    const temporary = target + ".workbench-" + randomUUID();
    try {
      await fs.promises.mkdir(path.dirname(target), { recursive: true });
      const stat = await fs.promises.stat(target).catch(() => null);
      await fs.promises.writeFile(temporary, bytes, {
        flag: "wx",
        mode: stat?.mode,
      });
      if (s.fingerprint !== (await this.identity(repo, s.file)))
        throw new Error("文件已被外部修改，未保存");
      await fs.promises.rename(temporary, target);
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
    return bytes;
  }
  async save(repo: string, token: string, text: string, preview?: { taskId?: string; file: string; afterSave?: () => Promise<void> }) {
    return this.write(repo, "保存工作区文件", async (_log, checkStop) => {
      const s = await this.checked(repo, token);
      if (preview && s.file !== preview.file) throw new Error("编辑文件与提交预览不符");
      if (!s.editable) throw new Error("此比较仅支持只读审查");
      const [head, index] = await Promise.all([
        this.head(repo),
        this.git.text(repo, ["ls-files", "--stage", "-z", "--", literal(s.file)]),
      ]);
      checkStop();
      const bytes = await this.saveWork(repo, s, text);
      let fingerprint = hash(JSON.stringify({ head, index, content: hash(bytes) }));
      if (fingerprint !== await this.identity(repo, s.file))
        throw new Error("保存期间文件、HEAD 或暂存区被外部修改，请刷新；未继续写入");
      if (preview?.afterSave) {
        await preview.afterSave();
        const stagedIndex = await this.git.text(repo, ["ls-files", "--stage", "-z", "--", literal(s.file)]);
        fingerprint = hash(JSON.stringify({ head, index: stagedIndex, content: hash(bytes) }));
        if (fingerprint !== await this.identity(repo, s.file))
          throw new Error("更新提交预览期间文件被外部修改，请重新检查");
      }
      this.snapshots.delete(token);
      // Keep an editable identity even when saving removes the last difference.
      // Old patches must not be attached to the new file contents.
      return { token: this.remember({
        ...s,
        fingerprint,
        patch: "",
        hunks: [],
        canPatch: false,
        revertPatch: "",
        revertHunks: [],
        at: Date.now(),
      }) };
    }, preview?.taskId);
  }
  async branches(repo: string): Promise<GitBranch[]> {
    const raw = await this.git.text(repo, [
      "for-each-ref",
      "--sort=-committerdate",
      "--format=%(refname)%00%(HEAD)%00%(upstream:short)%00%(subject)%00%(objectname)",
      "refs/heads",
      "refs/remotes",
    ]);
    return raw
      .split("\n")
      .filter(Boolean)
      .map((line) => {
        const [ref, current, upstream, subject, hash] = line
          .replace(/\r$/, "")
          .split("\0");
        return {
          name: ref.replace(/^refs\/(heads|remotes)\//, ""),
          current: current === "*",
          remote: ref.startsWith("refs/remotes/"),
          upstream,
          subject,
          hash,
        };
      })
      .filter((b) => !b.name.endsWith("/HEAD"));
  }
  async log(
    repo: string,
    options: {
      offset?: number;
      query?: string;
      file?: string;
      ref?: string;
      all?: boolean;
    } = {},
  ): Promise<GitCommit[]> {
    const offset = Number(options.offset || 0);
    if (!Number.isInteger(offset) || offset < 0 || offset > 1000000)
      throw new Error("历史分页无效");
    if (!(await this.head(repo))) return [];
    if (options.file) await this.filePath(repo, options.file);
    const revision = options.ref ? await this.ref(repo, options.ref) : "HEAD";
    const raw = await this.git.text(repo, [
      "log",
      "--date-order",
      "--max-count=150",
      `--skip=${offset}`,
      "--format=%H%x00%P%x00%an%x00%aI%x00%s%x00%D%x00",
      ...(options.all && !options.file ? ["--all"] : [revision]),
      ...(options.query
        ? [
            "--regexp-ignore-case",
            "--fixed-strings",
            "--grep=" + String(options.query).slice(0, 1000),
          ]
        : []),
      ...(options.file ? ["--follow", "--", literal(options.file)] : []),
    ]);
    const fields = raw.split("\0"),
      result: GitCommit[] = [];
    for (let i = 0; i + 5 < fields.length; i += 6)
      result.push({
        hash: fields[i].trim(),
        parents: fields[i + 1].split(" ").filter(Boolean),
        author: fields[i + 2],
        date: fields[i + 3],
        subject: fields[i + 4],
        refs: fields[i + 5],
      });
    return result;
  }
  async commitDetails(repo: string, ref: string) {
    const commit = await this.ref(repo, ref),
      parents = (
        await this.git.text(repo, ["show", "-s", "--format=%P", commit])
      )
        .split(" ")
        .filter(Boolean);
    const base = parents[0] || (await this.emptyTree(repo));
    const raw = await this.git.text(repo, [
      "show",
      "-s",
      "--format=%B",
      commit,
    ]);
    // An empty tree is valid for diff but is not a commit; handle the root explicitly.
    const result = await this.git.run(repo, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--name-status",
      "-z",
      "--find-renames",
      base,
      commit,
    ]);
    const fields = result.stdout.split("\0"),
      files: { path: string; oldPath?: string; status: string }[] = [];
    for (let i = 0; i < fields.length && fields[i]; ) {
      const status = fields[i++];
      let file = fields[i++],
        oldPath;
      if (/^[RC]/.test(status)) {
        oldPath = file;
        file = fields[i++];
      }
      files.push({ path: file, oldPath, status });
    }
    return { commit, base: parents[0] || "", message: raw, files };
  }
  async stashes(repo: string): Promise<GitStash[]> {
    const raw = await this.git.text(repo, [
      "stash",
      "list",
      "--format=%gd%x00%H%x00%gs%x00%cI",
    ]);
    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [ref, hash, subject, date] = line.split("\0");
        return { ref, hash, subject, date };
      });
  }
  async conflict(repo: string, file: string): Promise<ConflictContent> {
    const before = await this.identity(repo, file),
      state = await this.status(repo);
    if (!state.files.some((f) => f.path === file && f.conflicted))
      throw new Error("文件已不再冲突，请刷新");
    const [base, ours, theirs, work] = await Promise.all([
      this.blob(repo, `:1:${file}`),
      this.blob(repo, `:2:${file}`),
      this.blob(repo, `:3:${file}`),
      this.work(repo, file),
    ]);
    if (before !== (await this.identity(repo, file)))
      throw new Error("冲突文件已变化，请重试");
    const editable = [base, ours, theirs, work].every(
      (v) => !v.binary && !v.limited && v.encoding === "UTF-8",
    );
    const sideChanges = async (stage: number) => {
      if (!editable) return [];
      const diff = await this.git.run(
        repo,
        [
          "diff",
          "--no-ext-diff",
          "--no-textconv",
          "--no-color",
          "--unified=0",
          `:1:${file}`,
          `:${stage}:${file}`,
        ],
        { allowFailure: true, maxBytes: 8 * 1024 * 1024 },
      );
      if (diff.code) return [];
      return [
        ...diff.stdout.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm),
      ].map((m) => ({
        start: Math.max(1, Number(m[1])),
        end: Math.max(1, Number(m[1]) + Math.max(1, Number(m[2] ?? 1)) - 1),
      }));
    };
    const [oursChanges, theirsChanges] = await Promise.all([
      sideChanges(2),
      sideChanges(3),
    ]);
    const stages = await this.git.text(repo, [
      "ls-files",
      "--stage",
      "-z",
      "--",
      literal(file),
    ]);
    const token = this.remember({
      repo,
      file,
      comparison: { mode: "unstaged" },
      fingerprint: before,
      patch: "",
      hunks: [],
      canPatch: false,
      editable,
      conflict: true,
      at: Date.now(),
    });
    return {
      path: file,
      base: base.text,
      ours: ours.text,
      theirs: theirs.text,
      result: work.text,
      token,
      editable,
      oursChanges,
      theirsChanges,
      oursDeleted: !/^\d+ [0-9a-f]+ 2\t/m.test(stages.replaceAll("\0", "\n")),
      theirsDeleted: !/^\d+ [0-9a-f]+ 3\t/m.test(stages.replaceAll("\0", "\n")),
      oursLabel:
        state.operation === "rebase"
          ? "暂存区阶段 2 · Rebase 目标及已重放结果"
          : "暂存区阶段 2 · 当前 HEAD 侧",
      theirsLabel:
        state.operation === "rebase"
          ? "暂存区阶段 3 · 正在重放的提交"
          : "暂存区阶段 3 · 传入提交侧",
      notice: editable
        ? "以暂存区阶段 1 为共同基准。保存并标记解决后，再继续当前 Git 操作。"
        : "二进制、大文件或旧编码冲突请使用外部工具解决，本窗口不会转码覆盖。",
    };
  }
  async resolve(repo: string, token: string, text: string, remove = false) {
    return this.write(repo, "保存并标记冲突已解决", async (log) => {
      const s = await this.checked(repo, token, true);
      if (remove) {
        const stages = await this.git.text(repo, [
          "ls-files",
          "--stage",
          "-z",
          "--",
          literal(s.file),
        ]);
        const lines = stages.replaceAll("\0", "\n");
        if (
          /^\d+ [0-9a-f]+ 2\t/m.test(lines) &&
          /^\d+ [0-9a-f]+ 3\t/m.test(lines)
        )
          throw new Error("仅修改/删除冲突支持接受文件删除");
        await this.checked(repo, token, true);
        await this.git.run(repo, ["rm", "--force", "--", literal(s.file)], {
          logPath: log,
        });
        this.snapshots.delete(token);
        return;
      }
      if (!s.editable) throw new Error("该冲突只能在外部工具中解决");
      if (/^(<{7}|={7}|>{7}|\|{7})( |$)/m.test(text))
        throw new Error("结果仍含冲突标记，请先解决全部冲突块");
      await this.saveWork(repo, s, text);
      await this.pathCommand(repo, ["add", "-A"], [s.file], log);
      this.snapshots.delete(token);
    });
  }
  async pushPreview(repo: string, remote: string, branch: string) {
    const state = await this.status(repo);
    if (!state.remotes.includes(remote))
      throw new Error("请选择已配置的远程仓库");
    await this.branchName(repo, branch);
    const target = `refs/remotes/${remote}/${branch}`;
    const exists = await this.git.run(
      repo,
      ["show-ref", "--verify", "--quiet", target],
      { allowFailure: true },
    );
    const raw = await this.git.text(repo, [
      "log",
      "--max-count=100",
      "--format=%h %s",
      exists.code ? "HEAD" : `${target}..HEAD`,
    ]);
    return {
      branch: state.branch,
      remote,
      target: branch,
      commits: raw,
      head: state.head,
      newBranch: !!exists.code,
    };
  }
  private async branchName(repo: string, value: unknown) {
    if (
      typeof value !== "string" ||
      !value ||
      value.startsWith("-") ||
      value.length > 300
    )
      throw new Error("分支名称无效");
    await this.git.run(repo, ["check-ref-format", "--branch", value]);
    return value;
  }
  async execute(repo: string, operation: string, p: any = {}) {
    return this.write(
      repo,
      "Git · " + gitOperationLabel(operation),
      async (logPath, checkStop) => {
        const run = (args: string[], input?: string) => {
          checkStop();
          return this.git.run(repo, args, {
            logPath,
            input,
            env: {
              GIT_TERMINAL_PROMPT: "0",
              GIT_MERGE_AUTOEDIT: "no",
              GIT_EDITOR: "true",
              GIT_SEQUENCE_EDITOR: "true",
            },
          });
        };
        const state = await this.status(repo);
        if (state.locked)
          throw new Error("Git index.lock 存在，请等待外部操作结束");
        const recovery = ["continue", "skip", "abort"].includes(operation);
        if (
          state.operation &&
          !recovery &&
          !["stage", "unstage", "fetch"].includes(operation)
        )
          throw new Error(
            `当前 ${gitOperationLabel(state.operation)} 尚未结束，请解决冲突后继续或中止`,
          );
        switch (operation) {
          case "stage": {
            const files = await this.selected(repo, p.files);
            checkStop();
            return this.pathCommand(repo, ["add", "-A"], files, logPath);
          }
          case "unstage": {
            const files = await this.selected(repo, p.files);
            const names = new Set(files);
            for (const file of state.files)
              if (names.has(file.path) && file.oldPath) names.add(file.oldPath);
            checkStop();
            return this.pathCommand(
              repo,
              state.head
                ? ["restore", "--staged"]
                : ["rm", "--cached", "--ignore-unmatch"],
              [...names],
              logPath,
            );
          }
          case "rollback": {
            const files = await this.selected(repo, p.files);
            if (
              state.files.some(
                (f) => files.includes(f.path) && (f.untracked || f.conflicted),
              )
            )
              throw new Error("未跟踪文件不会被删除；冲突请通过三方解决器处理");
            for (const file of files) await this.filePath(repo, file, true);
            if (p.token) {
              const s = await this.checked(repo, p.token);
              if (!files.includes(s.file))
                throw new Error("回滚目标与当前对比不一致");
            }
            if (p.expected) {
              const current = await this.rollbackIdentity(repo, files);
              if (
                current.head !== p.expected.head ||
                current.index !== p.expected.index ||
                files.some(
                  (file) => current.files[file] !== p.expected.files?.[file],
                )
              )
                throw new Error(
                  "确认期间文件或暂存区已变化，未回滚；请刷新后重试",
                );
            }
            checkStop();
            return this.pathCommand(
              repo,
              ["restore", "--worktree"],
              files,
              logPath,
            );
          }
          case "commit": {
            if (state.files.some((f) => f.conflicted))
              throw new Error("仍有未解决冲突");
            if (!p.amend && !state.files.some((f) => f.staged))
              throw new Error("请先明确暂存要提交的内容");
            if (
              typeof p.message !== "string" ||
              !p.message.trim() ||
              p.message.length > 20000
            )
              throw new Error("请填写提交说明");
            const target = p.push ? await this.upstreamTarget(repo) : null;
            const result = await run(
              [
                "-c",
                "i18n.commitEncoding=UTF-8",
                "commit",
                ...(p.amend ? ["--amend"] : []),
                "--file=-",
              ],
              p.message,
            );
            if (target) {
              const current = await this.status(repo);
              if (current.branch !== state.branch)
                throw new Error(
                  "本地 Commit 已完成，但分支被外部切换；未执行 Push",
                );
              await run([
                "push",
                target.remote,
                `HEAD:refs/heads/${target.branch}`,
              ]);
            }
            return result;
          }
          case "fetch":
            return run(["fetch", "--all"]);
          case "pull": {
            if (!state.branch || !state.upstream)
              throw new Error("当前分支需要配置上游分支后才能 Pull");
            if (state.files.length)
              throw new Error("请先提交或 Stash 本地修改，再执行 Pull");
            if (!["merge", "rebase"].includes(p.strategy))
              throw new Error("请明确选择 Pull Merge 或 Rebase 策略");
            return run([
              "pull",
              p.strategy === "rebase" ? "--rebase" : "--no-rebase",
              "--no-autostash",
            ]);
          }
          case "push": {
            if (!state.branch)
              throw new Error("游离 HEAD 状态不能直接推送，请先创建分支");
            if (p.head !== state.head)
              throw new Error("待推送提交已变化，请重新预览 Push");
            if (!state.remotes.includes(p.remote))
              throw new Error("远程仓库无效");
            const branch = await this.branchName(repo, p.branch);
            return run([
              "push",
              "--set-upstream",
              p.remote,
              `HEAD:refs/heads/${branch}`,
            ]);
          }
          case "create-branch": {
            const name = await this.branchName(repo, p.name);
            const ref = await this.ref(repo, p.ref || "HEAD");
            return run(["branch", name, ref]);
          }
          case "checkout": {
            if (state.files.some((file) => !file.untracked))
              throw new Error("切换分支前请先提交或 Stash 本地修改");
            const name = await this.branchName(repo, p.branch);
            const branches = await this.branches(repo),
              chosen = branches.find((b) => b.name === name);
            if (!chosen) throw new Error("分支不存在");
            return run(
              chosen.remote
                ? [
                    "switch",
                    "--track",
                    "-c",
                    await this.branchName(
                      repo,
                      p.name || name.slice(name.indexOf("/") + 1),
                    ),
                    name,
                  ]
                : ["switch", name],
            );
          }
          case "delete-branch": {
            const name = await this.branchName(repo, p.branch);
            return run(["branch", "-d", name]);
          }
          case "rename-branch": {
            const name = await this.branchName(repo, p.branch),
              next = await this.branchName(repo, p.name);
            return run(["branch", "-m", name, next]);
          }
          case "merge":
          case "rebase": {
            if (state.files.length)
              throw new Error("合并或变基前请先提交或 Stash 本地修改");
            if (!state.branch) throw new Error("请先切换到本地分支");
            const ref = await this.ref(repo, p.ref);
            return operation === "merge"
              ? run(["merge", p.noFF ? "--no-ff" : "--ff", "--no-edit", ref])
              : run(["rebase", ref]);
          }
          case "revert":
          case "cherry-pick": {
            if (state.files.length)
              throw new Error("请先提交或 Stash 本地修改");
            const ref = await this.ref(repo, p.ref);
            const parents = (
              await this.git.text(repo, ["show", "-s", "--format=%P", ref])
            )
              .split(" ")
              .filter(Boolean);
            if (parents.length > 1)
              throw new Error(
                "合并提交需要明确选择 mainline，请在外部 Git 工具中操作",
              );
            return run([operation, "--no-edit", ref]);
          }
          case "continue":
          case "skip":
          case "abort": {
            if (!state.operation || state.operation === "sequencer")
              throw new Error("没有可恢复的单一 Git 操作，请核对仓库状态");
            if (
              operation === "skip" &&
              !["rebase", "cherry-pick"].includes(state.operation)
            )
              throw new Error("当前操作不支持 Skip");
            if (
              operation === "continue" &&
              state.files.some((f) => f.conflicted)
            )
              throw new Error("请先解决全部冲突并暂存");
            return run([state.operation, `--${operation}`]);
          }
          case "stash-push":
            return run([
              "stash",
              "push",
              ...(p.untracked ? ["--include-untracked"] : []),
              "--message",
              String(p.message || "工作台临时保存").slice(0, 1000),
            ]);
          case "stash-apply":
          case "stash-pop":
          case "stash-drop": {
            const selected = (await this.stashes(repo)).find(
              (s) => s.hash === p.hash && s.ref === p.ref,
            );
            if (!selected) throw new Error("Stash 已变化，请刷新后重试");
            return run(["stash", operation.slice(6), selected.ref]);
          }
          case "undo-last": {
            if (!state.head || !state.branch || state.files.length)
              throw new Error("撤销最后一次提交仅支持无本地修改的本地分支");
            const refs = await this.git.text(repo, [
              "for-each-ref",
              "--contains",
              state.head,
              "--format=%(refname)",
              "refs/remotes",
            ]);
            if (refs)
              throw new Error(
                "该提交出现在远程跟踪分支中，不能安全撤销，请使用 Revert",
              );
            if (p.head !== state.head) throw new Error("HEAD 已变化");
            await this.ref(repo, "HEAD^");
            return run(["reset", "--soft", "HEAD^"]);
          }
          default:
            throw new Error("不支持的 Git 操作");
        }
      },
    );
  }
}

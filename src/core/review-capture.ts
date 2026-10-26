import fs from "node:fs";
import path from "node:path";
import type { DiffScope, ReviewFile } from "../shared/types.js";
import { Git } from "./git.js";
import { hash, requireText } from "./util.js";
import { decodeOutput } from "./process.js";
export interface ReviewRange {
  repo: string;
  scope: DiffScope;
  base?: string;
  target?: string;
  context?: number;
  fingerprintOnly?: boolean;
  lazyUntracked?: boolean;
  contentChecks?: Record<string, string>;
}
export class ReviewCapture {
  constructor(
    private git: Git,
    private progress: (message: string) => void = () => {},
  ) {}
  private async commit(repo: string, ref: string) {
    requireText(ref, "版本引用", 500);
    if (ref.startsWith("-") || /[\r\n\0]/.test(ref))
      throw new Error("版本引用无效");
    return this.git.text(repo, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      ref + "^{commit}",
    ]);
  }
  async capture(range: ReviewRange) {
    this.progress("正在核对比较范围与文件清单…");
    const { repo, scope } = range;
    if (
      !["unstaged", "staged", "local", "versions", "ancestor"].includes(scope)
    )
      throw new Error("差异范围无效");
    const head = await this.git.text(repo, ["rev-parse", "HEAD"]);
    let baseCommit = head,
      targetCommit = head,
      base = "HEAD",
      target = "工作区";
    let compare: string[] = [];
    if (scope === "staged") {
      compare = ["--cached"];
      target = "暂存区";
    }
    if (scope === "unstaged") {
      compare = [];
      base = "暂存区";
      target = "工作区";
    }
    if (scope === "local") compare = ["HEAD"];
    if (scope === "versions" || scope === "ancestor") {
      base = range.base || "HEAD";
      target = range.target || "HEAD";
      baseCommit = await this.commit(repo, base);
      targetCommit = await this.commit(repo, target);
      if (scope === "ancestor")
        baseCommit = await this.git.text(repo, [
          "merge-base",
          baseCommit,
          targetCommit,
        ]);
      compare = [baseCommit, targetCommit];
    }
    const args = [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      ...compare,
    ];
    const names = (
      await this.git.run(repo, [...args, "--name-status", "-z", "-M"])
    ).stdout.split("\0");
    const files: ReviewFile[] = [];
    const untrackedFiles =
      scope === "local"
        ? await this.git.paths(repo, [
            "ls-files",
            "--others",
            "--exclude-standard",
            "-z",
          ])
        : [];
    let processed = 0;
    let displayBytes = 0;
    let contentChanged = false;
    const read = async (
      file: string,
      side: "old" | "new",
      metadataOnly = false,
    ) => {
      const working = side === "new" && ["local", "unstaged"].includes(scope);
      const ref =
        side === "old"
          ? scope === "unstaged"
            ? ":"
            : baseCommit + ":"
          : scope === "staged"
            ? ":"
            : targetCommit + ":";
      if (working) {
        const full = path.resolve(repo, file);
        const stat = await fs.promises.lstat(full).catch((error) => {
          if (error.code === "ENOENT") return null;
          throw error;
        });
        if (!stat)
          return {
            text: "",
            limited: false,
            binary: false,
            identity: "absent",
          };
        if (stat.isSymbolicLink()) {
          const text = await fs.promises.readlink(full);
          return { text, limited: false, binary: false, identity: hash(text) };
        }
        if (stat.size > 512 * 1024)
          return {
            text: "",
            limited: true,
            binary: false,
            identity: `metadata:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`,
          };
        const metadata = `metadata:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
        if (metadataOnly && !range.contentChecks?.[file])
          return {
            text: "",
            limited: false,
            binary: false,
            identity: metadata,
          };
        const bytes = await fs.promises.readFile(full);
        if (
          range.contentChecks?.[file] &&
          range.contentChecks[file] !== hash(bytes)
        )
          contentChanged = true;
        return {
          text: metadataOnly || bytes.includes(0) ? "" : decodeOutput(bytes),
          limited: false,
          binary: bytes.includes(0),
          identity: metadataOnly ? metadata : hash(bytes),
        };
      }
      const object = ref + file;
      const size = await this.git.run(repo, ["cat-file", "-s", object], {
        allowFailure: true,
      });
      if (size.code)
        return { text: "", limited: false, binary: false, identity: "absent" };
      if (Number(size.stdout) > 512 * 1024) {
        const oid = await this.git.text(repo, [
          "rev-parse",
          "--verify",
          object,
        ]);
        return { text: "", limited: true, binary: false, identity: oid };
      }
      const value = (
        await this.git.run(repo, [
          "show",
          "--no-ext-diff",
          "--no-textconv",
          object,
        ])
      ).stdout;
      return {
        text: value,
        limited: false,
        binary: value.includes("\0"),
        identity: hash(value),
      };
    };
    const make = async (
      file: string,
      status: string,
      oldPath?: string,
      untracked = false,
    ) => {
      this.progress(`读取文件 ${++processed} · ${file}`);
      const old = untracked
        ? { text: "", limited: false, binary: false, identity: "absent" }
        : await read(oldPath || file, "old");
      const current = await read(
        file,
        "new",
        untracked && !!range.lazyUntracked && untrackedFiles.length > 200,
      );
      const deferred =
        untracked &&
        !!range.lazyUntracked &&
        untrackedFiles.length > 200 &&
        !current.limited &&
        current.identity.startsWith("metadata:");
      const binary = old.binary || current.binary;
      let limited = old.limited || current.limited;
      const context = Math.min(10000, Math.max(3, range.context || 3));
      let patch = "";
      if (!range.fingerprintOnly && !binary && !limited && !untracked)
        patch = (
          await this.git.run(repo, [
            ...args,
            `--unified=${context}`,
            "--",
            `:(literal)${oldPath || file}`,
            ...(oldPath ? [`:(literal)${file}`] : []),
          ])
        ).stdout;
      if (
        !range.fingerprintOnly &&
        !deferred &&
        untracked &&
        !limited &&
        !binary
      )
        patch =
          `--- /dev/null\n+++ ${file}\n@@ -0,0 +1,${current.text.split("\n").length} @@\n` +
          current.text
            .split("\n")
            .map((l) => "+" + l)
            .join("\n");
      const bytes =
        Buffer.byteLength(old.text) +
        Buffer.byteLength(current.text) +
        Buffer.byteLength(patch);
      if (displayBytes + bytes > 16 * 1024 * 1024) {
        limited = true;
        patch = "";
      } else displayBytes += bytes;
      return {
        path: file,
        oldPath,
        status,
        binary,
        limited,
        patch,
        oldText: range.fingerprintOnly || binary || limited ? "" : old.text,
        newText: range.fingerprintOnly || binary || limited ? "" : current.text,
        hash: hash(
          JSON.stringify({
            old: old.identity,
            new: current.identity,
            status,
            oldPath,
          }),
        ),
        untracked,
        ...(deferred ? { deferred: true } : {}),
      };
    };
    for (let i = 0; i < names.length; i++) {
      const status = names[i];
      if (!status) continue;
      const first = names[++i];
      if (/^[RC]/.test(status)) {
        const second = names[++i];
        files.push(await make(second, status, first));
      } else files.push(await make(first, status));
    }
    if (scope === "local")
      for (let offset = 0; offset < untrackedFiles.length; offset += 16) {
        files.push(
          ...(await Promise.all(
            untrackedFiles
              .slice(offset, offset + 16)
              .map((file) => make(file, "?", undefined, true)),
          )),
        );
      }
    const fingerprint = hash(
      JSON.stringify({
        scope,
        baseCommit,
        targetCommit,
        files: files.map((f) => [f.path, f.hash]),
      }),
    );
    return {
      scope,
      base,
      target,
      baseCommit,
      targetCommit,
      files,
      fingerprint,
      lazyUntracked: !!range.lazyUntracked,
      contentChanged,
    };
  }
}

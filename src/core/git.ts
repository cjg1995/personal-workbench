import fs from "node:fs";
import path from "node:path";
import type { GitFile, SubmitCheck } from "../shared/types.js";
import {
  appSubmitPolicy,
  type FixedBranchPolicy,
  type SubmitPolicy,
} from "../shared/submit-policy.js";
import { command, type CommandOptions } from "./process.js";
import { hash } from "./util.js";
export const protectedFile = "store/index.js";
export function trackedDirectoryTree(files: string[]) {
  const directories = new Set<string>();
  for (const file of files) {
    let directory = path.posix.dirname(file);
    while (!directories.has(directoryKey(directory))) {
      directories.add(directoryKey(directory));
      if (directory === ".") break;
      directory = path.posix.dirname(directory);
    }
  }
  return directories;
}
const directoryKey = (directory: string) =>
  process.platform === "win32" ? directory.toLowerCase() : directory;
export function inTrackedDirectory(file: string, directories: Set<string>) {
  const parent = path.posix.dirname(file);
  return parent !== "." && directories.has(directoryKey(parent));
}
export function appPathRule(
  file: string,
  tracked: boolean,
  policy: FixedBranchPolicy = appSubmitPolicy,
): { included: boolean; reason?: string } {
  if (file.toLowerCase() === policy.protectedFile.toLowerCase())
    return { included: false, reason: "本地测试配置，始终保护" };
  if (
    /(^|\/)(\.[^/]+\/|tests?\/|__tests__\/|__mocks__\/|__snapshots__\/|node_modules\/|unpackage\/|dist\/|build\/|coverage\/|logs?\/|tmp\/|temp\/)/i.test(
      file,
    )
  )
    return { included: false, reason: "本地、测试或构建目录" };
  if (/(^|\/)(test[-_.][^/]*|[^/]*[.-](test|spec)\.[^/]+)$/i.test(file))
    return { included: false, reason: "测试命名文件" };
  if (
    /(^|\/)\.env($|\.)|\.(log|bak|tmp|swp|zip|rar|7z|apk|aab|ipa|keystore|jks|pem|key|p12|pfx)$/i.test(
      file,
    )
  )
    return { included: false, reason: "环境配置、密钥、产物或临时文件" };
  if (tracked) return { included: true };
  if (/\.(md|txt|bat|ps1|sh|patch|diff)$/i.test(file))
    return { included: false, reason: "新文档或脚本不自动纳入" };
  if (policy.source === "vue")
    return /^(src|public)\//i.test(file) ||
      /^(package(?:-lock)?\.json|vue\.config\.js|babel\.config\.js|jsconfig\.json)$/i.test(
        file,
      )
      ? { included: true }
      : { included: false, reason: "新文件不在源码目录或根文件白名单" };
  if (
    /^(api|components|js|lib|nativeplugins|pages|static|store|utils|plugins|uni_modules|common)\//i.test(
      file,
    ) ||
    /^(App\.vue|main\.js|mixin\.js|permission\.js|manifest\.json|pages\.json|uni\.scss|icon\.(png|jpg|jpeg|webp))$/i.test(
      file,
    )
  )
    return { included: true };
  return { included: false, reason: "新文件不在源码目录或根文件白名单" };
}
export class Git {
  constructor(public executable = "git") {}
  async run(repo: string, args: string[], options: CommandOptions = {}) {
    return command(
      this.executable,
      [
        "--no-optional-locks",
        "-c",
        "core.quotepath=false",
        "-c",
        "core.pager=cat",
        "-C",
        repo,
        ...args,
      ],
      {
        requireFullOutput: true,
        env: { GIT_TERMINAL_PROMPT: "0", GIT_MERGE_AUTOEDIT: "no" },
        ...options,
      },
    );
  }
  async text(repo: string, args: string[], options: CommandOptions = {}) {
    return (await this.run(repo, args, options)).stdout.trimEnd();
  }
  async paths(repo: string, args: string[]) {
    return (await this.run(repo, args)).stdout.split("\0").filter(Boolean);
  }
  async gitDir(repo: string) {
    return this.text(repo, ["rev-parse", "--absolute-git-dir"]);
  }
  async commonDir(repo: string) {
    return path
      .resolve(repo, await this.text(repo, ["rev-parse", "--git-common-dir"]))
      .toLowerCase();
  }
  async operation(repo: string) {
    const dir = await this.gitDir(repo);
    const states = [
      "MERGE_HEAD",
      "rebase-merge",
      "rebase-apply",
      "CHERRY_PICK_HEAD",
      "REVERT_HEAD",
      "sequencer",
      "index.lock",
    ];
    const active = states.filter((s) => fs.existsSync(path.join(dir, s)));
    if (await this.text(repo, ["ls-files", "--unmerged"]))
      active.push("未解决的冲突");
    return active;
  }
  async status(repo: string): Promise<GitFile[]> {
    const tokens = (
      await this.run(repo, [
        "status",
        "--porcelain=v1",
        "--no-renames",
        "-z",
        "--untracked-files=all",
      ])
    ).stdout.split("\0");
    const files: GitFile[] = [];
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;
      const status = token.slice(0, 2),
        file = token.slice(3);
      let oldPath: string | undefined;
      if (/[RC]/.test(status)) oldPath = tokens[++i];
      files.push({
        path: file,
        oldPath,
        status: status === "??" ? "?" : status.trim(),
        staged: status[0] !== " " && status[0] !== "?",
        tracked: status !== "??",
        included: true,
      });
    }
    return files;
  }
  async fingerprint(
    repo: string,
    includeUntracked = true,
    protectedPath = protectedFile,
    exceptFile?: string,
  ) {
    const scope = exceptFile ? ["--", ".", ":(exclude,literal)" + exceptFile] : [];
    const [head, branch, index, diff, untracked] = await Promise.all([
      this.text(repo, ["rev-parse", "HEAD"]),
      this.text(repo, ["branch", "--show-current"]),
      this.run(repo, ["ls-files", "--stage", "-z", ...scope]),
      this.run(
        repo,
        ["diff", "--no-ext-diff", "--no-textconv", "--binary", "HEAD", ...scope],
        { maxBytes: 1024 * 1024, requireFullOutput: false },
      ),
      includeUntracked
        ? this.paths(repo, ["ls-files", "--others", "--exclude-standard", "-z", ...scope])
        : Promise.resolve<string[]>([]),
    ]);
    const content = untracked.map((p) => {
      const file = path.resolve(repo, p);
      try {
        const st = fs.lstatSync(file);
        return [
          p,
          st.isSymbolicLink()
            ? fs.readlinkSync(file)
            : hash(fs.readFileSync(file)),
        ];
      } catch {
        return [p, "missing"];
      }
    });
    const store = path.join(repo, protectedPath);
    const localConfig =
      protectedPath && fs.existsSync(store) ? hash(fs.readFileSync(store)) : "";
    return hash(
      JSON.stringify({
        head,
        branch,
        index: index.stdout,
        diff:
          diff.stdoutSha256 ||
          hash(diff.stdoutBytes || Buffer.from(diff.stdout)),
        content,
        localConfig,
      }),
    );
  }
  async inspect(
    repo: string,
    selection: "erp" | "app" | SubmitPolicy,
  ): Promise<SubmitCheck> {
    const policy =
      typeof selection === "string"
        ? selection === "erp"
          ? { kind: "erp" as const }
          : appSubmitPolicy
        : selection;
    const [branch, head, gitDir, commonDir, files, ops] = await Promise.all([
      this.text(repo, ["branch", "--show-current"]),
      this.text(repo, ["rev-parse", "HEAD"]),
      this.gitDir(repo),
      this.commonDir(repo),
      this.status(repo),
      this.operation(repo),
    ]);
    const checks: SubmitCheck["checks"] = [];
    const check = (label: string, ok: boolean, detail: string) =>
      checks.push({ label, ok, detail });
    check("无未完成 Git 操作", ops.length === 0, ops.join("、") || "正常");
    const origin = await this.run(repo, ["remote", "get-url", "origin"], {
      allowFailure: true,
    });
    check(
      "origin 已配置",
      origin.code === 0,
      origin.code === 0 ? "已配置（凭据不在此展示）" : "未配置",
    );
    const up = await this.run(
      repo,
      ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"],
      { allowFailure: true },
    );
    const upstream = up.code === 0 ? up.stdout.trim() : "";
    let ahead = 0;
    let testPath: string | undefined;
    let defaultMessage = "";
    if (policy.kind === "erp") {
      const match = /^(feature-|hotfix-)(.+)$/.exec(branch);
      check(
        "开发分支有效",
        !!match && !!match[2].trim(),
        branch || "detached HEAD",
      );
      defaultMessage = match?.[2] || "";
      check("开发分支上游已配置", !!upstream, upstream || "未配置");
      for (const ref of ["refs/heads/test", "refs/remotes/origin/test"]) {
        const r = await this.run(
          repo,
          ["show-ref", "--verify", "--quiet", ref],
          { allowFailure: true },
        );
        check(ref + " 存在", r.code === 0, r.code === 0 ? "存在" : "不存在");
      }
      const targetUp = await this.text(repo, [
        "for-each-ref",
        "--format=%(upstream:short)",
        "refs/heads/test",
      ]);
      check(
        "test 跟踪 origin/test",
        targetUp === "origin/test",
        targetUp || "未配置",
      );
      const trees = (
        await this.run(repo, ["worktree", "list", "--porcelain", "-z"])
      ).stdout.split("\0\0");
      for (const entry of trees) {
        const fields = entry.split("\0");
        if (fields.includes("branch refs/heads/test"))
          testPath = fields.find((f) => f.startsWith("worktree "))?.slice(9);
      }
      if (
        testPath &&
        path.resolve(testPath).toLowerCase() !==
          path.resolve(repo).toLowerCase()
      ) {
        const dirty = (await this.status(testPath)).filter((f) => f.tracked);
        check(
          "test 工作树可用",
          dirty.length === 0,
          dirty.length ? "存在已跟踪的本地修改" : testPath,
        );
      } else
        check(
          "test 工作树位置",
          true,
          "执行时切换当前目录至 test，完成后不自动切回",
        );
      for (const f of files) {
        f.included = f.tracked || f.staged;
        if (!f.included) f.reason = "未暂存的未跟踪文件不加入 ERP 提交";
      }
    } else {
      check(
        `固定 ${policy.branch} 分支`,
        branch === policy.branch,
        branch || "detached HEAD",
      );
      if (policy.protectedFile) {
        const flags = await this.text(repo, [
          "ls-files",
          "-v",
          "--",
          policy.protectedFile,
        ]);
        check(
          "本地配置存在且已跟踪",
          !!flags && fs.existsSync(path.join(repo, policy.protectedFile)),
          flags || `未找到 ${policy.protectedFile}`,
        );
      }
      const stages = await this.text(repo, ["ls-files", "--stage"]);
      check("未使用子模块", !/^160000 /m.test(stages), "子模块不支持自动提交");
      for (const f of files)
        Object.assign(f, appPathRule(f.path, f.tracked, policy));
    }
    const aheadRef = policy.kind === "app" ? `origin/${policy.branch}` : upstream;
    if (aheadRef) {
      const n = await this.run(
        repo,
        ["rev-list", "--count", `${aheadRef}..HEAD`],
        { allowFailure: true },
      );
      if (n.code === 0) ahead = Number(n.stdout.trim());
    }
    return {
      repo: path.resolve(repo),
      branch,
      head,
      gitDir,
      commonDir,
      upstream,
      target: policy.kind === "app" ? `origin/${policy.branch}` : "origin/test",
      testPath,
      files,
      ahead,
      defaultMessage,
      // ERP only stages tracked/index content; unrelated build output must not enter its write precondition.
      fingerprint: await this.fingerprint(
        repo,
        policy.kind === "app",
        policy.kind === "app" ? policy.protectedFile : protectedFile,
      ),
      checks,
      valid: checks.every((c) => c.ok),
    };
  }
  async diff(
    repo: string,
    scope: "staged" | "unstaged" | "local",
    file?: string,
  ) {
    return (
      await this.run(repo, [
        "diff",
        "--no-ext-diff",
        "--no-textconv",
        "--no-color",
        ...(scope === "staged"
          ? ["--cached"]
          : scope === "local"
            ? ["HEAD"]
            : []),
        ...(file ? ["--", `:(literal)${file}`] : []),
      ])
    ).stdout;
  }
  async stagePaths(
    repo: string,
    files: string[],
    dir: string,
    mode: "all" | "update" = "all",
    logPath?: string,
  ) {
    if (!files.length) return;
    const list = path.join(dir, "paths-" + Date.now() + ".nul");
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      list,
      files.map((f) => ":(literal)" + f).join("\0") + "\0",
    );
    await this.run(
      repo,
      [
        "add",
        mode === "update" ? "--update" : "-A",
        "--pathspec-from-file",
        list,
        "--pathspec-file-nul",
      ],
      { logPath },
    );
  }
}

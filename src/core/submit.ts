import fs from "node:fs";
import path from "node:path";
import type { Task } from "../shared/types.js";
import {
  submitPolicyForProject,
  type FixedBranchPolicy,
  type SubmitPolicy,
} from "../shared/submit-policy.js";
import { Git, protectedFile } from "./git.js";
import { TaskManager, type TaskContext } from "./tasks.js";
import {
  atomicWrite,
  ensureDir,
  hash,
  now,
  readJson,
  requireText,
} from "./util.js";
interface Recovery {
  id: string;
  repo: string;
  gitDir: string;
  branch: string;
  head: string;
  flags: string;
  phase: string;
  stashId: string;
  stashApplying: boolean;
  storeHash: string;
  createdAt: string;
  restored: boolean;
  // Absent on older APP backups, which always protected store/index.js.
  protectedFile?: string;
}
export class SubmitService {
  private finishing = new Set<string>();
  constructor(
    public git: Git,
    private tasks: TaskManager,
    private dataDir: string,
  ) {}
  async check(repo: string, kind: "erp" | "app" | SubmitPolicy, fromGit = false) {
    const check = await this.git.inspect(repo, kind);
    if (fromGit) {
      const configFile = typeof kind === "object" && kind.kind === "app" ? kind.protectedFile :
        kind === "app" ? protectedFile : "";
      for (const file of check.files) {
        file.included = (file.staged || file.tracked) && (!configFile || file.path.toLowerCase() !== configFile.toLowerCase());
        file.reason = file.included ? undefined :
          configFile && file.path.toLowerCase() === configFile.toLowerCase()
            ? "本地测试配置，始终保护" : "未跟踪的新文件，暂存后才纳入提测";
      }
      check.fromGit = true;
      check.fingerprint = await this.git.fingerprint(repo, true,
        typeof kind === "object" && kind.kind === "app" ? kind.protectedFile : protectedFile);
    }
    return check;
  }
  async startErp(
    projectId: string,
    repo: string,
    message: string,
    fingerprint: string,
    fromGit = false,
  ) {
    if (submitPolicyForProject(projectId).kind !== "erp")
      throw new Error("此项目不支持开发分支合并提交");
    const check = await this.check(repo, "erp", fromGit);
    if (!check.valid)
      throw new Error(
        check.checks
          .filter((c) => !c.ok)
          .map((c) => c.label + "：" + c.detail)
          .join("\n"),
      );
    if (check.fingerprint !== fingerprint)
      throw new Error("代码或暂存区已变化，请重新检查");
    if (check.files.some((f) => f.included))
      requireText(message, "提交说明", 10000);
    const task = this.tasks.create(
      "erp",
      projectId === "refsys" ? "推荐官后端提交" : "ERP 提交",
      projectId,
      "git:" + check.commonDir,
      {
        repo,
        branch: check.branch,
        target: "origin/test",
        testPath: check.testPath || repo,
        fromGit,
      },
      [
        "本地提交",
        "推送开发分支",
        "切换到 test 工作目录",
        "更新 test",
        "合并开发分支到 test",
        "推送 test",
      ],
    );
    this.tasks.launch(
      task,
      async (ctx) => {
        const dir = ensureDir(path.join(this.dataDir, "git-inputs", task.id));
        let target = repo;
        await ctx.step("本地提交", async () => {
          await this.requireUnchanged(repo, check.fingerprint, fromGit);
          const selected = check.files
            .filter((f) => f.tracked && !f.staged)
            .map((f) => f.path);
          // Staged tracked files can also carry unstaged edits, all tracked edits are included.
          const unstaged = await this.git.paths(repo, [
            "diff",
            "--no-ext-diff",
            "--name-only",
            "--no-renames",
            "-z",
          ]);
          ctx.checkStop();
          await this.git.stagePaths(
            repo,
            Array.from(new Set([...selected, ...unstaged])),
            dir,
            "update",
            task.logPath,
          );
          const staged = await this.git.paths(repo, ["diff", "--cached", "--name-only", "--no-renames", "-z"]);
          if (staged.length) {
            ctx.checkStop();
            const msg = path.join(dir, "message.txt");
            fs.writeFileSync(msg, message, "utf8");
            await this.git.run(
              repo,
              ["-c", "i18n.commitEncoding=UTF-8", "commit", "--file", msg],
              { logPath: task.logPath },
            );
            ctx.result({ commitCreated: true, commitSkipped: false });
          } else {
            ctx.log("没有可提交改动，跳过 commit");
            ctx.result({ commitCreated: false, commitSkipped: true });
          }
          ctx.result({
            localCommit: await this.git.text(repo, ["rev-parse", "HEAD"]),
          });
          const dirty = (await this.git.status(repo)).filter((f) => f.tracked);
          if (dirty.length)
            throw new Error("开发工作树仍有已跟踪变更，停止后续步骤");
        });
        await ctx.step("推送开发分支", async () => {
          await this.requireBranch(repo, check.branch);
          ctx.checkStop();
          await this.git.run(repo, ["push"], { logPath: task.logPath });
          ctx.result({ developmentPushed: true });
        });
        await ctx.step("切换到 test 工作目录", async () => {
          if (check.testPath) target = check.testPath;
          else
            await this.git.run(repo, ["switch", "test"], {
              logPath: task.logPath,
            });
          await this.requireBranch(target, "test");
          const dirty = (await this.git.status(target)).filter(
            (f) => f.tracked,
          );
          if (dirty.length)
            throw new Error(`test 工作树存在已跟踪修改：${target}`);
          ctx.result({
            testPath: target,
            finalBranch: await this.git.text(repo, [
              "branch",
              "--show-current",
            ]),
          });
        });
        await ctx.step("更新 test", async () => {
          await this.requireBranch(target, "test");
          ctx.checkStop();
          await this.git.run(target, ["pull", "--ff-only", "origin", "test"], {
            logPath: task.logPath,
          });
          ctx.result({ testUpdated: true });
        });
        await ctx.step("合并开发分支到 test", async () => {
          await this.requireBranch(target, "test");
          ctx.checkStop();
          await this.git.run(target, ["merge", "--no-edit", check.branch], {
            logPath: task.logPath,
          });
          ctx.result({
            testMerged: true,
            testCommit: await this.git.text(target, ["rev-parse", "HEAD"]),
          });
        });
        await ctx.step("推送 test", async () => {
          await this.requireBranch(target, "test");
          ctx.checkStop();
          await this.git.run(target, ["push"], { logPath: task.logPath });
          ctx.result({
            testPushed: true,
            finalBranch: await this.git.text(repo, [
              "branch",
              "--show-current",
            ]),
          });
        });
      },
      (ctx) =>
        this.captureState(
          ctx,
          repo,
          fs.existsSync(String(ctx.task.result.testPath || ctx.task.params.testPath || repo))
            ? String(ctx.task.result.testPath || ctx.task.params.testPath || repo) : undefined,
        ),
    );
    return task;
  }
  async prepareApp(projectId: string, repo: string, fingerprint: string, fromGit = false, message = "") {
    const policy = submitPolicyForProject(projectId);
    if (policy.kind !== "app") throw new Error("此项目不支持固定分支提交");
    const { branch, protectedFile: configFile } = policy;
    const backupStep = configFile ? "备份与保护本地配置" : "备份暂存区";
    const check = await this.check(repo, policy, fromGit);
    if (!check.valid)
      throw new Error(
        check.checks
          .filter((c) => !c.ok)
          .map((c) => c.label + "：" + c.detail)
          .join("\n"),
      );
    if (check.fingerprint !== fingerprint)
      throw new Error("代码已变化，请重新检查");
    const recoveryPending = (await this.recoveries(repo)).filter(
      (r) =>
        !r.restored || (r.stashExists && r.phase !== "recovery-acknowledged"),
    );
    if (recoveryPending.length)
      throw new Error("存在尚未核实的本地配置恢复记录，请先查看恢复信息");
    const task = this.tasks.create(
      "app",
      projectId === "refsys-ui"
        ? "推荐官后台管理提交"
        : projectId === "refsys-wechat"
          ? "推荐官小程序提交"
          : "APP 更新与提交",
      projectId,
      "git:" + check.commonDir,
      { repo, branch, target: `origin/${branch}`, protectedFile: configFile,
        fromGit, message },
      [
        `获取 origin/${branch}`,
        backupStep,
        "保存本地改动",
        `合并远程 ${branch}`,
        "恢复本地改动",
        "核对最终提交清单",
        "本地提交",
        `推送 origin/${branch}`,
        "核对远端提交号",
      ],
    );
    this.tasks.launch(
      task,
      async (ctx) => {
        const dir = ensureDir(
          path.join(check.gitDir, "app-submit-backup", "workbench-" + task.id),
        );
        let recovery: Recovery | undefined;
        const save = () => {
          if (recovery)
            atomicWrite(
              path.join(dir, "recovery.json"),
              JSON.stringify(recovery, null, 2),
            );
        };
        try {
          await ctx.step(`获取 origin/${branch}`, async () => {
            await this.git.run(repo, ["fetch", "origin", branch], {
              logPath: task.logPath,
            });
            this.tasks.store.set("meta", "fetch:" + check.commonDir, {
              at: now(),
            });
            await this.assertProtectedHistory(repo, policy);
          });
          await ctx.step(backupStep, async () => {
            await this.requireUnchanged(
              repo, check.fingerprint, true, configFile,
            );
            const flags = configFile
              ? await this.git.text(repo, ["ls-files", "-v", "--", configFile])
              : "";
            ctx.checkStop();
            const bytes = configFile
              ? fs.readFileSync(path.join(repo, configFile))
              : Buffer.alloc(0);
            if (configFile)
              fs.writeFileSync(path.join(dir, "local-config.js"), bytes);
            fs.copyFileSync(
              path.join(check.gitDir, "index"),
              path.join(dir, "index.before"),
            );
            recovery = {
              id: task.id,
              repo: path.resolve(repo),
              gitDir: check.gitDir,
              branch,
              head: check.head,
              flags: flags[0],
              phase: "protected",
              stashId: "",
              stashApplying: false,
              storeHash: hash(bytes),
              createdAt: now(),
              restored: !configFile,
              protectedFile: configFile,
            };
            save();
            ctx.result({ recoveryDir: dir });
            if (!configFile) return;
            await this.git.run(
              repo,
              ["update-index", "--no-skip-worktree", "--", configFile],
              { logPath: task.logPath },
            );
            ctx.checkStop();
            await this.git.run(
              repo,
              ["update-index", "--no-assume-unchanged", "--", configFile],
              { logPath: task.logPath },
            );
            ctx.checkStop();
            await this.git.run(
              repo,
              [
                "restore",
                "--source=HEAD",
                "--staged",
                "--worktree",
                "--",
                configFile,
              ],
              { logPath: task.logPath },
            );
          });
          await ctx.step("保存本地改动", async () => {
            if (
              (await this.git.status(repo)).some(
                (f) => f.path !== configFile,
              )
            ) {
              ctx.checkStop();
              recovery!.phase = "stashing";
              save();
              await this.git.run(
                repo,
                [
                  "stash",
                  "push",
                  "--include-untracked",
                  "-m",
                  "app-submit workbench " + task.id,
                  "--",
                  ".",
                  ...(configFile ? [`:(top,exclude,literal)${configFile}`] : []),
                ],
                { logPath: task.logPath },
              );
              recovery!.stashId = await this.git.text(repo, [
                "rev-parse",
                "refs/stash",
              ]);
              ctx.result({ stashId: recovery!.stashId });
              save();
            }
          });
          await ctx.step(`合并远程 ${branch}`, async () => {
            await this.requireBranch(repo, branch);
            recovery!.phase = "merging";
            save();
            await this.git.run(repo, ["merge", "--no-edit", `origin/${branch}`], {
              logPath: task.logPath,
            });
            ctx.result({ remoteUpdated: true });
          });
          await ctx.step("恢复本地改动", async () => {
            if (recovery!.stashId) {
              recovery!.phase = "stash-applying";
              recovery!.stashApplying = true;
              save();
              await this.git.run(
                repo,
                ["stash", "apply", "--index", recovery!.stashId],
                { logPath: task.logPath },
              );
              recovery!.stashApplying = false;
              recovery!.phase = "stash-applied";
              save();
              const stash = (
                await this.git.text(repo, ["stash", "list", "--format=%H %gd"])
              )
                .split("\n")
                .find((s) => s.startsWith(recovery!.stashId + " "));
              if (stash)
                await this.git.run(
                  repo,
                  ["stash", "drop", stash.split(" ")[1]],
                  {
                    logPath: task.logPath,
                  },
                );
              recovery!.stashId = "";
              save();
            }
            await this.restoreProtected(recovery!, dir, task.logPath);
            save();
            ctx.result({ configRestored: true, stashRestored: true });
          });
          await ctx.step("核对最终提交清单", async () => {
            const files = await this.check(repo, policy, fromGit);
            if (!files.valid)
              throw new Error("仓库状态已变化，请重新检查分支与未完成的 Git 操作");
            ctx.checkStop();
            if (!fromGit) await this.git.run(repo, ["restore", "--staged", "--", "."], {
              logPath: task.logPath,
            });
            ctx.checkStop();
            await this.git.stagePaths(
              repo,
              files.files
                .filter((f) => f.included)
                .map((f) => f.path),
              dir,
              "all",
              task.logPath,
            );
            const final = await this.check(repo, policy, fromGit);
            if (!final.valid)
              throw new Error("仓库状态已变化，请重新检查分支与未完成的 Git 操作");
            ctx.result({
              check: final,
              preparedFingerprint: final.fingerprint,
              ready: true,
              recoveryDir: dir,
            });
            recovery!.phase = "awaiting-confirmation";
            save();
          });
          ctx.checkStop();
          return "awaiting";
        } finally {
          if (recovery) {
            try {
              await this.restoreProtected(recovery, dir, task.logPath);
              save();
              ctx.result({
                configRestored: true,
                recoveryDir: dir,
                stashId: recovery.stashId,
                stashApplying: recovery.stashApplying,
              });
            } catch (e) {
              ctx.result({ configRestored: false, recoveryDir: dir });
              throw e;
            }
          }
        }
      },
      (ctx) => this.captureState(ctx, repo),
    );
    return task;
  }
  async editAppPreview<T extends object>(taskId: string, projectId: string, file: string, save: (stage: () => Promise<void>) => Promise<T>) {
    if (this.finishing.has(taskId)) throw new Error("正在保存或提交，请稍后再试");
    const task = this.tasks.get(taskId);
    if (task.type !== "app" || task.projectId !== projectId || task.state !== "awaiting" || !task.result.ready)
      throw new Error("此任务不在待确认阶段，请重新检查");
    const policy = submitPolicyForProject(projectId);
    if (policy.kind !== "app") throw new Error("提交任务与项目不符");
    if (policy.protectedFile && file.toLowerCase() === policy.protectedFile.toLowerCase())
      throw new Error("本地测试配置受保护，不能在提交预览中修改");
    this.finishing.add(taskId);
    try {
      const repo = String(task.params.repo);
      await this.requireUnchanged(repo, String(task.result.preparedFingerprint), true, policy.protectedFile);
      const otherFiles = await this.git.fingerprint(repo, true, policy.protectedFile, file);
      const value = await save(async () => {
        if (this.tasks.get(taskId).state !== "awaiting") throw new Error("预览已取消；文件已保存到工作区，未继续暂存或提交");
        const current = await this.check(repo, policy, task.params.fromGit === true);
        if (current.files.some((item) => item.path === file && item.included))
          await this.git.stagePaths(repo, [file], String(task.result.recoveryDir), "all", task.logPath);
      });
      if (this.tasks.get(taskId).state !== "awaiting") throw new Error("预览已取消，未继续提交");
      const check = await this.check(repo, policy, task.params.fromGit === true);
      if (otherFiles !== await this.git.fingerprint(repo, true, policy.protectedFile, file))
        throw new Error("保存期间其他文件被外部修改；请取消本次提交后重新检查，已保存的工作区代码保留");
      if (this.tasks.get(taskId).state !== "awaiting") throw new Error("预览已取消，未继续提交");
      task.result.check = check as unknown as Task["result"][string];
      task.result.preparedFingerprint = check.fingerprint;
      this.tasks.save(task);
      return { ...value, check };
    } finally {
      this.finishing.delete(taskId);
    }
  }
  async finishApp(taskId: string, message: string) {
    if (this.finishing.has(taskId))
      throw new Error("此任务正在核对最终确认，请勿重复提交");
    const task = this.tasks.get(taskId);
    if (task.type !== "app" || task.state !== "awaiting" || !task.result.ready)
      throw new Error("此任务不在待确认阶段，请重新检查");
    this.finishing.add(taskId);
    try {
      return await this.finishConfirmedApp(task, message);
    } finally {
      this.finishing.delete(taskId);
    }
  }
  private async finishConfirmedApp(task: Task, message: string) {
    const taskId = task.id;
    const repo = String(task.params.repo);
    const policy = submitPolicyForProject(task.projectId || "");
    if (policy.kind !== "app") throw new Error("提交任务与项目不符");
    const { branch, protectedFile: configFile } = policy;
    await this.requireUnchanged(
      repo, String(task.result.preparedFingerprint), true, configFile,
    );
    const staged = await this.git.paths(repo, [
      "diff",
      "--cached",
      "--name-only",
      "--no-renames", "-z",
    ]);
    const changes = staged;
    if (configFile && changes.some((p) => p.toLowerCase() === configFile.toLowerCase()))
      throw new Error("受保护配置仍在暂存区，请重新检查");
    if (changes.length) requireText(message, "提交说明", 10000);
    if (this.tasks.get(taskId).state !== "awaiting")
      throw new Error("任务状态已变化或已取消，未启动提交");
    task.state = "running";
    task.error = null;
    this.tasks.save(task);
    this.tasks.launch(
      task,
      async (ctx) => {
        await ctx.step("本地提交", async () => {
          await this.requireUnchanged(
            repo,
            String(task.result.preparedFingerprint),
            true,
            configFile,
          );
          await this.assertProtectedHistory(repo, policy);
          ctx.checkStop();
          if (changes.length) {
            const file = path.join(
              String(task.result.recoveryDir),
              "message.txt",
            );
            fs.writeFileSync(file, message, "utf8");
            await this.git.run(
              repo,
              ["-c", "i18n.commitEncoding=UTF-8", "commit", "--file", file],
              { logPath: task.logPath },
            );
          }
          ctx.result({
            localCommit: await this.git.text(repo, ["rev-parse", "HEAD"]),
            commitCreated: changes.length > 0,
            commitSkipped: changes.length === 0,
          });
        });
        await ctx.step(`推送 origin/${branch}`, async () => {
          await this.requireBranch(repo, branch);
          await this.assertProtectedHistory(repo, policy);
          const n = Number(
            await this.git.text(repo, [
              "rev-list",
              "--count",
              `origin/${branch}..HEAD`,
            ]),
          );
          ctx.checkStop();
          if (n)
            await this.git.run(
              repo,
              ["push", "origin", `HEAD:refs/heads/${branch}`],
              {
                logPath: task.logPath,
              },
            );
          else ctx.log("没有待推送提交");
          ctx.result({ pushCompleted: n > 0, pushSkipped: n === 0 });
        });
        await ctx.step("核对远端提交号", async () => {
          const local = await this.git.text(repo, ["rev-parse", "HEAD"]);
          const remote = (
            await this.git.text(repo, [
              "ls-remote",
              "--heads",
              "origin",
              `refs/heads/${branch}`,
            ])
          ).split("\t")[0];
          if (local !== remote)
            throw new Error(`远端 ${branch} 与本地 HEAD 不一致，不能标记成功`);
          ctx.result({ remoteCommit: remote, verified: true });
        });
      },
      (ctx) => this.captureState(ctx, repo),
    );
    return task;
  }
  private async requireBranch(repo: string, expected: string) {
    const [branch, operations] = await Promise.all([
      this.git.text(repo, ["branch", "--show-current"]),
      this.git.operation(repo),
    ]);
    if (branch !== expected)
      throw new Error(
        `工作树分支已变化，预期 ${expected}，当前 ${branch || "detached HEAD"}：${repo}`,
      );
    if (operations.length)
      throw new Error(
        `工作树有未完成的 Git 操作：${operations.join("、")}（${repo}）`,
      );
  }
  private async assertProtectedHistory(repo: string, policy: FixedBranchPolicy) {
    if (!policy.protectedFile) return;
    if (
      await this.git.text(repo, [
        "log",
        "--format=%h",
        `origin/${policy.branch}..HEAD`,
        "--",
        policy.protectedFile,
      ])
    )
      throw new Error(
        `尚未推送的历史修改了 ${policy.protectedFile}，已停止，请在 Git 工具中检查`,
      );
  }
  private async captureState(ctx: TaskContext, repo: string, target?: string) {
    const states = [];
    const conflicts: { repo: string; file: string }[] = [];
    for (const directory of Array.from(
      new Set([repo, ...(target ? [target] : [])]),
    )) {
      const [branch, head, operation, files] = await Promise.all([
        this.git.text(directory, ["branch", "--show-current"]),
        this.git.text(directory, ["rev-parse", "HEAD"]),
        this.git.operation(directory),
        this.git.paths(directory, [
          "diff",
          "--no-ext-diff",
          "--name-only",
          "--diff-filter=U",
          "-z",
        ]),
      ]);
      states.push({ repo: directory, branch, head, operation });
      for (const file of files) conflicts.push({ repo: directory, file });
    }
    ctx.result({
      repositoryStates: states,
      conflicts,
      finalBranch: states[0]?.branch,
    });
  }
  private async requireUnchanged(
    repo: string,
    fingerprint: string,
    includeUntracked = true,
    protectedPath = protectedFile,
  ) {
    if (
      (await this.git.fingerprint(repo, includeUntracked, protectedPath)) !== fingerprint
    )
      throw new Error("代码、分支或暂存区已变化，请重新检查");
  }
  private async restoreProtected(r: Recovery, dir: string, logPath?: string) {
    const configFile = r.protectedFile ?? protectedFile;
    if (!configFile) {
      r.restored = true;
      return;
    }
    const bytes = fs.readFileSync(
      path.join(
        dir,
        r.protectedFile === undefined ? "store-index.js" : "local-config.js",
      ),
    );
    if (hash(bytes) !== r.storeHash)
      throw new Error("受保护配置备份校验失败，不能覆盖文件");
    fs.writeFileSync(path.join(r.repo, configFile), bytes);
    await this.git.run(
      r.repo,
      ["update-index", "--no-skip-worktree", "--", configFile],
      { logPath },
    );
    await this.git.run(
      r.repo,
      ["update-index", "--no-assume-unchanged", "--", configFile],
      { logPath },
    );
    if (["S", "s"].includes(r.flags))
      await this.git.run(
        r.repo,
        ["update-index", "--skip-worktree", "--", configFile],
        { logPath },
      );
    if (["h", "s"].includes(r.flags))
      await this.git.run(
        r.repo,
        ["update-index", "--assume-unchanged", "--", configFile],
        { logPath },
      );
    r.restored = true;
  }
  async recoveries(repo: string) {
    const dir = path.join(await this.git.gitDir(repo), "app-submit-backup");
    if (!fs.existsSync(dir)) return [];
    const stashes = (
      await this.git.text(repo, ["stash", "list", "--format=%H%x00%gs"])
    ).split("\n");
    return fs
      .readdirSync(dir)
      .filter((n) => n.startsWith("workbench-"))
      .flatMap((n) => {
        const file = path.join(dir, n, "recovery.json");
        if (!fs.existsSync(file)) return [];
        const r = readJson<Recovery>(file);
        if (!r.stashId && r.phase === "stashing")
          r.stashId =
            stashes
              .find((line) => line.includes("app-submit workbench " + r.id))
              ?.split("\0")[0] || "";
        return [
          {
            ...r,
            directory: path.dirname(file),
            stashExists:
              !!r.stashId &&
              stashes.some((line) => line.startsWith(r.stashId + "\0")),
          },
        ];
      });
  }
  async recoverConfig(repo: string, recoveryId: string) {
    const r = (await this.recoveries(repo)).find((r) => r.id === recoveryId);
    if (
      !r ||
      path.resolve(r.repo) !== path.resolve(repo) ||
      r.gitDir !== (await this.git.gitDir(repo))
    )
      throw new Error("恢复对象与仓库不一致");
    this.tasks.assertUnlocked("git:" + (await this.git.commonDir(repo)));
    if (r.protectedFile === "") throw new Error("此批次没有受保护的本地配置");
    const current = path.join(repo, r.protectedFile ?? protectedFile);
    if (fs.existsSync(current))
      fs.copyFileSync(
        current,
        path.join(r.directory, "before-manual-recovery-" + Date.now() + ".js"),
      );
    await this.restoreProtected(r, r.directory);
    atomicWrite(
      path.join(r.directory, "recovery.json"),
      JSON.stringify(r, null, 2),
    );
    return {
      configRestored: true,
      stashId: r.stashId,
      stashApplying: r.stashApplying,
      message: "仅恢复本地配置与原标志，未重复应用 stash、提交或推送",
    };
  }
  async acknowledgeRecovery(repo: string, recoveryId: string) {
    const r = (await this.recoveries(repo)).find((r) => r.id === recoveryId);
    if (
      !r ||
      path.resolve(r.repo) !== path.resolve(repo) ||
      r.gitDir !== (await this.git.gitDir(repo))
    )
      throw new Error("恢复对象不一致");
    this.tasks.assertUnlocked("git:" + (await this.git.commonDir(repo)));
    if ((await this.git.operation(repo)).length)
      throw new Error("仓库仍有未结束操作或冲突，请先在原工具完成处理");
    if ((await this.git.text(repo, ["branch", "--show-current"])) !== r.branch)
      throw new Error(`请先回到 ${r.branch} 分支核实恢复`);
    if (!r.restored) throw new Error("本地配置保护尚未恢复，请先处理");
    r.phase = "recovery-acknowledged";
    atomicWrite(
      path.join(r.directory, "recovery.json"),
      JSON.stringify(r, null, 2),
    );
    return {
      acknowledged: true,
      stashId: r.stashId,
      message: "已保存人工确认；未应用或删除 stash，未执行提交或推送",
    };
  }
}

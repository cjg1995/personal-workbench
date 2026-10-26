const fs = require("node:fs"),
  path = require("node:path"),
  { execFileSync } = require("node:child_process");
const {
  _electron,
} = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
const root = path.resolve(__dirname, ".."),
  phase = process.argv[2] || "apk",
  dir = path.join(root, ".local", "real-integration", phase + "-" + Date.now());
fs.mkdirSync(dir, { recursive: true });
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let app, page;
const results = [];
async function launch() {
  app = await _electron.launch({
    executablePath: require("electron"),
    args: [root, "--data-dir=" + path.join(dir, "data")],
    env,
    timeout: 90000,
  });
  page = await app.firstWindow();
  await page.waitForSelector("[data-page=home]");
}
async function close() {
  if (!app) return;
  const closed = app.waitForEvent("close", { timeout: 10000 }).catch(() => {});
  await app
    .evaluate(({ app }) => {
      setTimeout(() => app.exit(0), 30);
      return true;
    })
    .catch(() => {});
  await closed;
  app = null;
}
function save() {
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify({ phase, dir, results }, null, 2),
  );
}
async function call(name, payload) {
  const response = await page.evaluate(
    ({ name, payload }) => window.workbench.call(name, payload),
    { name, payload },
  );
  if (!response.ok) throw new Error(response.error);
  return response.data;
}
async function waitTask(id, timeout = 45 * 60 * 1000) {
  const start = Date.now();
  let last = "";
  while (Date.now() - start < timeout) {
    const data = await call("bootstrap");
    const t = data.tasks.find((t) => t.id === id);
    if (!t) throw new Error("Task missing");
    const progress = t.stages.map((s) => s.state[0]).join("") + " " + t.state;
    if (progress !== last) {
      console.log(
        JSON.stringify({
          id,
          title: t.title,
          state: t.state,
          stage: t.stages.find((s) => s.state === "running")?.name,
        }),
      );
      last = progress;
    }
    if (!["running", "cancelling", "awaiting"].includes(t.state)) return t;
    await sleep(1800);
  }
  await call("task.cancel", { id });
  throw new Error("Task timeout: " + id);
}
function gitStatus(project) {
  try {
    return execFileSync(
      "git",
      [
        "--no-optional-locks",
        "-c",
        "core.quotepath=false",
        "-C",
        project.path,
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=all",
      ],
      { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
    ).toString("base64");
  } catch (e) {
    throw new Error(
      "无法保存真实 Git 状态：" + project.path + "；" + e.message,
    );
  }
}
(async () => {
  try {
    await launch();
    const initial = await call("bootstrap");
    const before = Object.fromEntries(
      initial.config.projects.map((p) => [p.id, gitStatus(p)]),
    );
    fs.writeFileSync(
      path.join(dir, "git-before.json"),
      JSON.stringify(before, null, 2),
    );
    if (phase === "apk") {
      for (const projectId of ["employee", "projectman", "worker", "driver"]) {
        let cfg;
        try {
          cfg = await call("apk.inspect", { projectId });
          const { resourceHashes } = await import("../dist/core/apk.js");
          const hashes = resourceHashes(cfg.www);
          fs.cpSync(
            cfg.www,
            path.join(dir, "host-resources-before", projectId),
            { recursive: true, errorOnExist: true },
          );
          fs.writeFileSync(
            path.join(dir, projectId + "-resources-before.json"),
            JSON.stringify(hashes, null, 2),
          );
        } catch (e) {
          results.push({ projectId, phase: "precheck", error: e.message });
          save();
          continue;
        }
        for (const variant of ["Release", "Debug"]) {
          try {
            const task = await call("apk.start", { projectId, variant });
            const result = await waitTask(task.id);
            results.push({ projectId, variant, ...result });
            save();
          } catch (e) {
            results.push({ projectId, variant, error: e.message });
            save();
          }
        }
      }
    } else if (phase === "run") {
      const report = await call("projects.list");
      fs.writeFileSync(
        path.join(dir, "initial-runs.json"),
        JSON.stringify(report, null, 2),
      );
      for (const project of initial.config.projects.filter(
        (p) => !process.argv[3] || process.argv[3].split(",").includes(p.id),
      )) {
        const row = { projectId: project.id };
        results.push(row);
        save();
        console.log(JSON.stringify({ starting: project.id }));
        try {
          const first = (row.first = await call("projects.start", {
            projectId: project.id,
          }));
          const taskId = first.taskId || first.run?.taskId;
          row.task = taskId
            ? await waitTask(
                taskId,
                (project.type === "tomcat" ? 12 : 7) * 60 * 1000,
              )
            : null;
          let run = (row.run = await call("projects.inspect", {
            projectId: project.id,
          }));
          if (
            ["running", "watching", "external", "tool-open"].includes(run.state)
          )
            row.repeated = await call("projects.start", {
              projectId: project.id,
            });
          if (run.canStop && ["running", "watching"].includes(run.state)) {
            await close();
            await launch();
            row.afterReopen = run = await call("projects.inspect", {
              projectId: project.id,
            });
          }
          if (
            project.type === "uni-wechat" &&
            ["watching", "external"].includes(run.state)
          ) {
            row.tool = await call("projects.wechat", { projectId: project.id });
            if (row.tool.taskId)
              row.tool = await waitTask(row.tool.taskId, 120000);
          }
        } catch (e) {
          row.error = e.message;
        } finally {
          try {
            const run = await call("projects.inspect", {
              projectId: project.id,
            });
            if (run.canStop)
              row.stopped = await call("projects.stop", {
                projectId: project.id,
              });
          } catch (e) {
            row.stopError = e.message;
          }
          save();
        }
      }
    } else if (phase === "tapd") {
      const task = await call("tapd.open");
      results.push(await waitTask(task.id, 120000));
      save();
    }
    const final = await call("bootstrap");
    const after = Object.fromEntries(
      final.config.projects.map((p) => [p.id, gitStatus(p)]),
    );
    fs.writeFileSync(
      path.join(dir, "git-after.json"),
      JSON.stringify(after, null, 2),
    );
    const changed = Object.keys(before).filter((k) => before[k] !== after[k]);
    fs.writeFileSync(
      path.join(dir, "git-status-changed.json"),
      JSON.stringify(changed),
    );
    console.log(
      JSON.stringify({
        phase,
        dir,
        results: results.map((r) => ({
          projectId: r.projectId,
          variant: r.variant,
          state: r.state || r.run?.state,
          error: r.error,
          stopped: r.stopped?.state,
        })),
        gitStatusChanged: changed,
      }),
    );
    await close();
    process.exit(0);
  } catch (e) {
    console.error(e);
    save();
    await close();
    process.exit(1);
  }
})();

const fs = require("node:fs"),
  path = require("node:path"),
  assert = require("node:assert/strict"),
  { createHash } = require("node:crypto");
let pw;
try {
  pw = require("playwright");
} catch {
  pw = require("C:/Users/Master/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright");
}
const root = path.resolve(__dirname, ".."),
  dir = path.join(
    root,
    ".local",
    "real-integration",
    "apk-recovery-" + Date.now(),
  ),
  env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
fs.mkdirSync(dir, { recursive: true });
let app, page;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function launch() {
  app = await pw._electron.launch({
    executablePath: require("electron"),
    args: [root, "--data-dir=" + path.join(dir, "data")],
    env,
    timeout: 90000,
  });
  page = await app.firstWindow();
  await page.waitForSelector("[data-page=work]");
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
async function call(name, payload) {
  const r = await page.evaluate(
    ({ name, payload }) => window.workbench.call(name, payload),
    { name, payload },
  );
  if (!r.ok) throw new Error(r.error);
  return r.data;
}
async function ended(id) {
  let previous = "";
  for (let n = 0; n < 900; n++) {
    const task = (await call("bootstrap")).tasks.find((t) => t.id === id);
    const status = task.state + " " + task.stages.map((s) => s.state).join(",");
    if (status !== previous) {
      console.log(
        JSON.stringify({
          id,
          state: task.state,
          stage: task.stages.find((s) => s.state === "running")?.name,
        }),
      );
      previous = status;
    }
    if (!["running", "cancelling", "awaiting"].includes(task.state))
      return task;
    await sleep(1000);
  }
  throw new Error("Build verification timed out");
}
(async () => {
  try {
    await launch();
    const { resourceHashes } = await import("../dist/core/apk.js");
    const config = (await call("bootstrap")).config,
      cfg = await call("apk.inspect", { projectId: "employee" }),
      before = resourceHashes(cfg.www);
    const cancelled = await call("apk.start", {
      projectId: "employee",
      variant: "Release",
    });
    await call("task.cancel", { id: cancelled.id });
    const stopped = await ended(cancelled.id);
    assert.equal(stopped.state, "cancelled");
    assert.equal(stopped.result.artifact, undefined);
    assert.deepEqual(
      resourceHashes(cfg.www),
      before,
      "early cancellation must not change Android www",
    );
    await assert.rejects(
      () => call("apk.copy", { taskId: cancelled.id }),
      /没有成功/,
    );
    await close();
    await launch();
    assert.equal(
      (await call("bootstrap")).tasks.find((t) => t.id === cancelled.id).state,
      "cancelled",
    );
    assert.equal(
      (await call("bootstrap")).tasks.length,
      1,
      "restart cannot auto-build",
    );
    const invalid = JSON.parse(JSON.stringify(config));
    invalid.projects.find((p) => p.id === "employee").appId = "__UNI__INVALID";
    await call("settings.save", invalid);
    await assert.rejects(
      () => call("apk.start", { projectId: "employee", variant: "Release" }),
      /映射|AppID/,
    );
    assert.equal(
      (await call("bootstrap")).tasks.length,
      1,
      "mapping error is blocked before creating a task",
    );
    await call("settings.save", config);
    const retry = await call("apk.start", {
        projectId: "employee",
        variant: "Release",
      }),
      built = await ended(retry.id);
    assert.equal(built.state, "success", built.error || "");
    assert.equal(built.result.resourceCheck, "通过");
    assert.equal(built.result.signatureCheck, "通过");
    assert.equal(built.result.versionCheck, "通过");
    const history = JSON.parse(
      fs.readFileSync(
        path.join(
          root,
          ".local",
          "real-integration",
          "apk-1792852693280",
          "result.json",
        ),
        "utf8",
      ),
    ).results;
    for (const item of history) {
      const actual = createHash("sha256")
        .update(fs.readFileSync(item.result.artifact))
        .digest("hex");
      assert.equal(
        actual,
        item.result.sha256,
        "historical APK remains unchanged",
      );
    }
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify(
        {
          passed: true,
          dir,
          cancelled: stopped,
          retry: built,
          checks: [
            "early cancel leaves www unchanged",
            "cancelled task cannot expose an APK",
            "restart does not auto-build",
            "mapping mismatch blocked before build",
            "native recheck and full rebuild after cancellation",
            "original eight APK hashes unchanged",
          ],
        },
        null,
        2,
      ),
    );
    console.log(JSON.stringify({ passed: true, dir }));
    await close();
    process.exit(0);
  } catch (error) {
    console.error(error);
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify({ passed: false, dir, error: error.message }, null, 2),
    );
    if (app) {
      const active = (
        await call("bootstrap").catch(() => ({ tasks: [] }))
      ).tasks.filter((t) => ["running", "cancelling"].includes(t.state));
      for (const t of active)
        await call("task.cancel", { id: t.id }).catch(() => {});
      for (const t of active) await ended(t.id).catch(() => {});
    }
    await close();
    process.exit(1);
  }
})();

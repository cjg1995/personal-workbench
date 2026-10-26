const fs = require("node:fs"),
  path = require("node:path"),
  { DatabaseSync } = require("node:sqlite"),
  { createHash } = require("node:crypto"),
  { execFileSync } = require("node:child_process");
const root = path.resolve(__dirname, ".."),
  dir = path.join(root, ".local", "git-readonly-" + Date.now());
fs.mkdirSync(dir, { recursive: true });
const sql = new DatabaseSync(
  path.join(
    root,
    ".local",
    "real-integration",
    "apk-1792852693280",
    "data",
    "workbench.sqlite",
  ),
  { readOnly: true },
);
const config = JSON.parse(
  sql
    .prepare("select value from objects where kind=? and id=?")
    .get("config", "main").value,
);
sql.close();
const status = (p) =>
  execFileSync(
    config.tools.git,
    [
      "--no-optional-locks",
      "-c",
      "core.quotepath=false",
      "-C",
      p.path,
      "status",
      "--porcelain=v1",
      "--no-renames",
      "-z",
      "--untracked-files=all",
    ],
    { windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
  ).toString("base64");
const hash = (file) =>
  fs.existsSync(file)
    ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
    : null;
(async () => {
  try {
    const { Git } = await import("../dist/core/git.js");
    const git = new Git(config.tools.git),
      before = Object.fromEntries(
        config.projects.map((p) => [p.id, status(p)]),
      );
    fs.writeFileSync(path.join(dir, "before.json"), JSON.stringify(before));
    const checks = [];
    for (const id of [
      "homeproject",
      "homeproject-ai",
      "employee",
      "projectman",
      "worker",
      "driver",
    ]) {
      const p = config.projects.find((p) => p.id === id),
        gitDir = await git.gitDir(p.path),
        index = path.join(gitDir, "index"),
        indexBefore = hash(index),
        store = path.join(p.path, "store/index.js"),
        storeBefore = hash(store),
        flagsBefore = id.startsWith("homeproject")
          ? null
          : await git.text(p.path, ["ls-files", "-v", "--", "store/index.js"]),
        started = Date.now(),
        result = await git.inspect(
          p.path,
          id.startsWith("homeproject") ? "erp" : "app",
        );
      const row = {
        id,
        valid: result.valid,
        branch: result.branch,
        files: result.files.length,
        included: result.files.filter((f) => f.included).length,
        excluded: result.files.filter((f) => !f.included).length,
        seconds: (Date.now() - started) / 1000,
        checks: result.checks,
        indexUnchanged: hash(index) === indexBefore,
        protectedBytesUnchanged: hash(store) === storeBefore,
        protectedFlagsUnchanged:
          flagsBefore === null ||
          flagsBefore ===
            (await git.text(p.path, [
              "ls-files",
              "-v",
              "--",
              "store/index.js",
            ])),
      };
      checks.push(row);
      console.log(
        JSON.stringify({
          id,
          valid: row.valid,
          files: row.files,
          included: row.included,
          seconds: row.seconds,
        }),
      );
    }
    const after = Object.fromEntries(
      config.projects.map((p) => [p.id, status(p)]),
    );
    fs.writeFileSync(path.join(dir, "after.json"), JSON.stringify(after));
    const changed = Object.keys(before).filter(
        (id) => before[id] !== after[id],
      ),
      passed =
        !changed.length &&
        checks.every(
          (c) =>
            c.indexUnchanged &&
            c.protectedBytesUnchanged &&
            c.protectedFlagsUnchanged,
        );
    fs.writeFileSync(
      path.join(dir, "result.json"),
      JSON.stringify(
        {
          passed,
          dir,
          checks,
          statusChanged: changed,
          scope:
            "Read-only checks only; no fetch, add, commit, push, merge or recovery",
        },
        null,
        2,
      ),
    );
    if (!passed) throw new Error("Read-only invariants changed");
    console.log(JSON.stringify({ passed, dir }));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
})();

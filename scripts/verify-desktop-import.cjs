const fs = require("node:fs"),
  path = require("node:path"),
  crypto = require("node:crypto");
(async () => {
  const { Store } = await import("../dist/core/store.js");
  const { RecordsService } = await import("../dist/core/records.js");
  const dir = path.resolve(".local", "desktop-import-" + Date.now());
  fs.mkdirSync(dir, { recursive: true });
  const store = new Store(path.join(dir, "data.sqlite"));
  const records = new RecordsService(store, dir);
  const results = [];
  for (const [name, kind] of [
    ["todo.txt", "idea"],
    ["temp.txt", "work"],
  ]) {
    const file = path.join(process.env.USERPROFILE, "Desktop", name);
    const before = crypto
      .createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex");
    const p = records.previewImport(file, kind);
    const result = await records.import(
      p.id,
      p.lines.filter((l) => l.selected).map((l) => l.line),
    );
    const repeat = records.previewImport(file, kind);
    const after = crypto
      .createHash("sha256")
      .update(fs.readFileSync(file))
      .digest("hex");
    if (before !== after) throw new Error("Source bytes changed");
    if (
      result.records.some(
        (n) => n.happenedOn !== null || n.completedAt !== null,
      )
    )
      throw new Error("Date or completion inferred");
    if (repeat.lines.some((l) => l.selected))
      throw new Error("Duplicate default failure");
    results.push({
      file,
      lines: p.lines.length,
      encoding: p.encoding,
      added: result.added,
      skipped: result.skipped,
      sourceUnchanged: before === after,
      reimportSelected: repeat.lines.filter((l) => l.selected).length,
    });
  }
  const output = {
    passed: true,
    dir,
    results,
    monthRecords: records.month("2026-10").length,
  };
  fs.writeFileSync(
    path.join(dir, "result.json"),
    JSON.stringify(output, null, 2),
  );
  console.log(JSON.stringify(output));
  store.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});

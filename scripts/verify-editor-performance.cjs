const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const { EditorFiles } = await import("../dist/core/editor-files.js");
  const rg = path.resolve(__dirname, "..", "node_modules/@vscode/ripgrep-win32-x64/bin/rg.exe");
  const files = new EditorFiles(rg);
  const roots = ["D:/IdeaProjects/homeproject", "D:/IdeaProjects/refsys", "D:/IdeaProjects/refsys-ui"]
    .filter((root) => fs.existsSync(root));
  const results = [];
  for (const root of roots) {
    const start = performance.now();
    const index = await files.files(root);
    const indexMs = Math.round(performance.now() - start);
    const fileStart = performance.now();
    const found = await files.findFiles(root, "service");
    const fileMs = Math.round(performance.now() - fileStart);
    const textStart = performance.now();
    const hits = await files.search(root, "public class");
    const textMs = Math.round(performance.now() - textStart);
    assert(index.length > 0);
    results.push({ root: path.basename(root), files: index.length, indexMs, fileMatches: found.length,
      fileMs, textMatches: hits.length, textMs });
  }
  console.log(JSON.stringify(results, null, 2));
})().catch((error) => { console.error(error); process.exitCode = 1; });

import fs from "node:fs";
import path from "node:path";

export function readProjectRules(repo: string, fallback?: string) {
  const candidates = [path.join(repo, "AGENTS.md")];
  const dir = path.join(repo, ".cursor", "rules");
  if (fs.existsSync(dir)) {
    for (const file of fs.readdirSync(dir)) {
      if (file.endsWith(".mdc") || file.endsWith(".md")) {
        candidates.push(path.join(dir, file));
      }
    }
  }
  if (fallback && !candidates.some((f) => f.endsWith(".mdc"))) {
    candidates.push(fallback);
  }
  return candidates
    .filter((f) => fs.existsSync(f))
    .map((file) => ({ path: file, text: fs.readFileSync(file, "utf8") }));
}

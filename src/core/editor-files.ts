import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import iconv from "iconv-lite";
import { assertNoLinks, hash, inside } from "./util.js";

export interface EditorFile {
  file: string;
  text: string;
  version: string;
  encoding: "utf8" | "utf16le" | "utf16be" | "gb18030";
  bom: boolean;
  eol: "\n" | "\r\n";
}
export interface TreeEntry { name: string; file: string; directory: boolean }
export interface TextHit { file: string; line: number; column: number; text: string }

const excluded = new Set([
  ".git", ".idea", ".gradle", ".mvn", ".local", "node_modules", "target",
  "build", "dist", "out", "coverage", "unpackage", ".next", ".nuxt",
]);
const maxFileBytes = 4 * 1024 * 1024;

export function projectFile(root: string, relative: string, allowRoot = false) {
  if (typeof relative !== "string" || relative.includes("\0") || path.isAbsolute(relative))
    throw new Error("文件路径无效");
  const file = path.resolve(root, relative.replaceAll("/", path.sep));
  if (!inside(root, file) || (!allowRoot && file === path.resolve(root)))
    throw new Error("文件路径超出项目");
  assertNoLinks(file);
  return file;
}

function decode(buffer: Buffer): Omit<EditorFile, "file" | "version"> {
  if (buffer.length > maxFileBytes) throw new Error("文件超过 4 MB，请使用外部编辑器处理");
  let encoding: EditorFile["encoding"] = "utf8";
  let bom = false;
  let text: string;
  if (buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf) {
    text = buffer.subarray(3).toString("utf8");
    bom = true;
  } else if (buffer[0] === 0xff && buffer[1] === 0xfe) {
    encoding = "utf16le";
    text = buffer.subarray(2).toString("utf16le");
    bom = true;
  } else if (buffer[0] === 0xfe && buffer[1] === 0xff) {
    encoding = "utf16be";
    text = iconv.decode(buffer.subarray(2), "utf16be");
    bom = true;
  } else {
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(buffer);
    } catch {
      encoding = "gb18030";
      text = iconv.decode(buffer, "gb18030");
    }
  }
  if (text.includes("\0")) throw new Error("二进制文件无法在代码编辑器中打开");
  return { text, encoding, bom, eol: text.includes("\r\n") ? "\r\n" : "\n" };
}

function encode(text: string, encoding: EditorFile["encoding"], bom: boolean) {
  const body = encoding === "utf8" ? Buffer.from(text, "utf8") : iconv.encode(text, encoding);
  if (!bom) return body;
  const prefix = encoding === "utf8" ? [0xef, 0xbb, 0xbf]
    : encoding === "utf16le" ? [0xff, 0xfe] : [0xfe, 0xff];
  return Buffer.concat([Buffer.from(prefix), body]);
}

function relative(root: string, file: string) {
  return path.relative(root, file).replaceAll(path.sep, "/");
}

export class EditorFiles {
  private indexes = new Map<string, { at: number; promise: Promise<string[]> }>();
  private searches = new Map<string, AbortController>();
  constructor(private ripgrep?: string) {}

  private async rg(root: string, args: string[], maxBytes: number, maxLines = 0, signal?: AbortSignal) {
    if (!this.ripgrep || !fs.existsSync(this.ripgrep)) return null;
    if (signal?.aborted) return "";
    return new Promise<string | null>((resolve) => {
      const child = spawn(this.ripgrep!, args, { cwd: root, windowsHide: true, signal });
      const chunks: Buffer[] = [];
      let bytes = 0, lines = 0;
      child.stdout.on("data", (chunk: Buffer) => {
        if (bytes < maxBytes) { chunks.push(chunk); bytes += chunk.length; }
        if (maxLines) for (const byte of chunk) if (byte === 10) lines++;
        if (bytes >= maxBytes || (maxLines && lines >= maxLines)) child.kill();
      });
      child.once("error", () => resolve(signal?.aborted ? "" : null));
      child.once("close", (code) => resolve(code === 0 || code === 1 || bytes >= maxBytes || (maxLines && lines >= maxLines)
        ? Buffer.concat(chunks).toString("utf8") : null));
    });
  }

  private exclusions() {
    return [...excluded].flatMap((name) => ["-g", `!**/${name}/**`]);
  }

  async tree(root: string, directory = ""): Promise<TreeEntry[]> {
    const folder = projectFile(root, directory, true);
    const entries = await fs.promises.readdir(folder, { withFileTypes: true });
    return entries.filter((entry) => !entry.isSymbolicLink() &&
      (entry.isDirectory() ? !excluded.has(entry.name) : entry.isFile()))
      .map((entry) => ({
        name: entry.name,
        file: relative(root, path.join(folder, entry.name)),
        directory: entry.isDirectory(),
      }))
      .sort((a, b) => Number(b.directory) - Number(a.directory) ||
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" }));
  }

  async read(root: string, relativePath: string): Promise<EditorFile> {
    const file = projectFile(root, relativePath);
    const buffer = await fs.promises.readFile(file);
    return { file: relative(root, file), ...decode(buffer), version: hash(buffer) };
  }

  async version(root: string, relativePath: string): Promise<string | null> {
    const file = projectFile(root, relativePath);
    try { return hash(await fs.promises.readFile(file)); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  async save(root: string, input: Pick<EditorFile, "file" | "text" | "version" | "encoding" | "bom"> & { force?: boolean }) {
    const file = projectFile(root, input.file);
    const original = await fs.promises.readFile(file);
    const currentVersion = hash(original);
    if (!input.force && currentVersion !== input.version)
      return { conflict: true, version: currentVersion };
    if (input.encoding === "gb18030" && !iconv.encodingExists("gb18030"))
      throw new Error("无法保留原文件编码");
    const bytes = encode(input.text, input.encoding, input.bom);
    const stat = await fs.promises.stat(file);
    const temporary = `${file}.${randomUUID()}.tmp`;
    try {
      await fs.promises.writeFile(temporary, bytes, { flag: "wx", mode: stat.mode });
      if (!input.force && (await this.version(root, input.file)) !== currentVersion)
        return { conflict: true, version: await this.version(root, input.file) };
      await fs.promises.rename(temporary, file);
      return { conflict: false, version: hash(bytes) };
    } finally {
      await fs.promises.rm(temporary, { force: true });
    }
  }

  private async scan(root: string) {
    const listed = await this.rg(root, ["--files", "--hidden", ...this.exclusions(), "."], 24 * 1024 * 1024);
    if (listed !== null) return listed.split(/\r?\n/).filter(Boolean)
      .map((file) => file.replaceAll("\\", "/").replace(/^\.\//, ""));
    const files: string[] = [], queue = [path.resolve(root)];
    while (queue.length) {
      const folder = queue.shift()!;
      let entries: fs.Dirent[];
      try { entries = await fs.promises.readdir(folder, { withFileTypes: true }); }
      catch { continue; }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const full = path.join(folder, entry.name);
        if (entry.isDirectory() && !excluded.has(entry.name)) queue.push(full);
        else if (entry.isFile()) files.push(relative(root, full));
      }
      if (files.length % 200 < entries.length) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return files;
  }

  async files(root: string) {
    const key = path.resolve(root).toLowerCase(), cached = this.indexes.get(key);
    if (cached && Date.now() - cached.at < 30000) return cached.promise;
    const promise = this.scan(root);
    this.indexes.set(key, { at: Date.now(), promise });
    try { return await promise; }
    catch (error) { this.indexes.delete(key); throw error; }
  }

  invalidate(root: string) { this.indexes.delete(path.resolve(root).toLowerCase()); }
  cancelSearch(root: string) { this.searches.get(path.resolve(root).toLowerCase())?.abort(); }

  async findFiles(root: string, query: string, limit = 100) {
    const q = query.toLowerCase().trim();
    if (!q) return [];
    const score = (name: string) => {
      const text = name.toLowerCase(), base = path.basename(text);
      if (base === q) return 1000;
      if (base.startsWith(q)) return 800 - base.length;
      if (base.includes(q)) return 600 - base.length;
      let qi = 0, gap = 0;
      for (let i = 0; i < text.length && qi < q.length; i++) {
        if (text[i] === q[qi]) qi++;
        else if (qi) gap++;
      }
      return qi === q.length ? 300 - gap : -1;
    };
    return (await this.files(root)).map((file) => ({ file, score: score(file) }))
      .filter((item) => item.score >= 0)
      .sort((a, b) => b.score - a.score || a.file.length - b.file.length)
      .slice(0, Math.min(limit, 200)).map((item) => item.file);
  }

  async search(root: string, query: string, limit = 500): Promise<TextHit[]> {
    const key = path.resolve(root).toLowerCase();
    this.cancelSearch(root);
    const controller = new AbortController();
    this.searches.set(key, controller);
    if (!query || query.length > 200) return [];
    const matched = await this.rg(root, [
      "--hidden", "--line-number", "--column", "--ignore-case", "--fixed-strings",
      "--no-heading", "--color", "never", "--max-columns", "300", "--max-columns-preview",
      "--max-filesize", "4M",
      ...this.exclusions(),
      ...["java", "js", "jsx", "ts", "tsx", "vue", "json", "jsonc", "xml", "html", "htm", "css", "scss", "sql", "md", "yml", "yaml", "properties", "txt"]
        .flatMap((ext) => ["-g", `*.${ext}`]),
      "--", query, ".",
    ], 4 * 1024 * 1024, limit, controller.signal);
    if (controller.signal.aborted) return [];
    if (matched !== null) return matched.split(/\r?\n/).flatMap((line) => {
      const parts = /^\.[\\/](.*?):(\d+):(\d+):(.*)$/.exec(line);
      return parts ? [{ file: parts[1].replaceAll("\\", "/"), line: Number(parts[2]),
        column: Number(parts[3]), text: parts[4].trim().slice(0, 240) }] : [];
    }).slice(0, limit);
    const hits: TextHit[] = [];
    const files = await this.files(root);
    for (const file of files) {
      if (hits.length >= limit || controller.signal.aborted) break;
      if (!/\.(java|js|jsx|ts|tsx|vue|jsonc?|xml|html?|css|scss|sql|md|ya?ml|properties|txt)$/i.test(file)) continue;
      try {
        const target = projectFile(root, file);
        const stat = await fs.promises.stat(target);
        if (stat.size > maxFileBytes) continue;
        const text = decode(await fs.promises.readFile(target)).text;
        const lines = text.split(/\r?\n/);
        for (let i = 0; i < lines.length && hits.length < limit; i++) {
          let from = 0, at = -1;
          while (hits.length < limit && (at = lines[i].toLowerCase().indexOf(query.toLowerCase(), from)) >= 0) {
            hits.push({ file, line: i + 1, column: at + 1, text: lines[i].trim().slice(0, 240) });
            from = at + Math.max(query.length, 1);
          }
        }
      } catch { /* Deleted, binary, or inaccessible files are omitted. */ }
    }
    return hits;
  }

  async previews(root: string, locations: { file: string; line: number }[]) {
    const cached = new Map<string, Promise<string[]>>();
    return Promise.all(locations.slice(0, 200).map(async ({ file, line }) => {
      if (!cached.has(file)) {
        cached.set(file, this.read(root, file).then((value) => value.text.split(/\r?\n/)).catch(() => []));
      }
      return (await cached.get(file)!)?.[line - 1]?.trim().slice(0, 200) || "";
    }));
  }
}

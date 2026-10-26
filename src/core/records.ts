import fs from "node:fs";
import path from "node:path";
import type {
  ImportPreview,
  MonthlyDraft,
  MonthlyEntry,
  Note,
  RecordKind,
} from "../shared/types.js";
import { sections } from "../shared/types.js";
import { Store } from "./store.js";
import {
  atomicWrite,
  ensureDir,
  hash,
  id,
  localDate,
  now,
  requireText,
  validateDate,
} from "./util.js";
export class RecordsService {
  previews = new Map<string, ImportPreview>();
  constructor(
    public store: Store,
    public dataDir: string,
  ) {}
  list(kind: RecordKind, deleted = false) {
    return this.store
      .list<Note>("note")
      .filter((n) => n.kind === kind && !!n.deletedAt === deleted);
  }
  get(noteId: string) {
    const note = this.store.get<Note>("note", noteId);
    if (!note) throw new Error("记录不存在");
    return note;
  }
  save(input: {
    id?: string;
    kind: RecordKind;
    text: string;
    projectId?: string | null;
    happenedOn?: string | null;
    result?: string;
    sourceId?: string | null;
  }) {
    if (!["idea", "work"].includes(input.kind)) throw new Error("记录类型无效");
    const text = requireText(input.text);
    const original = input.id ? this.get(input.id) : undefined;
    if (original && original.kind !== input.kind)
      throw new Error("记录类型不能在编辑中改变");
    if (original?.deletedAt) throw new Error("此记录已删除，请先恢复");
    const note: Note = {
      id: original?.id || id(),
      kind: input.kind,
      text,
      projectId: input.projectId || null,
      happenedOn:
        input.kind === "work"
          ? validateDate(
              input.happenedOn === undefined
                ? (original?.happenedOn ?? localDate())
                : input.happenedOn,
            )
          : null,
      result: input.result || "",
      createdAt: original?.createdAt || now(),
      updatedAt: now(),
      completedAt: original?.completedAt || null,
      deletedAt: null,
      sourceId: input.sourceId ?? original?.sourceId ?? null,
      importBatch: original?.importBatch || null,
      sourceLine: original?.sourceLine || null,
      originalText: original?.originalText ?? null,
    };
    this.store.set("note", note.id, note);
    return note;
  }
  complete(noteId: string, done: boolean) {
    const n = this.get(noteId);
    if (n.kind !== "idea" || n.deletedAt)
      throw new Error("此记录不能修改完成状态");
    n.completedAt = done ? now() : null;
    n.updatedAt = now();
    return this.store.set("note", n.id, n);
  }
  remove(noteId: string) {
    const n = this.get(noteId);
    n.deletedAt = now();
    n.updatedAt = now();
    return this.store.set("note", n.id, n);
  }
  restore(noteId: string) {
    const n = this.get(noteId);
    n.deletedAt = null;
    n.updatedAt = now();
    return this.store.set("note", n.id, n);
  }
  month(month: string, projectId?: string) {
    this.checkMonth(month);
    return this.list("work")
      .filter(
        (n) =>
          n.happenedOn?.slice(0, 7) === month &&
          (!projectId || n.projectId === projectId),
      )
      .sort(
        (a, b) =>
          a.happenedOn!.localeCompare(b.happenedOn!) ||
          a.createdAt.localeCompare(b.createdAt),
      );
  }
  checkMonth(month: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new Error("月份无效");
  }
  previewImport(
    file: string,
    kind: RecordKind,
    encoding = "auto",
  ): ImportPreview {
    if (!["idea", "work"].includes(kind)) throw new Error("目标记录类型无效");
    const bytes = fs.readFileSync(file);
    if (bytes.length > 20 * 1024 * 1024)
      throw new Error("TXT 超过 20 MB，请先拆分后导入");
    let raw = "",
      detected = encoding;
    let warning: string | null = null;
    if (encoding === "auto") {
      try {
        raw = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        detected = bytes.subarray(0, 3).equals(Buffer.from([239, 187, 191]))
          ? "UTF-8 BOM"
          : "UTF-8";
      } catch {
        try {
          raw = new TextDecoder("gb18030", { fatal: true }).decode(bytes);
          detected = "GB18030 / GBK";
          warning = "按中文本机编码解码，请逐条核对，必要时切换编码。";
        } catch {
          throw new Error("无法可靠识别编码，请先选择正确编码并核对原文");
        }
      }
    } else {
      if (!["utf-8", "gb18030", "gbk", "utf-16le"].includes(encoding))
        throw new Error("不支持的编码");
      try {
        raw = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      } catch {
        throw new Error("所选编码无法解码此文件");
      }
    }
    raw = raw.replace(/^\uFEFF/, "");
    if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\ufffd]/.test(raw))
      throw new Error("文本含二进制内容或乱码，请核对格式，不能直接导入");
    const existing = new Set(
      this.store
        .list<Note>("note")
        .filter(
          (n) => n.kind === kind && n.importBatch && n.originalText !== null,
        )
        .map((n) => n.originalText),
    );
    const lines = raw.split(/\r\n|\n|\r/).flatMap((text, i) => {
      if (!text.trim()) return [];
      const duplicate = existing.has(text);
      existing.add(text);
      return [
        {
          line: i + 1,
          text,
          duplicate,
          selected: !duplicate,
          happenedOn: null,
        },
      ];
    });
    const preview: ImportPreview = {
      id: id(),
      kind,
      path: path.resolve(file),
      encoding: detected,
      hash: hash(bytes),
      bytes: bytes.length,
      raw,
      lines,
      warning,
    };
    const dir = ensureDir(path.join(this.dataDir, "snapshots", preview.id));
    atomicWrite(path.join(dir, "source.txt"), bytes);
    atomicWrite(
      path.join(dir, "source.json"),
      JSON.stringify({ ...preview, lines: undefined, raw: undefined }, null, 2),
    );
    this.previews.set(preview.id, preview);
    return preview;
  }
  async import(
    previewId: string,
    selected: number[],
    dates: Record<string, string | null> = {},
  ) {
    const preview = this.previews.get(previewId);
    if (!preview) throw new Error("预览已失效，请重新选择文件");
    if (hash(fs.readFileSync(preview.path)) !== preview.hash)
      throw new Error("原 TXT 已变化，请重新预览");
    if (
      new Set(selected).size !== selected.length ||
      selected.some((n) => !preview.lines.find((l) => l.line === n))
    )
      throw new Error("导入选择无效");
    const snapshot = path.join(
      this.dataDir,
      "snapshots",
      preview.id,
      "source.txt",
    );
    if (hash(fs.readFileSync(snapshot)) !== preview.hash)
      throw new Error("原文快照校验失败");
    const before = path.join(
      this.dataDir,
      "snapshots",
      preview.id,
      "before-import.sqlite",
    );
    await this.store.snapshot(before);
    const saved = this.store.transaction(() => {
      const current = new Set(
        this.store
          .list<Note>("note")
          .filter((n) => n.kind === preview.kind && n.importBatch)
          .map((n) => n.originalText),
      );
      const rows: Note[] = [];
      for (const line of preview.lines.filter((l) =>
        selected.includes(l.line),
      )) {
        if (current.has(line.text) && !line.duplicate)
          throw new Error("预览后有同文内容被导入，请刷新重复判断后重试");
        const n: Note = {
          id: id(),
          kind: preview.kind,
          text: line.text,
          projectId: null,
          happenedOn:
            preview.kind === "work"
              ? validateDate(dates[String(line.line)])
              : null,
          result: "",
          createdAt: now(),
          updatedAt: now(),
          completedAt: null,
          deletedAt: null,
          sourceId: null,
          importBatch: preview.id,
          sourceLine: line.line,
          originalText: line.text,
        };
        this.store.set("note", n.id, n);
        rows.push(n);
      }
      this.store.set("import", preview.id, {
        id: preview.id,
        path: preview.path,
        encoding: preview.encoding,
        hash: preview.hash,
        snapshot,
        createdAt: now(),
        added: rows.length,
        skipped: preview.lines.length - rows.length,
        lines: preview.lines.map((l) => ({
          line: l.line,
          text: l.text,
          imported: selected.includes(l.line),
        })),
      });
      return rows;
    });
    this.previews.delete(previewId);
    return {
      batchId: previewId,
      added: saved.length,
      skipped: preview.lines.length - saved.length,
      failed: 0,
      records: saved,
      snapshot,
    };
  }
  draft(month: string, name = "陈嘉庚") {
    this.checkMonth(month);
    return (
      this.store.get<MonthlyDraft>("monthly", month) || {
        month,
        name,
        entries: [],
        updatedAt: now(),
      }
    );
  }
  saveDraft(draft: MonthlyDraft) {
    this.checkMonth(draft.month);
    requireText(draft.name, "姓名", 100);
    if (!Array.isArray(draft.entries)) throw new Error("月报条目格式无效");
    const ids = new Set<string>();
    for (const e of draft.entries) {
      if (
        !e.id ||
        ids.has(e.id) ||
        !sections.includes(e.section) ||
        typeof e.text !== "string" ||
        !Array.isArray(e.sourceIds) ||
        !e.sourceVersions
      )
        throw new Error("月报条目格式无效");
      ids.add(e.id);
    }
    draft.updatedAt = now();
    this.store.set("monthly", draft.month, draft);
    return draft;
  }
  addSources(
    month: string,
    name: string,
    section: string,
    sourceIds: string[],
  ) {
    const draft = this.draft(month, name);
    if (!sections.includes(section)) throw new Error("章节无效");
    const known = new Set(draft.entries.flatMap((e) => e.sourceIds));
    if (sourceIds.some((s) => known.has(s)))
      throw new Error("所选素材已在正文中，请编辑已有条目");
    for (const source of Array.from(new Set(sourceIds))) {
      const n = this.get(source);
      if (
        n.kind !== "work" ||
        n.deletedAt ||
        !n.happenedOn ||
        n.happenedOn.slice(0, 7) !== month
      )
        throw new Error("素材必须是本月且日期明确的工作记录");
      draft.entries.push({
        id: id(),
        section,
        text: n.text + (n.result ? "\n实际结果：" + n.result : ""),
        sourceIds: [source],
        sourceVersions: { [source]: hash(JSON.stringify(n)) },
        manual: false,
      });
    }
    return this.saveDraft(draft);
  }
  sources(draft: MonthlyDraft) {
    return draft.entries.map((e) => ({
      entryId: e.id,
      sources: e.sourceIds.map((sourceId) => {
        const n = this.store.get<Note>("note", sourceId);
        return {
          id: sourceId,
          note: n,
          deleted: !n || !!n.deletedAt,
          changed: !n || hash(JSON.stringify(n)) !== e.sourceVersions[sourceId],
        };
      }),
    }));
  }
  monthlyText(draft: MonthlyDraft) {
    return (
      `一、工作成果\n\n` +
      sections
        .map(
          (s, i) =>
            `${i === 0 ? "1. " : i === 1 ? "2. " : i === 2 ? "二、" : i === 3 ? "三、" : "四、"}${s}\n${draft.entries
              .filter((e) => e.section === s)
              .map(
                (e, index, entries) =>
                  (i < 2 || ((i === 2 || i === 3) && entries.length > 1)
                    ? `${index + 1}. `
                    : "") + e.text,
              )
              .join("\n\n")}`,
        )
        .join("\n\n")
    );
  }
}

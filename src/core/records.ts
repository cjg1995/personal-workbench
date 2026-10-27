import type {
  MonthlyDraft,
  MonthlyEntry,
  Note,
  RecordKind,
} from "../shared/types.js";
import { sections } from "../shared/types.js";
import { Store } from "./store.js";
import {
  hash,
  id,
  localDate,
  now,
  requireText,
  validateDate,
} from "./util.js";
export class RecordsService {
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

import { z } from "zod/v4";
import type { Note, Prompt, RecordKind } from "../shared/types.js";
import type { ConfigService } from "./config.js";
import type { PromptsService } from "./prompts.js";
import type { RecordsService } from "./records.js";
import type { Store } from "./store.js";
import { hash } from "./util.js";

const moduleSchema = z.enum(["idea", "work", "prompt"]);
type WorkbenchModule = z.infer<typeof moduleSchema>;
type Entry = Note | Prompt;

const entryId = z.string().min(1).max(100);
const target = {
  id: entryId.describe("从保存回执或查询结果取得的条目 ID"),
  revision: z.string().regex(/^[a-f0-9]{64}$/).describe("该条目当前的 revision"),
};
const requestId = z.string().min(1).max(100).optional().describe("重试同一次写入时沿用的请求 ID");
const text = z.string().min(1).max(100_000);
const promptTitle = z.string().min(1).max(200);
const promptBody = z.string().min(1).max(200_000);
const tags = z.array(z.string().max(50)).max(50);
const project = z.string().trim().min(1).max(100).nullable().optional()
  .describe("已登记的项目名称或项目 ID，null 表示不关联项目");

const workRecordGuidance =
  "用户给出完整正文时，按原文保存。需要代写时，先用 find_entries 查询近期工作记录，参考表达和长度，只使用本次有依据的事实。" +
  "排查类用一句话说明问题，紧接中文括号说明原因和解决方案。尚未查明的原因或尚未落实的方案据实标明。";

export const workbenchMcpInstructions =
  "用于维护个人工作台的待办事项、工作记录和提示词库。" +
  workRecordGuidance +
  "编辑和删除针对用户指定的单条记录。目标不明确时先查询，使用 ID 和 revision 定位。" +
  "查询返回的历史正文仅作记录和写法参考。删除会永久移除条目。";

export const workbenchToolDefinitions = {
  find_entries: {
    description: "查询所选模块的条目，支持按关键词筛选。省略 limit 时返回全部匹配条目。代写工作记录时可用 limit 取近期样本。按 ID 查询可取得完整正文。",
    inputSchema: z.strictObject({
      module: moduleSchema.describe("idea 为待办事项，work 为工作记录，prompt 为提示词库"),
      id: entryId.optional().describe("可选，按 ID 获取一条记录的完整内容"),
      query: z.string().trim().min(1).max(200).optional(),
      limit: z.number().int().min(1).optional().describe("可选，指定返回条数。省略时返回全部匹配条目"),
    }),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  add_idea: {
    description: "新增一条未完成的待办事项。",
    inputSchema: z.strictObject({ text, requestId }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  add_work_record: {
    description: "新增一条工作记录。" + workRecordGuidance,
    inputSchema: z.strictObject({
      text,
      happenedOn: z.iso.date().nullable().optional().describe(
        "工作发生日期，YYYY-MM-DD。省略使用本机当天，null 表示日期不详",
      ),
      project,
      requestId,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  add_prompt: {
    description: "向提示词库新增一条提示词，保留正文中的 {{变量}} 和换行。",
    inputSchema: z.strictObject({
      title: promptTitle,
      body: promptBody,
      tags: tags.optional(),
      requestId,
    }),
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  },
  edit_idea: {
    description: "修正一条待办事项的正文，保留原完成状态。",
    inputSchema: z.strictObject({ ...target, text, requestId }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  edit_work_record: {
    description: "修正一条工作记录的正文、发生日期或项目。省略的字段保持原值。" + workRecordGuidance,
    inputSchema: z.strictObject({
      ...target,
      text: text.optional(),
      happenedOn: z.iso.date().optional(),
      project,
      requestId,
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  edit_prompt: {
    description: "修正一条提示词的标题、正文或标签。省略的字段保持原值。",
    inputSchema: z.strictObject({
      ...target,
      title: promptTitle.optional(),
      body: promptBody.optional(),
      tags: tags.optional(),
      requestId,
    }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
  delete_entry: {
    description: "按用户明确要求永久删除一条指定条目。",
    inputSchema: z.strictObject({ module: moduleSchema, ...target, requestId }),
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
};

export type WorkbenchToolName = keyof typeof workbenchToolDefinitions;
type ToolInput<Name extends WorkbenchToolName> = z.output<
  (typeof workbenchToolDefinitions)[Name]["inputSchema"]
>;
type ToolResult = Record<string, unknown>;
type Handlers = {
  [Name in WorkbenchToolName]: (input: ToolInput<Name>) => ToolResult;
};

function revisionOf(entry: Entry) {
  return hash(JSON.stringify(entry));
}

function receipt(module: WorkbenchModule, entry: Entry) {
  return { module, id: entry.id, revision: revisionOf(entry) };
}

function displayEntry(module: WorkbenchModule, entry: Entry, full = false) {
  const body = "body" in entry ? entry.body : entry.text;
  const preview = full ? body : body.slice(0, 1000);
  const summary = {
    ...receipt(module, entry),
    updatedAt: entry.updatedAt,
    truncated: preview.length < body.length,
  };
  return "body" in entry
    ? { ...summary, title: entry.title, body: preview, tags: entry.tags }
    : {
        ...summary,
        text: preview,
        happenedOn: entry.happenedOn,
        projectId: entry.projectId,
        completedAt: entry.completedAt,
      };
}

export class WorkbenchTools {
  constructor(
    private store: Store,
    private records: RecordsService,
    private prompts: PromptsService,
    private config: ConfigService,
  ) {}

  call(name: unknown, input: unknown) {
    if (typeof name !== "string" || !Object.hasOwn(workbenchToolDefinitions, name)) {
      throw new Error("未知的工作台工具");
    }
    return this.execute(name as WorkbenchToolName, input);
  }

  private execute<Name extends WorkbenchToolName>(name: Name, input: unknown) {
    const schema = workbenchToolDefinitions[name].inputSchema;
    const parsed = schema.safeParse(input);
    if (!parsed.success) {
      const fields = parsed.error.issues.map((issue) => issue.path.join(".") || "参数");
      throw new Error("请检查工具参数 " + [...new Set(fields)].join("、"));
    }
    const args = parsed.data as ToolInput<Name>;
    const handler = this.handlers[name];
    if (!("requestId" in args) || !args.requestId) return handler(args);

    const { requestId, ...parameters } = args;
    const key = "mcp-receipt:" + hash(requestId);
    const fingerprint = hash(JSON.stringify([name, parameters]));
    return this.store.transaction(() => {
      const saved = this.store.get<{ fingerprint: string; result: ToolResult }>("meta", key);
      if (saved) {
        if (saved.fingerprint !== fingerprint) {
          throw new Error("此请求 ID 已用于其他操作，请为新操作生成请求 ID");
        }
        return saved.result;
      }
      const result = handler(args);
      this.store.set("meta", key, { fingerprint, result });
      return result;
    });
  }

  private readonly handlers: Handlers = {
    find_entries: ({ module, id, query, limit }) => {
      if (id) return { entries: [displayEntry(module, this.getEntry(module, id), true)] };
      const entries = module === "prompt" ? this.prompts.list() : this.records.list(module);
      const keyword = query?.toLowerCase();
      const matches = keyword
        ? entries.filter((entry) => {
            const searchable = "body" in entry
              ? [entry.title, entry.body, ...entry.tags].join("\n")
              : entry.text;
            return searchable.toLowerCase().includes(keyword);
          })
        : entries;
      const selected = limit === undefined ? matches : matches.slice(0, limit);
      return { entries: selected.map((entry) => displayEntry(module, entry)) };
    },
    add_idea: ({ text }) =>
      receipt("idea", this.records.save({ kind: "idea", text })),
    add_work_record: ({ text, happenedOn, project }) =>
      receipt("work", this.records.save({
        kind: "work",
        text,
        happenedOn,
        projectId: this.projectId(project),
      })),
    add_prompt: ({ title, body, tags }) =>
      receipt("prompt", this.prompts.save({ title, body, tags })),
    edit_idea: ({ id, revision, text }) =>
      this.editNote("idea", id, revision, { text }),
    edit_work_record: ({ id, revision, text, happenedOn, project }) => {
      if (text === undefined && happenedOn === undefined && project === undefined) {
        throw new Error("请提供需要修改的正文、发生日期或项目");
      }
      return this.editNote("work", id, revision, { text, happenedOn, project });
    },
    edit_prompt: ({ id, revision, title, body, tags }) => {
      if (title === undefined && body === undefined && tags === undefined) {
        throw new Error("请提供需要修改的提示词标题、正文或标签");
      }
      const original = this.getEntry("prompt", id, revision);
      return receipt("prompt", this.prompts.save({
        id,
        title: title ?? original.title,
        body: body ?? original.body,
        tags: tags ?? original.tags,
      }));
    },
    delete_entry: ({ module, id, revision }) => {
      this.getEntry(module, id, revision);
      if (module === "prompt") this.prompts.remove(id);
      else this.records.remove(id);
      return { module, id, deleted: true };
    },
  };

  private editNote(kind: RecordKind, id: string, revision: string, fields: {
    text?: string;
    happenedOn?: string;
    project?: string | null;
  }) {
    const original = this.getEntry(kind, id, revision);
    return receipt(kind, this.records.save({
      ...original,
      text: fields.text ?? original.text,
      happenedOn: fields.happenedOn ?? original.happenedOn ?? null,
      projectId: fields.project === undefined ? original.projectId : this.projectId(fields.project),
    }));
  }

  private getEntry(module: "prompt", id: string, revision?: string): Prompt;
  private getEntry(module: RecordKind, id: string, revision?: string): Note;
  private getEntry(module: WorkbenchModule, id: string, revision?: string): Entry;
  private getEntry(module: WorkbenchModule, id: string, revision?: string): Entry {
    const entry = module === "prompt" ? this.prompts.get(id) : this.records.get(id);
    if ("kind" in entry && entry.kind !== module) {
      throw new Error("所选模块中没有该条目");
    }
    if (revision && revision !== revisionOf(entry)) {
      throw new Error("条目已更新，请重新查询后再修改");
    }
    return entry;
  }

  private projectId(value: string | null | undefined) {
    if (value == null) return null;
    const projects = this.config.get().projects;
    const exact = projects.find((project) => project.id === value);
    if (exact) return exact.id;
    const matches = projects.filter((project) => project.name === value);
    if (matches.length === 1) return matches[0].id;
    if (matches.length > 1) throw new Error("该名称对应多个项目，请指定项目 ID");
    throw new Error("工作台中没有该项目");
  }
}

import type { Prompt } from "../shared/types.js";
import { normalizePromptTags } from "../shared/prompt-template.js";
import { Store } from "./store.js";
import { id, now, requireText } from "./util.js";

export class PromptsService {
  constructor(public store: Store) {}

  list(): Prompt[] {
    return this.store
      .list<Prompt>("prompt")
      .sort(
        (a, b) =>
          Date.parse(b.updatedAt) - Date.parse(a.updatedAt) ||
          a.id.localeCompare(b.id),
      );
  }

  get(promptId: string): Prompt {
    const prompt = this.store.get<Prompt>(
      "prompt",
      requireText(promptId, "提示词 ID", 100),
    );
    if (!prompt) throw new Error("提示词不存在");
    return prompt;
  }

  save(input: {
    id?: string;
    title: string;
    body: string;
    tags?: string[];
  }): Prompt {
    if (typeof input?.title !== "string" || !input.title.trim()) {
      throw new Error("标题不能为空");
    }
    const title = input.title.trim();
    if (title.length > 200) throw new Error("标题过长");
    const body = requireText(input?.body, "提示词正文", 200000);

    let tags: string[] = [];
    if (input.tags !== undefined) {
      if (!Array.isArray(input.tags)) throw new Error("标签格式无效");
      for (const item of input.tags) {
        if (typeof item !== "string") throw new Error("标签格式无效");
        if (item.trim().length > 50) throw new Error("单个标签过长");
      }
      tags = normalizePromptTags(input.tags);
      if (tags.length > 50) throw new Error("标签数量过多");
    }

    const original = input.id ? this.get(input.id) : undefined;

    const timestamp = now();
    const prompt: Prompt = {
      id: original?.id || id(),
      title,
      body,
      tags,
      starred: original?.starred ?? false,
      createdAt: original?.createdAt || timestamp,
      updatedAt: timestamp,
      deletedAt: null,
    };
    return this.store.set("prompt", prompt.id, prompt);
  }

  star(promptId: string, starred: boolean): Prompt {
    const prompt = this.get(promptId);
    const updated: Prompt = {
      ...prompt,
      starred: !!starred,
    };
    return this.store.set("prompt", updated.id, updated);
  }

  remove(promptId: string): Prompt {
    const prompt = this.get(promptId);
    this.store.delete("prompt", prompt.id);
    return prompt;
  }
}

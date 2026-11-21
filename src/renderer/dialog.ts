import { computed, ref } from "vue";
import type {
  UiDialogButton,
  UiDialogRequest,
  UiDialogTone,
} from "../shared/types";

interface QueueEntry {
  request: UiDialogRequest;
  resolve: (response: number) => void;
}

const queue = ref<QueueEntry[]>([]);

export const activeDialog = computed<UiDialogRequest | null>(
  () => queue.value[0]?.request ?? null,
);

export interface OpenDialogOptions {
  tone?: UiDialogTone;
  title: string;
  message: string;
  detail?: string;
  buttons: (string | UiDialogButton)[];
  defaultId?: number;
  cancelId?: number;
}

let seq = 0;

function normalizeButtons(
  raw: (string | UiDialogButton)[],
): UiDialogButton[] {
  const list = raw
    .map((item) =>
      typeof item === "string"
        ? { label: item, variant: "default" as const }
        : { label: item.label, variant: item.variant || ("default" as const) },
    )
    .filter((item) => !!item.label);
  return list.length ? list : [{ label: "确定", variant: "primary" }];
}

export function openUiDialog(options: OpenDialogOptions): Promise<number> {
  const buttons = normalizeButtons(options.buttons);
  const clamp = (value: number | undefined, fallback: number) => {
    const n = Number.isInteger(value) ? Number(value) : fallback;
    return Math.min(Math.max(0, n), buttons.length - 1);
  };
  const request: UiDialogRequest = {
    id: `local-${++seq}-${Date.now()}`,
    tone: options.tone || "question",
    title: options.title,
    message: options.message,
    detail: options.detail || undefined,
    buttons,
    defaultId: clamp(options.defaultId, buttons.length - 1),
    cancelId: clamp(options.cancelId, 0),
  };
  return new Promise<number>((resolve) => {
    queue.value = [...queue.value, { request, resolve }];
  });
}

export function resolveActiveDialog(response: number) {
  const current = queue.value[0];
  if (!current) return;
  queue.value = queue.value.slice(1);
  const safe =
    Number.isInteger(response) &&
    response >= 0 &&
    response < current.request.buttons.length
      ? response
      : current.request.cancelId;
  current.resolve(safe);
}

export function bindMainDialogs(): () => void {
  if (!window.workbench?.onDialog) return () => {};
  return window.workbench.onDialog((request) => {
    const normalized: UiDialogRequest = {
      ...request,
      buttons: normalizeButtons(request.buttons || []),
    };
    const safeDefault = Math.min(
      Math.max(0, Number(normalized.defaultId) || 0),
      normalized.buttons.length - 1,
    );
    const safeCancel = Math.min(
      Math.max(0, Number(normalized.cancelId) || 0),
      normalized.buttons.length - 1,
    );
    normalized.defaultId = safeDefault;
    normalized.cancelId = safeCancel;
    queue.value = [
      ...queue.value,
      {
        request: normalized,
        resolve: (response) => {
          window.workbench.replyDialog(normalized.id, response);
        },
      },
    ];
  });
}

import type { Note } from "../shared/types.js";
import type { Store } from "./store.js";

type ScheduledTodo = Note & { dueAt: string };

export class TodoReminders {
  private active = false;
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: Promise<void>;
  private refreshQueued = false;
  private retries = new Map<string, number>();

  constructor(
    private store: Store,
    private show: (note: ScheduledTodo) => Promise<boolean>,
    private clock = Date.now,
  ) {}

  private key(note: Pick<Note, "id" | "dueAt">) {
    return `todo-reminder:${note.id}:${note.dueAt}`;
  }

  private pending() {
    return this.store.list<Note>("note").filter((note): note is ScheduledTodo =>
      note.kind === "idea" && !note.completedAt && !note.deletedAt && !!note.dueAt &&
      Number.isFinite(Date.parse(note.dueAt)) &&
      !this.store.get("meta", this.key(note)),
    );
  }

  hasPending() { return this.active && this.pending().length > 0; }

  start() {
    this.active = true;
    this.refresh();
  }

  async stop() {
    this.active = false;
    this.refreshQueued = false;
    clearTimeout(this.timer);
    await this.inFlight;
  }

  refresh() {
    if (!this.active) return;
    if (this.inFlight) this.refreshQueued = true;
    else this.schedule(0);
  }

  private schedule(delay: number) {
    clearTimeout(this.timer);
    if (!this.active || !Number.isFinite(delay)) return;
    this.timer = setTimeout(() => {
      const finish = (next: number) => {
        this.inFlight = undefined;
        const delay = this.refreshQueued ? 0 : next;
        this.refreshQueued = false;
        this.schedule(delay);
      };
      this.inFlight = this.notifyDue().then(finish, () => finish(30_000));
    }, delay);
    this.timer.unref();
  }

  private async notifyDue() {
    const pending = this.pending();
    const keys = new Set(pending.map((note) => this.key(note)));
    for (const key of this.retries.keys()) if (!keys.has(key)) this.retries.delete(key);
    let next = Infinity;
    for (const note of pending) {
      if (!this.active || this.refreshQueued) break;
      const key = this.key(note);
      const scheduledAt = Math.max(Date.parse(note.dueAt), this.retries.get(key) ?? 0);
      if (scheduledAt > this.clock()) {
        next = Math.min(next, scheduledAt);
        continue;
      }
      const current = this.store.get<Note>("note", note.id);
      if (!current || current.deletedAt || current.completedAt || current.dueAt !== note.dueAt) continue;
      if (await this.show({ ...current, dueAt: note.dueAt }).catch(() => false)) {
        this.store.set("meta", key, { shownAt: this.clock() });
        this.retries.delete(key);
      } else {
        const retryAt = this.clock() + 60_000;
        this.retries.set(key, retryAt);
        next = Math.min(next, retryAt);
      }
    }
    return Number.isFinite(next) ? Math.max(0, Math.min(next - this.clock(), 30_000)) : Infinity;
  }
}

import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { notificationActivation, todoNotification } from "../src/core/notifications.js";
import { RecordsService } from "../src/core/records.js";
import { Store } from "../src/core/store.js";
import { TodoReminders } from "../src/core/todo-reminders.js";
import { deadlineFromInput, localDeadline } from "../src/shared/todo-reminders.js";

async function until(check: () => boolean) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (check()) return;
    await delay(5);
  }
  assert.fail("未到达预期的提醒状态");
}

test("待办截止时间可留空、修改或清除，保存并完成使用同一笔事务", () => {
  const store = new Store(":memory:");
  const records = new RecordsService(store, "");
  try {
    const date = "2026-11-24T20:30";
    const deadline = deadlineFromInput(date)!;
    assert.equal(deadlineFromInput(""), null);
    assert.equal(localDeadline(deadline), date);
    assert.throws(() => deadlineFromInput("2026-02-30T20:30"), /有效/);
    const legacy = records.save({ kind: "idea", text: "原有待办" });
    assert.equal(legacy.dueAt, undefined);
    assert.throws(() => records.save({ ...legacy, dueAt: "2026-02-30T20:30:00Z" }), /无效/);
    const timed = records.save({ ...legacy, dueAt: deadline });
    assert.equal(records.save({ kind: "idea", id: timed.id, text: "改正文" }).dueAt, deadline);
    assert.throws(() => records.complete(timed.id, true, { text: "", dueAt: null }));
    assert.equal(records.get(timed.id).dueAt, deadline);
    assert.equal(records.get(timed.id).completedAt, null);
    const complete = records.complete(timed.id, true, { text: "清除日期后完成", dueAt: null });
    assert.equal(complete.dueAt, null);
    assert.ok(complete.completedAt);
  } finally { store.close(); }
});

test("只提醒到期未完成的待办，成功后重启去重，修改截止时间后可再次提醒", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "workbench-todo-"));
  const store = new Store(path.join(directory, "data.sqlite"));
  const records = new RecordsService(store, directory);
  let clock = Date.parse("2026-11-24T12:00:00.000Z");
  const at = (delta: number) => new Date(clock + delta).toISOString();
  const shown: string[] = [];
  let completeShow: () => void = () => {};
  const reminders = new TodoReminders(store, async (note) => {
    shown.push(note.id);
    if (shown.length === 1) await new Promise<void>((done) => { completeShow = done; });
    const options = todoNotification(note);
    assert.match(options.toastXml, /&lt;待办&gt; &amp;/);
    assert.deepEqual(notificationActivation(`workbench:todo:${note.id}`), { kind: "todo", id: note.id });
    return true;
  }, () => clock);
  try {
    records.save({ kind: "idea", text: "无截止时间" });
    const cancelled = records.save({ kind: "idea", text: "已移除时间", dueAt: at(1000) });
    records.save({ ...cancelled, dueAt: null });
    const removed = records.save({ kind: "idea", text: "已删除", dueAt: at(1000) });
    records.remove(removed.id);
    const completed = records.save({ kind: "idea", text: "已完成", dueAt: at(1000) });
    records.complete(completed.id, true);
    const due = records.save({ kind: "idea", text: "<待办> & 提醒", dueAt: at(1000) });
    reminders.start();
    await delay(15);
    assert.deepEqual(shown, []);
    assert.ok(reminders.hasPending());

    clock += 1000;
    reminders.refresh();
    await until(() => shown.length === 1);
    reminders.refresh();
    reminders.refresh();
    completeShow();
    await until(() => !reminders.hasPending());
    await reminders.stop();
    store.close();
    store.reopen();

    reminders.start();
    await delay(15);
    assert.deepEqual(shown, [due.id]);
    const rescheduled = records.save({ ...due, dueAt: at(1000) });
    reminders.refresh();
    clock += 1000;
    reminders.refresh();
    await until(() => !reminders.hasPending());
    assert.deepEqual(shown, [due.id, rescheduled.id]);
  } finally {
    completeShow();
    await reminders.stop();
    store.close();
  }
});

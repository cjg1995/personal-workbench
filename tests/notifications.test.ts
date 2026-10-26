import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { Store } from "../src/core/store.js";
import { TaskManager, StopRequested } from "../src/core/tasks.js";
import {
  projectNotification,
  activationTask,
  taskActivation,
} from "../src/core/notifications.js";

test("项目完成后仅通知真实终态，成功、失败和取消不同；重开不重复；通知失败不改变任务结果", async () => {
  const dir = path.resolve(".local", "notification-fixtures", randomUUID());
  fs.mkdirSync(dir, { recursive: true });
  const store = new Store(path.join(dir, "data.sqlite"));
  const messages: string[] = [];
  const tasks = new TaskManager(
    store,
    dir,
    () => {},
    (task) => {
      const message = projectNotification(task);
      if (message) messages.push(message.title);
    },
  );
  try {
    for (const state of ["success", "failed", "cancelled"]) {
      const task = tasks.create(
        "run",
        "启动 测试项目<&>",
        "employee",
        null,
        {},
      );
      assert.equal(
        messages.length,
        ["success", "failed", "cancelled"].indexOf(state),
      );
      tasks.launch(task, async () => {
        if (state === "failed") throw new Error("fixture failed");
        if (state === "cancelled") throw new StopRequested();
      });
      const done = await tasks.wait(task.id);
      assert.equal(done.state, state);
      const notification = projectNotification(done)!;
      assert.match(notification.toastXml, /&lt;&amp;&gt;/);
      assert.equal(activationTask(taskActivation(task.id)), task.id);
    }
    assert.equal(messages.length, 3);
    assert.match(messages[0], /已完成/);
    assert.match(messages[1], /失败/);
    assert.match(messages[2], /取消/);
    tasks.finished = () => {
      throw new Error("OS unavailable");
    };
    const successful = tasks.create(
      "run",
      "成功但通知失败",
      "employee",
      null,
      {},
    );
    tasks.launch(successful, async () => {});
    assert.equal((await tasks.wait(successful.id)).state, "success");
    new TaskManager(
      store,
      dir,
      () => {},
      () => messages.push("unexpected"),
    );
    assert.equal(messages.length, 3);
    assert.equal(projectNotification({ ...successful, type: "app" }), null);
    for (const input of [
      "workbench:task:../../x",
      "https://example.com",
      "workbench:task:bad",
    ])
      assert.equal(activationTask(input), null);
  } finally {
    store.close();
  }
});

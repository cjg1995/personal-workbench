<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { SubmitCheck, Task } from "../../shared/types";
import {
  attempt,
  call,
  context,
  model,
  navigate,
  notify,
  saveForm,
} from "../state";
import ProjectSelect from "../components/ProjectSelect.vue";
import TaskDetail from "../components/TaskDetail.vue";
const tab = ref<"erp" | "app">(context.value.tab || "erp"),
  projectId = ref<string | null>(
    context.value.projectId ||
      model.formDrafts["submit-" + tab.value]?.projectId ||
      (tab.value === "erp" ? "homeproject" : "employee"),
  );
const check = ref<SubmitCheck | null>(null),
  message = ref(model.formDrafts["submit-" + tab.value]?.message || ""),
  busy = ref(false),
  taskId = ref<string>(
    context.value.taskId ||
      model.tasks.find(
        (t) =>
          t.type === tab.value &&
          t.projectId === projectId.value &&
          ["running", "awaiting", "cancelling"].includes(t.state),
      )?.id ||
      "",
  ),
  file = ref(""),
  patch = ref(""),
  filter = ref("included"),
  query = ref(""),
  fileLimit = ref(200);
watch([filter, query, projectId], () => {
  fileLimit.value = 200;
});
watch(
  message,
  () =>
    saveForm("submit-" + tab.value, {
      projectId: projectId.value,
      message: message.value,
    }),
  { flush: "sync" },
);
const task = computed(() => model.tasks.find((t) => t.id === taskId.value));
const effective = computed(() =>
  task.value?.state === "awaiting"
    ? (task.value.result.check as unknown as SubmitCheck)
    : check.value,
);
const files = computed(
  () =>
    effective.value?.files.filter(
      (f) =>
        (filter.value === "included" ? f.included : !f.included) &&
        (!query.value || f.path.includes(query.value)),
    ) || [],
);
const active = computed(
  () =>
    task.value &&
    ["running", "cancelling", "awaiting"].includes(task.value.state),
);
watch(tab, () => {
  projectId.value = tab.value === "erp" ? "homeproject" : "employee";
});
watch(projectId, () => {
  check.value = null;
  taskId.value = "";
  patch.value = "";
  file.value = "";
  message.value =
    model.formDrafts["submit-" + tab.value]?.projectId === projectId.value
      ? model.formDrafts["submit-" + tab.value]?.message || ""
      : "";
});
async function inspect() {
  busy.value = true;
  await attempt(async () => {
    check.value = await call("git.check", {
      projectId: projectId.value,
      kind: tab.value,
    });
    taskId.value = "";
    patch.value = "";
    file.value = "";
    if (!message.value) message.value = check.value!.defaultMessage;
  });
  busy.value = false;
}
async function run() {
  if (!effective.value) return;
  busy.value = true;
  await attempt(async () => {
    let t: Task;
    if (tab.value === "erp")
      t = await call("git.erp", {
        projectId: projectId.value,
        message: message.value,
        fingerprint: effective.value!.fingerprint,
      });
    else if (task.value?.state === "awaiting")
      t = await call("git.app.finish", {
        taskId: task.value.id,
        message: message.value,
      });
    else
      t = await call("git.app.prepare", {
        projectId: projectId.value,
        fingerprint: effective.value!.fingerprint,
      });
    taskId.value = t.id;
    notify("任务已开始，可离开此页面");
  });
  busy.value = false;
}
async function diff(path: string) {
  file.value = path;
  await attempt(
    async () =>
      (patch.value = (
        await call("git.diff", {
          projectId: projectId.value,
          file: path,
          scope: task.value?.state === "awaiting" ? "staged" : "local",
        })
      ).text),
  );
}
</script>
<template>
  <div class="tabs">
    <button
      :class="{ active: tab === 'erp' }"
      :disabled="!!active"
      @click="tab = 'erp'"
    >
      ERP 提交</button
    ><button
      :class="{ active: tab === 'app' }"
      :disabled="!!active"
      @click="tab = 'app'"
    >
      APP 提交
    </button>
  </div>
  <div class="toolbar">
    <span>{{ tab === "erp" ? "仓库" : "应用" }}</span
    ><ProjectSelect
      v-model="projectId"
      :optional="false"
      :ids="
        tab === 'erp'
          ? ['homeproject', 'homeproject-ai']
          : ['employee', 'projectman', 'worker', 'driver']
      "
      :disabled="!!active"
    /><button :disabled="busy || !!active" @click="inspect">
      {{ busy ? "检查中…" : "检查仓库与预览" }}</button
    ><span v-if="effective" class="blue"
      >{{ effective.branch }} → {{ effective.target }}</span
    >
  </div>
  <p class="path">
    {{ model.config?.projects.find((p) => p.id === projectId)?.path }}
  </p>
  <template v-if="task && task.state !== 'awaiting'"
    ><TaskDetail :task="task" compact /><button
      v-if="!active"
      class="link"
      @click="inspect"
    >
      重新检查当前仓库 →
    </button></template
  >
  <template v-else-if="effective"
    ><div class="step-strip">
      <span class="active"><b>1</b>选择仓库</span
      ><span class="active"><b>2</b>检查与预览</span><span><b>3</b>执行</span
      ><span><b>4</b>结果</span>
    </div>
    <p v-if="task?.state === 'awaiting'" class="notice">
      远程更新完成，本地改动已恢复。取消不会撤销已经完成的远程更新。
    </p>
    <div class="split-editor">
      <section>
        <div class="tabs">
          <button
            :class="{ active: filter === 'included' }"
            @click="filter = 'included'"
          >
            将提交
            {{ effective.files.filter((f) => f.included).length }}</button
          ><button
            :class="{ active: filter === 'excluded' }"
            @click="filter = 'excluded'"
          >
            {{ tab === "erp" ? "未跟踪 / 跳过" : "已排除" }}
            {{ effective.files.filter((f) => !f.included).length }}
          </button>
        </div>
        <input
          v-model="query"
          type="search"
          placeholder="搜索文件路径"
          aria-label="搜索提交文件"
          style="width: 100%; margin-bottom: 12px"
        />
        <p v-if="!files.length" class="empty compact">此分组没有文件。</p>
        <div class="file-list">
          <button
            v-for="f in files.slice(0, fileLimit)"
            :key="f.path"
            class="file-item"
            :class="{ selected: file === f.path }"
            @click="diff(f.path)"
          >
            <span class="file-status" :class="f.status">{{ f.status }}</span
            ><span
              >{{ f.path
              }}<small v-if="f.reason" class="muted" style="display: block">{{
                f.reason
              }}</small></span
            ><small class="push-right muted">{{
              f.staged ? "已暂存" : f.tracked ? "已跟踪" : "未跟踪"
            }}</small>
          </button>
        </div>
        <p v-if="files.length > 200" class="small muted">
          已显示 {{ Math.min(fileLimit, files.length) }} /
          {{ files.length }} 个文件，可按路径搜索。
        </p>
        <button
          v-if="files.length > fileLimit"
          class="link"
          @click="fileLimit += 200"
        >
          再显示 200 个文件
        </button>
        <section class="section-rule">
          <h3>只读差异</h3>
          <pre v-if="patch" class="code-text">{{ patch }}</pre>
          <p v-else class="muted small">
            {{
              file
                ? "此文件没有普通文本差异，未跟踪文件可进入人工审查查看。"
                : "选择文件查看差异。"
            }}
          </p>
          <button
            class="link"
            @click="
              navigate('review', {
                projectId,
                scope: task?.state === 'awaiting' ? 'staged' : 'local',
              })
            "
          >
            在人工审查中查看同一范围 →
          </button>
        </section>
      </section>
      <section>
        <h2>检查项</h2>
        <ul class="check-list">
          <li v-for="c in effective.checks" :key="c.label">
            <span class="mark" :class="{ bad: !c.ok }">{{
              c.ok ? "✓" : "!"
            }}</span>
            <div>
              {{ c.label }}<small>{{ c.detail }}</small>
            </div>
          </li>
        </ul>
        <p v-if="tab === 'app'" class="notice small">
          store/index.js
          始终受保护，不提供绕过选项。其余文件按原纳入与排除规则处理。
        </p>
        <label
          v-if="tab === 'erp' || task?.state === 'awaiting'"
          class="section-rule"
          >提交说明<textarea
            v-model="message"
            rows="4"
            placeholder="填写本次提交说明…"
          />
        </label>
        <p class="small muted">已有未推送提交 {{ effective.ahead }} 个</p>
        <p v-if="effective.testPath" class="path">
          test 工作目录 {{ effective.testPath }}
        </p>
        <p v-if="tab === 'erp'" class="small muted">
          本地提交 → 推送开发分支 → 更新 test → merge → 推送
          test。最终分支按实际结果显示，不自动切回。
        </p>
        <div class="actions wrap">
          <button
            class="primary"
            :disabled="
              busy ||
              !effective.valid ||
              ((tab === 'erp' || task?.state === 'awaiting') &&
                effective.files.some((f) => f.included) &&
                !message.trim())
            "
            @click="run"
          >
            {{
              tab === "erp"
                ? effective.files.some((f) => f.included)
                  ? "确认提交并合并"
                  : "继续推送并合并"
                : task?.state === "awaiting"
                  ? "提交并推送"
                  : "确认更新并保护本地配置"
            }}</button
          ><button
            v-if="task?.state === 'awaiting'"
            @click="
              attempt(
                () => call('task.cancel', { id: task!.id }),
                '已取消提交，远程更新与本地恢复保留',
              )
            "
          >
            取消本次提交
          </button>
        </div>
        <p v-if="!effective.valid" class="error small">
          检查未通过。请在原 Git 工具处理后重新检查。
        </p>
      </section>
    </div></template
  >
  <p v-else class="empty">
    先选择工作目录，检查真实分支、暂存区和文件范围。检查不会提交或推送代码。
  </p>
</template>

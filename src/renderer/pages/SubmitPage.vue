<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import type { SubmitCheck, Task } from "../../shared/types";
import {
  submitPolicyForProject,
  submitProjectIds,
  submitTabForProject,
  type SubmitTab,
} from "../../shared/submit-policy";
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
import Icon from "../components/Icon.vue";
import SubmitDiffEditor from "../components/SubmitDiffEditor.vue";
const props = defineProps<{ projectId?: string; taskId?: string }>();
const tab = ref<SubmitTab>(
    submitTabForProject(props.projectId || context.value.projectId) || context.value.tab || "erp",
  ),
  projectId = ref<string | null>(
    props.projectId || context.value.projectId ||
      model.formDrafts["submit-" + tab.value]?.projectId ||
      submitProjectIds[tab.value][0],
  );
const policy = computed(() =>
  submitPolicyForProject(projectId.value || submitProjectIds[tab.value][0]),
);
const isBackend = computed(() => policy.value.kind === "erp");
const configFile = computed(() =>
  policy.value.kind === "app" ? policy.value.protectedFile : "",
);
function draftMessage(id: string | null) {
  return model.formDrafts["submit-message-" + id]?.message ??
    (model.formDrafts["submit-" + tab.value]?.projectId === id ? model.formDrafts["submit-" + tab.value]?.message : undefined) ??
    model.tasks.find((item) => item.projectId === id && item.type === "app" && item.state === "awaiting")?.params.message ?? "";
}
const diffEditor = ref<InstanceType<typeof SubmitDiffEditor>>();
const check = ref<SubmitCheck | null>(null),
  message = ref<string>(String(draftMessage(projectId.value))),
  busy = ref(false),
  taskId = ref<string>(
    props.taskId ||
      model.tasks.find(
        (t) =>
          t.type === policy.value.kind &&
          t.projectId === projectId.value &&
          ["running", "awaiting", "cancelling"].includes(t.state),
      )?.id ||
      "",
  ),
  file = ref(""),
  filter = ref("included"),
  query = ref(""),
  fileLimit = ref(200);
watch([filter, query, projectId], () => {
  fileLimit.value = 200;
});
watch(
  message,
  () => {
    saveForm("submit-" + tab.value, {
      projectId: projectId.value,
      message: message.value,
    });
    saveForm("submit-message-" + projectId.value, { message: message.value });
  },
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
const needsMessage = computed(
  () =>
    (isBackend.value || task.value?.state === "awaiting") &&
    !!effective.value?.files.some((f) => f.included) &&
    !message.value.trim(),
);
const failedChecks = computed(
  () => effective.value?.checks.filter((c) => !c.ok).length || 0,
);
watch(tab, () => {
  projectId.value = submitProjectIds[tab.value][0];
});
watch(projectId, () => {
  check.value = null;
  taskId.value =
    model.tasks.find(
      (t) =>
        t.type === policy.value.kind &&
        t.projectId === projectId.value &&
        ["running", "awaiting", "cancelling"].includes(t.state),
    )?.id || "";
  file.value = "";
  message.value = String(draftMessage(projectId.value));
});
async function canLeave() { return await diffEditor.value?.canLeave() ?? true; }
defineExpose({ canLeave });
async function inspect() {
  if (!await canLeave()) return;
  busy.value = true;
  await attempt(async () => {
    check.value = await call("git.check", {
      projectId: projectId.value,
      kind: tab.value,
      fromGit: !!props.projectId,
    });
    taskId.value = "";
    file.value = "";
    if (!message.value) message.value = check.value!.defaultMessage;
    const first = check.value!.files.find((item) => item.included);
    if (first) await diff(first.path);
  });
  busy.value = false;
}
async function run() {
  if (!await canLeave() || !effective.value) return;
  busy.value = true;
  await attempt(async () => {
    let t: Task;
    if (isBackend.value)
      t = await call("git.erp", {
        projectId: projectId.value,
        message: message.value,
        fingerprint: effective.value!.fingerprint,
        fromGit: effective.value!.fromGit,
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
        fromGit: effective.value!.fromGit,
        message: message.value,
      });
    taskId.value = t.id;
    notify("任务已开始，可离开此页面");
  });
  busy.value = false;
}
onMounted(() => {
  if (props.projectId && !task.value) void inspect();
  else if (task.value?.state === "awaiting") file.value = effective.value?.files.find((item) => item.included)?.path || "";
});
watch(() => task.value?.state, (state) => {
  if (state === "awaiting") file.value = effective.value?.files.find((item) => item.included)?.path || "";
});
async function diff(path: string) {
  if (path === file.value || !await canLeave()) return;
  file.value = path;
}
async function cancel() {
  if (await canLeave() && task.value) await attempt(() => call("task.cancel", { id: task.value!.id }), "已取消提交，远程更新与本地恢复保留");
}
</script>
<template>
  <div class="submit-page">
  <div class="submit-body">
  <div v-if="!props.projectId" class="tabs">
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
    </button
    ><button
      :class="{ active: tab === 'referrer' }"
      :disabled="!!active"
      @click="tab = 'referrer'"
    >
      推荐官提交
    </button>
  </div>
  <div class="submit-overview">
  <section class="submit-repository">
  <div class="toolbar">
    <ProjectSelect
      v-if="!props.projectId"
      v-model="projectId"
      :optional="false"
      :label="tab === 'app' ? '选择应用' : '选择仓库'"
      :ids="submitProjectIds[tab]"
      :disabled="!!active"
    /><button :disabled="busy || !!active" @click="inspect">
      {{ busy ? "检查中…" : "检查仓库与预览" }}</button
    ><span v-if="effective" class="pill" :title="effective.branch + ' → ' + effective.target"
      >{{ effective.branch }} → {{ effective.target }}</span
    >
  </div>
  <p class="path" :title="model.config?.projects.find((p) => p.id === projectId)?.path">
    {{ model.config?.projects.find((p) => p.id === projectId)?.path }}
  </p>
  <p v-if="props.projectId" class="inline-note">提交已暂存内容与已跟踪修改，新文件请先暂存；筛选不改变提交范围。</p>
  <p v-if="tab === 'referrer' && !isBackend" class="inline-note">
    {{
      policy.kind === 'app' && policy.branch === 'main'
          ? '后台管理前端仅允许在 main 分支提交并推送到 origin/main。'
          : '推荐官小程序仅允许在 dev 分支提交，config.js 按本地测试配置保护并恢复，不纳入提交。'
    }}
  </p>
  </section>
  <section v-if="effective" class="submit-flow">
    <h3>{{ isBackend ? '执行流程与分支去向' : '提交流程' }}</h3>
    <p v-if="isBackend" class="small muted">
      本地提交 → 推送开发分支 → 更新 test → 合并 → 推送 test
    </p>
    <p v-else class="small muted">
      更新远程 → 保护并恢复本地改动 → 核对提交清单 → 提交并推送
    </p>
    <p v-if="isBackend" class="small muted">
      {{ effective.testPath ? '使用已存在的 test 工作目录：' + effective.testPath : '在当前项目目录切换到 test，完成后停留在 test；冲突可直接在 IDEA 中处理。' }}
    </p>
    <p v-if="configFile" class="small muted">{{ configFile }} 始终受保护，不纳入提交。</p>
  </section>
  </div>
  <template v-if="task && task.state !== 'awaiting'"
    ><TaskDetail class="submit-task" :task="task" compact /></template
  >
  <template v-else-if="effective"
    ><p v-if="task?.state === 'awaiting'" class="notice">
      远程更新完成，本地改动已恢复。取消不会撤销已经完成的远程更新。
    </p>
    <section class="submit-checks">
      <div class="section-head">
        <h3>检查项</h3>
        <span v-if="failedChecks" class="pill warn">{{ failedChecks }} 项需注意</span>
      </div>
      <ul class="check-list">
        <li v-for="c in effective.checks" :key="c.label" :title="c.label + '：' + c.detail">
          <span class="mark" :class="{ bad: !c.ok }">{{ c.ok ? '✓' : '!' }}</span>
          <div><span class="submit-check-label">{{ c.label }}</span><small>{{ c.detail }}</small></div>
        </li>
      </ul>
    </section>
    <div class="split-editor submit-workspace">
      <section class="submit-files">
        <div class="tabs" role="group" aria-label="文件范围">
          <button
            :class="{ active: filter === 'included' }"
            :aria-pressed="filter === 'included'"
            @click="filter = 'included'"
          >
            将提交<span class="tab-count">{{
              effective.files.filter((f) => f.included).length
            }}</span></button
          ><button
            :class="{ active: filter === 'excluded' }"
            :aria-pressed="filter === 'excluded'"
            @click="filter = 'excluded'"
          >
            {{ props.projectId ? "未跟踪 / 排除" : isBackend ? "未跟踪 / 跳过" : "已排除" }}<span
              class="tab-count"
              >{{ effective.files.filter((f) => !f.included).length }}</span
            >
          </button>
        </div>
        <input
          v-model="query"
          type="search"
          placeholder="搜索文件路径"
          aria-label="搜索提交文件"
          class="block-filter"
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
              }}<small v-if="f.reason" class="muted sub-line">{{
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
      </section>
        <section class="submit-diff">
          <SubmitDiffEditor ref="diffEditor" :project-id="projectId!" :file="file"
            :task-id="task?.state === 'awaiting' ? task.id : undefined" :from-git="effective.fromGit"
            :protected-file="configFile" @saved="check = $event" />
          <button
            v-if="!props.projectId"
            class="link"
            @click="
              navigate('review', {
                projectId,
                scope: task?.state === 'awaiting' ? 'staged' : 'local',
              })
            "
          >
            在 Git 管理中查看同一范围 →
          </button>
        </section>
    </div></template
  >
  <div v-else class="empty">
    <span class="empty-icon"><Icon name="branch" :size="16" /></span>
    <p class="empty-title">尚未检查仓库</p>
    <p class="empty-hint">
      选择工作目录后点击「检查仓库与预览」，查看真实分支、暂存区和文件范围。检查不会提交或推送代码。
    </p>
  </div>
  </div>
  <footer v-if="effective && (!task || task.state === 'awaiting')" class="submit-footer">
    <label class="submit-footer-message">
      提交说明<textarea v-model="message" rows="2" placeholder="填写本次提交说明…" />
    </label>
    <div class="submit-footer-controls">
      <p class="small muted">将提交 {{ effective.files.filter((f) => f.included).length }} 个文件 · 已有未推送提交 {{ effective.ahead }} 个</p>
      <p v-if="needsMessage" class="small warn">填写提交说明后可继续。</p>
      <p v-if="!effective.valid" class="error small">检查未通过。请处理后重新检查。</p>
        <div class="actions wrap">
          <button
            class="primary"
            :disabled="busy || !effective.valid || needsMessage"
            @click="run"
          >
            {{
              isBackend
                ? effective.files.some((f) => f.included)
                  ? "确认提交并合并"
                  : "继续推送并合并"
                : task?.state === "awaiting"
                  ? "提交并推送"
                  : configFile
                    ? "确认更新并保护本地配置"
                    : "确认更新并预览提交"
            }}</button
          ><button
            v-if="task?.state === 'awaiting'"
            @click="cancel"
          >
            取消本次提交
          </button>
        </div>
    </div>
  </footer>
  </div>
</template>

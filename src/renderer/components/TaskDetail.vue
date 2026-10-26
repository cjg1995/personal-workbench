<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { Task } from "../../shared/types";
import {
  attempt,
  call,
  dateLabel,
  model,
  navigate,
  notify,
  openRecord,
  taskLabels,
} from "../state";
import Icon from "./Icon.vue";
const stageLabels: Record<string, string> = {
  pending: "待执行",
  running: "执行中",
  done: "已完成",
  failed: "失败 / 待处理",
  skipped: "未执行",
};
const props = defineProps<{ task: Task; compact?: boolean }>();
const log = ref<{ text: string; path: string; truncated?: boolean } | null>(
    null,
  ),
  busy = ref(false),
  recoveries = ref<any[]>([]);
const stages = computed(() => props.task.stages);
const clock = ref(Date.now());
const timer = setInterval(() => {
  clock.value = Date.now();
}, 1000);
onBeforeUnmount(() => clearInterval(timer));
function elapsed(start?: string, end?: string | null) {
  if (!start) return "";
  const seconds = Math.max(
    0,
    Math.round(
      ((end ? Date.parse(end) : clock.value) - Date.parse(start)) / 1000,
    ),
  );
  return seconds >= 60
    ? `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`
    : `${seconds} 秒`;
}
const conflicts = computed(
  () =>
    (Array.isArray(props.task.result.conflicts)
      ? props.task.result.conflicts
      : []) as { repo: string; file: string }[],
);
const isActive = computed(() =>
  ["running", "awaiting", "cancelling"].includes(props.task.state),
);
watch(
  () => props.task.id,
  () => {
    log.value = null;
    recoveries.value = [];
  },
);
async function loadLog() {
  log.value = await call("task.log", { id: props.task.id });
}
async function cancel() {
  busy.value = true;
  await attempt(async () => {
    await call("task.cancel", { id: props.task.id });
    notify(
      props.task.state === "awaiting"
        ? "已取消后续提交，远程更新与本地恢复保留"
        : "已请求安全停止",
    );
  });
  busy.value = false;
}
function openOperation() {
  if (props.task.type === "apk")
    navigate("apk", { projectId: props.task.projectId, taskId: props.task.id });
  else if (["app", "erp"].includes(props.task.type))
    navigate("submit", {
      tab: props.task.type === "app" ? "app" : "erp",
      projectId: props.task.projectId,
      taskId: props.task.id,
    });
  else if (["run", "wechat"].includes(props.task.type))
    navigate("projects", { projectId: props.task.projectId });
}
</script>
<template>
  <div>
    <div class="row spaced">
      <div>
        <h2>{{ task.title }}</h2>
        <p class="path">
          {{
            task.params.repo || task.params.android || task.params.target || ""
          }}
        </p>
      </div>
      <span class="status" :class="task.state">{{
        taskLabels[task.state]
      }}</span>
    </div>
    <p v-if="task.error" class="notice warning">{{ task.error }}</p>
    <p v-if="task.state === 'awaiting'" class="notice">
      远程更新与本地恢复已完成，等待核对最终清单并填写提交说明。
    </p>
    <ol class="timeline">
      <li v-for="(s, index) in stages" :key="s.name" :class="s.state">
        <span class="stage-marker"
          ><Icon v-if="s.state === 'done'" name="check" :size="14" /><span
            v-else
            >{{ s.state === "failed" ? "!" : index + 1 }}</span
          ></span
        ><strong>{{ s.name }}</strong
        ><small
          >{{ stageLabels[s.state]
          }}<span v-if="s.startedAt">
            · {{ elapsed(s.startedAt, s.endedAt || task.endedAt) }}</span
          ><br v-if="s.detail" />{{ s.detail }}</small
        >
      </li>
    </ol>
    <div v-if="!compact" class="progress-summary">
      开始 {{ dateLabel(task.startedAt)
      }}<span v-if="task.endedAt"> · 结束 {{ dateLabel(task.endedAt) }}</span> ·
      耗时 {{ elapsed(task.startedAt, task.endedAt) }}<br />任务 ID
      {{ task.id }}
    </div>
    <div v-if="task.result.artifact" class="section-rule">
      <h2>产物信息</h2>
      <dl class="kv">
        <dt>版本 / 包名</dt>
        <dd>
          {{ task.result.versionName }} · {{ task.result.versionCode }}<br />{{
            task.result.packageName
          }}
        </dd>
        <dt>任务专属副本</dt>
        <dd class="path">{{ task.result.artifact }}</dd>
        <dt>SHA256</dt>
        <dd class="path">{{ task.result.sha256 }}</dd>
      </dl>
      <p class="small">
        资源一致性 {{ task.result.resourceCheck }} · 签名
        {{ task.result.signatureCheck }} · 包名与版本
        {{ task.result.versionCheck }}
      </p>
      <div class="actions wrap">
        <button
          class="primary"
          @click="attempt(() => call('apk.folder', { taskId: task.id }))"
        >
          <Icon name="folder" />打开产物目录</button
        ><button
          @click="
            attempt(
              () => call('apk.copy', { taskId: task.id }),
              '已复制 APK 路径',
            )
          "
        >
          <Icon name="copy" />复制 APK 路径
        </button>
      </div>
      <button
        class="link"
        @click="
          openRecord({
            text: task.title + '，版本 ' + task.result.versionName,
            sourceId: 'task:' + task.id,
            projectId: task.projectId,
          })
        "
      >
        记一条工作 →
      </button>
    </div>
    <dl
      v-if="
        task.result.localCommit ||
        task.result.developmentPushed ||
        task.result.testPath
      "
      class="kv small"
    >
      <dt>
        {{ task.result.commitSkipped ? "跳过提交，当前 HEAD" : "本地提交" }}
      </dt>
      <dd class="path">{{ task.result.localCommit || "尚未生成" }}</dd>
      <dt>开发分支推送</dt>
      <dd>
        {{
          task.result.developmentPushed
            ? "已完成"
            : task.result.pushCompleted
              ? "推送命令已完成"
              : task.result.pushSkipped
                ? "没有领先提交，已跳过"
                : "尚未完成"
        }}
      </dd>
      <dt v-if="task.result.testPath">test 工作目录</dt>
      <dd v-if="task.result.testPath" class="path">
        {{ task.result.testPath }}
      </dd>
      <dt v-if="task.result.finalBranch">最终所在分支</dt>
      <dd v-if="task.result.finalBranch">{{ task.result.finalBranch }}</dd>
      <dt v-if="task.type === 'app'">远端核对</dt>
      <dd v-if="task.type === 'app'">
        {{ task.result.verified ? "已核实与本地 HEAD 一致" : "尚未核实成功" }}
      </dd>
    </dl>
    <p v-if="task.result.stashId" class="notice warning">
      本次 stash 保留 {{ task.result.stashId }}。{{
        task.result.stashApplying
          ? "恢复时发生冲突，请在原工具处理，不能反复 apply/pop。"
          : "先处理失败原因，再在原工具核实恢复。"
      }}
    </p>
    <p v-if="task.result.recoveryDir" class="path">
      配置和暂存区备份 {{ task.result.recoveryDir }}
    </p>
    <section v-if="conflicts.length" class="section-rule">
      <h2>冲突文件 {{ conflicts.length }}</h2>
      <p class="small muted">
        在原工具中处理后回到工作台重新检查。已完成的提交和推送保留。
      </p>
      <div
        v-for="c in conflicts"
        :key="c.repo + c.file"
        class="row spaced file-item"
      >
        <span
          ><strong>{{ c.file }}</strong
          ><small class="path" style="display: block">{{ c.repo }}</small></span
        ><button
          class="link"
          @click="
            attempt(() =>
              call('task.conflict-open', {
                id: task.id,
                repo: c.repo,
                file: c.file,
              }),
            )
          "
        >
          在编辑器中打开
        </button>
      </div>
    </section>
    <div class="actions wrap">
      <button
        v-if="isActive"
        :disabled="busy || task.state === 'cancelling'"
        class="danger"
        @click="cancel"
      >
        {{
          task.state === "awaiting" ? "取消本次提交" : "请求安全停止"
        }}</button
      ><button
        v-if="
          !compact && ['app', 'erp', 'apk', 'run', 'wechat'].includes(task.type)
        "
        class="primary"
        @click="openOperation"
      >
        {{
          task.state === "awaiting" ? "返回核对并继续" : "返回功能页重新检查"
        }}</button
      ><button
        v-if="task.projectId"
        @click="
          attempt(() => call('projects.folder', { projectId: task.projectId }))
        "
      >
        打开项目目录
      </button>
    </div>
    <details
      class="section-rule"
      @toggle="($event.target as HTMLDetailsElement).open && attempt(loadLog)"
    >
      <summary>详细日志</summary>
      <p class="small muted">包含本机目录与当前任务输出，敏感值已过滤。</p>
      <div class="row">
        <button class="link" @click="attempt(loadLog)">刷新日志</button
        ><button
          class="link"
          @click="attempt(() => call('task.open-log', { id: task.id }))"
        >
          打开日志文件</button
        ><button
          v-if="log"
          class="link"
          @click="
            attempt(
              () => call('clipboard.text', { text: log!.text }),
              '已复制当前显示的日志',
            )
          "
        >
          复制显示日志
        </button>
      </div>
      <p v-if="log?.truncated" class="notice small">
        这里只显示日志末尾 2 MB，可打开完整日志。
      </p>
      <pre v-if="log" class="log">{{ log.text || "尚无工具输出。" }}</pre>
      <p v-if="log" class="path">{{ log.path }}</p>
    </details>
    <details
      v-if="
        task.type === 'app' &&
        ['partial', 'failed', 'interrupted', 'cancelled'].includes(task.state)
      "
      @toggle="
        ($event.target as HTMLDetailsElement).open &&
        attempt(
          async () =>
            (recoveries = await call('git.recoveries', {
              projectId: task.projectId,
            })),
        )
      "
    >
      <summary>本地配置恢复信息</summary>
      <div v-for="r in recoveries.filter((r) => r.id === task.id)" :key="r.id">
        <p class="small">
          配置 {{ r.restored ? "已经恢复" : "待核实" }} · 阶段 {{ r.phase }}
        </p>
        <p class="path">{{ r.directory }}</p>
        <p v-if="r.stashExists" class="notice warning small">
          本次 stash 仍保留 {{ r.stashId }}，请在原工具核对，不要重复
          apply/pop。
        </p>
        <div class="actions wrap">
          <button
            @click="
              attempt(
                () =>
                  call('git.recover-config', {
                    projectId: task.projectId,
                    id: r.id,
                  }),
                '配置保护已核实恢复',
              )
            "
          >
            从本次备份恢复配置保护</button
          ><button
            v-if="r.restored && r.stashExists"
            @click="
              attempt(
                () =>
                  call('git.recovery-ack', {
                    projectId: task.projectId,
                    id: r.id,
                  }),
                '已记录人工确认，请重新检查仓库',
              )
            "
          >
            已在外部处理，记录确认
          </button>
        </div>
      </div>
    </details>
  </div>
</template>

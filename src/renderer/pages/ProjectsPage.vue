<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import type { RunInfo } from "../../shared/types";
import { attempt, call, context, model, notify, runLabels } from "../state";
import Icon from "../components/Icon.vue";
const runs = ref<
    (RunInfo & {
      canStop?: boolean;
      description?: string;
      deployment?: string;
      port?: number;
    })[]
  >([]),
  selected = ref(context.value.projectId || "homeproject"),
  query = ref(""),
  group = ref(""),
  status = ref(""),
  busy = ref<string | null>(null),
  loading = ref(false),
  log = ref<any>(null),
  rulesDialog = ref<HTMLDialogElement>(),
  rules = ref<{ path: string; text: string }[]>([]),
  rulesBusy = ref(false),
  rulesFor = ref("");
let timer: ReturnType<typeof setInterval> | undefined;
const selectedProject = computed(() =>
  model.config?.projects.find((p) => p.id === selected.value),
);
const current = computed(() =>
  runs.value.find((r) => r.projectId === selected.value),
);
const groups = computed(() =>
  ["HomeProject", "推荐官"]
    .filter((g) => !group.value || group.value === g)
    .map((g) => ({
      name: g,
      projects:
        model.config?.projects.filter(
          (p) =>
            p.group === g &&
            (!query.value ||
              p.name.toLowerCase().includes(query.value.toLowerCase())) &&
            (!status.value ||
              runs.value.find((r) => r.projectId === p.id)?.state ===
                status.value),
        ) || [],
    })),
);
const run = (id: string) => runs.value.find((r) => r.projectId === id);
const types: Record<string, string> = {
  tomcat: "Java / Tomcat",
  spring: "Spring Boot",
  h5: "UniApp H5",
  vue: "Vue 前端",
  wechat: "微信原生小程序",
  "uni-wechat": "UniApp 小程序",
};
async function refresh() {
  if (loading.value) return;
  loading.value = true;
  try {
    runs.value = await call("projects.list");
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), true);
  } finally {
    loading.value = false;
  }
}
async function act(action: string, id: string) {
  busy.value = id;
  await attempt(async () => {
    await call("projects." + action, { projectId: id });
    await refresh();
    notify(
      action === "stop"
        ? "停止结果已核实"
        : action === "start"
          ? "已检查并启动，请关注就绪状态"
          : "操作已执行",
    );
  });
  busy.value = null;
}
async function openRules() {
  const project = selectedProject.value;
  if (!project) return;
  rulesFor.value = project.name;
  rules.value = [];
  rulesBusy.value = true;
  rulesDialog.value?.showModal();
  await attempt(async () => {
    rules.value = await call("review.rules", { projectId: project.id });
  });
  rulesBusy.value = false;
}
onMounted(() => {
  void refresh();
  timer = setInterval(refresh, 9000);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>
<template>
  <div class="toolbar">
    <select v-model="group" aria-label="项目分组">
      <option value="">全部项目</option>
      <option>HomeProject</option>
      <option>推荐官</option></select
    ><select v-model="status" aria-label="项目运行状态">
      <option value="">全部状态</option>
      <option v-for="(label, key) in runLabels" :key="key" :value="key">
        {{ label }}
      </option></select
    ><input
      v-model="query"
      type="search"
      placeholder="搜索项目名称"
      aria-label="搜索项目"
    /><button
      class="link push-right"
      :disabled="loading"
      :aria-busy="loading"
      @click="refresh"
    >
      <Icon name="refresh" :size="15" />{{ loading ? "检测中…" : "重新检测" }}
    </button>
  </div>
  <table class="table">
    <thead>
      <tr>
        <th>项目</th>
        <th>类型</th>
        <th>实际状态</th>
        <th>操作</th>
      </tr>
    </thead>
    <tbody>
      <tr v-if="!groups.some((g) => g.projects.length)" class="table-empty">
        <td colspan="4">没有匹配的工作目录，调整筛选条件后再试。</td>
      </tr>
      <template v-for="g in groups" :key="g.name"
        ><tr class="group-row">
          <td colspan="4">
            {{ g.name }} ·
            {{
              model.config?.projects.filter((p) => p.group === g.name).length
            }}
            个工作目录
          </td>
        </tr>
        <tr
          v-for="p in g.projects"
          :key="p.id"
          class="click-row"
          :class="{ selected: p.id === selected }"
          @click="
            selected = p.id;
            log = null;
          "
        >
          <td>
            <span class="row project-name"
              ><Icon
                :name="
                  p.type === 'tomcat' || p.type === 'spring'
                    ? 'folder'
                    : p.type === 'wechat' || p.type === 'uni-wechat'
                      ? 'link'
                      : p.type === 'vue'
                        ? 'code'
                        : 'file'
                "
                :size="20"
              />{{ p.name }}</span
            >
          </td>
          <td class="small">{{ types[p.type] }}</td>
          <td>
            <span
              v-if="run(p.id)"
              class="status"
              :class="
                run(p.id)!.state === 'running'
                  ? 'running-service'
                  : run(p.id)!.state
              "
              >{{ runLabels[run(p.id)!.state] }}</span
            ><span v-else class="muted small">{{
              loading ? "检测中…" : "状态未知"
            }}</span>
          </td>
          <td>
            <div class="row row-actions" @click.stop>
              <button
                v-if="p.type === 'wechat'"
                class="link"
                :disabled="busy === p.id"
                @click="act('wechat', p.id)"
              >
                打开开发者工具</button
              ><template v-else
                ><button
                  v-if="['stopped', 'failed'].includes(run(p.id)?.state || '')"
                  class="link"
                  :disabled="busy === p.id"
                  @click="act('start', p.id)"
                >
                  启动</button
                ><button
                  v-if="run(p.id)?.state === 'running'"
                  class="link"
                  @click="act('url', p.id)"
                >
                  打开页面</button
                ><button
                  v-if="p.type === 'uni-wechat'"
                  class="link"
                  :disabled="busy === p.id || run(p.id)?.state === 'starting'"
                  @click="act('wechat', p.id)"
                >
                  打开开发者工具</button
                ><span
                  v-if="run(p.id)?.state === 'starting'"
                  class="muted small"
                  >等待就绪</span
                ><button
                  v-if="run(p.id)?.canStop"
                  class="link"
                  :disabled="busy === p.id"
                  @click="act('stop', p.id)"
                >
                  {{ p.type === "uni-wechat" ? "停止监听" : "停止" }}</button
                ><button
                  v-if="run(p.id)?.state === 'external' && p.type !== 'uni-wechat'"
                  class="link"
                  @click="act('ide', p.id)"
                >
                  在原工具中管理</button
                ><span
                  v-if="
                    ['unknown', 'unconfigured'].includes(
                      run(p.id)?.state || '',
                    ) && !run(p.id)?.canStop
                  "
                  class="muted small"
                  >查看详情</span
                ></template
              >
              <button
                v-if="run(p.id)?.canStop"
                class="link"
                @click="act('restart', p.id)"
              >
                重新启动</button
              ><button
                v-if="!['wechat', 'uni-wechat'].includes(p.type)"
                class="link"
                @click="act('ide', p.id)"
              >
                打开 IDE</button
              ><button class="link" @click="act('folder', p.id)">
                打开目录
              </button>
            </div>
          </td>
        </tr></template
      >
    </tbody>
  </table>
  <section v-if="selectedProject" class="section-rule">
    <div class="row spaced">
      <h2>{{ selectedProject.name }}</h2>
      <span class="status" :class="current?.state">{{
        runLabels[current?.state || "unknown"]
      }}</span>
    </div>
    <p
      v-if="current?.message"
      :class="
        ['unconfigured', 'unknown', 'failed'].includes(current.state)
          ? 'notice warning'
          : 'muted small'
      "
    >
      {{ current.message }}
    </p>
    <dl class="kv">
      <dt>工作目录</dt>
      <dd class="path">{{ selectedProject.path }}</dd>
      <dt>当前分支</dt>
      <dd>{{ current?.branch || "尚未核实 / 非 Git 目录" }}</dd>
      <dt>运行环境</dt>
      <dd>{{ current?.description || types[selectedProject.type] }}</dd>
      <dt v-if="current?.deployment">现有部署</dt>
      <dd v-if="current?.deployment" class="path">{{ current.deployment }}</dd>
      <dt>实际地址</dt>
      <dd>{{ current?.url || "尚无经过核实的可用地址" }}</dd>
      <dt>进程归属</dt>
      <dd>
        {{
          current?.canStop
            ? "工作台拥有且身份核实"
            : current?.state === "external"
              ? "外部实例，请用原工具管理"
              : "未核实为工作台运行实例"
        }}
      </dd>
    </dl>
    <p class="small muted">
      {{
        selectedProject.group === "推荐官"
          ? "推荐官后端还依赖 HomeProject API。"
          : "项目按现有配置访问所需后端和本地环境。"
      }}工作台不自动启动数据库、Redis 或未选择的依赖服务。
    </p>
    <div class="actions">
      <button
        @click="
          attempt(
            async () =>
              (log = await call('projects.log', { projectId: selected })),
          )
        "
      >
        查看工作台日志</button
      ><button @click="openRules">项目规则</button
      ><button @click="act('folder', selected)">打开目录</button>
    </div>
    <pre v-if="log" class="log">{{ log.text }}</pre>
  </section>
  <dialog
    ref="rulesDialog"
    class="rules-dialog"
    aria-labelledby="project-rules-title"
    @cancel.prevent="rulesDialog?.close()"
  >
    <div class="dialog-head">
      <h2 id="project-rules-title">{{ rulesFor }} · 项目规则</h2>
      <button
        class="dialog-close"
        aria-label="关闭项目规则"
        @click="rulesDialog?.close()"
      >
        <Icon name="close" :size="15" />
      </button>
    </div>
    <p v-if="rulesBusy" class="loading" role="status">正在读取规则文件…</p>
    <template v-else
      ><div v-for="rule in rules" :key="rule.path" class="rule-block">
        <p class="path">{{ rule.path }}</p>
        <pre class="rule-text">{{ rule.text }}</pre>
      </div>
      <p v-if="!rules.length" class="muted small">
        此项目没有自己的规则文件。
      </p></template
    >
  </dialog>
</template>

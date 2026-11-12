<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onBeforeUnmount,
  onDeactivated,
  ref,
  watch,
} from "vue";
import type { RunInfo } from "../../shared/types";
import {
  attempt,
  call,
  context,
  model,
  notify,
  route,
  runLabels,
} from "../state";
import CloseButton from "../components/CloseButton.vue";
import RunLog from "../components/RunLog.vue";
const runs = ref<
    (RunInfo & {
      canStop?: boolean;
      description?: string;
      deployment?: string;
      port?: number;
      url?: string;
      message?: string;
    })[]
  >([]),
  selected = ref(context.value.projectId || "homeproject"),
  query = ref(""),
  group = ref(""),
  busy = ref<string | null>(null),
  loading = ref(false),
  log = ref<any>(null),
  rulesDialog = ref<HTMLDialogElement>(),
  rules = ref<{ path: string; text: string }[]>([]),
  rulesBusy = ref(false),
  rulesFor = ref("");
let timer: ReturnType<typeof setInterval> | undefined;
const pageRoot = ref<HTMLElement>();
const scrollPositions = new Map<HTMLElement, { top: number; left: number }>();
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
              p.name.toLowerCase().includes(query.value.toLowerCase())),
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
function primaryAction(id: string) {
  const project = model.config?.projects.find((item) => item.id === id);
  const info = run(id);
  if (!project) return null;
  if (project.type === "wechat")
    return { action: "wechat", label: "打开开发者工具" };
  if (!info) return null;
  if (["stopped", "failed"].includes(info.state))
    return {
      action: "start",
      label: "启动",
      title: "只启动此项目，不自动启动数据库或依赖服务",
    };
  if (
    project.type === "uni-wechat" &&
    ["running", "watching", "tool-open"].includes(info.state)
  )
    return { action: "wechat", label: "打开开发者工具" };
  if (info.state === "external")
    return { action: "ide", label: "在原工具中管理" };
  return null;
}
function shownRunMessage(info?: { state?: string; message?: string } | null) {
  const message = info?.message?.trim() || "";
  if (!message) return "";
  if (["failed", "unconfigured", "unknown", "external"].includes(info?.state || ""))
    return message;
  if (
    /请|重试|未能|失败|错误|不可用|占用|无法|不存在|未打开|未标记|需要|冲突/.test(
      message,
    )
  )
    return message;
  return "";
}
function stopLabel(id: string) {
  return model.config?.projects.find((item) => item.id === id)?.type ===
    "uni-wechat"
    ? "停止监听"
    : "停止";
}
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
const liveStates = ["starting", "running", "watching", "stopping", "tool-open"];
let liveToken = 0;
let livePaused = false;
let liveBusy = false;
let liveWanted = false;
let liveTimer: ReturnType<typeof setTimeout> | undefined;
let logSession = 0;
function clearLiveTimer() {
  if (liveTimer) clearTimeout(liveTimer);
  liveTimer = undefined;
}
function stopLive() {
  liveToken++;
  livePaused = false;
  liveWanted = false;
  clearLiveTimer();
}
function pauseLive() {
  livePaused = true;
  clearLiveTimer();
}
function scheduleLive(token: number, id: string, session: number) {
  if (token !== liveToken || livePaused) return;
  clearLiveTimer();
  liveTimer = setTimeout(() => void tickLive(token, id, session), 400);
}
async function tickLive(token: number, id: string, session: number) {
  if (token !== liveToken || livePaused || liveBusy) return;
  liveBusy = true;
  let keepGoing = false;
  try {
    const from = log.value?.projectId === id ? log.value.offset || 0 : 0;
    const next = await call<{
      text: string;
      offset: number;
      path: string;
      reset: boolean;
      active: boolean;
    }>("projects.log", { projectId: id, offset: from });
    if (token !== liveToken) return;
    const same =
      !!log.value?.path &&
      log.value.path === next.path &&
      !next.reset &&
      from > 0;
    if (same && log.value) {
      const text = log.value.text + next.text;
      log.value = {
        ...log.value,
        text: text.length > 1024 * 1024 ? text.slice(-1024 * 1024) : text,
        offset: next.offset,
        session,
      };
    } else {
      log.value = {
        text: next.text,
        offset: next.offset,
        path: next.path,
        projectId: id,
        session,
      };
    }
    keepGoing = !!next.active;
    if (!keepGoing) liveWanted = false;
  } catch (e) {
    if (token !== liveToken) return;
    const state = run(id)?.state || "";
    if (!liveStates.includes(state)) {
      liveWanted = false;
      notify(e instanceof Error ? e.message : String(e), true);
      return;
    }
    keepGoing = true;
  } finally {
    liveBusy = false;
  }
  if (keepGoing) scheduleLive(token, id, session);
}
function selectProject(id: string) {
  if (id === selected.value) return;
  stopLive();
  log.value = null;
  selected.value = id;
}
function beginLive(id: string) {
  stopLive();
  liveWanted = true;
  const token = liveToken;
  const session = ++logSession;
  log.value = { text: "", offset: 0, path: "", projectId: id, session };
  void tickLive(token, id, session);
}
function resumeLive() {
  const current = log.value;
  if (!liveWanted || !current?.projectId) return;
  livePaused = false;
  void tickLive(liveToken, current.projectId, current.session);
}
function applyContext() {
  if (route.value !== "projects") return false;
  const id = context.value.projectId;
  if (typeof id !== "string" || !id || id === selected.value) return false;
  selectProject(id);
  return true;
}
function rememberScroll() {
  scrollPositions.clear();
  const root = pageRoot.value;
  if (!root) return;
  for (const element of [root, ...Array.from(root.querySelectorAll<HTMLElement>("*"))])
    if (
      element.scrollHeight > element.clientHeight ||
      element.scrollWidth > element.clientWidth
    )
      scrollPositions.set(element, {
        top: element.scrollTop,
        left: element.scrollLeft,
      });
}
function restoreScroll() {
  for (const [element, position] of scrollPositions)
    if (element.isConnected) element.scrollTo(position);
}
function startStatusTimer() {
  if (timer) clearInterval(timer);
  timer = setInterval(() => void refresh(), 9000);
}
watch(
  route,
  (next, previous) => {
    if (previous !== "projects" || next === "projects") return;
    rememberScroll();
  },
  { flush: "sync" },
);
async function act(action: string, id: string) {
  const live = action === "start" || action === "restart";
  if (live) {
    stopLive();
    selected.value = id;
    log.value = {
      text: "",
      offset: 0,
      path: "",
      projectId: id,
      session: ++logSession,
    };
  }
  busy.value = id;
  const started = await attempt(async () => {
    await call("projects." + action, { projectId: id });
    await refresh();
    notify(
      action === "stop"
        ? "停止结果已核实"
        : action === "start"
          ? "已检查并启动，日志会持续更新"
          : action === "restart"
            ? "已重新启动，日志会持续更新"
            : "操作已执行",
    );
    return true;
  });
  busy.value = null;
  if (!live) return;
  if (started) beginLive(id);
  else log.value = null;
}
async function runAction(action: string, id: string) {
  selected.value = id;
  if (action === "copy") {
    const url = run(id)?.url;
    if (!url) return;
    await attempt(async () => {
      await call("clipboard.text", { text: url });
      notify("已复制地址");
    });
    return;
  }
  if (action === "rules") {
    await openRules();
    return;
  }
  if (action === "log") {
    beginLive(id);
    return;
  }
  await act(action, id);
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
onActivated(async () => {
  const switched = applyContext();
  startStatusTimer();
  await nextTick();
  if (switched)
    pageRoot.value
      ?.querySelector(".project-item.selected")
      ?.scrollIntoView({ block: "nearest" });
  else restoreScroll();
  resumeLive();
  void refresh();
});
onDeactivated(() => {
  if (timer) clearInterval(timer);
  timer = undefined;
  pauseLive();
  if (rulesDialog.value?.open) rulesDialog.value.close();
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
  stopLive();
});
</script>
<template>
  <div ref="pageRoot" class="projects-page">
  <div class="projects-workspace">
    <section class="projects-list">
      <div class="projects-toolbar">
        <select v-model="group" aria-label="项目分组">
          <option value="">全部项目</option>
          <option>HomeProject</option>
          <option>推荐官</option>
        </select>
        <input
          v-model="query"
          type="search"
          placeholder="搜索项目"
          aria-label="搜索项目"
        />
      </div>
      <div class="projects-scroll">
        <p v-if="!groups.some((g) => g.projects.length)" class="empty compact">
          没有匹配的工作目录
        </p>
        <template v-for="g in groups" :key="g.name">
          <p class="project-group">{{ g.name }}</p>
          <div
            v-for="p in g.projects"
            :key="p.id"
            class="project-item"
            :class="{ selected: p.id === selected }"
            @click="selectProject(p.id)"
          >
            <div class="project-item-main">
              <strong class="project-name">{{ p.name }}</strong>
              <small
                >{{ types[p.type] }}
                <span
                  v-if="run(p.id)"
                  class="status"
                  :class="
                    run(p.id)!.state === 'running'
                      ? 'running-service'
                      : run(p.id)!.state
                  "
                  :title="shownRunMessage(run(p.id)) || undefined"
                  >{{ runLabels[run(p.id)!.state] }}</span
                ><span v-else class="muted">{{
                  loading ? "检测中…" : "状态未知"
                }}</span>              </small
              >
            </div>
            <div class="project-item-actions" @click.stop>
              <button
                v-if="primaryAction(p.id)"
                class="primary"
                :disabled="busy === p.id"
                :title="primaryAction(p.id)?.title"
                @click="runAction(primaryAction(p.id)!.action, p.id)"
              >
                {{ primaryAction(p.id)!.label }}
              </button>
              <button
                v-if="
                  p.type === 'uni-wechat' &&
                  primaryAction(p.id)?.action !== 'wechat'
                "
                :disabled="busy === p.id || run(p.id)?.state === 'starting'"
                @click="runAction('wechat', p.id)"
              >
                打开开发者工具
              </button>
              <button
                v-if="run(p.id)?.canStop"
                :disabled="busy === p.id"
                @click="runAction('stop', p.id)"
              >
                {{ stopLabel(p.id) }}
              </button>
              <span
                v-else-if="run(p.id)?.state === 'starting'"
                class="muted small"
                >启动中</span
              >
            </div>
          </div>
        </template>
      </div>
    </section>
    <section v-if="selectedProject" class="projects-detail">
      <div class="section-head">
        <h2>{{ selectedProject.name }}</h2>
        <span class="status" :class="current?.state">{{
          runLabels[current?.state || "unknown"]
        }}</span>
      </div>
      <p
        v-if="shownRunMessage(current)"
        :class="
          ['unconfigured', 'unknown', 'failed'].includes(current!.state)
            ? 'notice warning'
            : 'muted small'
        "
      >
        {{ shownRunMessage(current) }}
      </p>
      <div class="projects-actions">
        <button @click="runAction('editor', selected)" title="在独立窗口编辑项目代码">
          代码编辑
        </button>
        <button
          v-if="primaryAction(selected)"
          class="primary"
          :disabled="busy === selected"
          :title="primaryAction(selected)?.title"
          @click="runAction(primaryAction(selected)!.action, selected)"
        >
          {{ primaryAction(selected)!.label }}
        </button>
        <button
          v-if="
            selectedProject.type === 'uni-wechat' &&
            primaryAction(selected)?.action !== 'wechat'
          "
          :disabled="busy === selected || current?.state === 'starting'"
          @click="runAction('wechat', selected)"
        >
          打开开发者工具
        </button>
        <button
          v-if="current?.canStop"
          :disabled="busy === selected"
          @click="runAction('stop', selected)"
        >
          {{ stopLabel(selected) }}
        </button>
        <button
          v-if="
            !['wechat', 'uni-wechat'].includes(selectedProject.type) &&
            primaryAction(selected)?.action !== 'ide'
          "
          :disabled="busy === selected"
          @click="runAction('ide', selected)"
        >
          打开 IDE
        </button>
        <button :disabled="busy === selected" @click="runAction('folder', selected)">
          打开目录
        </button>
        <button @click="runAction('rules', selected)">项目规则</button>
        <button @click="runAction('log', selected)">查看日志</button>
      </div>
      <dl class="kv">
        <dt>工作目录</dt>
        <dd class="path" :title="selectedProject.path">{{ selectedProject.path }}</dd>
        <dt>当前分支</dt>
        <dd>{{ current?.branch || "尚未核实 / 非 Git 目录" }}</dd>
        <dt>运行环境</dt>
        <dd>{{ current?.description || types[selectedProject.type] }}</dd>
        <dt v-if="current?.port">端口</dt>
        <dd v-if="current?.port">{{ current.port }}</dd>
        <dt v-if="current?.deployment">现有部署</dt>
        <dd v-if="current?.deployment" class="path" :title="current.deployment">
          {{ current.deployment }}
        </dd>
        <dt>实际地址</dt>
        <dd class="address-line">
          <span class="path" :title="current?.url">{{
            current?.url || "尚无经过核实的可用地址"
          }}</span>
          <button v-if="current?.url" @click="runAction('url', selected)">
            打开
          </button>
        </dd>
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
      <p v-if="selectedProject.group === '推荐官'" class="small muted">
        后端依赖 HomeProject API，工作台不会代为启动。
      </p>
      <RunLog v-if="log" :key="log.session" :text="String(log.text ?? '')" />
    </section>
  </div>
  <dialog
    ref="rulesDialog"
    class="rules-dialog"
    aria-labelledby="project-rules-title"
    @cancel.prevent="rulesDialog?.close()"
  >
    <div class="dialog-head">
      <h2 id="project-rules-title">{{ rulesFor }} · 项目规则</h2>
      <CloseButton label="关闭项目规则" @click="rulesDialog?.close()" />
    </div>
    <div class="rules-dialog-body">
      <p v-if="rulesBusy" class="loading" role="status">正在读取规则文件…</p>
      <template v-else>
        <div v-for="rule in rules" :key="rule.path" class="rule-block">
          <p class="path">{{ rule.path }}</p>
          <pre class="rule-text">{{ rule.text }}</pre>
        </div>
        <p v-if="!rules.length" class="muted small">此项目没有自己的规则文件。</p>
      </template>
    </div>
  </dialog>
  </div>
</template>

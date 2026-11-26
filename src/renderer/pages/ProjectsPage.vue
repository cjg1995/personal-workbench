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
import Icon from "../components/Icon.vue";

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
  collapsedGroups = ref<Record<string, boolean>>({}),
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

const liveStates = ["starting", "running", "watching", "stopping", "tool-open"];

const allProjects = computed(() => model.config?.projects || []);
const groupNames = computed(() => {
  const ordered = ["HomeProject", "推荐官"];
  for (const p of allProjects.value) {
    if (p.group && !ordered.includes(p.group)) ordered.push(p.group);
  }
  return ordered.filter((g) => allProjects.value.some((p) => p.group === g));
});

const selectedProject = computed(
  () =>
    allProjects.value.find((p) => p.id === selected.value) ||
    allProjects.value[0],
);

watch(
  allProjects,
  (list) => {
    if (list.length && !list.some((p) => p.id === selected.value)) {
      selected.value = list[0].id;
    }
  },
  { immediate: true },
);

const current = computed(() =>
  runs.value.find((r) => r.projectId === selectedProject.value?.id),
);

const runningCount = computed(
  () =>
    runs.value.filter((r) =>
      ["running", "watching", "external", "tool-open"].includes(r.state),
    ).length,
);

const groups = computed(() =>
  groupNames.value
    .filter((g) => !group.value || group.value === g)
    .map((g) => ({
      name: g,
      projects: allProjects.value.filter(
        (p) =>
          p.group === g &&
          (!query.value ||
            p.name.toLowerCase().includes(query.value.toLowerCase())),
      ),
    }))
    .filter((g) => g.projects.length > 0),
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

function techIcon(project: { type: string }) {
  if (project.type === "spring" || project.type === "tomcat")
    return { icon: "server", cls: "server" };
  return { icon: "web", cls: "web" };
}

function shortEnvLabel(type: string, description?: string) {
  if (type === "spring") {
    const appMatch = description?.match(/\b([A-Z][A-Za-z0-9]+Application)\b/);
    return appMatch ? `Maven · ${appMatch[1]}` : "Maven · Spring Boot";
  }
  if (type === "tomcat") return "Java · Tomcat";
  if (type === "vue") return "Vue · DevServer";
  if (type === "h5") return "UniApp · H5";
  if (type === "uni-wechat") return "UniApp · 微信小程序";
  if (type === "wechat") return "微信原生小程序";
  return types[type] || description || "—";
}

function isLiveState(state?: string) {
  return !!state && ["running", "watching", "tool-open"].includes(state);
}

function badgeClass(state?: string) {
  if (!state || state === "stopped") return "neutral";
  if (["running", "watching", "tool-open"].includes(state)) return "live";
  if (state === "external") return "brand";
  if (["starting", "stopping", "unconfigured", "unknown"].includes(state))
    return "pending";
  if (state === "failed") return "danger";
  return "neutral";
}

const hostLabel = computed(() => {
  const url = current.value?.url;
  if (url) {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }
  return current.value?.port ? `localhost:${current.value.port}` : "";
});

function primaryAction(id: string) {
  const project = model.config?.projects.find((item) => item.id === id);
  const info = run(id);
  if (!project) return null;
  if (info?.canStop)
    return { action: "stop", label: stopLabel(id), icon: "stop" };
  if (project.type === "wechat")
    return { action: "wechat", label: "打开微信开发者工具", icon: "external" };
  if (!info) return null;
  if (["stopped", "failed", "starting"].includes(info.state))
    return {
      action: "start",
      label: "启动",
      icon: "play",
      disabled: info.state === "starting",
      title: info.state === "starting"
        ? "启动中"
        : "只启动此项目，不自动启动数据库或依赖服务",
    };
  if (info.state === "external")
    return { action: "ide", label: "在原工具中管理", icon: "external" };
  return null;
}

const selectedAction = computed(() =>
  selectedProject.value ? primaryAction(selectedProject.value.id) : null,
);

function shownRunMessage(info?: { state?: string; message?: string } | null) {
  const message = info?.message?.trim() || "";
  if (!message || info?.state === "external") return "";
  if (["failed", "unconfigured", "unknown"].includes(info?.state || ""))
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

function toggleGroup(name: string) {
  collapsedGroups.value = {
    ...collapsedGroups.value,
    [name]: !collapsedGroups.value[name],
  };
}

async function refresh() {
  if (loading.value) return;
  loading.value = true;
  try {
    runs.value = await call("projects.list");
    const selId = selectedProject.value?.id;
    const selRun = selId ? run(selId) : undefined;
    if (
      selId &&
      selRun &&
      liveStates.includes(selRun.state) &&
      log.value?.projectId !== selId
    ) {
      beginLive(selId);
    }
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), true);
  } finally {
    loading.value = false;
  }
}

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
  const info = run(id);
  if (info && liveStates.includes(info.state)) {
    beginLive(id);
  }
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
  const cur = log.value;
  if (!liveWanted || !cur?.projectId) return;
  livePaused = false;
  void tickLive(liveToken, cur.projectId, cur.session);
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
  for (const element of [
    root,
    ...Array.from(root.querySelectorAll<HTMLElement>("*")),
  ])
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
        ? "项目已停止"
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
    <div class="duo project-layout">
      <!-- 左侧项目列表卡片 -->
      <section class="card pane">
        <div class="panel-head">
          <div class="head-title">
            <Icon name="folders" :size="17" />
            <h2>项目列表</h2>
            <span class="count">{{ allProjects.length }}</span>
          </div>
          <span v-if="runningCount" class="badge live">
            <i class="dot" />{{ runningCount }} 个运行中
          </span>
        </div>

        <div class="project-filter">
          <label class="search-box" style="margin: 0">
            <Icon name="search" :size="14" />
            <input
              v-model="query"
              type="search"
              placeholder="搜索项目"
              aria-label="搜索项目"
            />
          </label>
          <select v-model="group" aria-label="项目分组">
            <option value="">全部分组</option>
            <option v-for="g in groupNames" :key="g" :value="g">{{ g }}</option>
          </select>
        </div>

        <div class="project-groups">
          <div v-if="!groups.length" class="empty compact">
            <span>没有匹配的工作目录</span>
          </div>
          <template v-for="g in groups" :key="g.name">
            <button
              type="button"
              class="group-label"
              :class="{ collapsed: !!collapsedGroups[g.name] }"
              :aria-expanded="!collapsedGroups[g.name]"
              @click="toggleGroup(g.name)"
            >
              <Icon name="down" :size="11" />
              <span>{{ g.name }}</span>
              <small>{{ g.projects.length }}</small>
            </button>

            <template v-if="!collapsedGroups[g.name]">
              <div
                v-for="p in g.projects"
                :key="p.id"
                class="project-item"
                :class="{ selected: p.id === selectedProject?.id }"
                role="button"
                tabindex="0"
                @click="selectProject(p.id)"
                @keydown.enter="selectProject(p.id)"
              >
                <span class="tech-icon" :class="techIcon(p).cls">
                  <Icon :name="techIcon(p).icon" :size="16" />
                </span>
                <div class="grow">
                  <strong class="project-name" :title="p.name">{{
                    p.name
                  }}</strong>
                  <small class="project-sub">
                    <span>{{ types[p.type] }}</span>
                    <template
                      v-if="
                        run(p.id) &&
                        run(p.id)!.state !== 'stopped' &&
                        run(p.id)!.state !== 'unknown'
                      "
                    >
                      <span class="sep-inline" aria-hidden="true">·</span>
                      <strong
                        v-if="isLiveState(run(p.id)!.state)"
                        class="live-word"
                        >{{ runLabels[run(p.id)!.state] }}</strong
                      >
                      <span v-else class="state-word">{{
                        runLabels[run(p.id)!.state]
                      }}</span>
                    </template>
                  </small>
                </div>
                <div @click.stop>
                  <button
                    v-if="run(p.id)?.canStop"
                    type="button"
                    class="run-action live"
                    :disabled="busy === p.id"
                    :title="stopLabel(p.id)"
                    :aria-label="`${stopLabel(p.id)} ${p.name}`"
                    @click="runAction('stop', p.id)"
                  >
                    <Icon name="stop" :size="15" />
                  </button>
                  <span
                    v-else-if="run(p.id)?.state === 'starting'"
                    class="spinner"
                    title="启动中"
                  />
                  <button
                    v-else-if="primaryAction(p.id)?.action === 'start'"
                    type="button"
                    class="run-action"
                    :disabled="busy === p.id"
                    :title="primaryAction(p.id)?.title || '启动项目'"
                    :aria-label="`启动 ${p.name}`"
                    @click="runAction('start', p.id)"
                  >
                    <Icon name="play" :size="15" />
                  </button>
                  <button
                    v-else-if="primaryAction(p.id)?.action === 'ide'"
                    type="button"
                    class="run-action"
                    :disabled="busy === p.id"
                    title="在原工具中管理"
                    :aria-label="`在原工具中管理 ${p.name}`"
                    @click="runAction('ide', p.id)"
                  >
                    <Icon name="external" :size="12" />
                  </button>
                </div>
              </div>
            </template>
          </template>
        </div>
      </section>

      <!-- 右侧服务详情 + 浅色运行日志 -->
      <div v-if="selectedProject" class="project-col">
        <section class="card service-info">
          <div class="service-header">
            <div class="service-mark">
              <Icon name="stack" :size="24" />
            </div>
            <div class="grow">
              <div class="service-name">
                <h2>{{ selectedProject.name }}</h2>
                <span
                  class="badge"
                  :class="badgeClass(current?.state)"
                  :title="
                    current?.canStop
                      ? '由工作台启动并托管'
                      : current?.state === 'external'
                        ? '外部进程运行中，请在原工具中管理'
                        : undefined
                  "
                >
                  <i class="dot" />
                  {{ runLabels[current?.state || "unknown"] }}
                </span>
              </div>
              <div class="service-trace">
                {{ selectedProject.group }}
                <template v-if="current?.port"
                  >　·　端口 {{ current.port }}</template
                >
              </div>
            </div>

            <div class="service-header-actions">
              <button
                v-if="selectedAction"
                type="button"
                class="btn"
                :class="{
                  'light-brand': selectedAction.action === 'start',
                  stop: selectedAction.action === 'stop',
                  'service-listener-action':
                    selectedProject.type === 'uni-wechat' && selectedAction.icon !== 'external',
                }"
                :disabled="busy === selectedProject.id || selectedAction.disabled"
                :title="selectedAction.title"
                @click="runAction(selectedAction.action, selectedProject.id)"
              >
                <Icon :name="selectedAction.icon" :size="selectedAction.icon === 'external' ? 14 : 16" />
                {{ selectedAction.label }}
              </button>
              <button
                type="button"
                class="btn primary"
                title="在独立窗口编辑项目代码"
                @click="runAction('editor', selectedProject.id)"
              >
                <Icon name="code" :size="15" />代码编辑
              </button>
              <button
                v-if="selectedProject.type === 'uni-wechat'"
                type="button"
                class="btn"
                :disabled="
                  busy === selectedProject.id || current?.state === 'starting'
                "
                @click="runAction('wechat', selectedProject.id)"
              >
                打开微信开发者工具
              </button>
              <button
                v-if="
                  !['wechat', 'uni-wechat'].includes(selectedProject.type) &&
                  selectedAction?.action !== 'ide'
                "
                type="button"
                class="btn"
                :disabled="busy === selectedProject.id"
                @click="runAction('ide', selectedProject.id)"
              >
                <Icon name="external" :size="14" />打开 IDE
              </button>
            </div>
          </div>

          <p
            v-if="shownRunMessage(current)"
            :class="
              ['unconfigured', 'unknown', 'failed'].includes(current!.state)
                ? 'notice warning'
                : 'inline-note'
            "
            style="margin-top: 12px; margin-bottom: 0"
          >
            {{ shownRunMessage(current) }}
          </p>

          <div class="service-facts">
            <div class="fact">
              <div class="fact-label">
                <Icon name="folder" :size="12" />工作目录
              </div>
              <div class="fact-value">
                <span class="mono" :title="selectedProject.path">{{
                  selectedProject.path
                }}</span>
              </div>
            </div>

            <div class="fact">
              <div class="fact-label">
                <Icon name="branch2" :size="12" />分支
              </div>
              <div class="fact-value">
                <span class="mono" :title="current?.branch">{{
                  current?.branch || "—"
                }}</span>
              </div>
            </div>

            <div v-if="current?.url" class="fact fact-wide">
              <div class="fact-label">
                <Icon name="link" :size="12" />访问地址
              </div>
              <div class="fact-value">
                <button
                  type="button"
                  class="fact-url-btn"
                  :title="current.url"
                  @click="runAction('url', selectedProject.id)"
                >
                  <span>{{ current.url }}</span>
                  <Icon name="external" :size="12" />
                </button>
                <button
                  type="button"
                  class="icon-btn small blank"
                  title="复制地址"
                  aria-label="复制地址"
                  @click="runAction('copy', selectedProject.id)"
                >
                  <Icon name="copy" :size="12" />
                </button>
              </div>
            </div>

            <div v-if="current?.deployment" class="fact fact-wide">
              <div class="fact-label">
                <Icon name="archive" :size="12" />现有部署
              </div>
              <div class="fact-value">
                <span class="mono" :title="current.deployment">{{
                  current.deployment
                }}</span>
              </div>
            </div>

            <div class="fact fact-wide">
              <div class="fact-label">
                <Icon name="server" :size="12" />运行环境
              </div>
              <div class="fact-value">
                <span
                  :title="current?.description || types[selectedProject.type]"
                  >{{
                    shortEnvLabel(selectedProject.type, current?.description)
                  }}</span
                >
              </div>
            </div>
          </div>

          <div class="service-tools">
            <button
              type="button"
              class="text-action"
              :disabled="busy === selectedProject.id"
              @click="runAction('folder', selectedProject.id)"
            >
              <Icon name="folder" :size="13" />打开目录
            </button>
            <button
              type="button"
              class="text-action"
              @click="runAction('rules', selectedProject.id)"
            >
              <Icon name="document" :size="13" />项目规则
            </button>
            <span
              v-if="selectedProject.group === '推荐官'"
              class="dep"
              title="需单独启动 HomeProject API"
            >
              依赖 HomeProject API
            </span>
          </div>
        </section>

        <RunLog
          v-if="log"
          :key="log.session"
          :text="String(log.text ?? '')"
          :active="isLiveState(current?.state)"
          :host-label="hostLabel"
        />
        <section v-else class="terminal terminal-idle">
          <div class="term-head">
            <Icon name="term" :size="16" />
            <h3>运行日志</h3>
            <span class="live-light idle" />
            <span v-if="hostLabel" class="term-host mono">{{ hostLabel }}</span>
          </div>
          <div class="term-empty">
            <span>未加载日志</span>
            <button
              type="button"
              class="btn compact"
              @click="runAction('log', selectedProject.id)"
            >
              <Icon name="term" :size="13" />查看上次日志
            </button>
          </div>
        </section>
      </div>
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
          <p v-if="!rules.length" class="muted small">
            此项目没有自己的规则文件。
          </p>
        </template>
      </div>
    </dialog>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  attempt,
  call,
  dismissToast,
  model,
  navigate,
  notify,
  pauseToast,
  reload,
  resumeToast,
  route,
  taskLabels,
  toast,
  leaveGuard,
} from "./state";
import { formatChromeDate } from "./format";
import Icon from "./components/Icon.vue";
import CloseButton from "./components/CloseButton.vue";
import workbenchIcon from "../../assets/workbench-v2-64.png";
import MessageDialog from "./components/MessageDialog.vue";
import NotesPage from "./pages/NotesPage.vue";
import MonthlyPage from "./pages/MonthlyPage.vue";
import PromptsPage from "./pages/PromptsPage.vue";
import ApkPage from "./pages/ApkPage.vue";
import ProjectsPage from "./pages/ProjectsPage.vue";
import GitPage from "./pages/GitPage.vue";
import SettingsPage from "./pages/SettingsPage.vue";
import TasksPage from "./pages/TasksPage.vue";

const ready = ref(false),
  initialError = ref(""),
  navOpen = ref(false),
  railCollapsed = ref(false),
  tapdBusy = ref(false),
  dismissedTaskId = ref(""),
  toastActionBusy = ref(false),
  toastRefreshing = ref(false),
  pageEntering = ref(false),
  workspace = ref<HTMLElement>();

const groups = [
  {
    name: "日常",
    items: [
      ["work", "note", "工作记录"],
      ["ideas", "idea", "待办事项"],
      ["monthly", "report", "月度总结"],
      ["prompts", "prompt-collection", "提示词库"],
    ],
  },
  {
    name: "开发",
    items: [
      ["projects", "folders", "项目管理"],
      ["review", "branch2", "Git 管理"],
    ],
  },
  {
    name: "交付",
    items: [
      ["apk", "box", "APK 打包"],
      ["tapd", "external", "TAPD 入口"],
    ],
  },
] as const;

const pageLabel = computed(() => {
  for (const { items } of groups) {
    const active = items.find(([page]) => page === route.value);
    if (active) return active[2];
  }
  return route.value === "tasks" ? "任务中心" : route.value === "settings" ? "设置" : "工作区";
});
const chromeDate = computed(() => formatChromeDate(model.today));

const openIdeasCount = computed(
  () => model.notes.filter((n) => n.kind === "idea" && !n.completedAt).length,
);

const runningTasks = computed(() =>
  model.tasks.filter((t) =>
    ["running", "awaiting", "cancelling"].includes(t.state),
  ),
);
const currentTask = computed(() => runningTasks.value[0]);
const showTaskStrip = computed(
  () =>
    ready.value &&
    !!currentTask.value &&
    route.value !== "tasks" &&
    currentTask.value.id !== dismissedTaskId.value,
);
const activeStage = computed(() => {
  const task = currentTask.value;
  if (!task) return "";
  return task.stages.find((s) => s.state === "running")?.name || "";
});

watch(
  () => currentTask.value?.id,
  (id) => {
    if (!id || id !== dismissedTaskId.value) dismissedTaskId.value = "";
  },
);

function toggleSidebar() {
  if (window.innerWidth <= 920) {
    navOpen.value = !navOpen.value;
  } else {
    railCollapsed.value = !railCollapsed.value;
  }
}

async function openTapd() {
  if (tapdBusy.value) return;
  tapdBusy.value = true;
  notify("正在打开 TAPD 客户端…", { duration: 6000 });
  try {
    await attempt(async () => {
      const task = await call<any>("tapd.open");
      if (task?.state === "failed" || task?.state === "partial")
        notify(
          task.error ? "打开 TAPD 失败：" + task.error : "打开 TAPD 失败",
          true,
        );
      else notify(task?.result?.message || "已请求打开 TAPD 客户端");
    });
  } finally {
    tapdBusy.value = false;
  }
}

async function runToastAction() {
  const action = toast.value?.action;
  if (!action || toastActionBusy.value) return;
  toastActionBusy.value = true;
  dismissToast(true);
  try {
    await action.run();
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), true);
  } finally {
    toastActionBusy.value = false;
  }
}

async function init() {
  try {
    await reload();
    ready.value = true;
    initialError.value = "";
    await openNotification();
  } catch (e) {
    initialError.value = e instanceof Error ? e.message : String(e);
  }
}

async function openNotification() {
  const destination = await call<{ taskId: string } | { todoId: string } | null>(
    "notification.take",
  );
  if (!destination) return;
  await reload();
  if ("taskId" in destination) {
    await navigate("tasks", destination);
  } else {
    const todo = model.notes.find((note) => note.id === destination.todoId && note.kind === "idea");
    if (todo) await navigate("ideas", { selected: todo.id, tab: todo.completedAt ? "completed" : "active" });
  }
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === "Escape" && navOpen.value) navOpen.value = false;
}

let toastRefreshTimer: ReturnType<typeof setTimeout> | undefined;
let pageEnterTimer: ReturnType<typeof setTimeout> | undefined;

watch(
  () => toast.value?.id,
  (nextId, prevId) => {
    if (nextId && prevId && nextId !== prevId) {
      toastRefreshing.value = false;
      requestAnimationFrame(() => {
        toastRefreshing.value = true;
        if (toastRefreshTimer) clearTimeout(toastRefreshTimer);
        toastRefreshTimer = setTimeout(() => {
          toastRefreshing.value = false;
        }, 140);
      });
    } else if (!nextId) {
      toastRefreshing.value = false;
    }
  },
);

watch(route, () => {
  navOpen.value = false;
  workspace.value?.scrollTo({ top: 0, left: 0 });
  void workspace.value?.focus({ preventScroll: true });
  pageEntering.value = false;
  requestAnimationFrame(() => {
    pageEntering.value = true;
    if (pageEnterTimer) clearTimeout(pageEnterTimer);
    pageEnterTimer = setTimeout(() => {
      pageEntering.value = false;
    }, 150);
  });
});

onMounted(() => {
  window.__workbenchCanClose = async () =>
    leaveGuard ? leaveGuard("close") : true;
  window.addEventListener("keydown", onKeydown);
  void init();
  window.workbench.onNavigate(() => {
    void attempt(openNotification);
  });
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  let latestRevision: number | undefined;
  window.workbench.onChanged((revision) => {
    latestRevision = revision;
    if (!reloadTimer)
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined;
        void attempt(() => reload(latestRevision));
      }, 180);
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  if (toastRefreshTimer) clearTimeout(toastRefreshTimer);
  if (pageEnterTimer) clearTimeout(pageEnterTimer);
});
</script>
<template>
  <a class="skip-link" href="#main">跳到主要内容</a>
  <div class="shell" :class="{ 'rail-collapsed': railCollapsed }">
    <aside id="app-sidebar" class="rail" :class="{ open: navOpen }">
      <div class="brand">
        <img :src="workbenchIcon" alt="" width="33" height="33" />
        <strong>个人工作台</strong>
      </div>
      <nav aria-label="主导航">
        <div v-for="group in groups" :key="group.name" class="navgroup">
          <h2>{{ group.name }}</h2>
          <button
            v-for="item in group.items"
            :key="item[0]"
            type="button"
            class="navitem"
            :class="{ active: route === item[0] }"
            :data-nav="item[0]"
            :disabled="item[0] === 'tapd' && tapdBusy"
            :aria-current="route === item[0] ? 'page' : undefined"
            :title="
              item[0] === 'ideas' && openIdeasCount
                ? `${item[2]}（${openIdeasCount} 项待完成）`
                : item[0] === 'tapd' && tapdBusy
                  ? '正在打开 TAPD 客户端…'
                  : item[2]
            "
            @click="item[0] === 'tapd' ? openTapd() : navigate(item[0])"
          >
            <Icon :name="item[1]" :size="18" />
            <span class="nav-label">{{ item[0] === 'tapd' && tapdBusy ? '正在打开 TAPD…' : item[2] }}</span>
            <span
              v-if="item[0] === 'ideas' && openIdeasCount"
              class="nav-count"
              aria-hidden="true"
              >{{ openIdeasCount }}</span
            >
          </button>
        </div>
      </nav>
      <div class="rail-bottom">
        <button
          type="button"
          class="rail-util"
          :class="{ active: route === 'tasks' }"
          :aria-current="route === 'tasks' ? 'page' : undefined"
          :title="
            runningTasks.length
              ? `任务中心（${runningTasks.length} 个执行中）`
              : '任务中心'
          "
          @click="navigate('tasks')"
        >
          <Icon name="tasks" :size="17" />
          <span class="nav-label">任务中心</span>
          <span
            v-if="runningTasks.length"
            class="nav-count running-number"
            aria-hidden="true"
            >{{ runningTasks.length }}</span
          >
        </button>
        <button
          type="button"
          class="rail-util"
          :class="{ active: route === 'settings' }"
          :aria-current="route === 'settings' ? 'page' : undefined"
          title="设置"
          @click="navigate('settings')"
        >
          <Icon name="settings" :size="17" />
          <span class="nav-label">设置</span>
        </button>
      </div>
    </aside>
    <Transition name="fade">
      <div
        v-if="navOpen"
        class="scrim"
        aria-hidden="true"
        @click="navOpen = false"
      />
    </Transition>
    <div class="frame">
      <header class="chrome">
        <div class="crumb">
          <button
            type="button"
            class="chrome-toggle"
            :aria-label="railCollapsed ? '展开侧栏' : '切换侧栏'"
            :aria-expanded="!railCollapsed"
            aria-controls="app-sidebar"
            title="切换侧栏"
            @click="toggleSidebar"
          >
            <Icon name="panel" :size="16" />
          </button>
        </div>
        <div class="chrome-date">
          <Icon name="calendar2" :size="14" />
          <span>{{ chromeDate.date }}</span>
          <span class="sep-dot" aria-hidden="true" />
          <span class="weekday">{{ chromeDate.weekday }}</span>
        </div>
        <div class="window-buttons">
          <button
            type="button"
            aria-label="最小化"
            title="最小化"
            @click="call('window.minimize')"
          >
            <Icon name="minus" :size="12" />
          </button>
          <button
            type="button"
            aria-label="最大化或还原"
            title="最大化或还原"
            @click="call('window.maximize')"
          >
            <Icon name="maximize" :size="11" />
          </button>
          <button
            type="button"
            class="win-close"
            aria-label="关闭窗口"
            title="关闭窗口"
            @click="call('window.close')"
          >
            <Icon name="close" :size="13" />
          </button>
        </div>
      </header>
      <main
        v-if="ready"
        id="main"
        ref="workspace"
        class="workarea"
        :class="['page-' + route, { 'page-entering': pageEntering }]"
        :data-page="route"
        :aria-label="pageLabel"
        tabindex="-1"
      >
        <NotesPage
          v-if="route === 'ideas' || route === 'work'"
          :key="route"
          :kind="route === 'ideas' ? 'idea' : 'work'"
        />
        <MonthlyPage v-else-if="route === 'monthly'" />
        <PromptsPage v-else-if="route === 'prompts'" />
        <ApkPage v-else-if="route === 'apk'" />
        <SettingsPage v-else-if="route === 'settings'" />
        <TasksPage v-else-if="route === 'tasks'" />
        <KeepAlive><ProjectsPage v-if="route === 'projects'" /></KeepAlive>
        <KeepAlive><GitPage v-if="route === 'review'" /></KeepAlive>
      </main>
      <main v-else class="startup">
        <span class="startup-mark"><Icon name="database" :size="22" /></span>
        <h1>个人工作台</h1>
        <p v-if="!initialError" class="muted">正在打开本地数据…</p>
        <div v-else role="alert">
          <p class="error">{{ initialError }}</p>
          <button type="button" class="btn primary" @click="init">
            重新打开本地数据
          </button>
        </div>
      </main>
      <div v-if="showTaskStrip && currentTask" class="task-strip-wrap">
        <button
          type="button"
          class="task-strip"
          @click="navigate('tasks', { taskId: currentTask.id })"
        >
          <Icon
            name="cycle"
            :size="14"
            :class="{ spinning: currentTask.state === 'running' }"
          />
          <strong>{{ currentTask.title }}</strong>
          <span class="live-task" :class="currentTask.state">
            <i class="dot" />{{ taskLabels[currentTask.state] }}
          </span>
          <span v-if="activeStage" class="task-stage">{{ activeStage }}</span>
          <span v-if="runningTasks.length > 1" class="count"
            >另有 {{ runningTasks.length - 1 }} 个</span
          >
          <span class="push" />
          <span class="text-action"
            ><Icon name="arrow-right" :size="13" />查看任务</span
          >
        </button>
        <CloseButton
          class="task-strip-dismiss"
          label="收起任务条"
          :size="12"
          @click="dismissedTaskId = currentTask.id"
        />
      </div>
    </div>
    <Transition name="toast">
      <div
        v-if="toast"
        key="toast"
        class="toast"
        :class="{
          error: toast.error,
          'has-countdown': toast.countdown,
          paused: toast.paused,
          'toast-refresh': toastRefreshing,
        }"
        role="status"
        aria-live="polite"
        aria-atomic="true"
        @mouseenter="pauseToast"
        @mouseleave="resumeToast"
      >
        <span class="toast-icon"
          ><Icon :name="toast.error ? 'warning' : 'check'" :size="12"
        /></span>
        <span class="toast-text">{{ toast.text }}</span>
        <button
          v-if="toast.action"
          type="button"
          class="toast-action"
          :disabled="toastActionBusy"
          :title="toast.countdown ? '悬停可暂停倒计时' : undefined"
          @click="runToastAction"
        >
          <span>{{ toast.action.label }}</span>
          <span v-if="toast.countdown" class="toast-countdown"
            >{{ toast.remainingSeconds }}s</span
          >
        </button>
        <CloseButton class="inverse" label="关闭提示" @click="dismissToast()" />
        <span
          v-if="toast.countdown"
          :key="toast.id"
          class="toast-progress"
          :class="{ paused: toast.paused }"
          :style="{ animationDuration: `${toast.duration}ms` }"
          aria-hidden="true"
        />
      </div>
    </Transition>
    <MessageDialog />
  </div>
</template>

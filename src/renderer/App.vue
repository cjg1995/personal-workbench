<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  attempt,
  call,
  model,
  navigate,
  notify,
  openRecord,
  reload,
  route,
  taskLabels,
  toast,
  recordModal,
  leaveGuard,
} from "./state";
import Icon from "./components/Icon.vue";
import CloseButton from "./components/CloseButton.vue";
import workbenchIcon from "../../assets/workbench-v2-64.png";
import MessageDialog from "./components/MessageDialog.vue";
import RecordDialog from "./components/RecordDialog.vue";
import NotesPage from "./pages/NotesPage.vue";
import MonthlyPage from "./pages/MonthlyPage.vue";
import PromptsPage from "./pages/PromptsPage.vue";
import ApkPage from "./pages/ApkPage.vue";
import ProjectsPage from "./pages/ProjectsPage.vue";
import ReviewPage from "./pages/GitPage.vue";
import SettingsPage from "./pages/SettingsPage.vue";
import TasksPage from "./pages/TasksPage.vue";

const ready = ref(false),
  initialError = ref(""),
  navOpen = ref(false),
  railCollapsed = ref(false),
  workspace = ref<HTMLElement>();

const groups = [
  {
    name: "日常",
    items: [
      ["work", "note", "工作记录"],
      ["ideas", "idea", "灵感待办"],
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

const openIdeasCount = computed(
  () =>
    model.notes.filter(
      (n) => n.kind === "idea" && !n.deletedAt && !n.completedAt,
    ).length,
);

const runningTasks = computed(() =>
  model.tasks.filter((t) =>
    ["running", "awaiting", "cancelling"].includes(t.state),
  ),
);
const currentTask = computed(() => runningTasks.value[0]);
const activeStage = computed(() => {
  const task = currentTask.value;
  if (!task) return "";
  return task.stages.find((s) => s.state === "running")?.name || "";
});

function toggleSidebar() {
  if (window.innerWidth <= 920) {
    navOpen.value = !navOpen.value;
  } else {
    railCollapsed.value = !railCollapsed.value;
  }
}

async function openTapd() {
  await attempt(async () => {
    const task = await call<any>("tapd.open");
    if (task?.state === "failed" || task?.state === "partial")
      notify(
        task.error ? "打开 TAPD 失败：" + task.error : "打开 TAPD 失败",
        true,
      );
    else notify(task?.result?.message || "已请求打开 TAPD 客户端");
  });
}

async function init() {
  try {
    await reload();
    ready.value = true;
    initialError.value = "";
    await openNotificationTask();
  } catch (e) {
    initialError.value = e instanceof Error ? e.message : String(e);
  }
}

async function openNotificationTask() {
  const destination = await call<{ taskId: string } | null>(
    "notification.take",
  );
  if (!destination) return;
  await reload();
  await navigate("tasks", destination);
}

function onKeydown(event: KeyboardEvent) {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "n") {
    if (recordModal.value) return;
    event.preventDefault();
    openRecord();
  }
  if (event.key === "Escape" && navOpen.value) navOpen.value = false;
}

watch(route, () => {
  navOpen.value = false;
  workspace.value?.scrollTo({ top: 0, left: 0 });
  void workspace.value?.focus({ preventScroll: true });
});

onMounted(() => {
  window.__workbenchCanClose = async () =>
    leaveGuard ? leaveGuard("close") : true;
  window.addEventListener("keydown", onKeydown);
  void init();
  window.workbench.onNavigate(() => {
    void attempt(openNotificationTask);
  });
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  window.workbench.onChanged(() => {
    if (!reloadTimer)
      reloadTimer = setTimeout(() => {
        reloadTimer = undefined;
        void attempt(reload);
      }, 180);
  });
});

onBeforeUnmount(() => window.removeEventListener("keydown", onKeydown));
</script>
<template>
  <a class="skip-link" href="#main">跳到主要内容</a>
  <div class="shell" :class="{ 'rail-collapsed': railCollapsed }">
    <aside id="app-sidebar" class="rail" :class="{ open: navOpen }">
      <div class="brand">
        <img :src="workbenchIcon" alt="" width="24" height="24" />
        <strong>个人工作台</strong>
      </div>
      <button
        type="button"
        class="quick"
        title="快速记录（Ctrl+N）"
        @click="openRecord()"
      >
        <Icon name="penbox" :size="16" />
        <span class="nav-label">快速记录</span>
      </button>
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
            :aria-current="route === item[0] ? 'page' : undefined"
            :title="
              item[0] === 'ideas' && openIdeasCount
                ? `${item[2]}（${openIdeasCount} 项待完成）`
                : item[2]
            "
            @click="item[0] === 'tapd' ? openTapd() : navigate(item[0])"
          >
            <Icon :name="item[1]" :size="18" />
            <span class="nav-label">{{ item[2] }}</span>
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
    <div
      v-if="navOpen"
      class="scrim"
      aria-hidden="true"
      @click="navOpen = false"
    />
    <div class="frame">
      <header class="chrome">
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
        :class="'page-' + route"
        :data-page="route"
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
        <KeepAlive><ReviewPage v-if="route === 'review'" /></KeepAlive>
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
      <button
        v-if="ready && currentTask && route !== 'tasks'"
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
    </div>
    <div
      v-if="toast"
      class="toast"
      :class="{ error: toast.error }"
      role="status"
      aria-live="polite"
      aria-atomic="true"
    >
      <span class="toast-icon"
        ><Icon :name="toast.error ? 'warning' : 'check'" :size="12"
      /></span>
      <span class="toast-text">{{ toast.text }}</span>
      <CloseButton class="inverse" label="关闭提示" @click="toast = null" />
    </div>
    <RecordDialog v-if="recordModal" />
    <MessageDialog />
  </div>
</template>

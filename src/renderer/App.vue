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
import workbenchIcon from "../../assets/workbench-v2-64.png";
import RecordDialog from "./components/RecordDialog.vue";
import NotesPage from "./pages/NotesPage.vue";
import MonthlyPage from "./pages/MonthlyPage.vue";
import ApkPage from "./pages/ApkPage.vue";
import ProjectsPage from "./pages/ProjectsPage.vue";
import ReviewPage from "./pages/GitPage.vue";
import SettingsPage from "./pages/SettingsPage.vue";
import TasksPage from "./pages/TasksPage.vue";
const ready = ref(false),
  initialError = ref(""),
  navOpen = ref(false),
  pageView = ref<HTMLElement>();
const groups = [
  {
    name: "日常",
    items: [
      ["work", "book", "工作记录"],
      ["ideas", "spark", "灵感待办"],
      ["monthly", "chart", "月度总结"],
    ],
  },
  {
    name: "开发",
    items: [
      ["projects", "play", "项目运行"],
      ["review", "branch", "Git 管理"],
    ],
  },
  {
    name: "交付",
    items: [
      ["apk", "box", "APK 打包"],
      ["tapd", "external", "TAPD 入口"],
    ],
  },
];
const titles: Record<string, string> = {
  ideas: "灵感待办",
  work: "工作记录",
  monthly: "月度总结",
  submit: "一键提测",
  apk: "APK 打包",
  projects: "项目运行",
  review: "Git 管理",
  settings: "设置",
  tasks: "任务中心",
};
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
const workspace = ref<HTMLElement>();
watch(route, () => {
  navOpen.value = false;
  pageView.value?.scrollTo({ top: 0, left: 0 });
  void workspace.value?.focus({ preventScroll: true });
});
onMounted(() => {
  window.__workbenchCanClose = async () => (leaveGuard ? leaveGuard("close") : true);
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
  <div class="app-shell">
    <div class="titlebar">
      <button
        class="menu-button"
        aria-label="打开导航菜单"
        :aria-expanded="navOpen"
        aria-controls="app-sidebar"
        @click="navOpen = !navOpen"
      >
        <Icon name="list" :size="18" />
      </button>
      <div class="brand">
        <img class="brand-mark" :src="workbenchIcon" alt="" width="24" height="24" />
        <span>个人工作台</span>
      </div>
      <div class="window-controls">
        <button aria-label="最小化" @click="call('window.minimize')">
          <Icon name="minus" :size="14" /></button
        ><button aria-label="最大化或还原" @click="call('window.maximize')">
          <Icon name="maximize" :size="11" /></button
        ><button aria-label="关闭窗口" @click="call('window.close')">
          <Icon name="close" :size="14" />
        </button>
      </div>
    </div>
    <div class="app-layout">
      <aside id="app-sidebar" class="sidebar" :class="{ open: navOpen }">
        <nav aria-label="主导航">
          <section v-for="group in groups" :key="group.name">
            <p>{{ group.name }}</p>
            <button
              v-for="item in group.items"
              :key="item[0]"
              :class="{ active: route === item[0] }"
              :aria-current="route === item[0] ? 'page' : undefined"
              :title="item[2]"
              @click="item[0] === 'tapd' ? openTapd() : navigate(item[0])"
            >
              <span class="nav-icon"><Icon :name="item[1]" :size="18" /></span
              ><span class="nav-label">{{ item[2] }}</span>
            </button>
          </section>
        </nav>
        <div class="sidebar-bottom">
          <button
            :class="{ active: route === 'settings' }"
            title="设置"
            @click="navigate('settings')"
          >
            <span class="nav-icon"><Icon name="settings" :size="18" /></span
            ><span class="nav-label">设置</span>
          </button>
        </div>
      </aside>
      <div
        v-if="navOpen"
        class="scrim"
        aria-hidden="true"
        @click="navOpen = false"
      />
      <main
        v-if="ready"
        id="main"
        ref="workspace"
        class="workspace"
        :data-page="route"
        tabindex="-1"
      >
        <header class="page-header">
          <div class="page-heading">
            <h1>{{ titles[route] }}</h1>
          </div>
          <div class="header-actions">
            <button
              class="header-button"
              title="快速记录（Ctrl+N）"
              @click="openRecord()"
            >
              <Icon name="pencil" :size="15" /><span class="btn-label"
                >快速记录</span
              ></button
            ><button
              v-if="route !== 'tasks'"
              class="header-button"
              title="任务中心"
              @click="navigate('tasks')"
            >
              <Icon name="list" :size="15" /><span class="btn-label"
                >任务中心</span
              ><span v-if="runningTasks.length" class="count-badge">{{
                runningTasks.length
              }}</span>
            </button>
          </div>
        </header>
        <div class="page-body" :class="'page-' + route">
          <div ref="pageView" class="page-view">
            <NotesPage
              v-if="route === 'ideas' || route === 'work'"
              :key="route"
              :kind="route === 'ideas' ? 'idea' : 'work'"
            /><MonthlyPage v-else-if="route === 'monthly'" /><ApkPage v-else-if="route === 'apk'" /><ProjectsPage
              v-else-if="route === 'projects'" /><SettingsPage v-else-if="route === 'settings'" /><TasksPage
              v-else-if="route === 'tasks'"
            />
            <KeepAlive><ReviewPage v-if="route === 'review'" /></KeepAlive>
          </div>
        </div>
        <button
          v-if="currentTask && route !== 'tasks'"
          class="task-statusbar"
          @click="navigate('tasks', { taskId: currentTask.id })"
        >
          <span
            class="spinner"
            v-if="currentTask.state === 'running'"
          /><strong>{{ currentTask.title }}</strong
          ><span class="status" :class="currentTask.state">{{
            taskLabels[currentTask.state]
          }}</span
          ><span v-if="runningTasks.length > 1" class="tab-count"
            >另有 {{ runningTasks.length - 1 }} 个</span
          ><span class="muted">{{ activeStage }}</span
          ><span class="push-right">查看任务 →</span>
        </button>
      </main>
      <main v-else class="startup">
        <span class="startup-mark"><Icon name="database" :size="22" /></span>
        <h1>个人工作台</h1>
        <p v-if="!initialError" class="muted">正在打开本地数据…</p>
        <div v-else role="alert">
          <p class="error">{{ initialError }}</p>
          <button class="primary" @click="init">重新打开本地数据</button>
        </div>
      </main>
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
      <span class="toast-text">{{ toast.text }}</span
      ><button
        class="toast-close"
        aria-label="关闭提示"
        @click="toast = null"
      >
        <Icon name="close" :size="15" />
      </button>
    </div>
    <RecordDialog v-if="recordModal" />
  </div>
</template>

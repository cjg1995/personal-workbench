<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import {
  attempt,
  call,
  context,
  dateLabel,
  model,
  navigate,
  openRecord,
  reload,
  route,
  taskLabels,
  toast,
  recordModal,
  leaveGuard,
} from "./state";
import Icon from "./components/Icon.vue";
import RecordDialog from "./components/RecordDialog.vue";
import HomePage from "./pages/HomePage.vue";
import NotesPage from "./pages/NotesPage.vue";
import MonthlyPage from "./pages/MonthlyPage.vue";
import SubmitPage from "./pages/SubmitPage.vue";
import ApkPage from "./pages/ApkPage.vue";
import TapdPage from "./pages/TapdPage.vue";
import ProjectsPage from "./pages/ProjectsPage.vue";
import ReviewPage from "./pages/ReviewPage.vue";
import SettingsPage from "./pages/SettingsPage.vue";
import ImportPage from "./pages/ImportPage.vue";
import TasksPage from "./pages/TasksPage.vue";
const ready = ref(false),
  initialError = ref("");
const groups = [
  {
    name: "日常",
    items: [
      ["home", "home", "今日概览"],
      ["ideas", "file", "灵感待办"],
      ["work", "file", "工作记录"],
      ["monthly", "chart", "月度总结"],
    ],
  },
  {
    name: "交付",
    items: [
      ["submit", "code", "代码提交"],
      ["apk", "box", "APK 打包"],
      ["tapd", "external", "TAPD 入口"],
    ],
  },
  {
    name: "开发",
    items: [
      ["projects", "play", "项目运行"],
      ["review", "search", "代码审查"],
    ],
  },
];
const titles: Record<string, string> = {
  home: "今日",
  ideas: "灵感待办",
  work: "工作记录",
  monthly: "月度总结",
  submit: "代码提交",
  apk: "APK 打包",
  tapd: "TAPD 入口",
  projects: "项目运行",
  review: "代码审查",
  settings: "设置",
  import: "导入历史记录",
  tasks: "任务中心",
};
const currentTask = computed(() =>
  model.tasks.find((t) =>
    ["running", "awaiting", "cancelling"].includes(t.state),
  ),
);
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
onMounted(() => {
  window.__workbenchCanClose = async () => (leaveGuard ? leaveGuard() : true);
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
</script>
<template>
  <div class="app-shell">
    <div class="titlebar">
      <div class="brand">
        <Icon name="database" :size="18" /><span>个人工作台</span>
      </div>
      <div class="window-controls">
        <button aria-label="最小化" @click="call('window.minimize')">—</button
        ><button aria-label="最大化或还原" @click="call('window.maximize')">
          □</button
        ><button aria-label="关闭窗口" @click="call('window.close')">×</button>
      </div>
    </div>
    <div class="app-layout">
      <aside class="sidebar">
        <nav aria-label="主导航">
          <section v-for="group in groups" :key="group.name">
            <p>{{ group.name }}</p>
            <button
              v-for="item in group.items"
              :key="item[0]"
              :class="{ active: route === item[0] }"
              :aria-current="route === item[0] ? 'page' : undefined"
              @click="navigate(item[0])"
            >
              <Icon :name="item[1]" /><span>{{ item[2] }}</span>
            </button>
          </section>
        </nav>
        <div class="sidebar-bottom">
          <button
            :class="{ active: ['settings', 'import'].includes(route) }"
            @click="navigate('settings')"
          >
            <Icon name="settings" /><span>设置</span>
          </button>
          <div class="data-health">
            <Icon name="database" :size="16" /><span
              class="dot"
              :class="{ bad: !ready }"
            />本地数据 · {{ ready ? "已连接" : "未就绪" }}
          </div>
        </div>
      </aside>
      <main v-if="ready" class="workspace" :data-page="route">
        <header class="page-header">
          <div class="row">
            <h1>{{ titles[route] }}</h1>
            <span
              v-if="['home', 'ideas', 'work', 'apk'].includes(route)"
              class="header-date"
              >{{ model.today.replaceAll("-", ".") }}</span
            ><span v-if="route === 'review'" class="header-date">人工审查</span>
          </div>
          <div class="header-actions">
            <button class="text-button" @click="openRecord()">
              <Icon name="pencil" />快速记录</button
            ><button
              class="text-button"
              :class="{ blue: route === 'tasks' }"
              @click="navigate('tasks')"
            >
              <Icon name="list" />任务中心
              <span
                v-if="
                  model.tasks.filter((t) =>
                    ['running', 'awaiting', 'cancelling'].includes(t.state),
                  ).length
                "
                class="count-badge"
                >{{
                  model.tasks.filter((t) =>
                    ["running", "awaiting", "cancelling"].includes(t.state),
                  ).length
                }}</span
              >
            </button>
          </div>
        </header>
        <div class="page-body">
          <HomePage v-if="route === 'home'" /><NotesPage
            v-else-if="route === 'ideas' || route === 'work'"
            :key="route"
            :kind="route === 'ideas' ? 'idea' : 'work'"
          /><MonthlyPage v-else-if="route === 'monthly'" /><SubmitPage
            v-else-if="route === 'submit'"
          /><ApkPage v-else-if="route === 'apk'" /><TapdPage
            v-else-if="route === 'tapd'"
          /><ProjectsPage v-else-if="route === 'projects'" /><ReviewPage
            v-else-if="route === 'review'"
          /><SettingsPage v-else-if="route === 'settings'" /><ImportPage
            v-else-if="route === 'import'"
          /><TasksPage v-else-if="route === 'tasks'" />
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
          ><span>{{ taskLabels[currentTask.state] }}</span
          ><span class="muted">{{
            currentTask.stages.find((s) => s.state === "running")?.name
          }}</span
          ><span class="push-right blue">查看任务 →</span>
        </button>
      </main>
      <main v-else class="startup">
        <h1>个人工作台</h1>
        <p v-if="!initialError">正在打开本地数据…</p>
        <div v-else role="alert">
          <p class="error">{{ initialError }}</p>
          <button @click="init">重新打开本地数据</button>
        </div>
      </main>
    </div>
    <div
      v-if="toast"
      class="toast"
      :class="{ error: toast.error }"
      role="status"
    >
      <span>{{ toast.text }}</span
      ><button aria-label="关闭提示" @click="toast = null">
        <Icon name="close" :size="17" />
      </button>
    </div>
    <RecordDialog v-if="recordModal" />
  </div>
</template>

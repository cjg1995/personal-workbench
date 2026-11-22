<script setup lang="ts">
import { computed, ref, watch } from "vue";
import type { BuildConfig, Task } from "../../shared/types";
import {
  attempt,
  call,
  context,
  dateLabel,
  model,
  navigate,
  notify,
  taskLabels,
} from "../state";
import TaskDetail from "../components/TaskDetail.vue";
import Icon from "../components/Icon.vue";

const projectId = ref(context.value.projectId || "employee"),
  variant = ref<"Release" | "Debug">("Release"),
  config = ref<BuildConfig | null>(null),
  error = ref(""),
  busy = ref(false),
  selected = ref(context.value.taskId || "");

const androidProjects = computed(
  () => model.config?.projects.filter((p) => p.android) || [],
);
const history = computed(() =>
  model.tasks.filter(
    (t) => t.type === "apk" && t.projectId === projectId.value,
  ),
);
const active = computed(() =>
  history.value.find((t) => ["running", "cancelling"].includes(t.state)),
);
const task = computed(() =>
  model.tasks.find((t) => t.id === (active.value?.id || selected.value)),
);

async function inspect() {
  config.value = null;
  error.value = "";
  try {
    config.value = await call("apk.inspect", { projectId: projectId.value });
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

watch(
  projectId,
  () => {
    selected.value = "";
    void inspect();
  },
  { immediate: true },
);

async function start() {
  busy.value = true;
  await attempt(async () => {
    const t = await call<Task>("apk.start", {
      projectId: projectId.value,
      variant: variant.value,
    });
    selected.value = t.id;
    notify("打包已开始，离开页面任务继续");
  });
  busy.value = false;
}
</script>
<template>
  <div class="subpage-wrap">
    <div class="page-head">
      <div>
        <h1>APK 打包</h1>
      </div>
    </div>

    <div class="duo apk-layout">
      <section class="card pane">
        <div class="panel-head spaced-head">
          <div class="head-title">
            <Icon name="box" :size="17" />
            <h2>打包配置</h2>
          </div>
          <button
            type="button"
            class="btn compact"
            :disabled="!!active"
            @click="inspect"
          >
            <Icon name="refresh" :size="13" />重新检查
          </button>
        </div>

        <div class="pane-scroll">
          <p class="muted small" style="margin-bottom: 8px">选择应用</p>
          <div class="build-types" role="radiogroup" aria-label="选择应用">
            <label v-for="p in androidProjects" :key="p.id">
              <input
                v-model="projectId"
                type="radio"
                :value="p.id"
                :disabled="!!active"
              />
              <span>{{ p.name.replace(" APP", "") }}</span>
            </label>
          </div>

          <div class="section-rule">
            <p class="muted small" style="margin-bottom: 8px">构建类型</p>
            <div class="segmented" role="group" aria-label="构建类型">
              <button
                type="button"
                :class="{ active: variant === 'Release' }"
                :aria-pressed="variant === 'Release'"
                :disabled="!!active"
                @click="variant = 'Release'"
              >
                Release
              </button>
              <button
                type="button"
                :class="{ active: variant === 'Debug' }"
                :aria-pressed="variant === 'Debug'"
                :disabled="!!active"
                @click="variant = 'Debug'"
              >
                Debug
              </button>
            </div>
          </div>

          <p v-if="error" class="notice warning" style="margin-top: 14px">
            {{ error }}
          </p>

          <dl v-if="config" class="kv">
            <dt>版本号</dt>
            <dd>{{ config.versionName }} · {{ config.versionCode }}</dd>
            <dt>包名</dt>
            <dd class="mono">{{ config.packageName }}</dd>
            <dt>AppID</dt>
            <dd class="mono">{{ config.appId }}</dd>
          </dl>

          <details v-if="config">
            <summary>工程与工具路径</summary>
            <p class="path">源码 {{ config.source }}</p>
            <p class="path">Android {{ config.android }}</p>
            <p class="path">宿主资源 {{ config.www }}</p>
            <p class="path">Node {{ config.node }}</p>
            <p class="path">JDK {{ config.java }}</p>
            <p class="path">SDK {{ config.sdk }}</p>
          </details>

          <div class="actions">
            <button
              type="button"
              class="btn primary"
              :disabled="!config || busy || !!active"
              @click="start"
            >
              <Icon name="box" :size="15" />
              {{ active ? "打包进行中…" : "开始打包" }}
            </button>
            <span v-if="config" class="badge live">
              <i class="dot" />预检查通过
            </span>
          </div>

          <button
            v-if="error"
            type="button"
            class="text-action"
            style="margin-top: 8px"
            @click="navigate('settings', { tab: 'projects' })"
          >
            检查项目与工具配置 →
          </button>
        </div>
      </section>

      <section class="card pane">
        <div class="panel-head spaced-head">
          <div class="head-title">
            <Icon name="tasks" :size="17" />
            <h2>构建状态与历史</h2>
            <span v-if="history.length" class="count">{{ history.length }}</span>
          </div>
        </div>
        <div v-if="!task && !history.length" class="empty" style="margin: auto">
          <span class="empty-icon"><Icon name="box" :size="16" /></span>
          <p class="empty-title">暂无构建记录</p>
        </div>
        <div v-else class="pane-scroll">
          <TaskDetail
            v-if="task"
            :task="task"
            compact
            hide-status
            hide-project-folder
          />

          <section :class="{ 'section-rule': !!task }">
            <div v-if="task" class="section-head">
              <h2>历史构建</h2>
              <span class="count">{{ history.length }}</span>
            </div>
            <button
              v-for="t in history"
              :key="t.id"
              type="button"
              class="task-line"
              :class="{ selected: task?.id === t.id }"
              @click="selected = t.id"
            >
              <time class="small muted">{{ dateLabel(t.startedAt) }}</time>
              <strong>{{ t.params.variant }}</strong>
              <span class="status" :class="t.state">{{
                taskLabels[t.state]
              }}</span>
              <span class="small muted push">{{
                t.result.versionName ||
                (t.result.config as any)?.versionName ||
                ""
              }}</span>
            </button>
          </section>
        </div>
      </section>
    </div>
  </div>
</template>

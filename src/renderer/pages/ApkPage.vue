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
  <div class="module-columns">
    <section>
      <h2>打包配置</h2>
      <div class="build-types">
        <p class="muted small">选择应用</p>
        <label
          v-for="p in model.config?.projects.filter((p) => p.android)"
          :key="p.id"
          ><input
            v-model="projectId"
            type="radio"
            :value="p.id"
            :disabled="!!active"
          />{{ p.name.replace(" APP", "") }}</label
        >
      </div>
      <div class="section-rule">
        <p class="muted small">构建类型</p>
        <div class="segmented" role="group" aria-label="构建类型">
          <button
            :class="{ active: variant === 'Release' }"
            :aria-pressed="variant === 'Release'"
            :disabled="!!active"
            @click="variant = 'Release'"
          >
            Release</button
          ><button
            :class="{ active: variant === 'Debug' }"
            :aria-pressed="variant === 'Debug'"
            :disabled="!!active"
            @click="variant = 'Debug'"
          >
            Debug
          </button>
        </div>
      </div>
      <p v-if="error" class="notice warning">{{ error }}</p>
      <dl v-if="config" class="kv">
        <dt>版本号</dt>
        <dd>{{ config.versionName }} · {{ config.versionCode }}</dd>
        <dt>包名</dt>
        <dd>{{ config.packageName }}</dd>
        <dt>AppID</dt>
        <dd>{{ config.appId }}</dd>
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
      <div v-if="config" class="row actions">
        <button
          class="primary"
          :disabled="!config || busy || !!active"
          @click="start"
        >
          {{ active ? "打包进行中…" : "开始打包" }}</button
        ><span class="pill success">预检查通过</span
        ><button class="link" :disabled="!!active" @click="inspect">
          重新检查
        </button>
      </div>
      <div v-else class="actions">
        <button class="primary" disabled>开始打包</button
        ><button class="link" :disabled="!!active" @click="inspect">
          重新检查
        </button>
      </div>
      <details class="section-rule">
        <summary>打包边界</summary>
        <p class="small muted">
          版本、签名与工具链沿用现有工程配置；资源、签名、包名和版本校验全部通过才显示成功。首版不自动安装到手机。
        </p>
      </details>
      <button
        v-if="error"
        class="link"
        @click="navigate('settings', { tab: 'projects' })"
      >
        检查项目与工具配置 →
      </button>
    </section>
    <section>
      <TaskDetail v-if="task" :task="task" compact />
      <div v-else class="empty">
        <span class="empty-icon"><Icon name="box" :size="16" /></span>
        <p class="empty-title">尚未开始构建</p>
        <p class="empty-hint">
          左侧确认配置后开始构建，四个阶段的状态与耗时来自实际执行。
        </p>
      </div>
      <section class="section-rule">
        <h2>历史构建记录</h2>
        <p v-if="!history.length" class="empty compact">暂无构建记录。</p>
        <button
          v-for="t in history"
          :key="t.id"
          class="task-line"
          @click="selected = t.id"
        >
          <time class="small muted">{{ dateLabel(t.startedAt) }}</time
          ><span>{{ t.params.variant }}</span
          ><span class="status" :class="t.state">{{ taskLabels[t.state] }}</span
          ><span class="small muted">{{
            t.result.versionName || (t.result.config as any)?.versionName || ""
          }}</span>
        </button>
      </section>
    </section>
  </div>
</template>

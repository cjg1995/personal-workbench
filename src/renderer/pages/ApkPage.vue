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
      <div class="row section-rule build-types">
        <label
          ><input
            v-model="variant"
            type="radio"
            value="Release"
            :disabled="!!active"
          />Release</label
        ><label
          ><input
            v-model="variant"
            type="radio"
            value="Debug"
            :disabled="!!active"
          />Debug</label
        >
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
      <div class="actions">
        <button
          class="primary"
          :disabled="!config || busy || !!active"
          @click="start"
        >
          {{ active ? "打包进行中…" : "预检查通过，开始打包" }}</button
        ><button :disabled="!!active" @click="inspect">重新检查</button>
      </div>
      <p class="small muted section-rule">
        版本、签名和工具链沿用现有工程配置。只有资源、签名、包名和版本校验全部通过才显示成功。首版不自动安装到手机。
      </p>
      <button
        v-if="error"
        class="link"
        @click="navigate('settings', { tab: 'tools' })"
      >
        修改项目与工具配置 →
      </button>
    </section>
    <section>
      <TaskDetail v-if="task" :task="task" compact />
      <p v-else class="empty">
        选择配置后开始真实构建。四个阶段的状态和耗时来自实际执行。
      </p>
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

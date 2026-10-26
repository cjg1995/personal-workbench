<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { context, dateLabel, model, taskLabels } from "../state";
import TaskDetail from "../components/TaskDetail.vue";
const query = ref(""),
  selected = ref(context.value.taskId || model.tasks[0]?.id || "");
const tasks = computed(() =>
  model.tasks.filter(
    (t) =>
      !query.value ||
      t.title.includes(query.value) ||
      String(t.params.repo || "").includes(query.value),
  ),
);
const active = computed(() => model.tasks.find((t) => t.id === selected.value));
watch(context, (value) => {
  if (value.taskId) {
    selected.value = value.taskId;
    query.value = "";
  }
});
</script>
<template>
  <div class="tasks-layout">
    <section>
      <div class="row spaced">
        <h2>任务记录</h2>
        <input
          v-model="query"
          type="search"
          placeholder="搜索任务"
          aria-label="搜索任务"
          style="width: 135px"
        />
      </div>
      <p v-if="!tasks.length" class="empty">没有执行记录。</p>
      <button
        v-for="t in tasks"
        :key="t.id"
        class="task-select"
        :class="{ selected: t.id === selected }"
        @click="selected = t.id"
      >
        <strong>{{ t.title }}</strong
        ><span class="status" :class="t.state">{{ taskLabels[t.state] }}</span
        ><small>{{ dateLabel(t.startedAt) }}</small>
      </button>
    </section>
    <section>
      <TaskDetail v-if="active" :task="active" />
      <p v-else class="empty">选择任务，核对真实阶段、结果和日志。</p>
    </section>
  </div>
</template>

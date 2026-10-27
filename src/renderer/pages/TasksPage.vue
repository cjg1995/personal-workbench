<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { context, dateLabel, model, taskLabels } from "../state";
import TaskDetail from "../components/TaskDetail.vue";
import Icon from "../components/Icon.vue";
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
      <div class="section-head">
        <h2>任务记录</h2>
        <input
          v-model="query"
          type="search"
          placeholder="搜索任务"
          aria-label="搜索任务"
          class="task-search"
        />
      </div>
      <div v-if="!tasks.length" class="empty">
        <span class="empty-icon"><Icon name="list" :size="16" /></span>
        <p class="empty-title">没有执行记录</p>
        <p class="empty-hint">
          {{
            query
              ? "换个关键词再试，或清空搜索查看全部任务。"
              : "提交、打包或启动项目后，任务会记录在这里。"
          }}
        </p>
        <button v-if="query" class="link" @click="query = ''">
          清空搜索
        </button>
      </div>
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
      <div v-else class="empty">
        <span class="empty-icon"><Icon name="list" :size="16" /></span>
        <p class="empty-title">选择一个任务</p>
        <p class="empty-hint">核对真实阶段、结果和日志。</p>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { context, dateLabel, model, taskLabels } from "../state";
import TaskDetail from "../components/TaskDetail.vue";
import Icon from "../components/Icon.vue";
const attentionStates = ["running", "cancelling", "awaiting", "failed", "partial"];
const query = ref(""),
  selected = ref(
    context.value.taskId ||
      model.tasks.find((task) => attentionStates.includes(task.state))?.id ||
      model.tasks[0]?.id ||
      "",
  );
const tasks = computed(() =>
  model.tasks.filter(
    (t) =>
      !query.value ||
      t.title.includes(query.value) ||
      String(t.params.repo || "").includes(query.value),
  ),
);
const attention = computed(() =>
  tasks.value.filter((task) => attentionStates.includes(task.state)),
);
const history = computed(() =>
  tasks.value.filter((task) => !attentionStates.includes(task.state)),
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
        <button v-if="query" class="link" @click="query = ''">清空搜索</button>
      </div>
      <template v-if="attention.length">
        <p class="list-label">需要处理</p>
        <button
          v-for="t in attention"
          :key="t.id"
          class="task-select"
          :class="{ selected: t.id === selected }"
          @click="selected = t.id"
        >
          <strong>{{ t.title }}</strong
          ><span class="status" :class="t.state">{{ taskLabels[t.state] }}</span
          ><small>{{ dateLabel(t.startedAt) }}</small>
        </button>
      </template>
      <template v-if="history.length">
        <p class="list-label">历史</p>
        <button
          v-for="t in history"
          :key="t.id"
          class="task-select"
          :class="{ selected: t.id === selected }"
          @click="selected = t.id"
        >
          <strong>{{ t.title }}</strong
          ><span class="status" :class="t.state">{{ taskLabels[t.state] }}</span
          ><small>{{ dateLabel(t.startedAt) }}</small>
        </button>
      </template>
    </section>
    <section>
      <TaskDetail v-if="active" :task="active" />
      <div v-else class="empty">
        <span class="empty-icon"><Icon name="list" :size="16" /></span>
        <p class="empty-title">选择一个任务</p>
      </div>
    </section>
  </div>
</template>

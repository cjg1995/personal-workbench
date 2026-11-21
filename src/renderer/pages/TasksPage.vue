<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { context, dateLabel, model, taskLabels } from "../state";
import TaskDetail from "../components/TaskDetail.vue";
import Icon from "../components/Icon.vue";

const attentionStates = [
  "running",
  "cancelling",
  "awaiting",
  "failed",
  "partial",
];
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
      t.title.toLowerCase().includes(query.value.toLowerCase()) ||
      String(t.params.repo || "")
        .toLowerCase()
        .includes(query.value.toLowerCase()),
  ),
);
const attention = computed(() =>
  tasks.value.filter((task) => attentionStates.includes(task.state)),
);
const history = computed(() =>
  tasks.value.filter((task) => !attentionStates.includes(task.state)),
);
const active = computed(() =>
  model.tasks.find((t) => t.id === selected.value),
);

watch(context, (value) => {
  if (value.taskId) {
    selected.value = value.taskId;
    query.value = "";
  }
});
</script>
<template>
  <div class="subpage-wrap">
    <div class="page-head">
      <h1>任务中心</h1>
    </div>

    <div class="duo tasks-layout">
      <section class="card pane">
        <div class="panel-head spaced-head">
          <div class="head-title">
            <h2>任务记录</h2>
            <span class="count">{{ tasks.length }}</span>
          </div>
          <label class="search-box" style="margin: 0; width: 138px">
            <Icon name="search" :size="13" />
            <input
              v-model="query"
              type="search"
              placeholder="搜索任务"
              aria-label="搜索任务"
            />
          </label>
        </div>

        <div class="task-list-scroll">
          <div v-if="!tasks.length" class="empty">
            <span>没有执行记录</span>
            <button v-if="query" type="button" class="link" @click="query = ''">
              清空搜索
            </button>
          </div>

          <template v-if="attention.length">
            <p class="list-label">需要处理</p>
            <button
              v-for="t in attention"
              :key="t.id"
              type="button"
              class="task-select"
              :class="{ selected: t.id === selected }"
              @click="selected = t.id"
            >
              <strong>{{ t.title }}</strong>
              <span class="status" :class="t.state">{{
                taskLabels[t.state]
              }}</span>
              <small>{{ dateLabel(t.startedAt) }}</small>
            </button>
          </template>

          <template v-if="history.length">
            <p class="list-label">历史</p>
            <button
              v-for="t in history"
              :key="t.id"
              type="button"
              class="task-select"
              :class="{ selected: t.id === selected }"
              @click="selected = t.id"
            >
              <strong>{{ t.title }}</strong>
              <span class="status" :class="t.state">{{
                taskLabels[t.state]
              }}</span>
              <small>{{ dateLabel(t.startedAt) }}</small>
            </button>
          </template>
        </div>
      </section>

      <section class="card pane">
        <div class="panel-head spaced-head">
          <div class="head-title">
            <h2>任务详情</h2>
          </div>
        </div>
        <div class="pane-scroll">
          <TaskDetail v-if="active" :task="active" />
          <div v-else class="empty" style="margin-top: 40px">未选择</div>
        </div>
      </section>
    </div>
  </div>
</template>

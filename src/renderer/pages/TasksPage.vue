<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { context, dateLabel, model, taskLabels } from "../state";
import TaskDetail from "../components/TaskDetail.vue";
import Icon from "../components/Icon.vue";

const timeline = computed(() =>
  [...model.tasks].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt)),
);
const query = ref(""),
  selected = ref(
    context.value.taskId || timeline.value[0]?.id || "",
  );

const tasks = computed(() => {
  const term = query.value.toLowerCase();
  if (!term) return timeline.value;
  return timeline.value.filter(
    (t) =>
      t.title.toLowerCase().includes(term) ||
      String(t.params.repo || "").toLowerCase().includes(term),
  );
});
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
    <section v-if="!model.tasks.length" class="card empty tasks-empty-card">
      <span class="empty-icon"><Icon name="tasks" :size="20" /></span>
      <p class="empty-title">暂无执行记录</p>
    </section>

    <div v-else class="duo tasks-layout">
      <section class="card pane">
        <div class="panel-head spaced-head">
          <div class="head-title">
            <Icon name="tasks" :size="17" />
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
            <span class="empty-icon"><Icon name="search" :size="16" /></span>
            <p class="empty-title">没有匹配的任务</p>
            <button v-if="query" type="button" class="link" @click="query = ''">
              清空搜索
            </button>
          </div>

          <button
            v-for="t in tasks"
            :key="t.id"
            type="button"
            class="task-select"
            :class="{ selected: t.id === selected }"
            @click="selected = t.id"
          >
            <strong>{{ t.title }}</strong>
            <span class="status" :class="t.state">{{ taskLabels[t.state] }}</span>
            <small>{{ dateLabel(t.startedAt) }}</small>
          </button>
        </div>
      </section>

      <section class="card pane">
        <div class="panel-head spaced-head">
          <div class="head-title">
            <Icon name="document" :size="17" />
            <h2>任务详情</h2>
          </div>
        </div>
        <div v-if="active" class="pane-scroll">
          <TaskDetail :task="active" />
        </div>
        <div v-else class="empty empty-subtle" style="margin: auto">
          <span>未选择</span>
        </div>
      </section>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  attempt,
  call,
  model,
  navigate,
  notify,
  projectName,
  reload,
  taskLabels,
  saveForm,
} from "../state";
import ProjectSelect from "../components/ProjectSelect.vue";
import Icon from "../components/Icon.vue";
const draft = model.formDrafts.home || {};
const kind = ref<"idea" | "work">(draft.kind || "idea"),
  text = ref(draft.text || ""),
  projectId = ref<string | null>(draft.projectId || null),
  happenedOn = ref(draft.happenedOn || model.today),
  busy = ref(false);
watch(
  [kind, text, projectId, happenedOn],
  () =>
    saveForm("home", {
      kind: kind.value,
      text: text.value,
      projectId: projectId.value,
      happenedOn: happenedOn.value,
    }),
  { flush: "sync" },
);
const works = computed(() =>
  model.notes
    .filter((n) => n.kind === "work" && !n.deletedAt)
    .sort(
      (a, b) =>
        (b.happenedOn || "").localeCompare(a.happenedOn || "") ||
        b.createdAt.localeCompare(a.createdAt),
    )
    .slice(0, 4),
);
const ideas = computed(() =>
  model.notes
    .filter((n) => n.kind === "idea" && !n.deletedAt && !n.completedAt)
    .slice(0, 4),
);
const running = computed(() =>
  model.tasks.filter((t) =>
    ["running", "awaiting", "cancelling"].includes(t.state),
  ),
);
async function save() {
  busy.value = true;
  await attempt(async () => {
    await call("record.save", {
      kind: kind.value,
      text: text.value,
      projectId: projectId.value,
      happenedOn: happenedOn.value,
    });
    text.value = "";
    await reload();
    notify("已保存");
  });
  busy.value = false;
}
</script>
<template>
  <div class="home-actions">
    <button @click="navigate('submit', { tab: 'erp' })">
      <Icon name="file" :size="27" />ERP 提交</button
    ><button @click="navigate('submit', { tab: 'app' })">
      <Icon name="file" :size="27" />APP 提交</button
    ><button @click="navigate('apk')">
      <Icon name="box" :size="27" />APK 打包</button
    ><button @click="navigate('tapd')">
      <Icon name="link" :size="27" />TAPD 入口
    </button>
  </div>
  <section class="quick-record">
    <div class="tabs">
      <button :class="{ active: kind === 'idea' }" @click="kind = 'idea'">
        记个想法</button
      ><button :class="{ active: kind === 'work' }" @click="kind = 'work'">
        记一条工作
      </button>
    </div>
    <form @submit.prevent="save">
      <textarea
        id="quick-text"
        v-model="text"
        rows="3"
        :placeholder="kind === 'idea' ? '先记下来…' : '今天处理了什么…'"
        aria-label="快速记录内容"
        required
      />
      <div class="row spaced">
        <div class="row">
          <ProjectSelect v-model="projectId" /><input
            v-if="kind === 'work'"
            v-model="happenedOn"
            type="date"
            aria-label="发生日期"
          />
        </div>
        <button class="primary" :disabled="busy || !text.trim()">
          {{ busy ? "保存中…" : "保存" }}
        </button>
      </div>
    </form>
  </section>
  <div class="columns home-lists">
    <section>
      <h2>最近工作</h2>
      <div v-if="!works.length" class="empty">
        还没有工作记录。从上面记下第一条。
      </div>
      <button
        v-for="n in works"
        :key="n.id"
        class="record-line"
        @click="navigate('work', { selected: n.id })"
      >
        <time>{{ n.happenedOn || "日期待补充" }}</time
        ><span>{{ n.text }}</span></button
      ><button class="link" @click="navigate('monthly')">
        整理本月工作 <Icon name="chevron" :size="15" />
      </button>
    </section>
    <section>
      <h2>
        未完成待办
        <small>{{
          model.notes.filter(
            (n) => n.kind === "idea" && !n.deletedAt && !n.completedAt,
          ).length
        }}</small>
      </h2>
      <div v-if="!ideas.length" class="empty">灵感和未来事项会显示在这里。</div>
      <div v-for="n in ideas" :key="n.id" class="todo-line">
        <button
          class="round-check"
          :aria-label="'完成待办 ' + n.text"
          @click="
            attempt(async () => {
              await call('record.complete', { id: n.id, done: true });
              await reload();
              notify('待办已完成');
            })
          "
        /><button
          class="text-button"
          @click="navigate('ideas', { selected: n.id })"
        >
          {{ n.text }}
        </button>
      </div>
    </section>
  </div>
  <section class="section-rule">
    <div class="row spaced">
      <h2>
        正在进行 <small>{{ running.length }}</small>
      </h2>
      <button class="link" @click="navigate('tasks')">
        任务中心 <Icon name="chevron" :size="15" />
      </button>
    </div>
    <p v-if="!running.length" class="empty compact">当前没有后台任务。</p>
    <button
      v-for="t in running"
      :key="t.id"
      class="task-line"
      @click="navigate('tasks', { taskId: t.id })"
    >
      <strong>{{ t.title }}</strong
      ><span class="status" :class="t.state">{{ taskLabels[t.state] }}</span
      ><span class="muted">{{
        t.stages.find((s) => s.state === "running")?.name || "等待核对后继续"
      }}</span
      ><Icon name="chevron" :size="16" />
    </button>
  </section>
  <div class="row section-rule">
    <button class="link" @click="navigate('projects')">
      <Icon name="play" />管理项目运行</button
    ><button class="link" @click="navigate('review')">
      <Icon name="search" />进入人工代码审查
    </button>
  </div>
</template>

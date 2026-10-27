<script setup lang="ts">
import { computed, ref, watch } from "vue";
import {
  attempt,
  call,
  model,
  navigate,
  notify,
  reload,
  saveForm,
} from "../state";
import Icon from "../components/Icon.vue";
const draft = model.formDrafts.home || {};
const kind = ref<"idea" | "work">(draft.kind || "idea"),
  text = ref(draft.text || ""),
  happenedOn = ref(draft.happenedOn || model.today),
  busy = ref(false);
watch(
  [kind, text, happenedOn],
  () =>
    saveForm("home", {
      kind: kind.value,
      text: text.value,
      happenedOn: happenedOn.value,
    }),
  { flush: "sync" },
);
const quickLinks = [
  {
    label: "ERP 提交",
    hint: "提交并合并 test",
    icon: "file",
    page: "submit",
    params: { tab: "erp" },
  },
  {
    label: "APP 提交",
    hint: "配置保护与远端核对",
    icon: "code",
    page: "submit",
    params: { tab: "app" },
  },
  {
    label: "APK 打包",
    hint: "四阶段构建与校验",
    icon: "box",
    page: "apk",
    params: {},
  },
  {
    label: "TAPD 入口",
    hint: "打开现有导入客户端",
    icon: "link",
    page: "tapd",
    params: {},
  },
];
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
const ideaCount = computed(
  () =>
    model.notes.filter((n) => n.kind === "idea" && !n.deletedAt && !n.completedAt)
      .length,
);
async function save() {
  if (busy.value || !text.value.trim()) return;
  busy.value = true;
  await attempt(async () => {
    await call("record.save", {
      kind: kind.value,
      text: text.value,
      happenedOn: happenedOn.value,
    });
    text.value = "";
    await reload();
    notify("已保存");
  });
  busy.value = false;
}
function onKeydown(event: KeyboardEvent) {
  if (!(event.ctrlKey || event.metaKey) || event.key !== "Enter") return;
  event.preventDefault();
  void save();
}
</script>
<template>
  <section class="composer">
    <div class="tabs" role="group" aria-label="记录类型">
      <button
        :class="{ active: kind === 'idea' }"
        :aria-pressed="kind === 'idea'"
        @click="kind = 'idea'"
      >
        记个想法</button
      ><button
        :class="{ active: kind === 'work' }"
        :aria-pressed="kind === 'work'"
        @click="kind = 'work'"
      >
        记一条工作
      </button>
    </div>
    <form @submit.prevent="save" @keydown="onKeydown">
      <textarea
        id="quick-text"
        v-model="text"
        rows="3"
        :placeholder="
          kind === 'idea' ? '想到什么，先记下来…' : '今天处理了什么…'
        "
        aria-label="快速记录内容"
        required
      />
      <div class="composer-foot">
        <div class="row">
          <input
            v-if="kind === 'work'"
            v-model="happenedOn"
            type="date"
            aria-label="发生日期"
          />
        </div>
        <div class="composer-actions">
          <span class="shortcut-hint" aria-hidden="true">Ctrl + Enter</span>
          <button
            class="primary"
            :disabled="busy || !text.trim()"
            :aria-busy="busy"
            title="Ctrl+Enter 快捷保存"
          >
            {{ busy ? "保存中…" : "保存" }}
          </button>
        </div>
      </div>
    </form>
  </section>
  <nav class="quick-links" aria-label="快捷入口">
    <button
      v-for="item in quickLinks"
      :key="item.label"
      class="quick-link"
      :title="item.hint"
      @click="navigate(item.page, item.params)"
    >
      <Icon :name="item.icon" :size="16" />{{ item.label }}
    </button>
  </nav>
  <div class="columns home-lists">
    <section>
      <h2>最近工作</h2>
      <div v-if="!works.length" class="empty">
        <span class="empty-icon"><Icon name="file" :size="16" /></span>
        <p class="empty-title">还没有工作记录</p>
        <p class="empty-hint">把今天真实发生的事记下来，月度总结可直接引用。</p>
      </div>
      <button
        v-for="n in works"
        :key="n.id"
        class="record-line"
        @click="navigate('work', { selected: n.id })"
      >
        <time>{{ n.happenedOn || "日期待补充" }}</time
        ><span>{{ n.text }}</span></button
      >
      <button class="link" @click="navigate('monthly')">
        整理本月工作 <Icon name="chevron" :size="14" />
      </button>
    </section>
    <section>
      <h2>
        未完成待办
        <span class="tab-count">{{ ideaCount }}</span>
      </h2>
      <div v-if="!ideas.length" class="empty">
        <span class="empty-icon"><Icon name="check" :size="16" /></span>
        <p class="empty-title">待办已清空</p>
        <p class="empty-hint">新的想法会出现在这里，完成一条就划掉一条。</p>
      </div>
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
</template>

<script setup lang="ts">
import { computed, ref } from "vue";
import {
  attempt,
  call,
  dateLabel,
  model,
  navigate,
  notify,
  reload,
  taskLabels,
} from "../state";
const text = ref(""),
  busy = ref(false),
  exists = ref<boolean | null>(null);
const latest = computed(() => model.tasks.find((t) => t.type === "tapd"));
void attempt(async () => {
  const checks = await call<any[]>("settings.check");
  exists.value = checks.find((c) => c.key === "tapd")?.exists || false;
});
async function open() {
  busy.value = true;
  await attempt(async () => {
    await call("tapd.open");
    notify("已请求打开客户端，启动结果将在任务中显示");
  });
  busy.value = false;
}
async function save() {
  busy.value = true;
  await attempt(async () => {
    await call("record.save", {
      kind: "work",
      text: text.value,
      happenedOn: model.today,
      result: "",
      sourceId: latest.value ? "task:" + latest.value.id : null,
    });
    text.value = "";
    await reload();
    notify("工作记录已保存");
  });
  busy.value = false;
}
</script>
<template>
  <section>
    <h2 style="font-size: 25px; margin-top: 28px">打开现有导入客户端</h2>
    <p class="muted">文档解析、核对与导入在现有客户端中完成。</p>
    <label>客户端程序路径</label>
    <div class="row spaced">
      <input
        :value="model.config?.tools.tapd"
        readonly
        style="flex: 1"
        aria-label="TAPD 程序路径"
      /><span :class="exists ? 'blue' : 'error'">{{
        exists === null ? "检测中…" : exists ? "路径存在" : "路径需要配置"
      }}</span
      ><button class="link" @click="navigate('settings', { tab: 'tools' })">
        修改路径
      </button>
    </div>
    <div class="actions">
      <button class="primary" :disabled="busy || !exists" @click="open">
        打开 TAPD 客户端</button
      ><button @click="attempt(() => call('tapd.documents'))">
        打开文档目录</button
      ><button class="link" @click="attempt(() => call('tapd.help'))">
        原客户端使用说明
      </button>
    </div>
  </section>
  <section class="section-rule" style="margin-top: 32px">
    <h2>导入流程 <small>在客户端中完成</small></h2>
    <div class="step-strip" style="justify-content: space-between">
      <span
        v-for="(t, i) in ['选择项目', '选择 Word', '核对需求', '提交导入']"
        :key="t"
        ><b>{{ i + 1 }}</b
        >{{ t }}</span
      >
    </div>
    <p class="small muted">
      令牌由原客户端管理。工作台只记录打开结果，不通过进程退出码推断导入数量或导入成功。
    </p>
  </section>
  <section class="section-rule">
    <h2>最近一次启动</h2>
    <div v-if="latest" class="row">
      <span class="status" :class="latest.state">{{
        latest.result.clientOpened ? "客户端已打开" : taskLabels[latest.state]
      }}</span
      ><time class="muted small">{{ dateLabel(latest.startedAt) }}</time
      ><span class="small muted">导入结果请在客户端核对。</span>
    </div>
    <p v-else class="empty compact">还没有通过工作台打开过客户端。</p>
    <p v-if="latest?.error" class="error">{{ latest.error }}</p>
  </section>
  <section class="section-rule">
    <h2>记下导入结果 <small>可选</small></h2>
    <form class="row" @submit.prevent="save">
      <textarea
        v-model="text"
        rows="3"
        placeholder="本次导入的项目、文档和人工核对结果…"
        aria-label="TAPD 手动结果"
      /><button class="primary" :disabled="busy || !text.trim()">
        保存工作记录
      </button>
    </form>
  </section>
</template>

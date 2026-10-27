<script setup lang="ts">
import { computed, ref } from "vue";
import {
  attempt,
  call,
  dateLabel,
  model,
  navigate,
  notify,
  openRecord,
  taskLabels,
} from "../state";
import Icon from "../components/Icon.vue";
const busy = ref(false),
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
function recordResult() {
  openRecord({
    kind: "work",
    text: "",
    projectId: null,
    happenedOn: model.today,
    result: "",
    sourceId: latest.value ? "task:" + latest.value.id : null,
  });
}
</script>
<template>
  <div class="module-columns">
    <section>
      <h2>启动客户端</h2>
      <p class="small muted">
        文档解析、需求核对与导入都在现有客户端中完成，工作台只负责启动与留痕。
      </p>
      <label for="tapd-path">客户端程序路径</label>
      <div class="row wrap">
        <input
          id="tapd-path"
          :value="model.config?.tools.tapd"
          readonly
          class="path-input"
          aria-label="TAPD 程序路径"
        /><span :class="exists ? 'pill success' : 'pill warn'">{{
          exists === null ? "检测中" : exists ? "路径存在" : "待配置"
        }}</span
        ><button class="link" @click="navigate('settings', { tab: 'tools' })">
          修改路径
        </button>
      </div>
      <div class="actions">
        <button class="primary" :disabled="busy || !exists" @click="open">
          打开 TAPD 客户端</button
        ><button @click="attempt(() => call('tapd.documents'))">
          打开文档目录
        </button>
      </div>
      <p v-if="exists === false" class="inline-note warn">
        路径尚未配置或不存在，请先在设置中指定客户端程序。
      </p>
      <p class="inline-note section-rule">
        客户端内流程：选择项目 → 选择 Word → 核对需求 → 提交导入。令牌由原客户端管理，工作台不读取导入结果。
        <button class="link" @click="attempt(() => call('tapd.help'))">
          查看使用说明
        </button>
      </p>
    </section>
    <section>
      <div class="section-head">
        <h2>最近一次启动</h2>
        <button
          v-if="latest"
          class="link small"
          @click="navigate('tasks', { taskId: latest.id })"
        >
          查看任务
        </button>
      </div>
      <div v-if="latest" class="row wrap">
        <span class="status" :class="latest.state">{{
          latest.result.clientOpened ? "客户端已打开" : taskLabels[latest.state]
        }}</span
        ><time class="muted small">{{ dateLabel(latest.startedAt) }}</time>
      </div>
      <p v-else class="empty compact">还没有通过工作台打开过客户端。</p>
      <p v-if="latest?.error" class="error small">{{ latest.error }}</p>
      <section class="section-rule">
        <h2>记录导入结果</h2>
        <p class="small muted">
          导入数量与成功状态请在客户端核对。需要留痕时，记一条工作记录。
        </p>
        <div class="actions">
          <button @click="recordResult">
            <Icon name="pencil" :size="15" />记录本次导入结果
          </button>
        </div>
      </section>
    </section>
  </div>
</template>

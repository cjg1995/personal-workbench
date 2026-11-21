<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { DiffScope, ReviewSnapshot } from "../../shared/types";
import { attempt, call, context, dateLabel, notify } from "../state";
import ProjectSelect from "../components/ProjectSelect.vue";
import DiffView from "../components/DiffView.vue";
import Icon from "../components/Icon.vue";
const projectId = ref<string | null>(context.value.projectId || "homeproject"),
  scope = ref<DiffScope>(context.value.scope || "local"),
  base = ref("origin/test"),
  target = ref("HEAD"),
  snapshot = ref<ReviewSnapshot | null>(null),
  selected = ref(""),
  query = ref(""),
  fileLimit = ref(200),
  status = ref(""),
  mode = ref<"split" | "unified">("unified"),
  busy = ref(false),
  progress = ref(""),
  contentLoading = ref<string | null>(null),
  contentError = ref(""),
  viewer = ref<InstanceType<typeof DiffView>>();
let unsubscribeProgress: (() => void) | undefined;
let disposed = false;
const file = computed(() =>
  snapshot.value?.files.find((f) => f.path === selected.value),
);
const files = computed(
  () =>
    snapshot.value?.files.filter(
      (f) =>
        (!query.value || f.path.includes(query.value)) &&
        (!status.value || f.status[0] === status.value),
    ) || [],
);
function fileHint(f: ReviewSnapshot["files"][number]) {
  if (f.binary) return "二进制";
  if (f.limited) return "超出内置大小限制";
  if (f.deferred && !f.contentHash) return "按需读取正文";
  if (f.untracked) return "未跟踪";
  return "";
}
async function loadSelected() {
  contentLoading.value = null;
  contentError.value = "";
  const s = snapshot.value,
    f = file.value;
  if (!s || !f?.deferred || f.contentHash || f.limited) return;
  const key = s.id + ":" + f.path;
  contentLoading.value = key;
  try {
    const loaded = await call<typeof f>("review.file-content", {
      id: s.id,
      file: f.path,
    });
    if (snapshot.value?.id === s.id) {
      const current = snapshot.value.files.find(
        (value) => value.path === f.path && value.hash === f.hash,
      );
      if (current) Object.assign(current, loaded);
    }
  } catch (error) {
    if (snapshot.value?.id === s.id && selected.value === f.path)
      contentError.value =
        error instanceof Error ? error.message : String(error);
  } finally {
    if (contentLoading.value === key) contentLoading.value = null;
  }
}
watch([() => snapshot.value?.id, selected, () => file.value?.hash], () => {
  void loadSelected();
});
const selectionChanged = computed(
  () =>
    !!snapshot.value &&
    (snapshot.value.projectId !== projectId.value ||
      snapshot.value.scope !== scope.value ||
      (["versions", "ancestor"].includes(scope.value) &&
        (snapshot.value.base !== base.value ||
          snapshot.value.target !== target.value))),
);
function acceptSnapshot(value: ReviewSnapshot) {
  snapshot.value = value;
}
async function refresh(contextLines = 3) {
  if (busy.value) return;
  busy.value = true;
  try {
    const value = await call<ReviewSnapshot>("review.open", {
      projectId: projectId.value,
      scope: scope.value,
      base: base.value,
      target: target.value,
      context: contextLines,
      previousId:
        snapshot.value?.projectId === projectId.value
          ? snapshot.value.id
          : undefined,
    });
    if (disposed) return;
    acceptSnapshot(value);
    if (!snapshot.value!.files.some((f) => f.path === selected.value))
      selected.value = snapshot.value!.files[0]?.path || "";
  } catch (error) {
    if (!disposed)
      notify(error instanceof Error ? error.message : String(error), true);
  } finally {
    busy.value = false;
  }
}
onMounted(() => {
  unsubscribeProgress = window.workbench.onReviewProgress((message) => {
    progress.value = message;
  });
  void refresh();
});
onBeforeUnmount(() => {
  disposed = true;
  unsubscribeProgress?.();
  if (busy.value) void call("review.cancel").catch(() => {});
});
</script>
<template>
  <div class="toolbar">
    <ProjectSelect
      v-model="projectId"
      :optional="false"
      label="审查项目"
      :disabled="busy"
    /><select v-model="scope" :disabled="busy" aria-label="差异范围">
      <option value="unstaged">未暂存变更 · 相对暂存区</option>
      <option value="staged">已暂存变更 · 相对 HEAD</option>
      <option value="local">全部本地变更 · 相对 HEAD</option>
      <option value="versions">两个分支 / 提交的最终版本</option>
      <option value="ancestor">开发分支自共同祖先以来</option></select
    ><button class="primary" :disabled="busy" @click="refresh()">
      {{ busy ? "读取差异…" : "读取 / 刷新差异" }}</button
    ><button v-if="busy" @click="call('review.cancel')">
      取消读取</button
    ><button
      class="link"
      :disabled="busy"
      @click="
        attempt(async () => {
          await call('review.fetch', { projectId });
          notify('已获取 origin，需刷新差异后核对');
        })
      "
    >
      获取远端引用
    </button>
  </div>
  <p v-if="progress" class="progress-line" role="status">
    <span class="spinner" />{{ progress }}
  </p>
  <div v-if="['versions', 'ancestor'].includes(scope)" class="row filters">
    <label class="inline-label"
      >基准<input
        v-model="base"
        :disabled="busy"
        aria-label="比较基准分支或提交" /></label
    ><span>→</span
    ><label class="inline-label"
      >目标<input
        v-model="target"
        :disabled="busy"
        aria-label="比较目标分支或提交" /></label
    ><span class="small muted">{{
      scope === "ancestor"
        ? "以两者共同祖先为实际基准"
        : "直接比较最终版本，不使用共同祖先"
    }}</span>
  </div>
  <p v-if="selectionChanged" class="notice">
    选择范围已改变，读取 / 刷新差异后再记录审查结果。
  </p>
  <template v-if="snapshot"
    ><p class="path">
      {{ snapshot.repo }} · {{ snapshot.base }}（{{
        snapshot.baseCommit.slice(0, 10)
      }}）→ {{ snapshot.target }}（{{ snapshot.targetCommit.slice(0, 10) }}）·
      {{ dateLabel(snapshot.createdAt) }}
    </p>
    <fieldset class="review-content" :disabled="busy || selectionChanged">
      <div class="review-layout">
        <section>
          <h2>
            变更文件 <small>{{ snapshot.files.length }}</small>
          </h2>
          <input
            v-model="query"
            type="search"
            placeholder="搜索文件…"
            aria-label="搜索审查文件"
            class="review-filter"
          /><select
            v-model="status"
            aria-label="变更类型"
            class="review-filter"
          >
            <option value="">全部类型</option>
            <option value="A">新增</option>
            <option value="M">修改</option>
            <option value="D">删除</option>
            <option value="R">重命名</option>
            <option value="?">未跟踪</option></select
          ><button
            v-for="f in files.slice(0, fileLimit)"
            :key="f.path"
            class="file-item"
            :class="{ selected: selected === f.path }"
            @click="selected = f.path"
          >
            <span class="file-status">{{ f.status[0] }}</span
            ><span
              >{{ f.path
              }}<small v-if="fileHint(f)" class="sub-line muted">{{
                fileHint(f)
              }}</small></span
            >
          </button>
          <p v-if="files.length > 200" class="small muted">
            已显示 {{ Math.min(fileLimit, files.length) }} /
            {{ files.length }} 个文件，可搜索定位。
          </p>
          <button
            v-if="files.length > fileLimit"
            class="link"
            @click="fileLimit += 200"
          >
            再显示 200 个文件
          </button>
          <p v-if="!files.length" class="empty">当前范围没有匹配的差异。</p>
        </section>
        <section>
          <div class="section-head">
            <h2>代码差异</h2>
            <div class="segmented" role="group" aria-label="差异显示方式">
              <button
                :class="{ active: mode === 'split' }"
                :aria-pressed="mode === 'split'"
                @click="mode = 'split'"
              >
                并排</button
              ><button
                :class="{ active: mode === 'unified' }"
                :aria-pressed="mode === 'unified'"
                @click="mode = 'unified'"
              >
                统一
              </button>
            </div>
          </div>
          <template v-if="file"
            ><p class="path">
              {{ file.oldPath ? file.oldPath + " → " : "" }}{{ file.path }}
            </p>
            <div class="row wrap diff-actions">
              <button class="link small" @click="viewer?.jump(-1)">
                上一变更</button
              ><button class="link small" @click="viewer?.jump(1)">
                下一变更</button
              ><button class="link small" @click="refresh(200)">
                展开上下文</button
              ><button
                class="link small"
                @click="
                  attempt(() =>
                    call('review.file', { id: snapshot!.id, file: file!.path }),
                  )
                "
              >
                在编辑器打开
              </button>
            </div>
            <template v-if="file.deferred && !file.contentHash">
              <p v-if="contentError" class="notice warning">
                {{ contentError }}
                <button class="link" @click="loadSelected">重试读取正文</button>
              </p>
              <p v-else class="loading" role="status">正在读取此文件正文…</p>
            </template>
            <DiffView v-else ref="viewer" :file="file" :mode="mode" />
            </template
          >
          <p v-else class="empty">
            选择文件阅读真实差异。改变比较范围不会切换分支或修改暂存区。
          </p>
        </section>
      </div>
    </fieldset></template
  >
  <p v-else-if="busy && !progress" class="progress-line" role="status">
    <span class="spinner" />正在读取 Git 差异…
  </p>
  <div v-else class="empty">
    <span class="empty-icon"><Icon name="search" :size="16" /></span>
    <p class="empty-title">尚未读取差异</p>
    <p class="empty-hint">
      选择仓库与比较范围后读取 Git 差异。读取不会切换分支或修改暂存区。
    </p>
  </div>
</template>

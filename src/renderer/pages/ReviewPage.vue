<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type {
  DiffScope,
  ReviewIssue,
  ReviewSnapshot,
} from "../../shared/types";
import {
  attempt,
  call,
  context,
  dateLabel,
  model,
  notify,
  confirm,
  setGuard,
} from "../state";
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
  changed = ref(false),
  line = ref<string>(""),
  side = ref<"old" | "new">("new"),
  issueText = ref(""),
  conclusion = ref(""),
  summary = ref(""),
  rules = ref<any[]>([]),
  progress = ref(""),
  validating = ref(false),
  moreHistory = ref(false),
  historyLoading = ref(false),
  contentLoading = ref<string | null>(null),
  contentError = ref(""),
  history = ref<
    {
      id: string;
      projectId: string;
      createdAt: string;
      scope: string;
      conclusion: string | null;
      fileCount: number;
    }[]
  >([]),
  viewer = ref<InstanceType<typeof DiffView>>();
let timer: ReturnType<typeof setInterval> | undefined;
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
const issues = computed(() => snapshot.value?.issues || []);
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
const issueEdits = ref<
  Record<string, { state: ReviewIssue["state"]; reason: string }>
>({});
const issueDirty = (issue: ReviewIssue) =>
  !!issueEdits.value[issue.id] &&
  (issueEdits.value[issue.id].state !== issue.state ||
    issueEdits.value[issue.id].reason !== issue.reason);
const dirty = computed(
  () =>
    !!issueText.value.trim() ||
    (!!snapshot.value &&
      (summary.value !== snapshot.value.summary ||
        conclusion.value !== (snapshot.value.conclusion || "") ||
        snapshot.value.issues.some(issueDirty))),
);
async function guard() {
  return (
    !dirty.value ||
    (await confirm(
      "有未保存的审查输入",
      "切换会丢弃尚未添加的意见、未保存的问题状态和人工总结。已保存快照会保留。",
      "丢弃输入",
    ))
  );
}
setGuard(guard);
function acceptSnapshot(value: ReviewSnapshot, reset = false) {
  if (reset) issueEdits.value = {};
  for (const issue of value.issues)
    if (!issueEdits.value[issue.id])
      issueEdits.value[issue.id] = { state: issue.state, reason: issue.reason };
  snapshot.value = value;
  if (reset) {
    issueText.value = "";
    line.value = "";
    summary.value = value.summary;
    conclusion.value = value.conclusion || "";
  }
}
async function refresh(contextLines = 3) {
  if (busy.value || validating.value) return;
  if (contextLines === 3 && !(await guard())) return;
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
    acceptSnapshot(value, contextLines === 3);
    changed.value = false;
    if (!snapshot.value!.files.some((f) => f.path === selected.value))
      selected.value = snapshot.value!.files[0]?.path || "";
    await loadHistory();
  } catch (error) {
    if (!disposed)
      notify(error instanceof Error ? error.message : String(error), true);
  } finally {
    busy.value = false;
  }
}
async function loadHistory(append = false) {
  if (historyLoading.value) return;
  historyLoading.value = true;
  try {
    const values = await call<typeof history.value>("review.history", {
      projectId: projectId.value,
      offset: append ? history.value.length : 0,
    });
    moreHistory.value = values.length === 200;
    history.value = append ? [...history.value, ...values] : values;
  } finally {
    historyLoading.value = false;
  }
}
async function validate() {
  if (
    !snapshot.value ||
    contentLoading.value ||
    busy.value ||
    validating.value ||
    changed.value ||
    document.visibilityState !== "visible"
  )
    return;
  validating.value = true;
  try {
    const result = await call<any>("review.validate", {
      id: snapshot.value!.id,
    });
    if (result.changed) {
      changed.value = true;
      snapshot.value!.seen = {};
    }
  } catch (error) {
    if (!disposed)
      notify(error instanceof Error ? error.message : String(error), true);
  } finally {
    validating.value = false;
  }
}
onMounted(() => {
  unsubscribeProgress = window.workbench.onReviewProgress((message) => {
    progress.value = message;
  });
  void refresh();
  timer = setInterval(validate, 60000);
});
onBeforeUnmount(() => {
  disposed = true;
  unsubscribeProgress?.();
  if (busy.value || validating.value)
    void call("review.cancel").catch(() => {});
  if (timer) clearInterval(timer);
  setGuard(null);
});
async function seen() {
  if (!snapshot.value || !file.value) return;
  await mutate(async () => {
    acceptSnapshot(
      await call("review.seen", {
        id: snapshot.value!.id,
        file: file.value!.path,
        viewed: snapshot.value!.seen[file.value!.path] !== file.value!.hash,
      }),
    );
    notify("已保存人工已看状态");
  });
}
async function addIssue() {
  if (!snapshot.value || !file.value) return;
  await mutate(async () => {
    acceptSnapshot(
      await call("review.issue", {
        id: snapshot.value!.id,
        issue: {
          file: file.value!.path,
          side: side.value,
          line: line.value ? Number(line.value) : null,
          text: issueText.value,
        },
      }),
    );
    issueText.value = "";
    line.value = "";
    notify("审查问题已保存");
  });
}
async function issueState(issue: ReviewIssue) {
  await mutate(async () => {
    const value = await call<ReviewSnapshot>("review.issue-state", {
      id: snapshot.value!.id,
      issueId: issue.id,
      state: issueEdits.value[issue.id].state,
      reason: issueEdits.value[issue.id].reason,
    });
    const saved = value.issues.find((i) => i.id === issue.id)!;
    issueEdits.value[issue.id] = { state: saved.state, reason: saved.reason };
    acceptSnapshot(value);
    notify("问题状态已保存");
  });
}
async function end() {
  await mutate(async () => {
    acceptSnapshot(
      await call("review.conclude", {
        id: snapshot.value!.id,
        conclusion: conclusion.value,
        summary: summary.value,
      }),
    );
    notify("人工审查结论已保存");
  });
}
async function mutate(work: () => Promise<void>) {
  if (busy.value || validating.value || selectionChanged.value) return;
  busy.value = true;
  try {
    await attempt(work);
  } finally {
    busy.value = false;
  }
}
async function toTodo(issue: ReviewIssue) {
  await mutate(async () => {
    const note = await call<any>("review.todo", {
      id: snapshot.value!.id,
      issueId: issue.id,
    });
    issue.todoId = note.id;
    notify("已关联待办，可在灵感待办中查看");
  });
}
async function openHistory(id: string) {
  if (busy.value || !(await guard())) return;
  busy.value = true;
  await attempt(async () => {
    const value = await call<ReviewSnapshot>("review.get", { id });
    projectId.value = value.projectId;
    scope.value = value.scope;
    if (["versions", "ancestor"].includes(value.scope)) {
      base.value = value.base;
      target.value = value.target;
    }
    acceptSnapshot(value, true);
    selected.value = value.files[0]?.path || "";
    changed.value = false;
  });
  busy.value = false;
}
function locate(issue: ReviewIssue) {
  const f = snapshot.value?.files.find((f) => f.path === issue.file);
  if (!f || f.hash !== issue.snapshotHash) return;
  selected.value = f.path;
  if (issue.line)
    setTimeout(() => viewer.value?.line(issue.side, issue.line!), 0);
}
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
    ><button v-if="busy || validating" @click="call('review.cancel')">
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
  <p v-if="progress || validating" class="progress-line" role="status">
    <span class="spinner" />{{ progress || "正在核对代码是否变化…" }}
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
    <details class="review-limits">
      <summary>读取范围与大小限制</summary>
      <p class="small muted">
        内置正文单文件上限 512 KB、单份快照合计 16
        MB。超限内容可在编辑器查看；大文件按大小与修改时间核对变化，不加载正文。
        大批未跟踪文件先按大小与时间检测变化，选中后读取正文。远端最后获取
        {{
          snapshot.fetchedAt
            ? dateLabel(snapshot.fetchedAt)
            : "尚未通过工作台获取，引用可能过时"
        }}。
      </p>
    </details>
    <p v-if="changed || snapshot.stale" class="notice warning">
      {{
        changed
          ? "代码已变化，需要刷新后复查。原已看标记已失效。"
          : "比较内容或读取方式已变化，原意见保留来源，请复查当前代码。"
      }}
    </p>
    <fieldset
      class="review-content"
      :disabled="busy || validating || selectionChanged"
    >
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
              }}<small
                class="sub-line"
                :class="snapshot.seen[f.path] === f.hash ? 'seen' : 'muted'"
                >{{
                  f.binary
                    ? "二进制 · "
                    : f.limited
                      ? "超出内置大小限制 · "
                      : f.deferred && !f.contentHash
                        ? "按需读取正文 · "
                        : f.untracked
                          ? "未跟踪 · "
                          : ""
                }}{{
                  snapshot.seen[f.path] === f.hash ? "已看" : "未看"
                }}</small
              ></span
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
            <div class="actions">
              <button
                :disabled="
                  changed ||
                  !!contentLoading ||
                  (file.deferred && !file.contentHash)
                "
                @click="seen"
              >
                {{
                  snapshot.seen[file.path] === file.hash
                    ? "改为未看"
                    : "标记此文件已看"
                }}
              </button>
            </div></template
          >
          <p v-else class="empty">
            选择文件阅读真实差异。改变比较范围不会切换分支或修改暂存区。
          </p>
          <details
            class="section-rule"
            @toggle="
              ($event.target as HTMLDetailsElement).open &&
              attempt(
                async () => (rules = await call('review.rules', { projectId })),
              )
            "
          >
            <summary>当前项目规则</summary>
            <div v-for="r in rules" :key="r.path">
              <p class="path">{{ r.path }}</p>
              <pre class="rule-text">{{ r.text }}</pre>
            </div>
            <p v-if="!rules.length" class="muted small">
              未找到此项目自己的规则文件。
            </p>
          </details>
        </section>
        <section>
          <h2>
            审查意见 <small>{{ issues.length }}</small>
          </h2>
          <div v-for="issue in issues" :key="issue.id" class="issue">
            <button
              class="link small issue-locate"
              @click="locate(issue)"
            >
              {{ issue.file }}
              {{
                issue.line
                  ? (issue.side === "old" ? "旧" : "新") + " L" + issue.line
                  : "文件级"
              }}
            </button>
            <p
              v-if="
                snapshot.files.find((f) => f.path === issue.file)?.hash !==
                issue.snapshotHash
              "
              class="notice warning small"
            >
              位置已变化，保留原定位，不绑定到当前同号行。
            </p>
            <p>{{ issue.text }}</p>
            <select
              v-model="issueEdits[issue.id].state"
              aria-label="问题处理状态"
            >
              <option value="open">待处理</option>
              <option value="fixed">已处理待复查</option>
              <option value="resolved">已确认解决</option>
              <option value="declined">不采纳（需原因）</option></select
            ><input
              v-if="issueEdits[issue.id].state === 'declined'"
              v-model="issueEdits[issue.id].reason"
              placeholder="不采纳原因"
              aria-label="不采纳原因"
              class="issue-reason"
            />
            <div class="row wrap issue-actions">
              <button class="link small" @click="issueState(issue)">
                保存问题状态</button
              ><button class="link small" @click="toTodo(issue)">
                {{ issue.todoId ? "已有待办" : "转为待办" }}
              </button>
            </div>
          </div>
          <section class="section-rule">
            <h3>添加审查意见</h3>
            <p class="path">{{ file?.path || "先选择文件" }}</p>
            <div class="row issue-form-row">
              <select
                v-model="side"
                aria-label="意见版本侧"
                class="issue-side"
              >
                <option value="new">新版本</option>
                <option value="old">旧版本</option></select
              ><input
                v-model="line"
                type="number"
                min="1"
                placeholder="行号（可选）"
                aria-label="意见行号"
                class="issue-line"
              />
            </div>
            <textarea
              v-model="issueText"
              rows="4"
              placeholder="问题、预期、影响或处理建议…"
              aria-label="审查意见内容"
            />
            <div class="actions right">
              <button
                class="primary"
                :disabled="!file || !!contentLoading || !issueText.trim()"
                @click="addIssue"
              >
                添加问题
              </button>
            </div>
          </section>
        </section>
      </div>
      <section class="section-rule">
        <div class="review-summary">
          <span class="pill"
            >已看 {{ Object.keys(snapshot.seen).length }} /
            {{ snapshot.files.length }}</span
          ><span class="pill"
            >未解决
            {{
              issues.filter((i) => ["open", "fixed"].includes(i.state)).length
            }}</span
          ><span class="pill"
            >正文待选读
            {{
              snapshot.files.filter((f) => f.deferred && !f.contentHash).length
            }}</span
          ><span class="pill"
            >无法内置
            {{ snapshot.files.filter((f) => f.binary || f.limited).length }}</span
          ><button
            class="link small push-right"
            @click="
              attempt(
                () => call('review.copy', { id: snapshot!.id }),
                '问题列表已复制',
              )
            "
          >
            复制问题列表
          </button>
        </div>
        <div class="row wrap">
          <select v-model="conclusion" aria-label="人工审查结论">
            <option value="">选择人工结论</option>
            <option>已完成</option>
            <option>仍有待处理项</option></select
          ><input
            v-model="summary"
            placeholder="人工总结（可选）"
            aria-label="人工审查总结"
            class="review-summary-input"
          /><button
            class="primary"
            :disabled="!conclusion || changed"
            @click="end"
          >
            结束审查
          </button>
        </div>
        <p v-if="!conclusion" class="inline-note">
          选择人工结论后可结束本次审查。
        </p>
        <p class="inline-note">
          空问题列表不代表通过。结束审查不会提交代码，也不新增提交门禁。
        </p>
        <details>
          <summary>历史审查快照</summary>
          <button
            v-for="h in history.filter((h) => h.projectId === projectId)"
            :key="h.id"
            class="task-line small"
            @click="openHistory(h.id)"
          >
            {{ dateLabel(h.createdAt) }} · {{ h.scope }} ·
            {{ h.conclusion || "未结束" }} · {{ h.fileCount }} 文件
          </button>
          <button
            v-if="moreHistory"
            :disabled="historyLoading"
            class="link small"
            @click="attempt(() => loadHistory(true))"
          >
            读取更早的审查快照
          </button>
        </details>
      </section>
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

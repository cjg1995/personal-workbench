<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onDeactivated,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import type {
  ChangeFile,
  GitBranch,
  GitCommit,
  GitComparison,
  GitStash,
  RepositoryState,
} from "../../shared/git-client";
import { call, context, model, notify, route, setGuard, leaveGuard } from "../state";
import { submitTabForProject } from "../../shared/submit-policy";
import { gitOperationLabel } from "../../shared/git-labels";
import ProjectSelect from "../components/ProjectSelect.vue";
import Icon from "../components/Icon.vue";
import VirtualFiles from "../components/VirtualFiles.vue";
import CommitGraph from "../components/CommitGraph.vue";
import GitCommitPanel from "../components/GitCommitPanel.vue";
import SubmitPage from "./SubmitPage.vue";
const projectId = ref(context.value.projectId || "homeproject"),
  tab = ref("changes"),
  state = ref<RepositoryState>(),
  busy = ref(false),
  error = ref(""),
  statusError = ref(""),
  output = ref("");
const query = ref(""),
  filter = ref(
    ["staged", "unstaged"].includes(context.value.scope)
      ? context.value.scope
      : "all",
  ),
  sort = ref("path"),
  selected = ref(""),
  checked = ref<string[]>([]),
  message = ref(""),
  amend = ref(false);
const commitOpen = ref(false), submitOpen = ref(false),
  submitTaskId = ref("");
const submitPage = ref<InstanceType<typeof SubmitPage>>();
async function closeSubmit() {
  if (await submitPage.value?.canLeave() ?? true) submitOpen.value = false;
}
const canSubmit = computed(() => !!submitTabForProject(projectId.value));
const activeSubmitTask = computed(() => model.tasks.find((task) =>
  task.projectId === projectId.value && ["erp", "app"].includes(task.type) &&
  ["running", "awaiting", "cancelling"].includes(task.state)));
const pageRoot = ref<HTMLElement>();
const scrollPositions = new Map<HTMLElement, { top: number; left: number }>();
async function guard(reason?: "navigate" | "close") {
  if (submitOpen.value && !await submitPage.value?.canLeave()) return false;
  if (reason !== "close" || !message.value.trim()) return true;
  return call<boolean>("ui.confirm", {
    title: "提交说明尚未提交",
    message: "关闭工作台会丢弃此处提交说明。确认关闭？",
  });
}
watch(route, (next, previous) => {
  if (previous !== "review" || next === "review") return;
  scrollPositions.clear();
  for (const element of Array.from(pageRoot.value?.querySelectorAll<HTMLElement>("*") || []))
    if (element.scrollHeight > element.clientHeight || element.scrollWidth > element.clientWidth)
      scrollPositions.set(element, { top: element.scrollTop, left: element.scrollLeft });
}, { flush: "sync" });
async function openCommit() {
  tab.value = "changes";
  commitOpen.value = true;
  await nextTick();
  document.querySelector<HTMLTextAreaElement>(".git-commit-modal textarea")?.focus();
}
async function stageVisible(onlyChecked: boolean) {
  const paths = onlyChecked ? new Set(checked.value) : new Set(files.value.map((f) => f.path));
  await execute("stage", { files: state.value?.files.filter((f) => paths.has(f.path)).map((f) => f.path) });
}
function commit(push: boolean) {
  void execute("commit", { message: message.value, amend: amend.value, push });
}
async function openSubmit(taskId = "") {
  if (!canSubmit.value) return;
  await readStatus();
  if (statusError.value) return;
  submitTaskId.value = taskId;
  submitOpen.value = true;
}
const branches = ref<GitBranch[]>([]),
  commits = ref<GitCommit[]>([]),
  stashes = ref<GitStash[]>([]),
  branchQuery = ref(""),
  logQuery = ref(""),
  logFile = ref(""),
  logAll = ref(true),
  logMore = ref(false);
const quickBranchOpen = ref(false),
  quickBranchLoading = ref(false),
  quickBranchQuery = ref(""),
  quickBranchError = ref(""),
  quickBranchIndex = ref(0),
  quickBranchInput = ref<HTMLInputElement>(),
  quickBranchButton = ref<HTMLButtonElement>();
let quickBranchRequest = 0;
const quickBranches = computed(() =>
  branches.value
    .filter((branch) =>
      branch.name.toLowerCase().includes(quickBranchQuery.value.toLowerCase()),
    )
    .slice()
    .sort(
      (a, b) =>
        Number(a.remote) - Number(b.remote) ||
        Number(b.current) - Number(a.current) ||
        a.name.localeCompare(b.name),
    ),
);
async function toggleQuickBranches() {
  if (quickBranchOpen.value) {
    quickBranchOpen.value = false;
    return;
  }
  quickBranchOpen.value = true;
  quickBranchLoading.value = true;
  quickBranchQuery.value = "";
  quickBranchError.value = "";
  const project = projectId.value,
    id = ++quickBranchRequest;
  await nextTick();
  quickBranchInput.value?.focus();
  try {
    const rows = await call<GitBranch[]>("git.branches", {
      projectId: project,
    });
    if (!disposed && id === quickBranchRequest && project === projectId.value)
      branches.value = rows;
  } catch (value) {
    if (id === quickBranchRequest)
      quickBranchError.value =
        value instanceof Error ? value.message : String(value);
  } finally {
    if (id === quickBranchRequest) quickBranchLoading.value = false;
  }
}
function closeQuickBranches() {
  quickBranchOpen.value = false;
  quickBranchButton.value?.focus();
}
async function chooseQuickBranch(branch: GitBranch) {
  if (repositoryBusy.value || state.value?.operation) return;
  let chosen = branch;
  if (branch.remote) {
    const localName = branch.name.slice(branch.name.indexOf("/") + 1),
      existing = branches.value.find(
        (value) => !value.remote && value.name === localName,
      );
    if (existing) {
      if (existing.upstream !== branch.name) {
        quickBranchError.value = `本地分支 ${localName} 已存在且未跟踪 ${branch.name}，请在列表中选择该本地分支。`;
        return;
      }
      chosen = existing;
    }
  }
  quickBranchOpen.value = false;
  if (!chosen.current) await execute("checkout", { branch: chosen.name });
}
async function quickBranchKey(event: KeyboardEvent) {
  if (event.key === "Escape") {
    event.preventDefault();
    event.stopPropagation();
    closeQuickBranches();
    return;
  }
  if (event.key === "Enter") {
    event.preventDefault();
    event.stopPropagation();
    const branch = quickBranches.value[quickBranchIndex.value];
    if (branch) void chooseQuickBranch(branch);
    return;
  }
  if (
    !["ArrowUp", "ArrowDown"].includes(event.key) ||
    !quickBranches.value.length
  )
    return;
  event.preventDefault();
  quickBranchIndex.value =
    (quickBranchIndex.value +
      (event.key === "ArrowDown" ? 1 : -1) +
      quickBranches.value.length) %
    quickBranches.value.length;
  await nextTick();
  document
    .getElementById("quick-branch-" + quickBranchIndex.value)
    ?.scrollIntoView({ block: "nearest" });
}
watch(quickBranches, () => {
  const first = quickBranches.value.findIndex((branch) => !branch.current);
  quickBranchIndex.value = first >= 0 ? first : 0;
});
const chosenCommit = ref<GitCommit>(),
  details = ref<{
    commit: string;
    base: string;
    message: string;
    files: { path: string; oldPath?: string; status: string }[];
  }>(),
  compareCommit = ref("");
const dialog = ref(""),
  form = ref<Record<string, any>>({}),
  preview = ref<any>(),
  menu = ref<{ x: number; y: number; file?: ChangeFile; commit?: GitCommit }>();
let disposed = false,
  refreshId = 0,
  logId = 0,
  detailId = 0,
  unsubscribe: (() => void) | undefined,
  refreshTimer: ReturnType<typeof setTimeout> | undefined;
const files = computed(() => {
  const text = query.value.toLowerCase();
  return (state.value?.files || [])
    .filter(
      (f) =>
        showUntrackedFile(f) &&
        (!text || f.path.toLowerCase().includes(text)) &&
        (filter.value === "staged"
          ? f.staged
          : filter.value === "unstaged"
            ? f.unstaged
            : filter.value === "conflicts"
              ? f.conflicted
              : filter.value === "untracked"
                ? f.untracked
                : true),
    )
    .slice()
    .sort((a, b) =>
      sort.value === "status"
        ? a.status.localeCompare(b.status) || a.path.localeCompare(b.path)
        : a.path.localeCompare(b.path),
    );
});
function showUntrackedFile(file: ChangeFile) {
  return (
    !file.untracked ||
    file.inTrackedDirectory !== false
  );
}
const hiddenUntrackedCount = computed(() =>
  state.value?.files.filter(
        (file) => file.untracked && file.inTrackedDirectory === false,
      ).length || 0,
);
const stagedCount = computed(
    () => state.value?.files.filter((f) => f.staged).length || 0,
  ),
  conflicts = computed(
    () => state.value?.files.filter((f) => f.conflicted).length || 0,
  );
const filteredBranches = computed(() =>
  branches.value.filter((b) =>
    b.name.toLowerCase().includes(branchQuery.value.toLowerCase()),
  ),
);
const hasSelection = computed(() => checked.value.length > 0),
  compareMode = computed(() =>
    filter.value === "staged"
      ? "staged"
      : filter.value === "unstaged"
        ? "unstaged"
        : "local",
  );
const checkedSet = computed(() => new Set(checked.value));
const detailFiles = computed<ChangeFile[]>(() =>
  (details.value?.files || []).map((f) => ({
    ...f,
    x: " ",
    y: " ",
    staged: false,
    unstaged: false,
    untracked: false,
    conflicted: false,
  })),
);
const repositoryBusy = computed(
  () =>
    busy.value ||
    !!state.value?.locked ||
    model.tasks.some(
      (t) =>
        ["running", "awaiting", "cancelling"].includes(t.state) &&
        t.params.repo ===
          model.config?.projects.find((p) => p.id === projectId.value)?.path,
    ),
);
async function readStatus() {
  const id = ++refreshId,
    project = projectId.value;
  try {
    const next = await call<RepositoryState>("git.status", {
      projectId: project,
    });
    if (disposed || id !== refreshId) return;
    state.value = next;
    const paths = new Set(
      next.files.filter(showUntrackedFile).map((f) => f.path),
    );
    checked.value = checked.value.filter((file) => paths.has(file));
    if (selected.value && !paths.has(selected.value)) selected.value = "";
    statusError.value = "";
  } catch (e) {
    if (!disposed && id === refreshId)
      statusError.value = String(e instanceof Error ? e.message : e);
  }
}
async function loadTab() {
  const project = projectId.value,
    current = tab.value;
  try {
    if (current === "branches") {
      const value = await call<GitBranch[]>("git.branches", {
        projectId: project,
      });
      if (project === projectId.value && !disposed) branches.value = value;
    }
    if (current === "stash") {
      const value = await call<GitStash[]>("git.stashes", {
        projectId: project,
      });
      if (project === projectId.value && !disposed) stashes.value = value;
    }
    if (current === "log") await loadLog();
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), true);
  }
}
async function refresh() {
  await readStatus();
  await loadTab();
}
async function execute(operation: string, p: Record<string, any> = {}) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    const result = await call<any>("git.execute", {
      ...p,
      projectId: projectId.value,
      operation,
    });
    if (!result.cancelled) {
      output.value = result.output || "Git 操作已完成";
      notify("Git · " + gitOperationLabel(operation) + " 已完成");
      dialog.value = "";
      if (operation === "commit") {
        commitOpen.value = false;
        message.value = "";
        amend.value = false;
      }
      checked.value = [];
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    output.value = error.value;
  } finally {
    await refresh();
    busy.value = false;
  }
}
function toggle(file: ChangeFile) {
  checked.value = checked.value.includes(file.path)
    ? checked.value.filter((p) => p !== file.path)
    : [...checked.value, file.path];
}
function stage(operation: "stage" | "unstage" | "rollback", file?: ChangeFile) {
  const byPath = new Map(state.value?.files.map((f) => [f.path, f]));
  void execute(operation, {
    files: file
      ? [
          file.path,
          ...(operation === "unstage" && file.oldPath ? [file.oldPath] : []),
        ]
      : checked.value.flatMap((file) => {
          const f = byPath.get(file);
          return [
            file,
            ...(operation === "unstage" && f?.oldPath ? [f.oldPath] : []),
          ];
        }),
  });
  menu.value = undefined;
}
async function showDiff(file: ChangeFile, comparison?: GitComparison) {
  if (busy.value) return;
  try {
    await call("git.diff-open", {
      projectId: projectId.value,
      file: file.path,
      comparison: comparison || { mode: compareMode.value },
      conflict: file.conflicted,
      trackedDirectoriesOnly: true,
    });
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), true);
  }
}
function open(kind: string, values: Record<string, any> = {}) {
  dialog.value = kind;
  preview.value = undefined;
  form.value = {
    remote: state.value?.remotes[0] || "origin",
    branch: state.value?.branch || "",
    name: "",
    ref: "HEAD",
    strategy: "merge",
    message: "",
    untracked: false,
    noFF: false,
    base: "HEAD",
    target: values.ref || "HEAD",
    working: false,
    ...values,
  };
  menu.value = undefined;
}
async function submitDialog() {
  if (dialog.value === "compare") {
    try {
      const comparison: GitComparison = {
        mode: form.value.working ? "history" : "versions",
        base: form.value.base,
        target: form.value.target,
        file: form.value.file || undefined,
      };
      const changed = await call<ChangeFile[]>("git.files", {
        projectId: projectId.value,
        comparison,
      });
      if (!changed.length) {
        notify("这两个版本没有差异");
        return;
      }
      await showDiff(changed[0], comparison);
      dialog.value = "";
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
    return;
  }
  if (dialog.value === "push" && !preview.value) {
    try {
      preview.value = await call("git.push-preview", {
        ...form.value,
        projectId: projectId.value,
      });
    } catch (e) {
      notify(e instanceof Error ? e.message : String(e), true);
    }
    return;
  }
  await execute(dialog.value, {
    ...form.value,
    ...(dialog.value === "push" ? { head: preview.value?.head } : {}),
  });
}
async function loadLog(append = false) {
  const id = ++logId,
    project = projectId.value,
    offset = append ? commits.value.length : 0;
  try {
    const rows = await call<GitCommit[]>("git.log", {
      projectId: project,
      offset,
      query: logQuery.value,
      file: logFile.value || undefined,
      all: logAll.value,
    });
    if (id !== logId || disposed || project !== projectId.value) return;
    commits.value = append ? [...commits.value, ...rows] : rows;
    logMore.value = rows.length === 150;
  } catch (e) {
    if (id === logId) notify(e instanceof Error ? e.message : String(e), true);
  }
}
async function selectCommit(commit: GitCommit) {
  chosenCommit.value = commit;
  details.value = undefined;
  const id = ++detailId;
  try {
    const value = await call<any>("git.commit-details", {
      projectId: projectId.value,
      ref: commit.hash,
    });
    if (id === detailId && !disposed) details.value = value;
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), true);
  }
}
function history(file: ChangeFile) {
  tab.value = "log";
  logFile.value = file.path;
  logAll.value = false;
  menu.value = undefined;
  void loadLog();
}
function historicalDiff(file: { path: string; status: string }) {
  if (!details.value) return;
  void showDiff(
    {
      ...file,
      x: " ",
      y: " ",
      staged: false,
      unstaged: false,
      conflicted: false,
      untracked: false,
    },
    {
      mode: "versions",
      base: details.value.base || "__empty__",
      target: details.value.commit,
    },
  );
}
async function stashDiff(stash: GitStash, untracked = false) {
  const comparison: GitComparison = {
    mode: "versions",
    base: untracked ? "__empty__" : `${stash.hash}^1`,
    target: untracked ? `${stash.hash}^3` : stash.hash,
  };
  try {
    const list = await call<ChangeFile[]>("git.files", {
      projectId: projectId.value,
      comparison,
    });
    if (list.length) await showDiff(list[0], comparison);
    else notify("此 Stash 范围没有文件");
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), true);
  }
}
function fileMenu(file: ChangeFile, event: MouseEvent) {
  selected.value = file.path;
  menu.value = {
    x: Math.min(event.clientX, window.innerWidth - 220),
    y: Math.min(event.clientY, window.innerHeight - 320),
    file,
  };
}
function commitMenu(commit: GitCommit, event: MouseEvent) {
  menu.value = {
    x: Math.min(event.clientX, window.innerWidth - 230),
    y: Math.min(event.clientY, window.innerHeight - 300),
    commit,
  };
}
function closeMenu() {
  menu.value = undefined;
  quickBranchOpen.value = false;
}
function key(event: KeyboardEvent) {
  if (route.value !== "review") return;
  if (event.key === "F5") {
    event.preventDefault();
    void refresh();
  }
  if (event.ctrlKey && event.key === "Enter") {
    event.preventDefault();
    if (
      !dialog.value && !submitOpen.value && !repositoryBusy.value &&
      tab.value === "changes" &&
      (stagedCount.value || amend.value) &&
      message.value.trim()
    )
      void execute("commit", { message: message.value, amend: amend.value });
  }
  if (event.key === "Escape") {
    menu.value = undefined;
    if (quickBranchOpen.value) closeQuickBranches();
    if (!busy.value) dialog.value = "";
    commitOpen.value = false;
    void closeSubmit();
  }
}
function onFocus() {
  if (route.value === "review" && !busy.value) void readStatus();
}
watch(projectId, () => {
  ++quickBranchRequest;
  quickBranchOpen.value = false;
  quickBranchLoading.value = false;
  ++logId;
  ++detailId;
  state.value = undefined;
  selected.value = "";
  checked.value = [];
  commits.value = [];
  branches.value = [];
  stashes.value = [];
  details.value = undefined;
  chosenCommit.value = undefined;
  logFile.value = "";
  output.value = "";
  message.value = "";
  amend.value = false;
  dialog.value = "";
  commitOpen.value = false;
  submitOpen.value = false;
  void refresh();
});
watch(tab, () => void loadTab());
onMounted(() => {
  window.addEventListener("keydown", key);
  window.addEventListener("click", closeMenu);
  window.addEventListener("focus", onFocus);
  unsubscribe = window.workbench.onChanged(() => {
    if (!refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (route.value === "review" && !busy.value) void refresh();
      }, 450);
  });
});
function applyContext() {
  if (route.value !== "review") return;
  if (context.value.projectId) projectId.value = context.value.projectId;
  if (["all", "staged", "unstaged"].includes(context.value.scope))
    filter.value = context.value.scope;
  if (context.value.submit) void openSubmit(context.value.taskId || "");
}
watch(context, applyContext);
onActivated(async () => {
  setGuard(guard);
  applyContext();
  void refresh();
  await nextTick();
  for (const [element, position] of scrollPositions)
    if (element.isConnected) element.scrollTo(position);
});
onDeactivated(() => {
  closeMenu();
  if (leaveGuard === guard) setGuard(null);
});
onBeforeUnmount(() => {
  ++quickBranchRequest;
  disposed = true;
  ++refreshId;
  ++logId;
  ++detailId;
  unsubscribe?.();
  clearTimeout(refreshTimer);
  window.removeEventListener("keydown", key);
  window.removeEventListener("click", closeMenu);
  window.removeEventListener("focus", onFocus);
  if (leaveGuard === guard) setGuard(null);
});
</script>
<template>
  <div ref="pageRoot" class="git-page">
    <div class="git-toolbar">
      <ProjectSelect
        v-model="projectId"
        :optional="false"
        label="Git 项目"
        :disabled="busy"
      />
      <div class="git-quick-branch" @click.stop>
        <button
          ref="quickBranchButton"
          class="git-branch-button"
          title="切换分支"
          aria-label="切换分支"
          aria-haspopup="listbox"
          :aria-expanded="quickBranchOpen"
          aria-controls="quick-branch-options"
          :disabled="repositoryBusy || submitOpen"
          @click="toggleQuickBranches"
        >
          <Icon name="branch" :size="16" /><span
            class="git-current-branch"
            :title="state?.branch"
            >{{
              state?.branch || (state?.detached ? "游离 HEAD" : "尚未读取")
            }}</span
          ><span class="git-branch-caret">▾</span>
        </button>
        <div
          v-if="quickBranchOpen"
          class="git-quick-branch-menu"
          @keydown="quickBranchKey"
        >
          <input
            ref="quickBranchInput"
            v-model="quickBranchQuery"
            role="combobox"
            aria-label="搜索并切换分支"
            aria-controls="quick-branch-options"
            aria-expanded="true"
            :aria-activedescendant="
              quickBranches.length
                ? 'quick-branch-' + quickBranchIndex
                : undefined
            "
            type="search"
            placeholder="搜索本地 / 远程分支"
            autocomplete="off"
          />
          <p
            v-if="quickBranchLoading"
            class="git-quick-branch-message"
            role="status"
          >
            正在读取分支…
          </p>
          <p
            v-if="quickBranchError"
            class="git-quick-branch-message git-quick-branch-error"
            role="alert"
          >
            {{ quickBranchError }}
          </p>
          <p v-if="state?.operation" class="git-quick-branch-message">
            请先完成 {{ gitOperationLabel(state.operation) }}，再切换分支。
          </p>
          <div
            id="quick-branch-options"
            role="listbox"
            aria-label="可切换分支"
            class="git-quick-branch-options"
          >
            <template
              v-for="(branch, index) in quickBranches"
              :key="branch.name + (branch.remote ? 'remote' : 'local')"
            >
              <div
                v-if="
                  index === 0 ||
                  branch.remote !== quickBranches[index - 1].remote
                "
                class="git-quick-branch-group"
              >
                {{ branch.remote ? "远程分支 · 签出并跟踪" : "本地分支" }}
              </div>
              <button
                :id="'quick-branch-' + index"
                role="option"
                :aria-selected="branch.current"
                :class="{ highlighted: index === quickBranchIndex }"
                :disabled="
                  repositoryBusy || !!state?.operation || branch.current
                "
                :title="branch.name"
                @mouseenter="quickBranchIndex = index"
                @click="chooseQuickBranch(branch)"
              >
                <Icon name="branch" :size="14" /><span
                  >{{ branch.name
                  }}<small v-if="branch.upstream">{{
                    branch.upstream
                  }}</small></span
                ><strong v-if="branch.current">当前</strong>
              </button>
            </template>
            <p
              v-if="!quickBranchLoading && !quickBranches.length"
              class="git-quick-branch-message"
            >
              没有匹配的分支
            </p>
          </div>
        </div>
      </div>
      <span
        class="git-sync-status"
        :title="state?.upstream || '尚未配置上游分支'"
        >↑ {{ state?.ahead || 0 }} ↓ {{ state?.behind || 0 }}</span
      >
      <span class="git-toolbar-separator" />
      <button :disabled="repositoryBusy" @click="execute('fetch')">Fetch</button
      ><button :disabled="repositoryBusy" @click="open('pull')">Pull</button
      ><button :disabled="repositoryBusy" @click="open('push')">Push</button>
      <button :disabled="repositoryBusy" title="打开本地提交窗口" @click="openCommit">
        Commit <span class="git-count">{{ stagedCount }}</span></button
      ><button :disabled="repositoryBusy" @click="open('stash-push')">
        Stash
      </button>
      <button class="primary" :disabled="!canSubmit || busy || (repositoryBusy && !activeSubmitTask)"
        :title="canSubmit ? '提交已暂存内容与已跟踪修改' : '此项目尚未配置提测流程'"
        @click="openSubmit()"><Icon name="merge" :size="14" />一键提测</button>
      <details class="git-more">
        <summary>更多 ···</summary>
        <div class="git-dropdown">
          <button @click="open('compare')">比较分支 / 提交</button
          ><button @click="open('create-branch')">从提交创建分支</button
          ><button @click="open('merge')">Merge 到当前分支</button
          ><button @click="open('rebase')">Rebase 当前分支到…</button>
        </div>
      </details>
      <button
        class="git-refresh"
        title="刷新（F5）"
        :disabled="busy"
        @click="refresh"
      >
        <Icon name="refresh" :size="15" />
      </button>
    </div>
    <div
      v-if="state?.operation || conflicts"
      class="git-operation-bar"
      role="status"
    >
      <Icon name="warning" :size="16" /><strong>{{
        state?.operation ? gitOperationLabel(state.operation) : "冲突待处理"
      }}</strong
      ><span>{{ conflicts }} 个冲突文件</span
      ><button
        @click="
          tab = 'changes';
          filter = 'conflicts';
        "
      >
        查看冲突</button
      ><button
        v-if="state?.operation"
        :disabled="repositoryBusy || !!conflicts"
        @click="execute('continue')"
      >
        Continue</button
      ><button
        v-if="['rebase', 'cherry-pick'].includes(state?.operation || '')"
        :disabled="repositoryBusy"
        @click="execute('skip')"
      >
        Skip</button
      ><button
        v-if="state?.operation"
        :disabled="repositoryBusy"
        @click="execute('abort')"
      >
        Abort
      </button>
    </div>
    <div class="git-tabs" role="tablist" aria-label="Git 功能">
      <button
        v-for="item in [
          ['changes', '本地变更'],
          ['log', 'Git Log'],
          ['branches', '分支'],
          ['stash', 'Stash'],
        ]"
        :key="item[0]"
        role="tab"
        :aria-selected="tab === item[0]"
        :class="{ active: tab === item[0] }"
        @click="tab = item[0]"
      >
        {{ item[1]
        }}<span v-if="item[0] === 'changes'" class="git-count">{{
          state?.files.filter(showUntrackedFile).length || 0
        }}</span></button
      ><span class="git-tab-hint">{{
        busy ? "Git 操作执行中…" : state?.upstream || "本地仓库 · 未配置上游分支"
      }}</span>
    </div>
    <div v-if="error || statusError" class="git-error" role="alert">
      {{ error || statusError
      }}<button
        @click="
          error = '';
          statusError = '';
        "
      >
        ×
      </button>
    </div>
    <div v-if="tab === 'changes'" class="git-changes-layout">
      <section class="git-changes-panel">
        <div class="git-filterbar">
          <input
            v-model="query"
            type="search"
            placeholder="搜索文件路径"
            aria-label="搜索变更文件"
          /><select v-model="filter" aria-label="变更范围">
            <option value="all">全部变更</option>
            <option value="staged">已暂存</option>
            <option value="unstaged">未暂存</option>
            <option value="untracked">未跟踪</option>
            <option value="conflicts">冲突</option></select
          ><select v-model="sort" aria-label="文件排序">
            <option value="path">按路径</option>
            <option value="status">按状态</option>
          </select>
        </div>
        <div
          v-if="hiddenUntrackedCount"
          class="git-untracked-filter"
        >
          <span class="muted" title="项目根目录及全新子目录中的未跟踪文件默认隐藏。"
            >已隐藏 {{ hiddenUntrackedCount }} 个未跟踪文件</span
          >
        </div>
        <div class="git-selectionbar">
          <label
            ><input
              type="checkbox"
              :checked="
                !!files.length && files.every((f) => checkedSet.has(f.path))
              "
              aria-label="选择当前列表全部文件"
              @change="
                checked = ($event.target as HTMLInputElement).checked
                  ? files.map((f) => f.path)
                  : []
              "
            />{{
              checked.length
                ? `已选择 ${checked.length} 个`
                : `${files.length} 个文件`
            }}</label
          ><button
            :disabled="repositoryBusy || !hasSelection"
            @click="stage('stage')"
          >
            Stage</button
          ><button
            :disabled="repositoryBusy || !hasSelection"
            @click="stage('unstage')"
          >
            Unstage</button
          ><button
            :disabled="repositoryBusy || !hasSelection"
            @click="stage('rollback')"
          >
            回滚未暂存修改
          </button>
        </div>
        <VirtualFiles
          :files="files"
          :selected="selected"
          :checked="checked"
          multiple
          @select="selected = $event.path"
          @toggle="toggle"
          @show="showDiff($event)"
          @menu="fileMenu"
        />
        <div class="git-file-footer">
          <span>双击 / Enter · 独立窗口对比</span
          ><span>● 已暂存 · ◐ 同时有未暂存修改</span>
        </div>
      </section>
      <aside class="git-commit-panel">
        <GitCommitPanel v-model:message="message" v-model:amend="amend"
          :staged-count="stagedCount" :busy="repositoryBusy" :upstream="state?.upstream"
          :visible-count="files.length" :checked-count="checked.length"
          @stage="stageVisible" @inspect="filter = 'staged'" @commit="commit" />
        <div v-if="selected" class="git-selected-detail">
          <span class="muted">当前文件</span><code>{{ selected }}</code
          ><button
            @click="showDiff(state!.files.find((f) => f.path === selected)!)"
          >
            打开对比 ↗
          </button>
        </div>
      </aside>
    </div>
    <div v-else-if="tab === 'log'" class="git-log-layout">
      <div class="git-log-main">
        <form class="git-filterbar" @submit.prevent="loadLog()">
          <input
            v-model="logQuery"
            aria-label="搜索提交说明"
            placeholder="搜索提交说明"
          /><input
            v-model="logFile"
            aria-label="文件历史路径"
            placeholder="文件路径（可选）"
          /><label class="git-checkbox"
            ><input v-model="logAll" type="checkbox" />全部分支</label
          ><button type="submit">筛选</button
          ><button
            type="button"
            @click="
              logQuery = '';
              logFile = '';
              loadLog();
            "
          >
            重置
          </button>
        </form>
        <div class="git-log-scroll">
          <CommitGraph
            :commits="commits"
            :selected="chosenCommit?.hash || ''"
            @select="selectCommit"
            @menu="commitMenu"
          /><button v-if="logMore" class="git-load-more" @click="loadLog(true)">
            加载更多历史
          </button>
          <p v-if="!commits.length" class="git-empty">没有匹配的提交</p>
        </div>
      </div>
      <aside class="git-log-detail">
        <template v-if="details"
          ><code>{{ details.commit }}</code>
          <pre>{{ details.message }}</pre>
          <div class="git-detail-actions">
            <button
              :disabled="repositoryBusy"
              @click="execute('revert', { ref: details.commit })"
            >
              Revert</button
            ><button
              :disabled="repositoryBusy"
              @click="execute('cherry-pick', { ref: details.commit })"
            >
              Cherry-pick</button
            ><button @click="open('create-branch', { ref: details.commit })">
              创建分支</button
            ><button @click="compareCommit = details.commit">
              选为比较起点</button
            ><button
              v-if="compareCommit"
              @click="
                open('compare', { base: compareCommit, target: details.commit })
              "
            >
              比较两个提交
            </button>
          </div>
          <p class="git-help">
            {{ details.files.length }} 个修改文件 · 双击 / Enter 查看
          </p>
          <VirtualFiles
            :files="detailFiles"
            @select="selected = $event.path"
            :selected="selected"
            @show="historicalDiff($event)"
        /></template>
        <p v-else class="git-empty">选择提交查看详情与文件</p>
      </aside>
    </div>
    <div v-else-if="tab === 'branches'" class="git-branches">
      <div class="git-filterbar">
        <input
          v-model="branchQuery"
          type="search"
          aria-label="搜索分支"
          placeholder="搜索本地 / 远程分支"
        /><button :disabled="repositoryBusy" @click="open('create-branch')">
          新建分支</button
        ><button @click="open('compare')">比较分支</button>
      </div>
      <div class="git-branch-list">
        <div
          v-for="branch in filteredBranches"
          :key="branch.name"
          class="git-branch-row"
        >
          <Icon name="branch" :size="17" />
          <div class="git-branch-name">
            <strong
              >{{ branch.name }}
              <span v-if="branch.current" class="git-ref-label">当前</span
              ><span v-else class="muted small">{{
                branch.remote ? "远程" : "本地"
              }}</span></strong
            ><small
              >{{ branch.subject }}
              <span v-if="branch.upstream">· {{ branch.upstream }}</span></small
            >
          </div>
          <div class="git-branch-actions">
            <button
              v-if="!branch.current"
              :disabled="repositoryBusy"
              @click="execute('checkout', { branch: branch.name })"
            >
              Checkout</button
            ><button
              :disabled="repositoryBusy"
              @click="open('merge', { ref: branch.name })"
            >
              Merge</button
            ><button
              :disabled="repositoryBusy"
              @click="open('rebase', { ref: branch.name })"
            >
              Rebase
            </button>
            <details class="git-more">
              <summary>···</summary>
              <div class="git-dropdown">
                <button
                  @click="
                    open('compare', { base: 'HEAD', target: branch.name })
                  "
                >
                  与 HEAD 比较</button
                ><button
                  v-if="!branch.remote"
                  @click="
                    open('rename-branch', {
                      branch: branch.name,
                      name: branch.name,
                    })
                  "
                >
                  重命名</button
                ><button
                  v-if="!branch.remote && !branch.current"
                  :disabled="repositoryBusy"
                  @click="execute('delete-branch', { branch: branch.name })"
                >
                  删除已合并分支
                </button>
              </div>
            </details>
          </div>
        </div>
        <p v-if="!filteredBranches.length" class="git-empty">没有匹配分支</p>
      </div>
    </div>
    <div v-else class="git-stash-panel">
      <div class="git-filterbar">
        <span>临时保存当前修改，稍后恢复</span
        ><button :disabled="repositoryBusy" @click="open('stash-push')">
          Stash Push
        </button>
      </div>
      <div class="git-stash-list">
        <article
          v-for="stash in stashes"
          :key="stash.hash"
          class="git-stash-row"
        >
          <div>
            <strong>{{ stash.ref }}</strong
            ><span>{{ stash.subject }}</span
            ><small
              >{{ stash.date.slice(0, 19).replace("T", " ") }} ·
              {{ stash.hash.slice(0, 8) }}</small
            >
          </div>
          <div class="git-stash-actions">
            <button @click="stashDiff(stash)">Diff</button
            ><button
              title="查看包含的未跟踪文件；未包含时会提示"
              @click="stashDiff(stash, true)"
            >
              未跟踪文件</button
            ><button
              :disabled="repositoryBusy"
              title="应用并保留记录"
              @click="execute('stash-apply', stash)"
            >
              Stash Apply</button
            ><button
              :disabled="repositoryBusy"
              title="成功应用后移除记录"
              @click="execute('stash-pop', stash)"
            >
              Stash Pop</button
            ><button
              :disabled="repositoryBusy"
              @click="execute('stash-drop', stash)"
            >
              Stash Drop
            </button>
          </div>
        </article>
        <p v-if="!stashes.length" class="git-empty">没有 Stash 记录</p>
      </div>
    </div>
    <details v-if="output" class="git-output">
      <summary>最近操作结果 / Git 钩子输出</summary>
      <pre>{{ output }}</pre>
    </details>
    <div
      v-if="menu"
      class="git-context-menu"
      :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
      role="menu"
      @click.stop
    >
      <template v-if="menu.file"
        ><button
          role="menuitem"
          @click="
            showDiff(menu.file);
            closeMenu();
          "
        >
          打开对比 ↗</button
        ><button
          role="menuitem"
          :disabled="repositoryBusy"
          @click="stage('stage', menu.file)"
        >
          Stage</button
        ><button
          role="menuitem"
          :disabled="repositoryBusy"
          @click="stage('unstage', menu.file)"
        >
          Unstage</button
        ><button
          role="menuitem"
          :disabled="repositoryBusy"
          @click="stage('rollback', menu.file)"
        >
          回滚未暂存修改…</button
        ><button role="menuitem" @click="history(menu.file)">
          查看文件历史</button
        ><button
          role="menuitem"
          @click="
            open('compare', {
              file: menu.file.path,
              base: 'HEAD',
              working: true,
            })
          "
        >
          与历史版本比较…</button
        ><button
          role="menuitem"
          @click="
            call('git.copy', { projectId, text: menu.file.path });
            closeMenu();
          "
        >
          复制相对路径</button
        ><button
          role="menuitem"
          @click="
            call('git.reveal', { projectId, file: menu.file.path });
            closeMenu();
          "
        >
          在文件资源管理器中打开
        </button></template
      >
      <template v-if="menu.commit"
        ><button
          role="menuitem"
          @click="
            call('git.copy', { projectId, text: menu.commit.hash });
            closeMenu();
          "
        >
          复制提交号</button
        ><button
          role="menuitem"
          :disabled="repositoryBusy"
          @click="
            execute('revert', { ref: menu.commit.hash });
            closeMenu();
          "
        >
          Revert 此提交…</button
        ><button
          role="menuitem"
          :disabled="repositoryBusy"
          @click="
            execute('cherry-pick', { ref: menu.commit.hash });
            closeMenu();
          "
        >
          Cherry-pick…</button
        ><button
          role="menuitem"
          @click="open('compare', { base: menu.commit.hash, target: 'HEAD' })"
        >
          与 HEAD 比较</button
        ><button
          role="menuitem"
          @click="open('create-branch', { ref: menu.commit.hash })"
        >
          从此提交创建分支</button
        ><button
          v-if="menu.commit.hash === state?.head"
          role="menuitem"
          :disabled="repositoryBusy"
          @click="
            execute('undo-last', { head: menu.commit.hash });
            closeMenu();
          "
        >
          撤销最后一次提交…
        </button></template
      >
    </div>
    <div v-if="commitOpen" class="git-dialog-overlay" @click.self="!busy && (commitOpen = false)">
      <section class="git-dialog git-commit-modal" role="dialog" aria-modal="true" aria-label="本地提交">
        <div class="section-head"><h2>本地提交</h2><button aria-label="关闭提交窗口" :disabled="busy" @click="commitOpen = false">×</button></div>
        <GitCommitPanel v-model:message="message" v-model:amend="amend"
          :staged-count="stagedCount" :busy="repositoryBusy" :upstream="state?.upstream"
          :visible-count="files.length" :checked-count="checked.length"
          @stage="stageVisible" @inspect="filter = 'staged'; commitOpen = false" @commit="commit" />
        <p v-if="error" class="git-error" role="alert">{{ error }}</p>
      </section>
    </div>
    <div v-if="submitOpen" class="git-dialog-overlay" @click.self="closeSubmit">
      <section class="git-dialog git-submit-dialog" role="dialog" aria-modal="true" aria-label="一键提测">
        <div class="section-head"><h2>一键提测 · {{ model.config?.projects.find(p => p.id === projectId)?.name }}</h2><button aria-label="关闭提测窗口" @click="closeSubmit">×</button></div>
        <div class="git-submit-content"><SubmitPage ref="submitPage" :key="projectId" :project-id="projectId" :task-id="submitTaskId" /></div>
      </section>
    </div>
    <div
      v-if="dialog"
      class="git-dialog-overlay"
      @click.self="!busy && (dialog = '')"
    >
      <form class="git-dialog" @submit.prevent="submitDialog">
        <h2>
          {{
            {
              push: "Push",
              pull: "Pull",
              "stash-push": "Stash Push",
              "create-branch": "新建分支",
              "rename-branch": "重命名分支",
              merge: "Merge 到当前分支",
              rebase: "Rebase 当前分支到…",
              compare: "比较版本",
            }[dialog] || dialog
          }}
        </h2>
        <p class="git-help">
          当前项目
          {{ model.config?.projects.find((p) => p.id === projectId)?.name }} ·
          {{ state?.branch }}
        </p>
        <template v-if="dialog === 'push'"
          ><label
            >远程仓库<select v-model="form.remote" :disabled="!!preview">
              <option v-for="remote in state?.remotes" :key="remote">
                {{ remote }}
              </option>
            </select></label
          ><label
            >目标分支<input
              v-model="form.branch"
              :disabled="!!preview"
              required
          /></label>
          <pre v-if="preview" class="git-push-preview"
            >{{ preview.commits || "无新增提交"
            }}{{ preview.newBranch ? "\n将创建远程分支" : "" }}</pre
          >
        </template>
        <template v-else-if="dialog === 'pull'"
          ><p>上游分支 · {{ state?.upstream || "未配置" }}</p>
          <label
            >Pull 策略<select v-model="form.strategy">
              <option value="merge">Merge · 合并远程变更</option>
              <option value="rebase">Rebase · 重放本地提交</option>
            </select></label
          ></template
        >
        <template v-else-if="dialog === 'stash-push'"
          ><label
            >说明<input
              v-model="form.message"
              placeholder="临时保存说明" /></label
          ><label class="git-checkbox"
            ><input v-model="form.untracked" type="checkbox" />包含未跟踪文件</label
          >
          <p class="git-help">
            Stash Apply 应用后保留记录；Stash Pop 成功应用后移除记录。
          </p></template
        >
        <template v-else-if="dialog === 'compare'"
          ><label
            >原始版本<input
              v-model="form.base"
              required
              placeholder="分支或提交号" /></label
          ><label v-if="!form.working"
            >目标版本<input
              v-model="form.target"
              required
              placeholder="分支或提交号" /></label
          ><label class="git-checkbox"
            ><input v-model="form.working" type="checkbox" />目标为当前工作区</label
          ><label
            >仅此文件（可选）<input
              v-model="form.file"
              placeholder="仓库相对路径" /></label
        ></template>
        <template v-else-if="['merge', 'rebase'].includes(dialog)"
          ><label
            >源分支 / 提交号<input
              v-model="form.ref"
              required
              list="git-refs" /></label
          ><label v-if="dialog === 'merge'" class="git-checkbox"
            ><input v-model="form.noFF" type="checkbox" />创建合并提交（--no-ff）</label
          >
          <p v-if="dialog === 'rebase'" class="git-help">
            Rebase 会重写历史。已推送分支需先与协作者确认。
          </p></template
        >
        <template v-else
          ><label>分支名称<input v-model="form.name" required /></label
          ><label v-if="dialog === 'create-branch'"
            >起点提交号 / 分支<input v-model="form.ref" required /></label
        ></template>
        <datalist id="git-refs">
          <option
            v-for="branch in branches"
            :key="branch.name"
            :value="branch.name"
          />
        </datalist>
        <footer>
          <button type="button" :disabled="busy" @click="dialog = ''">
            取消</button
          ><button type="submit" class="primary" :disabled="repositoryBusy">
            {{ dialog === "push" && !preview ? "预览待推送提交" : "继续" }}
          </button>
        </footer>
      </form>
    </div>
  </div>
</template>

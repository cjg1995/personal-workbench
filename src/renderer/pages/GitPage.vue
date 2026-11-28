<script setup lang="ts">
import {
  computed,
  nextTick,
  onActivated,
  onDeactivated,
  onBeforeUnmount,
  onMounted,
  ref,
  shallowRef,
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
import {
  attempt,
  call,
  confirm,
  context,
  model,
  navigate,
  notify,
  route,
  setGuard,
  leaveGuard,
} from "../state";
import { activeDialog } from "../dialog";
import { formatDateTime } from "../format";
import { submitTabForProject } from "../../shared/submit-policy";
import { gitOperationLabel } from "../../shared/git-labels";
import { describeUntrackedRule } from "../../shared/git-untracked";
import ProjectSelect from "../components/ProjectSelect.vue";
import Icon from "../components/Icon.vue";
import VirtualFiles from "../components/VirtualFiles.vue";
import CommitGraph from "../components/CommitGraph.vue";
import GitCommitPanel from "../components/GitCommitPanel.vue";
import { useGitCommitDraft } from "../git-commit-draft";
import SubmitPage from "./SubmitPage.vue";
import CloseButton from "../components/CloseButton.vue";

const projectId = ref(context.value.projectId || "homeproject"),
  tab = ref("changes"),
  state = shallowRef<RepositoryState>(),
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
  message = useGitCommitDraft(projectId),
  amend = ref(false),
  moreOpsOpen = ref(false);
const commitOpen = ref(false),
  submitOpen = ref(false),
  submitTaskId = ref("");
const submitPage = ref<InstanceType<typeof SubmitPage>>();

async function closeSubmit() {
  if ((await submitPage.value?.canLeave()) ?? true) submitOpen.value = false;
}

const canSubmit = computed(() => !!submitTabForProject(projectId.value));
const activeSubmitTask = computed(() =>
  model.tasks.find(
    (task) =>
      task.projectId === projectId.value &&
      ["erp", "app"].includes(task.type) &&
      ["running", "awaiting", "cancelling"].includes(task.state),
  ),
);
const pageRoot = ref<HTMLElement>();
const scrollPositions = new Map<HTMLElement, { top: number; left: number }>();

async function guard(reason?: "navigate" | "close") {
  if (submitOpen.value && !(await submitPage.value?.canLeave())) return false;
  if (reason !== "close" || !message.value.trim()) return true;
  return confirm(
    "提交说明尚未提交",
    "关闭工作台会丢弃此处提交说明，确认关闭？",
    "丢弃并关闭",
    { tone: "warning", danger: true },
  );
}

watch(
  route,
  (next, previous) => {
    if (previous !== "review" || next === "review") return;
    scrollPositions.clear();
    for (const element of Array.from(
      pageRoot.value?.querySelectorAll<HTMLElement>("*") || [],
    ))
      if (
        element.scrollHeight > element.clientHeight ||
        element.scrollWidth > element.clientWidth
      )
        scrollPositions.set(element, {
          top: element.scrollTop,
          left: element.scrollLeft,
        });
  },
  { flush: "sync" },
);

async function stageVisible(onlyChecked: boolean) {
  const paths = onlyChecked
    ? new Set(checked.value)
    : new Set(files.value.map((f) => f.path));
  await execute("stage", {
    files: state.value?.files
      .filter((f) => paths.has(f.path))
      .map((f) => f.path),
  });
}

async function unstageVisible(onlyChecked: boolean) {
  const paths = onlyChecked
    ? new Set(checked.value)
    : new Set(files.value.map((f) => f.path));
  await execute("unstage", {
    files: (state.value?.files || [])
      .filter((f) => paths.has(f.path) && f.staged)
      .flatMap((f) => [f.path, ...(f.oldPath ? [f.oldPath] : [])]),
  });
}

function commit(push: boolean) {
  void execute("commit", { message: message.value, amend: amend.value, push });
}

async function openSubmit(taskId = "") {
  // Let the project watcher reset the previous dialog when navigating from a task.
  const project = projectId.value;
  await nextTick();
  if (disposed || project !== projectId.value || !canSubmit.value) return;
  submitTaskId.value = taskId;
  submitOpen.value = true;
}

const branches = ref<GitBranch[]>([]),
  commits = ref<GitCommit[]>([]),
  stashes = ref<GitStash[]>([]),
  branchQuery = ref(""),
  logQuery = ref(""),
  logFile = ref(""),
  logFollowFile = ref(""),
  appliedLogQuery = ref(""),
  appliedLogFile = ref(""),
  logAll = ref(true),
  logLoading = ref(false),
  logMore = ref(false);
const hasLogFilter = computed(
  () => !!logQuery.value.trim() || !!logFile.value.trim(),
);
const hasAppliedLogFilter = computed(
  () => !!appliedLogQuery.value || !!appliedLogFile.value,
);
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
  logLayoutRef = ref<HTMLElement>(),
  resizingDetail = ref(false),
  detailWidth = ref<number | null>(readSavedDetailWidth());

function readSavedDetailWidth(): number | null {
  try {
    const raw = Number(localStorage.getItem("git-log-detail-width"));
    return Number.isFinite(raw) && raw >= 300 && raw <= 900 ? raw : null;
  } catch {
    return null;
  }
}

function startResizeDetail(event: PointerEvent) {
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  resizingDetail.value = true;
}

function moveResizeDetail(event: PointerEvent) {
  if (!resizingDetail.value || !logLayoutRef.value) return;
  const rect = logLayoutRef.value.getBoundingClientRect();
  const maxWidth = Math.max(360, Math.floor(rect.width - 440));
  const next = Math.max(300, Math.min(maxWidth, Math.round(rect.right - event.clientX)));
  detailWidth.value = next;
}

function stopResizeDetail() {
  if (!resizingDetail.value) return;
  resizingDetail.value = false;
  if (detailWidth.value) {
    try {
      localStorage.setItem("git-log-detail-width", String(detailWidth.value));
    } catch {}
  }
}

function resetDetailWidth() {
  detailWidth.value = null;
  try {
    localStorage.removeItem("git-log-detail-width");
  } catch {}
}
const dialog = ref(""),
  form = ref<Record<string, any>>({}),
  preview = ref<any>(),
  previewLoading = ref(false),
  previewError = ref(""),
  menu = ref<{ x: number; y: number; file?: ChangeFile; commit?: GitCommit }>();
let disposed = false,
  refreshId = 0,
  logId = 0,
  detailId = 0,
  previewId = 0,
  previewTimer: ReturnType<typeof setTimeout> | undefined,
  unsubscribe: (() => void) | undefined,
  refreshTimer: ReturnType<typeof setTimeout> | undefined;

function showUntrackedFile(file: ChangeFile) {
  return !file.untracked || file.inTrackedDirectory !== false;
}

const visibleChanges = computed(() => (state.value?.files || []).filter(showUntrackedFile));
const totalVisibleChanges = computed(() => visibleChanges.value.length);
const sortedChanges = computed(() => [...visibleChanges.value].sort((a, b) =>
  sort.value === "status"
    ? a.status.localeCompare(b.status) || a.path.localeCompare(b.path)
    : a.path.localeCompare(b.path),
));

const files = computed(() => {
  const text = query.value.toLowerCase();
  if (!text && filter.value === "all") return sortedChanges.value;
  return sortedChanges.value.filter(
    (f) =>
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
  );
});

const hiddenUntrackedCount = computed(
  () =>
    state.value?.files.filter(
      (file) => file.untracked && file.inTrackedDirectory === false,
    ).length || 0,
);
const untrackedRuleHint = computed(() => {
  const project = model.config?.projects.find((p) => p.id === projectId.value);
  return describeUntrackedRule(
    project
      ? {
          include: project.gitUntrackedInclude,
          exclude: project.gitUntrackedExclude,
        }
      : undefined,
  );
});
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
const allVisibleChecked = computed(
  () =>
    files.value.length > 0 &&
    files.value.every((f) => checkedSet.value.has(f.path)),
);
const someVisibleChecked = computed(
  () =>
    !allVisibleChecked.value &&
    files.value.some((f) => checkedSet.value.has(f.path)),
);
const checkedFiles = computed(() =>
  (state.value?.files || []).filter((f) => checkedSet.value.has(f.path)),
);
const hasCheckedStageable = computed(() =>
  checkedFiles.value.some((f) => !f.staged || f.unstaged || f.untracked),
);
const hasCheckedStaged = computed(() =>
  checkedFiles.value.some((f) => f.staged),
);
const hasCheckedRollbackable = computed(() =>
  checkedFiles.value.some((f) => f.unstaged && !f.untracked),
);
const hasVisibleStageable = computed(() =>
  files.value.some((f) => !f.staged || f.unstaged || f.untracked),
);
const hasVisibleStaged = computed(() =>
  files.value.some((f) => f.staged),
);
const hasUntrackedFiles = computed(() =>
  (state.value?.files || []).some((f) => f.untracked),
);
const hasChangesFilter = computed(
  () => !!query.value.trim() || filter.value !== "all",
);
const hasMoreFileOps = computed(
  () =>
    (hasSelection.value &&
      (hasCheckedStaged.value || hasCheckedRollbackable.value)) ||
    !!selected.value,
);
const trackedChangeCount = computed(
  () => state.value?.files.filter((f) => !f.untracked).length || 0,
);
const pullBlockedReason = computed(() => {
  if (!state.value) return "";
  if (!state.value.branch || !state.value.upstream)
    return "当前分支尚未配置上游分支，无法 Pull";
  if (trackedChangeCount.value)
    return `当前有 ${trackedChangeCount.value} 个已跟踪修改，Pull 前需先提交或 Stash`;
  return "";
});

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
    if (operation === "push" && dialog.value === "push" && /重新预览/.test(error.value)) {
      void loadPushPreview();
    }
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

function toggleAllFiles(event: Event) {
  checked.value = (event.target as HTMLInputElement).checked
    ? files.value.map((f) => f.path)
    : [];
}

function stage(
  operation: "stage" | "unstage" | "rollback",
  file?: ChangeFile,
) {
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
  moreOpsOpen.value = false;
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

function closeAllDetails() {
  pageRoot.value
    ?.querySelectorAll<HTMLDetailsElement>("details.git-more[open]")
    .forEach((el) => {
      el.open = false;
    });
}

async function ensureBranchesLoaded() {
  if (branches.value.length) return;
  const project = projectId.value;
  try {
    const rows = await call<GitBranch[]>("git.branches", {
      projectId: project,
    });
    if (!disposed && project === projectId.value) branches.value = rows;
  } catch {}
}

async function loadPushPreview() {
  if (dialog.value !== "push") return;
  const remote = String(form.value.remote || "").trim();
  const branch = String(form.value.branch || "").trim();
  if (!remote || !branch) {
    preview.value = undefined;
    previewError.value = "";
    return;
  }
  const id = ++previewId;
  const project = projectId.value;
  previewLoading.value = true;
  previewError.value = "";
  try {
    const result = await call("git.push-preview", {
      remote,
      branch,
      projectId: project,
    });
    if (
      !disposed &&
      id === previewId &&
      dialog.value === "push" &&
      project === projectId.value
    ) {
      preview.value = result;
    }
  } catch (e) {
    if (!disposed && id === previewId && dialog.value === "push") {
      preview.value = undefined;
      previewError.value = e instanceof Error ? e.message : String(e);
    }
  } finally {
    if (id === previewId) previewLoading.value = false;
  }
}

watch(
  () => [dialog.value, form.value.remote, form.value.branch],
  ([kind]) => {
    clearTimeout(previewTimer);
    if (kind !== "push") return;
    preview.value = undefined;
    previewError.value = "";
    previewTimer = setTimeout(() => void loadPushPreview(), 220);
  },
);

watch(amend, async (next) => {
  if (!next || message.value.trim() || !state.value?.head) return;
  const project = projectId.value;
  const head = state.value.head;
  try {
    const info = await call<{ message: string }>("git.commit-details", {
      projectId: project,
      ref: head,
    });
    if (
      !disposed &&
      amend.value &&
      project === projectId.value &&
      !message.value.trim() &&
      info?.message
    ) {
      message.value = info.message.trim();
    }
  } catch {}
});

function clearChangesFilter() {
  query.value = "";
  filter.value = "all";
}

async function copyGitText(text: string, label: string) {
  await attempt(async () => {
    await call("git.copy", { projectId: projectId.value, text });
    notify(`已复制${label}`);
  });
}

async function revealGitFile(filePath: string) {
  await attempt(() =>
    call("git.reveal", { projectId: projectId.value, file: filePath }),
  );
}

function open(kind: string, values: Record<string, any> = {}) {
  dialog.value = kind;
  preview.value = undefined;
  previewError.value = "";
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
  moreOpsOpen.value = false;
  closeAllDetails();
  if (["merge", "rebase", "compare", "create-branch"].includes(kind)) {
    void ensureBranchesLoaded();
  }
  void nextTick(() =>
    document
      .querySelector<HTMLElement>(
        ".git-dialog input, .git-dialog select, .git-dialog textarea",
      )
      ?.focus(),
  );
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
    await loadPushPreview();
    return;
  }
  await execute(dialog.value, {
    ...form.value,
    ...(dialog.value === "push"
      ? { head: preview.value?.head, confirmed: true }
      : {}),
  });
}

async function loadLog(append = false) {
  const id = ++logId,
    project = projectId.value,
    offset = append ? commits.value.length : 0,
    queryText = logQuery.value.trim(),
    fileText = logFile.value.trim(),
    follow = !!logFollowFile.value && fileText === logFollowFile.value;
  logLoading.value = true;
  if (!append) {
    appliedLogQuery.value = queryText;
    appliedLogFile.value = fileText;
  }
  try {
    const rows = await call<GitCommit[]>("git.log", {
      projectId: project,
      offset,
      query: queryText || undefined,
      file: fileText || undefined,
      follow,
      all: logAll.value,
    });
    if (id !== logId || disposed || project !== projectId.value) return;
    commits.value = append ? [...commits.value, ...rows] : rows;
    logMore.value = rows.length === 150;
    if (!append) {
      if (!commits.value.length) {
        chosenCommit.value = undefined;
        details.value = undefined;
      } else if (
        !chosenCommit.value ||
        !commits.value.some((c) => c.hash === chosenCommit.value?.hash)
      ) {
        void selectCommit(commits.value[0]);
      }
    }
  } catch (e) {
    if (id === logId) notify(e instanceof Error ? e.message : String(e), true);
  } finally {
    if (id === logId) logLoading.value = false;
  }
}

function setLogScope(all: boolean) {
  if (logAll.value === all) return;
  logAll.value = all;
  void loadLog();
}

function clearLogFilters() {
  logQuery.value = "";
  logFile.value = "";
  logFollowFile.value = "";
  void loadLog();
}

function onLogQuerySearch() {
  if (!logQuery.value.trim() && appliedLogQuery.value) void loadLog();
}

function onLogFileSearch() {
  if (!logFile.value.trim() && appliedLogFile.value) {
    logFollowFile.value = "";
    void loadLog();
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
  const wasLog = tab.value === "log";
  tab.value = "log";
  logFile.value = file.path;
  logFollowFile.value = file.path;
  logAll.value = false;
  menu.value = undefined;
  if (wasLog) void loadLog();
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

function closeMenu(event?: Event) {
  menu.value = undefined;
  quickBranchOpen.value = false;
  moreOpsOpen.value = false;
  const target = event?.target as HTMLElement | null;
  pageRoot.value
    ?.querySelectorAll<HTMLDetailsElement>("details.git-more[open]")
    .forEach((el) => {
      if (!target || !el.contains(target)) el.open = false;
    });
}

function key(event: KeyboardEvent) {
  if (route.value !== "review" || activeDialog.value) return;
  if (event.key === "F5") {
    event.preventDefault();
    void refresh();
    return;
  }
  if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
    if (
      !dialog.value &&
      !submitOpen.value &&
      !repositoryBusy.value &&
      tab.value === "changes" &&
      (stagedCount.value || amend.value) &&
      message.value.trim()
    ) {
      event.preventDefault();
      void execute("commit", { message: message.value, amend: amend.value });
    }
    return;
  }
  if (event.key === "Escape") {
    if (menu.value) {
      menu.value = undefined;
      return;
    }
    if (moreOpsOpen.value) {
      moreOpsOpen.value = false;
      return;
    }
    if (quickBranchOpen.value) {
      closeQuickBranches();
      return;
    }
    const openDetails = pageRoot.value?.querySelectorAll<HTMLDetailsElement>(
      "details.git-more[open]",
    );
    if (openDetails?.length) {
      openDetails.forEach((el) => {
        el.open = false;
      });
      return;
    }
    if (dialog.value) {
      if (!busy.value) dialog.value = "";
      return;
    }
    if (commitOpen.value) {
      commitOpen.value = false;
      return;
    }
    if (submitOpen.value) {
      void closeSubmit();
    }
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
  logQuery.value = "";
  logFile.value = "";
  logFollowFile.value = "";
  appliedLogQuery.value = "";
  appliedLogFile.value = "";
  logLoading.value = false;
  output.value = "";
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
  unsubscribe = window.workbench.onChanged((_revision, gitChanged) => {
    if (gitChanged === false) return;
    if (!refreshTimer)
      refreshTimer = setTimeout(() => {
        refreshTimer = undefined;
        if (route.value === "review" && !busy.value) {
          void (async () => {
            const prevHead = state.value?.head;
            await readStatus();
            if (tab.value === "log" && commits.value.length && state.value?.head === prevHead)
              return;
            await loadTab();
          })();
        }
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
  clearTimeout(previewTimer);
  window.removeEventListener("keydown", key);
  window.removeEventListener("click", closeMenu);
  window.removeEventListener("focus", onFocus);
  if (leaveGuard === guard) setGuard(null);
});
</script>

<template>
  <div ref="pageRoot" class="git-page">
    <!-- 仓库 / 分支 / 上游同步上下文条 -->
    <div class="repo-bar card">
      <div class="repo-block">
        <div class="service-mark">
          <Icon name="repo" :size="20" />
        </div>
        <div>
          <div class="context-label">仓库</div>
          <ProjectSelect
            v-model="projectId"
            class="repo-select"
            :optional="false"
            label="Git 项目"
            :disabled="busy"
          />
        </div>
      </div>

      <div class="vdiv" aria-hidden="true" />

      <div class="git-quick-branch" @click.stop>
        <div class="context-label">分支</div>
        <button
          ref="quickBranchButton"
          type="button"
          class="git-branch-button"
          title="切换分支"
          aria-label="切换分支"
          aria-haspopup="listbox"
          :aria-expanded="quickBranchOpen"
          aria-controls="quick-branch-options"
          :disabled="repositoryBusy || submitOpen"
          @click="toggleQuickBranches"
        >
          <Icon name="branch2" :size="15" />
          <span class="git-current-branch" :title="state?.branch">{{
            state?.branch || (state?.detached ? "游离 HEAD" : "—")
          }}</span>
          <Icon name="down" :size="13" />
        </button>

        <Transition name="pop">
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
                type="button"
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
                <Icon :name="branch.current ? 'check' : 'branch2'" :size="14" />
                <span>
                  {{ branch.name }}
                  <small v-if="branch.upstream">{{ branch.upstream }}</small>
                </span>
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
        </Transition>
      </div>

      <div class="vdiv" aria-hidden="true" />

      <div class="git-upstream-block" :title="state?.upstream || '未配置上游分支'">
        <div class="context-label">
          {{ state?.upstream || "未配置上游" }}
        </div>
        <div class="sync-count">
          <span
            class="sync-metric"
            :title="`领先上游 ${state?.ahead || 0} 个提交（待推送）`"
          >
            <Icon name="arrow-up" :size="13" />
            <span>{{ state?.ahead || 0 }}</span>
          </span>
          <span
            class="sync-metric"
            :title="`落后上游 ${state?.behind || 0} 个提交（待拉取）`"
          >
            <Icon name="arrow-down" :size="13" style="margin-left: 6px" />
            <span>{{ state?.behind || 0 }}</span>
          </span>
        </div>
      </div>

      <div class="repo-actions">
        <button
          type="button"
          class="btn blank compact"
          :disabled="repositoryBusy"
          @click="open('stash-push')"
        >
          <Icon name="stash" :size="14" />新建 Stash
        </button>
        <details class="git-more">
          <summary><Icon name="more" :size="15" />更多</summary>
          <div class="git-dropdown">
            <button type="button" @click="open('compare')">
              比较分支 / 提交
            </button>
            <button type="button" @click="open('create-branch')">
              从提交创建分支
            </button>
            <button type="button" @click="open('merge')">
              Merge 到当前分支
            </button>
            <button type="button" @click="open('rebase')">
              Rebase 当前分支到…
            </button>
          </div>
        </details>
        <button
          type="button"
          class="icon-btn"
          title="刷新仓库（F5）"
          aria-label="刷新仓库"
          :disabled="busy"
          @click="refresh"
        >
          <Icon name="refresh" :size="15" />
        </button>
      </div>
    </div>

    <!-- 冲突/操作中提示条 -->
    <div
      v-if="state?.operation || conflicts"
      class="git-operation-bar"
      role="status"
    >
      <Icon name="warning" :size="16" />
      <strong>{{
        state?.operation ? gitOperationLabel(state.operation) : "冲突待处理"
      }}</strong>
      <span>{{ conflicts }} 个冲突文件</span>
      <button
        type="button"
        class="btn compact"
        @click="
          tab = 'changes';
          filter = 'conflicts';
        "
      >
        查看冲突
      </button>
      <button
        v-if="state?.operation"
        type="button"
        class="btn primary compact"
        :disabled="repositoryBusy || !!conflicts"
        @click="execute('continue')"
      >
        Continue
      </button>
      <button
        v-if="['rebase', 'cherry-pick'].includes(state?.operation || '')"
        type="button"
        class="btn compact"
        :disabled="repositoryBusy"
        @click="execute('skip')"
      >
        Skip
      </button>
      <button
        v-if="state?.operation"
        type="button"
        class="btn stop compact"
        :disabled="repositoryBusy"
        @click="execute('abort')"
      >
        Abort
      </button>
    </div>

    <div class="repo-tabs">
      <div class="git-tabs" role="tablist" aria-label="Git 功能">
        <button
          v-for="item in [
            ['changes', '本地变更', 'changes'],
            ['log', 'Git Log', 'history'],
            ['branches', '分支', 'branch2'],
            ['stash', 'Stash', 'stash'],
          ]"
          :key="item[0]"
          type="button"
          class="tab"
          role="tab"
          :aria-selected="tab === item[0]"
          :class="{ active: tab === item[0], current: tab === item[0] }"
          @click="tab = item[0]"
        >
          <Icon :name="item[2]" :size="14" />
          <span>{{ item[1] }}</span>
          <span v-if="item[0] === 'changes'" class="count" aria-hidden="true">{{ totalVisibleChanges }}</span>
        </button>
      </div>
      <div class="git-sync-actions">
        <span v-if="busy" class="git-sync-status" role="status">Git 操作执行中…</span>
        <span class="button-group" role="group" aria-label="远程同步">
          <button type="button" :disabled="repositoryBusy" @click="execute('fetch')">
            <Icon name="refresh" :size="14" />Fetch
          </button>
          <button
            type="button"
            :disabled="repositoryBusy || !state?.branch || !state?.upstream"
            :title="
              !state?.branch || !state?.upstream
                ? '当前分支尚未配置上游分支，请先 Push 或关联上游'
                : '拉取上游分支变更'
            "
            @click="open('pull')"
          >
            <Icon name="pull" :size="14" />Pull
          </button>
          <button type="button" :disabled="repositoryBusy" @click="open('push')">
            <Icon name="push" :size="14" />Push
          </button>
        </span>
        <button
          v-if="canSubmit"
          type="button"
          class="btn primary compact"
          :disabled="busy || (repositoryBusy && !activeSubmitTask)"
          title="提交已暂存内容与已跟踪修改"
          @click="openSubmit()"
        >
          <Icon name="merge" :size="14" />一键提测
        </button>
      </div>
    </div>

    <!-- 错误提示条 -->
    <div v-if="error || statusError" class="git-error" role="alert">
      <span>{{ error || statusError }}</span>
      <CloseButton
        label="关闭错误"
        @click="
          error = '';
          statusError = '';
        "
      />
    </div>

    <!-- 本地变更双栏 -->
    <div v-if="tab === 'changes'" class="duo git-layout">
      <section class="card pane">
        <div class="panel-head">
          <div class="head-title">
            <Icon name="changes" :size="17" />
            <h2>变更文件</h2>
            <span
              v-if="files.length !== totalVisibleChanges"
              class="count"
              title="筛选命中文件数"
              >{{ files.length }}</span
            >
          </div>
          <button
            v-if="checked.length && hasCheckedStageable"
            type="button"
            class="btn light-brand compact"
            :disabled="repositoryBusy"
            @click="stage('stage')"
          >
            <Icon name="plus" :size="13" />
            暂存所选 · {{ checked.length }}
          </button>
          <button
            v-else-if="checked.length && hasCheckedStaged"
            type="button"
            class="btn compact"
            :disabled="repositoryBusy"
            @click="stage('unstage')"
          >
            <Icon name="minus" :size="13" />
            取消暂存所选 · {{ checked.length }}
          </button>
          <button
            v-else-if="hasVisibleStageable || !hasVisibleStaged"
            type="button"
            class="btn light-brand compact"
            :disabled="repositoryBusy || !files.length"
            title="暂存当前列表中的全部变更文件"
            @click="stageVisible(false)"
          >
            <Icon name="plus" :size="13" />
            全部暂存
          </button>
          <button
            v-else
            type="button"
            class="btn compact"
            :disabled="repositoryBusy"
            title="取消暂存当前列表中的全部文件"
            @click="unstageVisible(false)"
          >
            <Icon name="minus" :size="13" />
            全部取消暂存
          </button>
        </div>

        <div class="file-filters">
          <label class="search-box" style="margin: 0">
            <Icon name="search" :size="14" />
            <input
              v-model="query"
              type="search"
              placeholder="搜索文件路径"
              aria-label="搜索变更文件"
            />
          </label>
          <select v-model="filter" class="compact" aria-label="变更范围">
            <option value="all">全部变更</option>
            <option value="staged">已暂存</option>
            <option value="unstaged">未暂存</option>
            <option value="untracked">未跟踪</option>
            <option value="conflicts">冲突</option>
          </select>
          <select v-model="sort" class="compact" aria-label="文件排序">
            <option value="path">按路径</option>
            <option value="status">按状态</option>
          </select>
        </div>

        <div class="git-table-head">
          <input
            type="checkbox"
            :checked="allVisibleChecked"
            :indeterminate="someVisibleChecked"
            :disabled="!files.length"
            aria-label="选择当前列表全部文件"
            @change="toggleAllFiles"
          />
          <span>文件路径</span>
          <span>状态</span>
          <span />
        </div>

        <VirtualFiles
          variant="rich"
          :files="files"
          :selected="selected"
          :checked="checked"
          :busy="repositoryBusy"
          :filtered="hasChangesFilter"
          multiple
          @select="selected = $event.path"
          @toggle="toggle"
          @show="showDiff($event)"
          @menu="fileMenu"
          @stage="stage('stage', $event)"
          @unstage="stage('unstage', $event)"
          @clear-filter="clearChangesFilter"
        />

        <div
          v-if="hasMoreFileOps"
          class="selection-row"
          @click.stop
        >
          <div class="git-ops-wrap">
            <button
              type="button"
              class="text-action"
              @click="moreOpsOpen = !moreOpsOpen"
            >
              <Icon name="down" :size="12" />更多文件操作
            </button>
            <Transition name="pop-up">
              <div v-if="moreOpsOpen" class="git-dropdown ops-up" role="menu">
                <button
                  v-if="hasCheckedStaged"
                  type="button"
                  role="menuitem"
                  :disabled="repositoryBusy"
                  @click="stage('unstage')"
                >
                  取消暂存所选（Unstage）
                </button>
                <button
                  v-if="hasCheckedRollbackable"
                  type="button"
                  role="menuitem"
                  :disabled="repositoryBusy"
                  @click="stage('rollback')"
                >
                  回滚所选未暂存修改…
                </button>
                <button
                  v-if="selected"
                  type="button"
                  role="menuitem"
                  @click="
                    showDiff(state!.files.find((f) => f.path === selected)!);
                    moreOpsOpen = false;
                  "
                >
                  打开当前文件差异对比 ↗
                </button>
              </div>
            </Transition>
          </div>
        </div>

        <div
          v-if="hiddenUntrackedCount"
          class="git-info"
          :title="untrackedRuleHint"
        >
          <Icon name="eye-off" :size="14" />
          <span
            >已按项目规则隐藏
            {{ hiddenUntrackedCount.toLocaleString() }} 个未跟踪文件</span
          >
          <span class="push" />
          <button
            type="button"
            class="text-action"
            @click="
              navigate('settings', {
                tab: 'projects',
                projectId,
              })
            "
          >
            规则设置
          </button>
        </div>
      </section>

      <section class="card pane">
        <div class="panel-head spaced-head">
          <div class="head-title">
            <Icon name="git-commit" :size="17" />
            <h2>提交变更</h2>
          </div>
        </div>
        <GitCommitPanel
          v-model:message="message"
          v-model:amend="amend"
          :staged-count="stagedCount"
          :busy="repositoryBusy"
          :upstream="state?.upstream"
          :visible-count="files.length"
          :checked-count="checked.length"
          @stage="stageVisible"
          @inspect="filter = 'staged'"
          @commit="commit"
        />
      </section>
    </div>

    <!-- Git Log -->
    <div
      v-else-if="tab === 'log'"
      ref="logLayoutRef"
      class="git-log-layout card"
      :class="{ resizing: resizingDetail }"
    >
      <div class="git-log-main">
        <form class="git-filterbar git-log-filterbar" @submit.prevent="loadLog()">
          <div
            class="segmented git-log-scope"
            role="group"
            aria-label="提交分支范围"
          >
            <button
              type="button"
              :class="{ active: !logAll }"
              :aria-pressed="!logAll"
              :title="`仅显示当前分支${state?.branch ? '（' + state.branch + '）' : ''}的提交`"
              @click="setLogScope(false)"
            >
              当前分支
            </button>
            <button
              type="button"
              :class="{ active: logAll }"
              :aria-pressed="logAll"
              title="显示所有本地与远程分支的提交"
              @click="setLogScope(true)"
            >
              全部分支
            </button>
          </div>
          <label
            class="search-box git-log-input"
            title="按提交说明关键词搜索提交"
          >
            <Icon name="search" :size="14" />
            <input
              v-model="logQuery"
              type="search"
              aria-label="搜索提交说明"
              placeholder="搜索提交说明"
              @search="onLogQuerySearch"
            />
          </label>
          <label
            class="search-box git-log-file-input"
            title="按改动过的文件名或路径筛选提交（支持模糊搜索，不区分大小写）"
          >
            <Icon name="file" :size="14" />
            <input
              v-model="logFile"
              type="search"
              aria-label="按改动文件名或路径筛选"
              placeholder="按改动文件名/路径筛选"
              @input="logFollowFile = ''"
              @search="onLogFileSearch"
            />
          </label>
          <button
            type="submit"
            class="btn primary compact"
            :disabled="logLoading"
          >
            搜索
          </button>
          <button
            v-if="hasLogFilter"
            type="button"
            class="btn compact"
            :disabled="logLoading"
            @click="clearLogFilters"
          >
            清空
          </button>
        </form>
        <div class="git-log-scroll">
          <CommitGraph
            :commits="commits"
            :selected="chosenCommit?.hash || ''"
            @select="selectCommit"
            @menu="commitMenu"
          />
          <button
            v-if="logMore"
            type="button"
            class="btn compact git-load-more"
            :disabled="logLoading"
            @click="loadLog(true)"
          >
            加载更多历史
          </button>
          <p v-if="logLoading && !commits.length" class="git-empty">
            正在加载提交历史…
          </p>
          <div v-else-if="!commits.length" class="git-empty">
            <p>
              {{
                !logAll && hasAppliedLogFilter
                  ? "当前分支没有匹配的提交"
                  : "没有匹配的提交"
              }}
            </p>
            <div class="row" style="gap: 10px; justify-content: center">
              <button
                v-if="!logAll && hasAppliedLogFilter"
                type="button"
                class="link"
                @click="setLogScope(true)"
              >
                在全部分支中搜索
              </button>
              <button
                v-if="hasAppliedLogFilter"
                type="button"
                class="link"
                @click="clearLogFilters"
              >
                清除筛选
              </button>
            </div>
          </div>
        </div>
      </div>
      <div
        class="git-log-splitter"
        role="separator"
        aria-label="调整提交详情宽度"
        aria-orientation="vertical"
        title="拖动调整详情栏宽度，双击恢复默认"
        @pointerdown="startResizeDetail"
        @pointermove="moveResizeDetail"
        @pointerup="stopResizeDetail"
        @pointercancel="stopResizeDetail"
        @dblclick="resetDetailWidth"
      />
      <aside
        class="git-log-detail"
        :style="detailWidth ? { width: detailWidth + 'px' } : undefined"
      >
        <template v-if="details">
          <div class="git-log-detail-head">
            <div class="row spaced" style="gap: 8px; align-items: center">
              <code :title="details.commit">{{ details.commit }}</code>
              <button
                type="button"
                class="icon-btn small blank"
                title="复制提交号"
                aria-label="复制提交号"
                @click="copyGitText(details.commit, '提交号')"
              >
                <Icon name="copy" :size="12" />
              </button>
            </div>
            <p v-if="chosenCommit" class="git-help">
              {{ chosenCommit.author }} · {{ formatDateTime(chosenCommit.date) }}
            </p>
            <pre>{{ details.message }}</pre>
            <p class="git-help">{{ details.files.length }} 个文件</p>
          </div>
          <VirtualFiles
            variant="detail"
            :files="detailFiles"
            :selected="selected"
            @select="selected = $event.path"
            @show="historicalDiff($event)"
          />
        </template>
        <p v-else class="git-empty">选择提交查看详情与文件</p>
      </aside>
    </div>

    <!-- 分支 -->
    <div v-else-if="tab === 'branches'" class="git-branches card">
      <div class="git-filterbar">
        <label class="search-box" style="margin: 0; flex: 1; max-width: 340px">
          <Icon name="search" :size="14" />
          <input
            v-model="branchQuery"
            type="search"
            aria-label="搜索分支"
            placeholder="搜索本地 / 远程分支"
          />
        </label>
        <button
          type="button"
          class="btn primary compact"
          :disabled="repositoryBusy"
          @click="open('create-branch')"
        >
          <Icon name="plus" :size="13" />新建分支
        </button>
        <button type="button" class="btn compact" @click="open('compare')">
          比较分支
        </button>
      </div>
      <div class="git-branch-list">
        <div
          v-for="branch in filteredBranches"
          :key="branch.name"
          class="git-branch-row"
          :aria-current="branch.current ? 'true' : undefined"
        >
          <Icon :name="branch.current ? 'check' : 'branch2'" :size="16" />
          <div class="git-branch-name">
            <strong>
              {{ branch.name }}
              <span v-if="!branch.current" class="badge neutral">{{
                branch.remote ? "远程" : "本地"
              }}</span>
            </strong>
            <small>
              {{ branch.subject }}
              <span v-if="branch.upstream">· {{ branch.upstream }}</span>
            </small>
          </div>
          <div class="git-branch-actions">
            <button
              v-if="!branch.current"
              type="button"
              class="btn compact"
              :disabled="repositoryBusy"
              @click="execute('checkout', { branch: branch.name })"
            >
              Checkout
            </button>
            <button
              v-if="!branch.current"
              type="button"
              class="btn compact"
              :disabled="repositoryBusy"
              @click="open('merge', { ref: branch.name })"
            >
              Merge
            </button>
            <button
              v-if="!branch.current"
              type="button"
              class="btn compact"
              :disabled="repositoryBusy"
              @click="open('rebase', { ref: branch.name })"
            >
              Rebase
            </button>
            <details v-if="!branch.current || !branch.remote" class="git-more">
              <summary><Icon name="more" :size="14" /></summary>
              <div class="git-dropdown">
                <button
                  v-if="!branch.current"
                  type="button"
                  @click="
                    open('compare', { base: 'HEAD', target: branch.name })
                  "
                >
                  与 HEAD 比较
                </button>
                <button
                  v-if="!branch.remote"
                  type="button"
                  @click="
                    open('rename-branch', {
                      branch: branch.name,
                      name: branch.name,
                    })
                  "
                >
                  重命名
                </button>
                <button
                  v-if="!branch.remote && !branch.current"
                  type="button"
                  :disabled="repositoryBusy"
                  @click="
                    closeAllDetails();
                    execute('delete-branch', { branch: branch.name });
                  "
                >
                  删除已合并分支
                </button>
              </div>
            </details>
          </div>
        </div>
        <div v-if="!filteredBranches.length" class="git-empty">
          <p>没有匹配的分支</p>
          <button
            v-if="branchQuery"
            type="button"
            class="link"
            @click="branchQuery = ''"
          >
            清除搜索
          </button>
        </div>
      </div>
    </div>

    <!-- Stash -->
    <div v-else class="git-stash-panel card">
      <div class="git-filterbar">
        <button
          type="button"
          class="btn primary compact"
          :disabled="repositoryBusy"
          @click="open('stash-push')"
        >
          <Icon name="stash" :size="14" />新建 Stash
        </button>
      </div>
      <div class="git-stash-list">
        <article
          v-for="stash in stashes"
          :key="stash.hash"
          class="git-stash-row"
        >
          <div>
            <strong>{{ stash.ref }}</strong>
            <span>{{ stash.subject }}</span>
            <small>
              {{ formatDateTime(stash.date) }} ·
              {{ stash.hash.slice(0, 8) }}
            </small>
          </div>
          <div class="git-stash-actions">
            <button type="button" class="btn compact" @click="stashDiff(stash)">
              Diff
            </button>
            <button
              v-if="stash.hasUntracked"
              type="button"
              class="btn compact"
              title="查看包含的未跟踪文件"
              @click="stashDiff(stash, true)"
            >
              未跟踪文件
            </button>
            <button
              type="button"
              class="btn compact"
              :disabled="repositoryBusy"
              title="应用并保留记录"
              @click="execute('stash-apply', stash)"
            >
              Stash Apply
            </button>
            <button
              type="button"
              class="btn light-brand compact"
              :disabled="repositoryBusy"
              title="成功应用后移除记录"
              @click="execute('stash-pop', stash)"
            >
              Stash Pop
            </button>
            <button
              type="button"
              class="btn stop compact stash-drop-btn"
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

    <details v-if="output" class="git-output card">
      <summary>
        <span>最近操作结果 / Git 钩子输出</span>
        <button
          type="button"
          class="text-action git-output-clear"
          @click.prevent.stop="output = ''"
        >
          清除
        </button>
      </summary>
      <pre>{{ output }}</pre>
    </details>

    <!-- 右键菜单 -->
    <Transition name="pop">
      <div
        v-if="menu"
        class="git-context-menu"
        :style="{ left: menu.x + 'px', top: menu.y + 'px' }"
        role="menu"
        @click.stop
      >
      <template v-if="menu.file">
        <button
          type="button"
          role="menuitem"
          @click="
            showDiff(menu.file);
            closeMenu();
          "
        >
          打开对比 ↗
        </button>
        <button
          v-if="!menu.file.staged || menu.file.unstaged || menu.file.untracked"
          type="button"
          role="menuitem"
          :disabled="repositoryBusy"
          @click="stage('stage', menu.file)"
        >
          Stage
        </button>
        <button
          v-if="menu.file.staged"
          type="button"
          role="menuitem"
          :disabled="repositoryBusy"
          @click="stage('unstage', menu.file)"
        >
          Unstage
        </button>
        <button
          v-if="menu.file.unstaged && !menu.file.untracked"
          type="button"
          role="menuitem"
          :disabled="repositoryBusy"
          @click="stage('rollback', menu.file)"
        >
          回滚未暂存修改…
        </button>
        <button
          v-if="!menu.file.untracked"
          type="button"
          role="menuitem"
          @click="history(menu.file)"
        >
          查看文件历史
        </button>
        <button
          v-if="!menu.file.untracked"
          type="button"
          role="menuitem"
          @click="
            open('compare', {
              file: menu.file.path,
              base: 'HEAD',
              working: true,
            })
          "
        >
          与历史版本比较…
        </button>
        <button
          type="button"
          role="menuitem"
          @click="
            copyGitText(menu.file.path, '相对路径');
            closeMenu();
          "
        >
          复制相对路径
        </button>
        <button
          type="button"
          role="menuitem"
          @click="
            revealGitFile(menu.file.path);
            closeMenu();
          "
        >
          在文件资源管理器中打开
        </button>
      </template>

      <template v-if="menu.commit">
        <button
          type="button"
          role="menuitem"
          @click="
            copyGitText(menu.commit.hash, '提交号');
            closeMenu();
          "
        >
          复制提交号
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="repositoryBusy"
          @click="
            execute('revert', { ref: menu.commit.hash });
            closeMenu();
          "
        >
          Revert 此提交…
        </button>
        <button
          type="button"
          role="menuitem"
          :disabled="repositoryBusy"
          @click="
            execute('cherry-pick', { ref: menu.commit.hash });
            closeMenu();
          "
        >
          Cherry-pick…
        </button>
        <button
          type="button"
          role="menuitem"
          @click="open('compare', { base: menu.commit.hash, target: 'HEAD' })"
        >
          与 HEAD 比较
        </button>
        <button
          type="button"
          role="menuitem"
          @click="open('create-branch', { ref: menu.commit.hash })"
        >
          从此提交创建分支
        </button>
        <button
          v-if="menu.commit.hash === state?.head"
          type="button"
          role="menuitem"
          :disabled="repositoryBusy"
          @click="
            execute('undo-last', { head: menu.commit.hash });
            closeMenu();
          "
        >
          撤销最后一次提交…
        </button>
      </template>
      </div>
    </Transition>

    <!-- 一键提测弹窗 -->
    <Transition name="modal">
      <div
        v-if="submitOpen"
        class="git-dialog-overlay"
        @click.self="closeSubmit"
      >
        <section
          class="git-dialog git-submit-dialog"
          role="dialog"
          aria-modal="true"
          aria-label="一键提测"
        >
          <div class="section-head">
            <h2>
              一键提测 ·
              {{ model.config?.projects.find((p) => p.id === projectId)?.name }}
            </h2>
            <CloseButton label="关闭提测窗口" @click="closeSubmit" />
          </div>
          <div class="git-submit-content">
            <SubmitPage
              ref="submitPage"
              :key="projectId"
              :project-id="projectId"
              :task-id="submitTaskId"
            />
          </div>
        </section>
      </div>
    </Transition>

    <!-- Git 操作弹窗 -->
    <Transition name="modal">
      <div
        v-if="dialog"
        class="git-dialog-overlay"
        @click.self="!busy && (dialog = '')"
      >
      <form class="git-dialog" @submit.prevent="submitDialog">
        <div class="dialog-head">
          <h2>
            {{
              {
                push: "Push",
                pull: "Pull",
                "stash-push": "新建 Stash",
                "create-branch": "新建分支",
                "rename-branch": "重命名分支",
                merge: "Merge 到当前分支",
                rebase: "Rebase 当前分支到…",
                compare: "比较版本",
              }[dialog] || dialog
            }}
          </h2>
          <CloseButton label="关闭" :disabled="busy" @click="dialog = ''" />
        </div>
        <p class="git-help">
          {{ model.config?.projects.find((p) => p.id === projectId)?.name }} ·
          {{ state?.branch }}
        </p>

        <template v-if="dialog === 'push'">
          <label>
            远程仓库
            <select v-model="form.remote" :disabled="busy">
              <option v-for="remote in state?.remotes" :key="remote">
                {{ remote }}
              </option>
            </select>
          </label>
          <label>
            目标分支
            <input v-model="form.branch" :disabled="busy" required />
          </label>
          <p v-if="previewLoading" class="git-help" role="status">
            正在读取待推送提交…
          </p>
          <p v-else-if="previewError" class="error small" role="alert">
            {{ previewError }}
          </p>
          <template v-else-if="preview">
            <p class="small">
              {{ preview.branch }} → {{ preview.remote }}/{{ preview.target }}
              <span v-if="preview.newBranch" class="muted">· 将创建远程分支</span>
            </p>
            <pre class="git-push-preview">{{
              preview.commits || "无新增提交"
            }}</pre>
          </template>
        </template>

        <template v-else-if="dialog === 'pull'">
          <p class="small">上游分支 · {{ state?.upstream || "未配置" }}</p>
          <div v-if="pullBlockedReason" class="notice warning small">
            <p>{{ pullBlockedReason }}</p>
            <button
              v-if="state?.branch && state?.upstream && trackedChangeCount"
              type="button"
              class="btn compact"
              style="margin-top: 8px"
              @click="open('stash-push')"
            >
              先新建 Stash
            </button>
          </div>
          <label v-else>
            Pull 策略
            <select v-model="form.strategy">
              <option value="merge">Merge · 合并远程变更</option>
              <option value="rebase">Rebase · 重放本地提交</option>
            </select>
          </label>
        </template>

        <template v-else-if="dialog === 'stash-push'">
          <label>
            说明
            <input v-model="form.message" placeholder="临时保存说明" />
          </label>
          <label v-if="hasUntrackedFiles" class="git-checkbox">
            <input v-model="form.untracked" type="checkbox" />包含未跟踪文件
          </label>
        </template>

        <template v-else-if="dialog === 'compare'">
          <label>
            原始版本
            <input v-model="form.base" required list="git-refs" placeholder="分支或提交号" />
          </label>
          <label v-if="!form.working">
            目标版本
            <input v-model="form.target" required list="git-refs" placeholder="分支或提交号" />
          </label>
          <label class="git-checkbox">
            <input v-model="form.working" type="checkbox" />目标为当前工作区
          </label>
          <label>
            仅此文件（可选）
            <input v-model="form.file" placeholder="仓库相对路径" />
          </label>
        </template>

        <template v-else-if="['merge', 'rebase'].includes(dialog)">
          <label>
            源分支 / 提交号
            <input v-model="form.ref" required list="git-refs" />
          </label>
          <label v-if="dialog === 'merge'" class="git-checkbox">
            <input v-model="form.noFF" type="checkbox" />创建合并提交（--no-ff）
          </label>
          <p v-if="dialog === 'rebase'" class="git-help">
            Rebase 会重写提交历史。已推送的分支请先与协作者确认。
          </p>
        </template>

        <template v-else>
          <label>
            分支名称
            <input v-model="form.name" required />
          </label>
          <label v-if="dialog === 'create-branch'">
            起点提交号 / 分支
            <input v-model="form.ref" required list="git-refs" />
          </label>
        </template>

        <datalist id="git-refs">
          <option
            v-for="branch in branches"
            :key="branch.name"
            :value="branch.name"
          />
        </datalist>

        <footer>
          <button type="button" class="btn" :disabled="busy" @click="dialog = ''">
            取消
          </button>
          <button
            type="submit"
            class="btn primary"
            :disabled="
              repositoryBusy ||
              (dialog === 'push' && previewLoading) ||
              (dialog === 'pull' && !!pullBlockedReason)
            "
          >
            {{
              dialog === "push"
                ? previewLoading
                  ? "预览中…"
                  : preview
                    ? "确认推送"
                    : "重新预览"
                : "继续"
            }}
          </button>
        </footer>
      </form>
      </div>
    </Transition>
  </div>
</template>

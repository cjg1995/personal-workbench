export type RecordKind = "idea" | "work";
export interface Note {
  id: string;
  kind: RecordKind;
  text: string;
  projectId: string | null;
  happenedOn: string | null;
  result: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  deletedAt: string | null;
  sourceId: string | null;
  importBatch: string | null;
  sourceLine: number | null;
  originalText: string | null;
}
export type TaskState =
  | "running"
  | "awaiting"
  | "cancelling"
  | "success"
  | "partial"
  | "failed"
  | "cancelled"
  | "interrupted";
export type StageState = "pending" | "running" | "done" | "failed" | "skipped";
export interface Stage {
  name: string;
  state: StageState;
  startedAt?: string;
  endedAt?: string;
  detail?: string;
}
export interface Task {
  id: string;
  type: string;
  title: string;
  projectId: string | null;
  state: TaskState;
  startedAt: string;
  endedAt: string | null;
  stages: Stage[];
  logPath: string;
  error: string | null;
  params: Record<string, unknown>;
  result: Record<string, unknown>;
  lockKey: string | null;
}
export type ProjectType =
  | "tomcat"
  | "h5"
  | "spring"
  | "vue"
  | "wechat"
  | "uni-wechat";
export interface ProjectConfig {
  id: string;
  logicalId: string;
  group: string;
  name: string;
  path: string;
  type: ProjectType;
  android?: string;
  appId?: string;
  packageName?: string;
  java?: string;
  catalinaHome?: string;
  catalinaBase?: string;
  deployment?: string;
  vmArgs?: string;
  expectedPort?: number;
  context?: string;
  springProfile?: string;
}
export interface ToolsConfig {
  git: string;
  hbNode: string;
  hbCli: string;
  buildJava: string;
  wechat: string;
  idea: string;
  maven: string;
  tapd: string;
  tapdCwd: string;
  documents: string;
  exportDir: string;
  backupDir: string;
  template: string;
}
export interface Configuration {
  projects: ProjectConfig[];
  tools: ToolsConfig;
  name: string;
}
export type RunState =
  | "unconfigured"
  | "stopped"
  | "starting"
  | "running"
  | "external"
  | "stopping"
  | "failed"
  | "unknown"
  | "tool-open"
  | "watching";
export interface RunInfo {
  projectId: string;
  state: RunState;
  branch: string;
  pid?: number;
  created?: string;
  executable?: string;
  marker?: string;
  url?: string;
  message?: string;
  logPath?: string;
  toolOpened?: boolean;
  canStop?: boolean;
  configurationFingerprint?: string;
}
export interface GitFile {
  path: string;
  oldPath?: string;
  status: string;
  staged: boolean;
  tracked: boolean;
  included: boolean;
  reason?: string;
}
export interface SubmitCheck {
  /** Git 管理提测纳入已暂存内容和已跟踪修改，不自动创建工作树。 */
  fromGit?: boolean;
  repo: string;
  branch: string;
  head: string;
  upstream: string;
  target: string;
  testPath?: string;
  files: GitFile[];
  ahead: number;
  defaultMessage: string;
  fingerprint: string;
  checks: { label: string; ok: boolean; detail: string }[];
  valid: boolean;
  gitDir: string;
  commonDir: string;
}
export type DiffScope =
  | "unstaged"
  | "staged"
  | "local"
  | "versions"
  | "ancestor";
export interface ReviewFile {
  path: string;
  oldPath?: string;
  status: string;
  binary: boolean;
  limited: boolean;
  patch: string;
  oldText: string;
  newText: string;
  hash: string;
  untracked: boolean;
  deferred?: boolean;
  contentHash?: string;
}
export interface ReviewSnapshot {
  id: string;
  projectId: string;
  repo: string;
  scope: DiffScope;
  base: string;
  target: string;
  baseCommit: string;
  targetCommit: string;
  createdAt: string;
  fingerprint: string;
  files: ReviewFile[];
  seen: Record<string, string>;
  issues: ReviewIssue[];
  conclusion: string | null;
  summary: string;
  stale: boolean;
  fetchedAt: string | null;
  lazyUntracked?: boolean;
}
export interface ReviewIssue {
  id: string;
  file: string;
  side: "old" | "new";
  line: number | null;
  text: string;
  state: "open" | "fixed" | "resolved" | "declined";
  reason: string;
  snapshotHash: string;
  todoId?: string;
}
export interface MonthlyEntry {
  id: string;
  section: string;
  text: string;
  sourceIds: string[];
  sourceVersions: Record<string, string>;
  manual: boolean;
}
export interface MonthlyImage {
  id: string;
  name: string;
  mime: string;
  width: number;
  height: number;
  data: string;
}
export interface MonthlyDraft {
  month: string;
  name: string;
  entries: MonthlyEntry[];
  images?: MonthlyImage[];
  updatedAt: string;
}
export interface BuildConfig {
  projectId: string;
  name: string;
  source: string;
  android: string;
  appId: string;
  packageName: string;
  versionName: string;
  versionCode: string;
  www: string;
  sdk: string;
  java: string;
  aapt: string;
  signerJar: string;
  wrapperJar: string;
  cli: string;
  node: string;
}
export const sections = [
  "主要工作",
  "其他",
  "个人学习和成长",
  "个人工作计划、学习目标",
  "部门工作中存在问题及改进建议",
];
export interface ApiResponse<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}
export interface WorkbenchApi {
  call<T = unknown>(action: string, payload?: unknown): Promise<ApiResponse<T>>;
  onChanged(callback: () => void): () => void;
  onReviewProgress(callback: (message: string) => void): () => void;
  onNavigate(callback: (destination: { taskId: string }) => void): () => void;
  onGitDiff(callback: (request: import("./git-client.js").DiffWindowRequest) => void): () => void;
}

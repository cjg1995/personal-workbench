export type GitCompareMode =
  | "local"
  | "staged"
  | "unstaged"
  | "versions"
  | "history";
export interface GitComparison {
  mode: GitCompareMode;
  base?: string;
  target?: string;
  file?: string;
}
export interface ChangeFile {
  path: string;
  oldPath?: string;
  status: string;
  x: string;
  y: string;
  staged: boolean;
  unstaged: boolean;
  conflicted: boolean;
  untracked: boolean;
  /** Whether an untracked file passes the project's scope or tracked-directory filter. */
  inTrackedDirectory?: boolean;
}
export interface RepositoryState {
  branch: string;
  head: string;
  upstream: string;
  ahead: number;
  behind: number;
  operation: "merge" | "rebase" | "cherry-pick" | "revert" | "sequencer" | "";
  detached: boolean;
  files: ChangeFile[];
  remotes: string[];
  locked: boolean;
}
export interface DiffHunk {
  index: number;
  header: string;
  oldStart: number;
  newStart: number;
}
export interface FileComparison {
  path: string;
  oldText: string;
  newText: string;
  oldLabel: string;
  newLabel: string;
  token: string;
  hunks: DiffHunk[];
  revertHunks: (DiffHunk & { oldCount: number; newCount: number })[];
  canPatch: boolean;
  editable: boolean;
  notice: string;
  binary: boolean;
  limited: boolean;
  encoding: string;
}
export interface GitBranch {
  name: string;
  current: boolean;
  remote: boolean;
  upstream: string;
  subject: string;
  hash: string;
}
export interface GitCommit {
  hash: string;
  parents: string[];
  author: string;
  date: string;
  subject: string;
  refs: string;
}
export interface GitStash {
  ref: string;
  hash: string;
  subject: string;
  date: string;
}
export interface ConflictContent {
  path: string;
  base: string;
  ours: string;
  theirs: string;
  result: string;
  token: string;
  oursLabel: string;
  theirsLabel: string;
  notice: string;
  editable: boolean;
  oursChanges: { start: number; end: number }[];
  theirsChanges: { start: number; end: number }[];
  oursDeleted: boolean;
  theirsDeleted: boolean;
}
export interface DiffWindowRequest {
  projectId: string;
  comparison: GitComparison;
  file: string;
  conflict?: boolean;
  trackedDirectoriesOnly?: boolean;
}

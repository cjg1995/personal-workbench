const operationLabels: Record<string, string> = {
  stage: "Stage", unstage: "Unstage", rollback: "回滚未暂存修改",
  commit: "Commit", fetch: "Fetch", pull: "Pull", push: "Push", checkout: "Checkout",
  "create-branch": "创建分支", "rename-branch": "重命名分支", "delete-branch": "删除分支",
  merge: "Merge", rebase: "Rebase", revert: "Revert", "cherry-pick": "Cherry-pick",
  continue: "Continue", skip: "Skip", abort: "Abort",
  "stash-push": "Stash Push", "stash-apply": "Stash Apply", "stash-pop": "Stash Pop",
  "stash-drop": "Stash Drop", "undo-last": "撤销最后一次提交",
  sequencer: "操作序列",
};
export const gitOperationLabel = (operation: string) => operationLabels[operation] || "Git 操作";
export const comparisonLabels: Record<string, string> = {
  local: "本地变更", staged: "已暂存变更", unstaged: "未暂存变更",
  versions: "版本比较", history: "历史版本比较",
};

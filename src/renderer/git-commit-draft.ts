import { computed, onBeforeUnmount, ref, watch, type Ref } from "vue";

/** Both Git windows edit the same session-local commit message for a project. */
export function useGitCommitDraft(project: Ref<string | undefined>) {
  const text = ref("");
  let revision = 0;
  const unsubscribe = window.workbench.onCommitDraft(draft => {
    if (draft.projectId === project.value) { revision++; text.value = draft.message; }
  });
  watch(project, async projectId => {
    const id = ++revision;
    text.value = "";
    if (!projectId) return;
    const response = await window.workbench.call<string>("git.commit-draft", { projectId });
    if (id === revision && response.ok) text.value = response.data || "";
  }, { immediate: true, flush: "sync" });
  onBeforeUnmount(() => { revision++; unsubscribe(); });
  return computed({
    get: () => text.value,
    set(message: string) {
      revision++;
      text.value = message;
      if (project.value) void window.workbench.call("git.commit-draft", { projectId: project.value, message });
    },
  });
}

export type SubmitTab = "erp" | "app" | "referrer";

export interface FixedBranchPolicy {
  kind: "app";
  branch: "dev" | "main";
  source: "uniapp" | "vue";
  protectedFile: string;
}

export type SubmitPolicy = { kind: "erp" } | FixedBranchPolicy;

export const appSubmitPolicy: FixedBranchPolicy = {
  kind: "app",
  branch: "dev",
  source: "uniapp",
  protectedFile: "store/index.js",
};

export const submitProjectIds: Record<SubmitTab, string[]> = {
  erp: ["homeproject", "homeproject-ai"],
  app: ["employee", "projectman", "worker", "driver"],
  referrer: ["refsys", "refsys-ui", "refsys-wechat"],
};

export function submitTabForProject(projectId: string): SubmitTab | undefined {
  return (Object.keys(submitProjectIds) as SubmitTab[]).find((tab) =>
    submitProjectIds[tab].includes(projectId),
  );
}

export function submitPolicyForProject(projectId: string): SubmitPolicy {
  const tab = submitTabForProject(projectId);
  if (tab === "erp" || projectId === "refsys") return { kind: "erp" };
  if (tab === "app") return appSubmitPolicy;
  if (projectId === "refsys-ui")
    return { kind: "app", branch: "main", source: "vue", protectedFile: "" };
  if (projectId === "refsys-wechat")
    return { ...appSubmitPolicy, protectedFile: "config.js" };
  throw new Error("此项目不支持代码提交");
}

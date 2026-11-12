import fs from "node:fs";
import path from "node:path";
import type { Configuration, ProjectConfig } from "../shared/types.js";
import { Store } from "./store.js";
import { ensureDir } from "./util.js";
export function defaults(dataDir: string): Configuration {
  const hp = "HomeProject",
    ref = "推荐官";
  const app = (
    id: string,
    name: string,
    source: string,
    android: string,
    appId: string,
    packageName: string,
  ): ProjectConfig => ({
    id,
    logicalId: id,
    group: hp,
    name,
    path: source,
    type: "h5",
    android,
    appId,
    packageName,
  });
  return {
    name: "陈嘉庚",
    projects: [
      {
        id: "homeproject",
        logicalId: "homeproject",
        group: hp,
        name: "homeproject",
        path: "D:/IdeaProjects/homeproject",
        type: "tomcat",
      },
      {
        id: "homeproject-ai",
        logicalId: "homeproject",
        group: hp,
        name: "homeproject-ai",
        path: "D:/IdeaProjects/homeproject-ai",
        type: "tomcat",
      },
      app(
        "employee",
        "易居通 APP",
        "D:/git-project/employeeapp-uniapp-bak",
        "D:/androidstudio-employeeapp",
        "__UNI__6C33F0A",
        "com.house.employeeapp",
      ),
      app(
        "projectman",
        "项目经理 APP",
        "D:/git-project/projectmanapp-uniapp",
        "D:/uniAppSIgn/androidstudio-projectmanapp",
        "__UNI__4411B98",
        "com.house.app",
      ),
      app(
        "worker",
        "工人 APP",
        "D:/git-project/workerapp-uniapp",
        "D:/WorkerApp-android-studio",
        "__UNI__30BB9AD",
        "com.house.workerapp",
      ),
      app(
        "driver",
        "司机 APP",
        "D:/git-project/driverapp-uniapp",
        "D:/DriverApp-android-studio",
        "__UNI__76BB53A",
        "com.house.driverapp",
      ),
      {
        id: "wecom",
        logicalId: "wecom",
        group: hp,
        name: "企微侧边栏",
        path: "D:/HBuilderProjects/wecomproject",
        type: "h5",
      },
      {
        id: "customer",
        logicalId: "customer",
        group: hp,
        name: "客户小程序",
        path: "D:/git-project/customerwechat",
        type: "wechat",
      },
      {
        id: "refsys",
        logicalId: "refsys",
        group: ref,
        name: "refsys",
        path: "D:/IdeaProjects/refsys",
        type: "spring",
      },
      {
        id: "refsys-ui",
        logicalId: "refsys-ui",
        group: ref,
        name: "refsys-ui",
        path: "D:/IdeaProjects/refsys-ui",
        type: "vue",
      },
      {
        id: "refsys-wechat",
        logicalId: "refsys-wechat",
        group: ref,
        name: "推荐官小程序",
        path: "D:/HBuilderProjects/refsys-wechatproject",
        type: "uni-wechat",
      },
    ],
    tools: {
      git: "C:/Program Files/Git/cmd/git.exe",
      hbNode: "D:/HBuilderX/plugins/node/node.exe",
      hbCli: "D:/HBuilderX/plugins/uniapp-cli/bin/uniapp-cli.js",
      buildJava: "D:/Android Studio/jre/bin/java.exe",
      wechat: "D:/微信web开发者工具/微信开发者工具.exe",
      idea:
        [
          "C:/Program Files/JetBrains/IntelliJ IDEA 2022.2.1/bin/idea64.exe",
          "D:/IntelliJ IDEA 2020.3.3.0/bin/idea64.exe",
          "D:/IntelliJ IDEA 2020.3.3/bin/idea64.exe",
        ].find((file) => fs.existsSync(file)) || "",
      maven: "D:/apache-maven-3.6.3",
      tapd: "D:/TapdImport/TapdImport.App.exe",
      tapdCwd: "D:/TapdImport",
      documents: path.join(process.env.USERPROFILE || dataDir, "Desktop"),
      exportDir: path.join(process.env.USERPROFILE || dataDir, "Documents"),
      backupDir: path.join(dataDir, "backups"),
      template: "",
    },
  };
}
export class ConfigService {
  constructor(
    private store: Store,
    public dataDir: string,
  ) {
    ensureDir(dataDir);
    const existing = store.get<Configuration>("config", "main");
    if (!existing) {
      store.set("config", "main", defaults(dataDir));
      return;
    }
    const customerIndex = existing.projects.findIndex(
      (project) => project.id === "customer",
    );
    const wecomIndex = existing.projects.findIndex(
      (project) => project.id === "wecom",
    );
    if (customerIndex !== -1 && wecomIndex !== -1 && customerIndex < wecomIndex) {
      const [customer] = existing.projects.splice(customerIndex, 1);
      const nextWecom = existing.projects.findIndex(
        (project) => project.id === "wecom",
      );
      existing.projects.splice(nextWecom + 1, 0, customer);
      store.set("config", "main", existing);
    }
  }
  get() {
    return this.store.get<Configuration>("config", "main")!;
  }
  project(projectId: string) {
    const p = this.get().projects.find((p) => p.id === projectId);
    if (!p) throw new Error("未登记的工作目录");
    return p;
  }
  save(value: Configuration) {
    const original = this.get();
    if (
      !value ||
      value.projects?.length !== 11 ||
      new Set(value.projects.map((p) => p.id)).size !== 11 ||
      original.projects.some(
        (p) =>
          !value.projects.find(
            (v) =>
              v.id === p.id && v.type === p.type && v.logicalId === p.logicalId,
          ),
      )
    )
      throw new Error("必须保留全部 11 个工作目录与类型");
    for (const p of value.projects) {
      if (!p.name?.trim() || !path.isAbsolute(p.path))
        throw new Error("项目名称和绝对路径必填");
      if (
        p.expectedPort !== undefined &&
        (!Number.isInteger(p.expectedPort) ||
          p.expectedPort < 1 ||
          p.expectedPort > 65535)
      )
        throw new Error("端口无效");
      if (p.vmArgs && /[\r\n]/.test(p.vmArgs))
        throw new Error("VM 参数不能换行");
    }
    for (const [key, val] of Object.entries(value.tools)) {
      if (typeof val !== "string" || (val && !path.isAbsolute(val)))
        throw new Error(`工具配置需要绝对路径：${key}`);
    }
    this.store.set("config", "main", value);
    return this.get();
  }
  check(input?: {
    tools?: Record<string, string>;
    projects?: { id: string; path: string }[];
  }) {
    const saved = this.get();
    const tools =
      input?.tools && typeof input.tools === "object" ? input.tools : saved.tools;
    const projects = Array.isArray(input?.projects)
      ? input.projects
      : saved.projects.map((item) => ({ id: item.id, path: item.path }));
    const present = (value: unknown) =>
      typeof value === "string" &&
      !!value &&
      path.isAbsolute(value) &&
      fs.existsSync(value);
    return [
      ...Object.entries(tools)
        .filter((entry): entry is [string, string] => typeof entry[1] === "string")
        .map(([key, value]) => ({ key, path: value, exists: present(value) })),
      ...projects
        .filter(
          (item) =>
            !!item && typeof item.id === "string" && typeof item.path === "string",
        )
        .map((item) => ({
          key: "project:" + item.id,
          path: item.path,
          exists: present(item.path),
        })),
    ];
  }
}

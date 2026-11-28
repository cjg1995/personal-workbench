<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import type { Configuration, ProjectConfig } from "../../shared/types";
import {
  defaultUntrackedRuleByProject,
  formatUntrackedList,
  parseUntrackedInput,
} from "../../shared/git-untracked";
import {
  attempt,
  call,
  confirm,
  context,
  model,
  notify,
  reload,
  setGuard,
  dateLabel,
} from "../state";
import { activeDialog } from "../dialog";
import { formatBytes, projectTypeLabels, splitFilePath } from "../format";
import Icon from "../components/Icon.vue";

function buildUntrackedDrafts(projects: ProjectConfig[]) {
  return Object.fromEntries(
    projects.map((p) => [
      p.id,
      {
        include: formatUntrackedList(p.gitUntrackedInclude),
        exclude: formatUntrackedList(p.gitUntrackedExclude),
      },
    ]),
  );
}

const settingsRoot = ref<HTMLElement>(),
  tab = ref(context.value.tab || "data"),
  form = ref<Configuration>(JSON.parse(JSON.stringify(model.config))),
  saved = ref(JSON.stringify(form.value)),
  untrackedDrafts = ref<Record<string, { include: string; exclude: string }>>(
    buildUntrackedDrafts(form.value.projects),
  ),
  busy = ref(false),
  checks = ref<any[]>([]),
  backups = ref<any[]>([]),
  restorePreview = ref<any>(null);

const dirty = computed(() => JSON.stringify(form.value) !== saved.value);
const sortedBackups = computed(() =>
  [...backups.value].sort(
    (a, b) => (Date.parse(b.at) || 0) - (Date.parse(a.at) || 0),
  ),
);
const templateStatus = computed(() => {
  const value = form.value.tools.template;
  if (!value) return { text: "使用内置模板", cls: "success" };
  return pathStatus("template", value);
});

function syncUntracked(project: ProjectConfig, field: "include" | "exclude") {
  const raw = untrackedDrafts.value[project.id]?.[field] ?? "";
  const list = parseUntrackedInput(raw);
  const key =
    field === "include" ? "gitUntrackedInclude" : "gitUntrackedExclude";
  const hadPreset = !!defaultUntrackedRuleByProject[project.id];
  if (list.length) {
    project[key] = list;
  } else {
    project[key] = hadPreset ? [] : undefined;
  }
}

function onKeydown(event: KeyboardEvent) {
  if (
    !activeDialog.value &&
    dirty.value &&
    !busy.value &&
    (event.ctrlKey || event.metaKey) &&
    event.key.toLowerCase() === "s"
  ) {
    event.preventDefault();
    void save();
  }
}

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  if (tab.value === "projects" && typeof context.value.projectId === "string") {
    await nextTick();
    const target = settingsRoot.value?.querySelector<HTMLDetailsElement>(
      `details.settings-project[data-project-id="${CSS.escape(context.value.projectId)}"]`,
    );
    if (target) {
      target.open = true;
      target.scrollIntoView({ block: "nearest" });
    }
  }
});

const labels: Record<string, string> = {
  git: "Git 可执行文件",
  hbNode: "HBuilderX Node",
  hbCli: "UniApp CLI",
  buildJava: "APK 构建 Java",
  wechat: "微信开发者工具",
  idea: "IDEA 可执行文件",
  maven: "Maven 目录",
  tapd: "TAPD 客户端",
  tapdCwd: "TAPD 工作目录",
  documents: "常用文档目录",
  exportDir: "默认导出目录",
  backupDir: "备份目录",
  template: "月报空白模板（空为内置）",
};
const commonTools = ["git", "idea", "maven", "wechat", "tapd"];
const advancedTools = Object.keys(labels).filter(
  (key) => key !== "template" && !commonTools.includes(key),
);

setGuard(
  async () =>
    JSON.stringify(form.value) === saved.value ||
    (await confirm(
      "配置尚未保存",
      "离开后未保存的项目和工具配置将丢弃。",
      "丢弃配置",
    )),
);
onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  setGuard(null);
});

function pathStatus(key: string, value: string) {
  if (!value) return { text: "未填写", cls: "warn" };
  const hit = checks.value.find(
    (item) => item.key === key && item.path === value,
  );
  if (!hit) return { text: "未检测", cls: "" };
  return hit.exists
    ? { text: "存在", cls: "success" }
    : { text: "不存在", cls: "warn" };
}

async function refreshChecks() {
  checks.value = await call("settings.check", {
    tools: form.value.tools,
    projects: form.value.projects.map((item) => ({
      id: item.id,
      path: item.path,
    })),
  });
}

async function check() {
  await refreshChecks();
  backups.value = await call("backup.list");
}
void attempt(check);

async function save() {
  busy.value = true;
  await attempt(async () => {
    form.value = await call("settings.save", form.value);
    saved.value = JSON.stringify(form.value);
    untrackedDrafts.value = buildUntrackedDrafts(form.value.projects);
    await reload();
    await check();
    notify("本地配置已保存");
  });
  busy.value = false;
}

async function discard() {
  if (
    !(await confirm(
      "放弃未保存修改",
      "当前未保存的项目与工具配置修改将被丢弃。",
      "放弃修改",
      { tone: "warning", danger: true },
    ))
  )
    return;
  form.value = JSON.parse(saved.value);
  untrackedDrafts.value = buildUntrackedDrafts(form.value.projects);
  notify("已放弃未保存修改");
  void attempt(refreshChecks);
}

function resetBuiltinTemplate() {
  form.value.tools.template = "";
  void attempt(refreshChecks);
}

async function pickTool(key: string) {
  await attempt(async () => {
    const value = await call<string | null>("settings.pick-path", {
      current: (form.value.tools as any)[key],
      target: [
        "maven",
        "tapdCwd",
        "documents",
        "exportDir",
        "backupDir",
      ].includes(key)
        ? "directory"
        : "file",
    });
    if (value) {
      (form.value.tools as any)[key] = value;
      await refreshChecks();
    }
  });
}

async function pickProject(project: { path: string }) {
  await attempt(async () => {
    const value = await call<string | null>("settings.pick-path", {
      current: project.path,
      target: "directory",
    });
    if (value) {
      project.path = value;
      await refreshChecks();
    }
  });
}

async function createBackup() {
  busy.value = true;
  await attempt(async () => {
    const result = await call("backup.create");
    if (result) {
      await check();
      notify("备份已创建：" + result.path);
    }
  });
  busy.value = false;
}

async function previewRestore(file?: string) {
  busy.value = true;
  await attempt(async () => {
    restorePreview.value = await call(
      "backup.preview",
      file ? { file } : undefined,
    );
  });
  busy.value = false;
}

async function restore() {
  busy.value = true;
  await attempt(async () => {
    const result = await call("backup.restore", {
      token: restorePreview.value.token,
    });
    if (result) {
      restorePreview.value = null;
      await reload();
      form.value = JSON.parse(JSON.stringify(model.config));
      saved.value = JSON.stringify(form.value);
      untrackedDrafts.value = buildUntrackedDrafts(form.value.projects);
      await check();
      notify("恢复完成，原数据保护备份：" + result.protectedBackup);
    }
  });
  busy.value = false;
}
</script>
<template>
  <div ref="settingsRoot" class="subpage-wrap">
    <div class="card settings-card">
      <div class="settings-toolbar">
        <div class="tabs" role="tablist" aria-label="设置分类">
          <button
            type="button"
            role="tab"
            :class="{ active: tab === 'projects' }"
            :aria-selected="tab === 'projects'"
            @click="tab = 'projects'"
          >
            工作目录<span class="count">{{ form.projects.length }}</span>
          </button>
          <button
            type="button"
            role="tab"
            :class="{ active: tab === 'tools' }"
            :aria-selected="tab === 'tools'"
            @click="tab = 'tools'"
          >
            工具与客户端
          </button>
          <button
            type="button"
            role="tab"
            :class="{ active: tab === 'data' }"
            :aria-selected="tab === 'data'"
            @click="tab = 'data'"
          >
            本地数据
          </button>
          <button
            type="button"
            role="tab"
            :class="{ active: tab === 'template' }"
            :aria-selected="tab === 'template'"
            @click="tab = 'template'"
          >
            月报模板
          </button>
        </div>
        <span class="settings-version" title="工作台版本">v{{ model.version }}</span>
      </div>

      <div class="settings-body">
        <section v-if="tab === 'projects'">
          <details
            v-for="p in form.projects"
            :key="p.id"
            :data-project-id="p.id"
            class="settings-project"
          >
            <summary>
              <strong>{{ p.name }}</strong>
              <span>{{ p.group }} · {{ projectTypeLabels[p.type] || p.type }}</span>
              <span
                class="pill"
                :class="pathStatus('project:' + p.id, p.path).cls"
                >{{ pathStatus("project:" + p.id, p.path).text }}</span
              >
            </summary>
            <label class="form-line">
              <span>显示名称</span>
              <input v-model="p.name" />
            </label>
            <div class="form-line">
              <span>工作目录</span>
              <input
                v-model="p.path"
                :aria-label="p.name + ' 工作目录'"
                @change="refreshChecks"
              />
              <button type="button" @click="pickProject(p)">选择…</button>
            </div>
            <label v-if="p.android" class="form-line">
              <span>Android 工程</span>
              <input v-model="p.android" />
            </label>
            <label
              v-if="['tomcat', 'spring'].includes(p.type)"
              class="form-line"
            >
              <span>Java</span>
              <input v-model="p.java" placeholder="留空沿用项目 / IDEA 配置" />
            </label>
            <label v-if="p.type === 'tomcat'" class="form-line">
              <span>Tomcat home</span>
              <input
                v-model="p.catalinaHome"
                placeholder="留空沿用 IDEA 工具路径"
              />
            </label>
            <label v-if="p.type === 'tomcat'" class="form-line">
              <span>Tomcat base</span>
              <input
                v-model="p.catalinaBase"
                placeholder="留空沿用项目独立 base"
              />
            </label>
            <label v-if="p.type === 'tomcat'" class="form-line">
              <span>部署目录</span>
              <input
                v-model="p.deployment"
                placeholder="留空沿用现有 exploded 部署"
              />
            </label>
            <label v-if="p.type !== 'wechat'" class="form-line">
              <span>端口</span>
              <input
                :value="p.expectedPort"
                type="number"
                min="1"
                max="65535"
                placeholder="留空沿用项目配置"
                @input="
                  p.expectedPort = ($event.target as HTMLInputElement).value
                    ? Number(($event.target as HTMLInputElement).value)
                    : undefined
                "
              />
            </label>
            <label
              v-if="['tomcat', 'spring'].includes(p.type)"
              class="form-line"
            >
              <span>上下文</span>
              <input v-model="p.context" placeholder="留空沿用项目配置" />
            </label>
            <label
              v-if="['tomcat', 'spring'].includes(p.type)"
              class="form-line"
            >
              <span>VM 参数</span>
              <input v-model="p.vmArgs" placeholder="留空沿用项目配置" />
            </label>
            <label v-if="p.type === 'spring'" class="form-line">
              <span>Spring Profile</span>
              <input v-model="p.springProfile" placeholder="留空沿用原运行配置" />
            </label>
            <label class="form-line">
              <span>未跟踪显示范围</span>
              <input
                v-model="untrackedDrafts[p.id].include"
                :aria-label="p.name + ' 未跟踪显示范围'"
                placeholder="留空按已有受跟踪目录，填 * 显示全部，逗号分隔，如 src/, WebRoot/"
                @input="syncUntracked(p, 'include')"
              />
            </label>
            <label class="form-line">
              <span>未跟踪排除规则</span>
              <input
                v-model="untrackedDrafts[p.id].exclude"
                :aria-label="p.name + ' 未跟踪排除规则'"
                placeholder="留空不额外排除，填 * 全部隐藏，逗号分隔，如 *.rar, *.zip"
                @input="syncUntracked(p, 'exclude')"
              />
            </label>
          </details>
        </section>

        <section v-else-if="tab === 'tools'" class="form-section">
          <h2>常用工具</h2>
          <div v-for="key in commonTools" :key="key" class="form-line">
            <span>{{ labels[key] }}</span>
            <input
              v-model="(form.tools as any)[key]"
              :aria-label="labels[key]"
              @change="refreshChecks"
            />
            <button type="button" @click="pickTool(key)">选择…</button>
            <span
              class="pill"
              :class="pathStatus(key, (form.tools as any)[key]).cls"
              >{{ pathStatus(key, (form.tools as any)[key]).text }}</span
            >
          </div>

          <details class="section-rule">
            <summary>进阶工具与目录</summary>
            <div v-for="key in advancedTools" :key="key" class="form-line">
              <span>{{ labels[key] }}</span>
              <input
                v-model="(form.tools as any)[key]"
                :aria-label="labels[key]"
                @change="refreshChecks"
              />
              <button type="button" @click="pickTool(key)">选择…</button>
              <span
                class="pill"
                :class="pathStatus(key, (form.tools as any)[key]).cls"
                >{{ pathStatus(key, (form.tools as any)[key]).text }}</span
              >
            </div>
          </details>

          <div class="actions">
            <button type="button" @click="attempt(check, '检测完成')">
              <Icon name="refresh" :size="14" />重新检测
            </button>
          </div>
        </section>

        <section v-else-if="tab === 'data'" class="form-section">
          <div class="form-line" style="margin-top: 0">
            <span>数据目录</span>
            <input
              :value="model.dataDir"
              readonly
              aria-label="数据目录"
            />
            <button
              type="button"
              @click="attempt(() => call('settings.data-folder'))"
            >
              <Icon name="folder" :size="14" />打开目录
            </button>
          </div>

          <section class="section-rule">
            <h2>备份与恢复</h2>
            <p class="muted small" style="margin-bottom: 12px">
              包含记录、提示词、配置、月报与快照
            </p>
            <div class="actions">
              <button
                type="button"
                class="btn primary"
                :disabled="busy"
                @click="createBackup"
              >
                创建备份
              </button>
              <button
                type="button"
                class="btn"
                :disabled="busy"
                @click="previewRestore()"
              >
                选择备份并预览
              </button>
            </div>

            <table v-if="sortedBackups.length" class="table">
              <thead>
                <tr>
                  <th>备份文件</th>
                  <th>日期</th>
                  <th>大小</th>
                  <th>操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="b in sortedBackups" :key="b.path">
                  <td :title="b.path">
                    <div class="backup-name">{{ splitFilePath(b.path).name }}</div>
                    <div class="path small muted">{{ splitFilePath(b.path).dir }}</div>
                  </td>
                  <td>{{ dateLabel(b.at) }}</td>
                  <td>{{ formatBytes(b.bytes) }}</td>
                  <td>
                    <button
                      type="button"
                      class="text-action"
                      :disabled="busy"
                      @click="previewRestore(b.path)"
                    >
                      预览恢复
                    </button>
                  </td>
                </tr>
              </tbody>
            </table>

            <div
              v-if="restorePreview"
              class="notice warning"
              style="margin-top: 14px"
            >
              <h3>恢复预览</h3>
              <p>
                备份日期 {{ dateLabel(restorePreview.manifest.createdAt) }} ·
                TXT 快照 {{ restorePreview.snapshotCount }} 个
              </p>
              <p>{{ restorePreview.impact }}</p>
              <table class="table" style="margin-top: 8px">
                <thead>
                  <tr>
                    <th>内容</th>
                    <th>当前</th>
                    <th>备份</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="key in [
                      'note',
                      'prompt',
                      'monthly',
                      'task',
                      'import',
                      'config',
                    ]"
                    :key="key"
                  >
                    <td>
                      {{
                        (
                          {
                            note: "记录",
                            prompt: "提示词",
                            monthly: "月报",
                            task: "任务",
                            import: "导入批次",
                            config: "配置",
                          } as any
                        )[key]
                      }}
                    </td>
                    <td>{{ restorePreview.currentCounts[key] ?? 0 }}</td>
                    <td>{{ restorePreview.counts[key] ?? 0 }}</td>
                  </tr>
                </tbody>
              </table>
              <div class="actions">
                <button
                  type="button"
                  :disabled="busy"
                  class="btn primary"
                  @click="restore"
                >
                  保留当前备份并恢复此数据
                </button>
                <button
                  type="button"
                  class="btn"
                  @click="restorePreview = null"
                >
                  取消恢复
                </button>
              </div>
            </div>
          </section>
        </section>

        <section v-else class="form-section">
          <label class="form-line" style="margin-top: 0">
            <span>导出默认姓名</span>
            <input
              v-model="form.name"
              placeholder="用于月报导出文件名"
            />
          </label>
          <div class="form-line">
            <span>模板路径</span>
            <input
              v-model="form.tools.template"
              placeholder="留空使用内置空白模板（需保留五个章节槽位）"
              @change="refreshChecks"
            />
            <button type="button" @click="pickTool('template')">选择…</button>
            <button
              v-if="form.tools.template"
              type="button"
              class="text-action"
              @click="resetBuiltinTemplate"
            >
              恢复内置模板
            </button>
            <span class="pill" :class="templateStatus.cls">{{
              templateStatus.text
            }}</span>
            <button
              type="button"
              @click="attempt(() => call('settings.template'))"
            >
              <Icon name="document" :size="14" />查看空白模板
            </button>
          </div>
        </section>
      </div>

      <div v-if="dirty" class="save-bar" role="group" aria-label="未保存的配置">
        <button type="button" class="btn" :disabled="busy" @click="discard">
          放弃修改
        </button>
        <button
          type="button"
          class="btn primary"
          :disabled="busy"
          title="保存配置（Ctrl+S）"
          @click="save"
        >
          保存配置
        </button>
      </div>
    </div>
  </div>
</template>

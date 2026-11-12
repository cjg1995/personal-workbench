<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from "vue";
import type { Configuration } from "../../shared/types";
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
const tab = ref(context.value.tab || "data"),
  form = ref<Configuration>(JSON.parse(JSON.stringify(model.config))),
  saved = ref(JSON.stringify(form.value)),
  busy = ref(false),
  checks = ref<any[]>([]),
  backups = ref<any[]>([]),
  restorePreview = ref<any>(null);
const dirty = computed(() => JSON.stringify(form.value) !== saved.value);
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
onBeforeUnmount(() => setGuard(null));
function pathStatus(key: string, value: string) {
  if (!value) return { text: "未填写", cls: "warn" };
  const hit = checks.value.find((item) => item.key === key && item.path === value);
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
    await reload();
    await check();
    notify("本地配置已保存");
  });
  busy.value = false;
}
function discard() {
  form.value = JSON.parse(saved.value);
  notify("已放弃未保存修改");
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
async function previewRestore() {
  busy.value = true;
  await attempt(async () => {
    restorePreview.value = await call("backup.preview");
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
      await check();
      notify("恢复完成，原数据保护备份：" + result.protectedBackup);
    }
  });
  busy.value = false;
}
</script>
<template>
  <div class="tabs" role="group" aria-label="设置分类">
    <button
      :class="{ active: tab === 'projects' }"
      :aria-pressed="tab === 'projects'"
      @click="tab = 'projects'"
    >
      工作目录</button
    ><button
      :class="{ active: tab === 'tools' }"
      :aria-pressed="tab === 'tools'"
      @click="tab = 'tools'"
    >
      工具与客户端</button
    ><button
      :class="{ active: tab === 'data' }"
      :aria-pressed="tab === 'data'"
      @click="tab = 'data'"
    >
      本地数据</button
    ><button
      :class="{ active: tab === 'template' }"
      :aria-pressed="tab === 'template'"
      @click="tab = 'template'"
    >
      月报模板
    </button>
  </div>
  <section v-if="tab === 'projects'">
    <h2>工作目录 · {{ form.projects.length }} 个</h2>
    <p class="small muted">未填写的高级字段沿用项目和 IDEA 配置。</p>
    <details v-for="p in form.projects" :key="p.id" class="settings-project">
      <summary>
        {{ p.name }} <span>{{ p.group }} · {{ p.type }}</span>
        <span
          class="pill"
          :class="pathStatus('project:' + p.id, p.path).cls"
          >{{ pathStatus("project:" + p.id, p.path).text }}</span
        >
      </summary>
      <label class="form-line"
        ><span>显示名称</span><input v-model="p.name"
      /></label>
      <div class="form-line">
        <span>工作目录</span
        ><input
          v-model="p.path"
          :aria-label="p.id + ' 工作目录'"
          @change="refreshChecks"
        /><button @click="pickProject(p)">选择…</button>
      </div>
      <label v-if="p.android" class="form-line"
        ><span>Android 工程</span><input v-model="p.android" /></label
      ><label v-if="['tomcat', 'spring'].includes(p.type)" class="form-line"
        ><span>Java（空为原配置）</span><input v-model="p.java" /></label
      ><label v-if="p.type === 'tomcat'" class="form-line"
        ><span>Tomcat home</span
        ><input
          v-model="p.catalinaHome"
          placeholder="空为 IDEA 中的工具路径" /></label
      ><label v-if="p.type === 'tomcat'" class="form-line"
        ><span>Tomcat base</span
        ><input
          v-model="p.catalinaBase"
          placeholder="空为该项目独立 base" /></label
      ><label v-if="p.type === 'tomcat'" class="form-line"
        ><span>部署目录</span
        ><input
          v-model="p.deployment"
          placeholder="空为现有 exploded 部署" /></label
      ><label v-if="p.type !== 'wechat'" class="form-line"
        ><span>实际配置端口</span
        ><input
          :value="p.expectedPort"
          type="number"
          min="1"
          max="65535"
          placeholder="空为实际项目配置"
          @input="
            p.expectedPort = ($event.target as HTMLInputElement).value
              ? Number(($event.target as HTMLInputElement).value)
              : undefined
          " /></label
      ><label v-if="['tomcat', 'spring'].includes(p.type)" class="form-line"
        ><span>上下文（空为原配置）</span><input v-model="p.context" /></label
      ><label v-if="['tomcat', 'spring'].includes(p.type)" class="form-line"
        ><span>VM 参数（空为原配置）</span><input v-model="p.vmArgs" /></label
      ><label v-if="p.type === 'spring'" class="form-line"
        ><span>Spring Profile</span
        ><input v-model="p.springProfile" placeholder="空为原运行配置"
      /></label>
    </details>
  </section>
  <section v-else-if="tab === 'tools'" class="form-section">
    <h2>常用工具</h2>
    <div v-for="key in commonTools" :key="key" class="form-line">
      <span>{{ labels[key] }}</span
      ><input
        v-model="(form.tools as any)[key]"
        :aria-label="labels[key]"
        @change="refreshChecks"
      /><button @click="pickTool(key)">选择…</button
      ><span
        class="pill"
        :class="pathStatus(key, (form.tools as any)[key]).cls"
        >{{ pathStatus(key, (form.tools as any)[key]).text }}</span
      >
    </div>
    <details class="section-rule">
      <summary>进阶工具与目录</summary>
      <div v-for="key in advancedTools" :key="key" class="form-line">
        <span>{{ labels[key] }}</span
        ><input
          v-model="(form.tools as any)[key]"
          :aria-label="labels[key]"
          @change="refreshChecks"
        /><button @click="pickTool(key)">选择…</button
        ><span
          class="pill"
          :class="pathStatus(key, (form.tools as any)[key]).cls"
          >{{ pathStatus(key, (form.tools as any)[key]).text }}</span
        >
      </div>
    </details>
    <div class="actions">
      <button @click="attempt(check, '检测完成')">重新检测</button>
    </div>
  </section>
  <section v-else-if="tab === 'data'">
    <h2>本地数据</h2>
    <div class="form-line">
      <span>当前数据目录</span
      ><input
        :value="model.dataDir"
        readonly
        aria-label="当前数据目录"
      /><button @click="attempt(() => call('settings.data-folder'))">
        打开目录
      </button>
    </div>
    <p class="small muted">版本 {{ model.version }}。数据只保存在本机。</p>
    <section class="section-rule">
      <h2>备份与恢复</h2>
      <p class="muted">
        备份包含记录、配置、月报、审查和 TXT 快照。恢复前会先保护当前数据，并要求没有正在运行的任务。
      </p>
      <div class="actions">
        <button class="primary" :disabled="busy" @click="createBackup">
          创建备份</button
        ><button :disabled="busy" @click="previewRestore">
          选择备份并预览
        </button>
      </div>
      <p class="small muted">不含 APK、源码和日志文件本身。</p>
      <table v-if="backups.length" class="table">
        <thead>
          <tr>
            <th>备份文件</th>
            <th>日期</th>
            <th>大小</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="b in backups" :key="b.path">
            <td class="path">{{ b.path }}</td>
            <td>{{ dateLabel(b.at) }}</td>
            <td>{{ (b.bytes / 1024).toFixed(1) }} KB</td>
          </tr>
        </tbody>
      </table>
      <div v-if="restorePreview" class="notice warning">
        <h3>恢复预览</h3>
        <p>
          备份日期 {{ dateLabel(restorePreview.manifest.createdAt) }} · TXT 快照
          {{ restorePreview.snapshotCount }} 个
        </p>
        <p>{{ restorePreview.impact }}</p>
        <table class="table">
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
                'monthly',
                'review',
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
                      monthly: "月报",
                      review: "审查",
                      task: "任务",
                      import: "导入批次",
                      config: "配置",
                    } as any
                  )[key]
                }}
              </td>
              <td>{{ restorePreview.currentCounts[key] }}</td>
              <td>{{ restorePreview.counts[key] }}</td>
            </tr>
          </tbody>
        </table>
        <div class="actions">
          <button :disabled="busy" class="primary" @click="restore">
            保留当前备份并恢复此数据</button
          ><button @click="restorePreview = null">取消恢复</button>
        </div>
      </div>
    </section>
  </section>
  <section v-else class="form-section">
    <h2>固定月报模板</h2>
    <p>
      沿用现有月报章节与排版，旧业务正文已清除。「一、工作成果」下的截图在月报页粘贴后自动插入。
    </p>
    <label class="form-line"
      ><span>默认姓名</span><input v-model="form.name"
    /></label>
    <p class="small muted">
      默认姓名用于月报导出文件名，月报页不再单独输入。
    </p>
    <div class="form-line">
      <span>模板路径</span
      ><input
        v-model="form.tools.template"
        placeholder="使用应用内置空白模板"
      /><button @click="pickTool('template')">选择…</button>
    </div>
    <p class="small muted">自选模板需保留五个章节槽位。</p>
    <div class="actions">
      <button @click="attempt(() => call('settings.template'))">
        查看空白模板
      </button>
    </div>
  </section>
  <div v-if="dirty" class="save-bar">
    <span class="save-hint">配置有未保存的修改</span
    ><button :disabled="busy" @click="discard">放弃修改</button
    ><button class="primary" :disabled="busy" @click="save">保存配置</button>
  </div>
</template>

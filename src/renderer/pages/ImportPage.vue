<script setup lang="ts">
import { computed, ref } from "vue";
import type { ImportPreview, RecordKind } from "../../shared/types";
import {
  attempt,
  call,
  context,
  model,
  navigate,
  notify,
  reload,
} from "../state";
const kind = ref<RecordKind>(context.value.kind || "work"),
  encoding = ref("auto"),
  preview = ref<ImportPreview | null>(null),
  busy = ref(false),
  result = ref<any>(null);
const selected = computed(
  () => preview.value?.lines.filter((l) => l.selected).map((l) => l.line) || [],
);
async function choose() {
  busy.value = true;
  await attempt(async () => {
    const p = await call<ImportPreview | null>("import.preview", {
      kind: kind.value,
      encoding: encoding.value,
    });
    if (p) {
      preview.value = p;
      result.value = null;
    }
  });
  busy.value = false;
}
async function changeEncoding() {
  if (!preview.value) return;
  await attempt(
    async () =>
      (preview.value = await call("import.encoding", {
        id: preview.value!.id,
        encoding: encoding.value,
      })),
  );
}
async function importRows() {
  if (!preview.value) return;
  busy.value = true;
  await attempt(async () => {
    result.value = await call("import.commit", {
      id: preview.value!.id,
      selected: selected.value,
      dates: Object.fromEntries(
        preview.value!.lines.map((l) => [String(l.line), l.happenedOn]),
      ),
    });
    await reload();
    notify("复制导入完成，原 TXT 保持不变");
  });
  busy.value = false;
}
</script>
<template>
  <div class="step-strip">
    <span class="active"><b>1</b>选择文件</span
    ><span :class="{ active: !!preview }"><b>2</b>预览与确认</span
    ><span :class="{ active: !!result }"><b>3</b>导入结果</span>
  </div>
  <div class="toolbar">
    <select
      v-model="kind"
      aria-label="导入目标类型"
      :disabled="!!preview && !result"
    >
      <option value="idea">灵感待办 · todo.txt</option>
      <option value="work">工作记录 · temp.txt</option></select
    ><select v-model="encoding" aria-label="TXT 编码" @change="changeEncoding">
      <option value="auto">自动识别编码</option>
      <option value="utf-8">UTF-8 / BOM</option>
      <option value="gb18030">中文本机编码 GBK / GB18030</option>
      <option value="utf-16le">UTF-16 LE</option></select
    ><button class="primary" :disabled="busy" @click="choose">
      {{ preview ? "更换文件" : "选择 TXT 文件" }}</button
    ><button
      v-if="preview"
      @click="
        preview = null;
        result = null;
      "
    >
      重新选择类型
    </button>
  </div>
  <template v-if="preview"
    ><section class="section-rule">
      <h2>导入文件信息</h2>
      <p class="path">{{ preview.path }}</p>
      <p class="small muted">
        类型 {{ preview.kind === "idea" ? "灵感待办" : "工作记录" }} · 编码
        {{ preview.encoding }} · {{ preview.bytes }} 字节 ·
        {{ preview.lines.length }} 条非空物理行
      </p>
      <p v-if="preview.warning" class="notice warning">{{ preview.warning }}</p>
      <details>
        <summary>查看解码后的完整原文</summary>
        <pre class="log">{{ preview.raw }}</pre>
      </details>
    </section>
    <template v-if="!result"
      ><section class="section-rule">
        <h2>内容预览与选择</h2>
        <p class="small muted">
          括号和标点保留原文，不进一步拆条。重复项默认跳过，可明确勾选保留另一条同文事项。
        </p>
        <table class="table import-table">
          <thead>
            <tr>
              <th>选择</th>
              <th>原始行号</th>
              <th>记录内容</th>
              <th>识别结果</th>
              <th v-if="preview.kind === 'work'">发生日期</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="line in preview.lines" :key="line.line">
              <td>
                <input
                  v-model="line.selected"
                  type="checkbox"
                  :aria-label="'导入原始第 ' + line.line + ' 行'"
                />
              </td>
              <td>{{ line.line }}</td>
              <td>{{ line.text }}</td>
              <td>
                <span class="pill">{{
                  line.duplicate ? "原文重复，默认跳过" : "新增"
                }}</span>
              </td>
              <td v-if="preview.kind === 'work'">
                <input
                  v-model="line.happenedOn"
                  type="date"
                  :aria-label="'第 ' + line.line + ' 行发生日期'"
                /><small
                  v-if="!line.happenedOn"
                  class="muted"
                  style="display: block"
                  >日期待补充</small
                >
              </td>
            </tr>
          </tbody>
        </table>
      </section>
      <p class="notice section-rule">
        原文件与字节快照均保留，后续在工作台记录，不回写
        TXT。无日期内容不会按导入时间归入月报。
      </p>
      <div class="row spaced">
        <span
          >本次新增 {{ selected.length }} 条 · 跳过
          {{ preview.lines.length - selected.length }} 条</span
        ><button
          class="primary"
          :disabled="busy || !selected.length"
          @click="importRows"
        >
          {{ busy ? "保存中…" : "确认复制导入 " + selected.length + " 条" }}
        </button>
      </div></template
    >
    <section v-else class="section-rule">
      <h2>导入完成</h2>
      <p>
        新增 {{ result.added }} 条 · 跳过 {{ result.skipped }} 条 · 失败
        {{ result.failed }} 条
      </p>
      <p class="path">原文快照 {{ result.snapshot }}</p>
      <button
        class="primary"
        @click="
          navigate(preview.kind === 'idea' ? 'ideas' : 'work', {
            tab: preview.kind === 'work' ? 'undated' : 'active',
          })
        "
      >
        查看导入记录
      </button>
      <table class="table">
        <thead>
          <tr>
            <th>原始行</th>
            <th>原文</th>
            <th>结果</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="line in preview.lines" :key="line.line">
            <td>{{ line.line }}</td>
            <td>{{ line.text }}</td>
            <td>
              {{
                result.records.some((n: any) => n.sourceLine === line.line)
                  ? "已新增"
                  : "已跳过"
              }}
            </td>
          </tr>
        </tbody>
      </table>
    </section></template
  >
  <p v-else class="empty">
    复制导入前先预览原文、目标类型、重复项与日期。原 TXT 不会被修改或删除。
  </p>
</template>

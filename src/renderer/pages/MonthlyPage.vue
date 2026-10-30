<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import type { MonthlyDraft, MonthlyImage, Note } from "../../shared/types";
import { sections } from "../../shared/types";
import {
  attempt,
  call,
  confirm,
  context,
  model,
  navigate,
  notify,
  setGuard,
} from "../state";
import Icon from "../components/Icon.vue";
const month = ref(context.value.month || model.today.slice(0, 7)),
  draft = ref<MonthlyDraft | null>(null),
  materials = ref<Note[]>([]),
  undated = ref(0),
  selected = ref<string[]>([]),
  section = ref("其他"),
  saveState = ref(""),
  dirty = ref(false),
  loading = ref(true);
const imageInput = ref<HTMLInputElement | null>(null),
  imageBusy = ref(false),
  imageError = ref("");
const maxImageWidth = 1240;
const images = computed(() => draft.value?.images ?? []);
const shotUrls = computed(() => {
  const urls = new Map<string, string>();
  for (const image of images.value)
    urls.set(image.id, `data:${image.mime};base64,${image.data}`);
  return urls;
});
let timer: ReturnType<typeof setTimeout> | undefined;
let pending: Promise<void> | null = null,
  unmounted = false;
const linked = computed(
  () => new Set(draft.value?.entries.flatMap((e) => e.sourceIds) || []),
);
const stateClass = computed(() =>
  saveState.value.includes("失败")
    ? "error"
    : saveState.value.includes("待保存") || saveState.value.includes("新修改")
      ? "pending"
      : "",
);
const selectableMaterials = computed(() =>
  materials.value.filter((n) => !linked.value.has(n.id)),
);
const allSelected = computed(
  () =>
    selectableMaterials.value.length > 0 &&
    selectableMaterials.value.every((n) => selected.value.includes(n.id)),
);
const someSelected = computed(
  () => selected.value.length > 0 && !allSelected.value,
);
function toggleAll(event: Event) {
  selected.value = (event.target as HTMLInputElement).checked
    ? selectableMaterials.value.map((n) => n.id)
    : [];
}
async function flush() {
  if (timer) clearTimeout(timer);
  if (pending) await pending;
  if (!dirty.value || !draft.value) return;
  const current = JSON.stringify(draft.value);
  saveState.value = "保存中…";
  pending = (async () => {
    try {
      const saved = await call<MonthlyDraft>("monthly.save", draft.value);
      if (current === JSON.stringify(draft.value)) {
        dirty.value = false;
        saveState.value =
          "草稿已保存 " +
          new Date(saved.updatedAt).toLocaleTimeString("zh-CN", {
            hour: "2-digit",
            minute: "2-digit",
          });
      } else saveState.value = "仍有新修改待保存";
    } catch (e) {
      saveState.value = "保存失败，正文仍保留在页面";
      throw e;
    }
  })();
  try {
    await pending;
  } finally {
    pending = null;
  }
}
async function guard() {
  try {
    await flush();
    return (
      !dirty.value ||
      (await confirm(
        "月报尚未保存",
        "正文仍有修改，离开会丢弃当前页面未保存内容。",
        "丢弃并离开",
      ))
    );
  } catch (e) {
    notify(e instanceof Error ? e.message : String(e), true);
    return false;
  }
}
setGuard(guard);
onBeforeUnmount(() => {
  unmounted = true;
  setGuard(null);
  if (timer) clearTimeout(timer);
  document.removeEventListener("paste", pasteEverywhere);
  document.removeEventListener("dragover", guardDrag);
  document.removeEventListener("drop", dropEverywhere);
});
function edited() {
  dirty.value = true;
  saveState.value = "待保存";
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => {
    if (!unmounted) void attempt(flush);
  }, 650);
}
async function load(replace = true) {
  loading.value = true;
  await attempt(async () => {
    const data = await call<any>("monthly.get", {
      month: month.value,
    });
    materials.value = data.materials;
    undated.value = data.undated;
    if (replace) {
      draft.value = data.draft;
      draft.value!.images ??= [];
      dirty.value = false;
      saveState.value = draft.value!.entries.length ? "草稿已读取" : "";
      selected.value = [];
    }
  });
  loading.value = false;
}
onMounted(() => {
  document.addEventListener("paste", pasteEverywhere);
  document.addEventListener("dragover", guardDrag);
  document.addEventListener("drop", dropEverywhere);
  void load();
});
async function changeMonth(event: Event) {
  const next = (event.target as HTMLInputElement).value;
  if (!next) return;
  if (!(await guard())) {
    (event.target as HTMLInputElement).value = month.value;
    return;
  }
  month.value = next;
  await load();
}
async function addSources() {
  await attempt(async () => {
    await flush();
    draft.value = await call("monthly.add", {
      month: month.value,
      name: draft.value?.name || model.config?.name,
      section: section.value,
      ids: selected.value,
    });
    dirty.value = false;
    selected.value = [];
    await load(false);
    saveState.value = "草稿已保存";
    notify("已按原文加入正文，可继续编辑");
  });
}
function addManual(section: string) {
  if (!draft.value) return;
  draft.value.entries.push({
    id: crypto.randomUUID(),
    section,
    text: "",
    sourceIds: [],
    sourceVersions: {},
    manual: true,
  });
  edited();
}
function move(entryId: string, delta: number) {
  if (!draft.value) return;
  const list = draft.value.entries,
    i = list.findIndex((e) => e.id === entryId),
    j = i + delta;
  if (j < 0 || j >= list.length) return;
  [list[i], list[j]] = [list[j], list[i]];
  edited();
}
async function remove(entryId: string) {
  if (!draft.value) return;
  if (
    !(await confirm(
      "删除月报条目",
      "只从当前月报正文中删除此条，不删除原始工作记录。",
      "删除条目",
    ))
  )
    return;
  draft.value.entries = draft.value.entries.filter((e) => e.id !== entryId);
  edited();
}
async function shrinkShot(file: Blob, order: number): Promise<MonthlyImage> {
  const bitmap = await createImageBitmap(file);
  try {
    const scale = Math.min(1, maxImageWidth / bitmap.width);
    const width = Math.max(1, Math.round(bitmap.width * scale)),
      height = Math.max(1, Math.round(bitmap.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("当前环境无法处理图片");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, width, height);
    context.drawImage(bitmap, 0, 0, width, height);
    const url = canvas.toDataURL(
      file.type === "image/png" ? "image/png" : "image/jpeg",
      0.92,
    );
    return {
      id: crypto.randomUUID(),
      name: `工作内容汇总截图${order}`,
      mime: url.slice(5, url.indexOf(";", 5)),
      width,
      height,
      data: url.slice(url.indexOf(",") + 1),
    };
  } finally {
    bitmap.close();
  }
}
async function addShots(list: Array<File | Blob>) {
  if (!draft.value || imageBusy.value) return;
  const candidates = list.filter((file) => file.type.startsWith("image/"));
  if (!candidates.length) {
    imageError.value = "剪贴板里没有可粘贴的图片。";
    return;
  }
  imageBusy.value = true;
  imageError.value = "";
  const replaced = (draft.value.images?.length || 0) > 0;
  try {
    const shot = await shrinkShot(candidates[0], 1);
    (draft.value.images ??= []).splice(0, draft.value.images.length, shot);
    edited();
    notify(replaced ? "已用新截图替换原截图" : "已加入截图，导出 Word 时自动带上");
  } catch (e) {
    imageError.value = e instanceof Error ? e.message : String(e);
  } finally {
    imageBusy.value = false;
  }
}
function clipboardShots(event: ClipboardEvent) {
  return Array.from(event.clipboardData?.items || [])
    .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
    .map((item) => item.getAsFile())
    .filter((file): file is File => !!file);
}
function onPaste(event: ClipboardEvent) {
  const files = clipboardShots(event);
  if (!files.length) return;
  event.preventDefault();
  void addShots(files);
}
function pasteEverywhere(event: ClipboardEvent) {
  if (event.defaultPrevented || !clipboardShots(event).length) return;
  onPaste(event);
}
function guardDrag(event: DragEvent) {
  if (event.dataTransfer?.types.includes("Files")) event.preventDefault();
}
function dropEverywhere(event: DragEvent) {
  if (event.defaultPrevented) return;
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  event.preventDefault();
  void addShots(files);
}
function onDrop(event: DragEvent) {
  const files = Array.from(event.dataTransfer?.files || []);
  if (!files.length) return;
  event.preventDefault();
  event.stopPropagation();
  void addShots(files);
}
function pickShots() {
  imageInput.value?.click();
}
function onPickShots(event: Event) {
  const input = event.target as HTMLInputElement;
  void addShots(Array.from(input.files || []));
  input.value = "";
}
function removeShot(shotId: string) {
  if (!draft.value?.images) return;
  draft.value.images = draft.value.images.filter((i) => i.id !== shotId);
  imageError.value = "";
  edited();
}
async function exportFile() {
  await attempt(async () => {
    await flush();
    const result = await call("monthly.export", {
      month: month.value,
    });
    notify(result ? "文件已写入：" + result.path : "已取消导出");
  });
}
</script>
<template>
  <div class="monthly-page">
  <div class="toolbar">
    <input
      type="month"
      :value="month"
      aria-label="月报月份"
      @change="changeMonth"
    /><span
      v-if="saveState"
      class="save-state"
      :class="stateClass"
      role="status"
      >{{ saveState }}</span
    >
    <div class="row push-right">
      <button class="primary" :disabled="!draft" @click="exportFile()">
        导出 Word
      </button>
    </div>
  </div>
  <div v-if="draft" class="monthly-layout">
    <section>
      <div class="section-head">
        <h2>本月素材</h2>
        <button class="link small" @click="load(false)">刷新</button>
      </div>
      <div v-if="materials.length" class="material-select-all">
        <label>
          <input
            type="checkbox"
            :checked="allSelected"
            :indeterminate="someSelected"
            :disabled="!selectableMaterials.length"
            aria-label="全选本月素材"
            @change="toggleAll"
          />
          <span
            >全选<small class="muted"
              >{{ selected.length }} / {{ selectableMaterials.length }}</small
            ></span
          >
        </label>
      </div>
      <p v-if="!materials.length" class="empty compact">
        本月还没有日期明确的工作记录。
      </p>
      <div v-for="n in materials" :key="n.id" class="material">
        <label
          ><span
            v-if="linked.has(n.id)"
            class="material-check"
            aria-hidden="true"
            ><Icon name="check" :size="13" /></span
          ><input
            v-else
            v-model="selected"
            type="checkbox"
            :value="n.id"
          /><span
            ><time class="date">{{ n.happenedOn }}</time
            >{{ n.text }}</span
          ></label
        >
      </div>
      <div v-if="materials.length" class="material-actions">
        <label class="field-stack"
          ><select v-model="section" aria-label="放入章节" title="放入章节">
            <option v-for="s in sections" :key="s">{{ s }}</option>
          </select></label
        ><button
          class="primary"
          :disabled="!selected.length"
          @click="addSources"
        >
          {{ selected.length ? "加入正文 " + selected.length : "加入正文" }}
        </button>
      </div>
      <p v-if="undated" class="inline-note warn">
        {{ undated }} 条工作记录日期待补充，尚未计入本月。<button
          class="link"
          @click="navigate('work', { tab: 'undated' })"
        >
          去补日期 →
        </button>
      </p>
    </section>
    <section>
      <h2 class="doc-first">一、工作成果</h2>
      <div class="shot-block">
        <ul v-if="images.length" class="shot-list">
          <li v-for="shot in images" :key="shot.id" class="shot-item">
            <img :src="shotUrls.get(shot.id)" :alt="shot.name" />
            <button
              class="shot-remove"
              aria-label="移除截图"
              title="移除这张截图"
              @click="removeShot(shot.id)"
            >
              <Icon name="close" :size="12" />
            </button>
          </li>
        </ul>
        <div
          v-else
          class="shot-zone"
          :class="{ busy: imageBusy }"
          tabindex="0"
          aria-label="粘贴钉钉工作内容汇总截图"
          @paste="onPaste"
          @dragover.prevent
          @drop="onDrop"
        >
          <span class="shot-hint"
            ><Icon name="image" :size="15" /><span v-if="imageBusy"
              >正在处理截图…</span
            ><span v-else>粘贴钉钉「工作内容汇总」截图</span></span
          >
          <small class="shot-tip"
            >页面任意位置 Ctrl+V 或拖入图片，导出 Word 会自动带上，不用再手工排版。</small
          >
          <button class="link small" @click="pickShots">选择图片…</button>
        </div>
        <p v-if="imageError" class="inline-note warn">{{ imageError }}</p>
        <input
          ref="imageInput"
          class="shot-input"
          type="file"
          accept="image/*"
          aria-hidden="true"
          tabindex="-1"
          @change="onPickShots"
        />
      </div>
      <template v-for="(s, index) in sections" :key="s">
        <h3 v-if="index < 2">{{ index + 1 }}. {{ s }}</h3>
        <h2 v-else class="section-rule">
          {{ index === 2 ? "二、" : index === 3 ? "三、" : "四、" }}{{ s }}
        </h2>
        <div
          v-for="e in draft.entries.filter((e) => e.section === s)"
          :key="e.id"
          class="monthly-entry"
        >
          <textarea
            v-model="e.text"
            rows="1"
            :aria-label="s + '正文'"
            placeholder="在此人工编辑正文…"
            @input="edited"
          />
          <div class="row">
            <small class="muted">{{
              e.manual ? "手动补充" : "来源 " + e.sourceIds.length + " 条"
            }}</small
            ><select
              v-model="e.section"
              aria-label="调整条目章节"
              @change="edited"
            >
              <option v-for="section in sections" :key="section">
                {{ section }}
              </option></select
            ><button aria-label="上移条目" @click="move(e.id, -1)">↑</button
            ><button aria-label="下移条目" @click="move(e.id, 1)">↓</button
            ><button class="danger text-button" @click="remove(e.id)">
              移除
            </button>
          </div>
        </div>
        <p
          v-if="!draft.entries.some((e) => e.section === s)"
          class="small muted"
        >
          留空待填写。
        </p>
        <button class="link small" @click="addManual(s)">
          ＋ 手动补充
        </button></template
      >
    </section>
  </div>
  <p v-else-if="loading" class="loading">正在读取月报草稿…</p>
  <div v-else class="empty">
    <span class="empty-icon"><Icon name="chart" :size="16" /></span>
    <p class="empty-title">暂时没有月报草稿</p>
    <p class="empty-hint">重新选择月份，或稍后重试读取。</p>
    <button class="link" @click="load()">重新读取</button>
  </div>
  </div>
</template>

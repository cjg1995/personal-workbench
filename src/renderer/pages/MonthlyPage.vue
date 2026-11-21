<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
} from "vue";
import type {
  MonthlyDraft,
  MonthlyEntry,
  MonthlyImage,
  Note,
} from "../../shared/types";
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
import { formatMonthDay, formatMonthTitle, splitNoteText } from "../format";
import Icon from "../components/Icon.vue";

const month = ref(context.value.month || model.today.slice(0, 7)),
  draft = ref<MonthlyDraft | null>(null),
  materials = ref<Note[]>([]),
  undated = ref(0),
  selected = ref<string[]>([]),
  section = ref("其他"),
  saveState = ref(""),
  dirty = ref(false),
  loading = ref(true),
  editingEntryId = ref<string | null>(null),
  entryMenuId = ref<string | null>(null),
  monthPickerOpen = ref(false),
  pickerYear = ref(Number(month.value.slice(0, 4)) || new Date().getFullYear());

const imageInput = ref<HTMLInputElement | null>(null),
  imageBusy = ref(false),
  imageError = ref("");
const maxImageWidth = 1240;

const monthTitle = computed(() => formatMonthTitle(month.value));
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
const linkedInMonthCount = computed(
  () => materials.value.filter((n) => linked.value.has(n.id)).length,
);

const stateClass = computed(() =>
  saveState.value.includes("失败")
    ? "error"
    : saveState.value.includes("待保存") ||
        saveState.value.includes("新修改") ||
        saveState.value.includes("保存中")
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

function toggleMaterial(note: Note) {
  if (linked.value.has(note.id)) return;
  selected.value = selected.value.includes(note.id)
    ? selected.value.filter((id) => id !== note.id)
    : [...selected.value, note.id];
}

function entriesIn(sec: string): MonthlyEntry[] {
  return draft.value?.entries.filter((e) => e.section === sec) || [];
}

function entrySourceLabel(entry: MonthlyEntry): string {
  if (entry.manual || !entry.sourceIds.length) return "手动补充";
  const found = entry.sourceIds
    .map(
      (id) =>
        materials.value.find((m) => m.id === id) ||
        model.notes.find((n) => n.id === id),
    )
    .filter((n): n is Note => !!n);
  if (found.length === 1 && found[0].happenedOn) {
    return `来源于 ${formatMonthDay(found[0].happenedOn, false)}工作记录`;
  }
  if (found.length > 1) {
    const firstDate = found.find((n) => !!n.happenedOn)?.happenedOn;
    return firstDate
      ? `来源于 ${entry.sourceIds.length} 条工作记录（${formatMonthDay(firstDate, false)}等）`
      : `来源于 ${entry.sourceIds.length} 条工作记录`;
  }
  return `来源于 ${entry.sourceIds.length} 条工作记录`;
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

function closePopovers() {
  entryMenuId.value = null;
  monthPickerOpen.value = false;
}

onBeforeUnmount(() => {
  unmounted = true;
  setGuard(null);
  if (timer) clearTimeout(timer);
  document.removeEventListener("paste", pasteEverywhere);
  document.removeEventListener("dragover", guardDrag);
  document.removeEventListener("drop", dropEverywhere);
  window.removeEventListener("click", closePopovers);
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
      saveState.value = draft.value!.entries.length ? "草稿已保存" : "";
      selected.value = [];
      editingEntryId.value = null;
      entryMenuId.value = null;
    }
  });
  loading.value = false;
}

onMounted(() => {
  document.addEventListener("paste", pasteEverywhere);
  document.addEventListener("dragover", guardDrag);
  document.addEventListener("drop", dropEverywhere);
  window.addEventListener("click", closePopovers);
  void load();
});

async function selectMonthValue(next: string) {
  if (!next || next === month.value) {
    monthPickerOpen.value = false;
    return;
  }
  if (!(await guard())) return;
  month.value = next;
  pickerYear.value = Number(next.slice(0, 4)) || pickerYear.value;
  monthPickerOpen.value = false;
  await load();
}

async function changeMonthInput(event: Event) {
  const input = event.target as HTMLInputElement;
  const next = input.value;
  if (!next) return;
  if (!(await guard())) {
    input.value = month.value;
    return;
  }
  month.value = next;
  pickerYear.value = Number(next.slice(0, 4)) || pickerYear.value;
  monthPickerOpen.value = false;
  await load();
}

function toggleMonthPicker() {
  if (!monthPickerOpen.value) {
    pickerYear.value =
      Number(month.value.slice(0, 4)) || new Date().getFullYear();
  }
  monthPickerOpen.value = !monthPickerOpen.value;
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

async function addManual(targetSection: string) {
  if (!draft.value) return;
  const id = crypto.randomUUID();
  draft.value.entries.push({
    id,
    section: targetSection,
    text: "",
    sourceIds: [],
    sourceVersions: {},
    manual: true,
  });
  editingEntryId.value = id;
  edited();
  await nextTick();
  document
    .querySelector<HTMLTextAreaElement>(`[data-entry-id="${id}"] textarea`)
    ?.focus();
}

async function startEditEntry(id: string) {
  editingEntryId.value = id;
  entryMenuId.value = null;
  await nextTick();
  document
    .querySelector<HTMLTextAreaElement>(`[data-entry-id="${id}"] textarea`)
    ?.focus();
}

function toggleEditEntry(id: string) {
  if (editingEntryId.value === id) {
    editingEntryId.value = null;
  } else {
    void startEditEntry(id);
  }
}

function toggleEntryMenu(id: string) {
  entryMenuId.value = entryMenuId.value === id ? null : id;
}

function moveInSection(entry: MonthlyEntry, delta: number) {
  if (!draft.value) return;
  const list = draft.value.entries;
  const sameSectionIndices: number[] = [];
  list.forEach((item, idx) => {
    if (item.section === entry.section) sameSectionIndices.push(idx);
  });
  const pos = sameSectionIndices.findIndex(
    (idx) => list[idx].id === entry.id,
  );
  const targetPos = pos + delta;
  if (pos < 0 || targetPos < 0 || targetPos >= sameSectionIndices.length)
    return;
  const i = sameSectionIndices[pos],
    j = sameSectionIndices[targetPos];
  [list[i], list[j]] = [list[j], list[i]];
  edited();
  entryMenuId.value = null;
}

function canMoveInSection(entry: MonthlyEntry, delta: number) {
  const list = entriesIn(entry.section);
  const idx = list.findIndex((item) => item.id === entry.id);
  return idx >= 0 && idx + delta >= 0 && idx + delta < list.length;
}

async function remove(entryId: string) {
  if (!draft.value) return;
  entryMenuId.value = null;
  if (
    !(await confirm(
      "删除月报条目",
      "只从当前月报正文中删除此条，不删除原始工作记录。",
      "删除条目",
    ))
  )
    return;
  draft.value.entries = draft.value.entries.filter((e) => e.id !== entryId);
  if (editingEntryId.value === entryId) editingEntryId.value = null;
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
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("当前环境无法处理图片");
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
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
    notify(
      replaced ? "已用新截图替换原截图" : "已加入截图，导出 Word 时自动带上",
    );
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

const majorSections = [
  { key: sections[2], heading: "二、个人学习和成长" },
  { key: sections[3], heading: "三、个人工作计划、学习目标" },
  { key: sections[4], heading: "四、部门工作中存在问题及改进建议" },
];
</script>

<template>
  <div class="monthly-page">
    <div class="page-head">
      <div>
        <h1>月度总结</h1>
        <div class="h-meta">
          <span>{{ materials.length }} 条工作素材</span>
          <i class="sep-dot" aria-hidden="true" />
          <span>{{ linkedInMonthCount }} 条已加入正文</span>
        </div>
      </div>

      <div class="h-actions month-actions">
        <span
          v-if="saveState"
          class="saved"
          :class="stateClass"
          role="status"
        >
          <Icon
            :name="
              stateClass === 'error'
                ? 'warning'
                : stateClass === 'pending'
                  ? 'clock'
                  : 'check-circle'
            "
            :size="14"
          />
          <span>{{ saveState }}</span>
        </span>

        <div class="month-btn-wrap" @click.stop>
          <button
            type="button"
            class="btn"
            aria-label="选择月报月份"
            :aria-expanded="monthPickerOpen"
            @click="toggleMonthPicker"
          >
            <Icon name="calendar2" :size="15" />
            <span>{{ monthTitle.label }}</span>
            <Icon name="down" :size="12" />
          </button>

          <div
            v-if="monthPickerOpen"
            class="month-popover right"
            role="dialog"
            aria-label="切换月报月份"
          >
            <div class="month-popover-head">
              <button
                type="button"
                class="icon-btn small blank"
                aria-label="上一年"
                @click="pickerYear--"
              >
                <Icon name="arrow-left" :size="13" />
              </button>
              <strong>{{ pickerYear }} 年</strong>
              <button
                type="button"
                class="icon-btn small blank"
                aria-label="下一年"
                @click="pickerYear++"
              >
                <Icon name="arrow-right" :size="13" />
              </button>
            </div>
            <div class="month-popover-grid">
              <button
                v-for="m in 12"
                :key="m"
                type="button"
                :class="{
                  active:
                    month === `${pickerYear}-${String(m).padStart(2, '0')}`,
                }"
                @click="
                  selectMonthValue(
                    `${pickerYear}-${String(m).padStart(2, '0')}`,
                  )
                "
              >
                {{ m }} 月
              </button>
            </div>
            <div class="month-popover-foot">
              <input
                type="month"
                class="month-native-input"
                :value="month"
                aria-label="月报月份"
                @change="changeMonthInput"
              />
              <button
                type="button"
                class="text-action"
                @click="selectMonthValue(model.today.slice(0, 7))"
              >
                本月
              </button>
            </div>
          </div>
        </div>

        <button
          type="button"
          class="btn primary"
          :disabled="!draft"
          @click="exportFile()"
        >
          <Icon name="download" :size="15" />导出 Word
        </button>
      </div>
    </div>

    <div v-if="draft" class="duo monthly-layout">
      <!-- 左栏：本月素材 -->
      <section class="card pane">
        <div class="panel-head">
          <div class="head-title">
            <Icon name="stack" :size="17" />
            <h2>本月素材</h2>
            <span class="count">{{ materials.length }}</span>
          </div>
          <button
            type="button"
            class="icon-btn blank"
            title="刷新素材"
            aria-label="刷新素材"
            @click="load(false)"
          >
            <Icon name="refresh" :size="15" />
          </button>
        </div>

        <div v-if="materials.length" class="all-materials">
          <label>
            <input
              type="checkbox"
              :checked="allSelected"
              :indeterminate="someSelected"
              :disabled="!selectableMaterials.length"
              aria-label="全选可用素材"
              @change="toggleAll"
            />
            <span>全选可用素材</span>
          </label>
          <span class="push" />
          <span>已选 {{ selected.length }} / {{ selectableMaterials.length }}</span>
        </div>

        <div v-if="undated" class="material-undated">
          <span>{{ undated }} 条记录缺少日期，未计入本月</span>
          <button
            type="button"
            class="text-action"
            @click="navigate('work', { month: '' })"
          >
            查看全部记录
          </button>
        </div>

        <div class="material-list">
          <div v-if="!materials.length" class="empty" style="margin: auto">
            <span class="empty-icon"><Icon name="stack" :size="16" /></span>
            <p class="empty-title">{{ monthTitle.label }}暂无可用素材</p>
            <p class="empty-hint">带有发生日期的工作记录会自动汇总到这里。</p>
          </div>

          <div
            v-for="n in materials"
            :key="n.id"
            class="material-item material"
            :class="{
              sel: selected.includes(n.id),
              linked: linked.has(n.id),
            }"
            @click="toggleMaterial(n)"
          >
            <span
              v-if="linked.has(n.id)"
              class="check-mark linked"
              title="已加入正文"
              aria-label="已加入正文"
            >
              <Icon name="check" :size="11" />
            </span>
            <input
              v-else
              v-model="selected"
              type="checkbox"
              :value="n.id"
              :aria-label="'选择素材 ' + splitNoteText(n.text).title"
              @click.stop
            />
            <div class="grow">
              <div class="date">
                <span>{{ formatMonthDay(n.happenedOn, true) }}</span>
                <span v-if="linked.has(n.id)" class="tag live">已加入正文</span>
              </div>
              <strong>{{ splitNoteText(n.text).title }}</strong>
              <p v-if="splitNoteText(n.text).body">
                {{ splitNoteText(n.text).body }}
              </p>
            </div>
          </div>
        </div>

        <div class="material-foot">
          <span class="section-label">加入章节</span>
          <div class="row">
            <select
              v-model="section"
              aria-label="放入章节"
              :title="section"
            >
              <option v-for="s in sections" :key="s" :value="s">
                {{ s }}
              </option>
            </select>
            <button
              type="button"
              class="btn light-brand"
              :disabled="!selected.length"
              @click="addSources"
            >
              <Icon name="plus" :size="13" />
              {{
                selected.length ? `加入正文 · ${selected.length}` : "加入正文"
              }}
            </button>
          </div>
        </div>
      </section>

      <!-- 右栏：文档式正文纸面编辑区 -->
      <div class="card paper-desk">
        <article class="paper">
          <div class="doc-heading">
            <div>
              <div class="doc-date">{{ monthTitle.label }}</div>
              <h2>工作总结</h2>
            </div>
            <Icon name="document" :size="29" />
          </div>

          <!-- 一、工作成果 -->
          <section>
            <div class="doc-section-head">
              <b>一、工作成果</b>
            </div>

            <!-- 截图区 -->
            <div class="shot-block">
              <ul v-if="images.length" class="shot-list">
                <li v-for="shot in images" :key="shot.id" class="shot-item">
                  <img :src="shotUrls.get(shot.id)" :alt="shot.name" />
                  <button
                    type="button"
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
                class="drop-zone"
                :class="{ busy: imageBusy }"
                tabindex="0"
                aria-label="粘贴钉钉工作内容汇总截图"
                @paste="onPaste"
                @dragover.prevent
                @drop="onDrop"
              >
                <div class="drop-icon"><Icon name="image" :size="20" /></div>
                <div>
                  <b>{{
                    imageBusy ? "正在处理截图…" : "钉钉「工作内容汇总」截图"
                  }}</b>
                  <small>按 Ctrl + V 粘贴或拖入，导出 Word 时随正文附上。</small>
                </div>
                <span class="push" />
                <button
                  type="button"
                  class="text-action"
                  @click="pickShots"
                >
                  <Icon name="plus" :size="11" />选择图片
                </button>
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

            <!-- 1. 主要工作 / 2. 其他 -->
            <template v-for="(s, idx) in sections.slice(0, 2)" :key="s">
              <div class="doc-section-head minor">
                <b>{{ idx + 1 }}. {{ s }}</b>
                <button
                  type="button"
                  class="text-action"
                  @click="addManual(s)"
                >
                  <Icon name="plus" :size="11" />手动补充
                </button>
              </div>

              <div
                v-for="e in entriesIn(s)"
                :key="e.id"
                :data-entry-id="e.id"
                class="doc-entry monthly-entry"
              >
                <template v-if="editingEntryId === e.id || !e.text.trim()">
                  <textarea
                    v-model="e.text"
                    rows="2"
                    :aria-label="s + '正文'"
                    placeholder="在此人工编辑正文…"
                    @input="edited"
                  />
                  <div class="entry-inline-controls">
                    <select
                      v-model="e.section"
                      aria-label="调整条目章节"
                      @change="edited"
                    >
                      <option v-for="sec in sections" :key="sec" :value="sec">
                        {{ sec }}
                      </option>
                    </select>
                    <button
                      type="button"
                      class="btn compact"
                      aria-label="上移条目"
                      :disabled="!canMoveInSection(e, -1)"
                      @click="moveInSection(e, -1)"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      class="btn compact"
                      aria-label="下移条目"
                      :disabled="!canMoveInSection(e, 1)"
                      @click="moveInSection(e, 1)"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      class="delete-action"
                      @click="remove(e.id)"
                    >
                      移除
                    </button>
                    <button
                      v-if="e.text.trim()"
                      type="button"
                      class="btn light-brand compact push"
                      @click="editingEntryId = null"
                    >
                      完成编辑
                    </button>
                  </div>
                </template>

                <template v-else>
                  <p class="doc-entry-text" @click="startEditEntry(e.id)">
                    {{ e.text }}
                  </p>
                </template>

                <div class="source-note">
                  <Icon :name="e.manual ? 'penbox' : 'link'" :size="11" />
                  <span>{{ entrySourceLabel(e) }}</span>
                  <span class="entry-tools" @click.stop>
                    <button
                      type="button"
                      class="text-action"
                      @click="toggleEditEntry(e.id)"
                    >
                      <Icon name="penbox" :size="11" />
                      {{ editingEntryId === e.id ? "收起编辑" : "编辑条目" }}
                    </button>
                    <button
                      type="button"
                      class="icon-btn small blank"
                      aria-label="更多条目操作"
                      title="调整章节、排序或移除"
                      @click="toggleEntryMenu(e.id)"
                    >
                      <Icon name="more" :size="14" />
                    </button>
                    <div
                      v-if="entryMenuId === e.id"
                      class="entry-menu"
                      role="menu"
                    >
                      <div class="entry-menu-section">
                        <small>目标章节</small>
                        <select
                          v-model="e.section"
                          aria-label="调整条目章节"
                          @change="edited"
                        >
                          <option
                            v-for="sec in sections"
                            :key="sec"
                            :value="sec"
                          >
                            {{ sec }}
                          </option>
                        </select>
                      </div>
                      <button
                        type="button"
                        role="menuitem"
                        :disabled="!canMoveInSection(e, -1)"
                        @click="moveInSection(e, -1)"
                      >
                        <Icon name="up" :size="12" />上移条目
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        :disabled="!canMoveInSection(e, 1)"
                        @click="moveInSection(e, 1)"
                      >
                        <Icon name="down" :size="12" />下移条目
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        class="danger-item"
                        @click="remove(e.id)"
                      >
                        <Icon name="trash" :size="12" />从正文移除
                      </button>
                    </div>
                  </span>
                </div>
              </div>
            </template>
          </section>

          <!-- 二、三、四章节 -->
          <template v-for="sec in majorSections" :key="sec.key">
            <div v-if="!entriesIn(sec.key).length" class="empty-doc-row">
              <div class="doc-section-head">
                <b>{{ sec.heading }}</b>
              </div>
              <button
                type="button"
                class="text-action"
                @click="addManual(sec.key)"
              >
                <Icon name="plus" :size="11" />手动补充
              </button>
            </div>

            <section v-else class="doc-section-block">
              <div class="doc-section-head">
                <b>{{ sec.heading }}</b>
                <button
                  type="button"
                  class="text-action"
                  @click="addManual(sec.key)"
                >
                  <Icon name="plus" :size="11" />手动补充
                </button>
              </div>

              <div
                v-for="e in entriesIn(sec.key)"
                :key="e.id"
                :data-entry-id="e.id"
                class="doc-entry monthly-entry"
              >
                <template v-if="editingEntryId === e.id || !e.text.trim()">
                  <textarea
                    v-model="e.text"
                    rows="2"
                    :aria-label="sec.key + '正文'"
                    placeholder="在此人工编辑正文…"
                    @input="edited"
                  />
                  <div class="entry-inline-controls">
                    <select
                      v-model="e.section"
                      aria-label="调整条目章节"
                      @change="edited"
                    >
                      <option v-for="sOpt in sections" :key="sOpt" :value="sOpt">
                        {{ sOpt }}
                      </option>
                    </select>
                    <button
                      type="button"
                      class="btn compact"
                      aria-label="上移条目"
                      :disabled="!canMoveInSection(e, -1)"
                      @click="moveInSection(e, -1)"
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      class="btn compact"
                      aria-label="下移条目"
                      :disabled="!canMoveInSection(e, 1)"
                      @click="moveInSection(e, 1)"
                    >
                      ↓
                    </button>
                    <button
                      type="button"
                      class="delete-action"
                      @click="remove(e.id)"
                    >
                      移除
                    </button>
                    <button
                      v-if="e.text.trim()"
                      type="button"
                      class="btn light-brand compact push"
                      @click="editingEntryId = null"
                    >
                      完成编辑
                    </button>
                  </div>
                </template>
                <template v-else>
                  <p class="doc-entry-text" @click="startEditEntry(e.id)">
                    {{ e.text }}
                  </p>
                </template>

                <div class="source-note">
                  <Icon :name="e.manual ? 'penbox' : 'link'" :size="11" />
                  <span>{{ entrySourceLabel(e) }}</span>
                  <span class="entry-tools" @click.stop>
                    <button
                      type="button"
                      class="text-action"
                      @click="toggleEditEntry(e.id)"
                    >
                      <Icon name="penbox" :size="11" />
                      {{ editingEntryId === e.id ? "收起编辑" : "编辑条目" }}
                    </button>
                    <button
                      type="button"
                      class="icon-btn small blank"
                      aria-label="更多条目操作"
                      title="调整章节、排序或移除"
                      @click="toggleEntryMenu(e.id)"
                    >
                      <Icon name="more" :size="14" />
                    </button>
                    <div
                      v-if="entryMenuId === e.id"
                      class="entry-menu"
                      role="menu"
                    >
                      <div class="entry-menu-section">
                        <small>目标章节</small>
                        <select
                          v-model="e.section"
                          aria-label="调整条目章节"
                          @change="edited"
                        >
                          <option
                            v-for="sOpt in sections"
                            :key="sOpt"
                            :value="sOpt"
                          >
                            {{ sOpt }}
                          </option>
                        </select>
                      </div>
                      <button
                        type="button"
                        role="menuitem"
                        :disabled="!canMoveInSection(e, -1)"
                        @click="moveInSection(e, -1)"
                      >
                        <Icon name="up" :size="12" />上移条目
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        :disabled="!canMoveInSection(e, 1)"
                        @click="moveInSection(e, 1)"
                      >
                        <Icon name="down" :size="12" />下移条目
                      </button>
                      <button
                        type="button"
                        role="menuitem"
                        class="danger-item"
                        @click="remove(e.id)"
                      >
                        <Icon name="trash" :size="12" />从正文移除
                      </button>
                    </div>
                  </span>
                </div>
              </div>
            </section>
          </template>
        </article>
      </div>
    </div>

    <p v-else-if="loading" class="loading">正在读取月报草稿…</p>
    <div v-else class="card empty" style="flex: 1">
      <span class="empty-icon"><Icon name="report" :size="16" /></span>
      <p class="empty-title">暂时没有月报草稿</p>
      <p class="empty-hint">重新选择月份，或稍后重试读取。</p>
      <button type="button" class="link" @click="load()">重新读取</button>
    </div>
  </div>
</template>

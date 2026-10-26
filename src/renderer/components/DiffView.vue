<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import type { ReviewFile } from "../../shared/types";
const props = defineProps<{ file: ReviewFile; mode: "split" | "unified" }>();
const root = ref<HTMLElement>();
let changeIndex = -1;
const start = ref(0),
  pageSize = 300;
watch(
  () => [props.file, props.mode],
  () => {
    start.value = 0;
    changeIndex = -1;
  },
);
const parsed = computed(() => {
  let old = 0,
    next = 0,
    inHunk = false;
  const unified: any[] = [],
    split: any[] = [],
    removed: any[] = [],
    added: any[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(removed.length, added.length); i++)
      split.push({ old: removed[i], next: added[i], change: true });
    removed.length = 0;
    added.length = 0;
  };
  for (const line of props.file.patch.split("\n")) {
    const match = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (match) {
      flush();
      old = Number(match[1]);
      next = Number(match[2]);
      inHunk = true;
      unified.push({ hunk: line });
      split.push({ hunk: line });
      continue;
    }
    if (!inHunk || line.startsWith("\\")) continue;
    const kind = line[0];
    if (kind === "-") {
      const r = { no: old++, text: line.slice(1), kind: "del" };
      unified.push({ old: r.no, text: r.text, kind: "del" });
      removed.push(r);
    } else if (kind === "+") {
      const r = { no: next++, text: line.slice(1), kind: "add" };
      unified.push({ next: r.no, text: r.text, kind: "add" });
      added.push(r);
    } else if (kind === " ") {
      flush();
      const r = {
        old: { no: old++, text: line.slice(1) },
        next: { no: next++, text: line.slice(1) },
      };
      split.push(r);
      unified.push({
        old: r.old.no,
        next: r.next.no,
        text: line.slice(1),
        kind: "",
      });
    }
  }
  flush();
  return { unified, split };
});
const rows = computed(() =>
  props.mode === "split" ? parsed.value.split : parsed.value.unified,
);
const visibleRows = computed(() =>
  rows.value.slice(start.value, start.value + pageSize),
);
const displayText = (text?: string) =>
  text && text.length > 2000
    ? text.slice(0, 2000) + " …［本行过长，完整内容请在编辑器查看］"
    : text;
async function jump(delta: number) {
  const changes = rows.value
    .map((r, index) => (r.change || r.kind ? index : -1))
    .filter((i) => i >= 0);
  if (!changes.length) return;
  changeIndex = (changeIndex + delta + changes.length) % changes.length;
  const index = changes[changeIndex];
  start.value = Math.floor(index / pageSize) * pageSize;
  await nextTick();
  root.value
    ?.querySelectorAll("tr")
    [index - start.value]?.scrollIntoView({ block: "center" });
}
async function line(side: "old" | "new", number: number) {
  const index = rows.value.findIndex((r) =>
    props.mode === "split"
      ? (side === "old" ? r.old?.no : r.next?.no) === number
      : r[side === "old" ? "old" : "next"] === number,
  );
  if (index < 0) return;
  start.value = Math.floor(index / pageSize) * pageSize;
  await nextTick();
  root.value
    ?.querySelector(`[data-${side}="${number}"]`)
    ?.scrollIntoView({ block: "center" });
}
defineExpose({ jump, line });
</script>
<template>
  <div
    v-if="!file.binary && !file.limited && rows.length > pageSize"
    class="row wrap small"
    style="margin-bottom: 10px"
  >
    <button :disabled="start === 0" @click="start -= pageSize">
      上一页差异
    </button>
    <span
      >第 {{ start + 1 }}–{{ Math.min(start + pageSize, rows.length) }} /
      {{ rows.length }} 行</span
    >
    <button
      :disabled="start + pageSize >= rows.length"
      @click="start += pageSize"
    >
      下一页差异
    </button>
  </div>
  <p v-if="file.binary" class="notice warning">
    二进制文件，不能作为普通文本比较。请在外部工具核对。
  </p>
  <p v-else-if="file.limited" class="notice warning">
    文件或本次快照正文超过内置展示上限。此文件仍在审查范围内，请使用外部工具核对。
  </p>
  <div v-else ref="root" class="diff" tabindex="0" aria-label="只读代码差异">
    <table v-if="mode === 'split'">
      <tbody>
        <template v-for="(row, i) in visibleRows" :key="start + i"
          ><tr v-if="row.hunk">
            <td class="hunk" colspan="4">{{ row.hunk }}</td>
          </tr>
          <tr v-else :data-change="row.change ? 'true' : undefined">
            <td class="line-no" :data-old="row.old?.no">{{ row.old?.no }}</td>
            <td class="code divider" :class="row.old?.kind">
              {{ displayText(row.old?.text) }}
            </td>
            <td class="line-no" :data-new="row.next?.no">{{ row.next?.no }}</td>
            <td class="code" :class="row.next?.kind">
              {{ displayText(row.next?.text) }}
            </td>
          </tr></template
        >
      </tbody>
    </table>
    <table v-else>
      <tbody>
        <tr
          v-for="(row, i) in visibleRows"
          :key="start + i"
          :data-change="row.kind ? 'true' : undefined"
        >
          <td v-if="row.hunk" colspan="3" class="hunk">{{ row.hunk }}</td>
          <template v-else
            ><td class="line-no" :data-old="row.old">{{ row.old }}</td>
            <td class="line-no" :data-new="row.next">{{ row.next }}</td>
            <td class="code" :class="row.kind">
              {{ row.kind === "add" ? "+" : row.kind === "del" ? "-" : " " }}
              {{ displayText(row.text) }}
            </td></template
          >
        </tr>
      </tbody>
    </table>
    <p v-if="!parsed.unified.length" class="empty small">
      没有文本行差异。请核对文件类型、模式或重命名状态。
    </p>
  </div>
</template>

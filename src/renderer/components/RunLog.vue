<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Icon from "./Icon.vue";

const props = defineProps<{ text: string }>();
const root = ref<HTMLElement>();
const logBody = ref<HTMLElement>();
const findInput = ref<HTMLInputElement>();
const findQuery = ref("");
const follow = ref(true);
const matches = ref<{ start: number; end: number }[]>([]);
const index = ref(0);
let keysActive = false;
let sticking = false;
let adjusting = false;
let lastTop = 0;
let observer: ResizeObserver | undefined;

const matchLabel = computed(() => {
  if (!findQuery.value) return "";
  if (!matches.value.length) return "无匹配";
  return `${index.value + 1}/${matches.value.length}`;
});
const parts = computed(() => {
  const text = props.text || "";
  if (!findQuery.value || !matches.value.length)
    return [{ key: "all", text, hit: false, current: false }];
  const current = index.value;
  const items = matches.value;
  let from = 0;
  let to = items.length;
  if (items.length > 2500) {
    from = Math.max(0, current - 80);
    to = Math.min(items.length, from + 160);
    from = Math.max(0, to - 160);
  }
  const out: { key: string; text: string; hit: boolean; current: boolean }[] =
    [];
  let cursor = 0;
  for (let i = from; i < to; i++) {
    const item = items[i];
    if (item.start > cursor)
      out.push({
        key: "t" + cursor,
        text: text.slice(cursor, item.start),
        hit: false,
        current: false,
      });
    out.push({
      key: "h" + item.start,
      text: text.slice(item.start, item.end),
      hit: true,
      current: i === current,
    });
    cursor = item.end;
  }
  if (cursor < text.length)
    out.push({
      key: "t" + cursor,
      text: text.slice(cursor),
      hit: false,
      current: false,
    });
  return out;
});

function collect(text: string, query: string) {
  const found: { start: number; end: number }[] = [];
  if (!query) return found;
  const folded = query.toLowerCase();
  const hay = text.toLowerCase();
  if (folded.length !== query.length || hay.length !== text.length) {
    let from = 0;
    while (from <= text.length - query.length) {
      const at = text.indexOf(query, from);
      if (at < 0) break;
      found.push({ start: at, end: at + query.length });
      from = at + query.length;
    }
    return found;
  }
  let from = 0;
  while (from <= hay.length - folded.length) {
    const at = hay.indexOf(folded, from);
    if (at < 0) break;
    found.push({ start: at, end: at + folded.length });
    from = at + folded.length;
  }
  return found;
}
function syncMatches() {
  matches.value = collect(props.text || "", findQuery.value);
  if (index.value >= matches.value.length) index.value = 0;
}
function setKeys(active: boolean) {
  if (keysActive === active) return;
  keysActive = active;
  try {
    window.workbench.setRunLogKeys(active);
  } catch {
    keysActive = false;
  }
}
function onFocusIn() {
  setKeys(true);
}
function onFocusOut(event: FocusEvent) {
  const next = event.relatedTarget;
  if (next instanceof Node && root.value?.contains(next)) return;
  setTimeout(() => {
    const active = document.activeElement;
    setKeys(!!(active && root.value?.contains(active)));
  }, 0);
}
function onWindowFocus() {
  const active = document.activeElement;
  setKeys(!!(active && root.value?.contains(active)));
}
function stickToBottom() {
  const el = logBody.value;
  if (!el || el.clientHeight === 0) return;
  const next = Math.max(0, el.scrollHeight - el.clientHeight);
  sticking = true;
  el.scrollTop = next;
  lastTop = el.scrollTop;
  sticking = false;
}
function onScroll() {
  const el = logBody.value;
  if (!el) return;
  const top = el.scrollTop;
  if (sticking || adjusting) {
    lastTop = top;
    return;
  }
  const movedUp = top < lastTop - 1;
  const gap = el.scrollHeight - top - el.clientHeight;
  lastTop = top;
  if (follow.value && movedUp && gap > 4) follow.value = false;
}
function jump(toTop: boolean) {
  const el = logBody.value;
  if (!el) return;
  el.scrollTop = toTop ? 0 : Math.max(0, el.scrollHeight - el.clientHeight);
}
function scrollToMatch() {
  const el = logBody.value;
  const mark = el?.querySelector("mark.current");
  if (!el || !(mark instanceof HTMLElement)) return;
  const rect = mark.getBoundingClientRect();
  const box = el.getBoundingClientRect();
  if (rect.top < box.top + 4 || rect.bottom > box.bottom - 4)
    el.scrollTop += rect.top - box.top - Math.max(12, Math.min(72, box.height * 0.3));
  if (el.scrollHeight - el.scrollTop - el.clientHeight > 4) follow.value = false;
}
function focusFind() {
  void nextTick(() => {
    const input = findInput.value;
    if (!input) return;
    input.focus({ preventScroll: true });
    input.select();
  });
}
function step(delta: number) {
  const count = matches.value.length;
  if (!count) return;
  index.value = (index.value + delta + count) % count;
  void nextTick(() => scrollToMatch());
}
function toggleFollow() {
  if (follow.value) {
    follow.value = false;
    return;
  }
  follow.value = true;
  stickToBottom();
}
function onFindKeydown(event: KeyboardEvent) {
  if (event.isComposing || event.key === "Process") return;
  if (event.key !== "Enter" || event.ctrlKey || event.altKey || event.metaKey)
    return;
  event.preventDefault();
  step(event.shiftKey ? -1 : 1);
}
function onWindowKeydown(event: KeyboardEvent) {
  const rootEl = root.value;
  const target = event.target;
  if (!rootEl || !(target instanceof Node) || !rootEl.contains(target)) return;
  if (
    event.key === "Escape" &&
    !event.isComposing &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey &&
    event.target === findInput.value
  ) {
    event.preventDefault();
    event.stopPropagation();
    logBody.value?.focus({ preventScroll: true });
    return;
  }
  if (!event.ctrlKey || event.altKey || event.shiftKey || event.metaKey) return;
  const key = event.key.toLowerCase();
  if (key === "f") {
    event.preventDefault();
    event.stopPropagation();
    focusFind();
    return;
  }
  if (key === "home" || key === "end") {
    event.preventDefault();
    event.stopPropagation();
    jump(key === "home");
  }
}
function onCommand(command: string) {
  if (command === "find") focusFind();
  else if (command === "top") jump(true);
  else if (command === "bottom") jump(false);
}
const stopCommand = window.workbench.onRunLogCommand(onCommand);

watch(findQuery, async () => {
  index.value = 0;
  syncMatches();
  await nextTick();
  if (matches.value.length) scrollToMatch();
});
watch(
  () => props.text,
  async () => {
    const body = logBody.value;
    const hidden = !body || body.clientHeight === 0;
    const shouldStick = follow.value;
    const top = body?.scrollTop ?? 0;
    adjusting = true;
    syncMatches();
    try {
      await nextTick();
      if (hidden || !logBody.value || logBody.value.clientHeight === 0) return;
      if (shouldStick) {
        follow.value = true;
        stickToBottom();
        return;
      }
      const max = Math.max(0, logBody.value.scrollHeight - logBody.value.clientHeight);
      logBody.value.scrollTop = Math.min(top, max);
      lastTop = logBody.value.scrollTop;
    } finally {
      adjusting = false;
    }
  },
);

onMounted(() => {
  window.addEventListener("keydown", onWindowKeydown, true);
  window.addEventListener("focus", onWindowFocus);
  if (logBody.value) {
    observer = new ResizeObserver(() => {
      if (follow.value && logBody.value && logBody.value.clientHeight > 0)
        stickToBottom();
    });
    observer.observe(logBody.value);
  }
  void nextTick(() => {
    logBody.value?.focus({ preventScroll: true });
    requestAnimationFrame(() => {
      if (follow.value) stickToBottom();
    });
  });
});
onBeforeUnmount(() => {
  stopCommand();
  window.removeEventListener("keydown", onWindowKeydown, true);
  window.removeEventListener("focus", onWindowFocus);
  observer?.disconnect();
  if (keysActive) {
    keysActive = false;
    try {
      window.workbench.setRunLogKeys(false);
    } catch {
      /* 日志已关闭 */
    }
  }
});
</script>
<template>
  <div
    ref="root"
    class="run-log"
    role="region"
    aria-label="项目日志"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
  >
    <div class="run-log-bar">
      <div class="run-log-find" role="search">
        <input
          ref="findInput"
          v-model="findQuery"
          type="text"
          aria-label="在日志中查找"
          placeholder="查找日志"
          autocomplete="off"
          spellcheck="false"
          @keydown="onFindKeydown"
        />
        <span class="run-log-count" aria-live="polite">{{ matchLabel }}</span>
        <button
          type="button"
          title="上一处匹配（Shift+Enter）"
          aria-label="上一处匹配"
          :disabled="!matches.length"
          @click="step(-1)"
        >
          <Icon name="chevron" :size="14" class="run-log-icon-up" />
        </button>
        <button
          type="button"
          title="下一处匹配（Enter）"
          aria-label="下一处匹配"
          :disabled="!matches.length"
          @click="step(1)"
        >
          <Icon name="chevron" :size="14" class="run-log-icon-down" />
        </button>
      </div>
      <button
        type="button"
        class="run-log-follow"
        :aria-pressed="follow"
        :title="follow ? '暂停滚动' : '跟随底部'"
        @click="toggleFollow"
      >
        <Icon :name="follow ? 'pause' : 'arrow-down'" :size="14" />
        {{ follow ? "暂停滚动" : "跟随底部" }}
      </button>
    </div>
    <pre
      id="project-run-log"
      ref="logBody"
      class="log"
      tabindex="0"
      aria-label="项目日志内容"
      @scroll="onScroll"
    ><template v-for="part in parts" :key="part.key"><mark v-if="part.hit" class="run-log-hit" :class="{ current: part.current }">{{ part.text }}</mark><template v-else>{{ part.text }}</template></template></pre>
  </div>
</template>

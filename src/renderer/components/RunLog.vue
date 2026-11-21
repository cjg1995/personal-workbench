<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
} from "vue";
import Icon from "./Icon.vue";

const props = withDefaults(
  defineProps<{
    text: string;
    active?: boolean;
    hostLabel?: string;
  }>(),
  { active: true, hostLabel: "" },
);

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

interface Span {
  start: number;
  end: number;
  cls: string;
}

interface RenderPiece {
  text: string;
  cls: string;
  hit: boolean;
  current: boolean;
}

interface RenderLine {
  no: string;
  pieces: RenderPiece[];
}

const tokenCache = new Map<string, Span[]>();
const LOG_TOKEN_RE =
  /(\b\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:[.,]\d{3})?\b|\b\d{2}:\d{2}:\d{2}(?:[.,]\d{3})\b)|(\b(?:INFO|WARN|WARNING|ERROR|FATAL|SEVERE|DEBUG|TRACE)\b)|("(?:[^"\\]|\\.)*")|(https?:\/\/[^\s"'<>]+|\b(?:[a-z][a-z0-9_]*\.){2,}[A-Za-z_][A-Za-z0-9_$.]*\b)|((?:^|(?<=[\s:=(\[,]))\/[A-Za-z0-9_./-]*)|(\b\d+(?:\.\d+)?(?:\s?(?:ms|s|kb|mb|gb|m|k|g|%))?\b)/gi;

function tokenizeLine(line: string): Span[] {
  if (!line) return [];
  const cached = tokenCache.get(line);
  if (cached) return cached;
  const spans: Span[] = [];
  if (line.length <= 2000) {
    LOG_TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = LOG_TOKEN_RE.exec(line)) !== null) {
      const start = m.index;
      const end = start + m[0].length;
      if (end <= start) {
        LOG_TOKEN_RE.lastIndex = start + 1;
        continue;
      }
      let cls = "";
      if (m[1]) cls = "time";
      else if (m[2]) {
        const up = m[2].toUpperCase();
        cls =
          up === "ERROR" || up === "FATAL" || up === "SEVERE"
            ? "level-error"
            : up === "WARN" || up === "WARNING"
              ? "level-warn"
              : up === "DEBUG" || up === "TRACE"
                ? "level-debug"
                : "level";
      } else if (m[3]) {
        const after = line.slice(end).trimStart();
        cls = after.startsWith(":")
          ? "val"
          : /^[a-z0-9_.-]+\.[a-z0-9_.-]+/i.test(m[3].slice(1, -1)) ||
              /^\d+\.\d+\.\d+\.\d+$/.test(m[3].slice(1, -1))
            ? "path"
            : "val";
      } else if (m[4]) {
        cls = "path";
      } else if (m[5]) {
        cls = "val";
      } else if (m[6]) {
        cls = "num";
      }
      if (cls) spans.push({ start, end, cls });
    }
  }
  if (tokenCache.size > 4000) tokenCache.clear();
  tokenCache.set(line, spans);
  return spans;
}

function buildLinePieces(
  line: string,
  lineStart: number,
  lineMatches: { start: number; end: number; current: boolean }[],
): RenderPiece[] {
  if (!line) return [{ text: " ", cls: "", hit: false, current: false }];
  const syntax = tokenizeLine(line);
  if (!lineMatches.length) {
    if (!syntax.length)
      return [{ text: line, cls: "", hit: false, current: false }];
    const pieces: RenderPiece[] = [];
    let pos = 0;
    for (const s of syntax) {
      if (s.start > pos)
        pieces.push({
          text: line.slice(pos, s.start),
          cls: "",
          hit: false,
          current: false,
        });
      pieces.push({
        text: line.slice(s.start, s.end),
        cls: s.cls,
        hit: false,
        current: false,
      });
      pos = s.end;
    }
    if (pos < line.length)
      pieces.push({
        text: line.slice(pos),
        cls: "",
        hit: false,
        current: false,
      });
    return pieces;
  }

  const cuts = new Set<number>([0, line.length]);
  for (const s of syntax) {
    cuts.add(s.start);
    cuts.add(s.end);
  }
  const relMatches = lineMatches.map((m) => ({
    start: Math.max(0, m.start - lineStart),
    end: Math.min(line.length, m.end - lineStart),
    current: m.current,
  }));
  for (const m of relMatches) {
    cuts.add(m.start);
    cuts.add(m.end);
  }
  const sorted = Array.from(cuts).sort((a, b) => a - b);
  const pieces: RenderPiece[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i],
      b = sorted[i + 1];
    if (b <= a) continue;
    const syn = syntax.find((s) => s.start <= a && s.end >= b);
    const hit = relMatches.find((m) => m.start <= a && m.end >= b);
    pieces.push({
      text: line.slice(a, b),
      cls: syn?.cls || "",
      hit: !!hit,
      current: !!hit?.current,
    });
  }
  return pieces;
}

const matchLabel = computed(() => {
  if (!findQuery.value) return "";
  if (!matches.value.length) return "无匹配";
  return `${index.value + 1}/${matches.value.length}`;
});

const rawLines = computed(() => {
  const text = props.text || "";
  if (!text) return [];
  const list = text.split(/\r?\n/);
  if (list.length > 1 && list[list.length - 1] === "") list.pop();
  return list;
});

const renderedLines = computed<RenderLine[]>(() => {
  const text = props.text || "";
  if (!text) return [];
  const allMatches = findQuery.value ? matches.value : [];
  const currentIdx = index.value;
  let activeMatches: { start: number; end: number; current: boolean }[] = [];
  if (allMatches.length) {
    let from = 0;
    let to = allMatches.length;
    if (allMatches.length > 2500) {
      from = Math.max(0, currentIdx - 80);
      to = Math.min(allMatches.length, from + 160);
      from = Math.max(0, to - 160);
    }
    activeMatches = allMatches.slice(from, to).map((m, idx) => ({
      start: m.start,
      end: m.end,
      current: from + idx === currentIdx,
    }));
  }

  const lines: RenderLine[] = [];
  const totalLines = rawLines.value.length;
  const padWidth = Math.max(2, String(totalLines).length);
  let cursor = 0;
  let mPtr = 0;
  let lineNo = 0;

  while (cursor <= text.length) {
    const nl = text.indexOf("\n", cursor);
    const end = nl < 0 ? text.length : nl;
    const rawLine =
      end > cursor && text[end - 1] === "\r"
        ? text.slice(cursor, end - 1)
        : text.slice(cursor, end);
    if (nl < 0 && rawLine === "" && lineNo > 0) break;
    lineNo++;
    while (
      mPtr < activeMatches.length &&
      activeMatches[mPtr].end <= cursor
    ) {
      mPtr++;
    }
    const lineHits: { start: number; end: number; current: boolean }[] = [];
    for (
      let j = mPtr;
      j < activeMatches.length && activeMatches[j].start < end;
      j++
    ) {
      lineHits.push(activeMatches[j]);
    }
    lines.push({
      no: String(lineNo).padStart(padWidth, "0"),
      pieces: buildLinePieces(rawLine, cursor, lineHits),
    });
    if (nl < 0) break;
    cursor = nl + 1;
  }
  return lines;
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
    el.scrollTop +=
      rect.top - box.top - Math.max(12, Math.min(72, box.height * 0.3));
  if (el.scrollHeight - el.scrollTop - el.clientHeight > 4)
    follow.value = false;
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
      const max = Math.max(
        0,
        logBody.value.scrollHeight - logBody.value.clientHeight,
      );
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
  <section
    ref="root"
    class="terminal run-log"
    role="region"
    aria-label="项目日志"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
  >
    <div class="term-head">
      <h3>运行日志</h3>
      <span class="live-light" :class="{ idle: !active }" />
      <div class="term-find" role="search">
        <label class="search-box" style="margin: 0">
          <Icon name="search" :size="13" />
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
        </label>
        <span v-if="matchLabel" class="term-match-count" aria-live="polite">{{
          matchLabel
        }}</span>
        <button
          type="button"
          class="term-nav-btn"
          title="上一处匹配（Shift+Enter）"
          aria-label="上一处匹配"
          :disabled="!matches.length"
          @click="step(-1)"
        >
          <Icon name="up" :size="13" />
        </button>
        <button
          type="button"
          class="term-nav-btn"
          title="下一处匹配（Enter）"
          aria-label="下一处匹配"
          :disabled="!matches.length"
          @click="step(1)"
        >
          <Icon name="down" :size="13" />
        </button>
        <button
          type="button"
          class="term-control"
          :aria-pressed="follow"
          :title="follow ? '暂停滚动' : '跟随底部'"
          @click="toggleFollow"
        >
          <Icon :name="follow ? 'pause' : 'arrow-down'" :size="12" />
          <span>{{ follow ? "暂停滚动" : "跟随底部" }}</span>
        </button>
      </div>
    </div>

    <div
      id="project-run-log"
      ref="logBody"
      class="term-lines"
      tabindex="0"
      aria-label="项目日志内容"
      @scroll="onScroll"
    >
      <template v-if="renderedLines.length">
        <div
          v-for="(line, idx) in renderedLines"
          :key="idx"
          class="logline"
        >
          <span class="n">{{ line.no }}</span>
          <span>
            <template v-for="(piece, pIdx) in line.pieces" :key="pIdx">
              <mark
                v-if="piece.hit"
                class="run-log-hit"
                :class="[{ current: piece.current }, piece.cls]"
                >{{ piece.text }}</mark
              >
              <span v-else-if="piece.cls" :class="piece.cls">{{
                piece.text
              }}</span>
              <template v-else>{{ piece.text }}</template>
            </template>
          </span>
        </div>
      </template>
      <div v-else class="term-empty">
        <span>暂无日志输出，等待进程写入…</span>
      </div>
    </div>

    <div class="term-foot">
      <i class="dot" :class="{ paused: !follow }" />
      <span>{{ follow ? "正在跟随输出" : "已暂停自动滚动" }}</span>
      <span v-if="renderedLines.length" class="muted"
        >· {{ renderedLines.length }} 行</span
      >
      <span class="push" />
      <span v-if="hostLabel" class="mono">{{ hostLabel }}</span>
    </div>
  </section>
</template>

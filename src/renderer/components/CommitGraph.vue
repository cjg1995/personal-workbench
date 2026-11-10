<script setup lang="ts">
import { computed } from "vue";
import type { GitCommit } from "../../shared/git-client";
const props = defineProps<{ commits: GitCommit[]; selected: string }>();
defineEmits<{
  select: [commit: GitCommit];
  menu: [commit: GitCommit, event: MouseEvent];
}>();
const colors = [
  "#6598ed",
  "#72b588",
  "#c192da",
  "#e0ad66",
  "#dd848d",
  "#59b8bb",
];
const rows = computed(() => {
  let lanes: string[] = [];
  return props.commits.map((commit) => {
    if (!lanes.includes(commit.hash)) lanes.push(commit.hash);
    const lane = lanes.indexOf(commit.hash),
      before = [...lanes],
      after = [...lanes];
    after.splice(lane, 1, ...(commit.parents[0] ? [commit.parents[0]] : []));
    for (const parent of commit.parents.slice(1))
      if (!after.includes(parent)) after.splice(lane + 1, 0, parent);
    const unique = [...new Set(after)],
      edges: { from: number; to: number; color: string }[] = [];
    before.forEach((hash, index) => {
      if (index !== lane && unique.includes(hash))
        edges.push({
          from: index,
          to: unique.indexOf(hash),
          color: colors[index % colors.length],
        });
    });
    for (const parent of commit.parents)
      edges.push({
        from: lane,
        to: unique.indexOf(parent),
        color: colors[lane % colors.length],
      });
    lanes = unique;
    return {
      commit,
      lane,
      edges,
      before,
      width: Math.max(3, before.length, unique.length) * 14,
      color: colors[lane % colors.length],
    };
  });
});
</script>
<template>
  <div class="git-log-table">
    <button
      v-for="row in rows"
      :key="row.commit.hash"
      class="git-log-row"
      :class="{ active: selected === row.commit.hash }"
      @click="$emit('select', row.commit)"
      @contextmenu.prevent="$emit('menu', row.commit, $event)"
    >
      <svg :width="row.width" height="36" class="git-graph" aria-hidden="true">
        <path
          v-for="(_, index) in row.before"
          :key="'top-' + index"
          :d="`M ${index * 14 + 8} 0 V ${index === row.lane ? 14 : 18}`"
          :stroke="colors[index % colors.length]"
          stroke-width="1.5"
        />
        <path
          v-for="(edge, i) in row.edges"
          :key="i"
          :d="`M ${edge.from * 14 + 8} 18 C ${edge.from * 14 + 8} 28 ${edge.to * 14 + 8} 26 ${edge.to * 14 + 8} 36`"
          :stroke="edge.color"
          fill="none"
          stroke-width="1.5"
        />
        <circle :cx="row.lane * 14 + 8" cy="18" r="3.5" :fill="row.color" />
      </svg>
      <code>{{ row.commit.hash.slice(0, 8) }}</code
      ><span v-if="row.commit.refs" class="git-ref-label">{{
        row.commit.refs
      }}</span
      ><span class="git-log-subject">{{ row.commit.subject }}</span
      ><span class="muted git-author">{{ row.commit.author }}</span
      ><time>{{ row.commit.date.slice(0, 10) }}</time>
    </button>
  </div>
</template>

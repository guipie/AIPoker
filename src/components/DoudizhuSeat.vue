<script setup lang="ts">
import { computed } from "vue";
import type { DdzPlayer } from "../engine/doudizhu";
import type { AgentDef } from "../store";
import CardComp from "./Card.vue";

const props = defineProps<{
  player: DdzPlayer;
  agent?: AgentDef;
  isCurrent: boolean;
}>();

const isHuman = computed(() => props.player.isHuman);
const lastPlay = computed(() => props.player.lastPlay ?? []);
const initial = computed(() => (props.player.name || "?").slice(0, 1));
</script>

<template>
  <div
    class="flex w-[172px] flex-col items-center gap-1.5 transition-all"
    :class="isCurrent ? 'scale-105' : ''"
  >
    <!-- 座位卡片 -->
    <div
      class="seat-card relative flex w-full items-center gap-2.5 rounded-2xl px-3 py-2"
      :class="isCurrent ? 'turn-ring' : ''"
    >
      <!-- 头像 -->
      <div class="relative shrink-0">
        <img
          v-if="agent?.avatar"
          :src="agent.avatar"
          class="h-11 w-11 rounded-full border-2 object-cover shadow-lg"
          :class="isCurrent ? 'avatar-ring-active border-amber-300' : 'border-white/60'"
          alt=""
        />
        <div
          v-else
          class="flex h-11 w-11 items-center justify-center rounded-full border-2 text-lg font-black text-white shadow-lg"
          :class="[
            agent ? agent.color + ' ' + agent.color2 : 'bg-gradient-to-br from-amber-400 to-amber-700',
            isCurrent ? 'avatar-ring-active' : '',
          ]"
        >
          {{ isHuman ? "你" : agent?.emoji ?? initial }}
        </div>
        <span
          v-if="agent"
          class="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-fuchsia-500 to-violet-700 text-[10px] text-white shadow ring-1 ring-white/40"
          >✦</span
        >
      </div>

      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1">
          <span class="truncate text-sm font-bold text-white">{{ player.name }}</span>
          <span
            v-if="player.role === 'landlord'"
            class="shrink-0 rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-bold text-amber-950"
            >地主</span
          >
          <span
            v-else-if="player.role === 'farmer'"
            class="shrink-0 rounded bg-slate-500/90 px-1.5 py-0.5 text-[10px] font-bold text-white"
            >农民</span
          >
        </div>
        <div class="mt-0.5 flex items-center gap-1 text-[11px] text-amber-100/80">
          <span class="h-3 w-2 rounded-[2px] border border-indigo-300/40 bg-gradient-to-br from-indigo-600 to-indigo-900"></span>
          <span>剩 {{ player.handCount }} 张</span>
        </div>
      </div>
    </div>

    <!-- 思考中 -->
    <div
      v-if="isCurrent"
      class="animate-think flex items-center gap-1.5 rounded-full bg-black/55 px-3 py-0.5 text-[11px] text-amber-200 shadow"
    >
      <span>思考中</span>
      <span class="flex gap-0.5"><i class="thinking-dot h-1 w-1 rounded-full bg-amber-300"></i><i class="thinking-dot h-1 w-1 rounded-full bg-amber-300" style="animation-delay:.18s"></i><i class="thinking-dot h-1 w-1 rounded-full bg-amber-300" style="animation-delay:.36s"></i></span>
    </div>

    <!-- 最近一次出牌（在 agent 面前，下次出牌覆盖） -->
    <div class="flex min-h-[60px] items-center justify-center">
      <div
        v-if="lastPlay.length"
        class="flex items-center gap-1 rounded-xl border border-amber-300/25 bg-black/40 px-2 py-1 shadow"
      >
        <div
          v-for="(c, i) in lastPlay"
          :key="c.id"
          class="animate-card-fly"
          :style="{ marginLeft: i === 0 ? '0' : '-22px', zIndex: i }"
        >
          <CardComp :card="c" small />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from "vue";
import type { HoldemPlayer } from "../engine/holdem";
import type { AgentDef } from "../types";
import CardComp from "./Card.vue";

const props = defineProps<{
  player: HoldemPlayer;
  agent?: AgentDef;
  isCurrent: boolean;
  reveal: boolean; // 摊牌时亮牌
  winner: boolean;
  compact?: boolean; // 人数多时缩小
  // 该 agent 对应大模型的连通状态（启用大模型时才传）
  conn?: { ok: boolean; model: string; error?: string; checking?: boolean };
}>();

const emit = defineEmits<{ (e: "editModel"): void }>();

const isHuman = computed(() => props.player.isHuman);
const showHole = computed(() => isHuman.value || props.reveal);
const dimmed = computed(() => props.player.hasFolded && !props.player.isBusted);
const busted = computed(() => props.player.isBusted);
</script>

<template>
  <div
    class="flex w-[176px] flex-col items-center gap-1.5 transition-all"
    :class="[
      busted ? 'opacity-35 grayscale' : dimmed ? 'opacity-40 grayscale' : '',
      isCurrent ? 'scale-105' : '',
      compact ? '!w-[132px]' : '',
    ]"
  >
    <!-- 座位卡片 -->
    <div
      class="seat-card relative flex w-full items-center gap-2.5 rounded-2xl px-3 py-2"
      :class="[isCurrent ? 'turn-ring' : '', busted ? 'busted-card' : '']"
    >
      <!-- 头像 -->
      <div class="relative shrink-0">
        <div
          class="flex h-11 w-11 items-center justify-center rounded-full border-2 text-lg font-black text-white shadow-lg"
          :class="[
            agent
              ? agent.color + ' ' + agent.color2
              : 'bg-gradient-to-br from-amber-400 to-amber-700',
            isCurrent ? 'avatar-ring-active' : '',
          ]"
        >
          {{ isHuman ? "你" : agent?.emoji ?? player.name.slice(0, 1) }}
        </div>
        <span
          v-if="agent"
          class="absolute -right-1 -top-1 flex h-5 w-5 items-center justify-center rounded-full bg-gradient-to-br from-fuchsia-500 to-violet-700 text-[10px] text-white shadow ring-1 ring-white/40"
        >
          ✦
        </span>
        <!-- 庄家按钮 -->
        <span
          v-if="player.isDealer"
          class="absolute -left-2 -bottom-2 flex h-5 w-5 items-center justify-center rounded-full bg-white text-[10px] font-black text-slate-800 shadow ring-1 ring-amber-400"
          title="庄家"
        >
          D
        </span>
      </div>

      <div class="min-w-0 flex-1">
        <div class="flex items-center gap-1">
          <span class="truncate text-sm font-bold text-white">{{ player.name }}</span>
          <span
            v-if="winner"
            class="shrink-0 rounded bg-amber-400 px-1 py-0.5 text-[10px] font-bold text-amber-950"
          >
            赢
          </span>
        </div>
        <div class="mt-0.5 flex items-center gap-1 text-[11px] text-amber-100/80">
          <span
            v-if="busted"
            class="rounded bg-rose-700/80 px-1.5 py-0.5 text-[10px] font-bold text-white"
          >
            已输光
          </span>
          <span v-else>💰 {{ player.stack }}</span>
        </div>
        <div
          v-if="player.lastAction && !player.hasFolded && !busted"
          class="mt-0.5 text-[13px] text-green-600"
        >
          {{ player.lastAction }}
        </div>
        <div v-else-if="player.hasFolded && !busted" class="mt-0.5 text-[10px] text-rose-300/80">
          已弃牌
        </div>
        <div v-else-if="busted" class="mt-0.5 text-[10px] text-rose-200/80">出局</div>
      </div>
    </div>

    <!-- 模型在线状态（点击可修改该 agent 的模型配置） -->
    <button
      v-if="conn"
      class="flex max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-bold shadow transition-colors"
      :class="conn.ok ? 'bg-emerald-500/25 text-emerald-200 hover:bg-emerald-500/40' : 'bg-rose-500/25 text-rose-200 hover:bg-rose-500/40'"
      :title="conn.ok ? '点击修改该 agent 的模型配置' : (conn.error || '连接失败') + '（点击修改配置）'"
      @click="emit('editModel')"
    >
      <span class="h-1.5 w-1.5 shrink-0 rounded-full" :class="conn.ok ? 'bg-emerald-400' : 'bg-rose-400'"></span>
      <span class="truncate">{{ conn.model }}</span>
      <span>{{ conn.checking ? "检测中…" : conn.ok ? "在线" : "不在线" }}</span>
    </button>

    <!-- 手牌 -->
    <div class="flex h-[5.1rem] items-end justify-center">
      <div class="flex" :class="isCurrent ? '' : ''">
        <div
          v-for="(c, i) in player.hole"
          :key="c.id"
          :style="{ marginLeft: i === 0 ? '0' : '-14px', zIndex: i }"
        >
          <CardComp :card="c" small :face-down="!showHole" />
        </div>
        <div v-if="player.hole.length === 0" class="text-xs text-white/30">—</div>
      </div>
    </div>
  </div>
</template>

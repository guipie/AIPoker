<script setup lang="ts">
import { computed } from "vue";
import type { DdzPlayer } from "../engine/doudizhu";
import type { AgentDef } from "../types";
import CardComp from "./Card.vue";

const props = defineProps<{
  player: DdzPlayer;
  agent?: AgentDef;
  isCurrent: boolean;
  // 该 agent 对应大模型的连通状态（启用大模型时才传）
  conn?: { ok: boolean; model: string; error?: string; checking?: boolean };
  /** 该座位最近一个动作是「不出」：把自己上一次出的牌盖上 PASS */
  passed?: boolean;
  /** 该 agent 最近一次决策的思考过程（reasoning_content，流式累积） */
  thoughts?: string;
  /** 已在思考多久（秒）；0 表示不在思考 */
  waited?: number;
}>();

const emit = defineEmits<{ (e: "editModel"): void; (e: "openThoughts"): void }>();

const isHuman = computed(() => props.player.isHuman);
const lastPlay = computed(() => props.player.lastPlay ?? []);
const initial = computed(() => (props.player.name || "?").slice(0, 1));
/** 有没有可看的思考过程（思考型模型才会给 reasoning_content） */
const hasThoughts = computed(() => !!props.thoughts?.trim());
</script>

<template>
  <div
    class="flex w-[150px] flex-col items-center gap-1 transition-all"
    :class="isCurrent ? 'scale-105' : ''"
  >
    <!-- 座位卡片 -->
    <div
      class="seat-card relative flex w-full items-center gap-2 rounded-xl px-2 py-1.5"
      :class="isCurrent ? 'turn-ring' : ''"
    >
      <!-- 头像 -->
      <div class="relative shrink-0">
        <img
          v-if="agent?.avatar"
          :src="agent.avatar"
          class="h-9 w-9 rounded-full border-2 object-cover shadow-lg"
          :class="isCurrent ? 'avatar-ring-active border-amber-300' : 'border-white/60'"
          alt=""
        />
        <div
          v-else
          class="flex h-9 w-9 items-center justify-center rounded-full border-2 text-base font-black text-white shadow-lg"
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
          <span class="truncate text-[13px] font-bold leading-tight text-white">{{ player.name }}</span>
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

    <!-- 思考中（去掉超时后要让人知道它还在想：显示已等待秒数；有推理内容可点 › 查看） -->
    <div
      v-if="isCurrent"
      class="animate-think flex items-center gap-1.5 rounded-full bg-black/55 px-2.5 py-0.5 text-[11px] text-amber-200 shadow"
    >
      <button
        v-if="hasThoughts"
        class="flex h-4 w-4 shrink-0 items-center justify-center rounded-full bg-amber-300/25 text-[11px] font-black leading-none text-amber-100 transition-colors hover:bg-amber-300/50"
        title="查看思考过程"
        @click="emit('openThoughts')"
      >
        ›
      </button>
      <span>思考中<template v-if="waited && waited > 0"> · 已等 {{ waited }}s</template></span>
      <span class="flex gap-0.5"
        ><i class="thinking-dot h-1 w-1 rounded-full bg-amber-300"></i
        ><i class="thinking-dot h-1 w-1 rounded-full bg-amber-300" style="animation-delay: 0.18s"></i
        ><i class="thinking-dot h-1 w-1 rounded-full bg-amber-300" style="animation-delay: 0.36s"></i
      ></span>
    </div>
    <!-- 这一手想完了：留在座位上，随时回看它刚才怎么想的 -->
    <button
      v-else-if="hasThoughts"
      class="flex items-center gap-1 rounded-full bg-violet-500/20 px-2 py-0.5 text-[10px] font-bold text-violet-200 transition-colors hover:bg-violet-500/35"
      title="查看上一次的思考过程"
      @click="emit('openThoughts')"
    >
      › 思考过程
    </button>

    <!-- 最近一次出牌（在 agent 面前，下次出牌覆盖；自己「不出」时盖上 PASS） -->
    <div class="flex min-h-[46px] items-center justify-center">
      <div v-if="lastPlay.length" class="relative">
        <div
          class="flex items-center gap-1 rounded-xl border border-amber-300/25 bg-black/40 px-2 py-1 shadow transition-opacity"
          :class="passed ? 'opacity-40' : ''"
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
        <div
          v-if="passed"
          class="pointer-events-none absolute inset-0 flex items-center justify-center"
        >
          <span class="pass-stamp pass-stamp-sm text-xl">PASS</span>
        </div>
      </div>
      <div
        v-else-if="passed"
        class="rounded-full bg-rose-600/90 px-2.5 py-0.5 text-[11px] font-black tracking-wide text-white shadow"
      >
        不出
      </div>
    </div>
  </div>
</template>

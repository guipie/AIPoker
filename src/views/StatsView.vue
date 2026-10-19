<script setup lang="ts">
import { computed } from "vue";
import { store } from "../store";
import { sfx } from "../audio/sfx";

const ddz = computed(() => store.stats.ddz);
const holdem = computed(() => store.stats.holdem);
const total = computed(() => ddz.value.win + ddz.value.lose + holdem.value.win + holdem.value.lose);
const winRate = (w: number, l: number) => (w + l === 0 ? "—" : Math.round((w / (w + l)) * 100) + "%");

function fmtTime(t: number) {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}
</script>

<template>
  <div class="h-full overflow-y-auto px-6 py-8" style="background: radial-gradient(ellipse at 50% -10%, #2b1d11 0%, #150f08 55%, #0a0705 100%)">
    <div class="mx-auto max-w-4xl">
      <div class="mb-6 text-3xl font-black text-amber-100">📊 我的战绩</div>

      <!-- 总览 -->
      <div class="mb-6 grid gap-4 sm:grid-cols-3">
        <div class="rounded-2xl border border-white/10 bg-black/30 p-5 text-center">
          <div class="text-xs text-amber-100/60">总对局</div>
          <div class="text-3xl font-black text-amber-300">{{ total }}</div>
        </div>
        <div class="rounded-2xl border border-emerald-400/20 bg-emerald-500/10 p-5 text-center">
          <div class="text-xs text-emerald-200/70">总胜场</div>
          <div class="text-3xl font-black text-emerald-300">{{ ddz.win + holdem.win }}</div>
        </div>
        <div class="rounded-2xl border border-rose-400/20 bg-rose-500/10 p-5 text-center">
          <div class="text-xs text-rose-200/70">总负场</div>
          <div class="text-3xl font-black text-rose-300">{{ ddz.lose + holdem.lose }}</div>
        </div>
      </div>

      <!-- 分玩法 -->
      <div class="mb-6 grid gap-4 sm:grid-cols-2">
        <div class="rounded-2xl border border-white/10 bg-white/5 p-5">
          <div class="mb-3 flex items-center gap-2 font-bold text-white">🃏 斗地主</div>
          <div class="flex items-center justify-around text-center">
            <div><div class="text-2xl font-black text-emerald-300">{{ ddz.win }}</div><div class="text-xs text-white/50">胜</div></div>
            <div><div class="text-2xl font-black text-rose-300">{{ ddz.lose }}</div><div class="text-xs text-white/50">负</div></div>
            <div><div class="text-2xl font-black text-amber-300">{{ winRate(ddz.win, ddz.lose) }}</div><div class="text-xs text-white/50">胜率</div></div>
          </div>
        </div>
        <div class="rounded-2xl border border-white/10 bg-white/5 p-5">
          <div class="mb-3 flex items-center gap-2 font-bold text-white">♠ 德州扑克</div>
          <div class="flex items-center justify-around text-center">
            <div><div class="text-2xl font-black text-emerald-300">{{ holdem.win }}</div><div class="text-xs text-white/50">胜</div></div>
            <div><div class="text-2xl font-black text-rose-300">{{ holdem.lose }}</div><div class="text-xs text-white/50">负</div></div>
            <div><div class="text-2xl font-black text-amber-300">{{ winRate(holdem.win, holdem.lose) }}</div><div class="text-xs text-white/50">胜率</div></div>
          </div>
        </div>
      </div>

      <!-- 最近记录 -->
      <div class="rounded-2xl border border-white/10 bg-black/30 p-5">
        <div class="mb-3 font-bold text-white">最近对局</div>
        <div v-if="store.stats.hands.length === 0" class="py-6 text-center text-sm text-white/40">
          还没有记录，去广场开一局吧～
        </div>
        <div v-else class="space-y-1.5">
          <div
            v-for="(h, i) in store.stats.hands.slice(0, 20)"
            :key="i"
            class="flex items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-sm"
          >
            <span class="text-white/80">{{ h.mode === "ddz" ? "🃏 斗地主" : "♠ 德州扑克" }}</span>
            <span class="flex items-center gap-3">
              <span :class="h.result === '胜' ? 'text-emerald-300' : 'text-rose-300'" class="font-bold">{{ h.result }}</span>
              <span class="text-xs text-white/40">{{ fmtTime(h.time) }}</span>
            </span>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

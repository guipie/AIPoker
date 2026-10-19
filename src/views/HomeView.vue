<script setup lang="ts">
import { computed } from "vue";
import { store, agentById, beginGame } from "../store";
import { sfx } from "../audio/sfx";

// 优先展示：已多选 > 默认 agent > 空
const displayAgents = computed(() => {
  const ids = store.selectedAgentIds.length ? store.selectedAgentIds : store.defaultAgentIds;
  return ids.map((id) => agentById(id)).filter(Boolean);
});

function start(mode: "doudizhu" | "holdem") {
  sfx.click();
  beginGame(mode); // 用默认/随机 agent 开局
}
</script>

<template>
  <div class="h-full overflow-y-auto px-6 py-8" style="background: radial-gradient(ellipse at 50% -10%, #2b1d11 0%, #150f08 55%, #0a0705 100%)">
    <!-- Hero -->
    <div class="mx-auto max-w-5xl text-center">
      <div class="mb-3 inline-flex items-center gap-2 rounded-full bg-amber-400/10 px-4 py-1.5 text-xs text-amber-200 ring-1 ring-amber-400/30">
        🤖 与 DeepSeek / GPT / 本地 Ollama 等大模型机器人同台竞技
      </div>
      <h1 class="text-4xl font-black tracking-wide text-amber-100 drop-shadow sm:text-5xl">
        扑克 <span class="text-amber-400">AI</span> 竞技场
      </h1>
      <p class="mx-auto mt-3 max-w-2xl text-sm text-amber-100/70">
        在这里，你面对的不是冰冷的规则机器人，而是一个个有性格、有策略、甚至由不同大模型驱动的「AI 牌手」。
        叫牌、诈唬、读心——看你能不能赢过它们。
      </p>
    </div>

    <!-- 玩法卡片 -->
    <div class="mx-auto mt-10 grid max-w-5xl gap-6 md:grid-cols-2">
      <!-- 斗地主 -->
      <div
        class="hover-lift group relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-emerald-900/60 to-slate-900/80 p-7 shadow-2xl"
      >
        <div class="absolute -right-8 -top-8 text-[120px] opacity-10 transition-transform group-hover:scale-110">🃏</div>
        <div class="mb-3 flex items-center gap-3">
          <span class="flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-500/20 text-2xl">🃏</span>
          <div>
            <h2 class="text-xl font-black text-white">斗地主</h2>
            <span class="text-xs text-emerald-200/70">三人混战 · 叫地主 · 炸弹火箭</span>
          </div>
        </div>
        <p class="mb-5 text-sm text-white/70">
          你 + 两个 AI 抢地主。AI 会叫分、会算牌、会憋炸弹，开启大模型后，它们还会「思考」该怎么打。
        </p>
        <button
          class="btn btn-primary w-full py-3 text-base"
          @click="start('doudizhu')"
        >
          开始斗地主 →
        </button>
      </div>

      <!-- 德州扑克 -->
      <div
        class="hover-lift group relative overflow-hidden rounded-3xl border border-white/10 bg-gradient-to-br from-rose-900/60 to-slate-900/80 p-7 shadow-2xl"
      >
        <div class="absolute -right-8 -top-8 text-[120px] opacity-10 transition-transform group-hover:scale-110">♠</div>
        <div class="mb-3 flex items-center gap-3">
          <span class="flex h-12 w-12 items-center justify-center rounded-2xl bg-rose-500/20 text-2xl">♠</span>
          <div>
            <h2 class="text-xl font-black text-white">德州扑克</h2>
            <span class="text-xs text-rose-200/70">无限注 · 盲注 · 摊牌 · 边池</span>
          </div>
        </div>
        <p class="mb-5 text-sm text-white/70">
          无限注德州，多人同桌。下注、加注、全下、诈唬——每个 AI 对手都有独特的激进度与紧度，甚至用不同模型。
        </p>
        <button
          class="btn btn-rose w-full py-3 text-base"
          @click="start('holdem')"
        >
          开始德州扑克 →
        </button>
      </div>
    </div>

    <!-- 当前牌桌对手 -->
    <div class="mx-auto mt-8 max-w-5xl rounded-3xl border border-white/10 bg-black/30 p-6">
      <div class="mb-4 flex items-center justify-between">
        <h3 class="text-sm font-bold text-amber-100/90">本桌 AI 对手（来自 Agent 广场）</h3>
        <button class="btn-ghost rounded-lg px-3 py-1.5 text-xs" @click="store.view = 'agents'">
          去广场挑选 →
        </button>
      </div>
      <div class="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <div
          v-for="a in displayAgents"
          :key="a!.id"
          class="flex items-center gap-3 rounded-2xl border border-white/10 bg-white/5 p-3"
        >
          <span
            class="flex h-11 w-11 items-center justify-center rounded-xl bg-gradient-to-br text-xl"
            :class="[a!.color, a!.color2]"
            >{{ a!.emoji }}</span
          >
          <div class="min-w-0">
            <div class="truncate text-sm font-bold text-white">{{ a!.name }}</div>
            <div class="truncate text-[11px] text-white/55">{{ a!.tagline }}</div>
          </div>
        </div>
        <div
          v-if="displayAgents.length === 0"
          class="col-span-full rounded-2xl border border-dashed border-white/15 p-6 text-center text-sm text-white/40"
        >
          还没选对手，去 Agent 广场挑几个吧～
        </div>
      </div>
    </div>

    <p class="mx-auto mt-8 max-w-5xl text-center text-[11px] text-amber-100/30">
      提示：在「设置」中填入大模型 API Key 即可让 AI 对手真正用大模型思考；不填也能玩，会回退到内置规则 AI。
    </p>
  </div>
</template>

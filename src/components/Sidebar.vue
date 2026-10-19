<script setup lang="ts">
import { ref, computed } from "vue";
import { store, type ViewKey } from "../store";
import { sfx } from "../audio/sfx";

const collapsed = ref(false);

const items: { key: ViewKey; icon: string; label: string; sub?: string }[] = [
  { key: "plaza", icon: "🎰", label: "扑克广场", sub: "挑选玩法" },
  { key: "agents", icon: "🤖", label: "Agent 广场", sub: "挑选对手" },
  { key: "stats", icon: "📊", label: "战绩", sub: "我的记录" },
  { key: "settings", icon: "⚙️", label: "设置", sub: "大模型/音效" },
];

const selectedCount = computed(() => store.selectedAgentIds.length);

function go(key: ViewKey) {
  sfx.click();
  store.view = key;
}
</script>

<template>
  <aside
    class="z-30 flex h-full shrink-0 flex-col border-r border-white/10 bg-gradient-to-b from-[#1a120b] to-[#0c0805] text-amber-50 shadow-2xl transition-all duration-300"
    :class="collapsed ? 'w-[68px]' : 'w-[216px]'"
  >
    <!-- Logo -->
    <div class="flex h-16 items-center gap-2.5 border-b border-white/10 px-4">
      <div
        class="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-amber-400 to-amber-700 text-lg shadow-lg ring-1 ring-amber-200/40"
      >
        ♠
      </div>
      <div v-if="!collapsed" class="leading-tight">
        <div class="text-sm font-black tracking-wide">扑克 AI 竞技场</div>
        <div class="text-[10px] text-amber-200/60">与各大模型机器人斗牌</div>
      </div>
    </div>

    <!-- 导航 -->
    <nav class="flex-1 space-y-1 overflow-y-auto px-2.5 py-3">
      <button
        v-for="it in items"
        :key="it.key"
        class="group relative flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-all"
        :class="
          store.view === it.key
            ? 'bg-gradient-to-r from-amber-500/25 to-amber-700/10 ring-1 ring-amber-400/50'
            : 'hover:bg-white/5'
        "
        @click="go(it.key)"
      >
        <span
          class="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg text-lg"
          :class="store.view === it.key ? 'bg-amber-400/20' : 'bg-white/5'"
        >
          {{ it.icon }}
        </span>
        <span v-if="!collapsed" class="min-w-0 flex-1">
          <span
            class="block truncate text-sm font-bold"
            :class="store.view === it.key ? 'text-amber-200' : 'text-amber-50/90'"
            >{{ it.label }}</span
          >
          <span class="block truncate text-[10px] text-amber-100/45">{{ it.sub }}</span>
        </span>
        <span
          v-if="it.key === 'agents' && selectedCount > 0 && !collapsed"
          class="rounded-full bg-emerald-500/90 px-1.5 text-[10px] font-bold text-white"
          >{{ selectedCount }}</span
        >
        <span
          v-if="store.view === it.key"
          class="absolute left-0 top-1/2 h-6 w-1 -translate-y-1/2 rounded-r bg-amber-400"
        ></span>
      </button>
    </nav>

    <!-- 底部：LLM 状态 + 折叠 -->
    <div class="border-t border-white/10 p-3">
      <div
        v-if="!collapsed"
        class="mb-2 flex items-center gap-2 rounded-lg bg-black/30 px-3 py-2 text-[11px]"
      >
        <span
          class="h-2 w-2 rounded-full"
          :class="store.settings.enabled ? 'bg-emerald-400 shadow-[0_0_8px] shadow-emerald-400' : 'bg-slate-500'"
        ></span>
        <span class="text-amber-100/70">
          {{ store.settings.enabled ? "大模型大脑：在线" : "大脑：离线(规则AI)" }}
        </span>
      </div>
      <button
        class="flex w-full items-center justify-center gap-2 rounded-lg bg-white/5 py-2 text-xs text-amber-100/70 hover:bg-white/10"
        @click="collapsed = !collapsed"
      >
        <span>{{ collapsed ? "»" : "« 收起" }}</span>
      </button>
    </div>
  </aside>
</template>

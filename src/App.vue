<script setup lang="ts">
import { computed } from "vue";
import { store } from "./store";
import { setSoundEnabled } from "./audio/sfx";
import Sidebar from "./components/Sidebar.vue";
import HomeView from "./views/HomeView.vue";
import DoudizhuView from "./views/DoudizhuView.vue";
import HoldemView from "./views/HoldemView.vue";
import AgentPlazaView from "./views/AgentPlazaView.vue";
import StatsView from "./views/StatsView.vue";
import SettingsView from "./views/SettingsView.vue";
import { onMounted } from "vue";

const viewMap = {
  plaza: HomeView,
  doudizhu: DoudizhuView,
  holdem: HoldemView,
  agents: AgentPlazaView,
  stats: StatsView,
  settings: SettingsView,
};

const current = computed(() => viewMap[store.view]);

// 悬浮圆球：存在进行中的牌局且当前不在该牌局时显示
const showBall = computed(() => store.activeGame !== null && store.view !== store.activeGame);
function enterActiveGame() {
  if (store.activeGame) store.view = store.activeGame;
}

onMounted(() => {
  setSoundEnabled(store.settings.sound);
});
</script>

<template>
  <div class="flex h-full w-full overflow-hidden text-white">
    <Sidebar />
    <main class="relative flex-1 overflow-hidden">
      <keep-alive>
        <component :is="current" />
      </keep-alive>

      <!-- 右下角悬浮圆球：进入进行中的牌桌 -->
      <transition name="ball">
        <button
          v-if="showBall"
          class="floating-ball group absolute bottom-5 right-5 z-40 flex h-16 w-16 items-center justify-center rounded-full text-3xl shadow-2xl"
          @click="enterActiveGame"
          title="返回进行中的牌局"
        >
          <span class="ball-pulse absolute inset-0 rounded-full"></span>
          <span class="relative">♠</span>
          <span
            class="absolute -right-1 -top-1 rounded-full bg-rose-500 px-1.5 text-[10px] font-black text-white shadow ring-2 ring-black/40"
          >{{ store.activeGame === "doudizhu" ? "斗" : "德" }}</span>
        </button>
      </transition>
    </main>
  </div>
</template>

<style scoped>
.floating-ball {
  background: radial-gradient(circle at 30% 25%, #fbbf24 0%, #f59e0b 45%, #b45309 100%);
  border: 2px solid rgba(255, 255, 255, 0.35);
  transition: transform 0.18s ease;
}
.floating-ball:hover {
  transform: scale(1.08);
}
.floating-ball:active {
  transform: scale(0.94);
}
.ball-pulse {
  background: rgba(251, 191, 36, 0.5);
  animation: ball-pulse 2s ease-in-out infinite;
}
@keyframes ball-pulse {
  0%,
  100% {
    transform: scale(1);
    opacity: 0.55;
  }
  50% {
    transform: scale(1.5);
    opacity: 0;
  }
}
.ball-enter-active,
.ball-leave-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}
.ball-enter-from,
.ball-leave-to {
  opacity: 0;
  transform: translateY(20px) scale(0.6);
}
</style>

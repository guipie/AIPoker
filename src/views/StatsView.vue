<script setup lang="ts">
import { computed, onActivated, onMounted, ref } from "vue";
import { clearMatchLogs, matchLogById, store } from "../store";
import { sfx } from "../audio/sfx";
import type { DdzDetail, HoldemDetail, MatchLog, MatchLogEntry } from "../utils/matchLog";

const ddz = computed(() => store.stats.ddz);
const holdem = computed(() => store.stats.holdem);
const total = computed(() => ddz.value.win + ddz.value.lose + holdem.value.win + holdem.value.lose);
const winRate = (w: number, l: number) => (w + l === 0 ? "—" : Math.round((w / (w + l)) * 100) + "%");

function fmtTime(t: number) {
  const d = new Date(t);
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

// ===== 明细查看 =====
const openId = ref<string | null>(null);
const showHands = ref(false);
const openLog = computed<MatchLog | null>(() => matchLogById(openId.value));

function openDetail(logId?: string) {
  if (!logId) return;
  sfx.click();
  showHands.value = false;
  openId.value = logId;
}
function closeDetail() {
  openId.value = null;
}

const ddzDetail = computed<DdzDetail | null>(() =>
  openLog.value && openLog.value.detail.kind === "ddz" ? (openLog.value.detail as DdzDetail) : null
);
const holdemDetail = computed<HoldemDetail | null>(() =>
  openLog.value && openLog.value.detail.kind === "holdem"
    ? (openLog.value.detail as HoldemDetail)
    : null
);

const KIND_ICON: Record<string, string> = {
  bid: "🎯",
  play: "🃏",
  pass: "⏭",
  act: "•",
  deal: "🎴",
  over: "🏁",
};

function entryText(e: MatchLogEntry): string {
  if (e.kind === "bid") return e.score && e.score > 0 ? `抢地主 ${e.score} 分` : "不抢";
  if (e.kind === "play") return `出 ${(e.cards ?? []).join(" ")}`;
  if (e.kind === "pass") return "不出";
  return e.note ?? "";
}

function srcLabel(s?: string) {
  if (s === "llm") return "LLM";
  if (s === "human") return "你";
  if (s === "rule") return "规则";
  return "";
}
function srcClass(s?: string) {
  if (s === "llm") return "bg-violet-500/25 text-violet-200";
  if (s === "human") return "bg-sky-500/25 text-sky-200";
  if (s === "rule") return "bg-white/10 text-white/50";
  return "";
}

function clearAll() {
  if (!store.matchLogs.length) return;
  if (!window.confirm("确定清空全部对局明细吗？该操作不可恢复（战绩统计不受影响）。")) return;
  sfx.click();
  clearMatchLogs();
  openId.value = null;
}

// 按玩家分配一个稳定的强调色，让复盘时一眼分清谁在出牌
const PLAYER_COLORS = ["text-amber-300", "text-sky-300", "text-emerald-300", "text-fuchsia-300"];
function colorOf(name?: string) {
  if (!name) return "text-white/80";
  const idx = (openLog.value?.players ?? []).indexOf(name);
  return PLAYER_COLORS[Math.max(0, idx) % PLAYER_COLORS.length];
}

// 牌桌结算后点「查看本局明细」→ 进到战绩页自动打开那一局
function consumePending() {
  const id = store.pendingStatLogId;
  if (!id) return;
  store.pendingStatLogId = null;
  if (matchLogById(id)) {
    showHands.value = false;
    openId.value = id;
  }
}
onMounted(consumePending);
onActivated(consumePending);
</script>

<template>
  <div
    class="h-full overflow-y-auto px-6 py-8"
    style="background: radial-gradient(ellipse at 50% -10%, #2b1d11 0%, #150f08 55%, #0a0705 100%)"
  >
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

      <!-- 最近记录（可点开明细） -->
      <div class="rounded-2xl border border-white/10 bg-black/30 p-5">
        <div class="mb-3 flex items-center justify-between">
          <div class="font-bold text-white">最近对局</div>
          <div class="flex items-center gap-3">
            <span class="text-xs text-white/35">已存 {{ store.matchLogs.length }} 局明细</span>
            <button
              v-if="store.matchLogs.length"
              class="rounded-lg border border-white/15 px-2.5 py-1 text-xs text-white/60 hover:bg-white/10"
              @click="clearAll"
            >
              清空明细
            </button>
          </div>
        </div>
        <div v-if="store.stats.hands.length === 0" class="py-6 text-center text-sm text-white/40">
          还没有记录，去广场开一局吧～
        </div>
        <div v-else class="space-y-1.5">
          <button
            v-for="(h, i) in store.stats.hands.slice(0, 20)"
            :key="i"
            class="flex w-full items-center justify-between rounded-lg bg-white/5 px-3 py-2 text-left text-sm transition hover:bg-white/10 disabled:cursor-default disabled:hover:bg-white/5"
            :disabled="!h.logId"
            :title="h.logId ? '点击查看这局的抢地主 / 出牌明细' : '这局没有明细记录'"
            @click="openDetail(h.logId)"
          >
            <span class="flex items-center gap-2 text-white/80">
              <span>{{ h.mode === "ddz" ? "🃏 斗地主" : "♠ 德州扑克" }}</span>
              <span v-if="h.logId" class="rounded bg-amber-400/15 px-1.5 py-0.5 text-[10px] text-amber-200">明细 ›</span>
            </span>
            <span class="flex items-center gap-3">
              <span :class="h.result === '胜' ? 'text-emerald-300' : 'text-rose-300'" class="font-bold">{{ h.result }}</span>
              <span class="text-xs text-white/40">{{ fmtTime(h.time) }}</span>
            </span>
          </button>
        </div>
      </div>
    </div>

    <!-- ===== 明细弹层 ===== -->
    <div
      v-if="openLog"
      class="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
      @click.self="closeDetail"
    >
      <div
        class="flex max-h-[88vh] w-[720px] max-w-[96vw] flex-col overflow-hidden rounded-2xl border border-white/15 bg-gradient-to-b from-slate-800 to-slate-900 shadow-2xl"
      >
        <!-- 头部 -->
        <div class="flex shrink-0 items-start justify-between border-b border-white/10 px-5 py-4">
          <div>
            <div class="flex items-center gap-2 text-lg font-black text-white">
              {{ openLog.mode === "ddz" ? "🃏 斗地主" : "♠ 德州扑克" }}
              <span
                class="rounded px-1.5 py-0.5 text-xs font-bold"
                :class="openLog.result === '胜' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-rose-500/20 text-rose-300'"
              >
                {{ openLog.result }}
              </span>
              <span class="text-xs font-normal text-white/40">{{ fmtTime(openLog.time) }}</span>
            </div>
            <div class="mt-1 text-xs text-white/50">{{ openLog.summary }}</div>
          </div>
          <button class="btn-ghost rounded-lg px-3 py-1 text-sm" @click="closeDetail">关闭</button>
        </div>

        <div class="min-h-0 flex-1 overflow-y-auto px-5 py-4">
          <!-- 斗地主静态信息 -->
          <div v-if="ddzDetail" class="mb-4 rounded-xl border border-amber-300/20 bg-amber-400/5 p-3 text-xs">
            <div class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-white/70">
              <span>地主：<b class="text-amber-200">{{ ddzDetail.landlordName }}</b></span>
              <span>我的身份：<b class="text-white">{{ ddzDetail.myRole }}</b></span>
              <span>获胜方：<b class="text-white">{{ ddzDetail.winner }}</b></span>
              <span v-if="ddzDetail.redealCount" class="text-white/50">流局重发 {{ ddzDetail.redealCount }} 次</span>
            </div>
            <div v-if="ddzDetail.bottomCards.length" class="mb-1 flex items-center gap-2 text-white/60">
              <span>地主底牌</span>
              <span class="flex flex-wrap gap-1">
                <span
                  v-for="(c, i) in ddzDetail.bottomCards"
                  :key="i"
                  class="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-amber-100"
                >{{ c }}</span>
              </span>
            </div>
            <button class="mt-1 text-[11px] text-amber-200/80 underline" @click="showHands = !showHands">
              {{ showHands ? "收起各家开局手牌" : "展开各家开局手牌" }}
            </button>
            <div v-if="showHands" class="mt-2 space-y-1.5">
              <div v-for="(p, i) in ddzDetail.players" :key="i" class="rounded-lg bg-black/30 px-2 py-1.5">
                <div class="mb-1 text-[11px] text-white/60">
                  {{ p.name }} · {{ p.role }}
                  <span v-if="p.agent" class="text-white/35">（{{ p.agent }}）</span>
                  <span class="text-white/35"> · {{ p.hand.length }} 张</span>
                </div>
                <div class="flex flex-wrap gap-1">
                  <span
                    v-for="(c, j) in p.hand"
                    :key="j"
                    class="rounded bg-white/10 px-1.5 py-0.5 font-mono text-[10px] text-white/80"
                  >{{ c }}</span>
                </div>
              </div>
            </div>
          </div>

          <!-- 德州静态信息 -->
          <div v-if="holdemDetail" class="mb-4 rounded-xl border border-sky-300/20 bg-sky-400/5 p-3 text-xs">
            <div class="mb-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-white/70">
              <span class="flex items-center gap-1">
                我的手牌
                <span class="flex gap-1">
                  <span v-for="(c, i) in holdemDetail.hole" :key="i" class="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-sky-100">{{ c }}</span>
                </span>
              </span>
              <span>底池：<b class="text-amber-200">{{ holdemDetail.pot }}</b></span>
              <span>赢家：<b class="text-emerald-300">{{ holdemDetail.winners.join("、") || "—" }}</b></span>
            </div>
            <div class="flex items-center gap-1 text-white/60">
              公共牌
              <span class="flex gap-1">
                <span v-for="(c, i) in holdemDetail.community" :key="i" class="rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-white/85">{{ c }}</span>
                <span v-if="!holdemDetail.community.length" class="text-white/35">（翻前结束）</span>
              </span>
            </div>
          </div>

          <!-- 动作流水 -->
          <div class="mb-2 flex items-center justify-between text-xs text-white/50">
            <span>{{ openLog.mode === "ddz" ? "抢地主 / 出牌全过程" : "本手动作" }}</span>
            <span>{{ openLog.entries.length }} 条</span>
          </div>
          <div v-if="openLog.entries.length === 0" class="py-6 text-center text-sm text-white/35">
            这局没有记录到动作
          </div>
          <div v-else class="space-y-1">
            <div
              v-for="(e, i) in openLog.entries"
              :key="i"
              class="rounded-lg px-2.5 py-1.5 text-sm"
              :class="e.kind === 'bid' ? 'bg-amber-400/5' : i % 2 === 0 ? 'bg-white/5' : 'bg-white/[0.03]'"
            >
              <div class="flex items-center gap-2">
                <span class="w-4 shrink-0 text-center text-xs">{{ KIND_ICON[e.kind] ?? "•" }}</span>
                <span class="w-24 shrink-0 truncate font-bold" :class="colorOf(e.playerName)">{{ e.playerName }}</span>
                <span class="flex-1 text-white/85">
                  <span v-if="e.kind === 'play'" class="mr-1">出</span>
                  <span
                    v-for="(c, j) in e.cards ?? []"
                    :key="j"
                    class="mr-1 inline-block rounded bg-black/40 px-1.5 py-0.5 font-mono text-[11px] text-amber-100"
                  >{{ c }}</span>
                  <span v-if="e.kind !== 'play'">{{ entryText(e) }}</span>
                </span>
                <span v-if="e.handLeft != null" class="shrink-0 text-[11px] text-white/35">剩 {{ e.handLeft }}</span>
                <span
                  v-if="srcLabel(e.source)"
                  class="shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold"
                  :class="srcClass(e.source)"
                >{{ srcLabel(e.source) }}</span>
              </div>
              <div v-if="e.reason" class="mt-1 pl-6 text-[11px] leading-relaxed text-amber-200/60">
                💬 {{ e.reason }}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

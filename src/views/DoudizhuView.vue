<script setup lang="ts">
import { computed, onActivated, onDeactivated, onMounted, ref } from "vue";
import { sfx } from "../audio/sfx";
import CardComp from "../components/Card.vue";
import DoudizhuSeat from "../components/DoudizhuSeat.vue";
import HandCards from "../components/HandCards.vue";
import { SUIT_SYMBOL, rankLabel, type Card } from "../engine/cards";
import {
  DoudizhuGame,
  canBeat,
  detectPattern,
  findBeats,
  suggestBid,
  suggestLead,
} from "../engine/doudizhu";
import { llmDdzDecision, type LlmConfig } from "../engine/llm";
import { agentById, pickAgents, recordResult, store } from "../store";

const game = ref<DoudizhuGame | null>(null);
const state = ref<any>(null);
const selectedIds = ref<Set<string>>(new Set());
const busy = ref(false);
const thinkingId = ref<number | null>(null);
const agentIds = ref<string[]>([]);

let running = false;
let paused = false;

const me = computed(() => state.value?.players.find((p: any) => p.isHuman) ?? null);
const meLastPlay = computed<Card[]>(() => me.value?.lastPlay ?? []);
const bots = computed(() =>
  state.value ? state.value.players.filter((p: any) => !p.isHuman) : []
);
const isMyTurn = computed(() => state.value?.currentPlayerId === 0);
const isBidding = computed(() => state.value?.phase === "bidding");
const isPlaying = computed(() => state.value?.phase === "playing");
const isGameOver = computed(() => state.value?.phase === "gameover");
const currentBid = computed(() => state.value?.currentBid ?? 0);
// 桌面中央：当前需要压过的那一手（最近一次成功出牌），用于判断该出什么
const centerCards = computed<Card[]>(() => state.value?.lastPlay ?? []);

const iWin = computed(() => {
  if (!state.value?.winner) return false;
  const myRole = me.value?.role;
  if (myRole === "landlord") return state.value.winner === "landlord";
  return state.value.winner === "farmer";
});

const agentMap = computed(() => {
  const m: Record<number, string> = {};
  agentIds.value.forEach((id, i) => (m[i + 1] = id));
  return m;
});
function agentFor(id: number) {
  return agentById(agentMap.value[id] ?? "");
}
function llmConfigFor(id: number): LlmConfig {
  const a = agentFor(id);
  return {
    enabled: store.settings.enabled,
    baseUrl: a?.baseUrl ?? store.settings.baseUrl,
    apiKey: a?.apiKey ?? store.settings.apiKey,
    model: a?.model ?? store.settings.model,
    persona: a?.persona ?? store.settings.persona,
    temperature: store.settings.temperature,
  };
}

function ddzLabel(c: Card): string {
  if (c.suit === "joker") return c.rank === 17 ? "大王" : "小王";
  return SUIT_SYMBOL[c.suit] + rankLabel(c);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function newGame(ids?: string[]) {
  const list = ids && ids.length ? ids.slice(0, 3) : pickAgents(2);
  agentIds.value = list;
  const names = list.map(id => agentById(id)?.name ?? "机器人");
  const noJokers = list.length >= 3; // 4 人局（3 机器人 + 你）去掉大小王
  game.value = new DoudizhuGame(names, "你", noJokers);
  state.value = game.value.getState();
  selectedIds.value.clear();
  thinkingId.value = null;
  paused = false;
  store.activeGame = "doudizhu";
  sfx.deal();
  driveBots();
}

// 加减机器人（重置发牌）
function addBot() {
  if (agentIds.value.length >= 3) return;
  const more = pickAgents(1, agentIds.value);
  if (more.length === 0) return;
  sfx.click();
  newGame([...agentIds.value, ...more]);
}
function removeBot() {
  if (agentIds.value.length <= 2) return;
  sfx.click();
  newGame(agentIds.value.slice(0, -1));
}

function maybeStart() {
  if (store.pendingNewGame === "doudizhu") {
    store.pendingNewGame = null;
    const ids =
      store.startAgents && store.startAgents.length ? store.startAgents.slice(0, 3) : pickAgents(2);
    newGame(ids);
  } else if (!game.value) {
    newGame(pickAgents(2));
  } else {
    paused = false;
    resumeIfNeeded();
  }
}

async function driveBots() {
  if (running) return;
  if (paused) return;
  if (!state.value) return;
  running = true;
  try {
    for (let i = 0; i < 200; i++) {
      const s = state.value;
      if (!s || s.phase === "gameover") break;
      if (paused) break;
      if (s.currentPlayerId === 0 || s.currentPlayerId == null) break;

      thinkingId.value = s.currentPlayerId;
      await sleep(550 + Math.random() * 500);
      if (paused) break;

      const player = s.players[s.currentPlayerId];
      if (s.phase === "bidding") {
        const score = suggestBid(player.hand);
        sfx.chip();
        applyState(game.value!.bid(player.id, score));
      } else {
        let ids: string[] | null = null;
        if (store.settings.enabled && (store.settings.apiKey || agentFor(player.id)?.apiKey)) {
          try {
            const out = await llmDdzDecision(llmConfigFor(player.id), {
              hand: player.hand.map(ddzLabel),
              lastPlay: s.lastPlay ? s.lastPlay.map(ddzLabel) : null,
              myRole: player.role ?? "未知",
              persona: agentFor(player.id)?.persona,
            });
            if (out) {
              const map = new Map(player.hand.map((c: Card) => [ddzLabel(c), c.id]));
              if (out.play)
                ids = out.play.map((l: string) => map.get(l)).filter(Boolean) as string[];
              else ids = null;
            }
          } catch {
            ids = null;
          }
        }
        if (ids && ids.length) {
          const cards = ids.map(id => player.hand.find((c: Card) => c.id === id)!).filter(Boolean);
          const pat = detectPattern(cards);
          const lastPat = s.lastPlay ? detectPattern(s.lastPlay) : null;
          if (pat && (!lastPat || canBeat(pat, lastPat))) {
            sfx.play();
            applyState(game.value!.play(player.id, ids));
          } else {
            sfx.fold();
            applyState(game.value!.pass(player.id));
          }
        } else {
          const last = s.lastPlay ? detectPattern(s.lastPlay) : null;
          if (!last) {
            const lead = suggestLead(player.hand);
            sfx.play();
            applyState(
              game.value!.play(
                player.id,
                lead.map(c => c.id)
              )
            );
          } else {
            const beats = findBeats(player.hand, last);
            if (beats) {
              sfx.play();
              applyState(
                game.value!.play(
                  player.id,
                  beats.map(c => c.id)
                )
              );
            } else {
              sfx.fold();
              applyState(game.value!.pass(player.id));
            }
          }
        }
      }
    }
  } finally {
    running = false;
  }
  thinkingId.value = null;

  if (state.value?.phase === "gameover") {
    const win = iWin.value;
    recordResult("ddz", win, win ? "你赢了这局斗地主！" : "这局斗地主你输了");
    win ? sfx.win() : sfx.lose();
  }
}

function resumeIfNeeded() {
  const s = state.value;
  if (!s) return;
  if (s.phase === "gameover") return;
  if (s.currentPlayerId === 0 || s.currentPlayerId == null) return;
  driveBots();
}

function applyState(next: any) {
  state.value = next;
}

function toggleCard(id: string) {
  if (!isMyTurn.value || busy.value || !isPlaying.value) return;
  const next = new Set(selectedIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  selectedIds.value = next;
  sfx.click();
}

function playSelected() {
  if (!isMyTurn.value || busy.value) return;
  const ids = Array.from(selectedIds.value);
  if (ids.length === 0) return;
  busy.value = true;
  sfx.play();
  applyState(game.value!.play(0, ids));
  selectedIds.value.clear();
  busy.value = false;
  driveBots();
}

function pass() {
  if (!isMyTurn.value || busy.value) return;
  busy.value = true;
  sfx.fold();
  applyState(game.value!.pass(0));
  selectedIds.value.clear();
  busy.value = false;
  driveBots();
}

function bid(score: number) {
  if (!isMyTurn.value || !isBidding.value || busy.value) return;
  busy.value = true;
  sfx.chip();
  applyState(game.value!.bid(0, score));
  selectedIds.value.clear();
  busy.value = false;
  driveBots();
}

function hint() {
  if (!isMyTurn.value || busy.value || !isPlaying.value) return;
  const s = state.value;
  const last = s.lastPlay ? detectPattern(s.lastPlay) : null;
  let ids: string[] = [];
  if (!last) {
    ids = suggestLead(me.value.hand).map(c => c.id);
  } else {
    const beats = findBeats(me.value.hand, last);
    ids = beats ? beats.map(c => c.id) : [];
  }
  selectedIds.value = new Set(ids);
}

function backToPlaza() {
  sfx.click();
  paused = true;
  store.view = "plaza";
}

// 对手座位定位：你（人类）在底部，对手沿上弧排开
// 2 个对手 → 左上 / 右上；3 个对手 → 左上 / 上中(对面) / 右上
function botStyle(i: number, n: number) {
  if (n <= 1) return { left: "50%", top: "22%", transform: "translate(-50%,-50%)" };
  if (n === 2) {
    return i === 0
      ? { left: "26%", top: "24%", transform: "translate(-50%,-50%)" }
      : { left: "74%", top: "24%", transform: "translate(-50%,-50%)" };
  }
  const pos = [
    { left: "22%", top: "27%", transform: "translate(-50%,-50%)" },
    { left: "50%", top: "14%", transform: "translate(-50%,-50%)" },
    { left: "78%", top: "27%", transform: "translate(-50%,-50%)" },
  ];
  return pos[i] ?? pos[0];
}

// 相对“你”（底部）的方位标签，让你一眼知道对面/左右是谁
function positionLabel(i: number, n: number): string {
  if (n <= 1) return "对面";
  if (n === 2) return i === 0 ? "左" : "右";
  return ["左", "对面", "右"][i] ?? "";
}

onMounted(maybeStart);
onActivated(maybeStart);
onDeactivated(() => {
  paused = true;
});
</script>

<template>
  <div
    class="relative flex h-full w-full flex-col text-white"
    style="background: radial-gradient(ellipse at 50% -10%, #2b1d11 0%, #150f08 55%, #0a0705 100%)"
  >
    <!-- 顶栏 -->
    <header
      class="z-20 flex h-14 shrink-0 items-center justify-between border-b border-white/10 bg-black/40 px-4 shadow-lg backdrop-blur"
    >
      <button class="btn-ghost rounded-lg px-3 py-1.5 text-sm" @click="backToPlaza">← 广场</button>
      <div class="flex-1 px-4 text-center text-sm text-white/80">{{ state?.message ?? "" }}</div>
      <div class="flex items-center gap-2">
        <span
          v-if="store.settings.enabled"
          class="rounded-full bg-gradient-to-r from-fuchsia-600 to-violet-600 px-2 py-0.5 text-[10px] font-bold"
        >
          LLM 在线
        </span>
        <button
          class="btn-ghost rounded-lg px-2 py-1.5 text-sm"
          :disabled="agentIds.length >= 3"
          @click="addBot"
          title="加一个机器人"
        >
          ➕
        </button>
        <button
          class="btn-ghost rounded-lg px-2 py-1.5 text-sm"
          :disabled="agentIds.length <= 2"
          @click="removeBot"
          title="减一个机器人"
        >
          ➖
        </button>
        <button class="btn-ghost rounded-lg px-3 py-1.5 text-sm" @click="newGame()">重开</button>
      </div>
    </header>

    <!-- 牌桌 -->
    <div class="relative flex flex-1 items-center justify-center px-3 py-3">
      <div class="wood-rail relative h-full w-full max-w-[1240px] rounded-[150px] p-3">
        <div class="felt-table relative h-full w-full overflow-hidden rounded-[130px]">
          <div class="felt-weave pointer-events-none absolute inset-0"></div>
          <div
            class="table-emblem pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <svg viewBox="0 0 100 100" class="h-64 w-64 text-amber-100" fill="currentColor">
              <path
                d="M50 6C50 6 20 33 20 53c0 13 11 20 20 15-4 9-9 16-16 21h52c-7-5-12-12-16-21 9 5 20-2 20-15C80 33 50 6 50 6z"
              />
            </svg>
          </div>

          <!-- 机器人座位（你在对面下方，对手环绕桌面上方） -->
          <div
            v-for="(p, i) in bots"
            :key="p.id"
            class="absolute"
            :style="botStyle(i, bots.length)"
          >
            <div
              class="mb-0.5 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-bold tracking-wide text-amber-200 shadow"
            >
              {{ positionLabel(i, bots.length) }}
            </div>
            <DoudizhuSeat :player="p" :agent="agentFor(p.id)" :is-current="thinkingId === p.id" />
          </div>

          <div class="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <!-- 地主底牌 -->
            <div
              v-if="state && state.landlordCards.length > 0"
              class="flex flex-col items-center gap-1"
            >
              <span class="text-[11px] tracking-widest text-amber-200/70">地主底牌</span>
              <div class="flex gap-1">
                <CardComp v-for="c in state.landlordCards" :key="c.id" :card="c" small />
              </div>
            </div>

            <!-- 中央需压过的牌 -->
            <div class="flex min-h-[96px] items-center justify-center">
              <div v-if="centerCards.length" class="flex animate-card-fly">
                <div
                  v-for="(c, i) in centerCards"
                  :key="c.id"
                  :style="{ marginLeft: i === 0 ? '0' : '-26px', zIndex: i }"
                >
                  <CardComp :card="c" />
                </div>
              </div>
              <div v-else class="text-sm text-white/40">桌面空闲</div>
            </div>

            <!-- 叫地主 -->
            <div v-if="isBidding" class="flex flex-col items-center gap-2">
              <div class="text-base font-bold text-amber-200">
                叫地主（当前最高 {{ currentBid }} 分）
              </div>
              <div v-if="isMyTurn" class="flex gap-2">
                <button class="btn btn-chip-pass px-5 py-2 text-sm" @click="bid(0)">不叫</button>
                <button
                  v-for="s in [1, 2, 3]"
                  :key="s"
                  class="btn btn-chip px-5 py-2 text-sm"
                  :disabled="s <= currentBid"
                  @click="bid(s)"
                >
                  {{ s }} 分
                </button>
              </div>
              <div v-else class="flex items-center gap-2 text-sm text-white/70">
                <span>等待叫地主</span>
                <span class="flex gap-0.5">
                  <i class="thinking-dot h-1.5 w-1.5 rounded-full bg-amber-300"></i>
                  <i
                    class="thinking-dot h-1.5 w-1.5 rounded-full bg-amber-300"
                    style="animation-delay: 0.18s"
                  ></i>
                  <i
                    class="thinking-dot h-1.5 w-1.5 rounded-full bg-amber-300"
                    style="animation-delay: 0.36s"
                  ></i>
                </span>
              </div>
            </div>
            <div v-else-if="isPlaying" class="text-sm">
              <span
                v-if="isMyTurn"
                class="rounded-full bg-amber-500/90 px-3 py-1 font-bold text-amber-950 shadow"
              >
                轮到你出牌
              </span>
              <span v-else class="text-white/50">
                等待
                {{ state?.players.find((p: any) => p.id === state.currentPlayerId)?.name }} 出牌…
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部：自己 + 手牌 + 操作 -->
    <footer
      class="z-20 shrink-0 border-t border-white/10 bg-black/45 px-4 pb-3 pt-2 shadow-[0_-8px_24px_rgba(0,0,0,0.45)]"
    >
      <div class="mb-1 flex items-center justify-center gap-3 text-sm">
        <div class="flex items-center gap-2">
          <div
            class="flex h-8 w-8 items-center justify-center rounded-full border-2 text-sm font-black"
            :class="[
              me?.role === 'landlord'
                ? 'border-amber-300 bg-gradient-to-br from-amber-400 to-amber-700 text-amber-950'
                : 'border-slate-300/60 bg-gradient-to-br from-slate-500 to-slate-800',
              isMyTurn ? 'avatar-ring-active' : '',
            ]"
          >
            你
          </div>
          <span class="font-bold">你</span>
          <span
            v-if="me?.role === 'landlord'"
            class="rounded bg-amber-500 px-1.5 py-0.5 text-[10px] font-bold text-amber-950"
          >
            地主
          </span>
          <span
            v-else-if="me?.role === 'farmer'"
            class="rounded bg-slate-500 px-1.5 py-0.5 text-[10px] font-bold"
          >
            农民
          </span>
          <span
            v-if="agentIds.length === 3"
            class="rounded bg-amber-700/80 px-1.5 py-0.5 text-[10px] font-bold"
          >
            4 人局（无大小王）
          </span>
        </div>
      </div>

      <!-- 你最近一次出牌（在你面前展示，下次出牌覆盖） -->
      <div v-if="meLastPlay.length" class="mb-1 flex items-center justify-center">
        <div
          class="flex items-center gap-1.5 rounded-xl border border-amber-300/30 bg-black/45 px-3 py-1 shadow"
        >
          <!-- <span class="text-[10px] tracking-wide text-amber-200/80">你出过</span> -->
          <div
            v-for="(c, i) in meLastPlay"
            :key="c.id"
            class="animate-card-fly"
            :style="{ marginLeft: i === 0 ? '0' : '-22px', zIndex: i }"
          >
            <CardComp :card="c" small />
          </div>
        </div>
      </div>

      <HandCards
        v-if="state"
        :cards="state.myHand"
        :selected-ids="selectedIds"
        :disabled="!isMyTurn || !isPlaying"
        :flat="true"
        @toggle="toggleCard"
      />

      <div v-if="isPlaying" class="mt-2 flex justify-center gap-4">
        <button
          class="btn btn-primary px-7 py-2.5"
          :disabled="!isMyTurn || selectedIds.size === 0"
          @click="playSelected"
        >
          出牌
        </button>
        <button class="btn btn-slate px-7 py-2.5" :disabled="!isMyTurn" @click="pass">不出</button>
        <button class="btn btn-gold px-7 py-2.5" :disabled="!isMyTurn" @click="hint">提示</button>
      </div>
      <div v-else class="mt-2 h-[52px]"></div>
    </footer>

    <!-- 结算 -->
    <div
      v-if="isGameOver"
      class="absolute inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <div
        class="animate-win-glow w-[420px] max-w-[92vw] rounded-2xl border-2 border-amber-400/70 bg-gradient-to-b from-slate-800 to-slate-900 p-8 text-center shadow-2xl"
      >
        <div class="mb-1 text-5xl">{{ iWin ? "🎉" : "😢" }}</div>
        <div class="mb-1 text-3xl font-black">{{ iWin ? "你赢了！" : "你输了" }}</div>
        <div class="mb-5 text-white/75">
          {{ state?.winner === "landlord" ? "地主获胜" : "农民获胜" }}
          <span v-if="me?.role" class="text-white/50">
            · 你是{{ me?.role === "landlord" ? "地主" : "农民" }}
          </span>
        </div>
        <button class="btn btn-primary px-8 py-2.5" @click="newGame()">再来一局</button>
      </div>
      <div v-if="iWin" class="pointer-events-none absolute inset-0 overflow-hidden">
        <span
          v-for="n in 36"
          :key="n"
          class="confetti"
          :style="{
            left: ((n * 2.6) % 100) + '%',
            background: ['#fbbf24', '#fb7185', '#34d399', '#60a5fa', '#c084fc'][n % 5],
            animationDuration: 2.4 + (n % 5) * 0.3 + 's',
            animationDelay: (n % 7) * 0.12 + 's',
          }"
        ></span>
      </div>
    </div>
  </div>
</template>

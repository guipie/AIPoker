<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, ref, watch } from "vue";
import { sfx } from "../audio/sfx";
import CardComp from "../components/Card.vue";
import HoldemSeat from "../components/HoldemSeat.vue";
import AgentModelEditor from "../components/AgentModelEditor.vue";
import { SUIT_SYMBOL, rankLabel, type Card } from "../engine/cards";
import {
  HoldemGame,
  suggestHoldemAction,
  type AgentStyle,
  type HoldemState,
} from "../engine/holdem";
import { llmHoldemDecision, type LlmConfig } from "../engine/llm";
import { agentById, pickAgents, recordResult, store } from "../store";
import { checkAgents, configForAgent, type AgentConnResult } from "../utils/llmCheck";

const game = ref<HoldemGame | null>(null);
const state = ref<HoldemState | null>(null);
const busy = ref(false);
const thinkingId = ref<number | null>(null);
const raiseOpen = ref(false);
const agentIdsList = ref<string[]>([]);

let running = false;
let paused = false;
let winHandledForHand = -1;

const me = computed(() => state.value?.players.find(p => p.isHuman) ?? null);
const bots = computed(() => (state.value ? state.value.players.filter(p => !p.isHuman) : []));
const isMyTurn = computed(
  () =>
    state.value?.currentPlayerId === 0 &&
    (state.value.phase === "preflop" ||
      state.value.phase === "flop" ||
      state.value.phase === "turn" ||
      state.value.phase === "river")
);
const isHandOver = computed(
  () => state.value?.phase === "handover" || state.value?.phase === "showdown"
);
const isMatchOver = computed(() => state.value?.phase === "matchover");
const humanBust = computed(() => me.value?.isBusted ?? false);

const communityCards = computed<Card[]>(() => state.value?.community ?? []);
const pot = computed(() => state.value?.pot ?? 0);
const toCall = computed(() => state.value?.toCall ?? 0);
const myStack = computed(() => me.value?.stack ?? 0);

// ===== 座位定位（机器人环绕上弧，避免遮挡；人数多时缩放） =====
function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
function botStyle(i: number, n: number) {
  const start = 140;
  const span = 260;
  const angle = (start + (span * i) / n) * (Math.PI / 180);
  const rx = 38;
  const ry = 38;
  const x = clamp(50 + rx * Math.cos(angle), 12, 88);
  const y = clamp(55 + ry * Math.sin(angle), 8, 86);
  return { left: x + "%", top: y + "%", transform: "translate(-50%,-50%)" };
}

// ===== 筹码飞行动画 =====
const tableRef = ref<HTMLElement | null>(null);
const potRef = ref<HTMLElement | null>(null);
const seatRefs = new Map<number, HTMLElement>();
function setSeatRef(id: number, el: any) {
  if (el) seatRefs.set(id, el as HTMLElement);
  else seatRefs.delete(id);
}
const chipFx = ref<{ id: number; x: number; y: number; dx: number; dy: number; kind: string }[]>(
  []
);
let chipSeq = 0;
function flyChip(fromId: number, kind: "bet" | "win") {
  const table = tableRef.value;
  const potEl = potRef.value;
  if (!table || !potEl) return;
  const tr = table.getBoundingClientRect();
  const pr = potEl.getBoundingClientRect();
  const px = pr.left + pr.width / 2 - tr.left;
  const py = pr.top + pr.height / 2 - tr.top;
  const seatEl = seatRefs.get(fromId);
  let sx = px;
  let sy = py;
  if (seatEl) {
    const sr = seatEl.getBoundingClientRect();
    sx = sr.left + sr.width / 2 - tr.left;
    sy = sr.top + sr.height / 2 - tr.top;
  }
  const startX = kind === "bet" ? sx : px;
  const startY = kind === "bet" ? sy : py;
  const endX = kind === "bet" ? px : sx;
  const endY = kind === "bet" ? py : sy;
  const id = ++chipSeq;
  chipFx.value.push({ id, x: startX, y: startY, dx: endX - startX, dy: endY - startY, kind });
  setTimeout(() => {
    chipFx.value = chipFx.value.filter(c => c.id !== id);
  }, 850);
}

// ===== Agent 解析 =====
// 开局前的大模型连通性检查
const connChecking = ref(false);
const connErrors = ref<AgentConnResult[]>([]);
const lastList = ref<string[]>([]);
const agentMap = computed(() => {
  const m: Record<number, string> = {};
  agentIdsList.value.forEach((id, i) => (m[i + 1] = id));
  return m;
});
function agentFor(id: number) {
  return agentById(agentMap.value[id] ?? "");
}
function styleFor(id: number): AgentStyle {
  const a = agentFor(id);
  return { aggression: a?.aggression ?? 0.5, tightness: a?.tightness ?? 0.5 };
}
function llmConfigFor(id: number): LlmConfig {
  return configForAgent(agentFor(id));
}
function holdemLabel(c: Card): string {
  return SUIT_SYMBOL[c.suit] + rankLabel(c);
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** 开局入口：启用大模型时先检查牌桌上所有 agent 的连接，全部通过才真正开局 */
async function requestNewGame(ids?: string[]) {
  const list =
    ids && ids.length
      ? ids.slice(0, 8)
      : store.startAgents && store.startAgents.length
        ? store.startAgents.slice(0, 8)
        : pickAgents(5);
  agentIdsList.value = list;
  lastList.value = list;
  if (store.settings.enabled) {
    connChecking.value = true;
    connErrors.value = [];
    const res = await checkAgents(list);
    connChecking.value = false;
    const bad = res.filter((r) => !r.ok);
    if (bad.length) {
      connErrors.value = bad;
      sfx.lose();
      return; // 连接失败：不开始牌局
    }
    applyOnline(res); // 记录各 agent 的在线状态
  } else {
    // 未启用大模型：不做任何连通性判断，同时清掉上一次留下的错误遮罩
    agentOnline.value = {};
    connErrors.value = [];
  }
  buildAgentsFromList(list);
}

// 关闭大模型后，立刻清掉残留的“连接失败/去设置”提示（keep-alive 会保留下次仍是旧状态）
watch(
  () => store.settings.enabled,
  (on) => {
    if (!on) {
      connErrors.value = [];
      connChecking.value = false;
      agentOnline.value = {};
    }
  },
);

// 加减对手（重新发牌）
function addBot() {
  if (agentIdsList.value.length >= 8) return;
  const more = pickAgents(1, agentIdsList.value);
  if (!more.length) return;
  sfx.click();
  requestNewGame([...agentIdsList.value, ...more]);
}
function removeBot() {
  if (agentIdsList.value.length <= 2) return;
  sfx.click();
  requestNewGame(agentIdsList.value.slice(0, -1));
}
function buildAgentsFromList(list: string[]) {
  const names = list.map(id => agentById(id)?.name ?? "机器人");
  game.value = new HoldemGame({ names, agentIds: [undefined, ...list] });
  state.value = game.value.getState();
  raiseOpen.value = false;
  winHandledForHand = -1;
  paused = false;
  store.activeGame = "holdem";
  sfx.deal();
  driveBots();
}

async function maybeStart() {
  if (store.pendingNewGame === "holdem") {
    store.pendingNewGame = null;
    await requestNewGame();
  } else if (!game.value) {
    await requestNewGame();
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
    for (let i = 0; i < 300; i++) {
      const s = state.value;
      if (!s || s.phase === "handover" || s.phase === "matchover") break;
      if (paused) break;
      if (s.currentPlayerId === 0 || s.currentPlayerId == null) break;

      thinkingId.value = s.currentPlayerId;
      await sleep(500 + Math.random() * 450);
      if (paused) break;

      const id = s.currentPlayerId;
      const player = s.players[id];
      let action: "fold" | "check" | "call" | "raise" = "check";
      let raiseTo: number | undefined;

      if (store.settings.enabled && (store.settings.apiKey || agentFor(id)?.apiKey)) {
        const aid = agentMap.value[id];
        let llmErr: string | null = null;
        try {
          const out = await llmHoldemDecision(
            llmConfigFor(id),
            {
              hole: player.hole.map(holdemLabel),
              community: s.community.map(holdemLabel),
              pot: s.pot,
              toCall: s.toCall,
              minRaise: s.minRaise,
              stack: player.stack,
              currentBet: s.currentBet,
              players: s.players.map((p) => ({
                name: p.name,
                stack: p.stack,
                folded: p.hasFolded,
                committed: p.committed,
              })),
              position: player.isDealer ? "庄家" : "玩家",
              persona: agentFor(id)?.persona,
            },
            (msg) => {
              llmErr = msg;
              if (aid) markOffline(aid, msg);
            },
          );
          if (out) {
            action = out.action;
            raiseTo = out.raiseTo;
          }
          if (aid && !llmErr) markOnline(aid);
        } catch (e: any) {
          const emsg = e?.message ?? String(e);
          llmErr = emsg;
          if (aid) markOffline(aid, emsg);
        }
      }
      if (action === "check" && s.toCall > 0) action = "call";
      if (action === "raise" && (raiseTo == null || raiseTo <= s.currentBet))
        action = s.toCall > 0 ? "call" : "check";

      if (!store.settings.enabled || !store.settings.apiKey) {
        const a = suggestHoldemAction(s, id, styleFor(id));
        action = a.type;
        raiseTo = a.toAmount;
      }

      applyAndSound(id, action, raiseTo);
    }
  } finally {
    running = false;
  }
  thinkingId.value = null;

  if (state.value?.phase === "handover") {
    const win = state.value.winners.includes(0);
    recordResult("holdem", win, win ? "你赢下底池！" : "这手你没赢");
    win ? sfx.win() : sfx.lose();
  }
}

function resumeIfNeeded() {
  const s = state.value;
  if (!s) return;
  if (s.phase === "handover" || s.phase === "matchover") return;
  if (s.currentPlayerId === 0 || s.currentPlayerId == null) return;
  driveBots();
}

function applyAndSound(id: number, action: "fold" | "check" | "call" | "raise", raiseTo?: number) {
  const g = game.value!;
  if (action === "fold") {
    sfx.fold();
    state.value = g.fold(id);
  } else if (action === "check") {
    sfx.check();
    state.value = g.check(id);
  } else if (action === "call") {
    sfx.chip();
    state.value = g.call(id);
    flyChip(id, "bet");
  } else {
    sfx.bet();
    state.value = g.raiseTo(id, raiseTo ?? g.getState().currentBet + g.getState().minRaise);
    flyChip(id, "bet");
  }
  checkWinFx();
}

function checkWinFx() {
  const s = state.value;
  if (!s) return;
  if ((s.phase === "handover" || s.phase === "showdown") && s.winners.length) {
    if (winHandledForHand !== s.handNumber) {
      winHandledForHand = s.handNumber;
      nextTick(() => s.winners.forEach(w => flyChip(w, "win")));
    }
  }
}

// ===== 人类操作 =====
function humanAct(action: "fold" | "check" | "call") {
  if (!isMyTurn.value || busy.value) return;
  busy.value = true;
  raiseOpen.value = false;
  applyAndSound(0, action);
  busy.value = false;
  driveBots();
}

function humanRaise(kind: "min" | "half" | "pot" | "allin") {
  if (!isMyTurn.value || busy.value) return;
  const s = state.value!;
  let to: number;
  const minRaiseTo = s.currentBet > 0 ? s.currentBet + s.minRaise : s.minRaise;
  if (kind === "min") to = minRaiseTo;
  else if (kind === "half") to = s.currentBet + Math.max(s.minRaise, Math.round(s.pot * 0.5));
  else if (kind === "pot") to = s.currentBet + s.pot;
  else to = s.currentBet + me.value!.stack;
  to = Math.min(to, s.currentBet + me.value!.stack);
  busy.value = true;
  raiseOpen.value = false;
  sfx.bet();
  state.value = game.value!.raiseTo(0, to);
  flyChip(0, "bet");
  checkWinFx();
  busy.value = false;
  driveBots();
}

function nextHand() {
  if (!isHandOver.value || isMatchOver.value) return;
  sfx.click();
  state.value = game.value!.nextHand();
  raiseOpen.value = false;
  winHandledForHand = -1;
  if (state.value.phase !== "matchover") driveBots();
}

function backToPlaza() {
  sfx.click();
  paused = true;
  store.view = "plaza";
}

function goSettings() {
  sfx.click();
  paused = true;
  store.view = "settings";
}

// ===== 牌桌上各 agent 的大模型在线状态 =====
const agentOnline = ref<Record<string, { ok: boolean; model: string; error?: string; checking?: boolean }>>({});
const showEditor = ref(false);
const editAgentId = ref<string | null>(null);

function connFor(id: number) {
  const aid = agentMap.value[id];
  return aid ? agentOnline.value[aid] : undefined;
}

function applyOnline(res: AgentConnResult[]) {
  const map: Record<string, { ok: boolean; model: string; error?: string; checking?: boolean }> = {};
  for (const r of res) {
    const a = agentById(r.id);
    map[r.id] = { ok: r.ok, model: a?.model ?? store.settings.model, error: r.error };
  }
  agentOnline.value = map;
}

/** 重新检测牌桌上所有 agent（不阻断牌局，仅更新状态徽章） */
async function recheckAgents() {
  const ids = agentIdsList.value;
  if (!store.settings.enabled || !ids.length) {
    agentOnline.value = {};
    return;
  }
  applyOnline(await checkAgents(ids));
}

/** 某个 agent 的模型配置被修改后，单独重检它 */
async function recheckOne(id: string) {
  agentOnline.value = {
    ...agentOnline.value,
    [id]: { ok: false, model: agentById(id)?.model ?? store.settings.model, checking: true },
  };
  const r = (await checkAgents([id]))[0];
  if (r) {
    agentOnline.value = {
      ...agentOnline.value,
      [id]: { ok: r.ok, model: agentById(id)?.model ?? store.settings.model, error: r.error },
    };
  }
}

/** 运行时调用大模型失败 → 把该 agent 标记为不在线，并显示服务端原因 */
function markOffline(id: string, msg: string) {
  agentOnline.value = {
    ...agentOnline.value,
    [id]: { ok: false, model: agentById(id)?.model ?? store.settings.model, error: msg },
  };
}

/** 调用成功 → 若之前被标记为不在线，恢复为在线 */
function markOnline(id: string) {
  const prev = agentOnline.value[id];
  if (!prev || prev.ok) return;
  agentOnline.value = {
    ...agentOnline.value,
    [id]: { ok: true, model: agentById(id)?.model ?? store.settings.model },
  };
}

function openModelEditor(id: number) {
  const aid = agentMap.value[id];
  if (!aid) return;
  sfx.click();
  editAgentId.value = aid;
  showEditor.value = true;
}

const humanWon = computed(() => state.value?.winners.includes(0) ?? false);

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
      <div class="flex-1 px-4 text-center text-sm text-white/80">
        第 {{ state?.handNumber }} 手 · {{ state?.message }}
      </div>
      <div class="flex items-center gap-2">
        <span
          v-if="store.settings.enabled"
          class="rounded-full bg-gradient-to-r from-emerald-500 to-green-600 px-2 py-0.5 text-[10px] font-bold text-white shadow"
          title="已启用大模型大脑；未启用时对手使用内置规则引擎"
        >
          LLM 启用
        </span>
        <button
          v-if="store.settings.enabled"
          class="btn-ghost rounded-lg px-2 py-1.5 text-sm"
          @click="recheckAgents"
          title="重新检测牌桌上各 agent 的大模型连通性"
        >
          ⟳
        </button>
        <button
          class="btn-ghost rounded-lg px-2 py-1.5 text-sm"
          :disabled="agentIdsList.length >= 8"
          @click="addBot"
          title="加一个对手"
        >
          ➕
        </button>
        <button
          class="btn-ghost rounded-lg px-2 py-1.5 text-sm"
          :disabled="agentIdsList.length <= 2"
          @click="removeBot"
          title="减一个对手"
        >
          ➖
        </button>
        <button class="btn-ghost rounded-lg px-3 py-1.5 text-sm" @click="requestNewGame()">重开</button>
      </div>
    </header>

    <!-- 牌桌 -->
    <div class="relative flex flex-1 items-center justify-center px-3 py-3">
      <div class="wood-rail relative h-full w-full max-w-[1100px] rounded-[120px] p-3">
        <div
          ref="tableRef"
          class="felt-table relative h-full w-full overflow-hidden rounded-[100px]"
        >
          <div class="felt-weave pointer-events-none absolute inset-0"></div>

          <!-- 机器人座位（环绕上弧，避免遮挡） -->
          <div
            v-for="(p, i) in bots"
            :key="p.id"
            class="absolute"
            :ref="el => setSeatRef(p.id, el)"
            :style="botStyle(i, bots.length)"
          >
            <HoldemSeat
              :player="p"
              :agent="agentFor(p.id)"
              :is-current="thinkingId === p.id || state?.currentPlayerId === p.id"
              :reveal="isHandOver"
              :winner="state?.winners.includes(p.id) ?? false"
              :compact="bots.length > 5"
              :conn="connFor(p.id)"
              @edit-model="openModelEditor(p.id)"
            />
          </div>

          <!-- 中央：底池 + 公共牌 -->
          <div class="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <div
              ref="potRef"
              class="pot-glow flex flex-col items-center rounded-2xl border border-amber-400/40 bg-black/40 px-6 py-2"
            >
              <span class="text-[10px] tracking-widest text-amber-200/70">底池 POT</span>
              <span class="text-2xl font-black text-amber-300">💰 {{ pot }}</span>
            </div>
            <div class="flex min-h-[6.6rem] items-center justify-center gap-1.5">
              <div
                v-for="(c, i) in communityCards"
                :key="c.id"
                class="animate-card-fly"
                :style="{ marginLeft: i === 0 ? '0' : '0' }"
              >
                <CardComp :card="c" size="lg" />
              </div>
              <div
                v-for="n in 5 - communityCards.length"
                :key="'e' + n"
                class="h-[6.6rem] w-[4.6rem] rounded-lg border border-dashed border-white/20"
              ></div>
            </div>
          </div>

          <!-- 筹码飞行动画层 -->
          <div class="pointer-events-none absolute inset-0 z-[60]">
            <div
              v-for="c in chipFx"
              :key="c.id"
              class="chip-fx"
              :class="c.kind === 'bet' ? 'chip-fx-bet' : 'chip-fx-win'"
              :style="{
                left: c.x + 'px',
                top: c.y + 'px',
                '--dx': c.dx + 'px',
                '--dy': c.dy + 'px',
              }"
            ></div>
          </div>
        </div>
      </div>
    </div>

    <!-- 底部：自己的手牌 + 信息 + 操作 -->
    <footer
      class="z-20 shrink-0 border-t border-white/10 bg-black/45 px-4 pb-3 pt-2 shadow-[0_-8px_24px_rgba(0,0,0,0.45)]"
    >
      <div class="mb-1 flex items-center justify-center gap-3 text-sm">
        <div class="flex items-center gap-2" :ref="el => setSeatRef(0, el)">
          <div
            class="flex h-8 w-8 items-center justify-center rounded-full border-2 border-amber-300 bg-gradient-to-br from-amber-400 to-amber-700 text-sm font-black text-amber-950"
            :class="state?.currentPlayerId === 0 ? 'avatar-ring-active' : ''"
          >
            你
          </div>
          <span class="font-bold">你</span>
          <span class="rounded bg-amber-500/90 px-1.5 py-0.5 text-[10px] font-bold text-amber-950">
            💰 {{ myStack }}
          </span>
          <span
            v-if="state?.currentPlayerId === 0"
            class="rounded-full bg-emerald-500/90 px-2 py-0.5 text-[10px] font-bold text-white"
          >
            你的回合
          </span>
          <span
            v-if="humanBust"
            class="rounded-full bg-rose-700 px-2 py-0.5 text-[10px] font-bold text-white"
          >
            已输光
          </span>
        </div>
      </div>

      <div class="flex min-h-[6.6rem] items-end justify-center gap-2 pb-1">
        <CardComp v-for="c in me?.hole ?? []" :key="c.id" :card="c" size="lg" />
      </div>

      <div v-if="isMyTurn" class="mt-1 flex flex-col items-center gap-2">
        <div class="flex justify-center gap-3">
          <button class="btn btn-slate px-6 py-2.5" @click="humanAct('fold')">弃牌</button>
          <button
            v-if="toCall === 0"
            class="btn btn-primary px-6 py-2.5"
            @click="humanAct('check')"
          >
            过牌
          </button>
          <button v-else class="btn btn-primary px-6 py-2.5" @click="humanAct('call')">
            跟注 {{ toCall }}
          </button>
          <button class="btn btn-rose px-6 py-2.5" @click="raiseOpen = !raiseOpen">加注</button>
        </div>
        <div v-if="raiseOpen" class="flex flex-wrap justify-center gap-2">
          <button class="btn btn-gold px-4 py-1.5 text-xs" @click="humanRaise('min')">
            最小 {{ state!.currentBet > 0 ? state!.currentBet + state!.minRaise : state!.minRaise }}
          </button>
          <button class="btn btn-gold px-4 py-1.5 text-xs" @click="humanRaise('half')">½ 池</button>
          <button class="btn btn-gold px-4 py-1.5 text-xs" @click="humanRaise('pot')">底池</button>
          <button class="btn btn-gold px-4 py-1.5 text-xs" @click="humanRaise('allin')">
            全下
          </button>
        </div>
      </div>
      <div v-else-if="isHandOver && !isMatchOver" class="mt-2 flex justify-center">
        <button class="btn btn-primary px-8 py-2.5" @click="nextHand">下一手 →</button>
      </div>
      <div v-else class="mt-2 h-[52px]"></div>
    </footer>

    <!-- 每手结算 -->
    <div
      v-if="isHandOver && !isMatchOver"
      class="pointer-events-none absolute inset-0 z-40 flex items-center justify-center"
    >
      <div class="animate-win-glow rounded-2xl bg-black/70 px-6 py-4 text-center backdrop-blur-sm">
        <div class="text-3xl font-black" :class="humanWon ? 'text-amber-300' : 'text-rose-300'">
          {{ humanWon ? "🎉 你赢下底池！" : "😶 这手没赢" }}
        </div>
        <div class="mt-1 text-sm text-white/70">{{ state?.resultText }}</div>
      </div>
    </div>

    <!-- 整局结束 / 人类破产 -->
    <div
      v-if="isMatchOver"
      class="absolute inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm"
    >
      <div
        class="animate-win-glow w-[440px] max-w-[92vw] rounded-2xl border-2 border-amber-400/70 bg-gradient-to-b from-slate-800 to-slate-900 p-8 text-center shadow-2xl"
      >
        <div class="mb-1 text-5xl">{{ humanBust ? "💀" : "🏆" }}</div>
        <div class="mb-2 text-3xl font-black">{{ humanBust ? "你已输光筹码" : "对局结束" }}</div>
        <div class="mb-5 text-white/75">
          {{ state?.resultText || (humanBust ? "筹码已归零，无法继续" : "有玩家筹码耗尽") }}
        </div>
        <div class="flex justify-center gap-3">
          <button class="btn btn-primary px-6 py-2.5" @click="requestNewGame()">重开一局</button>
          <button class="btn-ghost rounded-xl px-6 py-2.5 text-sm" @click="backToPlaza">
            {{ humanBust ? "退出牌局" : "返回广场" }}
          </button>
        </div>
      </div>
    </div>

    <!-- 开局前：大模型连通性检测中 -->
    <div
      v-if="connChecking"
      class="absolute inset-0 z-[70] flex items-center justify-center bg-black/70 backdrop-blur-sm"
    >
      <div
        class="flex flex-col items-center gap-3 rounded-2xl border border-white/15 bg-slate-900/90 px-8 py-6 shadow-2xl"
      >
        <div class="text-3xl">🔌</div>
        <div class="text-sm text-white/80">正在检测牌桌上所有 AI 对手的大模型连接…</div>
        <span class="flex gap-1"
          ><i class="thinking-dot h-2 w-2 rounded-full bg-amber-300"></i
          ><i class="thinking-dot h-2 w-2 rounded-full bg-amber-300" style="animation-delay: 0.18s"></i
          ><i class="thinking-dot h-2 w-2 rounded-full bg-amber-300" style="animation-delay: 0.36s"></i
        ></span>
      </div>
    </div>

    <!-- 开局前：有 agent 连接失败，禁止开始 -->
    <div
      v-if="store.settings.enabled && connErrors.length && !connChecking"
      class="absolute inset-0 z-[70] flex items-center justify-center bg-black/75 p-4 backdrop-blur-sm"
    >
      <div
        class="w-[460px] max-w-[92vw] rounded-2xl border-2 border-rose-400/70 bg-gradient-to-b from-slate-800 to-slate-900 p-6 text-center shadow-2xl"
      >
        <div class="mb-1 text-4xl">🔌</div>
        <div class="mb-1 text-xl font-black text-rose-200">大模型连接失败，无法开始牌局</div>
        <div class="mb-4 text-sm text-white/70">以下 AI 对手无法连通其大模型，请检查 Key / 接口地址：</div>
        <div class="mb-4 max-h-52 space-y-2 overflow-y-auto text-left">
          <div
            v-for="e in connErrors"
            :key="e.id"
            class="rounded-lg border border-rose-400/30 bg-black/40 px-3 py-2"
          >
            <div class="text-sm font-bold text-white">{{ e.name }}</div>
            <div class="text-xs text-rose-200/90">{{ e.error }}</div>
          </div>
        </div>
        <div class="mb-4 text-xs text-white/45">
          提示：可到「Agent 广场」点卡片上的「✏️ 模型」修改该 agent 的接口 / Key / 模型名；
          或到「设置」修正全局 Key，或关闭大模型改用内置规则引擎。
        </div>
        <div class="flex flex-wrap justify-center gap-3">
          <button class="btn btn-slate px-5 py-2 text-sm" @click="requestNewGame(lastList)">重试</button>
          <button class="btn btn-ghost px-5 py-2 text-sm" @click="goSettings">去设置</button>
          <button class="btn btn-primary px-5 py-2 text-sm" @click="backToPlaza">返回广场</button>
        </div>
      </div>
    </div>
    <!-- 修改某个 agent 的模型配置（与广场共用同一个弹窗） -->
    <AgentModelEditor
      :open="showEditor"
      :agent-id="editAgentId"
      @close="showEditor = false"
      @saved="recheckOne"
    />
  </div>
</template>

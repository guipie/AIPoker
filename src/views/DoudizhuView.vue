<script setup lang="ts">
import { computed, nextTick, onActivated, onDeactivated, onMounted, ref, watch } from "vue";
import { sfx, type DdzSoundKind } from "../audio/sfx";
import AgentModelEditor from "../components/AgentModelEditor.vue";
import CardComp from "../components/Card.vue";
import DoudizhuSeat from "../components/DoudizhuSeat.vue";
import HandCards from "../components/HandCards.vue";
import { SUIT_SYMBOL, ddzValue, ddzValueLabel, rankLabel, type Card } from "../engine/cards";
import {
  DoudizhuGame,
  detectPattern,
  suggestBid,
  type DdzAction,
} from "../engine/doudizhu";
import {
  bestPlay,
  candidatesForLlm,
  enumeratePlays,
  toLlmChoices,
  type LlmChoice,
  type PlayContext,
} from "../engine/ddzCandidates";
import { llmDdzBid, llmDdzDecision, type LlmCallOptions, type LlmConfig } from "../engine/llm";
import { addMatchLog, agentById, pickAgents, recordResult, store } from "../store";
import { configForAgent, shouldUseLlm } from "../utils/llmCheck";
import { useAgentConnection } from "../composables/useAgentConnection";
import { newLogId, type MatchLogEntry } from "../types/match";

const game = ref<DoudizhuGame | null>(null);
const state = ref<any>(null);
const selectedIds = ref<Set<string>>(new Set());
const busy = ref(false);
const thinkingId = ref<number | null>(null);
const agentIds = ref<string[]>([]);

// 开局前的大模型连通性检查（斗地主 / 德州共用同一套 composable）
const conn = useAgentConnection();
const connChecking = conn.checking;
const connErrors = conn.errors;
const agentOnline = conn.online;
const lastList = conn.lastIds;
const { markOffline, markOnline, recheckOne, connOf } = conn;

let running = false;
let paused = false;
/** 牌局序号：每开一局 +1，用来丢弃「上一局还没回来的大模型结果」 */
let gameSeq = 0;
/**
 * 换局时中断在途的大模型请求。
 * 取消超时后一次思考可能几分钟，旧局不清掉会一直占着连接（也白烧 token）。
 */
let llmAbort: AbortController | null = null;

function armLlmAbort() {
  llmAbort?.abort();
  llmAbort = new AbortController();
  return llmAbort.signal;
}

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

// 上一轮真正打出的牌快照：新一轮开始（大家都不要）时引擎会清空 lastPlay，
// 这里留一份，好让「PASS」有东西可盖——否则桌面一空，谁不要了根本看不出来。
const lastRoundCards = ref<Card[]>([]);
const lastRoundBy = ref<number | null>(null);

// 桌面中央：当前需要压过的那一手；没有则沿用上一轮快照（会盖 PASS）
const centerCards = computed<Card[]>(() => {
  const lp = state.value?.lastPlay as Card[] | null | undefined;
  if (lp && lp.length) return lp;
  return lastRoundCards.value;
});

/** 中央区是否要盖 PASS：最近一个动作是「不出」就盖，并数出连续几家不要 */
const passOverlay = computed<{ name: string; count: number; freeLead: boolean } | null>(() => {
  const s = state.value;
  if (!s || s.phase !== "playing") return null;
  const acts: DdzAction[] = s.recentActions ?? [];
  let count = 0;
  let who: number | null = null;
  for (let i = acts.length - 1; i >= 0; i--) {
    if (acts[i].type !== "pass") break;
    count++;
    if (who === null) who = acts[i].playerId;
  }
  if (!count || who === null) return null;
  return {
    name: s.players[who]?.name ?? `玩家${who}`,
    count,
    freeLead: !s.lastPlay, // 其余人全不要 → 上一手作废，由打出者重新领出
  };
});

/** 每个座位最近一个动作是不是「不出」（自己上一次出的牌上盖 PASS） */
const passFlags = computed<Record<number, boolean>>(() => {
  const flags: Record<number, boolean> = {};
  for (const a of (state.value?.recentActions ?? []) as DdzAction[]) {
    flags[a.playerId] = a.type === "pass";
  }
  return flags;
});
const myPassed = computed(() => passFlags.value[0] ?? false);

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
  return configForAgent(agentFor(id));
}

function ddzLabel(c: Card): string {
  if (c.suit === "joker") return c.rank === 17 ? "大王" : "小王";
  return SUIT_SYMBOL[c.suit] + rankLabel(c);
}

// ===== 出牌播报：念牌名（对二 / 炸弹 / 不要）+ 牌型音效 =====
/** 斗地主牌桌上的中文叫法：J=勾、Q=圈、K=凯、A=尖、2=二 */
const CN_RANK: Record<number, string> = {
  3: "三",
  4: "四",
  5: "五",
  6: "六",
  7: "七",
  8: "八",
  9: "九",
  10: "十",
  11: "勾",
  12: "圈",
  13: "凯",
  14: "尖",
  15: "二",
  16: "小王",
  17: "大王",
};

/** 一手牌该念什么 + 用哪种音型 */
function announceOf(cards: Card[]): { label: string; kind: DdzSoundKind } {
  const p = detectPattern(cards);
  if (!p) return { label: "出牌", kind: "single" };
  const n = CN_RANK[p.mainRank] ?? String(p.mainRank);
  switch (p.type) {
    case "rocket":
      return { label: "王炸", kind: "rocket" };
    case "bomb":
      return { label: "炸弹", kind: "bomb" };
    case "single":
      return { label: n, kind: "single" };
    case "pair":
      return { label: `对${n}`, kind: "pair" };
    case "triple":
      return { label: `三张${n}`, kind: "triple" };
    case "triple_single":
      return { label: "三带一", kind: "triple_single" };
    case "triple_pair":
      return { label: "三带二", kind: "triple_pair" };
    case "straight":
      return { label: "顺子", kind: "straight" };
    case "pair_straight":
      return { label: "连对", kind: "pair_straight" };
    case "airplane":
      return { label: "飞机", kind: "airplane" };
    case "airplane_single":
      return { label: "飞机带单", kind: "airplane_single" };
    case "airplane_pair":
      return { label: "飞机带对", kind: "airplane_pair" };
    case "four_two_single":
      return { label: "四带二", kind: "four_two_single" };
    case "four_two_pair":
      return { label: "四带两对", kind: "four_two_pair" };
  }
}

function roleText(r: string | null | undefined): string {
  return r === "landlord" ? "地主" : r === "farmer" ? "农民" : "未定";
}

/** 相对“我”的方位：下家 / 上家 / 对家（4 人局） */
function relationOf(pid: number, myId: number, n: number): string {
  const delta = (pid - myId + n) % n;
  if (delta === 0) return "";
  if (delta === 1) return "下家";
  if (delta === n - 1) return "上家";
  if (n === 4 && delta === 2) return "对家";
  return "";
}

/**
 * 组装候选决策上下文。规则 AI 与大模型共用同一份「合法候选枚举」，
 * 这样模型的选项永远合法，且它选的和规则 AI 认为最优的在同一坐标系里。
 */
function playContextOf(s: any, player: any): PlayContext {
  const landlord = s.players.find((p: any) => p.role === "landlord") ?? null;
  const handCounts: Record<number, number> = {};
  for (const p of s.players) handCounts[p.id] = p.handCount;
  return {
    hand: player.hand as Card[],
    last: s.lastPlay ? detectPattern(s.lastPlay) : null,
    lastPlayerId: s.lastPlayerId ?? null,
    myId: player.id,
    landlordId: landlord ? landlord.id : null,
    handCounts,
  };
}

/**
 * 剩余未出现的牌。让大模型直接读结果，而不是让它从 playedCards 里自己数——
 * 数错牌是 LLM 打斗地主最常见的失分项。
 */
function remainingHint(s: any, player: any): string {
  const hasJoker = s.players.length === 3;
  const total = new Map<number, number>();
  for (let v = 3; v <= 15; v++) total.set(v, 4);
  if (hasJoker) {
    total.set(16, 1);
    total.set(17, 1);
  }
  const used = new Map<number, number>();
  const bump = (v: number) => used.set(v, (used.get(v) ?? 0) + 1);
  for (const c of player.hand as Card[]) bump(ddzValue(c));
  for (const c of (s.playedCards ?? []) as Card[]) bump(ddzValue(c));
  const parts: string[] = [];
  for (const [v, t] of [...total].sort((a, b) => b[0] - a[0])) {
    const left = t - (used.get(v) ?? 0);
    if (left > 0) parts.push(`${ddzValueLabel(v)}×${left}`);
  }
  return parts.length
    ? `【尚未出现的牌】（已剔除你的手牌与全场已出牌，用来判断对手手里还剩什么大牌）\n${parts.join("  ")}`
    : "";
}

/** 组装给大模型的完整牌局上下文（配合 prompts.ts 的 doudizuRules） */
function buildDdzInput(s: any, player: any, choices?: LlmChoice[], hint?: string) {
  const n = s.players.length;
  const landlord = s.players.find((p: any) => p.role === "landlord") ?? null;
  const farmerIds = s.players.filter((p: any) => p.role === "farmer").map((p: any) => p.name);

  const seats = s.players.map((p: any) => ({
    name: p.id === player.id ? `${p.name}（我）` : p.name,
    role: roleText(p.role),
    handCount: p.handCount,
    relation: relationOf(p.id, player.id, n),
    isMe: p.id === player.id,
  }));

  const recentActions = (s.recentActions ?? []).map((a: any) => {
    const who = s.players[a.playerId]?.name ?? "?";
    return a.type === "pass"
      ? `${who}：不出`
      : `${who}：出 ${(a.cards ?? []).map(ddzLabel).join(" ")}`;
  });

  return {
    num: n as 3 | 4,
    myId: player.name,
    landlordId: landlord ? landlord.name : "（尚未确定）",
    farmerIds,
    hand: player.hand.map(ddzLabel),
    lastPlay: s.lastPlay ? s.lastPlay.map(ddzLabel) : null,
    playedCards: (s.playedCards ?? []).map(ddzLabel),
    seats,
    recentActions,
    persona: agentFor(player.id)?.persona,
    // 关键：把引擎枚举好的合法候选编号交给模型，让它做选择题
    candidates: choices ?? toLlmChoices(playContextOf(s, player), ddzLabel, 14),
    cardCountHint: hint ?? remainingHint(s, player),
  };
}

/** 前面玩家的抢地主记录（喂给 qiangDoudizuRules 的 prePersons） */
function buildPrePersons(s: any) {
  return (s.bidHistory ?? []).map((b: any) => ({
    id: s.players[b.playerId]?.name ?? `玩家${b.playerId}`,
    action: (b.score > 0 ? "snatch" : "pass") as "snatch" | "pass",
    ...(b.score > 0 ? { snatchScore: b.score } : {}),
  }));
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ===== 思考态：等了多久 + 模型的推理过程（reasoning_content） =====
// 去掉超时后，「它在想」和「它挂了」在界面上必须能区分开：座位显示已等待秒数。
const thinkingSince = ref<number | null>(null);
const nowTick = ref(Date.now());
/** pid → 该 agent 最近一次决策的思考文本（流式累积） */
const thoughts = ref<Record<number, string>>({});
/** 正在查看谁家思考过程的弹层 */
const thoughtPid = ref<number | null>(null);
const thoughtBox = ref<HTMLElement | null>(null);
let tickTimer: ReturnType<typeof setInterval> | null = null;

const waitedSec = computed(() =>
  thinkingSince.value == null
    ? 0
    : Math.max(0, Math.floor((nowTick.value - thinkingSince.value) / 1000))
);

function beginThinking(pid: number) {
  thinkingId.value = pid;
  thinkingSince.value = Date.now();
  nowTick.value = Date.now();
}
function endThinking() {
  thinkingId.value = null;
  thinkingSince.value = null;
}
function addThought(pid: number, chunk: string) {
  thoughts.value = { ...thoughts.value, [pid]: (thoughts.value[pid] ?? "") + chunk };
}
function resetThought(pid: number) {
  if (!thoughts.value[pid]) return;
  thoughts.value = { ...thoughts.value, [pid]: "" };
}
function openThoughts(pid: number) {
  sfx.click();
  thoughtPid.value = pid;
}
function startTick() {
  if (tickTimer) return;
  tickTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 1000);
}
function stopTick() {
  if (!tickTimer) return;
  clearInterval(tickTimer);
  tickTimer = null;
}

/** 弹层当前展示的座位与该座的思考文本 */
const thoughtPlayer = computed(() =>
  thoughtPid.value == null ? null : (state.value?.players?.[thoughtPid.value] ?? null)
);
const currentThought = computed(() =>
  thoughtPid.value == null ? "" : (thoughts.value[thoughtPid.value] ?? "")
);

// ===== 大模型调用失败：暂停该 agent 的决策，等用户点「重试」 =====
type LlmStage = "抢地主" | "出牌";
interface LlmFailInfo {
  playerId: number;
  playerName: string;
  agentId: string;
  agentName: string;
  stage: LlmStage;
  error: string;
  attempts: number;
}
type LlmFailChoice = "retry" | "fallback" | "mute";

const llmFail = ref<LlmFailInfo | null>(null);
/** 用户选择「本局不再提示」后，后续调用失败直接回退规则引擎，不再打断牌局 */
const llmFailMuted = ref(false);
let llmFailResolve: ((c: LlmFailChoice) => void) | null = null;

function askLlmFail(info: LlmFailInfo): Promise<LlmFailChoice> {
  return new Promise(resolve => {
    llmFailResolve = resolve;
    llmFail.value = info;
  });
}

function resolveLlmFail(choice: LlmFailChoice) {
  const r = llmFailResolve;
  llmFailResolve = null;
  llmFail.value = null;
  r?.(choice);
}

/** 弹窗里的「✏️ 改模型」：直接打开该 agent 的模型配置 */
function editFailModel() {
  const pid = llmFail.value?.playerId;
  if (pid == null) return;
  openModelEditor(pid);
}

/**
 * 调一次大模型；失败时把选择权交回用户（重试 / 用规则引擎 / 静默）。
 * 「重试」会先重新体检该 agent 的连接（刷新在线徽章并给出更准的错误原因），
 * 再重跑这一手的决策——不会像以前那样静默退化成规则 AI。
 */
async function withLlmRetry<T>(
  pid: number,
  stage: LlmStage,
  call: (opts: LlmCallOptions) => Promise<T | null>
): Promise<T | null> {
  const aid = agentMap.value[pid] ?? "";
  let attempts = 0;
  for (;;) {
    let err: string | null = null;
    let out: T | null = null;
    let aborted = false;
    try {
      out = await call({
        onError: msg => {
          err = msg;
          if (aid) markOffline(aid, msg);
        },
        // 思考过程流式回传：座位上点「›」就能看它在想什么
        hooks: {
          onThinking: chunk => addThought(pid, chunk),
          onRestart: () => resetThought(pid),
        },
        signal: llmAbort?.signal,
      });
    } catch (e: any) {
      // 换局导致的中断：既不算失败，也不要弹重试面板
      if (e?.name === "AbortError") aborted = true;
      else {
        err = String(e?.message ?? e ?? "调用异常");
        if (aid) markOffline(aid, err);
      }
    }
    if (aborted) return null;
    if (aid && !err) markOnline(aid);
    if (out != null) return out;
    attempts++;
    if (llmFailMuted.value) return null; // 已静默：不再打断牌局
    const choice = await askLlmFail({
      playerId: pid,
      playerName: state.value?.players?.[pid]?.name ?? `玩家${pid}`,
      agentId: aid,
      agentName: agentFor(pid)?.name ?? "AI 对手",
      stage,
      error: err ?? "大模型返回的内容无法解析（不是合法 JSON / 没给决策）",
      attempts,
    });
    if (choice === "retry") {
      if (aid) await recheckOne(aid);
      continue;
    }
    if (choice === "mute") llmFailMuted.value = true;
    return null;
  }
}

// ===== 对局明细记录（抢地主 + 每一手出牌，结束后入库） =====
const matchEntries = ref<MatchLogEntry[]>([]);
const initialHands = ref<{ pid: number; name: string; role: string; hand: string[] }[]>([]);
const bottomSnapshot = ref<string[]>([]);
const lastLogId = ref<string | null>(null);
let logClosed = false;

function pushLog(e: MatchLogEntry) {
  matchEntries.value.push(e);
}

/** 出牌（统一入口）：真的生效了才写日志 + 播报 */
function doPlay(
  pid: number,
  ids: string[],
  meta: { source: "llm" | "rule" | "human"; reason?: string }
) {
  const g = game.value!;
  const hand = state.value.players[pid].hand as Card[];
  const cards = ids.map(id => hand.find(x => x.id === id)).filter((c): c is Card => !!c);
  const labels = cards.map(ddzLabel);
  const before = state.value.actionCount ?? 0;
  const next = g.play(pid, ids);
  applyState(next);
  if ((next.actionCount ?? 0) > before) {
    pushLog({
      kind: "play",
      playerId: pid,
      playerName: next.players[pid].name,
      cards: labels,
      handLeft: next.players[pid].handCount,
      source: meta.source,
      reason: meta.reason,
    });
    // 每次出牌都播报：念牌名（对二 / 炸弹）+ 牌型音效
    const a = announceOf(cards);
    sfx.playDdz(a.label, a.kind);
    return true;
  }
  return false;
}

/** 不出（统一入口）：真的生效了才写日志 */
function doPass(pid: number, meta: { source: "llm" | "rule" | "human"; reason?: string }) {
  const g = game.value!;
  const before = state.value.actionCount ?? 0;
  const next = g.pass(pid);
  applyState(next);
  if ((next.actionCount ?? 0) > before) {
    pushLog({
      kind: "pass",
      playerId: pid,
      playerName: next.players[pid].name,
      handLeft: next.players[pid].handCount,
      source: meta.source,
      reason: meta.reason,
    });
    sfx.playDdz("不要", "pass");
    return true;
  }
  return false;
}

/** 抢地主（统一入口） */
function doBid(
  pid: number,
  score: number,
  meta: { source: "llm" | "rule" | "human"; reason?: string }
) {
  const curBid = state.value.currentBid ?? 0;
  // 引擎会把“叫分不高于当前最高分”当作不叫，这里同步算出生效值用于记录
  const eff = score !== 0 && score <= curBid ? 0 : score;
  const next = game.value!.bid(pid, score);
  applyState(next);
  pushLog({
    kind: "bid",
    playerId: pid,
    playerName: (next.players[pid] ?? state.value.players[pid]).name,
    score: eff,
    source: meta.source,
    reason: meta.reason,
  });
  sfx.say(eff > 0 ? `${eff}分` : "不叫");
}

/** 一局结束：把明细入库，并在战绩里挂上 logId */
function finalizeMatch(win: boolean) {
  if (logClosed) return;
  logClosed = true;
  const s = state.value;
  if (!s) return;
  const landlord = s.players.find((p: any) => p.role === "landlord");
  const id = newLogId("ddz");
  const text = win ? "你赢了这局斗地主！" : "这局斗地主你输了";
  type SeatSnap = { pid: number; name: string; role: string; hand: string[] };
  const seats: SeatSnap[] = initialHands.value.length
    ? initialHands.value
    : s.players.map((p: any) => ({
        pid: p.id,
        name: p.name,
        role: roleText(p.role),
        hand: p.hand.map(ddzLabel),
      }));
  addMatchLog({
    id,
    mode: "ddz",
    time: Date.now(),
    result: win ? "胜" : "负",
    summary: text,
    players: s.players.map((p: any) => p.name),
    detail: {
      kind: "ddz",
      players: seats.map((h: SeatSnap) => ({
        name: h.pid === 0 ? "你" : h.name,
        role: h.role,
        agent: h.pid === 0 ? "（你本人）" : agentById(agentMap.value[h.pid] ?? "")?.name ?? "",
        hand: h.hand,
      })),
      landlordName: landlord?.name ?? "",
      bottomCards: bottomSnapshot.value,
      myRole: roleText(me.value?.role),
      winner: s.winner === "landlord" ? "地主" : "农民",
      redealCount: s.redealCount ?? 0,
    },
    entries: [...matchEntries.value],
  });
  lastLogId.value = id;
  recordResult("doudizhu", win, text, id);
}

/** 结算弹层：跳到战绩页并直接打开本局复盘 */
function viewMatchDetail() {
  if (!lastLogId.value) return;
  sfx.click();
  paused = true;
  store.pendingStatLogId = lastLogId.value;
  store.view = "stats";
}

function newGame(ids?: string[]) {
  const list = ids && ids.length ? ids.slice(0, 3) : pickAgents(2);
  agentIds.value = list;
  const names = list.map(id => agentById(id)?.name ?? "机器人");
  const noJokers = list.length >= 3; // 4 人局（3 机器人 + 你）去掉大小王
  game.value = new DoudizhuGame(names, "你", noJokers);
  state.value = game.value.getState();
  // 重置本局明细
  matchEntries.value = [];
  initialHands.value = [];
  bottomSnapshot.value = [];
  lastLogId.value = null;
  logClosed = false;
  selectedIds.value.clear();
  gameSeq++; // 旧局的在途请求（大模型可能还在想）一律作废
  armLlmAbort(); // 真的把旧请求掐掉，别让它继续烧 token
  endThinking();
  thoughts.value = {};
  thoughtPid.value = null;
  paused = false;
  // 重开时清掉桌面残留（上一轮的牌 / PASS 覆盖 / 失败提示静默开关）
  lastRoundCards.value = [];
  lastRoundBy.value = null;
  llmFailMuted.value = false;
  if (llmFailResolve) resolveLlmFail("fallback");
  resetHint();
  store.activeGame = "doudizhu";
  sfx.deal();
  driveBots();
}

/** 开局入口：启用大模型时先检查牌桌上所有 agent 的连接，全部通过才真正开局 */
async function requestNewGame(ids?: string[]) {
  const list = ids && ids.length ? ids.slice(0, 3) : pickAgents(2);
  const ok = await conn.checkBeforeStart(list);
  if (!ok) {
    sfx.lose();
    return; // 连接失败：不开始牌局
  }
  newGame(list);
}

// 加减机器人（重置发牌）
function addBot() {
  if (agentIds.value.length >= 3) return;
  const more = pickAgents(1, agentIds.value);
  if (more.length === 0) return;
  sfx.click();
  requestNewGame([...agentIds.value, ...more]);
}
function removeBot() {
  if (agentIds.value.length <= 2) return;
  sfx.click();
  requestNewGame(agentIds.value.slice(0, -1));
}

/** 防止 onMounted + onActivated 双触发：第一次还没检查完，第二次就把 pendingNewGame
 *  当成空、随机抽两个内置 agent 再查一遍 → 弹出「没配置大模型」的假面板，牌局却照常开始 */
let starting = false;
async function maybeStart() {
  if (starting) return;
  starting = true;
  try {
    if (store.pendingNewGame === "doudizhu") {
      store.pendingNewGame = null;
      const ids =
        store.startAgents && store.startAgents.length ? store.startAgents.slice(0, 3) : pickAgents(2);
      await requestNewGame(ids);
    } else if (!game.value) {
      await requestNewGame(pickAgents(2));
    } else {
      paused = false;
      resumeIfNeeded();
    }
  } finally {
    starting = false;
  }
}

async function driveBots() {
  if (running) return;
  if (paused) return;
  if (!state.value) return;
  // 没有超时之后，一次决策可能等很久；用局号判断「回来时是不是还是这一局」
  const seq = gameSeq;
  running = true;
  try {
    for (let i = 0; i < 200; i++) {
      const s = state.value;
      if (!s || s.phase === "gameover") break;
      if (paused) break;
      if (s.currentPlayerId === 0 || s.currentPlayerId == null) break;

      beginThinking(s.currentPlayerId);
      await sleep(550 + Math.random() * 500);
      if (paused || seq !== gameSeq) break;

      const player = s.players[s.currentPlayerId];
      if (s.phase === "bidding") {
        // 抢地主：启用大模型时让 LLM 决策（qiangDoudizuRules），失败/未启用才用规则评分
        let score = suggestBid(player.hand);
        let reason = "";
        let source: "llm" | "rule" = "rule";
        if (shouldUseLlm(agentFor(player.id))) {
          const out = await withLlmRetry(player.id, "抢地主", opts =>
            llmDdzBid(
              llmConfigFor(player.id),
              {
                num: s.players.length as 3 | 4,
                myHand: player.hand.map(ddzLabel),
                prePersons: buildPrePersons(s),
                persona: agentFor(player.id)?.persona,
              },
              opts
            )
          );
          if (seq !== gameSeq || paused) break; // 已重开/已离开 → 这次结果作废
          if (out) {
            source = "llm";
            reason = out.reason ?? "";
            if (out.action === "snatch") {
              let sc = out.snatchScore ?? 1;
              // 想抢就必须抢得比当前最高分更高，否则引擎会当作不抢
              if (sc <= s.currentBid) sc = s.currentBid + 1;
              score = sc >= 1 && sc <= 3 ? sc : 0;
            } else {
              score = 0;
            }
          }
        }
        doBid(player.id, score, { source, reason });
      } else {
        // 出牌阶段：引擎先枚举出**全部合法候选**，大模型与规则 AI 共用同一份。
        // 让模型做选择题，而不是自己凭空构造牌面——那是它最大的失分点。
        const ctx = playContextOf(s, player);
        const cands = candidatesForLlm(ctx, 14);
        const choices = cands.map((c, i) => ({
          index: i + 1,
          typeName: c.typeName,
          cards: c.cards.map(ddzLabel),
          handLeft: c.handLeft,
          isBomb: c.isBomb,
        }));
        const hint = remainingHint(s, player);

        let picked: Card[] | null = null; // 最终要出的牌
        let llmPass = false; // LLM 明确选择不出
        let source: "llm" | "rule" = "rule";
        let reason = ""; // LLM 给出的决策理由（写入明细）

        if (shouldUseLlm(agentFor(player.id))) {
          let out: Awaited<ReturnType<typeof llmDdzDecision>> = null;
          try {
            out = await withLlmRetry(player.id, "出牌", opts =>
              llmDdzDecision(llmConfigFor(player.id), buildDdzInput(s, player, choices, hint), opts)
            );
          } catch {
            out = null;
          }
          if (seq !== gameSeq || paused) break; // 已重开/已离开 → 这次结果作废
          if (out) {
            reason = out.reason ?? "";
            source = "llm";
            const ci = out.choice;
            if (typeof ci === "number" && Number.isInteger(ci)) {
              // 编号模式（首选）：0 = 不出，其余对应候选下标
              if (ci === 0) {
                llmPass = !!s.lastPlay; // 自由领出不能不出 → 视为无效，落回规则 AI
              } else {
                const hit = cands[ci - 1];
                if (hit) picked = hit.cards;
                else source = "rule"; // 编号越界 → 当作调用失败
              }
            } else if (out.play && out.play.length) {
              // 兼容旧格式：按牌面反查，必须每张都对得上，否则算失败
              const map = new Map(player.hand.map((c: Card) => [ddzLabel(c), c.id]));
              const ids = out.play.map((l: string) => map.get(l)).filter(Boolean) as string[];
              if (ids.length === out.play.length) {
                picked = ids.map(id => player.hand.find((c: Card) => c.id === id)!);
              } else {
                source = "rule";
              }
            } else {
              llmPass = true; // play 为 null/空 → 明确不出
            }
          }
        }

        if (picked && picked.length) {
          doPlay(player.id, picked.map(c => c.id), { source, reason });
        } else if (llmPass && s.lastPlay) {
          // 尊重 LLM 的「不出」（不压队友、保存实力）——不能被兜底覆盖
          doPass(player.id, { source: "llm", reason: reason || "选择不出" });
        } else {
          // 规则 AI：不再「有压就压最小的」，改用启发式评分从候选里选
          const cards = bestPlay(ctx);
          if (cards && cards.length) {
            doPlay(player.id, cards.map(c => c.id), { source: "rule", reason: "规则 AI 选牌" });
          } else {
            doPass(player.id, { source: "rule", reason: "规则 AI 无牌可压" });
          }
        }
      }
    }
  } finally {
    running = false;
  }
  // 换局时新局调用的 driveBots() 会因为 running 还是 true 直接 return，
  // 所以旧循环退出时必须自己把新局接上，否则新局第一手永远没人推。
  if (seq !== gameSeq) {
    driveBots();
    return;
  }
  endThinking();

  // 重开后旧局的结果不能再结算
  if (seq === gameSeq && state.value?.phase === "gameover") {
    const win = iWin.value;
    finalizeMatch(win);
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
  const prevPhase = state.value?.phase;
  const prevLast = ((state.value?.lastPlay ?? []) as Card[]).map(c => c.id).join(",");
  state.value = next;
  // 记录「上一轮真正打出的牌」：新一轮开始 lastPlay 被清空后，PASS 才有牌可盖
  if ((next?.lastPlay ?? []).length) {
    lastRoundCards.value = next.lastPlay as Card[];
    lastRoundBy.value = next.lastPlayerId ?? null;
  }
  // 场上要压的牌变了 → 清掉上一轮的提示（下次点提示会按新形势重算）
  if (prevLast !== ((next?.lastPlay ?? []) as Card[]).map(c => c.id).join(",")) resetHint();
  // 抢地主结束、正式开打的那一刻，快照各家手牌（含地主底牌），供复盘查看
  if (prevPhase === "bidding" && next.phase === "playing") {
    initialHands.value = next.players.map((p: any) => ({
      pid: p.id,
      name: p.name,
      role: roleText(p.role),
      hand: p.hand.map(ddzLabel),
    }));
    bottomSnapshot.value = (next.landlordCards ?? []).map(ddzLabel);
  }
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
  doPlay(0, ids, { source: "human" });
  selectedIds.value.clear();
  resetHint();
  busy.value = false;
  driveBots();
}

function pass() {
  if (!isMyTurn.value || busy.value) return;
  busy.value = true;
  doPass(0, { source: "human" });
  selectedIds.value.clear();
  resetHint();
  busy.value = false;
  driveBots();
}

function bid(score: number) {
  if (!isMyTurn.value || !isBidding.value || busy.value) return;
  busy.value = true;
  doBid(0, score, { source: "human" });
  selectedIds.value.clear();
  busy.value = false;
  driveBots();
}

// ===== 提示：循环切换所有能压过上家的牌组 =====
const hintOptions = ref<Card[][]>([]);
const hintIdx = ref(-1);
const hintKey = ref("");
const hintMsg = ref("");
const hintEmpty = ref(false);

/** 手牌或上家的牌发生变化时，提示候选需要重新计算 */
function hintKeyOf() {
  const lastIds = ((state.value?.lastPlay ?? []) as Card[]).map(c => c.id).join(",");
  const handIds = ((me.value?.hand ?? []) as Card[]).map(c => c.id).join(",");
  return `${lastIds}#${handIds}`;
}

function resetHint() {
  hintOptions.value = [];
  hintIdx.value = -1;
  hintKey.value = "";
  hintMsg.value = "";
  hintEmpty.value = false;
}

function hint() {
  if (!isMyTurn.value || busy.value || !isPlaying.value) return;
  const last = state.value.lastPlay ? detectPattern(state.value.lastPlay) : null;
  const key = hintKeyOf();
  if (key !== hintKey.value) {
    // 与 agent 共用同一套候选枚举：按启发式评分降序，
    // 第一个提示就是「AI 认为最优的一手」，之后的循环才是备选
    const hctx: PlayContext = {
      hand: (me.value?.hand ?? []) as Card[],
      last,
      lastPlayerId: state.value.lastPlayerId ?? null,
      myId: 0,
      landlordId:
        (state.value.players as any[]).find((p: any) => p.role === "landlord")?.id ?? null,
      handCounts: Object.fromEntries(
        (state.value.players as any[]).map((p: any) => [p.id, p.handCount]),
      ),
    };
    hintOptions.value = enumeratePlays(hctx).map(k => k.cards);
    hintKey.value = key;
    hintIdx.value = -1;
  }
  if (hintOptions.value.length === 0) {
    selectedIds.value = new Set();
    hintEmpty.value = true;
    hintMsg.value = last
      ? `没有能压过 ${(state.value.lastPlay as Card[]).map(ddzLabel).join(" ")} 的牌，只能「不出」`
      : "没有可出的牌";
    sfx.fold();
    return;
  }
  hintEmpty.value = false;
  hintIdx.value = (hintIdx.value + 1) % hintOptions.value.length;
  const opt = hintOptions.value[hintIdx.value];
  selectedIds.value = new Set(opt.map(c => c.id));
  const p = detectPattern(opt);
  const tag =
    p?.type === "rocket" ? "王炸" : p?.type === "bomb" ? "炸弹" : patternName(p?.type ?? "");
  hintMsg.value = `第 ${hintIdx.value + 1}/${hintOptions.value.length} 个可选组合 · ${tag}`;
  sfx.click();
}

function patternName(t: string) {
  const m: Record<string, string> = {
    single: "单张",
    pair: "对子",
    triple: "三张",
    triple_single: "三带一",
    triple_pair: "三带二",
    straight: "顺子",
    pair_straight: "连对",
    airplane: "飞机",
    airplane_single: "飞机带单",
    airplane_pair: "飞机带对",
    four_two_single: "四带二",
    four_two_pair: "四带两对",
    bomb: "炸弹",
    rocket: "王炸",
  };
  return m[t] ?? "牌组";
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
const showEditor = ref(false);
const editAgentId = ref<string | null>(null);

/** 座位组件用：座位号 → 该 agent 的连接状态 */
function connFor(id: number) {
  return connOf(agentMap.value[id]);
}

/** 顶栏 ⟳：重检牌桌上所有 agent（不阻断牌局） */
function recheckAgents() {
  return conn.recheckAll(agentIds.value);
}

function openModelEditor(id: number) {
  const aid = agentMap.value[id];
  if (!aid) return;
  sfx.click();
  editAgentId.value = aid;
  showEditor.value = true;
}

// 对手座位定位：你（人类）在底部，对手沿上弧排开
// 2 个对手 → 左上 / 右上；3 个对手 → 左上 / 上中(对面) / 右上
// 座位沿上弧排开；中央 48% 处是「需压过的牌」，座位上移让出这块区域
function botStyle(i: number, n: number) {
  const t = "translate(-50%,-50%)";
  if (n <= 1) return { left: "50%", top: "20%", transform: t };
  if (n === 2) {
    return i === 0
      ? { left: "27%", top: "21%", transform: t }
      : { left: "73%", top: "21%", transform: t };
  }
  const pos = [
    { left: "22%", top: "34%", transform: t },
    { left: "50%", top: "17%", transform: t },
    { left: "78%", top: "34%", transform: t },
  ];
  return pos[i] ?? pos[0];
}

// 相对“你”（底部）的方位标签，让你一眼知道对面/左右是谁
function positionLabel(i: number, n: number): string {
  if (n <= 1) return "对面";
  if (n === 2) return i === 0 ? "左" : "右";
  return ["左", "对面", "右"][i] ?? "";
}

onMounted(() => {
  startTick();
  maybeStart();
});
onActivated(() => {
  startTick();
  maybeStart();
});
onDeactivated(() => {
  paused = true;
  stopTick();
});

// 思考过程是流式追加的：弹层开着时自动滚到底
watch(
  () => (thoughtPid.value != null ? (thoughts.value[thoughtPid.value] ?? "") : ""),
  () => {
    nextTick(() => {
      const el = thoughtBox.value;
      if (el) el.scrollTop = el.scrollHeight;
    });
  }
);
</script>

<template>
  <div
    class="relative flex h-full w-full flex-col text-white"
    style="background: radial-gradient(ellipse at 50% -10%, #2b1d11 0%, #150f08 55%, #0a0705 100%)"
  >
    <!-- 顶栏 -->
    <header
      class="z-20 flex h-12 shrink-0 items-center justify-between border-b border-white/10 bg-black/40 px-4 shadow-lg backdrop-blur"
    >
      <button class="btn-ghost rounded-lg px-3 py-1.5 text-sm" @click="backToPlaza">← 广场</button>
      <div class="flex-1 px-4 text-center text-sm text-white/80">{{ state?.message ?? "" }}</div>
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
          v-if="llmFailMuted"
          class="rounded-full bg-rose-500/25 px-2 py-0.5 text-[10px] font-bold text-rose-200 hover:bg-rose-500/40"
          title="本局内大模型调用失败不再打断牌局，直接回退内置规则引擎；点击恢复提示"
          @click="llmFailMuted = false"
        >
          失败已静默
        </button>
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
        <button class="btn-ghost rounded-lg px-3 py-1.5 text-sm" @click="requestNewGame()">
          重开
        </button>
      </div>
    </header>

    <!-- 牌桌 -->
    <div class="relative flex flex-1 items-center justify-center px-3 py-2">
      <div class="wood-rail relative h-full w-full max-w-[1240px] rounded-[150px] p-2.5">
        <div class="felt-table relative h-full w-full overflow-hidden rounded-[130px]">
          <div class="felt-weave pointer-events-none absolute inset-0"></div>
          <div
            class="table-emblem pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <svg viewBox="0 0 100 100" class="h-52 w-52 text-amber-100" fill="currentColor">
              <path
                d="M50 6C50 6 20 33 20 53c0 13 11 20 20 15-4 9-9 16-16 21h52c-7-5-12-12-16-21 9 5 20-2 20-15C80 33 50 6 50 6z"
              />
            </svg>
          </div>

          <!-- 机器人座位（你在对面下方，对手环绕桌面上方） -->
          <div
            v-for="(p, index) in bots"
            :key="p.id"
            class="absolute"
            :style="botStyle(Number(index), bots.length)"
          >
            <div
              class="mb-1 rounded-full bg-black/55 px-2 py-0.5 text-[10px] font-bold tracking-wide text-amber-200 shadow"
            >
              {{ positionLabel(Number(index), bots.length) }}
            </div>
            <DoudizhuSeat
              :player="p"
              :agent="agentFor(p.id)"
              :is-current="thinkingId === p.id"
              :conn="connFor(p.id)"
              :passed="passFlags[p.id] ?? false"
              :thoughts="thoughts[p.id] ?? ''"
              :waited="thinkingId === p.id ? waitedSec : 0"
              @edit-model="openModelEditor(p.id)"
              @open-thoughts="openThoughts(p.id)"
            />
          </div>
          <!-- 中央区：需压过的牌（上移到牌桌中上部，底牌消失后的空位正好给它用） -->
          <div
            class="pointer-events-none absolute inset-x-0 top-[48%] z-10 flex -translate-y-1/2 flex-col items-center gap-1.5"
          >
            <!-- 地主底牌：只在叫地主阶段展示，开打后收起（牌桌放不下） -->
            <div
              v-if="isBidding && state && state.landlordCards.length > 0"
              class="flex flex-col items-center gap-1"
            >
              <span class="text-[11px] tracking-widest text-amber-200/70">地主底牌</span>
              <div class="flex gap-1">
                <CardComp v-for="c in state.landlordCards" :key="c.id" :card="c" size="sm" />
              </div>
            </div>

            <div class="relative flex min-h-[92px] items-center justify-center">
              <div v-if="!centerCards.length" class="text-sm text-white/40">桌面空闲</div>
              <div v-else class="flex flex-col items-center gap-1">
                <div
                  class="flex"
                  :class="passOverlay ? 'opacity-40 saturate-50' : 'animate-card-fly'"
                >
                  <div
                    v-for="(c, i) in centerCards"
                    :key="c.id"
                    :style="{ marginLeft: i === 0 ? '0' : '-26px', zIndex: i }"
                  >
                    <CardComp :card="c" />
                  </div>
                </div>
                <span
                  v-if="state?.lastPlayerId != null"
                  class="rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-amber-200/85"
                >
                  {{ state.players[state.lastPlayerId]?.name }} 打出
                </span>
                <span
                  v-else-if="passOverlay?.freeLead && lastRoundBy != null"
                  class="rounded-full bg-black/50 px-2 py-0.5 text-[10px] text-amber-200/85"
                >
                  上一手作废 · 由 {{ state.players[lastRoundBy]?.name }} 重新领出
                </span>
              </div>

              <!-- 有人「不要」：PASS 盖在上一轮出的牌上 -->
              <div
                v-if="passOverlay"
                class="pointer-events-none absolute inset-0 z-20 flex flex-col items-center justify-center"
              >
                <span class="pass-stamp text-5xl">PASS</span>
                <span
                  class="-mt-1 rounded-full bg-black/70 px-2 py-0.5 text-[11px] font-bold text-rose-200 shadow"
                >
                  {{ passOverlay.name }} 不要<span v-if="passOverlay.count > 1">
                    · 连续 {{ passOverlay.count }} 家</span
                  >
                </span>
              </div>
            </div>
          </div>

          <!-- 底部：叫地主 / 轮次提示 -->
          <div class="absolute inset-x-0 bottom-2 flex flex-col items-center">
            <!-- 叫地主 -->
            <div v-if="isBidding" class="flex flex-col items-center gap-1.5">
              <div class="text-sm font-bold text-amber-200">
                叫地主（当前最高 {{ currentBid }} 分）
              </div>
              <div v-if="isMyTurn" class="flex gap-2">
                <button class="btn btn-chip-pass px-5 py-1.5 text-sm" @click="bid(0)">不叫</button>
                <button
                  v-for="s in [1, 2, 3]"
                  :key="s"
                  class="btn btn-chip px-5 py-1.5 text-sm"
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
              <span
                v-else
                class="rounded-full bg-amber-500/85 px-3 py-1 font-bold text-amber-950 shadow"
              >
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
      class="z-20 shrink-0 border-t border-white/10 bg-black/45 px-4 pb-2.5 pt-2 shadow-[0_-8px_24px_rgba(0,0,0,0.45)]"
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

        <!-- 你最近一次出牌（合并进信息行，省一整行高度；下次出牌覆盖） -->
        <div
          v-if="meLastPlay.length"
          class="relative flex items-center gap-1.5 rounded-xl border border-amber-300/30 bg-black/45 px-2 py-0.5 shadow"
        >
          <div
            v-for="(c, i) in meLastPlay"
            :key="c.id"
            class="animate-card-fly"
            :class="myPassed ? 'opacity-40' : ''"
            :style="{ marginLeft: i === 0 ? '0' : '-22px', zIndex: i }"
          >
            <CardComp :card="c" small />
          </div>
          <div
            v-if="myPassed"
            class="pointer-events-none absolute inset-0 flex items-center justify-center"
          >
            <span class="pass-stamp pass-stamp-sm text-lg">PASS</span>
          </div>
        </div>
        <span
          v-else-if="myPassed"
          class="rounded-full bg-rose-600/85 px-2 py-0.5 text-[11px] font-black text-white shadow"
        >
          不出
        </span>
      </div>

      <HandCards
        v-if="state"
        :cards="state.myHand"
        :selected-ids="selectedIds"
        :disabled="!isMyTurn || !isPlaying"
        :flat="true"
        @toggle="toggleCard"
      />

      <div class="mt-1 flex min-h-[16px] items-center justify-center">
        <span
          v-if="hintMsg"
          class="rounded-full px-3 py-0.5 text-[11px]"
          :class="hintEmpty ? 'bg-rose-500/20 text-rose-300' : 'bg-emerald-500/15 text-emerald-300'"
        >
          {{ hintMsg }}
        </span>
      </div>
      <div v-if="isPlaying" class="mt-1.5 flex justify-center gap-4">
        <button
          class="btn btn-primary px-6 py-2"
          :disabled="!isMyTurn || selectedIds.size === 0"
          @click="playSelected"
        >
          出牌
        </button>
        <button class="btn btn-slate px-6 py-2" :disabled="!isMyTurn" @click="pass">不出</button>
        <button class="btn btn-gold px-6 py-2" :disabled="!isMyTurn" @click="hint">
          提示
          <span v-if="hintOptions.length">（{{ hintIdx + 1 }}/{{ hintOptions.length }}）</span>
        </button>
      </div>
      <div v-else class="mt-1.5 h-[30px]"></div>
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
        <button class="btn btn-primary px-8 py-2.5" @click="requestNewGame()">再来一局</button>
        <button
          v-if="lastLogId"
          class="btn btn-ghost mt-3 block w-full px-8 py-2 text-sm"
          @click="viewMatchDetail"
        >
          🔍 查看本局明细（抢地主 / 出牌全过程）
        </button>
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
        <span class="flex gap-1">
          <i class="thinking-dot h-2 w-2 rounded-full bg-amber-300"></i>
          <i
            class="thinking-dot h-2 w-2 rounded-full bg-amber-300"
            style="animation-delay: 0.18s"
          ></i>
          <i
            class="thinking-dot h-2 w-2 rounded-full bg-amber-300"
            style="animation-delay: 0.36s"
          ></i>
        </span>
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
        <div class="mb-4 text-sm text-white/70">
          以下 AI 对手无法连通其大模型，请检查 Key / 接口地址：
        </div>
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
          <button class="btn btn-slate px-5 py-2 text-sm" @click="requestNewGame(lastList)">
            重试
          </button>
          <button class="btn btn-ghost px-5 py-2 text-sm" @click="goSettings">去设置</button>
          <button class="btn btn-primary px-5 py-2 text-sm" @click="backToPlaza">返回广场</button>
        </div>
      </div>
    </div>
    <!-- 思考过程弹层：流式实时刷新（关闭后可从座位上点「›」再看） -->
    <div
      v-if="thoughtPid != null"
      class="absolute inset-0 z-[66] flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      @click.self="thoughtPid = null"
    >
      <div
        class="flex max-h-[80vh] w-[640px] max-w-[94vw] flex-col rounded-2xl border border-violet-400/50 bg-gradient-to-b from-slate-800 to-slate-900 p-5 shadow-2xl"
      >
        <div class="mb-2 flex items-center justify-between gap-3">
          <div class="flex min-w-0 items-center gap-2">
            <span class="text-lg">🧠</span>
            <span class="truncate text-sm font-black text-violet-200">
              {{ thoughtPlayer?.name ?? "AI 对手" }} 的思考过程
            </span>
            <span
              v-if="thinkingId === thoughtPid"
              class="shrink-0 rounded-full bg-amber-500/25 px-2 py-0.5 text-[10px] font-bold text-amber-200"
            >
              思考中 · 已等 {{ waitedSec }}s
            </span>
          </div>
          <button class="btn-ghost shrink-0 rounded-lg px-2 py-1 text-xs" @click="thoughtPid = null">
            关闭
          </button>
        </div>
        <div
          ref="thoughtBox"
          class="min-h-[90px] flex-1 overflow-y-auto whitespace-pre-wrap break-words rounded-xl border border-white/10 bg-black/45 p-3 text-[12px] leading-relaxed text-white/85"
        >
          {{ currentThought || "（该模型没有返回 reasoning_content，或还没开始思考）" }}
        </div>
        <div class="mt-2 text-[11px] text-white/40">
          这段是模型边想边流回来的 reasoning_content；关掉弹层后，座位上仍留「›」入口可回看。
        </div>
      </div>
    </div>

    <!-- 出牌过程中：某个 agent 的大模型调用失败 → 可重试，或交给规则引擎 -->
    <div
      v-if="llmFail"
      class="absolute inset-0 z-[68] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
    >
      <div
        class="w-[460px] max-w-[92vw] rounded-2xl border-2 border-amber-400/70 bg-gradient-to-b from-slate-800 to-slate-900 p-6 text-center shadow-2xl"
      >
        <div class="mb-1 text-4xl">📡</div>
        <div class="mb-1 text-lg font-black text-amber-200">
          「{{ llmFail.agentName }}」调用大模型失败
        </div>
        <div class="mb-3 text-sm text-white/70">
          轮到 {{ llmFail.playerName }} {{ llmFail.stage }} · 第 {{ llmFail.attempts }} 次尝试
        </div>
        <div
          class="mx-auto mb-4 max-h-32 overflow-y-auto rounded-lg border border-rose-400/30 bg-black/40 px-3 py-2 text-left text-xs text-rose-200/90"
        >
          {{ llmFail.error }}
        </div>
        <div class="flex flex-wrap justify-center gap-2">
          <button class="btn btn-primary px-5 py-2 text-sm" @click="resolveLlmFail('retry')">
            🔁 重试
          </button>
          <button class="btn btn-slate px-5 py-2 text-sm" @click="resolveLlmFail('fallback')">
            用规则引擎出这手
          </button>
          <button class="btn btn-ghost px-4 py-2 text-xs" @click="editFailModel">
            ✏️ 改模型
          </button>
          <button class="btn btn-ghost px-4 py-2 text-xs" @click="resolveLlmFail('mute')">
            本局不再提示
          </button>
        </div>
        <div class="mt-3 text-[11px] text-white/45">
          重试会先重新检测该 agent 的接口连通性，成功后再让它重新决策这一手
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

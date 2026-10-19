// 德州扑克引擎（纯 TS，不依赖 Tauri）
// 支持 2~6 人（1 人类 + 多机器人），盲注、下注轮次、公共牌、摊牌、边池与规则 AI。

import { Card, makeStdDeck, shuffle, sortStdCards } from "./cards";

export interface HoldemPlayer {
  id: number;
  name: string;
  isHuman: boolean;
  agentId?: string;
  stack: number;
  hole: Card[];
  hasFolded: boolean;
  isAllIn: boolean;
  isBusted: boolean; // 筹码归零，退出本局（仍显示在牌桌上置灰）
  committed: number; // 本轮已投入（手内累计）
  hasActed: boolean; // 本轮是否已行动
  isDealer: boolean;
  isCurrent: boolean;
  lastAction: string | null;
}

export type HoldemPhase =
  | "preflop"
  | "flop"
  | "turn"
  | "river"
  | "showdown"
  | "handover"
  | "matchover";

export interface HoldemState {
  phase: HoldemPhase;
  players: HoldemPlayer[];
  community: Card[];
  pot: number;
  currentBet: number; // 本轮最高投入
  minRaise: number;
  toCall: number; // 当前玩家需跟注额
  currentPlayerId: number | null;
  message: string;
  dealerId: number;
  handNumber: number;
  resultText: string;
  winners: number[]; // 本手赢家 id
}

export interface AgentStyle {
  aggression: number; // 0~1，越高越爱加注/诈唬
  tightness: number; // 0~1，越高越紧（只玩强牌）
}

export interface HoldemAction {
  type: "fold" | "check" | "call" | "raise";
  toAmount?: number; // raise 时用：加注后本轮总投入
}

// ===================== 手牌评估 =====================

interface HandEval {
  category: number; // 8 同花顺 .. 0 高牌
  tie: number[]; // 比较用副牌
  name: string;
}

const CAT_NAME = [
  "高牌",
  "一对",
  "两对",
  "三条",
  "顺子",
  "同花",
  "葫芦",
  "四条",
  "同花顺",
];

function evaluate5(cards: Card[]): HandEval {
  const ranks = cards.map((c) => c.rank).sort((a, b) => b - a);
  const suits = cards.map((c) => c.suit);
  const isFlush = suits.every((s) => s === suits[0]);
  const uniq = [...new Set(ranks)].sort((a, b) => b - a);
  let isStraight = false;
  let straightHigh = 0;
  if (uniq.length === 5) {
    if (uniq[0] - uniq[4] === 4) {
      isStraight = true;
      straightHigh = uniq[0];
    }
    // 轮子 A-2-3-4-5
    if (uniq.join(",") === "14,5,4,3,2") {
      isStraight = true;
      straightHigh = 5;
    }
  }
  const counts = new Map<number, number>();
  for (const r of ranks) counts.set(r, (counts.get(r) ?? 0) + 1);
  const byCount = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const cnts = byCount.map((e) => e[1]);

  if (isStraight && isFlush) return { category: 8, tie: [straightHigh], name: CAT_NAME[8] };
  if (cnts[0] === 4) return { category: 7, tie: [byCount[0][0], byCount[1][0]], name: CAT_NAME[7] };
  if (cnts[0] === 3 && cnts[1] === 2) return { category: 6, tie: [byCount[0][0], byCount[1][0]], name: CAT_NAME[6] };
  if (isFlush) return { category: 5, tie: ranks, name: CAT_NAME[5] };
  if (isStraight) return { category: 4, tie: [straightHigh], name: CAT_NAME[4] };
  if (cnts[0] === 3) return { category: 3, tie: [byCount[0][0], ...byCount.slice(1).map((e) => e[0])], name: CAT_NAME[3] };
  if (cnts[0] === 2 && cnts[1] === 2)
    return { category: 2, tie: [byCount[0][0], byCount[1][0], byCount[2][0]], name: CAT_NAME[2] };
  if (cnts[0] === 2) return { category: 1, tie: [byCount[0][0], ...byCount.slice(1).map((e) => e[0])], name: CAT_NAME[1] };
  return { category: 0, tie: ranks, name: CAT_NAME[0] };
}

function combos<T>(arr: T[], k: number): T[][] {
  if (k === 0) return [[]];
  if (arr.length < k) return [];
  const [head, ...rest] = arr;
  const withHead = combos(rest, k - 1).map((c) => [head, ...c]);
  const without = combos(rest, k);
  return [...withHead, ...without];
}

/** 从 7 张中选最佳 5 张 */
export function bestHand(seven: Card[]): HandEval {
  let best: HandEval | null = null;
  for (const c5 of combos(seven, 5)) {
    const e = evaluate5(c5);
    if (!best || e.category > best.category || (e.category === best.category && cmpTie(e.tie, best.tie) > 0)) {
      best = e;
    }
  }
  return best!;
}

function cmpTie(a: number[], b: number[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    if (x !== y) return x - y;
  }
  return 0;
}

// ===================== 机器人 AI =====================

/** 翻前起手牌评分 0~1 */
function preflopScore(hole: Card[]): number {
  const [a, b] = hole;
  const hi = Math.max(a.rank, b.rank);
  const lo = Math.min(a.rank, b.rank);
  const pair = a.rank === b.rank;
  const suited = a.suit === b.suit;
  if (pair) return Math.min(1, 0.5 + (hi - 2) / 24);
  let s = (hi + lo) / 28; // 高牌基础
  if (suited) s += 0.12;
  if (hi === 14) s += 0.1; // 含 A
  if (hi - lo === 1 && hi >= 10) s += 0.1; // 连张
  return Math.min(1, s);
}

/** 机器人行动建议（规则 AI，结合 agent 风格） */
export function suggestHoldemAction(state: HoldemState, playerId: number, style: AgentStyle): HoldemAction {
  const p = state.players[playerId];
  const toCall = state.toCall;
  const potOdds = toCall > 0 ? toCall / (state.pot + toCall) : 0;

  let strength: number;
  if (state.phase === "preflop") {
    strength = preflopScore(p.hole);
    strength = strength * (1 - style.tightness * 0.4); // 紧手适当降低
  } else {
    const ev = bestHand([...p.hole, ...state.community]);
    strength = Math.min(1, ev.category / 8 + (ev.category >= 3 ? 0.25 : ev.category >= 1 ? 0.12 : 0.02));
  }
  // 风格扰动
  strength = Math.min(1, Math.max(0, strength + (style.aggression - 0.5) * 0.25));

  const rand = Math.random();
  const bluff = style.aggression > 0.6 && rand < (style.aggression - 0.6) * 0.6 && toCall <= state.pot * 0.5;

  if (toCall === 0) {
    // 过牌或下注
    if (strength > 0.55 || bluff) {
      const raiseTo = Math.round(state.currentBet + Math.max(state.minRaise, state.pot * (0.4 + style.aggression * 0.5)));
      return { type: "raise", toAmount: Math.min(raiseTo, p.committed + p.stack) };
    }
    return { type: "check" };
  }
  // 需要跟注
  if (strength < 0.32 && potOdds > 0.25 && !bluff) return { type: "fold" };
  if (strength > 0.7 || bluff) {
    const raiseTo = Math.round(state.currentBet + Math.max(state.minRaise, state.pot * (0.5 + style.aggression * 0.6)));
    return { type: "raise", toAmount: Math.min(raiseTo, p.committed + p.stack) };
  }
  if (strength > potOdds + 0.1) return { type: "call" };
  if (potOdds < 0.15) return { type: "call" };
  return style.tightness > 0.6 ? { type: "fold" } : { type: "call" };
}

// ===================== 游戏主体 =====================

export class HoldemGame {
  private players: HoldemPlayer[] = [];
  private community: Card[] = [];
  private phase: HoldemPhase = "preflop";
  private pot = 0;
  private currentBet = 0;
  private minRaise = 2;
  private currentPlayerId: number | null = null;
  private dealerId = 0;
  private handNumber = 0;
  private message = "";
  private resultText = "";
  private winners: number[] = [];
  private smallBlind: number;
  private bigBlind: number;

  constructor(config: { names: string[]; agentIds?: (string | undefined)[]; stacks?: number[]; smallBlind?: number; bigBlind?: number }) {
    const { names, agentIds, stacks, smallBlind = 5, bigBlind = 10 } = config;
    this.smallBlind = smallBlind;
    this.bigBlind = bigBlind;
    this.minRaise = bigBlind;
    this.players = names.map((name, i) => ({
      id: i,
      name,
      isHuman: i === 0,
      agentId: agentIds?.[i],
      stack: stacks?.[i] ?? 200,
      hole: [],
      hasFolded: false,
      isAllIn: false,
      isBusted: false,
      committed: 0,
      hasActed: false,
      isDealer: false,
      isCurrent: false,
      lastAction: null,
    }));
    this.startHand();
  }

  private livePlayers() {
    return this.players.filter((p) => !p.hasFolded && p.stack > 0);
  }
  private activeInHand() {
    return this.players.filter((p) => !p.hasFolded);
  }

  private startHand() {
    // 破产玩家：标记 isBusted 并退出后续手牌（仍保留在牌桌上置灰显示）
    for (const p of this.players) {
      if (p.stack <= 0) {
        p.isBusted = true;
        p.hasFolded = true;
      }
    }
    // 人类破产：直接结束对局，由前端提示退出/重开
    if (this.players[0].isBusted) {
      this.phase = "matchover";
      this.message = "你已输光筹码";
      this.resultText = "你已输光筹码，可退出牌局或重开一局";
      return;
    }
    const live = this.livePlayers();
    if (live.length <= 1) {
      this.phase = "matchover";
      this.message = "对局结束";
      return;
    }
    this.handNumber++;
    this.community = [];
    this.pot = 0;
    this.currentBet = 0;
    this.winners = [];
    this.resultText = "";
    for (const p of this.players) {
      p.hole = [];
      p.hasFolded = p.stack <= 0;
      p.isAllIn = false;
      p.committed = 0;
      p.hasActed = false;
      p.lastAction = null;
    }
    // 轮换庄家
    this.dealerId = this.nextLive(this.dealerId);
    for (const p of this.players) p.isDealer = p.id === this.dealerId;

    const deck = shuffle(makeStdDeck());
    for (const p of this.players) if (!p.hasFolded) p.hole = sortStdCards([deck.pop()!, deck.pop()!]);

    // 下盲注
    const liveIds = live.map((p) => p.id);
    if (liveIds.length === 2) {
      // 单挑：庄家=小盲
      this.postBlind(this.dealerId, this.smallBlind);
      this.postBlind(this.nextLive(this.dealerId), this.bigBlind);
      this.currentPlayerId = this.nextLive(this.dealerId);
    } else {
      const sb = this.nextLive(this.dealerId);
      const bb = this.nextLive(sb);
      this.postBlind(sb, this.smallBlind);
      this.postBlind(bb, this.bigBlind);
      this.currentBet = this.bigBlind;
      this.currentPlayerId = this.nextLive(bb);
    }
    this.phase = "preflop";
    this.message = `第 ${this.handNumber} 手：翻前下注`;
  }

  private postBlind(id: number, amount: number) {
    const p = this.players[id];
    const pay = Math.min(amount, p.stack);
    p.stack -= pay;
    p.committed += pay;
    p.lastAction = amount === this.smallBlind ? "小盲" : "大盲";
    if (p.stack === 0) p.isAllIn = true;
  }

  private nextLive(fromId: number): number {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const id = (fromId + i) % n;
      if (!this.players[id].hasFolded && this.players[id].stack > 0) return id;
    }
    return fromId;
  }

  private nextToAct(fromId: number): number {
    const n = this.players.length;
    for (let i = 1; i <= n; i++) {
      const id = (fromId + i) % n;
      const p = this.players[id];
      if (!p.hasFolded && !p.isAllIn && !p.hasActed) return id;
    }
    return -1;
  }

  private bettingComplete(): boolean {
    const active = this.players.filter((p) => !p.hasFolded && !p.isAllIn);
    if (active.length <= 1) return true;
    return active.every((p) => p.hasActed && p.committed === this.currentBet);
  }

  private pay(id: number, amount: number) {
    const p = this.players[id];
    const pay = Math.min(amount, p.stack);
    p.stack -= pay;
    p.committed += pay;
    this.pot += pay;
    if (p.stack === 0) p.isAllIn = true;
  }

  private act(playerId: number, action: HoldemAction) {
    const p = this.players[playerId];
    const toCall = this.currentBet - p.committed;
    if (action.type === "fold") {
      p.hasFolded = true;
      p.lastAction = "弃牌";
    } else if (action.type === "check") {
      if (toCall > 0) return; // 不能过牌
      p.hasActed = true;
      p.lastAction = "过牌";
    } else if (action.type === "call") {
      this.pay(playerId, toCall);
      p.hasActed = true;
      p.lastAction = "跟注";
    } else if (action.type === "raise") {
      let toAmount = action.toAmount ?? this.currentBet + this.minRaise;
      if (toAmount <= this.currentBet) {
        // 不足加注额度，按跟注处理
        this.pay(playerId, toCall);
        p.hasActed = true;
        p.lastAction = "跟注";
        return;
      }
      const raiseSize = toAmount - this.currentBet;
      if (raiseSize < this.minRaise && p.stack + p.committed > toAmount) {
        toAmount = this.currentBet + this.minRaise;
      }
      const need = toAmount - p.committed;
      this.pay(playerId, need);
      this.currentBet = Math.max(this.currentBet, p.committed);
      p.hasActed = true;
      p.lastAction = p.isAllIn ? "全下" : "加注";
    }
  }

  private afterAction() {
    // 只剩一人未弃牌
    const remaining = this.activeInHand();
    if (remaining.length === 1) {
      this.awardTo(remaining[0].id);
      return;
    }
    if (this.bettingComplete()) {
      this.advanceStreet();
    } else {
      this.currentPlayerId = this.nextToAct(this.currentPlayerId!);
      if (this.currentPlayerId === -1) this.advanceStreet();
    }
  }

  private advanceStreet() {
    const remaining = this.activeInHand();
    if (remaining.length === 1) {
      this.awardTo(remaining[0].id);
      return;
    }
    // 重置本轮
    this.currentBet = 0;
    this.minRaise = this.bigBlind;
    for (const p of this.players) {
      if (!p.hasFolded && !p.isAllIn) {
        p.hasActed = false;
      }
    }
    if (this.phase === "preflop") {
      this.community = this.dealCommunity(3);
      this.phase = "flop";
      this.message = "翻牌";
    } else if (this.phase === "flop") {
      this.community.push(...this.dealCommunity(1));
      this.phase = "turn";
      this.message = "转牌";
    } else if (this.phase === "turn") {
      this.community.push(...this.dealCommunity(1));
      this.phase = "river";
      this.message = "河牌";
    } else if (this.phase === "river") {
      this.showdown();
      return;
    }
    // 设置首位行动者（庄家后第一个未弃牌/未全下）
    this.currentPlayerId = this.firstToActPostflop();
  }

  // 社区牌用一个内部牌堆缓存，避免每街重新洗
  private communityDeck: Card[] = [];
  private dealCommunity(n: number): Card[] {
    if (this.communityDeck.length === 0) {
      this.communityDeck = shuffle(makeStdDeck());
    }
    const out: Card[] = [];
    for (let i = 0; i < n; i++) out.push(this.communityDeck.pop()!);
    return out;
  }

  private firstToActPostflop(): number {
    let id = this.dealerId;
    for (let i = 0; i < this.players.length; i++) {
      id = this.nextLive(id);
      const p = this.players[id];
      if (!p.hasFolded && !p.isAllIn) return id;
    }
    return this.nextLive(this.dealerId);
  }

  private showdown() {
    this.phase = "showdown";
    const contenders = this.activeInHand();
    const evals = contenders.map((p) => ({ p, ev: bestHand([...p.hole, ...this.community]) }));
    let best = evals[0];
    for (const e of evals) {
      if (e.ev.category > best.ev.category || (e.ev.category === best.ev.category && cmpTie(e.ev.tie, best.ev.tie) > 0))
        best = e;
    }
    const winners = evals.filter(
      (e) => e.ev.category === best.ev.category && cmpTie(e.ev.tie, best.ev.tie) === 0,
    );
    this.distributePots(winners.map((w) => w.p.id));
    this.phase = "handover";
  }

  private distributePots(winnerIds: number[]) {
    // 边池：按投入层级分配，仅未弃牌者可分池
    const contrib = this.players.map((p) => ({ id: p.id, amt: p.committed, folded: p.hasFolded }));
    const winnerSet = new Set(winnerIds);
    let guard = 0;
    while (contrib.some((c) => c.amt > 0) && guard++ < 50) {
      const minAmt = Math.min(...contrib.filter((c) => c.amt > 0).map((c) => c.amt));
      const inPot = contrib.filter((c) => c.amt > 0);
      const pot = minAmt * inPot.length;
      const eligible = inPot.filter((c) => !c.folded && winnerSet.has(c.id));
      if (eligible.length > 0) {
        const share = Math.floor(pot / eligible.length);
        let rem = pot - share * eligible.length;
        for (const e of eligible) {
          let s = share;
          if (rem > 0) {
            s += 1;
            rem--;
          }
          this.players[e.id].stack += s;
        }
      }
      for (const c of inPot) c.amt -= minAmt;
    }
    this.winners = winnerIds;
    this.resultText = `${winnerIds.map((id) => this.players[id].name).join("、")} 赢得底池 ${this.pot}`;
  }

  private awardTo(id: number) {
    this.players[id].stack += this.pot;
    this.winners = [id];
    this.resultText = `${this.players[id].name} 赢得底池 ${this.pot}（其余玩家弃牌）`;
    this.phase = "handover";
  }

  // 公共 API
  fold(playerId: number): HoldemState {
    if (this.currentPlayerId !== playerId || this.phase === "handover" || this.phase === "matchover") return this.getState();
    this.act(playerId, { type: "fold" });
    this.afterAction();
    return this.getState();
  }
  check(playerId: number): HoldemState {
    if (this.currentPlayerId !== playerId) return this.getState();
    this.act(playerId, { type: "check" });
    this.afterAction();
    return this.getState();
  }
  call(playerId: number): HoldemState {
    if (this.currentPlayerId !== playerId) return this.getState();
    this.act(playerId, { type: "call" });
    this.afterAction();
    return this.getState();
  }
  raiseTo(playerId: number, toAmount: number): HoldemState {
    if (this.currentPlayerId !== playerId) return this.getState();
    this.act(playerId, { type: "raise", toAmount });
    this.afterAction();
    return this.getState();
  }
  /** 进入下一手（人类点击「下一手」） */
  nextHand(): HoldemState {
    if (this.phase !== "handover" && this.phase !== "showdown") return this.getState();
    this.communityDeck = [];
    this.startHand();
    return this.getState();
  }

  getState(): HoldemState {
    const cur = this.currentPlayerId;
    const toCall =
      cur !== null && this.players[cur]
        ? Math.max(0, this.currentBet - this.players[cur].committed)
        : 0;
    return {
      phase: this.phase,
      players: this.players.map((p) => ({ ...p, hole: [...p.hole] })),
      community: [...this.community],
      pot: this.pot,
      currentBet: this.currentBet,
      minRaise: this.minRaise,
      toCall,
      currentPlayerId: this.currentPlayerId,
      message: this.message,
      dealerId: this.dealerId,
      handNumber: this.handNumber,
      resultText: this.resultText,
      winners: [...this.winners],
    };
  }
}

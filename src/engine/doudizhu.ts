// 斗地主引擎（纯 TS，不依赖 Tauri）
// 三/四人对战：1 人类 + N 机器人（N=2 默认，可加到 3）。支持叫地主、完整牌型识别与校验、规则 AI。
// 构造函数 names 为“机器人”名字列表；人类固定为 0 号并置于最前。

import {
  Card,
  ddzValue,
  makeDdzDeck,
  shuffle,
  sortDdzCards,
} from "./cards";
import { GameEngine } from "./GameEngine";

export type DdzRole = "landlord" | "farmer";

export interface DdzPlayer {
  id: number;
  name: string;
  isHuman: boolean;
  role: DdzRole | null;
  hand: Card[];
  handCount: number;
  isCurrent: boolean;
  lastPlay: Card[] | null;
}

export type DdzPhase = "bidding" | "playing" | "gameover";

/** 一次出牌动作记录（用于复盘/给大模型描述“上家出了什么”） */
export interface DdzAction {
  playerId: number;
  type: "play" | "pass";
  cards: Card[] | null;
}

export interface DdzState {
  phase: DdzPhase;
  players: DdzPlayer[];
  myHand: Card[];
  landlordCards: Card[];
  currentPlayerId: number | null;
  lastPlay: Card[] | null;
  lastPlayerId: number | null;
  passCount: number;
  winner: DdzRole | null;
  bidHistory: { playerId: number; score: number }[];
  currentBid: number;
  message: string;
  // 最近若干次动作（按时间顺序，含“不出”），供 UI 与大模型了解场上形势
  recentActions: DdzAction[];
  // 本局已经打出的所有牌（累计，按打出顺序），供大模型「记牌」
  playedCards: Card[];
  // 累计动作数（play+pass，不受 recentActions 截断影响）；用于判断某个动作是否真的生效
  actionCount: number;
  // 叫地主轮次内部状态
  biddingOrder: number[];
  bidPtr: number;
  redealCount: number;
}

export type PatternType =
  | "single"
  | "pair"
  | "triple"
  | "triple_single"
  | "triple_pair"
  | "straight"
  | "pair_straight"
  | "airplane"
  | "airplane_single"
  | "airplane_pair"
  | "four_two_single"
  | "four_two_pair"
  | "bomb"
  | "rocket";

export interface CardPattern {
  type: PatternType;
  mainRank: number;
  length: number;
  cards: Card[];
}

// ===================== 牌型识别 =====================

/**
 * 按「斗地主牌力值」统计各点数张数。
 * 必须用 ddzValue（2→15），否则 2 会被当成最小的牌，导致「出 2 压不过 3」。
 */
function rankCounts(cards: Card[]): Map<number, number> {
  const m = new Map<number, number>();
  for (const c of cards) {
    const v = ddzValue(c);
    m.set(v, (m.get(v) ?? 0) + 1);
  }
  return m;
}

/** 识别一组牌的牌型；非法返回 null */
export function detectPattern(cards: Card[]): CardPattern | null {
  const n = cards.length;
  if (n === 0) return null;
  const counts = rankCounts(cards);
  const ranks = [...counts.keys()].sort((a, b) => a - b);
  const uniqueRanks = ranks.length;

  // 火箭（双王）
  if (n === 2 && cards.every((c) => c.suit === "joker")) {
    return { type: "rocket", mainRank: 100, length: 1, cards };
  }
  // 炸弹
  if (n === 4 && uniqueRanks === 1) {
    return { type: "bomb", mainRank: ranks[0], length: 1, cards };
  }
  if (n === 1) return { type: "single", mainRank: ranks[0], length: 1, cards };
  if (n === 2 && uniqueRanks === 1)
    return { type: "pair", mainRank: ranks[0], length: 1, cards };
  if (n === 3 && uniqueRanks === 1)
    return { type: "triple", mainRank: ranks[0], length: 1, cards };

  // 三带一
  if (n === 4) {
    const triple = ranks.find((r) => counts.get(r) === 3);
    if (triple !== undefined) return { type: "triple_single", mainRank: triple, length: 1, cards };
  }
  // 三带二（三带一对）
  if (n === 5) {
    const triple = ranks.find((r) => counts.get(r) === 3);
    const pair = ranks.find((r) => counts.get(r) === 2);
    if (triple !== undefined && pair !== undefined)
      return { type: "triple_pair", mainRank: triple, length: 1, cards };
  }
  // 四带二（四张 + 两张单/一对）
  if (n === 6) {
    const quad = ranks.find((r) => counts.get(r) === 4);
    if (quad !== undefined) return { type: "four_two_single", mainRank: quad, length: 1, cards };
  }
  // 四带两对
  if (n === 8) {
    const quad = ranks.find((r) => counts.get(r) === 4);
    const pairs = ranks.filter((r) => counts.get(r) === 2);
    if (quad !== undefined && pairs.length === 2)
      return { type: "four_two_pair", mainRank: quad, length: 1, cards };
  }

  // 顺子（5+ 连续单张，不含 2/王）
  if (n >= 5 && uniqueRanks === n && ranks[ranks.length - 1] <= 14 && ranks[0] >= 3) {
    let consecutive = true;
    for (let i = 1; i < ranks.length; i++)
      if (ranks[i] !== ranks[i - 1] + 1) consecutive = false;
    if (consecutive) return { type: "straight", mainRank: ranks[ranks.length - 1], length: n, cards };
  }
  // 连对（3+ 连续对子）
  if (
    n >= 6 &&
    n % 2 === 0 &&
    ranks.every((r) => counts.get(r) === 2) &&
    ranks[ranks.length - 1] <= 14 &&
    ranks[0] >= 3
  ) {
    let consecutive = true;
    for (let i = 1; i < ranks.length; i++)
      if (ranks[i] !== ranks[i - 1] + 1) consecutive = false;
    if (consecutive)
      return { type: "pair_straight", mainRank: ranks[ranks.length - 1], length: n / 2, cards };
  }

  // 飞机及带牌：从连续三张入手
  const triples = ranks.filter((r) => counts.get(r) === 3).sort((a, b) => a - b);
  if (triples.length >= 2) {
    // 找出最长连续三张段
    let bestStart = triples[0];
    let bestLen = 1;
    let curStart = triples[0];
    let curLen = 1;
    for (let i = 1; i < triples.length; i++) {
      if (triples[i] === triples[i - 1] + 1) {
        curLen++;
      } else {
        if (curLen > bestLen) {
          bestLen = curLen;
          bestStart = curStart;
        }
        curStart = triples[i];
        curLen = 1;
      }
    }
    if (curLen > bestLen) {
      bestLen = curLen;
      bestStart = curStart;
    }
    const planeRanks = Array.from({ length: bestLen }, (_, i) => bestStart + i);
    const planeSet = new Set(planeRanks);
    if (planeRanks[planeRanks.length - 1] <= 14 && planeRanks[0] >= 3) {
      const leftover = cards.filter((c) => !planeSet.has(ddzValue(c)));
      const leftCounts = rankCounts(leftover);
      const leftRanks = [...leftCounts.keys()];
      // 纯飞机（不带）
      if (leftover.length === 0)
        return { type: "airplane", mainRank: planeRanks[planeRanks.length - 1], length: bestLen, cards };
      // 飞机带单：剩余数量 == 段长，且每段三张外不占用三张点数
      if (leftover.length === bestLen)
        return { type: "airplane_single", mainRank: planeRanks[planeRanks.length - 1], length: bestLen, cards };
      // 飞机带对：剩余能组成 bestLen 个对子
      if (leftover.length === bestLen * 2 && leftRanks.every((r) => leftCounts.get(r) === 2))
        return { type: "airplane_pair", mainRank: planeRanks[planeRanks.length - 1], length: bestLen, cards };
    }
  }

  return null;
}

/** a 能否压过 b（b 为 null 表示自由出牌，任意合法牌型都可） */
export function canBeat(a: CardPattern, b: CardPattern | null): boolean {
  if (!b) return true;
  if (a.type === "rocket") return true;
  if (b.type === "rocket") return false;
  if (a.type === "bomb" && b.type !== "bomb") return true;
  if (b.type === "bomb" && a.type !== "bomb") return false;
  if (a.type === "bomb" && b.type === "bomb") return a.mainRank > b.mainRank;
  if (a.type !== b.type) return false;
  const needLen =
    a.type === "straight" ||
    a.type === "pair_straight" ||
    a.type === "airplane" ||
    a.type === "airplane_single" ||
    a.type === "airplane_pair";
  if (needLen && a.length !== b.length) return false;
  return a.mainRank > b.mainRank;
}

// ===================== 机器人 AI =====================

/** 统计手牌强度，用于叫分（0~3） */
function handStrength(hand: Card[]): number {
  let score = 0;
  const counts = rankCounts(hand);
  for (const [rank, c] of counts) {
    if (c === 4) score += 6; // 炸弹
    if (rank === 17) score += 4; // 大王
    if (rank === 16) score += 3; // 小王
    if (rank === 15) score += 2; // 2
  }
  const jokers = hand.filter((c) => c.suit === "joker").length;
  if (jokers === 2) score += 4;
  return score;
}

/** 机器人叫分建议：0=不叫，1/2/3 */
export function suggestBid(hand: Card[]): number {
  const s = handStrength(hand);
  if (s >= 12) return 3;
  if (s >= 7) return 2;
  if (s >= 4) return 1;
  return 0;
}

/** 从手牌中找出能压过 lastPlay 的最小合法组合；返回牌数组，null 表示建议不出 */
export function findBeats(hand: Card[], last: CardPattern): Card[] | null {
  const counts = rankCounts(hand);
  const byRank = (v: number) => hand.filter((c) => ddzValue(c) === v);
  let candidate: Card[] | null = null;

  const pickLowestOver = (pred: (r: number) => boolean): Card[] | null => {
    const candidates = [...counts.keys()].filter((r) => r > last.mainRank && pred(r)).sort((a, b) => a - b);
    if (candidates.length === 0) return null;
    const r = candidates[0];
    if (last.type === "single") return byRank(r).slice(0, 1);
    if (last.type === "pair") return byRank(r).slice(0, 2);
    if (last.type === "triple") return byRank(r).slice(0, 3);
    return null;
  };

  switch (last.type) {
    case "single":
      candidate = pickLowestOver(() => true);
      break;
    case "pair":
      candidate = pickLowestOver((r) => counts.get(r)! >= 2);
      break;
    case "triple":
      candidate = pickLowestOver((r) => counts.get(r)! >= 3);
      break;
    case "triple_single": {
      const t = pickLowestOver((r) => counts.get(r)! >= 3);
      if (t) {
        const tv = ddzValue(t[0]);
        const kicker = hand.find((c) => ddzValue(c) !== tv && c.suit !== "joker");
        if (kicker) candidate = [...t, kicker];
      }
      break;
    }
    case "triple_pair": {
      const t = pickLowestOver((r) => counts.get(r)! >= 3);
      if (t) {
        const tv = ddzValue(t[0]);
        const pr = [...counts.keys()].find((r) => counts.get(r)! >= 2 && r !== tv);
        if (pr !== undefined) candidate = [...t, ...byRank(pr).slice(0, 2)];
      }
      break;
    }
    case "straight":
    case "pair_straight":
    case "airplane":
    case "airplane_single":
    case "airplane_pair": {
      const need = last.length;
      const perLen =
        last.type === "pair_straight" || last.type === "airplane" || last.type === "airplane_single" || last.type === "airplane_pair"
          ? last.type === "pair_straight"
            ? 2
            : 3
          : 1;
      for (let start = last.mainRank - need + 2; start <= 14 - need + 1; start++) {
        if (start < 3) continue;
        let ok = true;
        for (let i = 0; i < need; i++) {
          const r = start + i;
          if (r > 14) {
            ok = false;
            break;
          }
          if ((counts.get(r) ?? 0) < perLen) {
            ok = false;
            break;
          }
        }
        if (!ok) continue;
        const combo: Card[] = [];
        for (let i = 0; i < need; i++) combo.push(...byRank(start + i).slice(0, perLen));
        if (last.type === "airplane_single" || last.type === "airplane_pair") {
          const used = new Set(combo.map((c) => c.id));
          const rest = hand
            .filter((c) => !used.has(c.id) && c.suit !== "joker")
            .sort((a, b) => ddzValue(a) - ddzValue(b));
          if (last.type === "airplane_pair") {
            // 需要 need 个对子作为带牌
            const pairVals: number[] = [];
            for (const c of rest) {
              const v = ddzValue(c);
              if (pairVals.includes(v)) continue;
              if (hand.filter((x) => ddzValue(x) === v && x.suit !== "joker").length >= 2) pairVals.push(v);
              if (pairVals.length === need) break;
            }
            if (pairVals.length === need) {
              const kickers: Card[] = [];
              for (const v of pairVals)
                kickers.push(...hand.filter((x) => ddzValue(x) === v && x.suit !== "joker").slice(0, 2));
              candidate = [...combo, ...kickers];
            }
          } else {
            // 飞机带单：need 张单牌（取自不同点数，避开三张点数）
            const usedVals = new Set(combo.map((c) => ddzValue(c)));
            const singles: Card[] = [];
            for (const c of rest) {
              if (singles.length >= need) break;
              if (usedVals.has(ddzValue(c))) continue;
              if (singles.some((s) => ddzValue(s) === ddzValue(c))) continue; // 单牌不重复点数
              singles.push(c);
            }
            if (singles.length === need) candidate = [...combo, ...singles];
          }
        } else {
          candidate = combo;
        }
        if (candidate) break;
      }
      break;
    }
  }

  // 炸弹 / 火箭兜底
  if (!candidate) {
    const bombRank = [...counts.keys()].find((r) => counts.get(r) === 4);
    if (bombRank !== undefined && (last.type !== "bomb" || bombRank > last.mainRank)) {
      candidate = byRank(bombRank).slice(0, 4);
    }
  }
  if (!candidate) {
    const hasSmall = hand.some((c) => c.suit === "joker" && c.rank === 16);
    const hasBig = hand.some((c) => c.suit === "joker" && c.rank === 17);
    if (hasSmall && hasBig) candidate = hand.filter((c) => c.suit === "joker");
  }

  // 安全网：必须真的能压过 lastPlay 才返回
  if (candidate) {
    const p = detectPattern(candidate);
    if (p && canBeat(p, last)) return candidate;
  }
  return null;
}

/** 领出（自由出牌）时，机器人建议出的最小非炸组合 */
export function suggestLead(hand: Card[]): Card[] {
  const counts = rankCounts(hand);
  const ranks = [...counts.keys()].sort((a, b) => a - b);
  // counts 的 key 是牌力值，取牌必须按牌力值匹配（否则 2 会取不到牌 → 空出牌 → 卡死）
  const byV = (v: number) => hand.filter((c) => ddzValue(c) === v);
  // 简单策略：优先出最小的单/对/三，保留 2（牌力 15）当大牌
  for (const r of ranks) {
    if (counts.get(r)! >= 3 && r !== 15) return byV(r).slice(0, 3);
  }
  for (const r of ranks) {
    if (counts.get(r)! >= 2 && r !== 15) return byV(r).slice(0, 2);
  }
  for (const r of ranks) {
    if (counts.get(r)! >= 1 && r !== 15) return byV(r).slice(0, 1);
  }
  // 只剩 2 或大小王时，出牌力最小的那一张
  const lowest = ranks[0];
  const out = byV(lowest).slice(0, 1);
  // 防呆：绝不能返回空数组，否则自由领出会被引擎判为非法 → 回合卡死
  return out.length ? out : hand.slice(0, 1);
}

// ===================== 提示（人类玩家） =====================

/** 牌型在提示列表里的排序权重：普通牌型 → 炸弹 → 王炸 */
function hintWeight(p: CardPattern): number {
  if (p.type === "rocket") return 3;
  if (p.type === "bomb") return 2;
  return 1;
}

/**
 * 枚举所有「能压过 last」的出牌组合（last 为 null 表示自由领出，枚举所有可出的牌型）。
 * 返回顺序：普通牌型（按牌力从小到大）→ 炸弹 → 王炸，供「提示」按钮循环切换。
 * 每个点数/起点的带牌只取最小的一种，避免组合爆炸。
 */
export function findAllBeats(hand: Card[], last: CardPattern | null): Card[][] {
  const counts = rankCounts(hand);
  const byV = (v: number) => hand.filter((c) => ddzValue(c) === v);
  const values = [...counts.keys()].sort((a, b) => a - b);
  const nonJoker = hand.filter((c) => c.suit !== "joker");
  const res: Card[][] = [];
  const seen = new Set<string>();

  const push = (cards: Card[]) => {
    if (cards.length === 0) return;
    if (cards.some((c) => !c)) return;
    const p = detectPattern(cards);
    if (!p || !canBeat(p, last)) return;
    const key = cards
      .map((c) => c.id)
      .sort()
      .join("|");
    if (seen.has(key)) return;
    seen.add(key);
    res.push(cards);
  };

  const isType = (...ts: PatternType[]) => !last || ts.includes(last.type);
  const over = (v: number) => !last || v > last.mainRank;
  /** 取 n 张点数互不相同的最小带牌（排除 exclude 中的点数，不带王） */
  const minSingles = (n: number, exclude: number[]) => {
    const picks: Card[] = [];
    const used = new Set<number>();
    for (const c of nonJoker.filter((x) => !exclude.includes(ddzValue(x))).sort((a, b) => ddzValue(a) - ddzValue(b))) {
      if (picks.length >= n) break;
      const v = ddzValue(c);
      if (used.has(v)) continue;
      used.add(v);
      picks.push(c);
    }
    return picks.length === n ? picks : null;
  };
  const minPairs = (n: number, exclude: number[]) => {
    const vs: number[] = [];
    for (const v of values) {
      if (exclude.includes(v)) continue;
      if ((counts.get(v) ?? 0) >= 2 && v !== 16 && v !== 17) vs.push(v);
      if (vs.length === n) break;
    }
    return vs.length === n ? vs.flatMap((v) => byV(v).slice(0, 2)) : null;
  };

  // 1) 单张 / 对子 / 三张
  for (const v of values) {
    if (isType("single") && over(v)) push(byV(v).slice(0, 1));
    if (isType("pair") && (counts.get(v) ?? 0) >= 2 && over(v)) push(byV(v).slice(0, 2));
    if (isType("triple") && (counts.get(v) ?? 0) >= 3 && over(v)) push(byV(v).slice(0, 3));
  }

  // 2) 三带一 / 三带二
  if (isType("triple_single", "triple_pair")) {
    for (const v of values) {
      if ((counts.get(v) ?? 0) < 3) continue;
      if (last && (last.type === "triple_single" || last.type === "triple_pair") && v <= last.mainRank) continue;
      const t = byV(v).slice(0, 3);
      if (isType("triple_single")) {
        const k = minSingles(1, [v]);
        if (k) push([...t, ...k]);
      }
      if (isType("triple_pair")) {
        const k = minPairs(1, [v]);
        if (k) push([...t, ...k]);
      }
    }
  }

  // 3) 顺子
  if (isType("straight")) {
    const lens = last?.type === "straight" ? [last.length] : [5, 6, 7, 8, 9, 10, 11, 12];
    for (const len of lens) {
      for (let start = 3; start + len - 1 <= 14; start++) {
        let ok = true;
        for (let i = 0; i < len; i++) if ((counts.get(start + i) ?? 0) < 1) { ok = false; break; }
        if (!ok) continue;
        if (last?.type === "straight" && start + len - 1 <= last.mainRank) continue;
        const cards: Card[] = [];
        for (let i = 0; i < len; i++) cards.push(byV(start + i)[0]);
        push(cards);
      }
    }
  }

  // 4) 连对
  if (isType("pair_straight")) {
    const lens = last?.type === "pair_straight" ? [last.length] : [3, 4, 5, 6, 7, 8, 9, 10];
    for (const len of lens) {
      for (let start = 3; start + len - 1 <= 14; start++) {
        let ok = true;
        for (let i = 0; i < len; i++) if ((counts.get(start + i) ?? 0) < 2) { ok = false; break; }
        if (!ok) continue;
        if (last?.type === "pair_straight" && start + len - 1 <= last.mainRank) continue;
        const cards: Card[] = [];
        for (let i = 0; i < len; i++) cards.push(...byV(start + i).slice(0, 2));
        push(cards);
      }
    }
  }

  // 5) 飞机（不带 / 带单 / 带对）
  const PLANE: PatternType[] = ["airplane", "airplane_single", "airplane_pair"];
  if (isType(...PLANE)) {
    const lens = last && PLANE.includes(last.type) ? [last.length] : [2, 3, 4, 5, 6];
    for (const len of lens) {
      for (let start = 3; start + len - 1 <= 14; start++) {
        let ok = true;
        for (let i = 0; i < len; i++) if ((counts.get(start + i) ?? 0) < 3) { ok = false; break; }
        if (!ok) continue;
        if (last && PLANE.includes(last.type) && start + len - 1 <= last.mainRank) continue;
        const combo: Card[] = [];
        for (let i = 0; i < len; i++) combo.push(...byV(start + i).slice(0, 3));
        const body = Array.from({ length: len }, (_, i) => start + i);
        if (isType("airplane")) push(combo);
        if (isType("airplane_single")) {
          const k = minSingles(len, body);
          if (k) push([...combo, ...k]);
        }
        if (isType("airplane_pair")) {
          const k = minPairs(len, body);
          if (k) push([...combo, ...k]);
        }
      }
    }
  }

  // 6) 四带二
  if (isType("four_two_single", "four_two_pair")) {
    for (const v of values) {
      if ((counts.get(v) ?? 0) < 4) continue;
      if (last && (last.type === "four_two_single" || last.type === "four_two_pair") && v <= last.mainRank) continue;
      const quad = byV(v).slice(0, 4);
      if (isType("four_two_single")) {
        const k = minSingles(2, [v]);
        if (k) push([...quad, ...k]);
      }
      if (isType("four_two_pair")) {
        const k = minPairs(2, [v]);
        if (k) push([...quad, ...k]);
      }
    }
  }

  // 7) 炸弹 / 王炸（任何牌型都能用它们压）
  for (const v of values) {
    if ((counts.get(v) ?? 0) !== 4) continue;
    if (last?.type === "bomb" && v <= last.mainRank) continue;
    push(byV(v).slice(0, 4));
  }
  const small = hand.find((c) => c.suit === "joker" && c.rank === 16);
  const big = hand.find((c) => c.suit === "joker" && c.rank === 17);
  if (small && big && last?.type !== "rocket") push([small, big]);

  res.sort((a, b) => {
    const pa = detectPattern(a)!;
    const pb = detectPattern(b)!;
    const wa = hintWeight(pa);
    const wb = hintWeight(pb);
    if (wa !== wb) return wa - wb;
    if (pa.mainRank !== pb.mainRank) return pa.mainRank - pb.mainRank;
    if (pa.length !== pb.length) return pa.length - pb.length;
    return a.length - b.length;
  });
  return res;
}

// ===================== 游戏主体 =====================

export class DoudizhuGame extends GameEngine<DdzState, DdzAction> {
  private players: DdzPlayer[] = [];
  private landlordCards: Card[] = [];
  private phase: DdzPhase = "bidding";
  private currentPlayerId: number | null = null;
  private lastPlay: Card[] | null = null;
  private lastPlayerId: number | null = null;
  private passCount = 0;
  private winner: DdzRole | null = null;
  private bidHistory: { playerId: number; score: number }[] = [];
  private currentBid = 0;
  private biddingOrder: number[] = [];
  private bidPtr = 0;
  private redealCount = 0;
  private message = "";
  // 动作流水由基类 GameEngine 维护（actions / actionCount / recentActions）
  private played: Card[] = [];

  constructor(names: string[], humanName = "你", noJokers = false) {
    super();
    // names 为机器人名字列表；人类固定为 0 号并置于最前，
    // 这样传入 2 个名字即得到「你 + 2 个机器人」共 3 人，符合“默认 2 个 agent，3~4 人”的设计。
    this.players = [
      { id: 0, name: humanName, isHuman: true, role: null, hand: [], handCount: 0, isCurrent: false, lastPlay: null },
      ...names.map((name, i) => ({
        id: i + 1,
        name,
        isHuman: false,
        role: null,
        hand: [],
        handCount: 0,
        isCurrent: false,
        lastPlay: null,
      })),
    ];
    this.noJokers = noJokers;
    this.deal();
  }

  private noJokers = false;

  private deal() {
    const deck = shuffle(makeDdzDeck(!this.noJokers));
    // 3 人局：54 张，每人 17 张，余 3 张作底牌；
    // 4 人局（无王）：52 张，每人 12 张，余 4 张作底牌（地主拿到后 16 张）
    const handSize = this.noJokers ? 12 : 17;
    for (const p of this.players) {
      p.hand = sortDdzCards(deck.splice(0, handSize));
      p.handCount = p.hand.length;
      p.lastPlay = null;
      p.role = null;
    }
    this.landlordCards = deck; // 剩余作底牌（3 人局 3 张 / 4 人局 4 张）
    this.phase = "bidding";
    this.currentBid = 0;
    this.bidHistory = [];
    this.lastPlay = null;
    this.lastPlayerId = null;
    this.passCount = 0;
    this.winner = null;
    this.resetActions();
    this.played = [];
    // 随机先叫，按人数生成叫分顺序
    const first = Math.floor(Math.random() * this.players.length);
    const n = this.players.length;
    this.biddingOrder = Array.from({ length: n }, (_, k) => (first + k) % n);
    this.bidPtr = 0;
    this.currentPlayerId = this.biddingOrder[0];
    this.message = "叫地主阶段：谁叫的分高谁当地主";
  }

  /** 人类/机器人叫分。score: 0=不叫，1/2/3=叫分（必须 > currentBid 除非 0） */
  bid(playerId: number, score: number): DdzState {
    if (this.phase !== "bidding") return this.getState();
    if (this.currentPlayerId !== playerId) return this.getState();
    // 叫分不够高：视为不叫（推进回合，避免死循环）
    if (score !== 0 && score <= this.currentBid) score = 0;

    this.bidHistory.push({ playerId, score });
    if (score > 0) this.currentBid = score;

    // 叫到 3 分立即结束；否则轮到下一位；全部叫完则结束
    if (score === 3) {
      this.finishBidding();
      return this.getState();
    }
    this.bidPtr++;
    if (this.bidPtr >= this.biddingOrder.length) {
      this.finishBidding();
    } else {
      this.currentPlayerId = this.biddingOrder[this.bidPtr];
    }
    return this.getState();
  }

  private finishBidding() {
    if (this.currentBid === 0) {
      // 全员不叫，重新发牌
      this.redealCount++;
      this.message = "无人叫地主，重新发牌…";
      this.deal();
      return;
    }
    const landlordId = [...this.bidHistory].reverse().find((b) => b.score > 0)!.playerId;
    this.players[landlordId].role = "landlord";
    for (const p of this.players) if (p.id !== landlordId) p.role = "farmer";
    // 底牌归地主
    this.players[landlordId].hand = sortDdzCards([...this.players[landlordId].hand, ...this.landlordCards]);
    this.players[landlordId].handCount = this.players[landlordId].hand.length;
    this.phase = "playing";
    this.currentPlayerId = landlordId;
    this.lastPlay = null;
    this.lastPlayerId = null;
    this.passCount = 0;
    this.message = `${this.players[landlordId].name} 成为地主，获得底牌`;
  }

  /** 出牌 */
  play(playerId: number, cardIds: string[]): DdzState {
    if (this.phase !== "playing") return this.getState();
    if (this.currentPlayerId !== playerId) return this.getState();
    const player = this.players[playerId];
    const cards = cardIds
      .map((id) => player.hand.find((c) => c.id === id))
      .filter((c): c is Card => !!c);
    const pattern = detectPattern(cards);
    if (!pattern) return this.getState(); // 非法牌型
    if (this.lastPlay) {
      const lastPattern = detectPattern(this.lastPlay)!;
      if (!canBeat(pattern, lastPattern)) return this.getState(); // 压不过
    }
    // 执行出牌
    this.actions.push({ playerId, type: "play", cards });
    this.played.push(...cards);
    const idSet = new Set(cardIds);
    player.hand = player.hand.filter((c) => !idSet.has(c.id));
    player.handCount = player.hand.length;
    // 仅更新出牌者自己的展示，其它座位前保留各自最近一次出牌；
    // 该玩家下次出牌时此处会被新牌覆盖（满足“下次出牌覆盖上一次显示”）。
    player.lastPlay = cards;
    this.lastPlay = cards;
    this.lastPlayerId = playerId;
    this.passCount = 0;

    if (player.hand.length === 0) {
      this.phase = "gameover";
      this.winner = player.role;
      this.message = `${player.name} 出完所有牌，${player.role === "landlord" ? "地主" : "农民"}获胜！`;
      return this.getState();
    }
    this.advance();
    return this.getState();
  }

  /** 不出 */
  pass(playerId: number): DdzState {
    if (this.phase !== "playing") return this.getState();
    if (this.currentPlayerId !== playerId) return this.getState();
    if (this.lastPlay === null) return this.getState(); // 自由出牌不能不出
    this.passCount++;
    this.actions.push({ playerId, type: "pass", cards: null });
    // 不出不改变各座位前已展示的出牌（覆盖式更新仅发生在再次出牌时）
    if (this.passCount >= this.players.length - 1) {
      // 其他人都过，由上一手出牌者重新领出
      const leader = this.lastPlayerId;
      this.lastPlay = null;
      this.lastPlayerId = null;
      this.passCount = 0;
      this.currentPlayerId = leader;
      this.message = leader !== null ? `新一轮，由 ${this.players[leader].name} 领出` : `${this.players[playerId].name} 不出`;
    } else {
      this.message = `${this.players[playerId].name} 不出`;
      this.advance();
    }
    return this.getState();
  }

  private prevPlayer(id: number): number {
    return (id - 1 + this.players.length) % this.players.length;
  }

  private advance() {
    this.currentPlayerId = (this.currentPlayerId! + 1) % this.players.length;
    this.message = `轮到 ${this.players[this.currentPlayerId!].name}`;
  }

  getState(): DdzState {
    return {
      phase: this.phase,
      players: this.players.map((p) => ({ ...p, hand: [...p.hand] })),
      myHand: [...this.players[0].hand],
      landlordCards: [...this.landlordCards],
      currentPlayerId: this.currentPlayerId,
      lastPlay: this.lastPlay ? [...this.lastPlay] : null,
      lastPlayerId: this.lastPlayerId,
      passCount: this.passCount,
      winner: this.winner,
      bidHistory: [...this.bidHistory],
      currentBid: this.currentBid,
      message: this.message,
      biddingOrder: [...this.biddingOrder],
      bidPtr: this.bidPtr,
      redealCount: this.redealCount,
      recentActions: this.recentActions(8).map((a) => ({ ...a, cards: a.cards ? [...a.cards] : null })),
      playedCards: [...this.played],
      actionCount: this.actionCount,
    };
  }
}

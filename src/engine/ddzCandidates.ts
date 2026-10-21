/**
 * 斗地主「候选动作」枚举与启发式评分。
 *
 * 设计动机：大模型玩斗地主的失败，绝大多数不是"不会打牌"，而是"凭空构造牌面"。
 * 让模型自由输出 ["♠3","♥3"] 时，它要同时完成：枚举合法牌型 → 判断能否压过 → 精确拼写牌面，
 * 任何一步出错就映射失败、退化成规则兜底出最烂的牌。
 *
 * 正确做法（与 DouZero 同构）：先由引擎枚举出**所有合法候选**，再让决策者做选择题。
 * 本模块负责枚举 + 打分，供三者共用：
 *   - 规则 AI：`bestPlay()` 直接取评分最高者（替掉旧的 suggestLead / findBeats）
 *   - 大模型：`candidatesForLlm()` 裁剪出多样化候选，编号后注入 prompt
 *   - 人类提示：与大模型共用同一份候选，保证"提示"和"AI 认为该出的"口径一致
 */
import { ddzValue, type Card } from "./cards";
import {
  detectPattern,
  findAllBeats,
  type CardPattern,
  type PatternType,
} from "./doudizhu";

const TYPE_NAME: Record<PatternType, string> = {
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

/** 一个合法的出牌候选 */
export interface PlayCandidate {
  cards: Card[];
  pattern: CardPattern;
  /** 中文牌型名，给大模型看 */
  typeName: string;
  /** 主牌力（用于比较大小，2=15） */
  mainRank: number;
  isBomb: boolean;
  isRocket: boolean;
  /** 出完这手后还剩几张 */
  handLeft: number;
  /** 启发式评分，越大越优 */
  score: number;
}

/** 做一个出牌决策需要的全部上下文 */
export interface PlayContext {
  hand: Card[];
  /** 需要压过的牌；null 表示本轮自由领出 */
  last: CardPattern | null;
  /** 上家那手牌是谁打的（null 表示自由领出） */
  lastPlayerId: number | null;
  myId: number;
  /** 地主座位号，未定时为 null */
  landlordId: number | null;
  /** 各家剩余手牌数 */
  handCounts: Record<number, number>;
}

/** 我的对手座位号（地主→所有农民；农民→只有地主） */
function opponentsOf(ctx: PlayContext): number[] {
  const ids = Object.keys(ctx.handCounts).map(Number).filter(id => id !== ctx.myId);
  if (ctx.landlordId == null) return ids;
  return ctx.myId === ctx.landlordId ? ids : [ctx.landlordId];
}

/** 上家是不是我的队友（农民视角：另一个农民） */
function lastIsTeammate(ctx: PlayContext): boolean {
  if (ctx.lastPlayerId == null) return false;
  if (ctx.landlordId == null) return false;
  if (ctx.myId === ctx.landlordId) return false; // 我是地主，没有队友
  return ctx.lastPlayerId !== ctx.landlordId; // 上家不是地主 → 是队友
}

/**
 * 启发式评分。分数越高越应该出这手。
 * 只做"常识层"的判断，不追求最优——真正的最优交给大模型或 RL。
 */
function scoreOne(cards: Card[], handSize: number, ctx: PlayContext): number {
  const p = detectPattern(cards);
  if (!p) return -Infinity;

  const handLeft = handSize - cards.length;
  const isRocket = p.type === "rocket";
  const isBomb = p.type === "bomb" || isRocket;

  let s = 0;

  // 1) 能一手走完 / 逼近走完：压倒性优先
  if (handLeft === 0) s += 10000;
  else if (handLeft === 1) s += 400;
  else if (handLeft === 2) s += 120;

  // 2) 残局封堵：对手快走完时，能压就必须压
  const oppLeft = opponentsOf(ctx).map(id => ctx.handCounts[id] ?? 99);
  const minOpp = oppLeft.length ? Math.min(...oppLeft) : 99;
  if (ctx.last) {
    if (minOpp <= 2) s += 600;
    else if (minOpp <= 5) s += 120;
  }

  // 3) 不压队友：队友出的牌一般别压（除非能一把走完 / 对手要跑）
  if (lastIsTeammate(ctx)) {
    s -= handLeft === 0 ? 0 : 250;
    if (minOpp <= 2) s += 300; // 但地主/对手要跑时还是要压
  }

  // 4) 牌力成本：出的主牌越大越亏
  //    注意引擎把王炸的 mainRank 记为 100（用于压一切），若照搬线性惩罚，
  //    王炸会被打到极低分 → 规则 AI 永远不会出王炸。所以炸弹/王炸单独处理。
  if (isRocket) s -= 0; // 王炸不存在"出大了浪费"的问题，成本只体现在保留价值上
  else if (p.type === "bomb") s -= p.mainRank * 0.8;
  else s -= p.mainRank * 1.5;

  // 5) 一次多清几张是好事（尤其长牌型消耗散牌）
  s += cards.length * 6;
  if (p.type === "straight" || p.type === "pair_straight" || p.type === "airplane") s += 60;

  // 6) 炸弹/王炸：宝贵的控场资源，非必要不打
  if (isRocket) s -= 200;
  else if (isBomb) s -= 90;
  // 残局或对手要跑时，炸弹该用就用
  if (isBomb && minOpp <= 3) s += 260;

  // 7) 别拆炸弹：手里有 4 张同点数却只出其中一部分
  if (!isBomb) {
    const counts = new Map<number, number>();
    for (const c of ctx.hand) {
      const v = ddzValue(c);
      counts.set(v, (counts.get(v) ?? 0) + 1);
    }
    for (const c of cards) {
      if (c.suit === "joker") continue;
      if ((counts.get(ddzValue(c)) ?? 0) >= 4) s -= 100;
    }
  }

  // 8) 别拆王炸：手里明明有双王，却只打出其中一张
  //    （只有单王时出它是正常打法，不惩罚）
  if (!isRocket && cards.some(c => c.suit === "joker")) {
    const hasSmall = ctx.hand.some(x => x.suit === "joker" && x.rank === 16);
    const hasBig = ctx.hand.some(x => x.suit === "joker" && x.rank === 17);
    s -= hasSmall && hasBig ? 220 : 30;
  }

  return s;
}

/**
 * 枚举当前所有合法候选（含评分）。last 为 null 时枚举自由领出的所有牌型。
 * 返回按评分降序。
 */
export function enumeratePlays(ctx: PlayContext): PlayCandidate[] {
  const combos = findAllBeats(ctx.hand, ctx.last);
  const out: PlayCandidate[] = [];
  for (const cards of combos) {
    const p = detectPattern(cards);
    if (!p) continue;
    out.push({
      cards,
      pattern: p,
      typeName: TYPE_NAME[p.type],
      mainRank: p.mainRank,
      isBomb: p.type === "bomb" || p.type === "rocket",
      isRocket: p.type === "rocket",
      handLeft: ctx.hand.length - cards.length,
      score: scoreOne(cards, ctx.hand.length, ctx),
    });
  }
  out.sort((a, b) => b.score - a.score);
  return out;
}

/**
 * 规则 AI 选牌：返回要出的牌，null 表示"不出"。
 * 自由领出时若枚举为空（理论上不会），退化到出最小的一张，绝不返回空数组。
 */
export function bestPlay(ctx: PlayContext): Card[] | null {
  const all = enumeratePlays(ctx);
  if (all.length) return all[0].cards;
  if (ctx.last) return null; // 压不过 → 不出
  // 自由领出却枚举不出牌型（极端情况）：出最小的一张
  const sorted = [...ctx.hand].sort((a, b) => ddzValue(a) - ddzValue(b));
  return sorted.slice(0, 1);
}

/**
 * 给大模型的候选：按牌型分组做 round-robin 采样，
 * 保证模型既能看到"最小的常规牌"，也能看到长牌型、炸弹等不同选择，
 * 而不是被规则评分前 N 名（往往全是单张）淹没。
 */
export function candidatesForLlm(ctx: PlayContext, limit = 14): PlayCandidate[] {
  const all = enumeratePlays(ctx);
  const groups = new Map<string, PlayCandidate[]>();
  for (const c of all) {
    const arr = groups.get(c.typeName) ?? [];
    arr.push(c);
    groups.set(c.typeName, arr);
  }
  const lists = [...groups.values()];
  for (const arr of lists) arr.sort((a, b) => b.score - a.score);

  const out: PlayCandidate[] = [];
  for (let i = 0; out.length < limit; i++) {
    let added = false;
    for (const arr of lists) {
      if (i >= arr.length) continue;
      out.push(arr[i]);
      added = true;
      if (out.length >= limit) break;
    }
    if (!added) break;
  }
  return out;
}

/** 交给大模型的候选（结构与 llm.ts 的 LlmCandidate 一致） */
export interface LlmChoice {
  index: number;
  typeName: string;
  cards: string[];
  handLeft: number;
  isBomb: boolean;
}

/** 枚举 + 裁剪 + 编号，一步到位生成给大模型的候选列表 */
export function toLlmChoices(
  ctx: PlayContext,
  label: (c: Card) => string,
  limit = 14,
): LlmChoice[] {
  return candidatesForLlm(ctx, limit).map((c, i) => ({
    index: i + 1,
    typeName: c.typeName,
    cards: c.cards.map(label),
    handLeft: c.handLeft,
    isBomb: c.isBomb,
  }));
}

/** 牌面文本：♠3 / 大王 */
export function labelOf(c: Card, suitSymbol: Record<string, string>, rankLabel: (v: number) => string): string {
  if (c.suit === "joker") return c.rank === 17 ? "大王" : "小王";
  return suitSymbol[c.suit] + rankLabel(c.rank);
}

export { TYPE_NAME };

// 共享卡牌工具：标准 52 张牌 + 斗地主 54 张（含大小王）
// 所有游戏引擎依赖此模块，纯 TS 实现，不依赖 Tauri。

export type StdSuit = "spades" | "hearts" | "diamonds" | "clubs";
export type Suit = StdSuit | "joker";

export interface Card {
  suit: Suit;
  rank: number; // 标准牌 2..14（A=14）；王：16=小王，17=大王
  id: string; // 唯一标识，例如 "hearts-14"
}

export const STD_SUITS: StdSuit[] = ["spades", "hearts", "diamonds", "clubs"];

export const SUIT_SYMBOL: Record<Suit, string> = {
  spades: "♠",
  hearts: "♥",
  diamonds: "♦",
  clubs: "♣",
  joker: "",
};

export function isRed(card: Card): boolean {
  return card.suit === "hearts" || card.suit === "diamonds";
}

/** 点数显示文字（A/J/Q/K/数字），王显示特殊字符 */
export function rankLabel(card: Card): string {
  if (card.suit === "joker") return card.rank === 17 ? "JOKER" : "joker";
  const r = card.rank;
  if (r === 14) return "A";
  if (r === 13) return "K";
  if (r === 12) return "Q";
  if (r === 11) return "J";
  if (r === 10) return "10";
  return String(r);
}

/** 标准 52 张牌 */
export function makeStdDeck(): Card[] {
  const deck: Card[] = [];
  for (const suit of STD_SUITS) {
    for (let rank = 2; rank <= 14; rank++) {
      deck.push({ suit, rank, id: `${suit}-${rank}` });
    }
  }
  return deck;
}

/** 斗地主牌堆；includeJokers=false 时只发 52 张（四人局无大小王） */
export function makeDdzDeck(includeJokers = true): Card[] {
  const deck = makeStdDeck();
  if (includeJokers) {
    deck.push({ suit: "joker", rank: 16, id: "joker-small" });
    deck.push({ suit: "joker", rank: 17, id: "joker-big" });
  }
  return deck;
}

/** Fisher–Yates 洗牌（原地会修改入参，返回新数组） */
export function shuffle<T>(arr: T[]): T[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 斗地主牌力值：3<4<…<J<Q<K<A<2<小王<大王。
 * 卡面 rank 中 2 是 2、A 是 14，直接比 rank 会让「2 比 3 还小」，
 * 因此斗地主相关的所有大小比较都必须走这个函数（2 提升为 15）。
 */
export function ddzValue(card: Card): number {
  return card.rank === 2 ? 15 : card.rank;
}

/** 斗地主手牌排序：牌力大的在前（2 紧随 A 之后、王之前），同点数按花色固定顺序 */
export function sortDdzCards(cards: Card[]): Card[] {
  const order: Record<Suit, number> = {
    spades: 0,
    hearts: 1,
    clubs: 2,
    diamonds: 3,
    joker: 4,
  };
  return [...cards].sort((a, b) => {
    const va = ddzValue(a);
    const vb = ddzValue(b);
    if (vb !== va) return vb - va;
    return order[a.suit] - order[b.suit];
  });
}

/** 德州手牌排序：点数大的在前（A 当 14） */
export function sortStdCards(cards: Card[]): Card[] {
  return [...cards].sort((a, b) => b.rank - a.rank);
}

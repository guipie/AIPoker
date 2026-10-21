/**
 * 规则 AI 新旧策略对战：量化这次「候选枚举 + 启发式评分」改造到底变强了多少。
 *
 * 新策略 = bestPlay（枚举全部候选后按启发式评分选最优）
 * 旧策略 = findBeats / suggestLead（有压就压最小的、领出就出最小单张）
 *
 * 做法：同一套牌局上，让新旧策略分别坐「地主方」和「农民方」各打 N 局，
 * 对称交换后统计新策略的胜率，排除位置带来的偏差。
 */
import { type Card } from "../src/engine/cards";
import { bestPlay, enumeratePlays, type PlayContext } from "../src/engine/ddzCandidates";
import { DoudizhuGame, detectPattern, findBeats, suggestLead, suggestBid } from "../src/engine/doudizhu";

type Policy = "new" | "old";

function ctxFrom(s: any, player: any): PlayContext {
  const landlord = s.players.find((p: any) => p.role === "landlord");
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

/** 按策略给出决策：返回要出的牌，null 表示不出 */
function decide(s: any, player: any, pol: Policy): Card[] | null {
  const ctx = ctxFrom(s, player);
  if (pol === "new") return bestPlay(ctx);
  // 旧策略
  if (!ctx.last) return suggestLead(player.hand as Card[]);
  return findBeats(player.hand as Card[], ctx.last);
}

interface Result {
  landlordSeat: number;
  farmerWin: boolean;
}

/** 跑一局：landlordSeat 用 polL，其余农民用 polF */
function runGame(polL: Policy, polF: Policy, landlordSeat: number): Result {
  const g = new DoudizhuGame(["BotA", "BotB"], "Human", false);
  let s: any = g.getState();

  // 抢地主：目标座位叫 3 分抢下，其余不叫
  let guard = 0;
  while (s.phase === "bidding" && guard++ < 20) {
    const cur = s.currentPlayerId;
    const score = cur === landlordSeat ? 3 : 0;
    s = g.bid(cur, score);
  }
  if (s.phase !== "playing") return { landlordSeat, farmerWin: false };

  guard = 0;
  while (s.phase === "playing" && guard++ < 3000) {
    const cur = s.currentPlayerId;
    const player = s.players[cur];
    const pol = cur === landlordSeat ? polL : polF;
    const cards = decide(s, player, pol);
    if (cards && cards.length) s = g.play(cur, cards.map(c => c.id));
    else s = g.pass(cur);
  }

  const landlord = s.players.find((p: any) => p.role === "landlord");
  return { landlordSeat: landlord ? landlord.id : landlordSeat, farmerWin: !!s.winner && s.winner !== "landlord" };
}

const N = 300;

function duel(newSide: "landlord" | "farmer"): number {
  let newWins = 0;
  let played = 0;
  for (let i = 0; i < N; i++) {
    const seat = i % 3; // 轮换座位，避免位置偏差
    const r =
      newSide === "landlord" ? runGame("new", "old", seat) : runGame("old", "new", seat);
    played++;
    const newWon = newSide === "landlord" ? !r.farmerWin : r.farmerWin;
    if (newWon) newWins++;
  }
  return (newWins / played) * 100;
}

console.log(`每组 ${N} 局，双方同一套牌局逻辑，仅策略不同\n`);

const asLandlord = duel("landlord");
const asFarmer = duel("farmer");

console.log(`新策略坐地主 vs 旧策略农民：新策略胜率 ${asLandlord.toFixed(1)}%`);
console.log(`新策略坐农民 vs 旧策略地主：新策略胜率 ${asFarmer.toFixed(1)}%`);
console.log(
  `\n结论：新策略平均胜率 ${((asLandlord + asFarmer) / 2).toFixed(1)}%（50% = 没有提升）`,
);

// 顺带看看候选枚举的规模，确认没有组合爆炸
{
  const g = new DoudizhuGame(["BotA", "BotB"], "Human", false);
  let s: any = g.getState();
  let guard = 0;
  while (s.phase === "bidding" && guard++ < 20) s = g.bid(s.currentPlayerId, suggestBid(s.players[s.currentPlayerId].hand));
  if (s.phase === "playing") {
    const p = s.players[s.currentPlayerId];
    const n = enumeratePlays(ctxFrom(s, p)).length;
    console.log(`\n开局首出候选数：${n} 个（手牌 ${p.hand.length} 张）`);
  }
}

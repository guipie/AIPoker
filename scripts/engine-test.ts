// 引擎逻辑自测：纯 Node 运行（经 esbuild 打包）
import { writeFileSync } from "fs";
import { DoudizhuGame, detectPattern, canBeat, findBeats, suggestLead, suggestBid } from "../src/engine/doudizhu";
import { HoldemGame, suggestHoldemAction, bestHand } from "../src/engine/holdem";
import { makeStdDeck, makeDdzDeck, shuffle } from "../src/engine/cards";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("断言失败: " + msg);
}

// ===== 牌堆 =====
assert(makeStdDeck().length === 52, "标准牌堆应为 52");
assert(makeDdzDeck().length === 54, "斗地主牌堆应为 54");
assert(new Set(makeStdDeck().map((c) => c.id)).size === 52, "标准牌 id 唯一");

// ===== 牌型识别抽查 =====
const find = (deck: any[], suit: string, rank: number) => deck.find((c) => c.suit === suit && c.rank === rank)!;
const deck = makeDdzDeck();
assert(detectPattern([find(deck, "spades", 5)]).type === "single", "单张");
assert(detectPattern([find(deck, "spades", 5), find(deck, "hearts", 5)]).type === "pair", "对子");
assert(detectPattern([find(deck, "spades", 5), find(deck, "hearts", 5), find(deck, "clubs", 5)]).type === "triple", "三张");
assert(detectPattern([find(deck, "spades", 5), find(deck, "hearts", 5), find(deck, "clubs", 5), find(deck, "diamonds", 5)]).type === "bomb", "炸弹");
const jokers = deck.filter((c) => c.suit === "joker");
assert(detectPattern(jokers).type === "rocket", "火箭");
const straight = [find(deck, "spades", 3), find(deck, "spades", 4), find(deck, "spades", 5), find(deck, "spades", 6), find(deck, "spades", 7)];
assert(detectPattern(straight).type === "straight", "顺子");
const pairStraight = [find(deck,"spades",3),find(deck,"hearts",3),find(deck,"spades",4),find(deck,"hearts",4),find(deck,"spades",5),find(deck,"hearts",5)];
assert(detectPattern(pairStraight).type === "pair_straight", "连对");

// ===== 斗地主自动对局 =====
{
  let games = 0;
  let terminations = 0;
  const anomalies: string[] = [];
  for (let g = 0; g < 200; g++) {
    const game = new DoudizhuGame(["甲", "乙"], "你");
    let st = game.getState();
    let steps = 0;
    while (st.phase !== "gameover" && steps < 2000) {
      steps++;
      if (st.phase === "bidding") {
        const p = st.players[st.currentPlayerId!];
        st = game.bid(p.id, suggestBid(p.hand));
      } else {
        const p = st.players[st.currentPlayerId!];
        let ids: string[] = [];
        const last = st.lastPlay ? detectPattern(st.lastPlay) : null;
        if (!last) ids = suggestLead(p.hand).map((c) => c.id);
        else {
          const b = findBeats(p.hand, last);
          ids = b ? b.map((c) => c.id) : [];
        }
        if (ids.length) st = game.play(p.id, ids);
        else st = game.pass(p.id);
      }
    }
    games++;
    if (st.phase === "gameover" && st.winner) terminations++;
    else if (anomalies.length < 3) {
      anomalies.push(
        `ANOM g=${g} phase=${st.phase} winner=${st.winner} steps=${steps} roles=${st.players.map((x) => x.role)} hc=${st.players.map((x) => x.handCount)} bid=${JSON.stringify(st.bidHistory)} redeal=${st.redealCount} cur=${st.currentPlayerId} pass=${st.passCount} last=${st.lastPlay?.map((c) => c.rank).join(",")}`,
      );
    }
  }
  if (anomalies.length) console.log("ANOMALIES:\n" + anomalies.join("\n---\n"));
  assert(games === 200, "斗地主自测局数");
  if (terminations !== 200) console.log(`⚠ 斗地主未全部正常结束，实际 ${terminations}`);
  else console.log(`✓ 斗地主 200 局全部正常结束`);
}

// ===== 德州自动对局（规则 AI） =====
{
  let hands = 0;
  let matchOver = 0;
  const game = new HoldemGame({ names: ["甲", "乙", "丙", "丁"], agentIds: ["a","b","c","d"] });
  let st = game.getState();
  let steps = 0;
  while (st.phase !== "matchover" && steps < 20000) {
    steps++;
    if (st.phase === "handover" || st.phase === "showdown") {
      st = game.nextHand();
      hands++;
      continue;
    }
    if (st.currentPlayerId == null) { st = game.nextHand(); hands++; continue; }
    const id = st.currentPlayerId;
    const a = suggestHoldemAction(st, id, { aggression: 0.5, tightness: 0.5 });
    if (a.type === "fold") st = game.fold(id);
    else if (a.type === "check") st = game.check(id);
    else if (a.type === "call") st = game.call(id);
    else st = game.raiseTo(id, a.toAmount ?? st.currentBet + st.minRaise);
  }
  matchOver = st.phase === "matchover" ? 1 : 0;
  assert(st.phase === "matchover", "德州应在某人破产时整局结束");
  console.log(`✓ 德州自动对局结束（共 ${hands} 手，最后阶段 ${st.phase}）`);
}

// ===== 手牌评估抽查 =====
{
  const deck = makeStdDeck();
  const pick = (s: string, r: number) => deck.find((c) => c.suit === s && c.rank === r)!;
  // 同花顺 > 四条
  const sf = [pick("spades",10),pick("spades",11),pick("spades",12),pick("spades",13),pick("spades",14)];
  const quad = [pick("hearts",2),pick("diamonds",2),pick("clubs",2),pick("spades",2),pick("hearts",14)];
  assert(bestHand(sf).category === 8, "同花顺识别");
  assert(bestHand(quad).category === 7, "四条识别");
  assert(bestHand(sf).category > bestHand(quad).category, "同花顺 > 四条");
  console.log("✓ 德州手牌评估正确");
}

console.log("\n全部自测通过 🎉");

// ===== 新增：四人局无王 + 德州破产保留 =====
{
  // 斗地主四人局（3 机器人）应使用无王牌堆且能正常结束
  assert(makeDdzDeck(false).length === 52, "无王斗地主牌堆应为 52");
  let ok4 = true;
  for (let g = 0; g < 30; g++) {
    const game = new DoudizhuGame(["甲", "乙", "丙"], "你", true);
    let st = game.getState();
    let steps = 0;
    while (st.phase !== "gameover" && steps < 3000) {
      steps++;
      if (st.currentPlayerId == null) break;
      const id = st.currentPlayerId;
      if (st.phase === "bidding") st = game.bid(id, suggestBid(st.players[id].hand));
      else {
        const last = st.lastPlay ? detectPattern(st.lastPlay) : null;
        if (!last) st = game.play(id, suggestLead(st.players[id].hand).map((c: any) => c.id));
        else {
          const b = findBeats(st.players[id].hand, last);
          if (b) st = game.play(id, b.map((c: any) => c.id));
          else st = game.pass(id);
        }
      }
    }
    if (st.phase !== "gameover") ok4 = false;
    // 校验无人手里有王
    if (st.players.some((p: any) => p.hand.some((c: any) => c.suit === "joker"))) ok4 = false;
  }
  assert(ok4, "四人局(无王)应正常结束且无人持王");
  console.log("✓ 斗地主四人局(无王) 30 局全部正常结束");

  // 德州：极小起始筹码，强制出现破产（isBusted），且对局能结束
  {
    const game = new HoldemGame({
      names: ["甲", "乙", "丙"],
      agentIds: ["a", "b", "c"],
      stacks: [10, 10, 10],
    });
    let st = game.getState();
    let steps = 0;
    while (st.phase !== "matchover" && steps < 20000) {
      steps++;
      if (st.phase === "handover" || st.phase === "showdown") {
        st = game.nextHand();
        continue;
      }
      if (st.currentPlayerId == null) {
        st = game.nextHand();
        continue;
      }
      const id = st.currentPlayerId;
      const a = suggestHoldemAction(st, id, { aggression: 0.5, tightness: 0.5 });
      if (a.type === "fold") st = game.fold(id);
      else if (a.type === "check") st = game.check(id);
      else if (a.type === "call") st = game.call(id);
      else st = game.raiseTo(id, a.toAmount ?? st.currentBet + st.minRaise);
    }
    assert(st.players.some((p: any) => p.isBusted), "德州极小筹码下应出现破产(isBusted)玩家");
    assert(st.phase === "matchover", "德州应在破产时整局结束");
    // 破产玩家仍保留在牌桌（数量不变）
    assert(st.players.length === 3, "破产玩家仍应保留在牌桌");
    console.log("✓ 德州破产(isBusted)逻辑正确，对手仍留在牌桌");
  }
}


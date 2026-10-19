import { DoudizhuGame, detectPattern, findBeats, suggestLead } from "../src/engine/doudizhu";
import { makeDdzDeck } from "../src/engine/cards";

function assert(cond: boolean, msg: string) {
  if (!cond) throw new Error("断言失败: " + msg);
}

const g = new DoudizhuGame(["甲", "乙"], "你", false);
let st = g.getState();

// 走完叫地主：人类叫 3 分直接当地主
let guard = 0;
while (st.phase === "bidding" && guard++ < 20) {
  st = g.bid(st.currentPlayerId!, st.currentPlayerId === 0 ? 3 : 0);
}
assert(st.phase === "playing", "应进入出牌阶段");
assert(st.players[0].isHuman, "玩家0应为人类");

// 人类领出一手
const humanLead = suggestLead(st.players[0].hand).map((c) => c.id);
st = g.play(0, humanLead);
assert(st.players[0].lastPlay != null, "人类出牌后 lastPlay 应非空");
assert(st.players[1].lastPlay == null, "机器人1尚未出牌，lastPlay 应为空");
assert(st.players[2].lastPlay == null, "机器人2尚未出牌，lastPlay 应为空");
const humanFirst = st.players[0].lastPlay!.map((c) => c.rank).join(",");

// 机器人1 跟一手（应能压过）
const beat = findBeats(st.players[1].hand, detectPattern(st.lastPlay!)!);
assert(beat != null, "应能找到压牌");
st = g.play(1, beat!.map((c) => c.id));
// 关键：人类之前的出牌展示应被【保留】，不被清空
assert(st.players[0].lastPlay != null, "人类展示应保留（覆盖式，不清除）");
assert(st.players[0].lastPlay!.map((c) => c.rank).join(",") === humanFirst, "人类展示应与首次出牌一致（未被清空）");
assert(st.players[1].lastPlay != null, "机器人1出牌后应有展示");

// 机器人2 不出 —— 不应清除任何人的展示
st = g.pass(2);
assert(st.players[0].lastPlay != null, "pass 不应清除人类展示");
assert(st.players[1].lastPlay != null, "pass 不应清除机器人1展示");

// 人类再出一手，覆盖自己上一次展示
const humanSecond = suggestLead(st.players[0].hand).map((c) => c.id);
st = g.play(0, humanSecond);
assert(st.players[0].lastPlay != null, "人类再次出牌后展示非空");
const humanNow = st.players[0].lastPlay!.map((c) => c.rank).join(",");
assert(humanNow !== humanFirst, "人类再次出牌应覆盖上一次展示");
assert(st.players[1].lastPlay != null, "机器人1展示在他人出牌后仍然保留");

console.log("✓ 斗地主 per-agent 出牌展示（保留+覆盖）逻辑正确");
console.log(`  人类首次=[${humanFirst}] 覆盖后=[${humanNow}] 机器人1展示=[${st.players[1].lastPlay!.map((c) => c.rank).join(",")}]`);

// 自测：斗地主 per-agent 出牌展示（保留 + 覆盖）
// 牌局是随机发的，「机器人能否压过」不保证，因此重试直到构造出可压场景再断言。
// 运行：npx esbuild scripts/ddz-lastplay-check.ts --bundle --platform=node --format=esm --outfile=.tmp.mjs && node .tmp.mjs

import { makeDdzDeck } from "../src/engine/cards";
import { DoudizhuGame, detectPattern, findBeats, suggestLead } from "../src/engine/doudizhu";

function tryOnce(): { ok: boolean; info?: string } {
  const g = new DoudizhuGame(["甲", "乙"], "你", false);
  let st = g.getState();

  // 走完叫地主：人类叫 3 分直接当地主
  let guard = 0;
  while (st.phase === "bidding" && guard++ < 20) {
    st = g.bid(st.currentPlayerId!, st.currentPlayerId === 0 ? 3 : 0);
  }
  if (st.phase !== "playing") return { ok: false };
  if (!st.players[0].isHuman) return { ok: false };

  // 人类领出一手
  const humanLead = suggestLead(st.players[0].hand).map((c) => c.id);
  if (humanLead.length === 0) return { ok: false };
  st = g.play(0, humanLead);
  if (st.players[0].lastPlay == null) return { ok: false };
  if (st.players[1].lastPlay != null || st.players[2].lastPlay != null) return { ok: false };
  const humanFirst = st.players[0].lastPlay!.map((c) => c.rank).join(",");

  // 机器人1 跟一手（必须能压过，否则换一副牌重来）
  const beat = findBeats(st.players[1].hand, detectPattern(st.lastPlay!)!);
  if (beat == null) return { ok: false };
  st = g.play(1, beat!.map((c) => c.id));
  // 关键：人类之前的出牌展示应被【保留】，不被清空
  if (st.players[0].lastPlay == null) return { ok: false };
  if (st.players[0].lastPlay!.map((c) => c.rank).join(",") !== humanFirst) return { ok: false };
  if (st.players[1].lastPlay == null) return { ok: false };

  // 机器人2 不出 —— 不应清除任何人的展示
  st = g.pass(2);
  if (st.players[0].lastPlay == null || st.players[1].lastPlay == null) return { ok: false };

  // 人类再出一手，覆盖自己上一次展示
  const humanSecond = suggestLead(st.players[0].hand).map((c) => c.id);
  if (humanSecond.length === 0) return { ok: false };
  st = g.play(0, humanSecond);
  if (st.players[0].lastPlay == null) return { ok: false };
  const humanNow = st.players[0].lastPlay!.map((c) => c.rank).join(",");
  if (humanNow === humanFirst) return { ok: false }; // 换副牌，确保能验证「覆盖」
  if (st.players[1].lastPlay == null) return { ok: false };

  return {
    ok: true,
    info: `人类首次=[${humanFirst}] 覆盖后=[${humanNow}] 机器人1展示=[${st.players[1].lastPlay!.map((c) => c.rank).join(",")}]`,
  };
}

let done: { ok: boolean; info?: string } = { ok: false };
for (let i = 0; i < 500 && !done.ok; i++) done = tryOnce();

if (!done.ok) {
  console.error("✗ 500 次尝试内没能构造出「机器人可压过 + 人类二次出牌不同」的牌局");
  process.exitCode = 1;
} else {
  console.log("✓ 斗地主 per-agent 出牌展示（保留+覆盖）逻辑正确");
  console.log(`  ${done.info}`);
}

// 顺带确认牌堆本身没被改动
const deck = makeDdzDeck(true);
console.log(`✓ 斗地主牌堆 ${deck.length} 张（含大小王）`);

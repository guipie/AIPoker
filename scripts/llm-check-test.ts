// 自测：斗地主出牌记录（recentActions） + 大模型连通性检测的基础校验
import { DoudizhuGame } from "../src/engine/doudizhu";
import { testLlmConnection } from "../src/engine/llm";

let failed = 0;
function assert(cond: any, msg: string) {
  if (!cond) {
    console.error("❌ " + msg);
    failed++;
  } else {
    console.log("✓ " + msg);
  }
}

// 1) recentActions 记录 play / pass
const g = new DoudizhuGame(["甲", "乙"], "你");
let s: any = g.getState();
s = g.bid(s.currentPlayerId, 3); // 当前叫分者叫 3 分，确定地主
assert(s.phase === "playing", "叫 3 分后进入出牌阶段");

const landlordId = s.currentPlayerId;
const lp = s.players[landlordId];
s = g.play(landlordId, [lp.hand[0].id]);
assert(
  s.recentActions.some((a: any) => a.type === "play" && a.playerId === landlordId),
  "出牌动作已写入 recentActions",
);

const nextId = s.currentPlayerId;
s = g.pass(nextId);
assert(
  s.recentActions.some((a: any) => a.type === "pass" && a.playerId === nextId),
  "不出动作已写入 recentActions",
);

console.log(
  "  最近动作：",
  s.recentActions
    .map((a: any) => {
      const who = s.players[a.playerId].name;
      if (a.type === "pass") return `${who}:不出`;
      return `${who}:出 ${a.cards.map((c: any) => c.rank).join("/")}`;
    })
    .join(" | "),
);

// 2) 空 BaseURL 明确报错（不触网）
const r1 = await testLlmConnection({
  enabled: true,
  baseUrl: "",
  model: "x",
  apiKey: "k",
  persona: "",
  temperature: 0.5,
});
assert(!r1.ok && r1.error.includes("接口地址"), "空 BaseURL 返回明确错误");

// 3) 缺 Key 不再被提前拦截（兼容本地 Ollama 等无 Key 场景）
const r2 = await testLlmConnection({
  enabled: true,
  baseUrl: "http://127.0.0.1:9/v1",
  model: "x",
  apiKey: "",
  persona: "",
  temperature: 0.5,
});
assert(!r2.ok, "不可达地址返回失败");
assert(!r2.error.includes("未填写 API Key"), "缺 Key 不提前拦截（兼容本地模型）");
console.log("  不可达检测返回：", r2.error);

console.log(failed === 0 ? "\n全部通过 🎉" : `\n${failed} 项失败`);
if (failed) process.exitCode = 1;

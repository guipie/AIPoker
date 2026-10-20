// 自测：新 prompt 接入 + 抢地主 LLM 决策 + 对局日志持久化
import "./localstorage-shim";
import { createServer } from "node:http";
import { DoudizhuGame } from "../src/engine/doudizhu";
import { llmDdzBid, llmDdzDecision, type LlmConfig } from "../src/engine/llm";
import { doudizuRules, qiangDoudizuRules } from "../src/utils/prompts";
import {
  loadMatchLogs,
  saveMatchLogs,
  MAX_MATCH_LOGS,
  type MatchLog,
} from "../src/utils/matchLog";
import { addMatchLog, matchLogById, recordResult, store } from "../src/store";
import { shouldUseLlm } from "../src/utils/llmCheck";

let failed = 0;
function assert(cond: any, msg: string) {
  if (!cond) {
    console.error("❌ " + msg);
    failed++;
  } else {
    console.log("✓ " + msg);
  }
}

// ============ 1. 引擎：playedCards / actionCount ============
const g = new DoudizhuGame(["甲", "乙"], "你");
let s: any = g.getState();
assert(Array.isArray(s.playedCards) && s.playedCards.length === 0, "开局 playedCards 为空");
assert(s.actionCount === 0, "开局 actionCount 为 0");

s = g.bid(s.currentPlayerId, 3);
const landlordId = s.currentPlayerId;
const lp = s.players[landlordId];
s = g.play(landlordId, [lp.hand[0].id]);
assert(s.playedCards.length === 1, "出 1 张牌后 playedCards 累计 1 张");
assert(s.actionCount === 1, "出牌后 actionCount = 1");

const other = s.currentPlayerId;
s = g.pass(other);
assert(s.playedCards.length === 1, "不出不会往 playedCards 里加牌");
assert(s.actionCount === 2, "不出也算一次动作 → actionCount = 2");

// 无效动作不应改变 actionCount（用于 UI 判断“是否真的生效”）
const wrongTurn = s.currentPlayerId === 0 ? 1 : 0;
const beforeCount = s.actionCount;
s = g.play(wrongTurn, []);
assert(s.actionCount === beforeCount, "非当前玩家的动作被拒绝，actionCount 不变");

// ============ 2. prompt 内容 ============
const bidPrompt = qiangDoudizuRules(
  3,
  [{ id: "甲", action: "snatch", snatchScore: 2 }],
  ["大王", "♠2", "♥A"]
);
assert(bidPrompt.includes("抢地主"), "抢地主 prompt 含阶段说明");
assert(bidPrompt.includes("snatchScore"), "抢地主 prompt 含输出字段 snatchScore");
assert(bidPrompt.includes("大王"), "抢地主 prompt 含我的手牌");
assert(bidPrompt.includes("甲"), "抢地主 prompt 含前置玩家动作");

const playPrompt = doudizuRules(3, "甲", "乙", ["乙", "你"], ["♠3", "♥3"], ["♠4", "♥4"], ["♦5"]);
assert(playPrompt.includes("地主:甲"), "出牌 prompt 标明地主");
assert(playPrompt.includes("你是农民"), "出牌 prompt 标明我的身份");
assert(playPrompt.includes("playedCards"), "出牌 prompt 含全局已出牌（记牌）");
assert(playPrompt.includes("♦5"), "出牌 prompt 带上 playedCards 的实际内容");

// ============ 3. LLM：假服务返回 JSON ============
let lastUser = "";
let lastSystem = "";
const srv = createServer((req, res) => {
  let body = "";
  req.on("data", (c) => (body += c));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    lastUser = (payload.messages ?? []).find((m: any) => m.role === "user")?.content ?? "";
    lastSystem = (payload.messages ?? []).find((m: any) => m.role === "system")?.content ?? "";
    const isBid = lastUser.includes("抢地主");
    const content = isBid
      ? JSON.stringify({ action: "snatch", snatchScore: 2, reason: "有王炸" })
      : JSON.stringify({ play: ["♠3", "♥3"], reason: "对子压制" });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content } }] }));
  });
});
await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
const port = (srv.address() as any).port;
const cfg: LlmConfig = {
  enabled: true,
  baseUrl: `http://127.0.0.1:${port}/v1`,
  model: "test-model",
  apiKey: "sk-test",
  persona: "",
  temperature: 0.6,
};

const bidOut = await llmDdzBid(cfg, {
  num: 3,
  myHand: ["大王", "小王", "♠2"],
  prePersons: [{ id: "甲", action: "pass" }],
  persona: "激进",
});
assert(bidOut?.action === "snatch" && bidOut.snatchScore === 2, "抢地主决策解析正确");
assert(lastUser.includes("抢地主"), "抢地主请求用的是 qiangDoudizuRules 生成的 prompt");
assert(lastSystem.includes("激进"), "人设写进 system 消息");

const playOut = await llmDdzDecision(cfg, {
  num: 3,
  myId: "乙",
  landlordId: "甲",
  farmerIds: ["乙", "你"],
  hand: ["♠3", "♥3", "♦7"],
  lastPlay: ["♠4", "♥4"],
  playedCards: ["♦5"],
  seats: [
    { name: "甲", role: "地主", handCount: 12, relation: "上家" },
    { name: "你", role: "农民", handCount: 3, relation: "下家" },
  ],
  recentActions: ["甲：出 ♠4 ♥4"],
});
assert(playOut?.play?.length === 2, "出牌决策解析正确");
assert(lastUser.includes("地主:甲"), "出牌请求用的是 doudizuRules 生成的 prompt");
assert(lastSystem.includes("各家剩余手牌") && lastSystem.includes("剩 3 张"), "system 里补充了各家剩牌");

// 失败分支：返回空内容 → null，并触发 onError 才能让 UI 标记离线
const deadCfg: LlmConfig = { ...cfg, baseUrl: "http://127.0.0.1:9/v1" };
let errMsg = "";
const dead = await llmDdzDecision(cfg, {
  num: 3,
  myId: "乙",
  landlordId: "甲",
  farmerIds: ["乙", "你"],
  hand: ["♠3"],
  lastPlay: null,
  playedCards: [],
});
assert(dead !== null, "正常服务返回有效决策");
const dead2 = await llmDdzDecision(deadCfg, {
  num: 3,
  myId: "乙",
  landlordId: "甲",
  farmerIds: ["乙"],
  hand: [],
  lastPlay: null,
  playedCards: [],
}, (m) => (errMsg = m));
assert(dead2 === null, "连接失败返回 null（交给规则 AI 兜底）");
assert(!!errMsg, "连接失败触发 onError 回调（用于标记 agent 离线）");
srv.close();

// ============ 4. 对局日志持久化 ============
const mkLog = (i: number): MatchLog => ({
  id: `ddz-${i}`,
  mode: "ddz",
  time: 1700000000000 + i,
  result: i % 2 ? "胜" : "负",
  summary: "测试",
  players: ["你", "甲", "乙"],
  detail: {
    kind: "ddz",
    players: [{ name: "你", role: "地主", hand: ["♠3"] }],
    landlordName: "你",
    bottomCards: ["♠2"],
    myRole: "地主",
    winner: "地主",
    redealCount: 0,
  },
  entries: [{ kind: "bid", playerId: 0, playerName: "你", score: 3, source: "human" }],
});

const before = store.matchLogs.length;
addMatchLog(mkLog(1));
assert(store.matchLogs.length === before + 1, "addMatchLog 后内存里能查到（响应式）");
assert(matchLogById("ddz-1")?.detail.kind === "ddz", "matchLogById 能按 id 取到明细");
assert(matchLogById("不存在") === null, "查不到的 id 返回 null");

const saved = loadMatchLogs();
assert(saved.length >= 1 && saved[0].id === "ddz-1", "日志已写入 localStorage 并可读回");

// 条数保护
saveMatchLogs(Array.from({ length: MAX_MATCH_LOGS + 12 }, (_, i) => mkLog(100 + i)));
assert(loadMatchLogs().length === MAX_MATCH_LOGS, `日志最多保留 ${MAX_MATCH_LOGS} 局`);

// 战绩记录挂 logId
const handsBefore = store.stats.hands.length;
recordResult("ddz", true, "测试", "ddz-1");
assert(store.stats.hands[0].logId === "ddz-1", "战绩记录里带有 logId，可反查明细");
assert(store.stats.hands.length === handsBefore + 1, "战绩记录数量 +1");

// ============ 5. 是否该走大模型（本地模型没 Key 也要能用） ============
store.settings.enabled = false;
store.settings.apiKey = "sk-x";
assert(!shouldUseLlm(undefined), "未启用大模型 → 不走 LLM");
store.settings.enabled = true;
store.settings.apiKey = "";
store.settings.baseUrl = "http://localhost:11434/v1";
assert(shouldUseLlm(undefined), "本地地址（无 Key）也走 LLM —— 修复 Ollama 永远走规则 AI");
store.settings.baseUrl = "https://api.deepseek.com/v1";
assert(!shouldUseLlm(undefined), "远程地址但没 Key → 不走 LLM");
store.settings.apiKey = "sk-x";
assert(shouldUseLlm(undefined), "远程地址 + Key → 走 LLM");

console.log(failed === 0 ? "\n全部通过 🎉" : `\n${failed} 项失败`);
if (failed) process.exitCode = 1;
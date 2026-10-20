// 自测：斗地主出牌记录（recentActions） + 大模型连通性检测（含模型名校验）
import { createServer } from "node:http";
import { DoudizhuGame } from "../src/engine/doudizhu";
import { modelNotInList, testLlmConnection } from "../src/engine/llm";

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
  "出牌动作已写入 recentActions"
);

const nextId = s.currentPlayerId;
s = g.pass(nextId);
assert(
  s.recentActions.some((a: any) => a.type === "pass" && a.playerId === nextId),
  "不出动作已写入 recentActions"
);

// 2) 模型名列表校验（纯函数）
assert(
  modelNotInList(["deepseek-flash", "deepseek-v4-pro"], "qwen2.5:7b") !== null,
  "不支持的模型名会被识别出来"
);
assert(
  modelNotInList(["deepseek-flash", "deepseek-v4-pro"], "deepseek-flash") === null,
  "受支持的模型名通过"
);
assert(modelNotInList([], "anything") === null, "空列表不做判断");
assert(modelNotInList(["deepseek-flash"], "deepseek-flash") === null, "模型名大小写不敏感");

// 3) 本地假服务：/models 返回 200 但只支持 deepseek-*，复现“假在线”bug
const srv = createServer((req, res) => {
  if (req.url?.endsWith("/models")) {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "deepseek-flash" }, { id: "deepseek-v4-pro" }] }));
    return;
  }
  if (req.url?.endsWith("/chat/completions")) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: {
          code: "invalid_request_error",
          message: "The supported API model names are deepseek-flash, deepseek-v4-pro",
        },
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});
await new Promise<void>(r => srv.listen(0, "127.0.0.1", () => r()));
const port = (srv.address() as any).port;
const base = `http://127.0.0.1:${port}/v1`;
const mk = (model: string) => ({
  enabled: true,
  baseUrl: base,
  model,
  apiKey: "sk-test",
  persona: "",
  temperature: 0.5,
});

const bad = await testLlmConnection(mk("qwen2.5:7b"));
assert(
  !bad.ok && bad.error.includes("不在该接口支持的模型列表中"),
  "回归：模型名不支持时不再误判为“在线”"
);
console.log("  报错信息：", bad.error);

const good = await testLlmConnection(mk("deepseek-flash"));
assert(good.ok, "受支持的模型名 → 判为在线");

// 4) 基础校验
const r1 = await testLlmConnection({ ...mk("x"), baseUrl: "" });
assert(!r1.ok && r1.error.includes("接口地址"), "空 BaseURL 返回明确错误");

const r2 = await testLlmConnection({ ...mk("x"), baseUrl: "http://127.0.0.1:9/v1", apiKey: "" });
assert(!r2.ok, "不可达地址返回失败");
assert(!r2.error.includes("未填写 API Key"), "缺 Key 不提前拦截（兼容本地模型）");

srv.close();

console.log(failed === 0 ? "\n全部通过 🎉" : `\n${failed} 项失败`);
if (failed) process.exitCode = 1;

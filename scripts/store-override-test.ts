// 自测：内置 agent 模型配置覆盖（saveAgentOverride / clearAgentOverride / allAgents 合并）
import "./localstorage-shim";
import { allAgents, agentById, saveAgentOverride, clearAgentOverride } from "../src/store";

let failed = 0;
function assert(cond: any, msg: string) {
  if (!cond) {
    console.error("❌ " + msg);
    failed++;
  } else {
    console.log("✓ " + msg);
  }
}

const mou = agentById("mou")!;
assert(mou.model === "gpt-4o-mini", "老谋子默认模型为 gpt-4o-mini（内置）");

saveAgentOverride("mou", {
  baseUrl: "https://api.deepseek.com/v1",
  apiKey: "sk-test",
  model: "deepseek-flash",
});
const m2 = agentById("mou")!;
assert(
  m2.model === "deepseek-flash" &&
    m2.baseUrl === "https://api.deepseek.com/v1" &&
    m2.apiKey === "sk-test",
  "覆盖后 allAgents/agentById 返回合并后的配置"
);
assert(allAgents().length === 8, "覆盖不影响 agent 数量");

// 留空 = 清除该项，其余保留
saveAgentOverride("mou", { apiKey: "" });
const m3 = agentById("mou")!;
assert(
  m3.apiKey === undefined &&
    m3.model === "deepseek-flash" &&
    m3.baseUrl === "https://api.deepseek.com/v1",
  "留空清除单项，其余覆盖保留"
);

// 恢复默认
clearAgentOverride("mou");
const m4 = agentById("mou")!;
assert(
  m4.model === "gpt-4o-mini" && m4.baseUrl === undefined && m4.apiKey === undefined,
  "清除覆盖后恢复内置默认"
);

// 全空 patch 不产生覆盖对象
saveAgentOverride("fox", { baseUrl: "", apiKey: "", model: "" });
assert(
  !((globalThis as any).localStorage.getItem("puke.agentOverrides.v1") ?? "").includes("fox"),
  "全空 patch 不生成覆盖"
);

console.log(failed === 0 ? "\n全部通过 🎉" : `\n${failed} 项失败`);
if (failed) process.exitCode = 1;

// 斗地主「双触发假面板」回归走查：
// 从广场点「开始斗地主」进入牌桌时 onMounted + onActivated 都会触发 maybeStart()，
// 旧代码第二次会随机抽两个内置 agent 再体检一遍 → 弹出「大模型连接失败」假面板，
// 而第一次检查已通过、牌局照常开始。
// 修复后：只做一次体检、不弹面板、牌局正常开始。
// 跑法：node scripts/ddz-double-start-shot.mjs（需要先 npm run dev 起 1420）
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PUP =
  "file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";
const { default: puppeteer } = await import(PUP);

const PORT = 8936;
let modelChecks = 0; // /models 请求数：一轮体检 = 每个 agent 一次
const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if ((req.url ?? "").includes("/models")) {
    modelChecks++;
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
    return;
  }
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" });
  res.write(
    `data: ${JSON.stringify({
      choices: [{ delta: { content: '{"action":"pass","snatchScore":null,"choice":0}' } }],
    })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu"],
  defaultViewport: { width: 1200, height: 880 },
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 160)));

await page.evaluateOnNewDocument((port) => {
  localStorage.clear();
  localStorage.setItem(
    "puke.settings.v2",
    JSON.stringify({
      enabled: true,
      baseUrl: `http://127.0.0.1:${port}/v1`,
      model: "fake-model",
      apiKey: "test-key",
      persona: "",
      temperature: 0.6,
      sound: false,
    }),
  );
  // 只有「铁柱哥 / 闪电」配了能用的模型；其他内置 agent 保持各自的 moonshot/gpt-4o 等
  // （在假服务下必然体检失败）——如果有第二次幽灵体检，就会弹假面板
  const ov = {
    tie: { baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake-model", apiKey: "k" },
    bolt: { baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake-model", apiKey: "k" },
  };
  localStorage.setItem("puke.agentOverrides.v1", JSON.stringify(ov));
  localStorage.setItem("puke.defaultAgentIds.v1", JSON.stringify(["tie", "bolt"]));
}, PORT);

await page.goto("http://localhost:1420/", { waitUntil: "networkidle2", timeout: 60000 });

// 从广场点「开始斗地主」→ 进入牌桌（触发 onMounted + onActivated 双激活）
const clicked = await page.evaluate(() => {
  const b = [...document.querySelectorAll("button")].find((x) =>
    (x.textContent || "").includes("开始斗地主"),
  );
  if (!b) return false;
  b.click();
  return true;
});
await new Promise((r) => setTimeout(r, 5000));

const info = await page.evaluate(() => {
  const t = (document.body.textContent ?? "").replace(/\s+/g, " ");
  return {
    failPanel: t.includes("大模型连接失败") || t.includes("调用大模型失败"),
    hasTie: t.includes("铁柱哥"),
    hasBolt: t.includes("闪电"),
    dealing: t.includes("叫地主") || t.includes("剩 17 张"),
  };
});
console.log("点击开始:", clicked, "| 假面板:", info.failPanel, "| 铁柱哥上桌:", info.hasTie, "| 闪电上桌:", info.hasBolt, "| 牌局开始:", info.dealing);
console.log("/models 体检请求数:", modelChecks, "(应为 2 = 只体检一轮)");
writeFileSync(".ddz-double-start.png", await page.screenshot());

console.log("页面错误:", errors.length ? errors.slice(0, 5) : "无");
await browser.close();
server.close();

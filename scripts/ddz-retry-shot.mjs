// 斗地主「大模型失败 → 重试面板」走查：
// 起一个假 LLM 服务（/models 正常、/chat/completions 返回乱码），
// 让开局体检通过、但每次决策都失败 → 应弹出可重试面板而不是静默回退。
// 依次验证：重试（attempts+1）→ 本局不再提示（牌局继续、不再弹）。
// 跑法：node scripts/ddz-retry-shot.mjs
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PUP =
  "file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";
const { default: puppeteer } = await import(PUP);

const PORT = 8931;
const server = createServer((req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "*");
  if (req.method === "OPTIONS") {
    res.writeHead(204).end();
    return;
  }
  if ((req.url ?? "").includes("/models")) {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ data: [{ id: "fake-model" }] }));
    return;
  }
  // 决策接口：返回 200 但内容不是 JSON → 解析失败（走「无法解析」分支）
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ choices: [{ message: { content: "我觉得应该出牌（不是JSON）" } }] }));
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
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text());
});
page.on("pageerror", (e) => errors.push("pageerror: " + e.message));
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
  // 清掉历史 agent 模型覆盖，并强制所有内置 agent 都走上面的假服务
  const ov = {};
  for (const id of ["qiang", "mou", "gambit", "fox", "tie", "bolt", "pro", "rookie"]) {
    ov[id] = { baseUrl: `http://127.0.0.1:${port}/v1`, model: "fake-model", apiKey: "k" };
  }
  localStorage.setItem("puke.agentOverrides.v1", JSON.stringify(ov));
}, PORT);

await page.goto("http://localhost:1420/?view=doudizhu", {
  waitUntil: "networkidle2",
  timeout: 60000,
});

async function panelInfo() {
  return page.evaluate(() => {
    const t = document.body.textContent ?? "";
    const m = t.match(/「[^」]+」调用大模型失败/);
    const attempts = t.match(/第 (\d+) 次尝试/);
    return {
      panel: Boolean(m),
      title: m?.[0] ?? "",
      attempts: attempts ? Number(attempts[1]) : 0,
      stage: t.includes("抢地主") ? "抢地主" : t.includes("出牌") ? "出牌" : "?",
      gameStarted: t.includes("叫地主") || t.includes("轮到") || t.includes("等待"),
    };
  });
}

// 等重试面板出现
let p1 = null;
for (let i = 0; i < 40; i++) {
  p1 = await panelInfo();
  if (p1.panel) break;
  await new Promise((r) => setTimeout(r, 500));
}
console.log("面板出现:", p1?.panel, "|", p1?.title, "|", p1?.stage, "| attempts:", p1?.attempts);
if (p1?.panel) writeFileSync(".ddz-retry-1.png", await page.screenshot());

// 点「重试」→ 应重新体检再失败，attempts 变 2
async function clickText(text) {
  return page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")].find(
      (x) => (x.textContent || "").includes(t) && !x.disabled,
    );
    if (!b) return false;
    b.click();
    return true;
  }, text);
}
if (p1?.panel) {
  await clickText("重试");
  await new Promise((r) => setTimeout(r, 2500));
  const p2 = await panelInfo();
  console.log("重试后面板:", p2.panel, "| attempts:", p2.attempts);
  if (p2.panel) writeFileSync(".ddz-retry-2.png", await page.screenshot());

  // 点「本局不再提示」→ 面板消失，牌局继续推进
  await clickText("本局不再提示");
  await new Promise((r) => setTimeout(r, 4000));
  const p3 = await panelInfo();
  console.log("静默后面板:", p3.panel, "| 牌局在进行:", p3.gameStarted);
  writeFileSync(".ddz-retry-3.png", await page.screenshot());
}

console.log("控制台错误:", errors.length ? errors.slice(0, 5) : "无");
await browser.close();
server.close();

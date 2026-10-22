// 斗地主「流式思考」走查：
// 假 LLM 服务按 SSE 逐字吐 reasoning_content + 正文，验证
//   1) 座位上出现「思考中 · 已等 Ns」和「›」入口
//   2) 点 › 能打开思考过程弹层，且文本随流增长
//   3) 思考途中重新发牌（中断旧请求）→ 不弹失败面板、新局能继续推进
// 跑法：node scripts/ddz-stream-shot.mjs（需要先 npm run dev 起 1420）
import { writeFileSync } from "node:fs";
import { createServer } from "node:http";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PUP =
  "file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";
const { default: puppeteer } = await import(PUP);

const PORT = 8934;
const REASONING = [
  "我手上有一张大王，",
  "还有对2，",
  "这牌力很强。",
  "上家出了对9，",
  "我可以直接用对2压住，",
  "但先看看队友的牌数。",
];
// 同时带 action / choice 两种字段：抢地主与出牌两个阶段都能被正常解析
const ANSWER =
  '{"action":"pass","snatchScore":null,"choice":0,"reason":"先过一手，保留大王"}';

function sse(res, obj) {
  res.write(`data: ${typeof obj === "string" ? obj : JSON.stringify(obj)}\n\n`);
}

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
  // 决策：SSE 流式返回（思考 + 正文），节奏放慢便于截图中途状态
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  let i = 0;
  const timer = setInterval(() => {
    if (i < REASONING.length) {
      sse(res, { choices: [{ delta: { reasoning_content: REASONING[i] } }] });
    } else if (i === REASONING.length) {
      sse(res, { choices: [{ delta: { content: ANSWER.slice(0, 8) } }] });
    } else {
      sse(res, { choices: [{ delta: { content: ANSWER.slice(8) } }] });
      sse(res, "[DONE]");
      clearInterval(timer);
      res.end();
    }
    i++;
  }, 260);
  req.on("close", () => clearInterval(timer));
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--autoplay-policy=no-user-gesture-required"],
  defaultViewport: { width: 1200, height: 880 },
});
const page = await browser.newPage();
const errors = [];
page.on("console", (m) => {
  if (m.type() === "error") errors.push(m.text().slice(0, 200));
});
page.on("pageerror", (e) => errors.push("pageerror: " + e.message.slice(0, 200)));

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
      sound: true, // 同时验证出牌播报不报错
    }),
  );
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

const text = () => page.evaluate(() => (document.body.textContent ?? "").replace(/\s+/g, " "));
const clickText = (t) =>
  page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")].find(
      (x) => (x.textContent || "").includes(t) && !x.disabled,
    );
    if (!b) return false;
    b.click();
    return true;
  }, t);
const clickArrow = () =>
  page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "›");
    if (!b) return false;
    b.click();
    return true;
  });

async function waitFor(pred, tries = 60, gap = 300) {
  for (let i = 0; i < tries; i++) {
    if (await pred()) return true;
    await new Promise((r) => setTimeout(r, gap));
  }
  return false;
}

// 1) 思考中 + › 入口
const sawThinking = await waitFor(async () => (await text()).includes("思考中"));
const hasWaitSec = /思考中 · 已等 \d+s/.test(await text());
const hasArrow = await waitFor(() => clickArrowPreview(), 20, 200);
async function clickArrowPreview() {
  return page.evaluate(() => {
    const b = [...document.querySelectorAll("button")].find((x) => (x.textContent || "").trim() === "›");
    return Boolean(b);
  });
}
console.log("思考中:", sawThinking, "| 显示已等秒数:", hasWaitSec, "| 有「›」:", hasArrow);
writeFileSync(".ddz-think-1.png", await page.screenshot());

// 2) 点开思考弹层：文本应随流增长
const opened = await clickArrow();
const len1 = await page.evaluate(() => (document.body.textContent ?? "").length);
await new Promise((r) => setTimeout(r, 900));
const len2 = await page.evaluate(() => (document.body.textContent ?? "").length);
const panelText = await text();
console.log(
  "打开弹层:",
  opened,
  "| 弹层标题含「思考过程」:",
  panelText.includes("思考过程"),
  "| 文本增长:",
  len2 - len1,
);
writeFileSync(".ddz-thought-panel.png", await page.screenshot());
await clickText("关闭");

// 3) 思考途中重新发牌：中断旧请求，不该弹失败面板，新局要能继续走
await clickText("重新发牌");
await new Promise((r) => setTimeout(r, 6000));
const after = await text();
const failPanel = after.includes("调用大模型失败");
const stillThinking = after.includes("思考中");
console.log("换局后: 失败面板 =", failPanel, "| 仍在思考 =", stillThinking, "| 有牌桌 =", after.includes("叫地主"));
writeFileSync(".ddz-think-2.png", await page.screenshot());

console.log("控制台错误:", errors.length ? errors.slice(0, 5) : "无");
await browser.close();
server.close();

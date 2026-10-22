// 斗地主 UI 走查：自动替“你”出牌，等到牌桌中央出现 PASS 覆盖层时截图。
// 跑法：node scripts/ddz-pass-shot.mjs [out=.ddz-pass.png]
import { writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PUP =
  "file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";
const { default: puppeteer } = await import(PUP);

const out = process.argv[2] ?? ".ddz-pass.png";
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

await page.goto("http://localhost:1420/?view=doudizhu", {
  waitUntil: "networkidle2",
  timeout: 60000,
});
await new Promise((r) => setTimeout(r, 2500));

// 用小工具按可见文字点按钮
async function clickText(text) {
  return page.evaluate((t) => {
    const btns = [...document.querySelectorAll("button")];
    const b = btns.find((x) => (x.textContent || "").includes(t) && !x.disabled);
    if (!b) return false;
    b.click();
    return true;
  }, text);
}
async function snapshot() {
  return page.evaluate(() => {
    const app = document.querySelector("#app");
    return {
      text: (app?.textContent ?? "").replace(/\s+/g, " ").slice(0, 400),
      pass: Boolean(document.querySelector(".pass-stamp")),
      myTurn: (app?.textContent ?? "").includes("轮到你出牌"),
      bidding: (app?.textContent ?? "").includes("叫地主"),
      over: (app?.textContent ?? "").includes("你赢了") || (app?.textContent ?? "").includes("你输了"),
    };
  });
}

let shot = false;
let steps = 0;
for (let i = 0; i < 90; i++) {
  const s = await snapshot();
  if (s.over) break;
  if (s.pass && !shot) {
    writeFileSync(out, await page.screenshot());
    shot = true;
    console.log("已抓到 PASS 覆盖层，第", steps, "步");
    console.log("画面文本:", s.text.slice(0, 160));
  }
  if (s.bidding && s.myTurn) {
    // 叫地主阶段：不叫，让机器人去抢
    await clickText("不叫");
    steps++;
  } else if (s.myTurn) {
    const ok = await clickText("提示");
    await new Promise((r) => setTimeout(r, 220));
    const after = await snapshot();
    const noBeat = (after.text || "").includes("只能「不出」");
    if (!ok || noBeat) await clickText("不出");
    else await clickText("出牌");
    steps++;
  }
  await new Promise((r) => setTimeout(r, 700));
}

const fin = await snapshot();
if (!shot) writeFileSync(out, await page.screenshot());
console.log("步数:", steps, "| 抓到PASS:", shot, "| 结束态:", fin.over, "| 文本:", fin.text.slice(0, 160));
console.log("控制台错误:", errors.length ? errors.slice(0, 5) : "无");
await browser.close();

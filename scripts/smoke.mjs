// 端到端冒烟：打开牌桌 → 检查应用是否真的挂载（持久化 bootstrap 之后）+ 抓控制台报错 + 截图。
// 跑法：node scripts/smoke.mjs（需 dev server 在 1420）
import { writeFileSync } from "node:fs";

const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const PUP = "file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";
const { default: puppeteer } = await import(PUP);

const url = process.argv[2] ?? "http://127.0.0.1:1420/?view=doudizhu";
const out = process.argv[3] ?? ".smoke.png";

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

await page.goto(url, { waitUntil: "networkidle2", timeout: 60000 });
await new Promise((r) => setTimeout(r, 3500));

const info = await page.evaluate(() => {
  const app = document.querySelector("#app");
  const ls = Object.keys(localStorage).filter((k) => k.startsWith("puke."));
  return {
    mounted: Boolean(app && app.children.length > 0 && app.textContent.trim().length > 0),
    text: (app?.textContent ?? "").slice(0, 120).replace(/\s+/g, " "),
    pukeKeys: ls,
  };
});

writeFileSync(out, await page.screenshot());
await browser.close();

console.log("mounted:", info.mounted);
console.log("首屏文本:", info.text);
console.log("localStorage 键:", info.pukeKeys.join(", ") || "（无）");
console.log("控制台错误:", errors.length ? errors.slice(0, 5) : "无");
if (!info.mounted || errors.length) process.exitCode = 1;

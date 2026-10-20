// 用 puppeteer-core 驱动本机 Chrome 无头截图：验证斗地主出牌阶段布局
// 运行：NODE_PATH=<workspace>/node_modules node scripts/ui-shot.mjs
const { default: puppeteer } = await import("file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js");


const CHROME = "C:/Program Files/Google/Chrome/Application/chrome.exe";
const BASE = "http://localhost:1420";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clickByText(page, text) {
  const ok = await page.evaluate((t) => {
    const btns = [...document.querySelectorAll("button")];
    const b = btns.find((x) => x.textContent.replace(/\s/g, "").includes(t) && !x.disabled);
    if (b) {
      b.click();
      return true;
    }
    return false;
  }, text);
  return ok;
}

async function shot(page, name) {
  await page.screenshot({ path: `D:/chenyanyi/puke/.shot-${name}.png` });
  console.log(`saved .shot-${name}.png`);
}

const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--mute-audio"],
  defaultViewport: { width: 1200, height: 880 },
});
const page = await browser.newPage();
await page.goto(`${BASE}/?view=doudizhu`, { waitUntil: "networkidle0" });
await sleep(1500);

// 叫地主：直接叫 3 分当地主，尽快进入出牌阶段
for (let i = 0; i < 10; i++) {
  const inPlaying = await page.evaluate(
    () => document.body.textContent.includes("轮到你出牌") || document.body.textContent.includes("等待")
  );
  if (inPlaying && !(await page.evaluate(() => document.body.textContent.includes("叫地主（当前最高")))) break;
  if (!(await clickByText(page, "3分"))) {
    if (!(await clickByText(page, "不叫"))) break;
  }
  await sleep(700);
}
await sleep(1500);
await shot(page, "ddz-playing");

// 点两次提示，看循环选中效果
await clickByText(page, "提示");
await sleep(400);
await clickByText(page, "提示");
await sleep(400);
await shot(page, "ddz-hint");

// 出牌 → 等 bots 行动 → 截图（中央牌 + 座位前展示）
await clickByText(page, "出牌");
await sleep(3500);
await shot(page, "ddz-after-play");

await browser.close();
console.log("done");

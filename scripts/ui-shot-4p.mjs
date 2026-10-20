// 验证 3 人局（对面/左/右座位 + 中央牌）布局
import puppeteer from "file:///C:/Users/Administrator/.workbuddy/binaries/node/workspace/node_modules/puppeteer-core/lib/puppeteer/puppeteer-core.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function clickByText(page, text) {
  return page.evaluate((t) => {
    const b = [...document.querySelectorAll("button")].find(
      (x) => x.textContent.replace(/\s/g, "").includes(t) && !x.disabled
    );
    if (b) {
      b.click();
      return true;
    }
    return false;
  }, text);
}

const browser = await puppeteer.launch({
  executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  headless: "new",
  args: ["--no-sandbox", "--disable-gpu", "--hide-scrollbars", "--mute-audio"],
  defaultViewport: { width: 1200, height: 880 },
});
const page = await browser.newPage();
await page.goto("http://localhost:1420/?view=doudizhu", { waitUntil: "networkidle0" });
await sleep(1200);

await clickByText(page, "➕"); // 加到 3 个机器人（4 人局）
await sleep(2500);

// 叫地主直到进入出牌阶段
for (let i = 0; i < 12; i++) {
  const bidding = await page.evaluate(() => document.body.textContent.includes("叫地主（当前最高"));
  if (!bidding) break;
  if (!(await clickByText(page, "3分"))) {
    if (!(await clickByText(page, "不叫"))) break;
  }
  await sleep(600);
}
await sleep(1500);
await page.screenshot({ path: "D:/chenyanyi/puke/.shot-ddz-4p-bidding.png" });
console.log("saved .shot-ddz-4p-bidding.png");

// 领出一手并等 bots 打完一轮
for (let i = 0; i < 6; i++) {
  if (!(await page.evaluate(() => document.body.textContent.includes("轮到你出牌")))) break;
  await clickByText(page, "提示");
  await sleep(300);
  if (await clickByText(page, "出牌")) break;
  await clickByText(page, "不出");
  await sleep(2000);
}
await sleep(4000);
await page.screenshot({ path: "D:/chenyanyi/puke/.shot-ddz-4p-playing.png" });
console.log("saved .shot-ddz-4p-playing.png");

await browser.close();
console.log("done");

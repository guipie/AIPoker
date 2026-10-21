/**
 * 斗地主「候选枚举 + 启发式评分 + 大模型编号选择」自测。
 *
 * 背景：大模型打斗地主弱，根因是让它凭空构造牌面（枚举/比大小/拼写，三步都可能错）。
 * 本套用例验证改造后的三件事：
 *   1. 引擎枚举出的候选永远合法
 *   2. 启发式评分的常识判断正确（能一把走完、残局封堵、不压队友、不拆炸弹）
 *   3. 大模型改成「编号选择题」后，choice 能被正确解析、越界能被识别
 */
import http from "node:http";
import { ddzValue, rankLabel, SUIT_SYMBOL, type Card, type Suit } from "../src/engine/cards";
import { canBeat, detectPattern } from "../src/engine/doudizhu";
import {
  bestPlay,
  candidatesForLlm,
  enumeratePlays,
  toLlmChoices,
  type PlayContext,
} from "../src/engine/ddzCandidates";
import { llmDdzDecision, type LlmConfig } from "../src/engine/llm";

let pass = 0;
let failed = 0;
function ok(cond: boolean, msg: string) {
  if (cond) {
    pass++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.log("  ✗", msg);
  }
}
function section(t: string) {
  console.log("\n" + t);
}

let seq = 0;
/** 构造一张牌；rank 用标准值（2=2，A=14，小王16，大王17） */
function c(suit: Suit, rank: number): Card {
  return { suit, rank, id: `${suit}-${rank}-${seq++}` };
}
const sp = (r: number) => c("spades", r);
const he = (r: number) => c("hearts", r);
const di = (r: number) => c("diamonds", r);
const cl = (r: number) => c("clubs", r);

function ctxOf(hand: Card[], last: Card[] | null, over: Partial<PlayContext> = {}): PlayContext {
  return {
    hand,
    last: last ? detectPattern(last) : null,
    lastPlayerId: last ? 2 : null,
    myId: 1,
    landlordId: 0,
    handCounts: { 0: 10, 1: hand.length, 2: 10 },
    ...over,
  };
}

// ===================== 1. 候选合法性 =====================
section("1. 候选枚举");

{
  const hand = [sp(3), he(3), sp(5), he(5), di(5), sp(9), he(10), cl(11), sp(14)];
  const cands = enumeratePlays(ctxOf(hand, null));
  ok(cands.length > 0, `自由领出枚举出 ${cands.length} 个候选`);
  ok(
    cands.every(k => detectPattern(k.cards) !== null),
    "每个候选都能被识别为合法牌型",
  );
  ok(
    cands.every(k => k.cards.every(card => hand.some(h => h.id === card.id))),
    "每个候选的牌都来自手牌（无凭空捏造）",
  );
  const hasPair = cands.some(k => k.typeName === "对子");
  const hasTriple = cands.some(k => k.typeName === "三张");
  ok(hasPair && hasTriple, "枚举结果同时包含对子与三张（牌型多样）");
}

{
  // 需要压过时，所有候选都必须真的能压过
  const hand = [sp(3), he(3), sp(5), he(5), di(5), sp(9), he(10), cl(11), sp(14), sp(2)];
  const last = [cl(4), di(4)]; // 对 4
  const lastPat = detectPattern(last)!;
  const cands = enumeratePlays(ctxOf(hand, last));
  ok(cands.length > 0, `压「对4」枚举出 ${cands.length} 个候选`);
  ok(
    cands.every(k => canBeat(detectPattern(k.cards)!, lastPat)),
    "每个候选都确实能压过上家",
  );
  ok(
    cands.every(k => k.typeName === "对子" || k.isBomb),
    "压对子只会给出对子或炸弹（牌型正确）",
  );
  ok(ddzValue(sp(2)) === 15, "牌力映射仍正确：2 → 15");
}

// ===================== 2. 启发式评分常识 =====================
section("2. 启发式评分");

{
  // 能一把走完 → 必须选它
  const hand = [sp(7), he(7)];
  const last = [cl(4), di(4)];
  const pick = bestPlay(ctxOf(hand, last));
  ok(pick !== null && pick.length === 2, "能一把走完时选择出牌");
  ok(
    pick !== null && detectPattern(pick)?.mainRank === ddzValue(sp(7)),
    "一把走完出的是对 7（而非保留）",
  );
}

{
  // 非残局不要轻易动用炸弹（手牌留厚，排除"出完就快走完"的加成）
  const hand = [sp(6), he(6), di(6), cl(6), sp(9), he(10), cl(11), sp(12), sp(13), sp(14)];
  const cands = enumeratePlays(ctxOf(hand, null));
  const bomb = cands.find(k => k.typeName === "炸弹");
  const single = cands.find(k => k.typeName === "单张");
  ok(!!bomb && !!single, "候选里同时有炸弹与单张");
  ok(
    !!bomb && !!single && bomb.score < single.score,
    "非残局时炸弹评分低于单张（不轻易用炸弹）",
  );
}

{
  // 残局封堵：对手只剩 1 张时，压牌的评分要显著更高
  const hand = [sp(10), he(10), sp(13)];
  const last = [cl(5)];
  const calm = enumeratePlays(ctxOf(hand, last, { handCounts: { 0: 12, 1: 3, 2: 12 } }));
  const urgent = enumeratePlays(ctxOf(hand, last, { handCounts: { 0: 1, 1: 3, 2: 12 } }));
  const calmTop = calm[0]?.score ?? 0;
  const urgentTop = urgent[0]?.score ?? 0;
  ok(urgentTop > calmTop, `对手剩 1 张时评分更高（${calmTop} → ${urgentTop}）`);
}

{
  // 农民不压队友
  const hand = [sp(10), he(10), sp(13)];
  const last = [cl(5)];
  // 上家是地主（座位 0）
  const vsLandlord = enumeratePlays(ctxOf(hand, last, { lastPlayerId: 0, landlordId: 0 }));
  // 上家是队友（座位 2，非地主）
  const vsMate = enumeratePlays(ctxOf(hand, last, { lastPlayerId: 2, landlordId: 0 }));
  const a = vsLandlord[0]?.score ?? 0;
  const b = vsMate[0]?.score ?? 0;
  ok(b < a, `压队友的评分低于压地主（${a} → ${b}）`);
}

{
  // 别拆炸弹：手上有 4 张 8，不该为了出对子去拆
  const hand = [sp(8), he(8), di(8), cl(8), sp(3), he(3), sp(9)];
  const cands = enumeratePlays(ctxOf(hand, null));
  const bomb8 = cands.find(k => k.typeName === "炸弹");
  const pair8 = cands.find(k => k.typeName === "对子" && k.mainRank === 8);
  ok(!!bomb8 && !!pair8, "同时存在「四张8炸弹」与「对子8」两个候选");
  ok(
    !!bomb8 && !!pair8 && pair8.score < bomb8.score,
    "拆炸弹出的对子 8 评分低于保留成炸弹（别拆炸弹）",
  );
}

{
  // 别单出王
  const hand = [c("joker", 17), c("joker", 16), sp(3), he(3), sp(9)];
  const cands = enumeratePlays(ctxOf(hand, null));
  const rocket = cands.find(k => k.typeName === "王炸");
  const singleJoker = cands.find(k => k.typeName === "单张" && k.cards.some(x => x.suit === "joker"));
  ok(!!rocket, "枚举出王炸");
  ok(
    !!rocket && !!singleJoker && singleJoker.score < rocket.score,
    "单出王（拆王炸）评分低于王炸本身",
  );
}

{
  // 压不过时必须返回 null，绝不返回空数组（否则回合卡死）
  const hand = [sp(3), he(4), di(6)];
  const last = [cl(14), sp(14), he(14), di(14)]; // 炸弹 A
  const pick = bestPlay(ctxOf(hand, last));
  ok(pick === null, "压不过时 bestPlay 返回 null（走不出死循环）");
}

{
  // 自由领出永远不会返回空
  for (const hand of [
    [sp(3)],
    [sp(2)],
    [c("joker", 17)],
    [sp(3), he(3), di(3), cl(3)],
    [sp(5), he(6), di(7), cl(8), sp(9)],
  ]) {
    const pick = bestPlay(ctxOf(hand, null));
    ok(!!pick && pick.length > 0, `手牌 ${hand.length} 张自由领出必出牌`);
  }
}

// ===================== 3. 给大模型的候选 =====================
section("3. 大模型候选列表");

{
  const hand = [
    sp(3), he(3), sp(5), he(5), di(5), sp(7), he(7), di(7), cl(7),
    sp(9), he(10), cl(11), sp(12), sp(13), sp(14), sp(2),
  ];
  const ctx = ctxOf(hand, null);
  const label = (x: Card) => (x.suit === "joker" ? "王" : SUIT_SYMBOL[x.suit] + rankLabel(x));
  const choices = toLlmChoices(ctx, label, 14);
  ok(choices.length <= 14 && choices.length > 0, `裁剪后共 ${choices.length} 个候选（≤14）`);
  ok(
    choices.every((k, i) => k.index === i + 1),
    "编号 1..N 连续（0 留给「不出」）",
  );
  const types = new Set(choices.map(k => k.typeName));
  ok(types.size >= 3, `候选覆盖 ${types.size} 种牌型（避免全是单张）`);
  ok(
    choices.every(k => k.cards.length > 0 && k.handLeft === hand.length - k.cards.length),
    "每个候选都带正确的剩余张数",
  );

  const limited = candidatesForLlm(ctx, 5);
  ok(limited.length <= 5, "limit 生效");
}

// ===================== 4. 大模型编号解析 =====================
section("4. 编号选择题解析（假服务）");

function serveOnce(body: string): Promise<{ port: number; close: () => void }> {
  return new Promise(resolve => {
    const server = http.createServer((req, res) => {
      let data = "";
      req.on("data", d => (data += d));
      req.on("end", () => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            id: "x",
            object: "chat.completion",
            created: 0,
            model: "m",
            choices: [{ index: 0, message: { role: "assistant", content: body }, finish_reason: "stop" }],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
          }),
        );
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as { port: number };
      resolve({ port: addr.port, close: () => server.close() });
    });
  });
}

const baseInput = {
  num: 3 as const,
  myId: "阿强",
  landlordId: "地主哥",
  farmerIds: ["阿强", "闪电"],
  hand: ["♠3", "♥3"],
  lastPlay: ["♣4"],
  playedCards: [],
  candidates: [
    { index: 1, typeName: "单张", cards: ["♠3"], handLeft: 1, isBomb: false },
    { index: 2, typeName: "单张", cards: ["♥3"], handLeft: 1, isBomb: false },
  ],
};

async function ask(body: string) {
  const s = await serveOnce(body);
  const cfg: LlmConfig = {
    baseUrl: `http://127.0.0.1:${s.port}/v1`,
    apiKey: "k",
    model: "fake",
    temperature: 0.2,
  };
  try {
    return await llmDdzDecision(cfg, baseInput);
  } finally {
    s.close();
  }
}

{
  const out = await ask('{"choice":2,"reason":"出最小的单张"}');
  ok(out?.choice === 2, "解析 choice=2");
  ok(out?.reason === "出最小的单张", "解析 reason");
}
{
  const out = await ask('{"choice":0,"reason":"不压队友"}');
  ok(out?.choice === 0, "解析 choice=0（不出）");
}
{
  const out = await ask('{"play":["♠3"],"reason":"兼容旧格式"}');
  ok(out?.choice === undefined, "旧格式 play 仍被支持");
  ok(Array.isArray(out?.play) && out?.play?.[0] === "♠3", "旧格式牌面正确返回");
}
{
  const out = await ask('{"choice":99,"reason":"越界"}');
  ok(out?.choice === 99, "越界编号原样返回（由调用方判为失败）");
}
{
  const out = await ask("这不是 JSON");
  ok(out === null, "非 JSON 返回 null（走规则兜底）");
}

console.log(`\n${failed === 0 ? "全部通过" : failed + " 项失败"}（共 ${pass + failed} 项）`);
if (failed) process.exitCode = 1;

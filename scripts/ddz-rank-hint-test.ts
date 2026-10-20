// 自测：斗地主牌力（2 仅次于王）+ 提示枚举 findAllBeats
// 运行：npx esbuild scripts/ddz-rank-hint-test.ts --bundle --platform=node --format=esm --outfile=.tmp.mjs && node .tmp.mjs

import { Card, ddzValue, sortDdzCards } from "../src/engine/cards";
import {
  canBeat,
  detectPattern,
  findAllBeats,
  findBeats,
} from "../src/engine/doudizhu";

let failed = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (!cond) {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  } else {
    console.log(`  ✓ ${name}`);
  }
}

function card(rank: number, suit: Card["suit"] = "spades"): Card {
  return { suit, rank, id: `${suit}-${rank}` };
}
const joker = (big: boolean): Card => ({
  suit: "joker",
  rank: big ? 17 : 16,
  id: big ? "joker-big" : "joker-small",
});

console.log("\n[1] 牌力映射 ddzValue：3<…<A<2<小王<大王");
ok(ddzValue(card(3)) < ddzValue(card(14)), "3 < A");
ok(ddzValue(card(14)) < ddzValue(card(2)), "A < 2（核心：2 不能是最小的牌）");
ok(ddzValue(card(2)) < ddzValue(joker(false)), "2 < 小王");
ok(ddzValue(joker(false)) < ddzValue(joker(true)), "小王 < 大王");

console.log("\n[2] 单张 2 能压过 A / K / 3");
const single2 = detectPattern([card(2)])!;
ok(single2.type === "single", "2 被识别为单张");
ok(ddzValue(card(2)) === 15, "2 的牌力值为 15");
for (const r of [3, 10, 13, 14]) {
  ok(canBeat(single2, detectPattern([card(r)])), `单张 2 压过单张 ${r}`);
}
ok(!canBeat(detectPattern([card(3)])!, single2), "单张 3 压不过单张 2");
ok(canBeat(detectPattern([joker(true)])!, single2), "大王压过 2");
ok(canBeat(detectPattern([joker(false)])!, single2), "小王压过 2");

console.log("\n[3] 对子 / 三张的 2 同样生效");
const pair2 = detectPattern([card(2, "spades"), card(2, "hearts")])!;
ok(pair2.type === "pair", "双 2 是对子");
ok(canBeat(pair2, detectPattern([card(14, "spades"), card(14, "hearts")])!), "对 2 压过对 A");
const triple2 = detectPattern([card(2, "spades"), card(2, "hearts"), card(2, "clubs")])!;
ok(triple2.type === "triple", "三 2 是三张");
ok(canBeat(triple2, detectPattern([card(14, "spades"), card(14, "hearts"), card(14, "clubs")])!), "三 2 压过三 A");

console.log("\n[4] 顺子不含 2（2 牌力为 15 应被排除）");
ok(detectPattern([card(3), card(4), card(5), card(6), card(7)]) !== null, "3-7 是顺子");
ok(detectPattern([card(11), card(12), card(13), card(14), card(2)]) === null, "10-A-2 不是顺子");
ok(detectPattern([card(10), card(11), card(12), card(13), card(14)]) !== null, "10-A 是顺子");

console.log("\n[5] 手牌排序：2 排在 A 之后、王之前");
const sorted = sortDdzCards([card(3), joker(true), card(2), card(14), card(13)]);
const labels = sorted.map(c => (c.suit === "joker" ? (c.rank === 17 ? "大王" : "小王") : c.rank));
ok(JSON.stringify(labels) === JSON.stringify(["大王", 2, 14, 13, 3]), `排序=${labels.join(",")}`);

console.log("\n[6] findAllBeats：能压过时给出全部候选");
const hand: Card[] = [
  card(3, "spades"), card(3, "hearts"),
  card(5, "spades"), card(5, "hearts"), card(5, "clubs"),
  card(9, "spades"),
  card(14, "spades"),
  card(2, "spades"), card(2, "hearts"),
];
const lastSingleA = detectPattern([card(13, "spades")])!; // 上家出单张 K
const opts1 = findAllBeats(hand, lastSingleA);
ok(opts1.length > 0, `有候选（${opts1.length} 个）`);
ok(
  opts1.every(o => canBeat(detectPattern(o)!, lastSingleA)),
  "所有候选都能压过上家"
);
const hasTwo = opts1.some(o => o.length === 1 && ddzValue(o[0]) === 15);
ok(hasTwo, "候选里包含单张 2");
// 排序：非炸弹在前，炸弹/王炸最后
const kinds = opts1.map(o => detectPattern(o)!.type);
const firstBomb = kinds.findIndex(k => k === "bomb" || k === "rocket");
ok(firstBomb === -1 || firstBomb === kinds.length - 1, `炸弹排最后（${kinds.join(",")}）`);
// 第一个候选应该是能压过的最小的牌
ok(ddzValue(opts1[0][0]) === 14, `首选是最小可压牌（A），实际=${ddzValue(opts1[0][0])}`);

console.log("\n[7] findAllBeats：压不过时返回空（用于提示“只能不出”）");
const noWay = findAllBeats([card(3, "spades"), card(4, "hearts")], detectPattern([card(2, "spades")])!);
ok(noWay.length === 0, "3/4 压不过单张 2 → 空");
ok(findBeats([card(3, "spades")], detectPattern([card(2, "spades")])!) === null, "findBeats 同样为 null");

console.log("\n[8] findAllBeats：上家是炸弹时只给更大的炸弹/王炸");
const vsBomb = findAllBeats(
  [card(3, "spades"), card(3, "hearts"), card(3, "clubs"), card(3, "diamonds"),
   card(4, "spades"), card(4, "hearts"), card(4, "clubs"), card(4, "diamonds")],
  detectPattern([card(3, "spades"), card(3, "hearts"), card(3, "clubs"), card(3, "diamonds")])!
);
ok(vsBomb.length === 1 && vsBomb[0].every(c => c.rank === 4), `只有 4 的炸弹（${vsBomb.length}）`);

console.log("\n[9] findAllBeats：自由领出（last=null）枚举所有牌型且不重复");
const free = findAllBeats(hand, null);
ok(free.length > 5, `自由领出候选 ${free.length} 个`);
const keys = new Set(free.map(o => o.map(c => c.id).sort().join("|")));
ok(keys.size === free.length, "候选无重复");
ok(free.every(o => detectPattern(o) !== null), "候选都是合法牌型");

console.log("\n[10] 提示循环：连续点击能遍历全部候选");
let idx = -1;
const seenSeq: string[] = [];
for (let i = 0; i < opts1.length; i++) {
  idx = (idx + 1) % opts1.length;
  seenSeq.push(opts1[idx].map(c => c.id).sort().join("|"));
}
ok(new Set(seenSeq).size === opts1.length, "一轮循环遍历到每个候选各一次");

console.log(failed === 0 ? "\n全部通过 🎉" : `\n${failed} 项失败`);
if (failed) process.exitCode = 1;

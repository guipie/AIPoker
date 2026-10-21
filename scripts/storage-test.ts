// 持久化层自测：驱动（内存 / localStorage）、Repository 校验与归一、
// 旧数据兼容（stats.ddz → doudizhu）、JSON 对局日志的增删查与容量保护。
// 跑法：npx esbuild scripts/storage-test.ts --bundle --platform=node --format=esm --outfile=.tmp-st.mjs && node .tmp-st.mjs
import "./localstorage-shim";
import { MemoryPersistence } from "../src/storage/MemoryPersistence";
import { LocalStoragePersistence } from "../src/storage/LocalStoragePersistence";
import {
  AgentsRepository,
  JsonRepository,
  SettingsRepository,
  StatsRepository,
} from "../src/storage/Repository";
import { JsonMatchLogStore, createMatchLogStore } from "../src/storage/MatchLogStore";
import type { MatchLog } from "../src/types/match";

let pass = 0;
let failed = 0;
function ok(cond: boolean, name: string, extra = "") {
  if (cond) {
    pass++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.log(`  ✗ ${name} ${extra}`);
  }
}
const eq = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  // ===== 1. MemoryPersistence：同步读 + 异步写 =====
  console.log("\n[1] MemoryPersistence（写穿透缓存）");
  {
    const p = new MemoryPersistence();
    await p.open();
    ok(p.kind === "memory", "kind = memory");
    ok(p.get("nope", { x: 1 }).x === 1, "未命中的键返回 fallback");

    p.set("a", { v: 42 });
    // 关键语义：set 之后**立即可同步读到**，不必 await
    ok(p.get<{ v: number }>("a", { v: 0 }).v === 42, "set 后同步可读（写穿透）");
    ok(p.has("a"), "has() 命中");

    await p.flush();
    const all = await p.readAll();
    ok(all.a === JSON.stringify({ v: 42 }), "flush 后已落盘");
    ok(p.status().pending === 0, "flush 后队列清空");

    p.remove("a");
    ok(!p.has("a"), "remove 后镜像同步删除");
    await p.flush();
    ok(!(("a" in (await p.readAll())) as boolean), "remove 后介质也删除");
  }

  // ===== 2. 落盘失败不炸 UI，且会留在队列里重试 =====
  console.log("\n[2] 落盘失败降级");
  {
    class BrokenPersistence extends MemoryPersistence {
      fail = true;
      protected override async doWrite(): Promise<void> {
        if (this.fail) throw new Error("磁盘只读");
      }
    }
    const p = new BrokenPersistence();
    await p.open();
    p.set("k", 1);
    await p.flush();
    ok(p.status().lastError === "磁盘只读", "记录了失败原因");
    ok(p.get<number>("k", 0) === 1, "镜像仍有值（UI 不受影响）");
    ok(p.status().pending === 1, "失败项留在队列等待重试");
    p.fail = false;
    await p.flush();
    ok(p.status().lastError === null && p.status().pending === 0, "恢复后重试成功、错误清除");
  }

  // ===== 3. LocalStoragePersistence：前缀隔离 =====
  console.log("\n[3] LocalStoragePersistence");
  {
    localStorage.setItem("other.app.key", "should-be-ignored");
    const p = new LocalStoragePersistence();
    await p.open();
    p.set("puke.demo", { a: 1 });
    await p.flush();
    ok(localStorage.getItem("puke.demo") !== null, "写入时带 puke. 前缀");
    const all = await p.readAll();
    ok(!("other.app.key" in all), "读取时忽略非本应用的键");
    // 已带前缀的键不会重复加前缀
    p.set("puke.demo2", 2);
    await p.flush();
    ok(localStorage.getItem("puke.demo2") !== null, "已带前缀不重复拼接");
    await p.drop(["puke.demo", "puke.demo2"]);
    ok(localStorage.getItem("puke.demo") === null, "drop 生效");
  }

  // ===== 4. SettingsRepository：校验 + 归一 =====
  console.log("\n[4] SettingsRepository");
  {
    const p = new MemoryPersistence();
    await p.open();
    const repo = new SettingsRepository(p);
    const def = repo.load();
    ok(def.model === "deepseek-flash" && def.temperature === 0.6 && def.sound === true, "空库返回默认值");

    repo.save({ ...def, temperature: 99, enabled: true, apiKey: "sk-1" });
    const back = repo.load();
    ok(back.temperature === 2, "越界温度被 clamp 到 2", String(back.temperature));
    ok(back.enabled === true, "布尔字段保留");

    // 损坏数据（字符串 / 非法 JSON）不能炸，回落默认
    p.set("puke.settings.v2", "not-an-object");
    ok(repo.load().model === "deepseek-flash", "非法数据回落默认值");

    // 部分字段缺失时用默认补齐
    p.set("puke.settings.v2", { model: "qwen2.5:7b" });
    const partial = repo.load();
    ok(partial.model === "qwen2.5:7b" && partial.baseUrl.startsWith("https://"), "缺失字段用默认补齐");
  }

  // ===== 5. StatsRepository：兼容旧结构 ddz =====
  console.log("\n[5] StatsRepository（旧数据兼容）");
  {
    const p = new MemoryPersistence();
    await p.open();
    const repo = new StatsRepository(p);

    // 老版本存的是 stats.ddz，新版本是 doudizhu —— 老用户的数据不能丢
    p.set("puke.stats.v2", { ddz: { win: 7, lose: 3 }, holdem: { win: 1, lose: 1 }, hands: [] });
    const migrated = repo.load();
    ok(migrated.doudizhu.win === 7 && migrated.doudizhu.lose === 3, "旧 ddz 战绩被迁移到 doudizhu");

    repo.record("doudizhu", true, "log-1");
    const after = repo.load();
    ok(after.doudizhu.win === 8, "record 胜利 +1");
    ok(after.hands[0].logId === "log-1" && after.hands[0].mode === "doudizhu", "战绩流水带 logId 与模式");

    repo.record("holdem", false);
    ok(repo.load().holdem.lose === 2, "record 失败 +1");

    // 条数上限保护
    for (let i = 0; i < 80; i++) repo.record("holdem", i % 2 === 0);
    ok(repo.load().hands.length === StatsRepository.MAX_HANDS, `战绩流水最多 ${StatsRepository.MAX_HANDS} 条`);
  }

  // ===== 6. AgentsRepository：三个独立键 =====
  console.log("\n[6] AgentsRepository");
  {
    const p = new MemoryPersistence();
    await p.open();
    const repo = new AgentsRepository(p);
    ok(eq(repo.custom.load(), []), "自定义 agent 默认空数组");
    ok(eq(repo.overrides.load(), {}), "模型覆盖默认空对象");

    repo.custom.save([
      { id: "x", name: "X", emoji: "🤖", color: "from-a", color2: "to-b", tagline: "", aggression: 0.5, tightness: 0.5, blurb: "" },
    ]);
    repo.overrides.save({ qiang: { model: "gpt-4o" } });
    repo.defaultIds.save(["qiang", "fox"]);
    ok(repo.custom.load().length === 1, "自定义 agent 已保存");
    ok(repo.overrides.load().qiang.model === "gpt-4o", "模型覆盖已保存");
    ok(repo.defaultIds.load().length === 2, "默认 agent 已保存");

    // 非法结构（不是数组）→ 回落默认
    p.set("puke.customAgents.v1", { not: "array" });
    ok(eq(repo.custom.load(), []), "非数组数据回落空数组");
  }

  // ===== 7. JsonRepository：通用实现 =====
  console.log("\n[7] JsonRepository");
  {
    const p = new MemoryPersistence();
    await p.open();
    const repo = new JsonRepository<number>(p, "puke.counter.v1", () => 0, (raw) =>
      typeof raw === "number" ? raw : null,
    );
    ok(repo.load() === 0, "默认值生效");
    repo.update((n) => n + 1);
    repo.update((n) => n + 1);
    ok(repo.load() === 2, "update 读改写正确");
    repo.reset();
    ok(repo.load() === 0, "reset 回到默认值");
  }

  // ===== 8. MatchLogStore（JSON 实现）=====
  console.log("\n[8] JsonMatchLogStore");
  {
    const p = new MemoryPersistence();
    await p.open();
    const store = new JsonMatchLogStore(p);

    const mk = (id: string, mode: "ddz" | "holdem", text: string): MatchLog => ({
      id,
      mode,
      time: Date.now(),
      result: "胜",
      summary: text,
      players: ["你", "狂刀阿强"],
      detail: { kind: "ddz", players: [], landlordName: "你", bottomCards: [], myRole: "地主", winner: "地主", redealCount: 0 },
      entries: [{ kind: "play", playerName: "狂刀阿强", cards: ["♠3"], reason: "试探" }],
    });

    await store.save(mk("a", "ddz", "第一局"));
    await store.save(mk("b", "holdem", "第二局"));
    ok((await store.count()) === 2, "写入两局");
    ok((await store.load())[0].id === "b", "最新的在最前");
    ok((await store.query({ mode: "ddz" })).length === 1, "按模式查询");
    ok((await store.query({ keyword: "试探" })).length === 2, "按关键字命中决策理由");
    ok((await store.query({ keyword: "不存在" })).length === 0, "关键字无命中返回空");

    // 同 id 覆盖写入（幂等）
    await store.save(mk("a", "ddz", "第一局-改"));
    ok((await store.count()) === 2, "同 id 覆盖不新增");
    ok((await store.load()).find((l) => l.id === "a")?.summary === "第一局-改", "同 id 内容被更新");

    await store.remove("a");
    ok((await store.count()) === 1, "删除生效");
    await store.clear();
    ok((await store.count()) === 0, "清空生效");

    // 容量保护
    for (let i = 0; i < 40; i++) await store.save(mk(`c${i}`, "ddz", `第 ${i} 局`));
    ok((await store.count()) === store.capacity, `超出容量只保留 ${store.capacity} 局`);
  }

  // ===== 9. 工厂多态分派 =====
  console.log("\n[9] 工厂多态分派");
  {
    const mem = new MemoryPersistence();
    await mem.open();
    const s1 = createMatchLogStore(mem);
    ok(s1 instanceof JsonMatchLogStore, "非 SQLite 驱动 → JSON 实现");

    const local = new LocalStoragePersistence();
    await local.open();
    ok(createMatchLogStore(local) instanceof JsonMatchLogStore, "localStorage 驱动 → JSON 实现");
  }

  console.log(`\n${failed === 0 ? "全部通过 🎉" : `${failed} 项失败`}（通过 ${pass}）`);
  if (failed) process.exitCode = 1;
}

void main();

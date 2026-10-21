/**
 * 一次性迁移：把浏览器时代存在 localStorage 里的数据搬进 SQLite。
 *
 * 场景：用户先用 `npm run dev` 在浏览器里玩了几局，之后打包成桌面端打开——
 * 这时 SQLite 是空的，而战绩 / 对局日志 / 设置都在 localStorage 里。
 * 迁移完成后打标记，之后不再重复执行。
 */
import { LocalStoragePersistence } from "./LocalStoragePersistence";
import { SqlitePersistence } from "./SqlitePersistence";

const MIGRATION_FLAG = "puke.__migratedFromLocalStorage.v1";

/** @returns 迁移的键数量（0 表示无需迁移） */
export async function migrateFromLocalStorage(sqlite: SqlitePersistence): Promise<number> {
  try {
    if (sqlite.has(MIGRATION_FLAG)) return 0;

    const local = new LocalStoragePersistence();
    const snapshot = await local.readAll();
    const keys = Object.keys(snapshot).filter((k) => k.startsWith("puke."));
    if (keys.length === 0) {
      // 没有任何历史数据：也打标记，避免每次启动都读一遍 localStorage
      sqlite.set(MIGRATION_FLAG, { at: Date.now(), count: 0 });
      await sqlite.flush();
      return 0;
    }

    const batch: Record<string, string> = {};
    for (const k of keys) batch[k] = snapshot[k];
    await sqlite.writeThrough(batch);
    sqlite.set(MIGRATION_FLAG, { at: Date.now(), count: keys.length });
    await sqlite.flush();
    return keys.length;
  } catch {
    return 0; // 迁移失败不影响正常启动
  }
}

/** 判断某次启动是否执行过迁移（调试用） */
export function hasMigrated(sqlite: SqlitePersistence): boolean {
  return sqlite.has(MIGRATION_FLAG);
}

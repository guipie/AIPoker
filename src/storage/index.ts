/**
 * 持久化工厂：按运行环境挑选驱动（多态分派），并完成一次性的历史数据迁移。
 *
 * 优先级：SQLite（Tauri 桌面端） → localStorage（浏览器 / 降级） → 内存（最后兜底）。
 * 上层永远只拿到抽象的 `Persistence`，不关心具体是哪个实现。
 */
import type { Persistence } from "./BasePersistence";
import { LocalStoragePersistence, LS_PREFIX } from "./LocalStoragePersistence";
import { MemoryPersistence } from "./MemoryPersistence";
import { SqlitePersistence } from "./SqlitePersistence";
import { migrateFromLocalStorage } from "./migrate";

/** 是否运行在 Tauri 桌面外壳里（v2 会注入内部对象） */
export function isTauriShell(): boolean {
  if (typeof window === "undefined") return false;
  const w = window as unknown as { __TAURI_INTERNALS__?: unknown; isTauri?: boolean };
  return Boolean(w.__TAURI_INTERNALS__ || w.isTauri);
}

let current: Persistence | null = null;
let initPromise: Promise<Persistence> | null = null;

/** 当前生效的驱动（未初始化时返回 null） */
export function persistence(): Persistence | null {
  return current;
}

/**
 * 初始化持久化。整个应用启动时调用一次（main.ts）。
 * 已经初始化过则直接返回同一个实例（幂等）。
 */
export function initPersistence(): Promise<Persistence> {
  if (current) return Promise.resolve(current);
  if (initPromise) return initPromise;

  initPromise = (async (): Promise<Persistence> => {
    // 1) 桌面端优先 SQLite
    if (isTauriShell()) {
      try {
        const sqlite = new SqlitePersistence();
        await sqlite.open();
        await migrateFromLocalStorage(sqlite);
        current = sqlite;
        return sqlite;
      } catch {
        /* SQLite 不可用 → 继续降级 */
      }
    }

    // 2) 浏览器：localStorage
    try {
      const local = new LocalStoragePersistence();
      await local.open();
      current = local;
      return local;
    } catch {
      /* 隐私模式等 → 继续降级 */
    }

    // 3) 兜底：内存（不落盘，但保证 App 能用）
    const mem = new MemoryPersistence();
    await mem.open();
    current = mem;
    return mem;
  })();

  return initPromise;
}

/** 取当前驱动；未初始化则退化为内存驱动，保证调用方不会拿到 null */
export function requirePersistence(): Persistence {
  return current ?? new MemoryPersistence();
}

/** 当前驱动状态（设置页展示「数据存在哪」） */
export function persistenceStatus() {
  return current?.status() ?? null;
}

export { LS_PREFIX };
export type { Persistence };

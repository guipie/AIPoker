/**
 * SQLite 驱动：Tauri 环境的主力持久化实现（@tauri-apps/plugin-sql）。
 *
 * 表设计刻意保持「键值 + 结构化日志」两层：
 * - `kv`：设置 / 战绩 / agent 配置这类「整块读写」的小数据；
 * - `match_logs` + `match_entries`：对局明细，结构化存储，可直接用 SQL 查询统计。
 *
 * 继承 `BasePersistence` 后，本类只需关心 SQL，缓存与写队列由基类统一处理。
 */
import { BasePersistence, type DriverKind } from "./BasePersistence";

/** plugin-sql 的 Database 句柄类型（动态导入，避免浏览器端加载） */
type SqlDatabase = {
  execute(query: string, bindValues?: unknown[]): Promise<{ rowsAffected: number }>;
  select<T>(query: string, bindValues?: unknown[]): Promise<T>;
  close(): Promise<boolean>;
};

interface KvRow {
  key: string;
  value: string;
}

export const SQLITE_DB_PATH = "sqlite:puke.db";

export class SqlitePersistence extends BasePersistence {
  readonly kind: DriverKind = "sqlite";
  readonly label = "SQLite（本地数据库）";

  private db: SqlDatabase | null = null;

  constructor(private readonly path: string = SQLITE_DB_PATH) {
    super();
  }

  /** 当前连接（供结构化存储复用同一连接与事务） */
  get connection(): SqlDatabase | null {
    return this.db;
  }

  protected async doOpen(): Promise<void> {
    const mod = await import("@tauri-apps/plugin-sql");
    const Database = mod.default;
    this.db = (await Database.load(this.path)) as unknown as SqlDatabase;
    await this.exec(`CREATE TABLE IF NOT EXISTS kv (
      key TEXT PRIMARY KEY NOT NULL,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )`);
    await this.exec(
      `CREATE INDEX IF NOT EXISTS idx_kv_updated_at ON kv(updated_at)`,
    );
  }

  protected async doReadAll(): Promise<Record<string, string>> {
    const rows = await this.select<KvRow[]>("SELECT key, value FROM kv");
    const out: Record<string, string> = {};
    for (const r of rows) out[r.key] = r.value;
    return out;
  }

  protected async doWrite(entries: Record<string, string>): Promise<void> {
    if (!this.db) throw new Error("SQLite 连接未就绪");
    const now = Date.now();
    await this.exec("BEGIN");
    try {
      for (const [key, value] of Object.entries(entries)) {
        await this.exec(
          "INSERT INTO kv (key, value, updated_at) VALUES ($1, $2, $3) " +
            "ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
          [key, value, now],
        );
      }
      await this.exec("COMMIT");
    } catch (e) {
      await this.exec("ROLLBACK").catch(() => undefined);
      throw e;
    }
  }

  protected async doRemove(keys: string[]): Promise<void> {
    for (const key of keys) await this.exec("DELETE FROM kv WHERE key = $1", [key]);
  }

  protected async doClose(): Promise<void> {
    await this.db?.close();
    this.db = null;
  }

  // ===================== 供结构化存储使用的底层原语 =====================
  async exec(sql: string, params: unknown[] = []): Promise<void> {
    if (!this.db) throw new Error("SQLite 连接未就绪");
    await this.db.execute(sql, params);
  }

  async select<T>(sql: string, params: unknown[] = []): Promise<T> {
    if (!this.db) throw new Error("SQLite 连接未就绪");
    return await this.db.select<T>(sql, params);
  }
}

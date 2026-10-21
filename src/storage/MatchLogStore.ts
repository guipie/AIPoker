/**
 * 对局明细的持久化契约。
 *
 * 为什么它要单独做成一套继承体系，而不是复用 kv 表？
 * 因为「对局日志」是要被查询的：桌面端落 SQLite 后可以直接 SQL 统计
 * （某 agent 的战绩、某局里谁炸过、按关键字搜牌面与决策理由）；
 * 浏览器回退时只能整块 JSON + 内存过滤。
 * 两种介质的查询能力不同，于是抽象出 `MatchLogStore`，由工厂按驱动种类多态分派。
 *
 * 职责边界：本层只管「介质读写」，内存镜像由 store 持有（避免两份数据不一致）。
 */
import type { Persistence } from "./BasePersistence";
import { SqlitePersistence } from "./SqlitePersistence";
import { MATCH_LOG_LIMIT_JSON, type MatchLog, type MatchLogEntry } from "../types/match";

/** 查询条件（两种实现都支持，只是底层手段不同） */
export interface MatchLogQuery {
  mode?: "ddz" | "holdem";
  /** 关键字：匹配玩家名 / 出牌 / 决策理由 */
  keyword?: string;
  limit?: number;
  offset?: number;
}

export abstract class MatchLogStore {
  /** 介质能容纳的局数（子类按能力声明：SQLite 远大于 JSON） */
  abstract readonly capacity: number;

  /** 读取最近的若干局（按时间倒序） */
  abstract load(limit?: number): Promise<MatchLog[]>;

  /** 写入（或整局替换）一条对局 */
  abstract save(log: MatchLog): Promise<void>;

  abstract remove(id: string): Promise<void>;

  abstract clear(): Promise<void>;

  /** 条件查询：SQLite 走 SQL，JSON 走内存过滤 */
  abstract query(q: MatchLogQuery): Promise<MatchLog[]>;

  abstract count(q?: Pick<MatchLogQuery, "mode" | "keyword">): Promise<number>;
}

/** SQLite 列名常量，避免字符串散落 */
const LOG_COLUMNS = "id, mode, time, result, summary, players, detail";

// ===================== SQLite 实现：结构化两张表 =====================
export class SqliteMatchLogStore extends MatchLogStore {
  readonly capacity = 500;

  constructor(private readonly sqlite: SqlitePersistence) {
    super();
  }

  private get db(): SqlitePersistence {
    if (!this.sqlite.connection) throw new Error("SQLite 连接未就绪");
    return this.sqlite;
  }

  private async ensureSchema(): Promise<void> {
    await this.db.exec(`CREATE TABLE IF NOT EXISTS match_logs (
      id TEXT PRIMARY KEY NOT NULL,
      mode TEXT NOT NULL,
      time INTEGER NOT NULL,
      result TEXT NOT NULL,
      summary TEXT NOT NULL DEFAULT '',
      players TEXT NOT NULL DEFAULT '[]',
      detail TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    )`);
    await this.db.exec(`CREATE TABLE IF NOT EXISTS match_entries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      match_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      player_id INTEGER,
      player_name TEXT,
      cards TEXT,
      score INTEGER,
      hand_left INTEGER,
      source TEXT,
      reason TEXT,
      note TEXT,
      ts INTEGER
    )`);
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_entries_match ON match_entries(match_id)`);
    await this.db.exec(`CREATE INDEX IF NOT EXISTS idx_logs_time ON match_logs(time DESC)`);
  }

  async load(limit = this.capacity): Promise<MatchLog[]> {
    await this.ensureSchema();
    const rows = await this.db.select<LogRow[]>(
      `SELECT ${LOG_COLUMNS} FROM match_logs ORDER BY time DESC LIMIT $1`,
      [limit],
    );
    const entries = await this.loadEntries(rows.map((r) => r.id));
    return rows.map((r) => rowToLog(r, entries[r.id] ?? []));
  }

  async save(log: MatchLog): Promise<void> {
    await this.ensureSchema();
    await this.db.exec(
      `INSERT OR REPLACE INTO match_logs (id, mode, time, result, summary, players, detail, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        log.id,
        log.mode,
        log.time,
        log.result,
        log.summary,
        JSON.stringify(log.players),
        JSON.stringify(log.detail),
        Date.now(),
      ],
    );
    // 动作流水整局重写（一局最多几十条，代价可忽略，且天然幂等）
    await this.db.exec("DELETE FROM match_entries WHERE match_id = $1", [log.id]);
    const entries = log.entries ?? [];
    await this.db.exec("BEGIN");
    try {
      for (let i = 0; i < entries.length; i++) {
        const e = entries[i];
        await this.db.exec(
          `INSERT INTO match_entries (match_id, seq, kind, player_id, player_name, cards, score, hand_left, source, reason, note, ts)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
          [
            log.id,
            e.seq ?? i,
            e.kind,
            e.playerId ?? null,
            e.playerName ?? null,
            e.cards ? JSON.stringify(e.cards) : null,
            e.score ?? null,
            e.handLeft ?? null,
            e.source ?? null,
            e.reason ?? null,
            e.note ?? null,
            e.ts ?? log.time,
          ],
        );
      }
      await this.db.exec("COMMIT");
    } catch (err) {
      await this.db.exec("ROLLBACK").catch(() => undefined);
      throw err;
    }
    await this.trim();
  }

  async remove(id: string): Promise<void> {
    await this.db.exec("DELETE FROM match_entries WHERE match_id = $1", [id]);
    await this.db.exec("DELETE FROM match_logs WHERE id = $1", [id]);
  }

  async clear(): Promise<void> {
    await this.db.exec("DELETE FROM match_entries");
    await this.db.exec("DELETE FROM match_logs");
  }

  async query(q: MatchLogQuery): Promise<MatchLog[]> {
    await this.ensureSchema();
    const { sql, params } = this.buildWhere(q);
    const rows = await this.db.select<LogRow[]>(
      `SELECT ${LOG_COLUMNS} FROM match_logs${sql} ORDER BY time DESC LIMIT ${this.num(q.limit ?? 50)} OFFSET ${this.num(q.offset ?? 0)}`,
      params,
    );
    const entries = await this.loadEntries(rows.map((r) => r.id));
    return rows.map((r) => rowToLog(r, entries[r.id] ?? []));
  }

  async count(q: Pick<MatchLogQuery, "mode" | "keyword"> = {}): Promise<number> {
    const { sql, params } = this.buildWhere({ ...q, limit: undefined, offset: undefined });
    const rows = await this.db.select<{ c: number }[]>(
      `SELECT COUNT(*) AS c FROM match_logs${sql}`,
      params,
    );
    return Number(rows?.[0]?.c ?? 0);
  }

  /** 超出容量时删除最旧的几局（连同比条目） */
  private async trim(): Promise<void> {
    const rows = await this.db.select<{ id: string }[]>(
      "SELECT id FROM match_logs ORDER BY time DESC LIMIT -1 OFFSET $1",
      [this.capacity],
    );
    for (const r of rows) await this.remove(r.id);
  }

  private buildWhere(q: MatchLogQuery): { sql: string; params: unknown[] } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (q.mode) {
      params.push(q.mode);
      where.push(`mode = $${params.length}`);
    }
    if (q.keyword) {
      const like = `%${q.keyword}%`;
      params.push(like, like);
      const i = params.length;
      params.push(like);
      where.push(
        `(summary LIKE $${i - 2} OR players LIKE $${i - 1} OR EXISTS (
            SELECT 1 FROM match_entries e WHERE e.match_id = match_logs.id
            AND (e.player_name LIKE $${i} OR e.cards LIKE $${i} OR e.reason LIKE $${i})
         ))`,
      );
    }
    return { sql: where.length ? ` WHERE ${where.join(" AND ")}` : "", params };
  }

  private num(n: number): number {
    return Math.max(0, Math.floor(Number(n) || 0));
  }

  private async loadEntries(ids: string[]): Promise<Record<string, MatchLogEntry[]>> {
    const out: Record<string, MatchLogEntry[]> = {};
    if (!ids.length) return out;
    const marks = ids.map((_, i) => `$${i + 1}`).join(",");
    const rows = await this.db.select<EntryRow[]>(
      `SELECT match_id, seq, kind, player_id, player_name, cards, score, hand_left, source, reason, note, ts
       FROM match_entries WHERE match_id IN (${marks}) ORDER BY seq ASC`,
      ids,
    );
    for (const r of rows) {
      const list = (out[r.match_id] ??= []);
      list.push({
        kind: r.kind as MatchLogEntry["kind"],
        playerId: r.player_id ?? undefined,
        playerName: r.player_name ?? undefined,
        cards: r.cards ? parseJson<string[]>(r.cards, []) : undefined,
        score: r.score ?? undefined,
        handLeft: r.hand_left ?? undefined,
        source: (r.source as MatchLogEntry["source"]) ?? undefined,
        reason: r.reason ?? undefined,
        note: r.note ?? undefined,
        ts: r.ts ?? undefined,
        seq: r.seq,
      });
    }
    return out;
  }
}

// ===================== JSON 实现（localStorage / 内存回退） =====================
export class JsonMatchLogStore extends MatchLogStore {
  readonly capacity = MATCH_LOG_LIMIT_JSON;
  /** 体积保护：整块字符串不能撑爆 localStorage */
  static readonly MAX_BYTES = 2_000_000;

  constructor(
    private readonly backend: Persistence,
    private readonly key = "puke.matchLogs.v1",
  ) {
    super();
  }

  async load(): Promise<MatchLog[]> {
    const raw = this.backend.get<unknown>(this.key, null);
    return Array.isArray(raw) ? (raw as MatchLog[]) : [];
  }

  async save(log: MatchLog): Promise<void> {
    const list = await this.load();
    const next = [log, ...list.filter((l) => l.id !== log.id)];
    this.persist(next);
  }

  async remove(id: string): Promise<void> {
    const list = await this.load();
    this.persist(list.filter((l) => l.id !== id));
  }

  async clear(): Promise<void> {
    this.backend.set(this.key, []);
  }

  async query(q: MatchLogQuery): Promise<MatchLog[]> {
    let out = await this.load();
    if (q.mode) out = out.filter((l) => l.mode === q.mode);
    if (q.keyword) {
      const kw = q.keyword.toLowerCase();
      out = out.filter(
        (l) =>
          l.summary.toLowerCase().includes(kw) ||
          l.players.some((p) => p.toLowerCase().includes(kw)) ||
          l.entries.some(
            (e) =>
              (e.playerName ?? "").toLowerCase().includes(kw) ||
              (e.reason ?? "").toLowerCase().includes(kw) ||
              (e.cards ?? []).join(" ").toLowerCase().includes(kw),
          ),
      );
    }
    const start = q.offset ?? 0;
    return out.slice(start, start + (q.limit ?? 50));
  }

  async count(q: Pick<MatchLogQuery, "mode" | "keyword"> = {}): Promise<number> {
    return (await this.query({ ...q, limit: Number.MAX_SAFE_INTEGER })).length;
  }

  private persist(list: MatchLog[]): void {
    let out = list.slice(0, this.capacity);
    while (out.length > 1 && JSON.stringify(out).length > JsonMatchLogStore.MAX_BYTES) {
      out = out.slice(0, out.length - 1);
    }
    this.backend.set(this.key, out);
  }
}

// ===================== 工厂：按驱动种类多态分派 =====================
export function createMatchLogStore(backend: Persistence): MatchLogStore {
  if (backend instanceof SqlitePersistence) return new SqliteMatchLogStore(backend);
  return new JsonMatchLogStore(backend);
}

// ===================== 行映射 =====================
interface LogRow {
  id: string;
  mode: string;
  time: number;
  result: string;
  summary: string;
  players: string;
  detail: string;
}

interface EntryRow {
  match_id: string;
  seq: number;
  kind: string;
  player_id: number | null;
  player_name: string | null;
  cards: string | null;
  score: number | null;
  hand_left: number | null;
  source: string | null;
  reason: string | null;
  note: string | null;
  ts: number | null;
}

function parseJson<T>(text: string, fallback: T): T {
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

function rowToLog(r: LogRow, entries: MatchLogEntry[]): MatchLog {
  return {
    id: r.id,
    mode: r.mode as MatchLog["mode"],
    time: Number(r.time),
    result: r.result as MatchLog["result"],
    summary: r.summary,
    players: parseJson<string[]>(r.players, []),
    detail: parseJson<MatchLog["detail"]>(r.detail, { kind: "ddz" } as MatchLog["detail"]),
    entries,
  };
}

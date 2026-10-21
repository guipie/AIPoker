/**
 * 对局日志领域模型。
 *
 * 一局牌 = 一条 `MatchLog`（元信息 + 静态详情）+ 若干条 `MatchLogEntry`（动作流水）。
 * 桌面端会落到 SQLite 的 match_logs / match_entries 两张表，可直接用 SQL 查询统计；
 * 浏览器回退时整体序列化为 JSON。
 */

export type LogKind = "deal" | "bid" | "play" | "pass" | "act" | "over";

/** 决策来源：大模型 / 规则 AI / 玩家本人 */
export type DecisionSource = "llm" | "rule" | "human";

/** 一条动作记录 */
export interface MatchLogEntry {
  kind: LogKind;
  playerId?: number;
  playerName?: string;
  /** 打出的牌（展示文本，如 ["♠3","♥3"]） */
  cards?: string[];
  /** 抢地主分数（0 = 不抢） */
  score?: number;
  /** 该玩家剩余手牌数（动作之后） */
  handLeft?: number;
  source?: DecisionSource;
  /** 大模型给出的理由（或补充说明） */
  reason?: string;
  note?: string;
  /** 时间戳（默认写入时刻） */
  ts?: number;
  /** 动作序号（同一局内递增，用于排序） */
  seq?: number;
}

/** 斗地主一局的静态信息（复盘用） */
export interface DdzDetail {
  kind: "ddz";
  players: { name: string; role: string; agent?: string; hand: string[] }[];
  landlordName: string;
  bottomCards: string[];
  myRole: string;
  winner: string;
  redealCount: number;
}

/** 德州一手牌的静态信息 */
export interface HoldemDetail {
  kind: "holdem";
  hole: string[];
  community: string[];
  pot: number;
  winners: string[];
  players: { name: string; stack: number }[];
}

export type MatchDetail = DdzDetail | HoldemDetail;

/** 一局完整记录 */
export interface MatchLog {
  id: string;
  mode: "ddz" | "holdem";
  time: number;
  result: "胜" | "负";
  summary: string;
  players: string[];
  detail: MatchDetail;
  entries: MatchLogEntry[];
}

/** JSON（浏览器）方案下最多保留多少局明细；SQLite 方案容量更大，见 MatchLogStore */
export const MATCH_LOG_LIMIT_JSON = 30;

/** 生成新的对局 id */
export function newLogId(mode: "ddz" | "holdem"): string {
  return `${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

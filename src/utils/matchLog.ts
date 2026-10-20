// 对局日志：把每一局的「抢地主 / 出牌」全过程记录并能持久化，供战绩页复盘查看。
// 设计目标：结构简单、能长期躺在 localStorage 里（限制条数 + 体积保护）。

export type LogKind = "deal" | "bid" | "play" | "pass" | "act" | "over";

/** 一条动作记录 */
export interface MatchLogEntry {
  kind: LogKind;
  playerId?: number;
  playerName?: string;
  /** 打出的牌（展示文本，如 ["♠3","♥3"]） */
  cards?: string[];
  /** 抢地主分数（0 = 不抢） */
  score?: number;
  /** 该玩家剩余手牌数（出牌后） */
  handLeft?: number;
  /** 决策来源：大模型 / 规则 / 玩家本人 */
  source?: "llm" | "rule" | "human";
  /** 大模型给出的理由（或补充说明） */
  reason?: string;
  note?: string;
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

export interface MatchLog {
  id: string;
  mode: "ddz" | "holdem";
  time: number;
  result: "胜" | "负";
  summary: string;
  players: string[];
  detail: DdzDetail | HoldemDetail;
  entries: MatchLogEntry[];
}

export const MATCH_LOG_KEY = "puke.matchLogs.v1";
/** 最多保留多少局明细（超出的从最旧的删） */
export const MAX_MATCH_LOGS = 30;
/** 日志总字节上限，避免 localStorage 爆掉 */
const MAX_BYTES = 2_000_000;

export function loadMatchLogs(): MatchLog[] {
  try {
    const raw = localStorage.getItem(MATCH_LOG_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? (arr as MatchLog[]) : [];
  } catch {
    return [];
  }
}

export function saveMatchLogs(list: MatchLog[]) {
  // 先按条数截断，再按体积兜底裁剪
  let out = list.slice(0, MAX_MATCH_LOGS);
  try {
    let text = JSON.stringify(out);
    while (text.length > MAX_BYTES && out.length > 1) {
      out = out.slice(0, out.length - 1);
      text = JSON.stringify(out);
    }
    localStorage.setItem(MATCH_LOG_KEY, text);
  } catch {
    /* ignore（配额满/隐私模式） */
  }
}

export function newLogId(mode: "ddz" | "holdem"): string {
  return `${mode}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
}

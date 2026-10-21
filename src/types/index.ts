/**
 * 全局领域类型（单一来源）。
 * 以前这些类型散落在 store.ts / utils 里，视图又各自写 `any`；
 * 现在集中到 types/，store、Repository、视图统一从这里取，避免循环依赖与重复定义。
 */

/** 左侧导航 / 路由键 */
export type ViewKey = "plaza" | "doudizhu" | "holdem" | "agents" | "stats" | "settings";

/** 游戏模式（同时用于对局日志与战绩统计的键） */
export type GameMode = "doudizhu" | "holdem";

/** 对局日志里的简称（ddz / holdem），与 GameMode 一一对应 */
export type MatchMode = "ddz" | "holdem";

/** 大模型设置（全局默认；单个 agent 可覆盖 model/baseUrl/apiKey） */
export interface LlmSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  persona: string;
  temperature: number;
  sound: boolean;
}

/** agent 的模型配置覆盖（三项都可缺省，缺省表示沿用全局设置） */
export interface AgentModelOverride {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

/** AI 对手档案（内置 + 用户自定义统一结构） */
export interface AgentDef {
  id: string;
  name: string;
  /** 头像 emoji（无图片时回退用） */
  emoji: string;
  /** 可选图片 URL */
  avatar?: string;
  /** 主题色（tailwind 渐变两端） */
  color: string;
  color2: string;
  tagline: string;
  /** 激进度 0~1 */
  aggression: number;
  /** 紧度 0~1 */
  tightness: number;
  /** 覆盖全局模型 */
  model?: string;
  /** 自定义接口地址 */
  baseUrl?: string;
  /** 自定义 key */
  apiKey?: string;
  /** 独立人设 */
  persona?: string;
  blurb: string;
  isCustom?: boolean;
}

/** 单个模式的胜负计数 */
export interface ModeStat {
  win: number;
  lose: number;
}

/** 最近一手（战绩流水） */
export interface HandRecord {
  mode: GameMode;
  result: "胜" | "负";
  time: number;
  /** 关联的对局明细 id（可跳到战绩页复盘） */
  logId?: string;
}

/** 战绩统计 */
export interface Stats {
  doudizhu: ModeStat;
  holdem: ModeStat;
  hands: HandRecord[];
}

/** 结算横幅 */
export interface LastResult {
  mode: GameMode;
  win: boolean;
  text: string;
}

/** 把 GameMode 转成日志/统计里的简称 */
export function toMatchMode(mode: GameMode): MatchMode {
  return mode === "doudizhu" ? "ddz" : "holdem";
}

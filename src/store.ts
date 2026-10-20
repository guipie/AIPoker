// 中央状态：视图路由、LLM 设置、AI 对手档案库、默认/自定义 agent、牌桌选座、战绩统计、对局日志。
import { reactive } from "vue";
import {
  loadMatchLogs,
  saveMatchLogs,
  type MatchLog,
} from "./utils/matchLog";

export type ViewKey = "plaza" | "doudizhu" | "holdem" | "agents" | "stats" | "settings";
export type GameMode = "doudizhu" | "holdem";

export interface LlmSettings {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  persona: string;
  temperature: number;
  sound: boolean;
}

export interface AgentDef {
  id: string;
  name: string;
  emoji: string; // 头像 emoji（无图片时回退用）
  avatar?: string; // 可选图片 URL
  color: string; // 主题色（tailwind 渐变两端）
  color2: string;
  tagline: string;
  aggression: number; // 0~1
  tightness: number; // 0~1
  model?: string; // 可选：覆盖全局模型（不同 agent 用不同大模型）
  baseUrl?: string; // 自定义大模型的接口地址
  apiKey?: string; // 自定义大模型的 key
  persona?: string; // 可选：独立人设
  blurb: string;
  isCustom?: boolean; // 用户自定义
}

// ===================== AI 对手档案库（agent 广场） =====================
export const AGENTS: AgentDef[] = [
  {
    id: "qiang",
    name: "狂刀阿强",
    emoji: "🤠",
    color: "from-rose-500",
    color2: "to-red-700",
    tagline: "激进诈唬流",
    aggression: 0.88,
    tightness: 0.35,
    model: "deepseek-flash",
    persona: "激进好斗，喜欢加注和诈唬，口头禅「跟到底」",
    blurb: "永远在施压，能逼出你的破绽，也常在自己诈唬时翻车。",
  },
  {
    id: "mou",
    name: "老谋子",
    emoji: "🧠",
    color: "from-sky-500",
    color2: "to-blue-800",
    tagline: "保守计算型",
    aggression: 0.22,
    tightness: 0.85,
    model: "gpt-4o-mini",
    persona: "冷静理性，只玩强牌，擅长读牌与赔率计算",
    blurb: "稳如磐石，轻易不参战，一旦下注往往牌力不俗。",
  },
  {
    id: "gambit",
    name: "赌神G",
    emoji: "😎",
    color: "from-violet-500",
    color2: "to-fuchsia-700",
    tagline: "均衡职业选手",
    aggression: 0.55,
    tightness: 0.55,
    model: "moonshot-v1-8k",
    persona: "风格均衡的职业牌手，攻守兼备",
    blurb: "没有明显短板，会利用位置与下注尺度拿价值。",
  },
  {
    id: "fox",
    name: "小狐狸",
    emoji: "🦊",
    color: "from-orange-400",
    color2: "to-amber-600",
    tagline: "松凶诈唬怪",
    aggression: 0.92,
    tightness: 0.28,
    model: "qwen2.5:7b",
    persona: "机灵爱诈唬的狐狸，常常用空气牌吓人",
    blurb: "出手频率极高，诈唬多到你难以判断真假。",
  },
  {
    id: "tie",
    name: "铁柱哥",
    emoji: "🪨",
    color: "from-slate-400",
    color2: "to-slate-700",
    tagline: "紧弱跟注站",
    aggression: 0.18,
    tightness: 0.82,
    persona: "老实巴交的跟注站，轻易不弃牌也不加注",
    blurb: "像块石头，只会用真牌跟注，别想诈唬他。",
  },
  {
    id: "bolt",
    name: "闪电",
    emoji: "⚡",
    color: "from-yellow-400",
    color2: "to-amber-600",
    tagline: "快攻猛打",
    aggression: 0.8,
    tightness: 0.5,
    model: "deepseek-flash",
    persona: "节奏极快的进攻型选手，喜欢快速施压",
    blurb: "出手又快又狠，给你思考的时间很少。",
  },
  {
    id: "pro",
    name: "教授",
    emoji: "🎓",
    color: "from-emerald-500",
    color2: "to-teal-700",
    tagline: "GTO 理论派",
    aggression: 0.5,
    tightness: 0.62,
    model: "gpt-4o",
    persona: "严谨遵循博弈论最优策略（GTO）的理论派",
    blurb: "数学碾压型对手，漏洞极少，长期必赢。",
  },
  {
    id: "rookie",
    name: "萌新小白",
    emoji: "🐣",
    color: "from-pink-400",
    color2: "to-rose-500",
    tagline: "新手练习对象",
    aggression: 0.45,
    tightness: 0.4,
    persona: "刚学会扑克的新手，偶尔犯迷糊",
    blurb: "手感飘忽的新人，适合练手找信心。",
  },
];

// ===================== 持久化 =====================
const SETTINGS_KEY = "puke.settings.v2";
const STATS_KEY = "puke.stats.v2";
const CUSTOM_KEY = "puke.customAgents.v1";
const DEFAULTS_KEY = "puke.defaultAgentIds.v1";
const OVERRIDES_KEY = "puke.agentOverrides.v1";

const defaultSettings: LlmSettings = {
  enabled: false,
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-flash",
  apiKey: "",
  persona: "",
  temperature: 0.6,
  sound: true,
};

function loadSettings(): LlmSettings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (raw) return { ...defaultSettings, ...JSON.parse(raw) };
  } catch {
    /* ignore */
  }
  return { ...defaultSettings };
}

function loadCustom(): AgentDef[] {
  try {
    const raw = localStorage.getItem(CUSTOM_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return [];
}

function loadDefaultIds(): string[] {
  try {
    const raw = localStorage.getItem(DEFAULTS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return [];
}

/** agent 的模型配置覆盖（内置 agent 也可改用别的大模型） */
export interface AgentModelOverride {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}

function loadOverrides(): Record<string, AgentModelOverride> {
  try {
    const raw = localStorage.getItem(OVERRIDES_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return {};
}

export interface Stats {
  ddz: { win: number; lose: number };
  holdem: { win: number; lose: number };
  hands: { mode: string; result: string; time: number; logId?: string }[];
}

function loadStats(): Stats {
  try {
    const raw = localStorage.getItem(STATS_KEY);
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { ddz: { win: 0, lose: 0 }, holdem: { win: 0, lose: 0 }, hands: [] };
}

export const store = reactive({
  view: "plaza" as ViewKey,
  settings: loadSettings(),
  selectedAgentIds: [] as string[], // Agent 广场多选（用于开始按钮）
  defaultAgentIds: loadDefaultIds(), // 设为「默认」的 agent（开局优先）
  customAgents: loadCustom(), // 用户自定义大模型 agent
  agentOverrides: loadOverrides(), // 内置/自定义 agent 的模型配置覆盖（model/baseUrl/apiKey）
  startAgents: null as string[] | null, // 从广场开局时指定的对手列表
  pendingNewGame: null as GameMode | null, // 标记进入视图后需开新局
  pendingStatLogId: null as string | null, // 结算后「查看本局明细」：跳到战绩页自动打开这一局
  activeGame: null as GameMode | null, // 当前进行中的牌局（用于悬浮圆球）
  stats: loadStats(),
  matchLogs: loadMatchLogs(), // 每局详细过程（抢地主 / 出牌 / 摊牌），供战绩页复盘
  lastResult: null as null | { mode: string; win: boolean; text: string },
});

// ===================== 持久化工具 =====================
export function saveSettings() {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(store.settings));
  } catch {
    /* ignore */
  }
}
export function saveStats() {
  try {
    localStorage.setItem(STATS_KEY, JSON.stringify(store.stats));
  } catch {
    /* ignore */
  }
}
function saveCustom() {
  try {
    localStorage.setItem(CUSTOM_KEY, JSON.stringify(store.customAgents));
  } catch {
    /* ignore */
  }
}
function saveDefaultIds() {
  try {
    localStorage.setItem(DEFAULTS_KEY, JSON.stringify(store.defaultAgentIds));
  } catch {
    /* ignore */
  }
}
function saveOverrides() {
  try {
    localStorage.setItem(OVERRIDES_KEY, JSON.stringify(store.agentOverrides));
  } catch {
    /* ignore */
  }
}

/** 保存某个 agent 的模型配置覆盖（baseUrl/model/apiKey；字段未提供=保持不变，空串=清除该项回落默认） */
export function saveAgentOverride(id: string, patch: AgentModelOverride) {
  const cur: AgentModelOverride = { ...(store.agentOverrides[id] ?? {}) };
  for (const k of ["baseUrl", "apiKey", "model"] as const) {
    if (patch[k] === undefined) continue; // 未提供该字段 → 不动
    const v = patch[k].trim();
    if (v) cur[k] = v;
    else delete cur[k]; // 显式传空串 = 清除覆盖
  }
  if (Object.keys(cur).length === 0) delete store.agentOverrides[id];
  else store.agentOverrides[id] = cur;
  saveOverrides();
}

/** 清除某个 agent 的全部模型配置覆盖（恢复默认） */
export function clearAgentOverride(id: string) {
  delete store.agentOverrides[id];
  saveOverrides();
}

/** 直接修改自定义 agent 的模型配置（写回 customAgents 并持久化） */
export function updateCustomAgent(id: string, patch: AgentModelOverride) {
  const a = store.customAgents.find(c => c.id === id);
  if (!a) return;
  if (patch.baseUrl !== undefined) a.baseUrl = patch.baseUrl.trim() || undefined;
  if (patch.apiKey !== undefined) a.apiKey = patch.apiKey.trim() || undefined;
  if (patch.model !== undefined) a.model = patch.model.trim() || store.settings.model;
  saveCustom();
}

// ===================== Agent 查询 =====================
export function allAgents(): AgentDef[] {
  // 合并模型配置覆盖，使内置 agent 也能用用户指定的 baseUrl/apiKey/model
  const merged = [...AGENTS, ...store.customAgents].map(a => {
    const o = store.agentOverrides[a.id];
    return o ? { ...a, ...o } : a;
  });
  return merged;
}

export function agentById(id: string): AgentDef | undefined {
  return allAgents().find(a => a.id === id);
}

export function isDefault(id: string): boolean {
  return store.defaultAgentIds.includes(id);
}

/** 切换某个 agent 的「默认」状态（开局优先显示） */
export function toggleDefault(id: string) {
  const i = store.defaultAgentIds.indexOf(id);
  if (i >= 0) store.defaultAgentIds.splice(i, 1);
  else store.defaultAgentIds.push(id);
  saveDefaultIds();
}

/** 新增自定义 agent（持久化） */
export function addCustomAgent(a: AgentDef) {
  store.customAgents.push(a);
  saveCustom();
}

function shuffleStr(arr: string[]): string[] {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/**
 * 挑选 count 个对手 id：优先使用「默认」agent（按默认顺序），
 * 不足再从剩余池随机补足；exclude 内的 id 会被跳过。
 * 没有默认 agent 时完全随机。
 */
export function pickAgents(count: number, exclude: string[] = []): string[] {
  const pool = allAgents()
    .map(a => a.id)
    .filter(id => !exclude.includes(id));
  const defs = store.defaultAgentIds.filter(id => pool.includes(id));
  const rest = shuffleStr(pool.filter(id => !defs.includes(id)));
  return [...defs, ...rest].slice(0, count);
}

/** 从广场/首页发起一局：记录对手列表并切到对应视图 */
export function beginGame(mode: GameMode, agents?: string[]) {
  store.startAgents = agents && agents.length ? [...agents] : null;
  store.pendingNewGame = mode;
  store.activeGame = mode;
  store.view = mode;
}

export function recordResult(
  mode: "ddz" | "holdem",
  win: boolean,
  text: string,
  logId?: string,
) {
  if (win) store.stats[mode].win++;
  else store.stats[mode].lose++;
  store.stats.hands.unshift({ mode, result: win ? "胜" : "负", time: Date.now(), logId });
  if (store.stats.hands.length > 50) store.stats.hands.pop();
  store.lastResult = { mode, win, text };
  saveStats();
}

// ===================== 对局日志（明细复盘） =====================

/** 追加一局明细（最新的在最前），并做条数/体积保护 */
export function addMatchLog(log: MatchLog) {
  store.matchLogs.unshift(log);
  if (store.matchLogs.length > 30) store.matchLogs.splice(30);
  saveMatchLogs(store.matchLogs);
}

export function matchLogById(id: string | undefined | null): MatchLog | null {
  if (!id) return null;
  return store.matchLogs.find((l) => l.id === id) ?? null;
}

export function clearMatchLogs() {
  store.matchLogs.splice(0);
  saveMatchLogs([]);
}

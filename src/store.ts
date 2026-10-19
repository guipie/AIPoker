// 中央状态：视图路由、LLM 设置、AI 对手档案库、默认/自定义 agent、牌桌选座、战绩统计。
import { reactive } from "vue";

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
    model: "deepseek-chat",
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
    model: "deepseek-chat",
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

const defaultSettings: LlmSettings = {
  enabled: false,
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-chat",
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

export interface Stats {
  ddz: { win: number; lose: number };
  holdem: { win: number; lose: number };
  hands: { mode: string; result: string; time: number }[];
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
  startAgents: null as string[] | null, // 从广场开局时指定的对手列表
  pendingNewGame: null as GameMode | null, // 标记进入视图后需开新局
  activeGame: null as GameMode | null, // 当前进行中的牌局（用于悬浮圆球）
  stats: loadStats(),
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

// ===================== Agent 查询 =====================
export function allAgents(): AgentDef[] {
  return [...AGENTS, ...store.customAgents];
}

export function agentById(id: string): AgentDef | undefined {
  return allAgents().find((a) => a.id === id);
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
    .map((a) => a.id)
    .filter((id) => !exclude.includes(id));
  const defs = store.defaultAgentIds.filter((id) => pool.includes(id));
  const rest = shuffleStr(pool.filter((id) => !defs.includes(id)));
  return [...defs, ...rest].slice(0, count);
}

/** 从广场/首页发起一局：记录对手列表并切到对应视图 */
export function beginGame(mode: GameMode, agents?: string[]) {
  store.startAgents = agents && agents.length ? [...agents] : null;
  store.pendingNewGame = mode;
  store.activeGame = mode;
  store.view = mode;
}

export function recordResult(mode: "ddz" | "holdem", win: boolean, text: string) {
  if (win) store.stats[mode].win++;
  else store.stats[mode].lose++;
  store.stats.hands.unshift({ mode, result: win ? "胜" : "负", time: Date.now() });
  if (store.stats.hands.length > 50) store.stats.hands.pop();
  store.lastResult = { mode, win, text };
  saveStats();
}

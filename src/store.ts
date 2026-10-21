/**
 * 中央状态：视图路由、LLM 设置、AI 对手档案、选座、战绩、对局明细。
 *
 * 分层（自上而下单向依赖，避免循环）：
 *   视图 / 组件 → store（本文件）→ Repository → Persistence（SQLite / localStorage / 内存）
 *
 * 本文件不再直接触碰任何存储介质：所有读写都走 `src/storage/`，
 * 于是「桌面端存 SQLite、浏览器存 localStorage」对业务代码完全透明。
 */
import { reactive } from "vue";
import { AGENTS } from "./data/agents";
import type { DriverKind } from "./storage/BasePersistence";
import { initPersistence, persistenceStatus, type Persistence } from "./storage";
import { MemoryPersistence } from "./storage/MemoryPersistence";
import {
  AgentsRepository,
  SettingsRepository,
  StatsRepository,
} from "./storage/Repository";
import { createMatchLogStore, type MatchLogQuery, type MatchLogStore } from "./storage/MatchLogStore";
import type {
  AgentDef,
  AgentModelOverride,
  GameMode,
  LastResult,
  LlmSettings,
  Stats,
  ViewKey,
} from "./types";
import type { MatchLog, MatchLogEntry } from "./types/match";

// 类型再导出：视图可从 store 或 types 取，保持旧 import 路径可用
export type {
  AgentDef,
  AgentModelOverride,
  GameMode,
  LlmSettings,
  Stats,
  ViewKey,
} from "./types";
export type { MatchLog, MatchLogEntry } from "./types/match";

const DEFAULT_SETTINGS: LlmSettings = {
  enabled: false,
  baseUrl: "https://api.deepseek.com/v1",
  model: "deepseek-flash",
  apiKey: "",
  persona: "",
  temperature: 0.6,
  sound: true,
};

function defaultStats(): Stats {
  return {
    doudizhu: { win: 0, lose: 0 },
    holdem: { win: 0, lose: 0 },
    hands: [],
  };
}

export const store = reactive({
  view: "plaza" as ViewKey,
  settings: { ...DEFAULT_SETTINGS },
  selectedAgentIds: [] as string[], // Agent 广场多选（用于开始按钮）
  defaultAgentIds: [] as string[], // 设为「默认」的 agent（开局优先）
  customAgents: [] as AgentDef[], // 用户自定义大模型 agent
  agentOverrides: {} as Record<string, AgentModelOverride>, // agent 的模型配置覆盖
  startAgents: null as string[] | null, // 从广场开局时指定的对手列表
  pendingNewGame: null as GameMode | null, // 进入视图后需开新局
  pendingStatLogId: null as string | null, // 结算后「查看本局明细」自动打开这一局
  activeGame: null as GameMode | null, // 当前进行中的牌局（悬浮圆球）
  stats: defaultStats(),
  matchLogs: [] as MatchLog[], // 每局明细（镜像，供战绩页复盘）
  lastResult: null as LastResult | null,
  /** 当前实际使用的存储介质（设置页展示） */
  storage: {
    kind: "memory" as DriverKind,
    label: "初始化中…",
    ready: false,
    error: null as string | null,
  },
});

// ===================== 持久化装配 =====================
// 先挂一套内存实现，保证 bootstrap 之前调用也不会崩；bootstrap 后会被真实驱动替换。
let backend: Persistence = new MemoryPersistence();
let settingsRepo = new SettingsRepository(backend);
let statsRepo = new StatsRepository(backend);
let agentsRepo = new AgentsRepository(backend);
let logStore: MatchLogStore = createMatchLogStore(backend);

/**
 * 启动装配：打开持久化 → 建 Repository → 把数据灌进 store。
 * 在 main.ts 里 mount 之前 await，避免首屏读到默认值再闪一下。
 */
export async function bootstrapStore(): Promise<void> {
  try {
    backend = await initPersistence();
    settingsRepo = new SettingsRepository(backend);
    statsRepo = new StatsRepository(backend);
    agentsRepo = new AgentsRepository(backend);
    logStore = createMatchLogStore(backend);

    store.settings = settingsRepo.load();
    store.stats = statsRepo.load();
    store.customAgents = agentsRepo.custom.load();
    store.agentOverrides = agentsRepo.overrides.load();
    store.defaultAgentIds = agentsRepo.defaultIds.load();
    store.matchLogs = await logStore.load();

    const st = persistenceStatus();
    store.storage.kind = st?.kind ?? "memory";
    store.storage.label = st?.label ?? "内存（临时）";
    store.storage.ready = true;
  } catch (e) {
    store.storage.error = e instanceof Error ? e.message : String(e);
    store.storage.ready = true; // 出错也要让 UI 起来，只是不落盘
  }
}

// ===================== 持久化入口（写操作：内存即时 + 异步落盘） =====================
export function saveSettings(): void {
  settingsRepo.save(store.settings);
}
export function saveStats(): void {
  statsRepo.save(store.stats);
}
function saveCustom(): void {
  agentsRepo.custom.save(store.customAgents);
}
function saveDefaultIds(): void {
  agentsRepo.defaultIds.save(store.defaultAgentIds);
}
function saveOverrides(): void {
  agentsRepo.overrides.save(store.agentOverrides);
}

/** 手动把所有改动刷到介质（如退出前调用） */
export function flushStorage(): Promise<void> {
  return backend.flush();
}

// ===================== Agent =====================
/** 保存某个 agent 的模型配置覆盖（未提供=不动，空串=清除该项回落默认） */
export function saveAgentOverride(id: string, patch: AgentModelOverride): void {
  const cur: AgentModelOverride = { ...(store.agentOverrides[id] ?? {}) };
  for (const k of ["baseUrl", "apiKey", "model"] as const) {
    if (patch[k] === undefined) continue;
    const v = (patch[k] ?? "").trim();
    if (v) cur[k] = v;
    else delete cur[k];
  }
  if (Object.keys(cur).length === 0) delete store.agentOverrides[id];
  else store.agentOverrides[id] = cur;
  saveOverrides();
}

/** 清除某个 agent 的全部模型配置覆盖（恢复默认） */
export function clearAgentOverride(id: string): void {
  delete store.agentOverrides[id];
  saveOverrides();
}

/** 直接修改自定义 agent 的模型配置（写回 customAgents 并持久化） */
export function updateCustomAgent(id: string, patch: AgentModelOverride): void {
  const a = store.customAgents.find((c) => c.id === id);
  if (!a) return;
  if (patch.baseUrl !== undefined) a.baseUrl = patch.baseUrl.trim() || undefined;
  if (patch.apiKey !== undefined) a.apiKey = patch.apiKey.trim() || undefined;
  if (patch.model !== undefined) a.model = patch.model.trim() || store.settings.model;
  saveCustom();
}

/** 全部 agent（内置 + 自定义），已合并模型配置覆盖 */
export function allAgents(): AgentDef[] {
  return [...AGENTS, ...store.customAgents].map((a) => {
    const o = store.agentOverrides[a.id];
    return o ? { ...a, ...o } : a;
  });
}

export function agentById(id: string): AgentDef | undefined {
  return allAgents().find((a) => a.id === id);
}

export function isDefault(id: string): boolean {
  return store.defaultAgentIds.includes(id);
}

/** 切换某个 agent 的「默认」状态（开局优先显示） */
export function toggleDefault(id: string): void {
  const i = store.defaultAgentIds.indexOf(id);
  if (i >= 0) store.defaultAgentIds.splice(i, 1);
  else store.defaultAgentIds.push(id);
  saveDefaultIds();
}

/** 新增自定义 agent（持久化） */
export function addCustomAgent(a: AgentDef): void {
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
 * 挑选 count 个对手 id：优先「默认」agent，不足再从剩余池随机补足；
 * exclude 内的 id 会被跳过。
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
export function beginGame(mode: GameMode, agents?: string[]): void {
  store.startAgents = agents && agents.length ? [...agents] : null;
  store.pendingNewGame = mode;
  store.activeGame = mode;
  store.view = mode;
}

// ===================== 战绩 =====================
export function recordResult(mode: GameMode, win: boolean, text: string, logId?: string): void {
  const bucket = store.stats[mode];
  if (win) bucket.win += 1;
  else bucket.lose += 1;
  store.stats.hands.unshift({ mode, result: win ? "胜" : "负", time: Date.now(), logId });
  if (store.stats.hands.length > StatsRepository.MAX_HANDS) store.stats.hands.pop();
  store.lastResult = { mode, win, text };
  saveStats();
}

// ===================== 对局明细 =====================

/** 追加一局明细（镜像即时更新 + 异步落盘） */
export function addMatchLog(log: MatchLog): void {
  const cap = logStore.capacity;
  store.matchLogs.unshift(log);
  if (store.matchLogs.length > cap) store.matchLogs.length = cap;
  void logStore.save(log).catch(() => undefined);
}

export function matchLogById(id: string | undefined | null): MatchLog | null {
  if (!id) return null;
  return store.matchLogs.find((l) => l.id === id) ?? null;
}

/** 条件查询（桌面端走 SQL，浏览器走内存过滤——多态） */
export function searchMatchLogs(q: MatchLogQuery = {}): Promise<MatchLog[]> {
  return logStore.query(q);
}

export async function removeMatchLog(id: string): Promise<void> {
  const i = store.matchLogs.findIndex((l) => l.id === id);
  if (i >= 0) store.matchLogs.splice(i, 1);
  await logStore.remove(id);
}

export async function clearMatchLogs(): Promise<void> {
  store.matchLogs.splice(0);
  await logStore.clear();
}

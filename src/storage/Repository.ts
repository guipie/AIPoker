/**
 * Repository 层：把「某个业务对象怎么存」封装起来，store / 视图不再直接碰 localStorage。
 *
 * 两层设计：
 * - `Repository<T>`：抽象基类，定义模板流程（读镜像 → 校验 → 归一 → 兜底默认），
 *   子类只需提供 `defaults()` 与 `validate()`。
 * - `JsonRepository<T>`：配置驱动的通用实现（给默认值 + 可选类型守卫即可开箱用）。
 *   需要字段级清洗的业务（设置、战绩）则继承基类并 override `normalize()`。
 */
import type { Persistence } from "./BasePersistence";
import type {
  AgentDef,
  AgentModelOverride,
  GameMode,
  HandRecord,
  LlmSettings,
  Stats,
} from "../types";

export abstract class Repository<T> {
  constructor(
    protected readonly backend: Persistence,
    public readonly key: string,
  ) {}

  /** 数据缺失或损坏时的兜底值 */
  protected abstract defaults(): T;

  /** 反序列化校验：`unknown` → `T`，不可用返回 null（自动回落默认） */
  protected abstract validate(raw: unknown): T | null;

  /** 归一钩子：把合法但越界的值拉回正常区间（默认不动，子类可 override） */
  protected normalize(value: T): T {
    return value;
  }

  /** 模板方法：统一的读取流程 */
  load(): T {
    const raw = this.backend.get<unknown>(this.key, null);
    if (raw === null || raw === undefined) return this.defaults();
    const parsed = this.validate(raw);
    return parsed === null ? this.defaults() : this.normalize(parsed);
  }

  /** 写入（同步更新镜像 + 异步落盘），返回写入的值便于链式使用 */
  save(value: T): T {
    this.backend.set(this.key, value);
    return value;
  }

  /** 读—改—写，避免调用方自己 load/save 造成漏存 */
  update(mutator: (current: T) => T): T {
    return this.save(mutator(this.load()));
  }

  reset(): T {
    return this.save(this.defaults());
  }
}

/** 配置驱动的通用实现：给定默认值与可选守卫函数即可使用 */
export class JsonRepository<T> extends Repository<T> {
  constructor(
    backend: Persistence,
    key: string,
    private readonly fallback: () => T,
    private readonly guard?: (raw: unknown) => T | null,
  ) {
    super(backend, key);
  }
  protected defaults(): T {
    return this.fallback();
  }
  protected validate(raw: unknown): T | null {
    if (this.guard) return this.guard(raw);
    return raw as T;
  }
}

// ===================== 具体 Repository =====================

/** 键名沿用历史版本，保证升级后老数据还在 */
export const KEYS = {
  settings: "puke.settings.v2",
  stats: "puke.stats.v2",
  customAgents: "puke.customAgents.v1",
  defaultAgentIds: "puke.defaultAgentIds.v1",
  agentOverrides: "puke.agentOverrides.v1",
} as const;

const clamp = (n: number, lo: number, hi: number): number =>
  Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : lo;

/** 大模型设置：需要字段级清洗（越界温度、缺失开关） */
export class SettingsRepository extends Repository<LlmSettings> {
  constructor(backend: Persistence) {
    super(backend, KEYS.settings);
  }

  protected defaults(): LlmSettings {
    return {
      enabled: false,
      baseUrl: "https://api.deepseek.com/v1",
      model: "deepseek-flash",
      apiKey: "",
      persona: "",
      temperature: 0.6,
      sound: true,
    };
  }

  protected validate(raw: unknown): LlmSettings | null {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Partial<LlmSettings>;
    return {
      enabled: Boolean(r.enabled),
      baseUrl: typeof r.baseUrl === "string" ? r.baseUrl : this.defaults().baseUrl,
      model: typeof r.model === "string" ? r.model : this.defaults().model,
      apiKey: typeof r.apiKey === "string" ? r.apiKey : "",
      persona: typeof r.persona === "string" ? r.persona : "",
      temperature: typeof r.temperature === "number" ? r.temperature : 0.6,
      sound: r.sound !== false,
    };
  }

  protected override normalize(v: LlmSettings): LlmSettings {
    return { ...v, temperature: clamp(v.temperature, 0, 2) };
  }
}

/** 战绩：兼容老版本（ddz 键 + 旧 result 文本），并做条数上限保护 */
export class StatsRepository extends Repository<Stats> {
  /** 最近战绩最多保留多少条 */
  static readonly MAX_HANDS = 50;

  constructor(backend: Persistence) {
    super(backend, KEYS.stats);
  }

  protected defaults(): Stats {
    return {
      doudizhu: { win: 0, lose: 0 },
      holdem: { win: 0, lose: 0 },
      hands: [],
    };
  }

  protected validate(raw: unknown): Stats | null {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    // 兼容旧结构：{ ddz: {...} } → { doudizhu: {...} }
    const legacy = r.ddz as { win?: number; lose?: number } | undefined;
    const ddz = (r.doudizhu ?? legacy) as { win?: number; lose?: number } | undefined;
    const hl = r.holdem as { win?: number; lose?: number } | undefined;
    const hands = Array.isArray(r.hands) ? (r.hands as HandRecord[]) : [];
    return {
      doudizhu: { win: Number(ddz?.win ?? 0), lose: Number(ddz?.lose ?? 0) },
      holdem: { win: Number(hl?.win ?? 0), lose: Number(hl?.lose ?? 0) },
      hands: hands.filter(
        (h): h is HandRecord => Boolean(h) && typeof h.time === "number" && typeof h.result === "string",
      ),
    };
  }

  protected override normalize(v: Stats): Stats {
    return { ...v, hands: v.hands.slice(0, StatsRepository.MAX_HANDS) };
  }

  /** 记录一手结果（胜/负 + 关联明细 id） */
  record(mode: GameMode, win: boolean, logId?: string): Stats {
    const next = this.update((cur) => {
      const bucket = mode === "doudizhu" ? cur.doudizhu : cur.holdem;
      if (win) bucket.win += 1;
      else bucket.lose += 1;
      cur.hands.unshift({ mode, result: win ? "胜" : "负", time: Date.now(), logId });
      if (cur.hands.length > StatsRepository.MAX_HANDS) cur.hands.pop();
      return cur;
    });
    return next;
  }
}

/**
 * Agent 档案库：由三个独立的 Repository 组合而成（组合优于继承——
 * 三份数据生命周期不同，硬塞进一个「大对象 Repository」反而耦合）。
 */
export class AgentsRepository {
  readonly custom: JsonRepository<AgentDef[]>;
  readonly overrides: JsonRepository<Record<string, AgentModelOverride>>;
  readonly defaultIds: JsonRepository<string[]>;

  constructor(backend: Persistence) {
    this.custom = new JsonRepository<AgentDef[]>(
      backend,
      KEYS.customAgents,
      () => [],
      (raw) => (Array.isArray(raw) ? (raw as AgentDef[]) : null),
    );
    this.overrides = new JsonRepository<Record<string, AgentModelOverride>>(
      backend,
      KEYS.agentOverrides,
      () => ({}),
      (raw) => (typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, AgentModelOverride>) : null),
    );
    this.defaultIds = new JsonRepository<string[]>(
      backend,
      KEYS.defaultAgentIds,
      () => [],
      (raw) => (Array.isArray(raw) ? (raw as string[]) : null),
    );
  }
}

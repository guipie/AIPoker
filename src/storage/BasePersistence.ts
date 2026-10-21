/**
 * 本地持久化抽象层（驱动层）。
 *
 * 设计要点：
 * 1. **面向接口编程**：上层（Repository / store）只认识 `Persistence` 这个抽象类型，
 *    永远不知道底下是 SQLite 还是 localStorage——这就是多态的价值。
 * 2. **模板方法模式**：抽象基类 `BasePersistence` 固化了「打开 → 预热镜像 → 同步读 / 异步写」
 *    这套完整流程，子类只需实现四个 IO 原语（open/readAllRaw/writeRaw/removeRaw）。
 * 3. **写穿透缓存（Write-Through Cache）**：
 *    - 读：永远同步命中内存镜像，UI 代码不用改成 async；
 *    - 写：同步更新镜像 + 异步排队落盘，失败只记录状态、绝不打断牌局。
 *
 * 之所以必须这么设计：SQLite（Tauri）是异步的，而浏览器 localStorage 是同步的。
 * 统一成「同步读 + 异步写」后，两种介质的差异被完全封装在驱动里。
 */

/** 驱动种类（可在设置页展示当前实际使用的介质） */
export type DriverKind = "sqlite" | "localStorage" | "memory";

/** 驱动健康状态：UI 可据此提示「数据未落盘」 */
export interface PersistenceStatus {
  kind: DriverKind;
  label: string;
  opened: boolean;
  /** 待落盘的键数量（>0 表示正在写入） */
  pending: number;
  lastError: string | null;
}

/**
 * 驱动契约：只负责「键 → 文本」的存取，不理解任何业务语义。
 * 具体驱动通过继承 `BasePersistence` 实现它（也可独立实现，便于测试造替身）。
 */
export interface Persistence {
  readonly kind: DriverKind;
  readonly label: string;

  // ---- 同步读（命中内存镜像，UI 可以直接用） ----
  get<T>(key: string, fallback: T): T;
  has(key: string): boolean;

  // ---- 异步写（写穿透：镜像即时更新，后台落盘） ----
  set<T>(key: string, value: T): void;
  remove(key: string): void;
  flush(): Promise<void>;

  // ---- 生命周期 / 批量 ----
  /** 打开介质并预热内存镜像；失败时由实现决定降级策略 */
  open(): Promise<void>;
  close(): Promise<void>;
  /** 把快照写入介质（批量，用于迁移） */
  writeThrough(entries: Record<string, string>): Promise<void>;
  /** 删除若干键 */
  drop(keys: string[]): Promise<void>;
  /** 读取全部键值（用于启动时预热 / 迁移） */
  readAll(): Promise<Record<string, string>>;
  status(): PersistenceStatus;
}

/** 序列化失败的兜底：宁可丢数据也不能让牌局崩掉 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

/**
 * 抽象基类：持有内存镜像 + 落盘队列，对外暴露同步 get / 异步 set。
 * 子类只实现 IO 原语（见 protected 抽象方法）。
 */
export abstract class BasePersistence implements Persistence {
  abstract readonly kind: DriverKind;
  abstract readonly label: string;

  /** 内存镜像：所有同步读取都走这里 */
  private readonly mirror = new Map<string, string>();
  /** 待落盘队列：值为 null 表示删除 */
  private readonly queue = new Map<string, string | null>();
  /** 串行化所有落盘操作，避免并发写同一键 */
  private chain: Promise<void> = Promise.resolve();
  private opened = false;
  private lastError: string | null = null;

  // ===================== 子类必须实现的 IO 原语 =====================
  protected abstract doOpen(): Promise<void>;
  protected abstract doReadAll(): Promise<Record<string, string>>;
  protected abstract doWrite(entries: Record<string, string>): Promise<void>;
  protected abstract doRemove(keys: string[]): Promise<void>;
  protected abstract doClose(): Promise<void>;

  // ===================== 生命周期 =====================
  async open(): Promise<void> {
    if (this.opened) return;
    try {
      await this.doOpen();
      const all = await this.doReadAll();
      for (const [k, v] of Object.entries(all)) this.mirror.set(k, v);
      this.opened = true;
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      throw e; // 交给工厂降级
    }
  }

  async close(): Promise<void> {
    await this.flush();
    await this.doClose().catch(() => undefined);
    this.opened = false;
  }

  get isOpen(): boolean {
    return this.opened;
  }

  // ===================== 同步读（UI 友好） =====================
  /** 读取并反序列化；不存在或解析失败时返回 fallback */
  get<T>(key: string, fallback: T): T {
    const raw = this.mirror.get(key);
    if (raw === undefined) return fallback;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  has(key: string): boolean {
    return this.mirror.has(key);
  }

  /** 镜像里已有的全部键（调试用） */
  mirrorKeys(): string[] {
    return [...this.mirror.keys()];
  }

  // ===================== 异步写（写穿透） =====================
  /** 同步更新镜像 + 异步落盘 */
  set<T>(key: string, value: T): void {
    const text = safeStringify(value);
    if (!text) return;
    this.mirror.set(key, text);
    this.enqueue(key, text);
  }

  remove(key: string): void {
    this.mirror.delete(key);
    this.enqueue(key, null);
  }

  private enqueue(key: string, value: string | null): void {
    this.queue.set(key, value);
    void this.flush();
  }

  /**
   * 把队列里的变更一次性刷到介质；连续调用会被串行化。
   * 注意：即使队列当前为空也必须返回 `chain`，否则调用方 await 时
   * 会拿不到「上一批还在写」的结果（竞态：读到旧值 / 以为失败了）。
   */
  flush(): Promise<void> {
    if (this.queue.size > 0) {
      const batch = new Map(this.queue);
      this.queue.clear();

      const run = async (): Promise<void> => {
        const writes: Record<string, string> = {};
        const drops: string[] = [];
        for (const [k, v] of batch) {
          if (v === null) drops.push(k);
          else writes[k] = v;
        }
        try {
          if (Object.keys(writes).length) await this.doWrite(writes);
          if (drops.length) await this.doRemove(drops);
          this.lastError = null;
        } catch (e) {
          // 落盘失败：把变更放回队列等待下次重试，UI 仍可用（镜像已更新）
          for (const [k, v] of batch) this.queue.set(k, v);
          this.lastError = e instanceof Error ? e.message : String(e);
        }
      };

      this.chain = this.chain.then(run, run);
    }
    return this.chain;
  }

  // ===================== 批量接口（供迁移 / 导入） =====================
  async writeThrough(entries: Record<string, string>): Promise<void> {
    for (const [k, v] of Object.entries(entries)) this.mirror.set(k, v);
    try {
      await this.doWrite(entries);
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async drop(keys: string[]): Promise<void> {
    for (const k of keys) this.mirror.delete(k);
    try {
      await this.doRemove(keys);
      this.lastError = null;
    } catch (e) {
      this.lastError = e instanceof Error ? e.message : String(e);
      throw e;
    }
  }

  async readAll(): Promise<Record<string, string>> {
    return await this.doReadAll();
  }

  /** 导出镜像快照（供「从 localStorage 迁移到 SQLite」使用） */
  snapshot(): Record<string, string> {
    return Object.fromEntries(this.mirror);
  }

  /** 把外部快照灌入镜像（不落盘，配合 writeThrough 使用） */
  mergeSnapshot(snapshot: Record<string, string>): void {
    for (const [k, v] of Object.entries(snapshot)) this.mirror.set(k, v);
  }

  status(): PersistenceStatus {
    return {
      kind: this.kind,
      label: this.label,
      opened: this.opened,
      pending: this.queue.size,
      lastError: this.lastError,
    };
  }
}

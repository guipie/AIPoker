/**
 * 内存驱动：不落盘。
 * 用途：①单元测试里当替身（Test Double）；②隐私模式 / 存储全部不可用时的最后兜底，
 * 保证牌局本身永远能进行，只是关闭后不留痕迹。
 */
import { BasePersistence, type DriverKind } from "./BasePersistence";

export class MemoryPersistence extends BasePersistence {
  readonly kind: DriverKind = "memory";
  readonly label = "内存（临时）";

  private readonly store = new Map<string, string>();

  constructor(seed: Record<string, string> = {}) {
    super();
    for (const [k, v] of Object.entries(seed)) this.store.set(k, v);
  }

  protected async doOpen(): Promise<void> {
    /* 无需打开 */
  }
  protected async doReadAll(): Promise<Record<string, string>> {
    return Object.fromEntries(this.store);
  }
  protected async doWrite(entries: Record<string, string>): Promise<void> {
    for (const [k, v] of Object.entries(entries)) this.store.set(k, v);
  }
  protected async doRemove(keys: string[]): Promise<void> {
    for (const k of keys) this.store.delete(k);
  }
  protected async doClose(): Promise<void> {
    this.store.clear();
  }
}

/**
 * localStorage 驱动：浏览器环境（npm run dev 直连 vite）下的回退实现。
 * 桌面端跑 Tauri 时会优先用 SQLite，这里保证「同一个 App 在浏览器里也能完整运行」。
 */
import { BasePersistence, type DriverKind } from "./BasePersistence";

/** 本应用所有键的统一前缀，便于整库导出 / 清理 */
export const LS_PREFIX = "puke.";

export class LocalStoragePersistence extends BasePersistence {
  readonly kind: DriverKind = "localStorage";
  readonly label = "浏览器 localStorage（回退）";

  constructor(private readonly prefix: string = LS_PREFIX) {
    super();
  }

  private full(key: string): string {
    return key.startsWith(this.prefix) ? key : this.prefix + key;
  }

  protected async doOpen(): Promise<void> {
    if (typeof localStorage === "undefined") throw new Error("当前环境没有 localStorage");
  }

  protected async doReadAll(): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(this.prefix)) continue;
      const v = localStorage.getItem(k);
      if (v !== null) out[k] = v;
    }
    return out;
  }

  protected async doWrite(entries: Record<string, string>): Promise<void> {
    for (const [k, v] of Object.entries(entries)) localStorage.setItem(this.full(k), v);
  }

  protected async doRemove(keys: string[]): Promise<void> {
    for (const k of keys) localStorage.removeItem(this.full(k));
  }

  protected async doClose(): Promise<void> {
    /* localStorage 无需关闭 */
  }
}

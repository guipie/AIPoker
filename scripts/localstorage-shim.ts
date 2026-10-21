// node 环境下的 localStorage 垫片（store.ts / LocalStoragePersistence 模块初始化时就会用到）
const mem: Record<string, string> = {};
(globalThis as any).localStorage = {
  get length() {
    return Object.keys(mem).length;
  },
  key: (i: number) => Object.keys(mem)[i] ?? null,
  getItem: (k: string) => (k in mem ? mem[k] : null),
  setItem: (k: string, v: string) => {
    mem[k] = String(v);
  },
  removeItem: (k: string) => {
    delete mem[k];
  },
  clear: () => {
    for (const k of Object.keys(mem)) delete mem[k];
  },
};

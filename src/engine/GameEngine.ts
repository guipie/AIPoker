/**
 * 牌局引擎的公共基类。
 *
 * 为什么需要它：斗地主和德州规则完全不同，但有几件事是完全一样的——
 * 记录动作流水、统计动作数、给外部（UI / 大模型 / 复盘）提供最近动作。
 * 以前这部分在两个引擎里各写一遍，现在统一到基类，子类只关心自己的规则。
 *
 * 设计：
 * - 用**泛型**表达多态：`GameEngine<TState, TAction>`，两个引擎各自绑定自己的状态与动作类型，
 *   于是 `getState()` 的返回值是精确的（不是 `any`，也不是一个巨大的联合类型）。
 * - 用**模板方法**：`getState()` 由子类实现，基类只提供日志相关能力。
 */
export interface EngineAction {
  playerId: number;
  /** 动作类型：出牌 / 不出 / 弃牌…（各引擎自行扩展） */
  type: string;
}

export abstract class GameEngine<TState, TAction extends EngineAction = EngineAction> {
  /** 本局动作流水（按时间顺序，含“不出”这类非出牌动作） */
  protected readonly actions: TAction[] = [];

  /** 子类实现：导出当前局面快照（只读视图，不能反改引擎内部） */
  abstract getState(): TState;

  /** 累计动作数：不受「最近 N 条」截断影响，可用于判断某次调用是否真的改变了局面 */
  get actionCount(): number {
    return this.actions.length;
  }

  /** 最近 n 条动作（浅拷贝，避免外部改动内部数组） */
  recentActions(n = 8): TAction[] {
    return this.actions.slice(-n);
  }

  /** 全部动作（复盘用） */
  allActions(): readonly TAction[] {
    return this.actions;
  }

  protected record(action: TAction): void {
    this.actions.push(action);
  }

  protected resetActions(): void {
    this.actions.length = 0;
  }
}

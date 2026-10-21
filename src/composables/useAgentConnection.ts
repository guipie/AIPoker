/**
 * 牌桌上「各 agent 大模型连通性」的通用逻辑。
 *
 * 斗地主与德州两个牌桌原本各写了一份几乎逐行相同的实现
 * （体检 → 在线徽章 → 单体重检 → 运行时失败标记），
 * 现在抽成一个 composable：改一处，两个牌桌同时受益。
 *
 * 只负责「连不连得上」，不含任何牌局规则。
 */
import { ref, watch } from "vue";
import { agentById, store } from "../store";
import { checkAgents, type AgentConnResult } from "../utils/llmCheck";

/** 单个 agent 的连接状态（座位徽章用） */
export interface AgentConnState {
  ok: boolean;
  model: string;
  error?: string;
  checking?: boolean;
}

export function useAgentConnection() {
  /** 是否正在体检（开局前） */
  const checking = ref(false);
  /** 体检失败的 agent（会弹出遮罩，阻止开局） */
  const errors = ref<AgentConnResult[]>([]);
  /** agentId → 连接状态 */
  const online = ref<Record<string, AgentConnState>>({});
  /** 最近一次体检/开局的 agent 列表（失败遮罩里点「重试」用） */
  const lastIds = ref<string[]>([]);

  const modelOf = (id: string): string => agentById(id)?.model ?? store.settings.model;

  function applyOnline(res: AgentConnResult[]): void {
    const map: Record<string, AgentConnState> = {};
    for (const r of res) map[r.id] = { ok: r.ok, model: modelOf(r.id), error: r.error };
    online.value = map;
  }

  /** 清空全部状态（未启用大模型 / 关闭开关时调用） */
  function reset(): void {
    online.value = {};
    errors.value = [];
    checking.value = false;
  }

  /**
   * 开局前体检。
   * @returns true = 可以开局；false = 有 agent 连不上（errors 里带了原因）
   */
  async function checkBeforeStart(ids: string[]): Promise<boolean> {
    lastIds.value = ids;
    if (!store.settings.enabled) {
      reset(); // 未启用大模型：不做任何判断，也清掉上一次残留的错误遮罩
      return true;
    }
    checking.value = true;
    errors.value = [];
    const res = await checkAgents(ids);
    checking.value = false;
    const bad = res.filter((r) => !r.ok);
    if (bad.length) {
      errors.value = bad;
      return false;
    }
    applyOnline(res);
    return true;
  }

  /** 重新检测牌桌上所有 agent（不阻断牌局，仅更新徽章） */
  async function recheckAll(ids: string[]): Promise<void> {
    if (!store.settings.enabled || !ids.length) {
      online.value = {};
      return;
    }
    applyOnline(await checkAgents(ids));
  }

  /** 某个 agent 的模型配置被修改后，单独重检它 */
  async function recheckOne(id: string): Promise<void> {
    online.value = { ...online.value, [id]: { ok: false, model: modelOf(id), checking: true } };
    const res = await checkAgents([id]);
    const r = res[0];
    if (r) online.value = { ...online.value, [id]: { ok: r.ok, model: modelOf(id), error: r.error } };
  }

  /** 运行时调用大模型失败 → 标记为不在线，并显示服务端原因 */
  function markOffline(id: string, msg: string): void {
    online.value = { ...online.value, [id]: { ok: false, model: modelOf(id), error: msg } };
  }

  /** 调用成功 → 若之前被标记为不在线则恢复 */
  function markOnline(id: string): void {
    const prev = online.value[id];
    if (!prev || prev.ok) return;
    online.value = { ...online.value, [id]: { ok: true, model: modelOf(id) } };
  }

  /** 座位组件用的查询：agentId → 状态 */
  function connOf(agentId?: string): AgentConnState | undefined {
    return agentId ? online.value[agentId] : undefined;
  }

  // 关闭大模型开关后立刻清掉残留提示（keep-alive 会把旧状态带回来）
  watch(
    () => store.settings.enabled,
    (on) => {
      if (!on) reset();
    },
  );

  return {
    checking,
    errors,
    online,
    lastIds,
    checkBeforeStart,
    recheckAll,
    recheckOne,
    markOffline,
    markOnline,
    connOf,
    reset,
  };
}

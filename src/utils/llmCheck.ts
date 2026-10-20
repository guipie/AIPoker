// 大模型连通性检查：组装 agent 的 LLM 配置 + 批量并发检测。
// 供「设置保存校验」「开局前牌桌体检」两处复用。
import { agentById, store, type AgentDef } from "../store";
import { testLlmConnection, type LlmConfig } from "../engine/llm";

/** 组装某个 agent 使用的 LLM 配置：优先用 agent 自己的，其次回落到全局设置 */
export function configForAgent(a: AgentDef | undefined): LlmConfig {
  return {
    enabled: store.settings.enabled,
    baseUrl: a?.baseUrl ?? store.settings.baseUrl,
    apiKey: a?.apiKey ?? store.settings.apiKey,
    model: a?.model ?? store.settings.model,
    persona: a?.persona ?? store.settings.persona,
    temperature: store.settings.temperature,
  };
}

export function configForAgentId(id: string): LlmConfig {
  return configForAgent(agentById(id));
}

export interface AgentConnResult {
  id: string;
  name: string;
  ok: boolean;
  error: string;
}

/** 并发检测牌桌上所有 agent 与其大模型的连通性 */
export async function checkAgents(ids: string[]): Promise<AgentConnResult[]> {
  const unique = Array.from(new Set(ids));
  return Promise.all(
    unique.map(async (id) => {
      const a = agentById(id);
      const name = a?.name ?? id;
      const cfg = configForAgent(a);
      // 本地模型（Ollama 等）可能不需要 Key，因此不在此拦截，交由接口判断
      const r = await testLlmConnection(cfg);
      return { id, name, ok: r.ok, error: r.error };
    }),
  );
}

// LLM 决策客户端：调用 OpenAI 兼容接口（DeepSeek / OpenAI / Ollama 等）
// 大模型作为「牌桌大脑」给出行动建议；任何失败都回退到规则 AI（由调用方处理）。

export interface LlmConfig {
  enabled: boolean;
  baseUrl: string;
  model: string;
  apiKey: string;
  persona: string;
  temperature: number;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** 调用一次聊天补全，返回文本；失败/超时时抛错（调用方兜底） */
export async function callChat(config: LlmConfig, messages: ChatMessage[]): Promise<string> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
  try {
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        temperature: config.temperature,
        response_format: { type: "json_object" },
      }),
      signal: ctrl.signal,
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    const data = await resp.json();
    return data?.choices?.[0]?.message?.content ?? "";
  } finally {
    clearTimeout(timer);
  }
}

/** 从模型输出中解析 JSON（容错：截取第一个 {...}） */
export function parseJsonObject<T>(text: string): T | null {
  try {
    return JSON.parse(text) as T;
  } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        return JSON.parse(m[0]) as T;
      } catch {
        return null;
      }
    }
    return null;
  }
}

// ===================== 德州扑克：让 LLM 决策 =====================

export interface HoldemLlmInput {
  hole: string[]; // 如 ["♠A","♥K"]
  community: string[];
  pot: number;
  toCall: number;
  minRaise: number;
  stack: number;
  currentBet: number;
  players: { name: string; stack: number; folded: boolean; committed: number }[];
  position: string;
  persona?: string;
}

export interface HoldemLlmOutput {
  action: "fold" | "check" | "call" | "raise";
  raiseTo?: number;
  reason?: string;
}

export async function llmHoldemDecision(config: LlmConfig, input: HoldemLlmInput): Promise<HoldemLlmOutput | null> {
  const system = `你是一名德州扑克 AI 玩家${
    input.persona ? "，人设：" + input.persona : ""
  }。请根据牌局给出行动。只输出 JSON，格式：{"action":"fold"|"check"|"call"|"raise","raiseTo":<加注后本轮总投入整数，仅 raise 时>,"reason":"简短中文理由"}。注意底池赔率与手牌强度，避免无谓跟注。`;
  const user = `我的手牌：${input.hole.join(" ")}
公共牌：${input.community.length ? input.community.join(" ") : "（暂无）"}
底池：${input.pot}  需跟注：${input.toCall}  最小加注到：${input.currentBet + input.minRaise}  我的筹码：${input.stack}
座位（${input.position}）：
${input.players.map((p) => `- ${p.name} 筹码${p.stack} 已投入${p.committed}${p.folded ? " 已弃牌" : ""}`).join("\n")}
请决策。`;
  try {
    const text = await callChat(config, [
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    const out = parseJsonObject<HoldemLlmOutput>(text);
    if (out && ["fold", "check", "call", "raise"].includes(out.action)) return out;
    return null;
  } catch {
    return null;
  }
}

// ===================== 斗地主：让 LLM 决策 =====================

export interface DdzLlmInput {
  hand: string[];
  lastPlay: string[] | null;
  myRole: string;
  persona?: string;
}

export interface DdzLlmOutput {
  play: string[] | null; // 出这些牌；null 表示不出
  reason?: string;
}

export async function llmDdzDecision(config: LlmConfig, input: DdzLlmInput): Promise<DdzLlmOutput | null> {
  const system = `你是一名斗地主 AI 玩家${
    input.persona ? "，人设：" + input.persona : ""
  }。只输出 JSON：{"play":[出牌文本数组，如["♠3","♥3"]；或 null 表示不出],"reason":"简短中文理由"}。若上家出了牌，你出的牌必须能压过它（同牌型更大，或炸弹/王炸）；压不过就输出 null。`;
  const user = `我的手牌（${input.hand.length} 张）：${input.hand.join(" ")}
我的身份：${input.myRole}
${input.lastPlay ? "桌面需要压过的牌：" + input.lastPlay.join(" ") : "当前我可以自由出牌（领出）"}
请决策出哪几张牌，或不出。`;
  try {
    const text = await callChat(config, [
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    const out = parseJsonObject<DdzLlmOutput>(text);
    if (out && (out.play === null || Array.isArray(out.play))) return out;
    return null;
  } catch {
    return null;
  }
}

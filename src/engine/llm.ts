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
    if (!resp.ok) {
      // 带上服务端返回的 message（如“模型名不支持”），方便定位
      let detail = "";
      try {
        const d = await resp.json();
        detail = d?.error?.message ?? d?.message ?? "";
      } catch {
        /* ignore */
      }
      throw new Error(`HTTP ${resp.status}${detail ? "：" + detail : ""}`);
    }
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

// ===================== 连通性检测（验证 Key / 接口是否可用） =====================

export interface ConnTestResult {
  ok: boolean;
  error: string; // 失败原因（中文，可直接展示给用户）
}

function friendlyNetError(e: any): string {
  if (e?.name === "AbortError") return "连接超时（10 秒未响应）";
  const msg = String(e?.message ?? "");
  if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) {
    return "无法连接（接口地址错误、网络不通，或浏览器跨域限制）";
  }
  return `无法连接：${msg || "网络错误"}`;
}

/** 用一次极短对话验证（当服务不提供 /models 时回退到此方式） */
async function probeByChat(
  base: string,
  headers: Record<string, string>,
  model: string,
  signal: AbortSignal,
): Promise<ConnTestResult> {
  try {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model,
        messages: [{ role: "user", content: "ping" }],
        max_tokens: 1,
      }),
      signal,
    });
    if (r.ok) return { ok: true, error: "" };
    let detail = "";
    try {
      const d = await r.json();
      detail = d?.error?.message ?? d?.message ?? "";
    } catch {
      /* ignore */
    }
    if (r.status === 401 || r.status === 403) {
      return { ok: false, error: `API Key 无效或已失效（HTTP ${r.status}）${detail ? "：" + detail : ""}` };
    }
    if (r.status === 404) {
      return { ok: false, error: `模型「${model}」不存在或接口地址不对（HTTP 404）` };
    }
    return { ok: false, error: `接口返回 HTTP ${r.status}${detail ? "：" + detail : ""}` };
  } catch (e: any) {
    return { ok: false, error: friendlyNetError(e) };
  }
}

/**
 * 测试大模型接口连通性 / API Key 是否正确。
 * 优先探测 /models（开销小），不支持时回退到一次极短对话。
 */
/**
 * 校验配置的模型名是否在接口返回的模型列表中。
 * 返回错误信息（null 表示通过 / 列表为空无法判断）。
 * 说明：只判断 /models 是否 200 是不够的——那样模型名填错也会被判“在线”，
 * 真正调用时才报 invalid_request_error。
 */
export function modelNotInList(available: string[], model: string): string | null {
  const ids = available.filter(Boolean);
  if (!ids.length) return null; // 列表为空 → 不做判断
  const m = (model ?? "").trim();
  if (!m) return null;
  const hit = ids.some((id) => id.toLowerCase() === m.toLowerCase());
  if (hit) return null;
  const hint = ids.slice(0, 6).join("、") + (ids.length > 6 ? "…" : "");
  return `模型「${m}」不在该接口支持的模型列表中（可用：${hint}）`;
}

/** 解析 /models 的返回，取出模型 id 列表（兼容 {data:[{id}]} 与纯数组两种格式） */
async function parseModelIds(resp: Response): Promise<string[]> {
  try {
    const d = await resp.json();
    const arr = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];
    return arr.map((x: any) => (typeof x === "string" ? x : (x?.id ?? ""))).filter(Boolean);
  } catch {
    return [];
  }
}

export async function testLlmConnection(config: LlmConfig): Promise<ConnTestResult> {
  const base = config.baseUrl.replace(/\/$/, "");
  if (!base) return { ok: false, error: "未填写接口地址（Base URL）" };
  // 注意：本地 Ollama 等无需 Key，这里不强制要求 apiKey，交给接口返回结果判断。

  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (config.apiKey) headers.Authorization = `Bearer ${config.apiKey}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const r = await fetch(`${base}/models`, { method: "GET", headers, signal: ctrl.signal });
    if (r.ok) {
      // 关键：不仅看接口通不通，还要校验“这个模型名该服务是否真的支持”
      const ids = await parseModelIds(r);
      const bad = modelNotInList(ids, config.model);
      if (bad) return { ok: false, error: bad };
      if (ids.length) return { ok: true, error: "" };
      // 拿不到模型列表 → 用一次极短对话验证模型可用性
      return await probeByChat(base, headers, config.model, ctrl.signal);
    }
    let detail = "";
    try {
      const d = await r.json();
      detail = d?.error?.message ?? d?.message ?? "";
    } catch {
      /* ignore */
    }
    if (r.status === 401 || r.status === 403) {
      return { ok: false, error: `API Key 无效或无权访问（HTTP ${r.status}）${detail ? "：" + detail : ""}` };
    }
    if (r.status === 404) {
      // 该服务没有 /models 端点，改用极短对话验证
      return await probeByChat(base, headers, config.model, ctrl.signal);
    }
    return { ok: false, error: `接口返回 HTTP ${r.status}${detail ? "：" + detail : ""}` };
  } catch (e: any) {
    // /models 请求本身失败（网络/DNS/CORS），再用对话端点确认一次
    const chat = await probeByChat(base, headers, config.model, ctrl.signal);
    if (chat.ok) return chat;
    return { ok: false, error: friendlyNetError(e) };
  } finally {
    clearTimeout(timer);
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

export async function llmHoldemDecision(
  config: LlmConfig,
  input: HoldemLlmInput,
  onError?: (msg: string) => void,
): Promise<HoldemLlmOutput | null> {
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
  } catch (e: any) {
    onError?.(e?.message ?? String(e));
    return null;
  }
}

// ===================== 斗地主：让 LLM 决策 =====================

export interface DdzLlmInput {
  hand: string[];
  lastPlay: string[] | null; // 当前需要压过的牌（自由领出时为 null）
  lastPlayerName: string | null; // 这手牌是谁打出的
  freeLead: boolean; // 本轮是否由我领出
  myRole: string; // "地主" | "农民" | "未定"
  landlordName: string; // 地主是谁
  teammates: string[]; // 我的队友（地主时为空）
  opponents: string[]; // 我的对手
  seats: { name: string; role: string; handCount: number; relation: string }[]; // 按出牌顺序
  recentActions: string[]; // 最近各家出牌结果（按时间顺序，含“不出”）
  persona?: string;
}

export interface DdzLlmOutput {
  play: string[] | null; // 出这些牌；null 表示不出
  reason?: string;
}

export async function llmDdzDecision(
  config: LlmConfig,
  input: DdzLlmInput,
  onError?: (msg: string) => void,
): Promise<DdzLlmOutput | null> {
  // 身份策略提示：农民要配合队友，地主是独战
  let roleHint = "";
  if (input.myRole === "农民" && input.teammates.length) {
    roleHint = `你是农民，队友是：${input.teammates.join("、")}。要和队友配合打地主：地主出的牌尽量压住；队友出的牌一般不要压（除非你能一把走完，或需要给队友让路）。`;
  } else if (input.myRole === "地主") {
    roleHint = `你是地主，独战所有农民（${input.opponents.join("、")}），他们会联合针对你。控制节奏，用小牌消耗、留大牌和炸弹控场。`;
  }

  const system = `你是一名斗地主 AI 玩家${
    input.persona ? "，人设：" + input.persona : ""
  }。请只输出 JSON：{"play":[出牌文本数组，如["♠3","♥3"]；或 null 表示不出],"reason":"简短中文理由"}。
规则要点：
- 必须出合法牌型：单张/对子/三张/三带一/三带二/顺子(5张起)/连对/飞机/四带二/炸弹/王炸。
- 只能出自己手牌里有的牌，不要凭空捏造。
- 若不是自由领出，出的牌必须能压过桌面上那手牌（同牌型更大，或用炸弹/王炸）；压不过就输出 null（不出）。
- 结合各家剩余牌数判断：有人只剩 1-2 张时要优先封堵。
${roleHint}`;

  const user = `【牌桌信息】
- 地主：${input.landlordName}
- 我的身份：${input.myRole}
${input.teammates.length ? `- 我的队友：${input.teammates.join("、")}` : ""}
${input.opponents.length ? `- 我的对手：${input.opponents.join("、")}` : ""}

【各家情况】（按出牌顺序）
${input.seats
  .map(
    (p) =>
      `- ${p.name}（${p.role}${p.relation ? "，" + p.relation : ""}）剩 ${p.handCount} 张${
        p.handCount <= 2 ? " ⚠️快走完了" : ""
      }`,
  )
  .join("\n")}

【最近出牌结果】（按时间顺序，最新在最后）
${input.recentActions.length ? input.recentActions.map((a) => `- ${a}`).join("\n") : "- 本局还没有人出牌"}

【当前需要你处理的一手】
${
  input.freeLead
    ? "你是本轮首家，可以自由出任意合法牌型（不能不出）。"
    : `需要压过的牌：${(input.lastPlay ?? []).join(" ")}（由 ${input.lastPlayerName ?? "上家"} 打出）\n压不过就输出 null（不出）。`
}

【我的手牌】（${input.hand.length} 张）：${input.hand.join(" ")}
请决策。`;

  try {
    const text = await callChat(config, [
      { role: "system", content: system },
      { role: "user", content: user },
    ]);
    const out = parseJsonObject<DdzLlmOutput>(text);
    if (out && (out.play === null || Array.isArray(out.play))) return out;
    return null;
  } catch (e: any) {
    onError?.(e?.message ?? String(e));
    return null;
  }
}

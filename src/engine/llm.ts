// LLM 决策客户端：调用 OpenAI 兼容接口（DeepSeek / OpenAI / Ollama 等）
// 大模型作为「牌桌大脑」给出行动建议；任何失败都回退到规则 AI（由调用方处理）。

import { doudizuRules, qiangDoudizuRules } from "../utils/prompts";

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

// ===================== 底层调用：流式优先、不设超时 =====================
//
// 为什么不再超时：思考型模型（R1 / QwQ / o1 等）一步棋想一两分钟很正常，
// 原来的 20s 超时会把「慢」误判成「离线」。这里改成一直等，并把模型吐出来的
// reasoning_content 流式喂给 UI，让人看得见它还在想什么。

/** 流式回调：思考增量 / 正文增量 / 换策略前清空 */
export interface LlmStreamHooks {
  /** 思考模型的推理增量（delta.reasoning_content / delta.reasoning） */
  onThinking?: (chunk: string) => void;
  /** 正式回答的增量（delta.content） */
  onContent?: (chunk: string) => void;
  /** 降级换一种请求策略前调用，用于清掉已累积的半截文本 */
  onRestart?: () => void;
}

/** 调用参数：`onError` 兼容旧的「直接传一个函数」写法 */
export interface LlmCallOptions {
  onError?: (msg: string) => void;
  hooks?: LlmStreamHooks;
  /** 需要主动中断时传入（如重开牌局）。注意：**没有超时**，思考多久都等 */
  signal?: AbortSignal;
}

export type LlmCallArg = LlmCallOptions | ((msg: string) => void);

function asOptions(arg?: LlmCallArg): LlmCallOptions {
  if (!arg) return {};
  return typeof arg === "function" ? { onError: arg } : arg;
}

interface RequestStrategy {
  stream: boolean;
  json: boolean;
}

/**
 * 请求策略逐级降级：
 * 1. 流式 + JSON 模式（首选，能边想边显示）
 * 2. 流式 + 纯文本（思考型模型普遍不支持 response_format=json_object）
 * 3. 非流式 + JSON（老网关不支持 stream）
 * 4. 非流式 + 纯文本（最保守，什么服务都能跑）
 */
const STRATEGIES: RequestStrategy[] = [
  { stream: true, json: true },
  { stream: true, json: false },
  { stream: false, json: true },
  { stream: false, json: false },
];

function headersOf(config: LlmConfig): Record<string, string> {
  return {
    "Content-Type": "application/json",
    ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}),
  };
}

function bodyOf(config: LlmConfig, messages: ChatMessage[], s: RequestStrategy): string {
  return JSON.stringify({
    model: config.model,
    messages,
    temperature: config.temperature,
    ...(s.stream ? { stream: true } : {}),
    ...(s.json ? { response_format: { type: "json_object" } } : {}),
  });
}

/** 从一次性响应里取出正文（兼容 content 为字符串或分段数组） */
function extractText(data: any): string {
  const c = data?.choices?.[0]?.message?.content;
  if (typeof c === "string") return c;
  if (Array.isArray(c)) return c.map((p: any) => (typeof p === "string" ? p : (p?.text ?? ""))).join("");
  return "";
}

/** 读一条 SSE / NDJSON 流，边读边把思考与正文推给回调 */
async function readStream(
  body: ReadableStream<Uint8Array>,
  hooks?: LlmStreamHooks,
): Promise<string> {
  const reader = body.getReader();
  const dec = new TextDecoder("utf-8");
  let buf = "";
  let content = "";
  /** 处理一行；返回该行里的正文增量 */
  const handleLine = (raw: string): string => {
    let line = raw.trim();
    if (!line) return "";
    if (line.startsWith("data:")) line = line.slice(5).trim();
    if (!line || line === "[DONE]") return "";
    let chunk: any;
    try {
      chunk = JSON.parse(line);
    } catch {
      return ""; // SSE 注释行 / 心跳等
    }
    const choice = chunk?.choices?.[0] ?? {};
    const delta = choice.delta ?? {};
    const think =
      typeof delta.reasoning_content === "string"
        ? delta.reasoning_content
        : typeof delta.reasoning === "string"
          ? delta.reasoning
          : "";
    if (think) hooks?.onThinking?.(think);
    const text =
      typeof delta.content === "string"
        ? delta.content
        : // 少数实现不带 delta，直接把整段放在 message 里
          (typeof choice.message?.content === "string" ? choice.message.content : "");
    if (text) hooks?.onContent?.(text);
    return text;
  };
  const drain = () => {
    let nl = buf.indexOf("\n");
    while (nl >= 0) {
      const line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      content += handleLine(line);
      nl = buf.indexOf("\n");
    }
  };
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    drain();
  }
  // 最后一行可能没有换行符（如 `data: {...}` 直接收尾）：不冲掉就会丢掉结尾那段 JSON
  buf += dec.decode();
  content += handleLine(buf);
  return content;
}

/** 按某种策略发一次请求 */
async function requestOnce(
  config: LlmConfig,
  messages: ChatMessage[],
  s: RequestStrategy,
  hooks?: LlmStreamHooks,
  signal?: AbortSignal,
): Promise<string> {
  const url = `${config.baseUrl.replace(/\/$/, "")}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: headersOf(config),
    body: bodyOf(config, messages, s),
    signal,
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
  const ct = (resp.headers.get("content-type") ?? "").toLowerCase();
  const looksStream =
    ct.includes("text/event-stream") || ct.includes("application/x-ndjson") || ct.includes("stream");
  if (!s.stream || !resp.body || !looksStream) {
    // 服务端忽略了 stream 参数（直接返回一整包 JSON）→ 按普通响应处理
    const data = await resp.json().catch(() => null);
    const text = extractText(data);
    if (!text) throw new Error("返回内容为空");
    hooks?.onContent?.(text);
    return text;
  }
  return await readStream(resp.body, hooks);
}

/**
 * 调用一次聊天补全，返回完整文本。
 * 流式优先；接口不支持时自动降级，绝不因为「想得久」而判失败。
 */
export async function callChat(
  config: LlmConfig,
  messages: ChatMessage[],
  hooks?: LlmStreamHooks,
  signal?: AbortSignal,
): Promise<string> {
  let lastErr: Error | null = null;
  for (let i = 0; i < STRATEGIES.length; i++) {
    try {
      if (i > 0) hooks?.onRestart?.();
      const text = await requestOnce(config, messages, STRATEGIES[i], hooks, signal);
      if (text && text.trim()) return text;
      lastErr = new Error("返回内容为空");
    } catch (e: any) {
      if (e?.name === "AbortError") throw e; // 主动取消：不再换策略重试
      lastErr = e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr ?? new Error("调用失败");
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
  signal: AbortSignal
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
      return {
        ok: false,
        error: `API Key 无效或已失效（HTTP ${r.status}）${detail ? "：" + detail : ""}`,
      };
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
  const hit = ids.some(id => id.toLowerCase() === m.toLowerCase());
  if (hit) return null;
  const hint = ids.slice(0, 6).join("、") + (ids.length > 6 ? "…" : "");
  return `模型「${m}」不在该接口支持的模型列表中（可用：${hint}）`;
}

/** 解析 /models 的返回，取出模型 id 列表（兼容 {data:[{id}]} 与纯数组两种格式） */
async function parseModelIds(resp: Response): Promise<string[]> {
  try {
    const d = await resp.json();
    const arr = Array.isArray(d?.data) ? d.data : Array.isArray(d) ? d : [];
    return arr.map((x: any) => (typeof x === "string" ? x : x?.id ?? "")).filter(Boolean);
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
      return {
        ok: false,
        error: `API Key 无效或无权访问（HTTP ${r.status}）${detail ? "：" + detail : ""}`,
      };
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
  arg?: LlmCallArg
): Promise<HoldemLlmOutput | null> {
  const { onError, hooks, signal } = asOptions(arg);
  const system = `你是一名德州扑克 AI 玩家${
    input.persona ? "，人设：" + input.persona : ""
  }。请根据牌局给出行动。只输出 JSON，格式：{"action":"fold"|"check"|"call"|"raise","raiseTo":<加注后本轮总投入整数，仅 raise 时>,"reason":"简短中文理由"}。注意底池赔率与手牌强度，避免无谓跟注。`;
  const user = `我的手牌：${input.hole.join(" ")}
公共牌：${input.community.length ? input.community.join(" ") : "（暂无）"}
底池：${input.pot}  需跟注：${input.toCall}  最小加注到：${
    input.currentBet + input.minRaise
  }  我的筹码：${input.stack}
座位（${input.position}）：
${input.players
  .map(p => `- ${p.name} 筹码${p.stack} 已投入${p.committed}${p.folded ? " 已弃牌" : ""}`)
  .join("\n")}
请决策。`;
  try {
    const text = await callChat(
      config,
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      hooks,
      signal
    );
    const out = parseJsonObject<HoldemLlmOutput>(text);
    if (out && ["fold", "check", "call", "raise"].includes(out.action)) return out;
    return null;
  } catch (e: any) {
    // 主动中断（换局 / 离开牌桌）不是失败：原样抛给调用方，不在这里报告离线
    if (e?.name === "AbortError") throw e;
    onError?.(e?.message ?? String(e));
    return null;
  }
}

// ===================== 斗地主：让 LLM 决策 =====================
// 提示词统一由 src/utils/prompts.ts 生成（用户自己打磨的规则版 prompt），
// 这里只负责：拼人设 / 补充局势 → 调接口 → 解析 JSON。

export interface DdzBidInput {
  num: 3 | 4; // 玩家人数
  myHand: string[]; // 我的手牌（如 ["大王","♠2","♥A"]）
  prePersons: Array<{ id: string; action: "snatch" | "pass"; snatchScore?: number }>; // 前面玩家的抢地主记录
  persona?: string;
}

export interface DdzBidOutput {
  action: "snatch" | "pass";
  snatchScore: number | null;
  reason?: string;
}

/** 抢地主决策（对应 prompts.ts 的 qiangDoudizuRules） */
export async function llmDdzBid(
  config: LlmConfig,
  input: DdzBidInput,
  arg?: LlmCallArg
): Promise<DdzBidOutput | null> {
  const { onError, hooks, signal } = asOptions(arg);
  const system = `你是一名斗地主 AI 玩家${
    input.persona ? "，人设：" + input.persona : ""
  }。严格遵守【输出约定】：只输出原始 JSON，不要 markdown、不要解释文字、不要多余换行。`;
  const user = qiangDoudizuRules(input.num, input.prePersons, input.myHand);
  try {
    const text = await callChat(
      config,
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      hooks,
      signal
    );
    const out = parseJsonObject<{ action?: string; snatchScore?: number | null; reason?: string }>(
      text
    );
    if (!out) return null;
    if (out.action === "pass") return { action: "pass", snatchScore: null, reason: out.reason };
    if (out.action === "snatch") {
      const raw = Number(out.snatchScore);
      // 抢分归一化到 1~3；模型给了奇怪值就用 1 分
      const score = Number.isFinite(raw) && raw >= 1 ? Math.min(3, Math.round(raw)) : 1;
      return { action: "snatch", snatchScore: score, reason: out.reason };
    }
    return null;
  } catch (e: any) {
    // 主动中断（换局 / 离开牌桌）不是失败：原样抛给调用方，不在这里报告离线
    if (e?.name === "AbortError") throw e;
    onError?.(e?.message ?? String(e));
    return null;
  }
}

/**
 * 给大模型的一个「合法候选动作」。
 * 引擎已枚举好所有能出的牌，模型只需做选择题，不必自己构造牌面——
 * 这是修复「大模型老出非法牌 / 出最烂的牌」的关键。
 */
export interface LlmCandidate {
  /** 编号，1 起；0 固定代表「不出」 */
  index: number;
  typeName: string;
  cards: string[];
  handLeft: number;
  isBomb: boolean;
}

export interface DdzLlmInput {
  num: 3 | 4;
  myId: string; // 我的名字（prompt 内用于标识身份）
  landlordId: string; // 地主名字
  farmerIds: string[]; // 农民名字列表（含我自己，如果我是农民）
  hand: string[]; // 我的手牌
  lastPlay: string[] | null; // 需要压过的牌（首出为 null）
  playedCards: string[]; // 全局已经打出的所有牌（记牌）
  seats?: { name: string; role: string; handCount: number; relation?: string; isMe?: boolean }[];
  recentActions?: string[]; // 最近各家出牌结果（按时间顺序）
  persona?: string;
  /** 引擎枚举出的合法候选；给了就启用「编号选择题」模式 */
  candidates?: LlmCandidate[];
  /** 剩余关键牌统计（帮模型算牌，避免它自己数） */
  cardCountHint?: string;
}

export interface DdzLlmOutput {
  play: string[] | null; // 出这些牌；null 表示不出
  /** 模型选择的候选编号（优先于 play）；0 = 不出 */
  choice?: number;
  reason?: string;
}

/** 出牌决策（对应 prompts.ts 的 doudizuRules） */
export async function llmDdzDecision(
  config: LlmConfig,
  input: DdzLlmInput,
  arg?: LlmCallArg
): Promise<DdzLlmOutput | null> {
  const { onError, hooks, signal } = asOptions(arg);
  // 局势补充信息放在 system 里，保证 user 段落是 prompts.ts 原样输出
  const extra: string[] = [];
  if (input.seats && input.seats.length) {
    extra.push(
      "【各家剩余手牌】（按出牌顺序）\n" +
        input.seats
          .map(
            p =>
              `- ${p.name}（${p.role}${p.relation ? "，" + p.relation : ""}）剩 ${p.handCount} 张${
                p.handCount <= 2 ? " ⚠️快走完了，优先封堵" : ""
              }`
          )
          .join("\n")
    );
  }
  if (input.cardCountHint) extra.push(input.cardCountHint);
  if (input.recentActions && input.recentActions.length) {
    extra.push(
      "【最近出牌记录】（最新在最后）\n" + input.recentActions.map(a => `- ${a}`).join("\n")
    );
  }

  const system = `你是一名斗地主 AI 玩家${
    input.persona ? "，人设：" + input.persona : ""
  }。严格遵守【输出约定】：只输出原始 JSON，不要 markdown、不要解释文字、不要多余换行。${
    extra.length ? "\n\n" + extra.join("\n\n") : ""
  }`;

  const user =
    doudizuRules(
      input.num,
      input.landlordId,
      input.myId,
      input.farmerIds,
      input.hand,
      input.lastPlay,
      input.playedCards
    ) + buildCandidateSection(input);

  try {
    const text = await callChat(
      config,
      [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      hooks,
      signal
    );
    const out = parseJsonObject<{ play?: string[] | null; choice?: number; reason?: string }>(text);
    if (!out) return null;
    // 编号选择题优先：模型给的牌面经常拼错，编号不会
    if (Number.isInteger(out.choice)) {
      return { play: null, choice: out.choice as number, reason: out.reason };
    }
    if (out.play === null || Array.isArray(out.play)) {
      return { play: out.play ?? null, reason: out.reason };
    }
    return null;
  } catch (e: any) {
    // 主动中断（换局 / 离开牌桌）不是失败：原样抛给调用方，不在这里报告离线
    if (e?.name === "AbortError") throw e;
    onError?.(e?.message ?? String(e));
    return null;
  }
}

/**
 * 拼「本回合可选动作」段落，追加在用户自研 prompt 之后。
 * 引擎已经枚举出全部合法候选，模型只需挑一个编号——把「算牌/枚举/拼写」
 * 这些大模型不擅长的事全部收回到引擎侧。
 */
function buildCandidateSection(input: DdzLlmInput): string {
  if (!input.candidates || input.candidates.length === 0) return "";
  const canPass = !!input.lastPlay; // 自由领出时不能不出
  const lines = input.candidates
    .map(
      c =>
        `${c.index}. 【${c.typeName}】${c.cards.join(" ")} → 出完剩 ${c.handLeft} 张${
          c.isBomb ? "（炸弹/王炸，慎用）" : ""
        }`
    )
    .join("\n");

  return `\n\n===本回合可选动作（已经替你枚举好，必须且只能从中选一个，禁止自己组合新牌）===
${canPass ? "0. 【不出】放弃本轮，让下家接手" : "（本轮由你首发，必须出牌，不能不出）"}
${lines}

===输出格式（本节覆盖前面的输出约定）===
只输出一行 JSON：{"choice":编号,"reason":"一句话中文理由"}
${canPass ? `不出则 {"choice":0,"reason":"..."}；` : ""}出第 N 个则 {"choice":N,"reason":"..."}
要求：choice 必须是上面列出的编号；不要再输出 play 字段的牌面数组。`;
}

// 程序化音效（Web Audio API），无需任何外部音频文件。
// 浏览器要求音频在用户手势后才能播放，因此首次交互时自动 resume。

let ctx: AudioContext | null = null;
let master: GainNode | null = null;
let enabled = true;

function ensure(): AudioContext | null {
  if (typeof window === "undefined") return null;
  if (!ctx) {
    const AC = window.AudioContext || (window as any).webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.5;
    master.connect(ctx.destination);
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function setSoundEnabled(v: boolean) {
  enabled = v;
  if (!v) stopSpeaking();
}
export function isSoundEnabled() {
  return enabled;
}

// ===== 语音播报（中文）=====
// 真牌桌上人喊的是「对二」「炸弹」「不要」，所以牌名优先用系统中文语音念出来；
// 没有中文语音（或 WebView 不支持）时自动退回下面的牌型音型，保证一直有反馈。

let voiceCache: SpeechSynthesisVoice | null | undefined; // undefined = 还没找到过

function synth(): SpeechSynthesis | null {
  if (typeof window === "undefined") return null;
  const s = (window as any).speechSynthesis as SpeechSynthesis | undefined;
  return s && typeof s.speak === "function" ? s : null;
}

function chineseVoice(): SpeechSynthesisVoice | null {
  const s = synth();
  if (!s) return null;
  if (voiceCache) return voiceCache;
  const list = s.getVoices?.() ?? [];
  if (!list.length) return null; // 语音列表是异步加载的，下次再试
  voiceCache =
    list.find(v => /^zh/i.test(v.lang)) ??
    list.find(v => /chinese|中文|普通话|huihui|yaoyao|kangkang|xiaoxiao|yunxi/i.test(v.name)) ??
    null;
  return voiceCache;
}

// 语音列表加载完成后重置缓存，避免第一次拿空就一直认为“没有中文语音”
if (typeof window !== "undefined" && (window as any).speechSynthesis) {
  (window as any).speechSynthesis.onvoiceschanged = () => {
    voiceCache = undefined;
  };
}

/** 当前环境能否用中文语音播报 */
export function canSpeak(): boolean {
  return !!chineseVoice();
}

/** 念一句话；返回是否真的念出来了 */
export function speak(text: string): boolean {
  if (!enabled || !text) return false;
  const s = synth();
  if (!s) return false;
  const v = chineseVoice();
  if (!v) return false;
  try {
    const u = new SpeechSynthesisUtterance(text);
    u.voice = v;
    u.lang = v.lang || "zh-CN";
    u.rate = 1.15;
    u.pitch = 1.05;
    u.volume = 0.95;
    s.cancel(); // 连打时别排队积压，直接说最新这一手
    s.speak(u);
    return true;
  } catch {
    return false;
  }
}

function stopSpeaking() {
  try {
    synth()?.cancel();
  } catch {
    /* ignore */
  }
}

function tone(freq: number, start: number, dur: number, type: OscillatorType, gain = 0.3) {
  const c = ensure();
  if (!c || !master) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  osc.frequency.value = freq;
  const t0 = c.currentTime + start;
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

function noise(start: number, dur: number, gain = 0.3, filterFreq = 2000) {
  const c = ensure();
  if (!c || !master) return;
  const len = Math.floor(c.sampleRate * dur);
  const buf = c.createBuffer(1, len, c.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
  const src = c.createBufferSource();
  src.buffer = buf;
  const filter = c.createBiquadFilter();
  filter.type = "highpass";
  filter.frequency.value = filterFreq;
  const g = c.createGain();
  g.gain.value = gain;
  src.connect(filter);
  filter.connect(g);
  g.connect(master);
  src.start(c.currentTime + start);
}

/** 扫频（上/下滑音），做「飞机」「炸弹」这类有方向感的音型 */
function sweep(
  from: number,
  to: number,
  start: number,
  dur: number,
  type: OscillatorType,
  gain = 0.3,
) {
  const c = ensure();
  if (!c || !master) return;
  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = type;
  const t0 = c.currentTime + start;
  osc.frequency.setValueAtTime(Math.max(20, from), t0);
  osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(gain, t0 + 0.02);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(master);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** 斗地主的牌型音型分类（与引擎 PatternType 对应，多一个 pass/bid） */
export type DdzSoundKind =
  | "single"
  | "pair"
  | "triple"
  | "triple_single"
  | "triple_pair"
  | "straight"
  | "pair_straight"
  | "airplane"
  | "airplane_single"
  | "airplane_pair"
  | "four_two_single"
  | "four_two_pair"
  | "bomb"
  | "rocket"
  | "pass"
  | "bid";

/** 各牌型的音型：闭眼听也能分出单张 / 对子 / 顺子 / 炸弹 / 不要 */
function patternSound(kind: DdzSoundKind, vol = 1) {
  const v = (x: number) => Math.max(0.02, x * vol);
  switch (kind) {
    case "single":
      tone(920, 0, 0.07, "triangle", v(0.22));
      break;
    case "pair":
      tone(700, 0, 0.06, "triangle", v(0.2));
      tone(980, 0.07, 0.06, "triangle", v(0.2));
      break;
    case "triple":
      [640, 820, 1020].forEach((f, i) => tone(f, i * 0.06, 0.06, "triangle", v(0.2)));
      break;
    case "triple_single":
      [640, 820, 1020].forEach((f, i) => tone(f, i * 0.06, 0.06, "triangle", v(0.2)));
      tone(1240, 0.2, 0.05, "sine", v(0.14));
      break;
    case "triple_pair":
      [640, 820, 1020].forEach((f, i) => tone(f, i * 0.06, 0.06, "triangle", v(0.2)));
      tone(1240, 0.2, 0.05, "sine", v(0.16));
      tone(1240, 0.26, 0.05, "sine", v(0.14));
      break;
    case "straight":
      [523, 587, 659, 784, 880].forEach((f, i) => tone(f, i * 0.05, 0.07, "sine", v(0.18)));
      break;
    case "pair_straight":
      [523, 659, 784, 988].forEach((f, i) => {
        tone(f, i * 0.08, 0.05, "sine", v(0.15));
        tone(f, i * 0.08 + 0.03, 0.05, "sine", v(0.12));
      });
      break;
    case "airplane":
    case "airplane_single":
    case "airplane_pair":
      sweep(420, 980, 0, 0.28, "sine", v(0.22));
      tone(1040, 0.3, 0.06, "sine", v(0.16));
      break;
    case "four_two_single":
    case "four_two_pair":
      tone(300, 0, 0.12, "square", v(0.18));
      tone(900, 0.1, 0.06, "triangle", v(0.18));
      break;
    case "bomb":
      // 低频轰 + 噪声爆点：和普通出牌拉开明显差距
      sweep(180, 45, 0, 0.45, "sawtooth", v(0.5));
      noise(0, 0.3, v(0.4), 700);
      tone(60, 0, 0.5, "sine", v(0.5));
      break;
    case "rocket":
      noise(0, 0.36, v(0.45), 600);
      sweep(120, 1400, 0, 0.5, "sawtooth", v(0.42));
      sweep(70, 40, 0.05, 0.6, "sine", v(0.5));
      break;
    case "pass":
      // 两声下行，像摆手说“不要”
      tone(430, 0, 0.1, "sine", v(0.2));
      tone(280, 0.1, 0.16, "sine", v(0.18));
      break;
    case "bid":
      tone(1180, 0, 0.05, "triangle", v(0.18));
      tone(1560, 0.06, 0.05, "triangle", v(0.16));
      break;
  }
}

export const sfx = {
  click() {
    if (!enabled) return;
    tone(660, 0, 0.06, "sine", 0.18);
  },
  deal() {
    if (!enabled) return;
    noise(0, 0.12, 0.22, 1500);
    tone(220, 0, 0.08, "square", 0.08);
  },
  play() {
    if (!enabled) return;
    noise(0, 0.14, 0.35, 1200);
  },
  chip() {
    if (!enabled) return;
    tone(1280, 0, 0.05, "triangle", 0.2);
    tone(1640, 0.05, 0.05, "triangle", 0.18);
  },
  check() {
    if (!enabled) return;
    tone(420, 0, 0.1, "sine", 0.2);
  },
  fold() {
    if (!enabled) return;
    tone(300, 0, 0.18, "sawtooth", 0.2);
    tone(200, 0.08, 0.2, "sawtooth", 0.18);
  },
  win() {
    if (!enabled) return;
    const notes = [523, 659, 784, 1047];
    notes.forEach((n, i) => tone(n, i * 0.12, 0.22, "triangle", 0.28));
  },
  lose() {
    if (!enabled) return;
    const notes = [440, 370, 294];
    notes.forEach((n, i) => tone(n, i * 0.16, 0.3, "sawtooth", 0.22));
  },
  bet() {
    if (!enabled) return;
    tone(900, 0, 0.05, "square", 0.15);
    tone(1300, 0.04, 0.05, "square", 0.13);
  },
  /** 斗地主：念牌名（对二 / 炸弹 / 不要）+ 对应牌型音型 */
  playDdz(label: string, kind: DdzSoundKind) {
    if (!enabled) return;
    const spoken = speak(label);
    // 有语音时把音型压低，别盖住人声；没语音时音型就是唯一反馈
    patternSound(kind, spoken ? 0.55 : 1);
  },
  /** 只念一句（叫分等）；没有中文语音时退回一声轻音 */
  say(text: string) {
    if (!enabled) return;
    if (!speak(text)) tone(760, 0, 0.07, "triangle", 0.16);
  },
};

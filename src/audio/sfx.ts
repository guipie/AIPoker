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
}
export function isSoundEnabled() {
  return enabled;
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
};

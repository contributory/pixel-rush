/* Hệ thống âm thanh: nhạc nền + hiệu ứng tổng hợp WebAudio. */

const LOCAL_SRC = "/music/pixel-rush.mp3";
const REMOTE_SRC =
  "https://s3.us-east-005.backblazeb2.com/bosuutap/music/Pixel%20Rush.mp3?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Content-Sha256=UNSIGNED-PAYLOAD&X-Amz-Credential=0055373d2f421cb0000000004%2F20260816%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20260816T113422Z&X-Amz-Expires=604800&X-Amz-Signature=0b7be1365c7f154e23a8eefd444c6bda99d173d740908e293dd0af131aefc4b7&X-Amz-SignedHeaders=host&x-amz-checksum-mode=ENABLED&x-id=GetObject";

export type BgmSource = "local" | "remote" | "synth" | "none";

class AudioSys {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bgm: HTMLAudioElement | null = null;
  private bgmStarting = false;
  private synthTimer: number | null = null;
  private synthStep = 0;
  private lastShot = 0;
  muted = false;
  bgmSource: BgmSource = "none";
  onBgmState: ((playing: boolean, source: BgmSource) => void) | null = null;

  constructor() {
    try {
      this.muted = localStorage.getItem("pixelrush-muted") === "1";
    } catch {
      this.muted = false;
    }
  }

  /* ---------- nhạc nền ---------- */

  init() {
    if (this.bgm || this.bgmStarting || this.synthTimer !== null) return;
    this.startBgm();
    const wake = () => this.resume();
    window.addEventListener("pointerdown", wake);
    window.addEventListener("keydown", wake);
  }

  private emit() {
    const playing =
      (this.bgm !== null && !this.bgm.paused) || this.synthTimer !== null;
    this.onBgmState?.(playing, this.bgmSource);
  }

  private startBgm() {
    this.bgmStarting = true;
    const el = new Audio();
    el.loop = true;
    el.preload = "auto";
    el.volume = this.muted ? 0 : 0.5;
    let stage = 0; // 0 = file nội bộ, 1 = tải blob từ nguồn
    let settled = false;

    const finish = (src: BgmSource) => {
      settled = true;
      this.bgmStarting = false;
      this.bgm = el;
      this.bgmSource = src;
      el.addEventListener("play", () => this.emit());
      el.addEventListener("pause", () => this.emit());
      this.emit();
    };

    const fallbackSynth = () => {
      if (settled) return;
      settled = true;
      this.bgmStarting = false;
      this.startSynth();
    };

    const tryPlay = () => {
      const attempt = stage;
      el.play()
        .then(() => finish(attempt === 0 ? "local" : "remote"))
        .catch((e: unknown) => {
          const name = e instanceof DOMException ? e.name : "";
          if (name === "NotAllowedError") {
            // Trình duyệt chặn autoplay — giữ nguồn, phát khi có tương tác đầu tiên.
            finish(attempt === 0 ? "local" : "remote");
          } else if (!settled && attempt === stage) {
            next();
          }
        });
    };

    const next = () => {
      if (settled) return;
      if (stage === 0) {
        stage = 1;
        el.onerror = fallbackSynth;
        el.src = REMOTE_SRC;
        el.load();
        tryPlay();
      } else {
        fallbackSynth();
      }
    };

    el.onerror = next;
    el.src = LOCAL_SRC;
    tryPlay();
  }

  resume() {
    if (this.ctx && this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    if (this.bgm && this.bgmSource !== "synth" && this.bgm.paused) {
      this.bgm.play().catch(() => {});
    }
    if (this.bgmSource === "synth" && this.synthTimer === null) this.startSynth();
  }

  /** Nhạc nền dự phòng: vòng chiptune tổng hợp nếu không có file MP3. */
  private startSynth() {
    const ctx = this.ensure();
    if (!ctx || this.synthTimer !== null) return;
    this.bgmSource = "synth";
    const bass = [110, 110, 130.8, 110, 164.8, 110, 98, 110, 110, 110, 130.8, 110, 174.6, 164.8, 146.8, 130.8];
    const arp = [440, 523.3, 659.3, 880, 659.3, 523.3, 440, 329.6];
    this.synthStep = 0;
    this.synthTimer = window.setInterval(() => {
      if (this.muted) return;
      const i = this.synthStep++;
      const t = ctx.currentTime;
      this.note(bass[i % 16], t, 0.13, "square", 0.16);
      if (i % 2 === 0) this.note(arp[(i / 2) % 8], t + 0.01, 0.09, "triangle", 0.1);
      if (i % 4 === 2) this.noiseHit(0.05, 0.08, 6000, t);
      if (i % 16 === 0) this.note(1567.98, t + 0.02, 0.3, "sawtooth", 0.05);
    }, 138);
    this.emit();
  }

  setMuted(m: boolean) {
    this.muted = m;
    try {
      localStorage.setItem("pixelrush-muted", m ? "1" : "0");
    } catch {
      /* ignore */
    }
    if (this.master) this.master.gain.value = m ? 0 : 0.55;
    if (this.bgm) this.bgm.volume = m ? 0 : 0.5;
    this.emit();
  }

  /* ---------- hiệu ứng ---------- */

  private ensure(): AudioContext | null {
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  private note(f: number, t: number, d: number, type: OscillatorType, v: number, f2?: number) {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(f, t);
    if (f2) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), t + d);
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(this.master);
    o.start(t);
    o.stop(t + d + 0.02);
  }

  private noiseHit(d: number, v: number, freq: number, at?: number) {
    const ctx = this.ensure();
    if (!ctx || !this.master || this.muted) return;
    const t = at ?? ctx.currentTime;
    const len = Math.max(1, Math.floor(ctx.sampleRate * d));
    const buf = ctx.createBuffer(1, len, ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = ctx.createBufferSource();
    src.buffer = buf;
    const flt = ctx.createBiquadFilter();
    flt.type = "lowpass";
    flt.frequency.value = freq;
    const g = ctx.createGain();
    g.gain.setValueAtTime(v, t);
    g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    src.connect(flt).connect(g).connect(this.master);
    src.start(t);
  }

  shoot() {
    const now = performance.now();
    if (now - this.lastShot < 42) return;
    this.lastShot = now;
    const ctx = this.ensure();
    if (!ctx) return;
    this.note(960, ctx.currentTime, 0.07, "square", 0.1, 460);
  }
  eshoot() {
    const ctx = this.ensure();
    if (!ctx) return;
    this.note(300, ctx.currentTime, 0.09, "sawtooth", 0.07, 170);
  }
  hit() {
    const ctx = this.ensure();
    if (!ctx) return;
    this.note(230, ctx.currentTime, 0.08, "square", 0.16, 90);
  }
  boom(size = 1) {
    const ctx = this.ensure();
    if (!ctx) return;
    this.noiseHit(0.35 + 0.3 * size, 0.4, 750);
    this.note(150, ctx.currentTime, 0.4 + 0.15 * size, "sine", 0.4 * size, 38);
  }
  power() {
    const ctx = this.ensure();
    if (!ctx) return;
    this.note(520, ctx.currentTime, 0.09, "triangle", 0.22);
    this.note(784, ctx.currentTime + 0.08, 0.1, "triangle", 0.22);
    this.note(1046, ctx.currentTime + 0.16, 0.14, "triangle", 0.22);
  }
  bomb() {
    const ctx = this.ensure();
    if (!ctx) return;
    this.noiseHit(0.9, 0.55, 420);
    this.note(70, ctx.currentTime, 0.8, "sine", 0.5, 28);
    this.note(1200, ctx.currentTime, 0.25, "sawtooth", 0.12, 200);
  }
  wave() {
    const ctx = this.ensure();
    if (!ctx) return;
    this.note(440, ctx.currentTime, 0.1, "square", 0.16);
    this.note(554, ctx.currentTime + 0.1, 0.1, "square", 0.16);
    this.note(659, ctx.currentTime + 0.2, 0.18, "square", 0.16);
  }
  playerDead() {
    const ctx = this.ensure();
    if (!ctx) return;
    this.noiseHit(0.6, 0.5, 600);
    this.note(320, ctx.currentTime, 0.5, "sawtooth", 0.25, 50);
  }
  over() {
    const ctx = this.ensure();
    if (!ctx) return;
    const seq = [392, 330, 262, 196];
    seq.forEach((f, i) => this.note(f, ctx.currentTime + i * 0.22, 0.24, "square", 0.18));
  }
  ui() {
    const ctx = this.ensure();
    if (!ctx) return;
    this.note(720, ctx.currentTime, 0.05, "square", 0.08);
  }
  select() {
    const ctx = this.ensure();
    if (!ctx) return;
    this.note(660, ctx.currentTime, 0.06, "square", 0.14);
    this.note(990, ctx.currentTime + 0.06, 0.1, "square", 0.14);
  }
}

export const audio = new AudioSys();

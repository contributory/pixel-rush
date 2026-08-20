/* Audio system: background music + synthesized WebAudio sound effects. */

/** Local BGM from public/ folder. Stays silent if missing. */
const LOCAL_SRC = "/pixel-rush.mp3";

export type BgmSource = "local" | "none";

class AudioSys {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private bgm: HTMLAudioElement | null = null;
  private bgmStarting = false;
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

  /* ---------- background music ---------- */

  init() {
    if (this.bgm || this.bgmStarting) return;

    // Chrome blocks media playback until a user gesture. Do not call play()
    // from the constructor/game bootstrap; prepare the element and wait for
    // the first real interaction.
    this.startBgm();
    const wake = () => {
      this.resume();
      window.removeEventListener("pointerdown", wake);
      window.removeEventListener("keydown", wake);
      window.removeEventListener("touchstart", wake);
    };
    window.addEventListener("pointerdown", wake, { passive: true });
    window.addEventListener("keydown", wake);
    window.addEventListener("touchstart", wake, { passive: true });
  }

  private emit() {
    const playing = this.bgm !== null && !this.bgm.paused;
    this.onBgmState?.(playing, this.bgmSource);
  }

  private startBgm() {
    this.bgmStarting = true;
    const el = new Audio();
    el.loop = true;
    el.preload = "auto";
    el.volume = this.muted ? 0 : 0.5;
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      this.bgmStarting = false;
      this.bgm = el;
      this.bgmSource = "local";
      el.addEventListener("play", () => this.emit());
      el.addEventListener("pause", () => this.emit());
      el.addEventListener("ended", () => this.emit());
      this.emit();
      // If a gesture already unlocked audio, start now.
      if (!this.muted) {
        void el.play().then(() => this.emit()).catch(() => {
          /* wait for explicit resume */
        });
      }
    };

    const onMissing = () => {
      if (settled) return;
      settled = true;
      this.bgmStarting = false;
      console.warn("[audio] background music missing — playback will stay silent");
      this.bgmSource = "none";
      this.emit();
    };

    el.addEventListener("error", onMissing, { once: true });
    el.addEventListener("canplay", finish, { once: true });
    el.src = LOCAL_SRC;
    el.load();
  }

  /** True when BGM is actively playing. */
  get isBgmPlaying(): boolean {
    return this.bgm !== null && !this.bgm.paused;
  }

  resume() {
    // Must be called from a user gesture on Chrome (autoplay policy).
    this.init();
    const ctx = this.ensure();
    if (ctx?.state === "suspended") {
      void ctx.resume().catch(() => {});
    }

    if (this.muted) {
      this.emit();
      return;
    }

    if (this.bgm) {
      if (this.bgm.paused) {
        void this.bgm.play().then(() => this.emit()).catch(() => {
          // File blocked or missing — stay silent.
          if (this.bgm) {
            try {
              this.bgm.pause();
            } catch {
              /* ignore */
            }
            this.bgm = null;
            this.bgmSource = "none";
            this.emit();
          }
        });
      }
    }
    this.emit();
  }

  pauseBgm() {
    if (this.bgm && !this.bgm.paused) {
      try {
        this.bgm.pause();
      } catch {
        /* ignore */
      }
    }
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
    if (m) {
      this.pauseBgm();
    } else {
      // Unmute from a click = valid Chrome user gesture → start playback.
      this.resume();
    }
    this.emit();
  }

  /**
   * Mute button behaviour:
   *  - muted  → unmute + play
   *  - unmuted but music not playing → play (Chrome autoplay unlock)
   *  - unmuted and playing → mute + pause
   */
  toggleMuteOrPlay() {
    this.init();
    if (this.muted) {
      this.setMuted(false);
      return;
    }
    if (!this.isBgmPlaying) {
      this.resume();
      return;
    }
    this.setMuted(true);
  }

  /* ---------- sound effects ---------- */

  private ensure(): AudioContext | null {
    if (!this.ctx) {
      const AC =
        window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext })
          .webkitAudioContext;
      if (!AC) return null;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = this.muted ? 0 : 0.55;
      this.master.connect(this.ctx.destination);
    }
    if (this.ctx.state === "suspended") this.ctx.resume().catch(() => {});
    return this.ctx;
  }

  private note(
    f: number,
    t: number,
    d: number,
    type: OscillatorType,
    v: number,
    f2?: number,
  ) {
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
    for (let i = 0; i < len; i++)
      data[i] = (Math.random() * 2 - 1) * (1 - i / len);
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
    seq.forEach((f, i) =>
      this.note(f, ctx.currentTime + i * 0.22, 0.24, "square", 0.18),
    );
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

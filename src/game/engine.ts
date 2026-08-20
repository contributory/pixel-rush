/* ============================================================
   PIXEL RUSH — engine
   Shoot'em up cuộn dọc, canvas 2D.
   Solo: tự mô phỏng. Co-op: HOST mô phỏng địch + gửi snapshot,
   khách gửi input/bullets và nội suy địch từ snapshot.
   ============================================================ */

import { audio } from "./audio";
import { NetClient, roomWsUrl, type NetMsg, type PeerInfo } from "./net";

export type Phase = "menu" | "connecting" | "playing" | "paused" | "gameover";
export type Role = "solo" | "host" | "guest";

export interface OverStats {
  score: number;
  wave: number;
  kills: number;
  bestCombo: number;
  newRecord: boolean;
}

export interface HudPlayer {
  id: string;
  name: string;
  color: string;
  lives: number;
  alive: boolean;
  weapons: WeaponType[];
  bombs: number;
  local: boolean;
}

export interface HudData {
  phase: Phase;
  role: Role;
  score: number;
  hi: number;
  wave: number;
  combo: number;
  mult: number;
  kills: number;
  bossHp: number;
  bossMax: number;
  players: HudPlayer[];
  muted: boolean;
}

export interface NetInfo {
  connected: boolean;
  role: Role;
  youHost: boolean;
  peers: PeerInfo[];
  error: string | null;
  myColor: string;
}

export interface EngineCallbacks {
  onPhase: (phase: Phase, stats?: OverStats) => void;
  onHud: (hud: HudData) => void;
  onNet: (info: NetInfo) => void;
}

/* ---------------- tiện ích ---------------- */
const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
const rand = (a: number, b: number) => a + Math.random() * (b - a);
const irand = (a: number, b: number) => Math.floor(rand(a, b + 1));

function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

const PALETTE = ["#00f0ff", "#ff2d78", "#ffd23f", "#7dff5e"];
const ENEMY_COLORS: Record<string, string> = {
  drone: "#ff4d8f",
  dart: "#ff9d2e",
  spinner: "#7dff5e",
  tank: "#b45cff",
  boss: "#ff2d78",
  hydra: "#ff006e",
  prism: "#00f5d4",
  serpent: "#fee440",
  fortress: "#8338ec",
  wraith: "#00ffff",
  bomber: "#ff6b35",
  splitter: "#9d4edd",
  hunter: "#ff006e",
  sentinel: "#3a86ff",
  miniboss: "#8338ec",
  raider: "#fb5607",
  mortar: "#3a86ff",
};
const ENEMY_SCORE: Record<string, number> = {
  drone: 100,
  dart: 150,
  spinner: 250,
  tank: 300,
  boss: 5000,
  hydra: 5500,
  prism: 5200,
  serpent: 5400,
  fortress: 6000,
  wraith: 180,
  bomber: 350,
  splitter: 400,
  hunter: 280,
  sentinel: 450,
  miniboss: 2500,
  raider: 2800,
  mortar: 2700,
};
const ENEMY_R: Record<string, number> = {
  drone: 13,
  dart: 11,
  spinner: 15,
  tank: 20,
  boss: 48,
  hydra: 50,
  prism: 46,
  serpent: 44,
  fortress: 56,
  wraith: 12,
  bomber: 18,
  splitter: 16,
  hunter: 14,
  sentinel: 22,
  miniboss: 35,
  raider: 34,
  mortar: 36,
};

/** Full-size boss roster (wave multiples of 10). */
const BOSS_TYPES = ["boss", "hydra", "prism", "serpent", "fortress"] as const;
/** Mid-tier bosses (wave multiples of 5, not 10). */
const MINIBOSS_TYPES = ["miniboss", "raider", "mortar"] as const;

function isBossKind(t: string): boolean {
  return (BOSS_TYPES as readonly string[]).includes(t);
}
function isMinibossKind(t: string): boolean {
  return (MINIBOSS_TYPES as readonly string[]).includes(t);
}

/* ---------------- entity types ---------------- */
interface Bullet {
  x: number; y: number; vx: number; vy: number;
  dmg: number; r: number; from: "p" | "e"; color: string;
  homing?: boolean; dead?: boolean;
}
type EnemyType = "drone" | "dart" | "spinner" | "tank" | "boss" | "hydra" | "prism" | "serpent" | "fortress" | "wraith" | "bomber" | "splitter" | "hunter" | "sentinel" | "miniboss" | "raider" | "mortar";
interface Enemy {
  id: number; type: EnemyType;
  x: number; y: number;
  hp: number; maxHp: number;
  t: number; flash: number; shootT: number;
  baseX: number; anchorY: number; phase: number;
  dashVx: number; dashVy: number; burst: number;
  // nội suy phía khách
  tx: number; ty: number; thp: number;
  dead?: boolean;
}
export type WeaponType = "pulse" | "spread" | "laser" | "missile" | "sidewinder" | "plasma" | "burst" | "orbit" | "rail" | "nova";
const WEAPON_TYPES: WeaponType[] = ["pulse", "spread", "laser", "missile", "sidewinder", "plasma", "burst", "orbit", "rail", "nova"];
const WEAPON_LABEL: Record<WeaponType, string> = {
  pulse: "PULSE", spread: "SPREAD", laser: "LASER", missile: "MISSILE", sidewinder: "SIDEWINDER",
  plasma: "PLASMA", burst: "BURST", orbit: "ORBIT", rail: "RAIL", nova: "NOVA",
};
type PickType = WeaponType | "B" | "H";
interface Pickup {
  id: number; type: PickType; x: number; y: number; t: number;
  tx: number; ty: number; dead?: boolean;
}
interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; size: number; color: string;
  kind: "spark" | "puff" | "ring" | "streak";
}
interface Pop {
  x: number; y: number; text: string; color: string; t: number; life: number; big?: boolean;
}
interface ShipState {
  id: string; name: string; color: string;
  x: number; y: number; vx: number;
  alive: boolean; lives: number; weapons: WeaponType[]; bombs: number;
  firing: boolean; cool: number; inv: number; respawn: number;
  tx: number; ty: number;
}
interface SpawnEntry { at: number; type: EnemyType; x: number; phase: number }

const HI_KEY = "pixelrush-hiscore";
/** Solo pilot account — never wiped between matches. */
const PROFILE_KEY = "pixelrush-profile";

/** Persistent solo pilot profile (account-style, not a mid-run CONTINUE). */
export interface PlayerProfile {
  score: number;
  wave: number;
  weapons: WeaponType[];
  bombs: number;
  kills: number;
  bestCombo: number;
}

/** @deprecated alias kept so older imports still typecheck */
export type RunProgress = PlayerProfile;

const DEFAULT_PROFILE = (): PlayerProfile => ({
  score: 0,
  wave: 1,
  weapons: ["pulse"],
  bombs: 3,
  kills: 0,
  bestCombo: 0,
});

export function loadPlayerProfile(): PlayerProfile {
  try {
    const raw = localStorage.getItem(PROFILE_KEY) ?? localStorage.getItem("pixelrush-progress");
    if (!raw) return DEFAULT_PROFILE();
    const o = JSON.parse(raw) as Partial<PlayerProfile>;
    const weapons = Array.isArray(o.weapons)
      ? o.weapons.map(String).filter((w): w is WeaponType => WEAPON_TYPES.includes(w as WeaponType))
      : ["pulse"];
    if (!weapons.includes("pulse")) weapons.unshift("pulse");
    return {
      score: Math.max(0, Math.floor(Number(o.score) || 0)),
      wave: Math.max(1, Math.floor(Number(o.wave) || 1)),
      weapons: weapons.length ? weapons : ["pulse"],
      bombs: Math.max(0, Math.min(9, Math.floor(Number(o.bombs) || 3))),
      kills: Math.max(0, Math.floor(Number(o.kills) || 0)),
      bestCombo: Math.max(0, Math.floor(Number(o.bestCombo) || 0)),
    };
  } catch {
    return DEFAULT_PROFILE();
  }
}

/** @deprecated use loadPlayerProfile */
export function loadRunProgress(): PlayerProfile | null {
  const p = loadPlayerProfile();
  return p.wave > 1 || p.weapons.length > 1 || p.score > 0 ? p : null;
}

function savePlayerProfile(p: PlayerProfile) {
  try {
    localStorage.setItem(PROFILE_KEY, JSON.stringify(p));
    // keep legacy key in sync for older builds
    localStorage.setItem("pixelrush-progress", JSON.stringify(p));
  } catch { /* ignore */ }
}

export function clearPlayerProfile() {
  try {
    localStorage.removeItem(PROFILE_KEY);
    localStorage.removeItem("pixelrush-progress");
  } catch { /* ignore */ }
}

/* ============================================================ */
export class Engine {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private cb: EngineCallbacks;
  private W = 960;
  private H = 720;

  phase: Phase = "menu";
  private role: Role = "solo";
  private net: NetClient | null = null;

  private keys = new Set<string>();
  private pressed = new Set<string>();

  /* --- điều khiển: PC (mouse + keyboard), Mobile (chạm trực tiếp) --- */
  private mouseX = 0;
  private mouseY = 0;
  private mouseActive = false;
  private showCursor = false;
  private touchX: number | null = null;
  private touchY: number | null = null;
  private controlMode: "keyboard" | "mouse" | "touch" = "keyboard";
  private onPtrDown: (e: PointerEvent) => void;
  private onPtrMove: (e: PointerEvent) => void;
  private onPtrUp: (e: PointerEvent) => void;
  private onKeyDown: (e: KeyboardEvent) => void;
  private onKeyUp: (e: KeyboardEvent) => void;

  private raf = 0;
  private last = 0;
  private now = 0;
  private hudT = 0;
  private destroyed = false;

  /* world */
  private players = new Map<string, ShipState>();
  private me!: ShipState;
  private bullets: Bullet[] = [];
  private enemies: Enemy[] = [];
  private picks: Pickup[] = [];
  private parts: Particle[] = [];
  private pops: Pop[] = [];
  private stars: { x: number; y: number; z: number; r: number; tw: number }[] = [];

  private score = 0;
  private hi = 0;
  private wave = 0;
  private combo = 0;
  private bestCombo = 0;
  private comboT = 0;
  private mult = 1;
  private kills = 0;
  private spawnQueue: SpawnEntry[] = [];
  private waveT = 0;
  private waveClearT = -1;
  private bossTrickleT = 0;
  private idc = 1;

  private shake = 0;
  private flashRed = 0;
  private flashWhite = 0;
  private banner: { text: string; sub: string; t: number; life: number; color: string } | null = null;

  private snapT = 0;
  private shipT = 0;
  private streakT = 2;

  private onResize: () => void;
  private onVis: () => void;

  constructor(canvas: HTMLCanvasElement, cb: EngineCallbacks) {
    this.canvas = canvas;
    this.cb = cb;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Canvas 2D unavailable");
    this.ctx = ctx;
    try {
      this.hi = Number(localStorage.getItem(HI_KEY) ?? 0) || 0;
    } catch { this.hi = 0; }

    this.me = this.makeShip("p1", "PILOT-1", PALETTE[0]);
    this.players.set(this.me.id, this.me);

    this.onResize = () => this.resize();
    this.onKeyDown = (e) => this.keyDown(e);
    this.onKeyUp = (e) => this.keyUp(e);
    this.onVis = () => {
      if (document.hidden && this.role === "solo" && this.phase === "playing") {
        this.setPhase("paused");
      }
    };
    window.addEventListener("resize", this.onResize);
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    document.addEventListener("visibilitychange", this.onVis);

    // PC: mouse follow + Ctrl để hiện chuột
    this.canvas.addEventListener("mousemove", (e) => {
      const rect = this.canvas.getBoundingClientRect();
      this.mouseX = e.clientX - rect.left;
      this.mouseY = e.clientY - rect.top;
      this.mouseActive = true;
      this.controlMode = "mouse";
      if (!this.showCursor) {
        this.canvas.style.cursor = "none";
      }
    });

    this.canvas.addEventListener("mousedown", () => {
      if (this.phase === "playing") this.me.firing = true;
    });

    this.canvas.addEventListener("mouseup", () => {
      this.me.firing = false;
    });

    // Mobile: chạm trực tiếp để di chuyển (direct touch follow)
    this.onPtrDown = (e) => this.pointerDown(e);
    this.onPtrMove = (e) => this.pointerMove(e);
    this.onPtrUp = (e) => this.pointerUp(e);
    this.canvas.style.touchAction = "none";
    this.canvas.style.userSelect = "none";
    this.canvas.addEventListener("pointerdown", this.onPtrDown);
    this.canvas.addEventListener("pointermove", this.onPtrMove);
    this.canvas.addEventListener("pointerup", this.onPtrUp);
    this.canvas.addEventListener("pointercancel", this.onPtrUp);

    this.resize();
    this.buildStars();
    audio.init();
    if (document.fonts?.load) {
      document.fonts.load("12px 'Press Start 2P'").catch(() => {});
    }
    this.last = performance.now();
    const loop = (t: number) => {
      if (this.destroyed) return;
      const dt = clamp((t - this.last) / 1000, 0, 0.05);
      this.last = t;
      this.now = t / 1000;
      this.update(dt);
      this.draw();
      this.raf = requestAnimationFrame(loop);
    };
    this.raf = requestAnimationFrame(loop);
  }

  destroy() {
    this.destroyed = true;
    cancelAnimationFrame(this.raf);
    window.removeEventListener("resize", this.onResize);
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    document.removeEventListener("visibilitychange", this.onVis);
    this.canvas.removeEventListener("pointerdown", this.onPtrDown);
    this.canvas.removeEventListener("pointermove", this.onPtrMove);
    this.canvas.removeEventListener("pointerup", this.onPtrUp);
    this.canvas.removeEventListener("pointercancel", this.onPtrUp);
    this.net?.close();
    this.net = null;
  }

  /* ---------------- setup ---------------- */

  private makeShip(id: string, name: string, color: string): ShipState {
    return {
      id, name, color,
      x: this.W / 2, y: this.H - 120, vx: 0,
      alive: true, lives: 2, weapons: ["pulse"], bombs: 3,
      firing: false, cool: 0, inv: 2, respawn: Infinity,
      tx: this.W / 2, ty: this.H - 120,
    };
  }

  private resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    this.canvas.width = Math.floor(this.W * dpr);
    this.canvas.height = Math.floor(this.H * dpr);
    this.canvas.style.width = `${this.W}px`;
    this.canvas.style.height = `${this.H}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.buildStars();
  }

  private buildStars() {
    const n = clamp(Math.floor((this.W * this.H) / 8000), 90, 240);
    this.stars = [];
    for (let i = 0; i < n; i++) {
      this.stars.push({
        x: rand(0, this.W),
        y: rand(0, this.H),
        z: irand(0, 2),
        r: rand(0.6, 2.1),
        tw: rand(0, TAU),
      });
    }
  }

  /* ---------------- input ---------------- */

  private keyDown(e: KeyboardEvent) {
    const tgt = e.target as HTMLElement | null;
    if (tgt && (tgt.tagName === "INPUT" || tgt.tagName === "TEXTAREA")) return;
    if (["Space", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(e.code)) {
      e.preventDefault();
    }
    this.keys.add(e.code);
    if (!e.repeat) {
      this.pressed.add(e.code);
      if (e.code === "KeyM") {
        this.toggleMute();
      }
      // Ctrl để hiện chuột
      if (e.code === "ControlLeft" || e.code === "ControlRight") {
        this.showCursor = true;
        this.canvas.style.cursor = "default";
      }
      if ((e.code === "KeyP" || e.code === "Escape") && this.role === "solo") {
        if (this.phase === "playing") this.setPhase("paused");
        else if (this.phase === "paused") this.setPhase("playing");
      }
      if ((e.code === "Enter" || e.code === "NumpadEnter") && this.phase === "gameover") {
        this.restart();
      }
    }
  }

  private keyUp(e: KeyboardEvent) {
    this.keys.delete(e.code);
    if (e.code === "ControlLeft" || e.code === "ControlRight") {
      this.showCursor = false;
      this.canvas.style.cursor = "none";
    }
  }

  /* --- điều khiển cảm ứng: chạm trực tiếp (direct touch follow) --- */
  private pointerDown(e: PointerEvent) {
    if (this.phase !== "playing") return;
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch { /* ignore */ }
    const rect = this.canvas.getBoundingClientRect();
    this.touchX = e.clientX - rect.left;
    this.touchY = e.clientY - rect.top;
    this.controlMode = "touch";
    // Auto-fire khi chạm
    this.me.firing = true;
    e.preventDefault();
  }

  private pointerMove(e: PointerEvent) {
    if (this.controlMode !== "touch") return;
    const rect = this.canvas.getBoundingClientRect();
    this.touchX = e.clientX - rect.left;
    this.touchY = e.clientY - rect.top;
  }

  private pointerUp(e: PointerEvent) {
    this.touchX = null;
    this.touchY = null;
    this.me.firing = false;
    try {
      this.canvas.releasePointerCapture(e.pointerId);
    } catch { /* ignore */ }
  }

  /* ---------------- public API ---------------- */

  startSolo() {
    this.disconnect();
    this.role = "solo";
    this.me = this.makeShip("p1", this.loadName(), PALETTE[0]);
    this.players = new Map([[this.me.id, this.me]]);
    // Always load the pilot account — arsenal / wave are never wiped between matches.
    this.startMatch(loadPlayerProfile());
    this.emitNet();
    audio.select();
  }

  async startCoop(urlBase: string, room: string, name: string) {
    this.disconnect();
    this.setPhase("connecting");
    const net = new NetClient();
    this.net = net;
    net.onMsg = (m) => this.handleNet(m);
    net.onPeers = () => this.emitNet();
    net.onClose = () => this.handleDisconnect();
    // Normalize server URL (handles bare host, http(s), trailing /ws, etc.)
    const wsUrl = roomWsUrl(urlBase, room);
    if (!wsUrl.startsWith("ws")) {
      this.net = null;
      this.role = "solo";
      this.setPhase("menu");
      this.emitNet("Invalid server address");
      return;
    }
    try {
      // pick the first palette color nobody in the room already uses
      let myColor = PALETTE[0];
      await net.connect(wsUrl, name, (peers) => {
        const used = new Set(peers.map((p) => p.color));
        myColor = PALETTE.find((c) => !used.has(c)) ?? PALETTE[peers.length % PALETTE.length];
        return myColor;
      });
      this.me = this.makeShip(net.id, name, myColor);
      this.players = new Map([[this.me.id, this.me]]);
      this.role = net.youHost ? "host" : "guest";
      this.resetWorld();
      this.setPhase("menu");
      this.emitNet();
      if (!net.youHost) {
        this.showBanner("ROOM JOINED", "waiting for the HOST to start...", "#00f0ff");
      } else {
        this.showBanner("YOU ARE HOST", "press START MISSION in the lobby", "#ffd23f");
      }
    } catch (e) {
      this.net = null;
      this.role = "solo";
      this.setPhase("menu");
      this.emitNet(e instanceof Error ? e.message : "Connection failed");
    }
  }

  private loadName(): string {
    try {
      return localStorage.getItem("pixelrush-name") || `PILOT-${irand(10, 99)}`;
    } catch {
      return `PILOT-${irand(10, 99)}`;
    }
  }

  togglePause() {
    if (this.role !== "solo") return;
    if (this.phase === "playing") this.setPhase("paused");
    else if (this.phase === "paused") this.setPhase("playing");
  }

  restart() {
    if (this.phase !== "gameover") return;
    if (this.role === "guest" && this.net?.open) return; // khách đợi host
    if (this.role === "host" && this.net?.open) {
      this.net.send({ t: "start" });
      this.startMatch();
    } else {
      // PLAY AGAIN: still loads pilot account (arsenal + wave)
      this.startMatch();
    }
    audio.select();
  }

  /** Pilot account (menu stats). */
  getPlayerProfile(): PlayerProfile {
    return loadPlayerProfile();
  }

  quitToMenu() {
    if (this.net?.open) this.net.send({ t: "lobby" });
    this.disconnect();
    this.role = "solo";
    this.resetWorld();
    this.setPhase("menu");
    this.emitNet();
    audio.ui();
  }

  toggleMute() {
    // Also acts as play/pause for BGM — unlocks Chrome autoplay on first click.
    audio.toggleMuteOrPlay();
    this.pushHud(true);
  }

  getHud(): HudData {
    const boss = this.enemies.find((e) => isBossKind(e.type) || isMinibossKind(e.type));
    return {
      phase: this.phase,
      role: this.role,
      score: this.score,
      hi: this.hi,
      wave: this.wave,
      combo: this.combo,
      mult: this.mult,
      kills: this.kills,
      bossHp: boss ? Math.max(0, boss.hp) : 0,
      bossMax: boss ? boss.maxHp : 0,
      players: [...this.players.values()].map((s) => ({
        id: s.id, name: s.name, color: s.color, lives: s.lives,
        alive: s.alive, weapons: [...s.weapons], bombs: s.bombs, local: s === this.me,
      })),
      muted: audio.muted,
    };
  }

  /* ---------------- match flow ---------------- */

  private startMatch(profile: PlayerProfile | null = null) {
    // Solo always carries the pilot account; co-op stays a fresh pulse loadout.
    const account = this.role === "solo" ? (profile ?? loadPlayerProfile()) : null;
    this.resetWorld(account);
    if (this.role === "host") this.ensurePeerPlayers();
    this.setPhase("playing");
    if (account && account.wave >= 1) {
      this.wave = Math.max(0, account.wave - 1);
      this.nextWave();
      if (account.wave > 1 || account.weapons.length > 1) {
        this.showBanner(
          `WAVE ${this.wave}`,
          "pilot account loaded",
          "#ffd23f",
        );
      }
    } else {
      this.nextWave();
    }
  }

  /** Host bấm bắt đầu trận co-op (hoặc chơi solo nếu chưa nối mạng). */
  async hostStart() {
    if (this.role === "host" && this.net?.open) {
      // Co-op uses WebRTC only after the second player is present and the host
      // explicitly starts the mission. Do not create a peer connection in the lobby.
      if (this.net.peers.length !== 1) {
        this.showBanner("WAITING FOR PILOT", "2 players are required to start co-op", "#ff2d78");
        return;
      }
      try {
        await this.net.startWebRTC();
      } catch (e) {
        this.showBanner("LINK FAILED", e instanceof Error ? e.message : "WebRTC setup failed", "#ff2d78");
        return;
      }
      this.net.send({ t: "start" });
      this.startMatch();
      audio.select();
    } else if (!this.net) {
      this.startSolo();
    }
  }

  private resetWorld(profile: PlayerProfile | null = null) {
    this.bullets = [];
    this.enemies = [];
    this.picks = [];
    this.parts = [];
    this.pops = [];
    this.spawnQueue = [];
    // Account carries score / kills / best combo across matches (solo only).
    this.score = profile ? profile.score : 0;
    this.wave = 0;
    this.combo = 0;
    this.bestCombo = profile ? profile.bestCombo : 0;
    this.comboT = 0;
    this.mult = 1;
    this.kills = profile ? profile.kills : 0;
    this.waveT = 0;
    this.waveClearT = -1;
    this.shake = 0;
    this.flashRed = 0;
    this.flashWhite = 0;
    this.banner = null;
    this.spreadPlayers(profile);
  }

  private spreadPlayers(profile: PlayerProfile | null = null) {
    const n = this.players.size;
    let i = 0;
    for (const s of this.players.values()) {
      s.alive = true;
      s.lives = 2;
      // Solo pilot keeps unlocked arsenal; co-op still starts with pulse.
      if (profile && s === this.me && this.role === "solo") {
        s.weapons = [...profile.weapons];
        if (!s.weapons.includes("pulse")) s.weapons.unshift("pulse");
        if (!s.weapons.length) s.weapons = ["pulse"];
        s.bombs = Math.max(3, profile.bombs);
      } else {
        s.weapons = ["pulse"];
        s.bombs = 3;
      }
      s.inv = 2;
      s.respawn = Infinity;
      s.cool = 0;
      const off = n > 1 ? (i - (n - 1) / 2) * 95 : 0;
      s.x = s.tx = clamp(this.W / 2 + off, 40, this.W - 40);
      s.y = s.ty = this.H - 120;
      i++;
    }
  }

  private ensurePeerPlayers() {
    if (!this.net) return;
    for (const p of this.net.peers) {
      if (!this.players.has(p.id)) {
        this.players.set(p.id, this.makeShip(p.id, p.name, p.color));
      }
    }
    this.spreadPlayers();
  }

  private nextWave() {
    this.wave++;
    this.waveT = 0;
    this.spawnQueue = this.buildWave(this.wave);
    this.waveClearT = -1;
    this.bossTrickleT = 3;
    const isBoss = this.wave % 5 === 0;
    this.showBanner(
      `WAVE ${this.wave}`,
      isBoss ? "!! BOSS INCOMING !!" : "destroy all hostiles",
      isBoss ? "#ff2d78" : "#00f0ff",
    );
    audio.wave();
  }

  private buildWave(w: number): SpawnEntry[] {
    const q: SpawnEntry[] = [];
    const xAt = (f: number) => clamp(this.W * f, 50, this.W - 50);

    // Full bosses every 10 waves — cycle variants for variety
    if (w % 10 === 0) {
      const kind = BOSS_TYPES[Math.floor(w / 10) % BOSS_TYPES.length];
      q.push({ at: 1.2, type: kind, x: this.W / 2, phase: 0 });
      // escort pack so the arena is never empty
      for (let i = 0; i < 4 + Math.min(6, Math.floor(w / 10)); i++) {
        q.push({ at: 2.0 + i * 0.55, type: "drone", x: xAt(rand(0.12, 0.88)), phase: rand(0, TAU) });
      }
      return q;
    }
    // Minibosses every 5 waves (not 10)
    if (w % 5 === 0) {
      const kind = MINIBOSS_TYPES[Math.floor(w / 5) % MINIBOSS_TYPES.length];
      q.push({ at: 1.2, type: kind, x: this.W / 2, phase: 0 });
      for (let i = 0; i < 3 + Math.min(4, Math.floor(w / 5)); i++) {
        q.push({ at: 1.8 + i * 0.45, type: "dart", x: xAt(rand(0.15, 0.85)), phase: rand(0, TAU) });
      }
      return q;
    }

    let t = 0.4;
    // denser drone waves
    const drones = 6 + Math.min(16, Math.floor(w * 1.55));
    for (let i = 0; i < drones; i++) {
      q.push({ at: t, type: "drone", x: xAt(rand(0.12, 0.88)), phase: rand(0, TAU) });
      t += rand(0.16, 0.32);
    }

    if (w >= 2) {
      t += 0.45;
      const darts = 4 + Math.min(7, w);
      for (let i = 0; i < darts; i++) {
        q.push({ at: t, type: "dart", x: xAt(rand(0.15, 0.85)), phase: rand(0, TAU) });
        t += rand(0.28, 0.48);
      }
    }

    if (w >= 3) {
      const spins = 2 + Math.min(2, Math.floor(w / 5));
      for (let i = 0; i < spins; i++) {
        q.push({ at: t + 0.3 + i * 0.45, type: "spinner", x: xAt(0.2 + i * 0.2), phase: i * Math.PI });
      }
      t += 1.2 + spins * 0.4;
    }

    if (w >= 4) {
      const tanks = 2 + Math.min(3, Math.floor((w - 4) / 2));
      for (let i = 0; i < tanks; i++) {
        q.push({ at: t + i * 1.1, type: "tank", x: xAt(rand(0.25, 0.75)), phase: rand(0, TAU) });
      }
      t += tanks * 1.1;
    }

    if (w >= 5) {
      const wraiths = 3 + Math.min(6, Math.floor((w - 5) / 2));
      for (let i = 0; i < wraiths; i++) {
        q.push({ at: t + 0.25 + i * 0.4, type: "wraith", x: xAt(rand(0.1, 0.9)), phase: rand(0, TAU) });
      }
      t += 0.4 + wraiths * 0.4;
    }

    if (w >= 6) {
      const bombers = 2 + Math.min(3, Math.floor((w - 6) / 2));
      for (let i = 0; i < bombers; i++) {
        q.push({ at: t + 0.35 + i * 1.0, type: "bomber", x: xAt(rand(0.2, 0.8)), phase: rand(0, TAU) });
      }
      t += 0.5 + bombers * 1.0;
    }

    if (w >= 7) {
      const splits = 2 + Math.min(2, Math.floor(w / 8));
      for (let i = 0; i < splits; i++) {
        q.push({ at: t + 0.4 + i * 0.55, type: "splitter", x: xAt(0.3 + i * 0.2), phase: i * Math.PI });
      }
      t += 1.4 + splits * 0.4;
    }

    if (w >= 8) {
      const hunters = 3 + Math.min(5, Math.floor((w - 8) / 2));
      for (let i = 0; i < hunters; i++) {
        q.push({ at: t + 0.25 + i * 0.55, type: "hunter", x: xAt(rand(0.15, 0.85)), phase: rand(0, TAU) });
      }
      t += 0.4 + hunters * 0.55;
    }

    if (w >= 9) {
      const sentinels = 2 + Math.min(3, Math.floor((w - 9) / 3));
      for (let i = 0; i < sentinels; i++) {
        q.push({ at: t + 0.5 + i * 1.2, type: "sentinel", x: xAt(rand(0.25, 0.75)), phase: rand(0, TAU) });
      }
      t += 0.7 + sentinels * 1.2;
    }

    // closing rush
    if (w >= 3) {
      const fin = 4 + Math.min(6, Math.floor(w / 3));
      for (let i = 0; i < fin; i++) {
        q.push({ at: t + 0.35 + i * 0.22, type: "drone", x: xAt(rand(0.12, 0.88)), phase: rand(0, TAU) });
      }
    }

    return q;
  }

  private spawnEnemy(type: EnemyType, x: number, phase: number) {
    const w = this.wave;
    // Độ khó tăng dần: dễ hơn ở đầu, scale mạnh hơn từ wave 10+
    // Harder curve: ramps earlier and keeps climbing
    const difficultyMultiplier =
      w <= 2 ? 0.85 :
      w <= 5 ? 1.05 :
      w <= 10 ? 1.25 :
      w <= 15 ? 1.45 :
      1.55 + (w - 15) * 0.09;
    const coop = this.players.size > 1 ? 1.55 : 1;
    const hp =
      type === "drone" ? Math.max(1, Math.floor(2 * difficultyMultiplier)) :
      type === "dart" ? Math.max(1, Math.floor(2 * difficultyMultiplier)) :
      type === "spinner" ? Math.max(3, Math.floor((5 + Math.floor(w / 2)) * difficultyMultiplier)) :
      type === "tank" ? Math.max(6, Math.floor((10 + Math.floor(w / 1.5)) * difficultyMultiplier)) :
      type === "wraith" ? Math.max(3, Math.floor((4 + Math.floor(w / 3)) * difficultyMultiplier)) :
      type === "bomber" ? Math.max(8, Math.floor((12 + Math.floor(w / 2)) * difficultyMultiplier)) :
      type === "splitter" ? Math.max(6, Math.floor((8 + Math.floor(w / 2)) * difficultyMultiplier)) :
      type === "hunter" ? Math.max(3, Math.floor((5 + Math.floor(w / 3)) * difficultyMultiplier)) :
      type === "sentinel" ? Math.max(12, Math.floor((18 + Math.floor(w / 1.5)) * difficultyMultiplier)) :
      isMinibossKind(type) ? Math.floor((95 + w * 28) * coop * difficultyMultiplier) :
      isBossKind(type) ? Math.floor((160 + w * 38) * coop * difficultyMultiplier) :
      Math.max(2, Math.floor(3 * difficultyMultiplier));
    const e: Enemy = {
      id: this.idc++, type,
      x, y: -40,
      hp, maxHp: hp,
      t: 0, flash: 0, shootT: rand(0.6, 1.4),
      baseX: x, anchorY: type === "tank" || type === "sentinel" ? rand(160, 220) : rand(130, 230),
      phase, dashVx: 0, dashVy: 0, burst: 0,
      tx: x, ty: -40, thp: hp,
    };
    this.enemies.push(e);
  }

  /* ---------------- net ---------------- */

  private emitNet(error: string | null = null) {
    this.cb.onNet({
      connected: this.net?.open ?? false,
      role: this.role,
      youHost: this.net?.youHost ?? false,
      peers: this.net ? [...this.net.peers] : [],
      myColor: this.me?.color ?? "#00f0ff",
      error,
    });
  }

  private disconnect() {
    if (this.net) {
      this.net.close();
      this.net = null;
    }
    this.players = new Map([[this.me.id, this.me]]);
  }

  private handleDisconnect() {
    // Mất kết nối giữa trận
    const wasGuest = this.role === "guest";
    if (this.phase === "connecting") {
      this.role = "solo";
      this.setPhase("menu");
      this.emitNet("Lost server connection");
      return;
    }
    this.net = null;
    // xóa phi công máy khách khác
    for (const [id, s] of this.players) {
      if (s !== this.me) {
        this.explode(s.x, s.y, s.color, 1);
        this.players.delete(id);
      }
    }
    if (wasGuest) {
      this.role = "host";
      for (const e of this.enemies) {
        e.x = e.tx; e.y = e.ty; e.hp = e.thp;
      }
      if (this.enemies.length === 0 && this.spawnQueue.length === 0 && this.phase === "playing") {
        this.waveClearT = 1;
      }
      this.showBanner("LINK LOST", "continuing alone", "#ffd23f");
    } else if (this.role === "host") {
      this.role = "solo";
      if (this.phase === "playing") this.showBanner("LINK LOST", "playing solo now", "#ffd23f");
    }
    this.emitNet("Lost server connection");
  }

  private promoteToHost() {
    this.role = "host";
    if (this.net) {
      this.net.youHost = true;
    }
    for (const e of this.enemies) {
      e.x = e.tx; e.y = e.ty; e.hp = e.thp;
    }
    if (this.enemies.length === 0 && this.spawnQueue.length === 0 && this.phase === "playing") {
      this.waveClearT = 1;
    }
    this.showBanner("YOU ARE THE NEW HOST", "carry on the fight", "#ffd23f");
    this.emitNet();
  }

  private handleNet(m: NetMsg) {
    switch (m.t) {
      case "host":
        if (this.net && m.id === this.net.id) this.promoteToHost();
        break;
      case "peer-join": {
        if (this.role === "host" && this.phase === "playing") {
          const s = this.makeShip(String(m.from ?? m.id), String(m.name ?? "PILOT"), String(m.color ?? "#ffd23f"));
          this.players.set(s.id, s);
          this.net?.send({ t: "start" });
        }
        this.emitNet();
        break;
      }
      case "peer-leave": {
        const s = this.players.get(String(m.id));
        if (s && s !== this.me) {
          this.explode(s.x, s.y, s.color, 1);
          this.players.delete(String(m.id));
          if (this.phase === "playing") this.showBanner(`${s.name} LEFT`, "", "#8ea0d8");
          this.checkGameOver();
        }
        this.emitNet();
        break;
      }
      case "start":
        if (this.role !== "host") {
          this.resetWorld();
          this.setPhase("playing");
          this.showBanner("WAVE 1", "battle begins!", "#00f0ff");
        }
        break;
      case "snap":
        if (this.role === "guest") this.applySnap(m);
        break;
      case "eshot":
        this.bullets.push({
          x: Number(m.x), y: Number(m.y), vx: Number(m.vx), vy: Number(m.vy),
          dmg: 1, r: Number(m.r ?? 5), from: "e", color: String(m.color ?? "#ff5c8a"),
        });
        break;
      case "pshot":
        // đạn của người chơi khác (chỉ nhận của đồng đội — của mình thì tự mô phỏng)
        this.bullets.push({
          x: Number(m.x), y: Number(m.y), vx: Number(m.vx), vy: Number(m.vy),
          dmg: Number(m.dmg ?? 1), r: 4, from: "p", color: String(m.color ?? "#9ffbff"),
          homing: !!m.homing,
        });
        break;
      case "ship": {
        const id = String(m.from ?? "");
        if (!id || id === this.me.id) break;
        let s = this.players.get(id);
        if (!s) {
          s = this.makeShip(id, String(m.name ?? "PILOT"), String(m.color ?? "#ff2d78"));
          s.x = s.tx = Number(m.x);
          s.y = s.ty = Number(m.y);
          this.players.set(id, s);
          this.ring(s.x, s.y, s.color);
        }
        s.tx = Number(m.x);
        s.ty = Number(m.y);
        s.vx = Number(m.vx ?? 0);
        s.alive = !!m.alive;
        s.lives = Number(m.lives ?? 0);
        s.weapons = Array.isArray(m.weapons)
          ? (m.weapons.map(String).filter((w): w is WeaponType => WEAPON_TYPES.includes(w as WeaponType)))
          : ["pulse"];
        if (!s.weapons.length) s.weapons = ["pulse"];
        s.bombs = Number(m.bombs ?? 0);
        s.firing = !!m.firing;
        s.name = String(m.name ?? s.name);
        s.color = String(m.color ?? s.color);
        break;
      }
      case "pdmg":
        if (this.role === "host") {
          const s = this.players.get(String(m.from ?? ""));
          if (s) {
            s.lives = Number(m.lives ?? 0);
            s.alive = !m.dead;
            this.checkGameOver();
          }
        }
        break;
      case "pick":
        if (this.role === "host") {
          const p = this.picks.find((k) => k.id === Number(m.id));
          if (p) p.dead = true;
        }
        break;
      case "bomb":
        if (this.role === "host") {
          this.hostBomb(Number(m.x), Number(m.y));
        }
        break;
      case "bombfx":
        this.localBombFx(Number(m.x), Number(m.y));
        break;
      case "over":
        if (this.role !== "host") {
          this.score = Number(m.score ?? this.score);
          this.wave = Number(m.wave ?? this.wave);
          this.kills = Number(m.kills ?? this.kills);
          this.endGame();
        }
        break;
      case "again":
        if (this.role === "host" && this.phase === "gameover") {
          this.net?.send({ t: "start" });
          this.startMatch();
        }
        break;
    }
  }

  private applySnap(m: NetMsg) {
    this.score = Number(m.score ?? this.score);
    this.combo = Number(m.combo ?? 0);
    this.mult = Number(m.mult ?? 1);
    this.kills = Number(m.kills ?? this.kills);
    const snapWave = Number(m.wave ?? this.wave);
    if (snapWave > this.wave) {
      this.wave = snapWave;
      const isBoss = snapWave % 5 === 0;
      this.showBanner(`WAVE ${snapWave}`, isBoss ? "!! BOSS !!" : "", isBoss ? "#ff2d78" : "#00f0ff");
      audio.wave();
    } else {
      this.wave = snapWave;
    }
    // địch: nội suy
    const seen = new Set<number>();
    for (const e of (m.enemies as Array<Record<string, number>>) ?? []) {
      const id = Number(e.i);
      seen.add(id);
      let en = this.enemies.find((k) => k.id === id);
      if (!en) {
        en = {
          id, type: String(e.tp) as EnemyType,
          x: e.x, y: e.y, hp: e.hp, maxHp: e.mh,
          t: 0, flash: 0, shootT: 1, baseX: e.x, anchorY: e.y,
          phase: 0, dashVx: 0, dashVy: 0, burst: 0,
          tx: e.x, ty: e.y, thp: e.hp,
        };
        this.enemies.push(en);
      }
      en.tx = e.x; en.ty = e.y; en.thp = e.hp; en.maxHp = e.mh;
    }
    for (const en of this.enemies) {
      if (!seen.has(en.id)) {
        // chỉ nổ khi địch còn trong màn hình (tránh nổ "ma" khi địch bay ra ngoài)
        if (en.ty < this.H - 10 && en.ty > -20 && en.tx > -30 && en.tx < this.W + 30) {
          this.explode(en.x, en.y, ENEMY_COLORS[en.type] ?? "#ff4d8f", isBossKind(en.type) ? 3 : isMinibossKind(en.type) ? 2 : 1);
        }
        en.dead = true;
      }
    }
    this.enemies = this.enemies.filter((e) => !e.dead);
    // pickups
    const pseen = new Set<number>();
    for (const p of (m.picks as Array<Record<string, number | string>>) ?? []) {
      const id = Number(p.i);
      pseen.add(id);
      let pk = this.picks.find((k) => k.id === id);
      if (!pk) {
        pk = { id, type: String(p.tp) as PickType, x: Number(p.x), y: Number(p.y), t: 0, tx: Number(p.x), ty: Number(p.y) };
        this.picks.push(pk);
      }
      pk.tx = Number(p.x); pk.ty = Number(p.y);
    }
    this.picks = this.picks.filter((p) => pseen.has(p.id));
  }

  private sendSnap() {
    const state = {
      t: "snap",
      score: this.score,
      wave: this.wave,
      combo: this.combo,
      mult: this.mult,
      kills: this.kills,
      enemies: this.enemies.map((e) => ({
        i: e.id, tp: e.type,
        x: Math.round(e.x * 10) / 10, y: Math.round(e.y * 10) / 10,
        hp: e.hp, mh: e.maxHp,
      })),
      picks: this.picks.map((p) => ({ i: p.id, tp: p.type, x: Math.round(p.x), y: Math.round(p.y) })),
    };
    // Gửi qua WebRTC data channel nếu có (ưu tiên)
    if (this.net?.open) {
      this.net.broadcastState(state);
    } else if (this.role === "host" && this.net?.open) {
      // Fallback: gửi qua WebSocket nếu WebRTC data channel không khả dụng
      this.net.send(state);
    }
  }

  private sendShip() {
    this.net?.send({
      t: "ship",
      x: Math.round(this.me.x), y: Math.round(this.me.y),
      vx: Math.round(this.me.vx),
      alive: this.me.alive, lives: this.me.lives,
      weapons: [...this.me.weapons], bombs: this.me.bombs,
      firing: this.me.firing, name: this.me.name, color: this.me.color,
    });
  }

  /* ---------------- update ---------------- */

  private update(dt: number) {
    // sao luôn trôi (kể cả menu)
    const starSpeed = this.phase === "playing" ? 1 : 0.45;
    for (const s of this.stars) {
      s.y += (26 + s.z * 55) * starSpeed * dt;
      if (s.y > this.H + 4) {
        s.y = -4;
        s.x = rand(0, this.W);
      }
    }
    this.streakT -= dt;
    if (this.streakT <= 0) {
      this.streakT = rand(2.5, 6);
      this.parts.push({
        x: rand(0, this.W), y: -20, vx: rand(-60, 60), vy: rand(500, 800),
        life: 0.9, max: 0.9, size: 2, color: "#9fd8ff", kind: "streak",
      });
    }

    if (this.phase === "playing") {
      this.updatePlaying(dt);
    } else if (this.phase !== "paused") {
      this.updateFx(dt);
    }

    // hiệu ứng chung
    this.shake = Math.max(0, this.shake - dt * 34);
    this.flashRed = Math.max(0, this.flashRed - dt * 1.6);
    this.flashWhite = Math.max(0, this.flashWhite - dt * 2.4);
    if (this.banner) {
      this.banner.t += dt;
      if (this.banner.t > this.banner.life) this.banner = null;
    }

    this.hudT += dt;
    if (this.hudT >= 0.1) this.pushHud();
  }

  private pushHud(force = false) {
    if (force) this.hudT = 0;
    this.hudT = 0;
    this.cb.onHud(this.getHud());
  }

  private updateFx(dt: number) {
    for (const p of this.parts) {
      p.life -= dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      if (p.kind === "spark") {
        p.vx *= 1 - 2.4 * dt;
        p.vy *= 1 - 2.4 * dt;
      }
      if (p.kind === "streak") p.vy += 300 * dt;
    }
    this.parts = this.parts.filter((p) => p.life > 0);
    for (const p of this.pops) p.t += dt;
    this.pops = this.pops.filter((p) => p.t < p.life);
  }

  private updatePlaying(dt: number) {
    const isSim = this.role !== "guest";
    this.waveT += dt;

    /* --- phi công địa phương --- */
    const me = this.me;
    if (me.alive) {
      let tx = me.x;
      let ty = me.y;

      // PC: mouse follow
      if (this.controlMode === "mouse" && this.mouseActive) {
        tx = this.mouseX;
        ty = this.mouseY;
      }
      // Mobile: touch follow
      else if (this.controlMode === "touch" && this.touchX !== null && this.touchY !== null) {
        tx = this.touchX;
        ty = this.touchY;
      }
      // Keyboard
      else {
        const kx = (this.keys.has("ArrowRight") || this.keys.has("KeyD") ? 1 : 0) -
          (this.keys.has("ArrowLeft") || this.keys.has("KeyA") ? 1 : 0);
        const ky = (this.keys.has("ArrowDown") || this.keys.has("KeyS") ? 1 : 0) -
          (this.keys.has("ArrowUp") || this.keys.has("KeyW") ? 1 : 0);
        if (kx !== 0 || ky !== 0) {
          const len = Math.hypot(kx, ky) || 1;
          const speed = 370;
          me.vx = (kx / len) * speed;
          const vy = (ky / len) * speed;
          tx = me.x + me.vx * dt;
          ty = me.y + vy * dt;
        }
      }

      // Di chuyển đến vị trí mục tiêu (lerp cho mượt)
      const lerpFactor = this.controlMode === "touch" || this.controlMode === "mouse" ? 0.25 : 1;
      me.x = me.x + (tx - me.x) * lerpFactor;
      me.y = me.y + (ty - me.y) * lerpFactor;

      // Clamp trong màn hình
      me.x = clamp(me.x, 26, this.W - 26);
      me.y = clamp(me.y, this.H * 0.35, this.H - 40);

      me.firing = true; // auto-fire: phi công chỉ cần di chuyển
      me.cool -= dt;
      if (me.firing && me.cool <= 0) this.firePlayer(me);
      if ((this.pressed.has("KeyK") || this.pressed.has("KeyX")) && me.bombs > 0) {
        this.useBomb(me);
      }
    } else if (Number.isFinite(me.respawn)) {
      me.respawn -= dt;
      if (me.respawn <= 0) {
        me.alive = true;
        me.x = this.W / 2;
        me.y = this.H - 120;
        me.inv = 2.5;
        this.ring(me.x, me.y, me.color);
        audio.power();
      }
    }
    me.inv = Math.max(0, me.inv - dt);

    /* --- phi công từ xa (nội suy) --- */
    for (const s of this.players.values()) {
      if (s === me) continue;
      const k = Math.min(1, dt * 18);
      s.x += (s.tx - s.x) * k;
      s.y += (s.ty - s.y) * k;
      s.inv = Math.max(0, s.inv - dt);
    }

    /* --- mô phỏng địch (host/solo) --- */
    if (isSim) {
      for (const sp of this.spawnQueue) {
        if (this.waveT >= sp.at) {
          this.spawnEnemy(sp.type, sp.x, sp.phase);
          sp.at = Infinity;
        }
      }
      this.spawnQueue = this.spawnQueue.filter((s) => s.at !== Infinity);

      // boss wave: rỉ rả thêm drone
      if (this.wave % 5 === 0 && this.enemies.some((e) => isBossKind(e.type) || isMinibossKind(e.type))) {
        this.bossTrickleT -= dt;
        if (this.bossTrickleT <= 0 && this.enemies.length < 10) {
          this.bossTrickleT = 2.2;
          const fodder: EnemyType = Math.random() < 0.5 ? "drone" : "dart";
          this.spawnEnemy(fodder, rand(60, this.W - 60), rand(0, TAU));
        }
      }

      for (const e of this.enemies) this.updateEnemy(e, dt);
      this.enemies = this.enemies.filter((e) => !e.dead && e.y < this.H + 70 && e.y > -160);

      // Hết wave là vào wave tiếp theo ngay lập tức — không có thời gian nghỉ.
      if (this.spawnQueue.length === 0 && this.enemies.length === 0) {
        this.showBanner("WAVE CLEAR", `+${200 * this.wave} bonus pts`, "#7dff5e");
        this.score += 200 * this.wave;
        audio.power();
        this.nextWave();
        this.persistProfile(); // checkpoint: lưu wave sắp chơi + vũ khí
      }

      // pickups rơi
      for (const p of this.picks) {
        p.t += dt;
        p.y += 85 * dt;
        // nam châm
        let best: ShipState | null = null;
        let bd = 110;
        for (const s of this.players.values()) {
          if (!s.alive) continue;
          const d = Math.hypot(s.x - p.x, s.y - p.y);
          if (d < bd) { bd = d; best = s; }
        }
        if (best) {
          p.x += ((best.x - p.x) / (bd || 1)) * 260 * dt;
          p.y += ((best.y - p.y) / (bd || 1)) * 260 * dt;
        }
        if (p.y > this.H + 30) p.dead = true;
      }
      this.picks = this.picks.filter((p) => !p.dead);

      this.snapT += dt;
      if (this.snapT >= 0.066) {
        this.snapT = 0;
        if (this.net?.open) this.sendSnap();
      }
    } else {
      // khách: nội suy địch + pickup
      const k = Math.min(1, dt * 14);
      for (const e of this.enemies) {
        e.x += (e.tx - e.x) * k;
        e.y += (e.ty - e.y) * k;
        e.hp = e.thp;
        e.t += dt;
        e.flash = Math.max(0, e.flash - dt);
      }
      for (const p of this.picks) {
        p.t += dt;
        p.x += (p.tx - p.x) * k;
        p.y += (p.ty - p.y) * k;
      }
    }

    /* --- đạn --- */
    for (const b of this.bullets) {
      if (b.homing) {
        let best: Enemy | null = null;
        let bd = Infinity;
        for (const e of this.enemies) {
          const d = Math.hypot(e.x - b.x, e.y - b.y);
          if (d < bd) { bd = d; best = e; }
        }
        if (best) {
          const ang = Math.atan2(b.vy, b.vx);
          const want = Math.atan2(best.y - b.y, best.x - b.x);
          let diff = want - ang;
          while (diff > Math.PI) diff -= TAU;
          while (diff < -Math.PI) diff += TAU;
          const na = ang + clamp(diff, -4.5 * dt, 4.5 * dt);
          const sp = Math.hypot(b.vx, b.vy);
          b.vx = Math.cos(na) * sp;
          b.vy = Math.sin(na) * sp;
        }
      }
      b.x += b.vx * dt;
      b.y += b.vy * dt;
      if (b.y < -50 || b.y > this.H + 50 || b.x < -60 || b.x > this.W + 60) b.dead = true;
    }

    /* --- va chạm --- */
    // đạn của ta vs địch
    for (const b of this.bullets) {
      if (b.dead || b.from !== "p") continue;
      for (const e of this.enemies) {
        if (e.dead) continue;
        const r = ENEMY_R[e.type] + b.r;
        const dx = e.x - b.x;
        const dy = e.y - b.y;
        if (dx * dx + dy * dy < r * r) {
          b.dead = true;
          e.flash = 0.1;
          this.sparks(b.x, b.y, b.color, 4);
          audio.hit();
          if (isSim) {
            e.hp -= b.dmg;
            if (e.hp <= 0) this.killEnemy(e);
          }
          break;
        }
      }
    }
    // đạn địch vs phi công (mỗi máy tự lo cho mình)
    if (me.alive && me.inv <= 0) {
      for (const b of this.bullets) {
        if (b.dead || b.from !== "e") continue;
        const r = 12 + b.r;
        const dx = me.x - b.x;
        const dy = me.y - b.y;
        if (dx * dx + dy * dy < r * r) {
          b.dead = true;
          this.damageMe();
          break;
        }
      }
    }
    // địch đâm va
    if (me.alive && me.inv <= 0) {
      for (const e of this.enemies) {
        if (e.dead) continue;
        const r = ENEMY_R[e.type] + 11;
        const dx = me.x - e.x;
        const dy = me.y - e.y;
        if (dx * dx + dy * dy < r * r) {
          if (isSim) {
            e.hp -= 2;
            if (e.hp <= 0) this.killEnemy(e);
          }
          this.damageMe();
          break;
        }
      }
    }
    // nhặt đồ
    if (me.alive) {
      for (const p of this.picks) {
        if (p.dead) continue;
        const dx = me.x - p.x;
        const dy = me.y - p.y;
        if (dx * dx + dy * dy < 26 * 26) {
          p.dead = true;
          this.applyPickup(p.type);
          if (this.role === "guest") this.net?.send({ t: "pick", id: p.id });
        }
      }
      this.picks = this.picks.filter((p) => !p.dead);
    }

    this.bullets = this.bullets.filter((b) => !b.dead);

    /* --- combo / thời gian --- */
    if (this.comboT > 0) {
      this.comboT -= dt;
      if (this.comboT <= 0) this.combo = 0;
    }
    this.mult = 1 + Math.min(3, Math.floor(this.combo / 4) * 0.5);

    /* --- gửi trạng thái phi công --- */
    this.shipT += dt;
    if (this.shipT >= 0.05) {
      this.shipT = 0;
      if (this.net?.open) {
        // Gửi ship state qua WebSocket (signaling không cần low-latency)
        this.sendShip();
      }
    }

    if (isSim) this.checkGameOver();

    this.updateFx(dt);
    this.pressed.clear();
  }

  /** Write the solo pilot account (never clears between matches). */
  private persistProfile() {
    if (this.role !== "solo") return;
    const prev = loadPlayerProfile();
    const weapons = this.me?.weapons?.length ? [...this.me.weapons] : ["pulse"];
    // Merge unlocks so we never lose a weapon the pilot already owned.
    const merged = new Set<WeaponType>(["pulse", ...prev.weapons, ...weapons]);
    savePlayerProfile({
      score: Math.max(prev.score, this.score),
      wave: Math.max(prev.wave, this.wave, 1),
      weapons: WEAPON_TYPES.filter((w) => merged.has(w)),
      bombs: Math.max(prev.bombs, this.me?.bombs ?? 3),
      kills: Math.max(prev.kills, this.kills),
      bestCombo: Math.max(prev.bestCombo, this.bestCombo),
    });
  }

  private checkGameOver() {
    if (this.phase !== "playing") return;
    let anyAlive = false;
    for (const s of this.players.values()) if (s.alive || Number.isFinite(s.respawn)) anyAlive = true;
    if (!anyAlive) this.endGame();
  }

  private endGame() {
    if (this.phase === "gameover") return;
    // Update pilot account (arsenal + highest wave) — not wiped next match
    this.persistProfile();
    let newRecord = false;
    if (this.score > this.hi) {
      this.hi = this.score;
      newRecord = true;
      try { localStorage.setItem(HI_KEY, String(this.hi)); } catch { /* ignore */ }
    }
    const stats: OverStats = {
      score: this.score, wave: this.wave, kills: this.kills,
      bestCombo: this.bestCombo, newRecord,
    };
    if (this.role === "host" && this.net?.open) {
      this.net.send({ t: "over", score: this.score, wave: this.wave, kills: this.kills });
    }
    this.setPhase("gameover", stats);
    audio.over();
  }

  /* ---------------- hành động ---------------- */

  private firePlayer(s: ShipState) {
    const weapons = s.weapons.length ? s.weapons : ["pulse"];
    const mk = (x: number, y: number, vx: number, vy: number, dmg: number, color: string, homing = false, r = 4) => {
      const b: Bullet = { x, y, vx, vy, dmg, r, from: "p", color, homing };
      this.bullets.push(b);
      if (s === this.me && this.net?.open) {
        this.net.send({ t: "pshot", x, y, vx, vy, dmg, color, homing, r });
      }
    };
    const y0 = s.y - 18;

    // Every collected weapon remains active. Their fire patterns stack together.
    for (const weapon of weapons) {
      switch (weapon) {
        case "pulse":
          mk(s.x, y0, 0, -900, 1, "#9ffbff");
          break;
        case "spread":
          mk(s.x - 10, y0, -120, -850, 0.8, "#ffd23f");
          mk(s.x, y0 - 2, 0, -900, 0.9, "#ffd23f");
          mk(s.x + 10, y0, 120, -850, 0.8, "#ffd23f");
          break;
        case "laser":
          mk(s.x, y0, 0, -1150, 1.7, "#ff4dff", false, 3);
          break;
        case "missile":
          mk(s.x - 7, y0 + 4, -45, -610, 2.2, "#b45cff", true, 5);
          mk(s.x + 7, y0 + 4, 45, -610, 2.2, "#b45cff", true, 5);
          break;
        case "sidewinder":
          mk(s.x - 13, y0 + 4, -230, -790, 1.1, "#00ffff");
          mk(s.x + 13, y0 + 4, 230, -790, 1.1, "#00ffff");
          break;
        case "plasma":
          mk(s.x, y0, 0, -700, 3.5, "#7dff5e", false, 8);
          break;
        case "burst":
          for (let i = -1; i <= 1; i++) mk(s.x + i * 7, y0, i * 55, -980, 1.15, "#ff9d2e");
          break;
        case "orbit": {
          const a = this.now * 5;
          for (const side of [-1, 1]) {
            const ang = a + (side < 0 ? Math.PI : 0);
            mk(s.x + Math.cos(ang) * 18, y0 + Math.sin(ang) * 18, Math.cos(ang) * 180, -760 + Math.sin(ang) * 120, 1.4, "#ff6b35");
          }
          break;
        }
        case "rail":
          mk(s.x, y0, 0, -1450, 2.8, "#ffffff", false, 2);
          break;
        case "nova":
          for (let i = 0; i < 5; i++) {
            const a = -Math.PI / 2 + (i - 2) * 0.28;
            mk(s.x, y0, Math.cos(a) * 380, Math.sin(a) * 380, 1.3, "#ff2d78");
          }
          break;
      }
    }
    s.cool = Math.max(0.075, 0.16 - weapons.length * 0.004);
    this.parts.push({ x: s.x, y: y0 - 4, vx: 0, vy: -60, life: 0.07, max: 0.07, size: 6, color: s.color, kind: "puff" });
    if (s === this.me) audio.shoot();
  }

  private useBomb(s: ShipState) {
    s.bombs--;
    if (this.role === "guest") {
      this.net?.send({ t: "bomb", x: s.x, y: s.y });
      this.localBombFx(s.x, s.y);
    } else if (this.net?.open) {
      this.hostBomb(s.x, s.y);
    } else {
      this.hostBomb(s.x, s.y);
    }
  }

  private hostBomb(x: number, y: number) {
    for (const b of this.bullets) if (b.from === "e") { b.dead = true; this.sparks(b.x, b.y, "#ff5c8a", 2); }
    for (const e of this.enemies) {
      e.hp -= 25;
      e.flash = 0.2;
      if (e.hp <= 0) this.killEnemy(e);
    }
    this.net?.send({ t: "bombfx", x, y });
    this.localBombFx(x, y);
  }

  private localBombFx(x: number, y: number) {
    for (const b of this.bullets) if (b.from === "e") b.dead = true;
    // Cải thiện hiệu suất: giảm particle trong bomb fx
    this.parts.push({ x, y, vx: 0, vy: 0, life: 0.5, max: 0.5, size: 18, color: "#ffffff", kind: "ring" });
    this.parts.push({ x, y, vx: 0, vy: 0, life: 0.6, max: 0.6, size: 9, color: "#00f0ff", kind: "ring" });
    this.sparks(x, y, "#ffd23f", 18); // giảm từ 26 xuống 18
    this.shake = Math.min(30, this.shake + 22);
    this.flashWhite = 0.5;
    audio.bomb();
  }

  private applyPickup(type: PickType) {
    const me = this.me;
    if (type === "B") {
      if (me.bombs < 6) { me.bombs++; this.pop(me.x, me.y - 30, "BOMB +1", "#ff2d78", true); }
      else { this.score += 300; this.pop(me.x, me.y - 30, "+300", "#ff2d78"); }
    } else if (type === "H") {
      if (me.lives < 4) { me.lives++; this.pop(me.x, me.y - 30, "LIFE +1", "#7dff5e", true); }
      else { this.score += 1000; this.pop(me.x, me.y - 30, "+1000", "#7dff5e"); }
    } else {
      if (!me.weapons.includes(type)) {
        me.weapons.push(type);
        this.pop(me.x, me.y - 30, `${WEAPON_LABEL[type]} ONLINE`, "#ffd23f", true);
        // Unlock into the pilot account immediately so the next match keeps it.
        this.persistProfile();
      } else {
        this.score += 750;
        this.pop(me.x, me.y - 30, "+750", "#ffd23f");
      }
    }
    this.ring(me.x, me.y, "#ffffff");
    audio.power();
  }

  private damageMe() {
    const me = this.me;
    if (!me.alive || me.inv > 0) return;
    this.explode(me.x, me.y, me.color, 2);
    audio.playerDead();
    this.shake = Math.min(30, this.shake + 16);
    this.flashRed = 0.55;
    if (me.lives > 0) {
      me.lives--;
      me.alive = false;
      me.respawn = 1.6;
    } else {
      me.alive = false;
      me.respawn = Infinity;
    }
    if (this.net?.open) {
      this.net.send({ t: "pdmg", lives: me.lives, dead: !me.alive && !Number.isFinite(me.respawn) });
    }
    if (this.role !== "guest") this.checkGameOver();
  }

  private enemyShoot(e: Enemy, tx: number, ty: number, speed: number, color: string, r = 5) {
    const d = Math.hypot(tx - e.x, ty - e.y) || 1;
    const b: Bullet = {
      x: e.x, y: e.y + 8,
      vx: ((tx - e.x) / d) * speed, vy: ((ty - e.y) / d) * speed,
      dmg: 1, r, from: "e", color,
    };
    this.bullets.push(b);
    if (this.net?.open && this.role !== "guest") {
      this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r, color });
    }
    audio.eshoot();
  }

  private nearestPlayer(x: number, y: number): ShipState | null {
    let best: ShipState | null = null;
    let bd = Infinity;
    for (const s of this.players.values()) {
      if (!s.alive) continue;
      const d = Math.hypot(s.x - x, s.y - y);
      if (d < bd) { bd = d; best = s; }
    }
    return best;
  }

  private updateEnemy(e: Enemy, dt: number) {
    e.t += dt;
    e.flash = Math.max(0, e.flash - dt);
    const w = this.wave;
    switch (e.type) {
      case "drone": {
        e.y += Math.min(220, 100 + w * 6) * dt;
        e.x = e.baseX + Math.sin(e.t * 2.2 + e.phase) * 80;
        break;
      }
      case "dart": {
        if (e.t < 0.5) {
          e.y += 260 * dt;
        } else if (e.t < 0.9) {
          e.x += Math.sin(e.t * 50) * 1.4; // rung báo hiệu
          if (e.dashVx === 0 && e.dashVy === 0) {
            const p = this.nearestPlayer(e.x, e.y);
            const tx = p ? p.x : e.x;
            const ty = p ? p.y : this.H;
            const d = Math.hypot(tx - e.x, ty - e.y) || 1;
            const sp = Math.min(540, 400 + w * 10);
            e.dashVx = ((tx - e.x) / d) * sp;
            e.dashVy = ((ty - e.y) / d) * sp;
          }
        } else {
          e.x += e.dashVx * dt;
          e.y += e.dashVy * dt;
        }
        break;
      }
      case "spinner": {
        if (e.y < e.anchorY) {
          e.y += 180 * dt;
        } else if (e.t < 10) {
          e.x = e.baseX + Math.cos(e.t * 1.7 + e.phase) * 85;
          e.y = e.anchorY + Math.sin(e.t * 1.7 + e.phase) * 34;
          e.shootT -= dt;
          if (e.shootT <= 0) {
            e.shootT = 1.5;
            const p = this.nearestPlayer(e.x, e.y);
            if (p) this.enemyShoot(e, p.x, p.y, Math.min(300, 210 + w * 6), "#a5ff8a");
          }
        } else {
          e.y -= 260 * dt;
        }
        break;
      }
      case "tank": {
        if (e.y < e.anchorY) {
          e.y += 120 * dt;
        } else if (e.t < 9) {
          e.x = clamp(e.baseX + Math.sin(e.t * 0.7 + e.phase) * 130, 40, this.W - 40);
          e.shootT -= dt;
          if (e.shootT <= 0) {
            if (e.burst <= 0) { e.burst = 3; e.shootT = 2.1; }
          }
          if (e.burst > 0) {
            e.burst--;
            e.shootT = 0.13;
            const p = this.nearestPlayer(e.x, e.y);
            if (p) this.enemyShoot(e, p.x, p.y, Math.min(310, 220 + w * 6), "#d9a6ff", 6);
            if (e.burst === 0) e.shootT = 2.1;
          }
        } else {
          e.y -= 170 * dt;
        }
        break;
      }
      case "boss": {
        if (e.y < 150) {
          e.y += 100 * dt;
        } else {
          e.x = this.W / 2 + Math.sin(e.t * 0.55) * Math.max(80, this.W / 2 - 150);
          const enraged = e.hp < e.maxHp * 0.45;
          const k = enraged ? 0.65 : 1;
          e.shootT -= dt;
          if (e.shootT <= 0) {
            e.shootT = 1.9 * k;
            const n = 14 + Math.min(10, Math.floor(w / 2));
            const off = rand(0, TAU);
            for (let i = 0; i < n; i++) {
              const a = off + (i / n) * TAU;
              const sp = Math.min(300, 180 + w * 5);
              const b: Bullet = {
                x: e.x, y: e.y + 10, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                dmg: 1, r: 6, from: "e", color: "#ffd23f",
              };
              this.bullets.push(b);
              if (this.net?.open) this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 6, color: "#ffd23f" });
            }
            audio.eshoot();
          }
          e.phase += dt;
          if (e.phase > 1.15 * k) {
            e.phase = 0;
            const p = this.nearestPlayer(e.x, e.y);
            if (p) {
              for (let i = -3; i <= 3; i++) {
                const sp = Math.min(320, 220 + w * 6);
                const base = Math.atan2(p.y - e.y, p.x - e.x) + i * 0.14;
                const b: Bullet = {
                  x: e.x, y: e.y + 16, vx: Math.cos(base) * sp, vy: Math.sin(base) * sp,
                  dmg: 1, r: 5, from: "e", color: "#ff5c8a",
                };
                this.bullets.push(b);
                if (this.net?.open) this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 5, color: "#ff5c8a" });
              }
              audio.eshoot();
            }
          }
        }
        break;
      }
      case "hydra": {
        // Twin-core boss — dual side cannons + ring fire
        if (e.y < 140) e.y += 95 * dt;
        else {
          e.x = this.W / 2 + Math.sin(e.t * 0.7) * Math.max(60, this.W / 2 - 160);
          const enraged = e.hp < e.maxHp * 0.4;
          e.shootT -= dt;
          if (e.shootT <= 0) {
            e.shootT = enraged ? 0.9 : 1.35;
            for (const side of [-1, 1] as const) {
              const ox = e.x + side * 36;
              const p = this.nearestPlayer(ox, e.y);
              const base = p ? Math.atan2(p.y - e.y, p.x - ox) : Math.PI / 2;
              for (let i = -2; i <= 2; i++) {
                const a = base + i * 0.11;
                const sp = Math.min(310, 210 + w * 6);
                const b: Bullet = {
                  x: ox, y: e.y + 12, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                  dmg: 1, r: 5, from: "e", color: ENEMY_COLORS.hydra,
                };
                this.bullets.push(b);
                if (this.net?.open) this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 5, color: ENEMY_COLORS.hydra });
              }
            }
            audio.eshoot();
          }
          e.phase += dt;
          if (e.phase > (enraged ? 1.4 : 2.0)) {
            e.phase = 0;
            const n = 12 + Math.min(8, Math.floor(w / 2));
            const off = e.t;
            for (let i = 0; i < n; i++) {
              const a = off + (i / n) * TAU;
              const sp = Math.min(280, 160 + w * 5);
              const b: Bullet = {
                x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                dmg: 1, r: 5, from: "e", color: "#ff9d2e",
              };
              this.bullets.push(b);
              if (this.net?.open) this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 5, color: "#ff9d2e" });
            }
            audio.eshoot();
          }
        }
        break;
      }
      case "prism": {
        // Prism — rapid aimed lasers in rotating fan
        if (e.y < 130) e.y += 110 * dt;
        else {
          e.x = this.W / 2 + Math.sin(e.t * 0.9) * Math.max(40, this.W / 2 - 200);
          e.shootT -= dt;
          if (e.shootT <= 0) {
            e.shootT = e.hp < e.maxHp * 0.35 ? 0.18 : 0.32;
            const p = this.nearestPlayer(e.x, e.y);
            const base = p ? Math.atan2(p.y - e.y, p.x - e.x) : Math.PI / 2;
            const fan = 3 + Math.min(4, Math.floor(w / 4));
            for (let i = -fan; i <= fan; i++) {
              const a = base + i * 0.08 + Math.sin(e.t * 4) * 0.15;
              const sp = Math.min(360, 240 + w * 7);
              const b: Bullet = {
                x: e.x, y: e.y + 8, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                dmg: 1, r: 3.5, from: "e", color: ENEMY_COLORS.prism,
              };
              this.bullets.push(b);
              if (this.net?.open) this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 3.5, color: ENEMY_COLORS.prism });
            }
            audio.eshoot();
          }
        }
        break;
      }
      case "serpent": {
        // Serpent — sweeps left/right, sprays arcs
        if (e.y < 120) e.y += 100 * dt;
        else {
          e.x = this.W / 2 + Math.sin(e.t * 1.15) * Math.max(120, this.W / 2 - 90);
          e.y = 120 + Math.sin(e.t * 2.2) * 28;
          e.shootT -= dt;
          if (e.shootT <= 0) {
            e.shootT = 0.55;
            const dir = Math.sin(e.t * 1.15) >= 0 ? 1 : -1;
            for (let i = 0; i < 7; i++) {
              const a = Math.PI / 2 + dir * (0.15 + i * 0.12);
              const sp = Math.min(300, 190 + w * 5);
              const b: Bullet = {
                x: e.x, y: e.y + 10, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                dmg: 1, r: 5, from: "e", color: ENEMY_COLORS.serpent,
              };
              this.bullets.push(b);
              if (this.net?.open) this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 5, color: ENEMY_COLORS.serpent });
            }
            audio.eshoot();
          }
        }
        break;
      }
      case "fortress": {
        // Fortress — slow, armored, spawns drones + heavy volleys
        if (e.y < 160) e.y += 70 * dt;
        else {
          e.x = this.W / 2 + Math.sin(e.t * 0.25) * 50;
          e.shootT -= dt;
          if (e.shootT <= 0) {
            e.shootT = 2.1;
            const n = 16 + Math.min(12, Math.floor(w / 2));
            const off = e.t * 0.5;
            for (let i = 0; i < n; i++) {
              const a = off + (i / n) * TAU;
              const sp = Math.min(260, 140 + w * 4);
              const b: Bullet = {
                x: e.x, y: e.y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                dmg: 1, r: 7, from: "e", color: ENEMY_COLORS.fortress,
              };
              this.bullets.push(b);
              if (this.net?.open) this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 7, color: ENEMY_COLORS.fortress });
            }
            // summon escorts
            if (this.enemies.length < 12) {
              this.spawnEnemy("drone", clamp(e.x - 80, 40, this.W - 40), 0);
              this.spawnEnemy("drone", clamp(e.x + 80, 40, this.W - 40), Math.PI);
            }
            audio.eshoot();
          }
          e.phase += dt;
          if (e.phase > 1.0) {
            e.phase = 0;
            const p = this.nearestPlayer(e.x, e.y);
            if (p) {
              for (let i = -1; i <= 1; i++) {
                const a = Math.atan2(p.y - e.y, p.x - e.x) + i * 0.08;
                const sp = Math.min(340, 230 + w * 6);
                const b: Bullet = {
                  x: e.x, y: e.y + 18, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                  dmg: 1, r: 8, from: "e", color: "#ffd23f",
                };
                this.bullets.push(b);
                if (this.net?.open) this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 8, color: "#ffd23f" });
              }
            }
          }
        }
        break;
      }
      case "wraith": {
        // wraith di chuyển nhanh và zigzag
        if (e.y < e.anchorY) {
          e.y += Math.min(280, 180 + w * 8) * dt;
        } else if (e.t < 8) {
          e.x = e.baseX + Math.sin(e.t * 3.5 + e.phase) * 120;
          e.y = e.anchorY + Math.sin(e.t * 2.1) * 20;
          // wraith không bắn thường mà chỉ đâm vào người chơi
          if (e.t > 1.5 && e.dashVx === 0 && e.dashVy === 0) {
            const p = this.nearestPlayer(e.x, e.y);
            if (p && Math.random() < 0.02) {
              const d = Math.hypot(p.x - e.x, p.y - e.y) || 1;
              const sp = Math.min(480, 350 + w * 10);
              e.dashVx = ((p.x - e.x) / d) * sp;
              e.dashVy = ((p.y - e.y) / d) * sp;
            }
          }
          if (e.dashVx !== 0 || e.dashVy !== 0) {
            e.x += e.dashVx * dt;
            e.y += e.dashVy * dt;
          }
        } else {
          e.y -= 320 * dt;
        }
        break;
      }
      case "bomber": {
        // bomber đứng yên và ném bom theo chùm
        if (e.y < e.anchorY) {
          e.y += 100 * dt;
        } else if (e.t < 10) {
          e.x = clamp(e.baseX + Math.sin(e.t * 0.5 + e.phase) * 60, 50, this.W - 50);
          e.shootT -= dt;
          if (e.shootT <= 0) {
            e.shootT = 1.8;
            // ném 3 quả bom theo hình quạt
            const p = this.nearestPlayer(e.x, e.y);
            const baseAngle = p ? Math.atan2(p.y - e.y, p.x - e.x) : Math.PI / 2;
            for (let i = -1; i <= 1; i++) {
              const angle = baseAngle + i * 0.25;
              const sp = Math.min(200, 150 + w * 4);
              const b: Bullet = {
                x: e.x, y: e.y + 12, vx: Math.cos(angle) * sp, vy: Math.sin(angle) * sp,
                dmg: 1, r: 7, from: "e", color: ENEMY_COLORS.bomber,
              };
              this.bullets.push(b);
              if (this.net?.open) this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 7, color: ENEMY_COLORS.bomber });
            }
            audio.eshoot();
          }
        } else {
          e.y -= 140 * dt;
        }
        break;
      }
      case "splitter": {
        // splitter di chuyển xoắn ốc và phân chia khi chết (xử lý ở killEnemy)
        if (e.y < e.anchorY) {
          e.y += 140 * dt;
        } else if (e.t < 9) {
          const spiral = e.t * 2.5 + e.phase;
          e.x = e.baseX + Math.cos(spiral) * 70;
          e.y = e.anchorY + Math.sin(spiral * 0.7) * 40;
          e.shootT -= dt;
          if (e.shootT <= 0) {
            e.shootT = 1.2;
            // bắn 5 viên theo hình sao
            const count = 5;
            const off = e.t;
            for (let i = 0; i < count; i++) {
              const a = off + (i / count) * TAU;
              const sp = Math.min(240, 180 + w * 5);
              const b: Bullet = {
                x: e.x, y: e.y + 8, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                dmg: 1, r: 4, from: "e", color: ENEMY_COLORS.splitter,
              };
              this.bullets.push(b);
              if (this.net?.open) this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 4, color: ENEMY_COLORS.splitter });
            }
            audio.eshoot();
          }
        } else {
          e.y -= 200 * dt;
        }
        break;
      }
      case "hunter": {
        // hunter truy đuổi người chơi gần nhất
        if (e.y < e.anchorY) {
          e.y += 200 * dt;
        } else if (e.t < 10) {
          const p = this.nearestPlayer(e.x, e.y);
          if (p) {
            const d = Math.hypot(p.x - e.x, p.y - e.y) || 1;
            const speed = Math.min(220, 160 + w * 5);
            e.x += ((p.x - e.x) / d) * speed * dt;
            e.y += ((p.y - e.y) / d) * speed * dt;
          }
          e.shootT -= dt;
          if (e.shootT <= 0) {
            e.shootT = 0.9;
            const p = this.nearestPlayer(e.x, e.y);
            if (p) this.enemyShoot(e, p.x, p.y, Math.min(280, 200 + w * 6), ENEMY_COLORS.hunter, 4);
          }
        } else {
          e.y -= 240 * dt;
        }
        break;
      }
      case "sentinel": {
        // sentinel đứng yên tại vị trí cao và bắn đạn chậm nhưng dày đặc
        if (e.y < e.anchorY) {
          e.y += 80 * dt;
        } else if (e.t < 12) {
          e.x = clamp(e.baseX + Math.sin(e.t * 0.4 + e.phase) * 90, 60, this.W - 60);
          e.shootT -= dt;
          if (e.shootT <= 0) {
            e.shootT = 0.4;
            if (e.burst <= 0) { e.burst = 5; e.shootT = 2.5; }
          }
          if (e.burst > 0) {
            e.burst--;
            e.shootT = 0.08;
            // bắn 3 hướng
            const p = this.nearestPlayer(e.x, e.y);
            const baseAngle = p ? Math.atan2(p.y - e.y, p.x - e.x) : Math.PI / 2;
            for (let i = -1; i <= 1; i++) {
              const angle = baseAngle + i * 0.2;
              const sp = Math.min(190, 140 + w * 4);
              const b: Bullet = {
                x: e.x, y: e.y + 10, vx: Math.cos(angle) * sp, vy: Math.sin(angle) * sp,
                dmg: 1, r: 5, from: "e", color: ENEMY_COLORS.sentinel,
              };
              this.bullets.push(b);
              if (this.net?.open) this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 5, color: ENEMY_COLORS.sentinel });
            }
            audio.eshoot();
            if (e.burst === 0) e.shootT = 2.5;
          }
        } else {
          e.y -= 130 * dt;
        }
        break;
      }
      case "miniboss": {
        if (e.y < 130) e.y += 80 * dt;
        else {
          e.x = this.W / 2 + Math.sin(e.t * 0.45) * Math.max(100, this.W / 2 - 180);
          e.shootT -= dt;
          if (e.shootT <= 0) {
            e.shootT = 1.15;
            const n = 12 + Math.min(8, Math.floor(w / 2));
            const off = rand(0, TAU);
            for (let i = 0; i < n; i++) {
              const a = off + (i / n) * TAU;
              const sp = Math.min(260, 170 + w * 5);
              const b: Bullet = {
                x: e.x, y: e.y + 8, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                dmg: 1, r: 5, from: "e", color: ENEMY_COLORS.miniboss,
              };
              this.bullets.push(b);
              if (this.net?.open) this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 5, color: ENEMY_COLORS.miniboss });
            }
            audio.eshoot();
          }
          e.phase += dt;
          if (e.phase > 0.95) {
            e.phase = 0;
            const p = this.nearestPlayer(e.x, e.y);
            if (p) {
              for (let i = -2; i <= 2; i++) {
                const sp = Math.min(300, 210 + w * 5);
                const base = Math.atan2(p.y - e.y, p.x - e.x) + i * 0.11;
                const b: Bullet = {
                  x: e.x, y: e.y + 12, vx: Math.cos(base) * sp, vy: Math.sin(base) * sp,
                  dmg: 1, r: 6, from: "e", color: "#ff6b35",
                };
                this.bullets.push(b);
                if (this.net?.open) this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 6, color: "#ff6b35" });
              }
              audio.eshoot();
            }
          }
        }
        break;
      }
      case "raider": {
        // Aggressive chase miniboss
        if (e.y < 110) e.y += 120 * dt;
        else {
          const p = this.nearestPlayer(e.x, e.y);
          if (p) {
            const d = Math.hypot(p.x - e.x, p.y - e.y) || 1;
            const speed = Math.min(200, 130 + w * 4);
            e.x += ((p.x - e.x) / d) * speed * dt;
            e.y += ((p.y - e.y) / d) * speed * 0.55 * dt;
            e.y = clamp(e.y, 80, this.H * 0.55);
          }
          e.shootT -= dt;
          if (e.shootT <= 0) {
            e.shootT = 0.7;
            if (p) {
              for (let i = -2; i <= 2; i++) {
                const a = Math.atan2(p.y - e.y, p.x - e.x) + i * 0.1;
                const sp = Math.min(330, 230 + w * 6);
                const b: Bullet = {
                  x: e.x, y: e.y + 10, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                  dmg: 1, r: 5, from: "e", color: ENEMY_COLORS.raider,
                };
                this.bullets.push(b);
                if (this.net?.open) this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 5, color: ENEMY_COLORS.raider });
              }
              audio.eshoot();
            }
          }
        }
        break;
      }
      case "mortar": {
        // Artillery miniboss — slow arcing bombs
        if (e.y < 100) e.y += 75 * dt;
        else {
          e.x = this.W / 2 + Math.sin(e.t * 0.35) * Math.max(80, this.W / 2 - 160);
          e.shootT -= dt;
          if (e.shootT <= 0) {
            e.shootT = 1.05;
            const p = this.nearestPlayer(e.x, e.y);
            for (let i = -3; i <= 3; i++) {
              const targetX = (p ? p.x : this.W / 2) + i * 40;
              const targetY = p ? p.y : this.H - 100;
              const a = Math.atan2(targetY - e.y, targetX - e.x);
              const sp = Math.min(240, 150 + w * 4);
              const b: Bullet = {
                x: e.x, y: e.y + 10, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
                dmg: 1, r: 8, from: "e", color: ENEMY_COLORS.mortar,
              };
              this.bullets.push(b);
              if (this.net?.open) this.net.send({ t: "eshot", x: b.x, y: b.y, vx: b.vx, vy: b.vy, r: 8, color: ENEMY_COLORS.mortar });
            }
            audio.eshoot();
          }
        }
        break;
      }
    }
  }

  private killEnemy(e: Enemy) {
    if (e.dead) return;
    e.dead = true;
    this.kills++;
    this.combo++;
    this.bestCombo = Math.max(this.bestCombo, this.combo);
    this.comboT = 2.2;
    const gained = Math.round((ENEMY_SCORE[e.type] ?? 100) * this.mult);
    this.score += gained;
    const c = ENEMY_COLORS[e.type] ?? "#ff4d8f";
    this.pop(e.x, e.y, `+${gained}`, this.mult > 1 ? "#ffd23f" : "#eaf6ff");
    this.explode(e.x, e.y, c, isBossKind(e.type) ? 3 : isMinibossKind(e.type) ? 2.2 : e.type === "tank" ? 1.6 : 1);
    if (isBossKind(e.type)) {
      this.shake = Math.min(32, this.shake + 20);
      this.flashWhite = 0.6;
      // Bosses drop one guaranteed weapon only (was two)
      this.dropPickup(e.x, e.y, WEAPON_TYPES[Math.floor(Math.random() * WEAPON_TYPES.length)]);
      this.pop(e.x, e.y - 40, "BOSS DOWN!", ENEMY_COLORS[e.type] ?? "#ff2d78", true);
    } else if (isMinibossKind(e.type)) {
      this.shake = Math.min(24, this.shake + 12);
      if (Math.random() < 0.55) {
        this.dropPickup(e.x, e.y, WEAPON_TYPES[Math.floor(Math.random() * WEAPON_TYPES.length)]);
      }
      this.pop(e.x, e.y - 36, "MINI DOWN!", ENEMY_COLORS[e.type] ?? "#8338ec", true);
    } else {
      // Lower drop rate — gear is scarce
      const dropChance = Math.min(0.14, 0.06 + this.wave * 0.0025);
      if (Math.random() < dropChance) {
        const roll = Math.random();
        let type: PickType;
        if (roll < 0.55) {
          type = WEAPON_TYPES[Math.floor(Math.random() * WEAPON_TYPES.length)];
        } else if (roll < 0.8) type = "B";
        else type = "H";
        this.dropPickup(e.x, e.y, type);
      }
    }
  }

  private dropPickup(x: number, y: number, type: PickType) {
    this.picks.push({ id: this.idc++, type, x, y, t: 0, tx: x, ty: y });
  }

  /* ---------------- hiệu ứng ---------------- */

  private explode(x: number, y: number, color: string, power: number) {
    // Cải thiện hiệu suất: giảm số particle nhưng vẫn giữ hiệu ứng đẹp
    const n = Math.floor(8 + power * 7); // giảm từ 10+ xuống 8+
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const sp = rand(40, 130 + power * 130);
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.25, 0.6), max: 0.6, size: rand(1.5, 3.2), // giảm thời gian sống và kích thước
        color: Math.random() < 0.25 ? "#ffffff" : color, kind: "spark",
      });
    }
    for (let i = 0; i < 2 + power; i++) { // giảm số puff
      this.parts.push({
        x: x + rand(-8, 8), y: y + rand(-8, 8), vx: rand(-30, 30), vy: rand(-50, -10),
        life: rand(0.35, 0.7), max: 0.7, size: rand(4, 9 + power * 3), // giảm kích thước
        color: "#5a6aa0", kind: "puff",
      });
    }
    this.parts.push({ x, y, vx: 0, vy: 0, life: 0.35, max: 0.35, size: 5, color, kind: "ring" });
    this.shake = Math.min(30, this.shake + 2 + power * 3.5);
    // Tối ưu: giới hạn particle nghiêm ngặt hơn
    if (this.parts.length > 350) this.parts.splice(0, this.parts.length - 350);
    audio.boom(power);
  }

  private sparks(x: number, y: number, color: string, n: number) {
    for (let i = 0; i < n; i++) {
      const a = rand(0, TAU);
      const sp = rand(30, 150);
      this.parts.push({
        x, y, vx: Math.cos(a) * sp, vy: Math.sin(a) * sp,
        life: rand(0.12, 0.3), max: 0.3, size: rand(1, 2.4), color, kind: "spark",
      });
    }
  }

  private ring(x: number, y: number, color: string) {
    this.parts.push({ x, y, vx: 0, vy: 0, life: 0.45, max: 0.45, size: 6, color, kind: "ring" });
  }

  private pop(x: number, y: number, text: string, color: string, big = false) {
    this.pops.push({ x, y, text, color, t: 0, life: 0.9, big });
    if (this.pops.length > 40) this.pops.shift();
  }

  private showBanner(text: string, sub: string, color: string) {
    this.banner = { text, sub, t: 0, life: 2.1, color };
  }

  private setPhase(p: Phase, stats?: OverStats) {
    if (this.phase === p) return;
    this.phase = p;
    this.cb.onPhase(p, stats);
  }

  /* ---------------- vẽ ---------------- */

  private draw() {
    const c = this.ctx;
    const { W, H } = this;

    // nền
    c.fillStyle = "#05060f";
    c.fillRect(0, 0, W, H);
    const g = c.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, "#070b1e");
    g.addColorStop(0.5, "#05060f");
    g.addColorStop(1, "#0b0820");
    c.fillStyle = g;
    c.fillRect(0, 0, W, H);

    const n1 = c.createRadialGradient(W * 0.22, H * 0.28, 0, W * 0.22, H * 0.28, W * 0.5);
    n1.addColorStop(0, "rgba(255,45,120,0.07)");
    n1.addColorStop(1, "rgba(255,45,120,0)");
    c.fillStyle = n1;
    c.fillRect(0, 0, W, H);
    const n2 = c.createRadialGradient(W * 0.82, H * 0.68, 0, W * 0.82, H * 0.68, W * 0.45);
    n2.addColorStop(0, "rgba(0,240,255,0.06)");
    n2.addColorStop(1, "rgba(0,240,255,0)");
    c.fillStyle = n2;
    c.fillRect(0, 0, W, H);

    // sao
    for (const s of this.stars) {
      const tw = 0.5 + 0.5 * Math.sin(this.now * 2 + s.tw);
      const alpha = (0.25 + s.z * 0.3) * (0.6 + 0.4 * tw);
      c.fillStyle = s.z === 2 ? `rgba(200,235,255,${alpha})` : `rgba(150,180,240,${alpha})`;
      c.fillRect(s.x, s.y, s.r * (0.6 + s.z * 0.4), s.r * (0.6 + s.z * 0.4) * (s.z === 2 ? 2.4 : 1));
    }

    c.save();
    if (this.shake > 0.2) {
      c.translate(rand(-this.shake, this.shake) * 0.5, rand(-this.shake, this.shake) * 0.5);
    }

    if (this.phase !== "menu" && this.phase !== "connecting") {
      this.drawPickups(c);
      this.drawEnemies(c);
      this.drawShips(c);
      this.drawBullets(c);
    }
    this.drawParticles(c);
    this.drawPops(c);
    this.drawBanner(c);
    c.restore();

    // flash
    if (this.flashRed > 0) {
      c.fillStyle = `rgba(255,45,90,${this.flashRed * 0.28})`;
      c.fillRect(0, 0, W, H);
    }
    if (this.flashWhite > 0) {
      c.fillStyle = `rgba(255,255,255,${this.flashWhite * 0.5})`;
      c.fillRect(0, 0, W, H);
    }
  }

  private drawShips(c: CanvasRenderingContext2D) {
    for (const s of this.players.values()) {
      if (!s.alive) continue;
      const blink = s.inv > 0 && Math.floor(this.now * 16) % 2 === 0;
      c.save();
      c.globalAlpha = blink ? 0.35 : 1;
      c.translate(s.x, s.y);
      c.rotate(clamp(s.vx * 0.00055, -0.24, 0.24));

      // lửa động cơ
      const fl = 12 + Math.sin(this.now * 42 + s.x) * 4;
      c.globalCompositeOperation = "lighter";
      const fg = c.createLinearGradient(0, 12, 0, 12 + fl + 10);
      fg.addColorStop(0, "rgba(255,210,63,0.9)");
      fg.addColorStop(1, "rgba(255,45,120,0)");
      c.fillStyle = fg;
      c.beginPath();
      c.moveTo(-5, 12);
      c.lineTo(0, 12 + fl + 8);
      c.lineTo(5, 12);
      c.closePath();
      c.fill();
      c.globalCompositeOperation = "source-over";

      // thân
      c.shadowColor = s.color;
      c.shadowBlur = 16;
      const hg = c.createLinearGradient(0, -20, 0, 14);
      hg.addColorStop(0, "#ffffff");
      hg.addColorStop(0.35, s.color);
      hg.addColorStop(1, "#101735");
      c.fillStyle = hg;
      c.beginPath();
      c.moveTo(0, -20);
      c.lineTo(4, -6);
      c.lineTo(17, 8);
      c.lineTo(17, 13);
      c.lineTo(6, 9);
      c.lineTo(3, 14);
      c.lineTo(-3, 14);
      c.lineTo(-6, 9);
      c.lineTo(-17, 13);
      c.lineTo(-17, 8);
      c.lineTo(-4, -6);
      c.closePath();
      c.fill();
      c.shadowBlur = 0;
      c.strokeStyle = hexA(s.color, 0.9);
      c.lineWidth = 1.4;
      c.stroke();
      c.fillStyle = "#0b1030";
      c.beginPath();
      c.ellipse(0, -6, 3, 6, 0, 0, TAU);
      c.fill();
      c.restore();

      // tên
      c.save();
      c.font = "600 10px 'Chakra Petch', sans-serif";
      c.textAlign = "center";
      c.fillStyle = hexA(s.color, 0.85);
      c.fillText(s.name, s.x, s.y + 30);
      c.restore();
    }
  }

  private drawEnemies(c: CanvasRenderingContext2D) {
    for (const e of this.enemies) {
      const col = ENEMY_COLORS[e.type] ?? "#ff4d8f";
      c.save();
      c.translate(e.x, e.y);
      if (e.flash > 0) {
        c.shadowColor = "#ffffff";
        c.shadowBlur = 22;
      } else {
        c.shadowColor = col;
        c.shadowBlur = 10;
      }
      const body = e.flash > 0 ? "#ffffff" : col;
      switch (e.type) {
        case "drone": {
          c.rotate(Math.sin(e.t * 3 + e.phase) * 0.2);
          c.fillStyle = body;
          c.beginPath();
          c.moveTo(0, 14);
          c.lineTo(12, -8);
          c.lineTo(5, -4);
          c.lineTo(0, -12);
          c.lineTo(-5, -4);
          c.lineTo(-12, -8);
          c.closePath();
          c.fill();
          c.fillStyle = "#2b0f22";
          c.beginPath();
          c.arc(0, 0, 3.4, 0, TAU);
          c.fill();
          break;
        }
        case "dart": {
          const ang = Math.atan2(e.dashVy || 1, e.dashVx || 0);
          c.rotate(e.t > 0.9 ? ang - Math.PI / 2 : 0);
          c.fillStyle = body;
          c.beginPath();
          c.moveTo(0, 15);
          c.lineTo(5, -11);
          c.lineTo(0, -5);
          c.lineTo(-5, -11);
          c.closePath();
          c.fill();
          break;
        }
        case "spinner": {
          c.rotate(e.t * 3.4);
          c.fillStyle = body;
          for (let i = 0; i < 4; i++) {
            c.rotate(Math.PI / 2);
            c.fillRect(-3, -16, 6, 13);
          }
          c.beginPath();
          c.arc(0, 0, 6, 0, TAU);
          c.fill();
          c.fillStyle = "#0c2410";
          c.beginPath();
          c.arc(0, 0, 3, 0, TAU);
          c.fill();
          break;
        }
        case "tank": {
          c.fillStyle = body;
          c.beginPath();
          c.moveTo(-20, 0);
          c.lineTo(-12, -14);
          c.lineTo(12, -14);
          c.lineTo(20, 0);
          c.lineTo(12, 12);
          c.lineTo(-12, 12);
          c.closePath();
          c.fill();
          c.fillStyle = "#1c0f33";
          c.beginPath();
          c.arc(0, 0, 6, 0, TAU);
          c.fill();
          c.fillStyle = body;
          c.fillRect(-2.4, 0, 4.8, 14);
          break;
        }
        case "boss": {
          const pul = 1 + Math.sin(this.now * 5) * 0.04;
          c.scale(pul, pul);
          c.fillStyle = body;
          c.beginPath();
          for (let i = 0; i < 6; i++) {
            const a = (i / 6) * TAU + Math.PI / 6;
            const px = Math.cos(a) * 52;
            const py = Math.sin(a) * 38;
            if (i === 0) c.moveTo(px, py);
            else c.lineTo(px, py);
          }
          c.closePath();
          c.fill();
          c.strokeStyle = hexA(col, 0.8);
          c.lineWidth = 3;
          c.stroke();
          // vòng xoay
          c.rotate(this.now * 1.6);
          c.strokeStyle = "rgba(255,210,63,0.75)";
          c.lineWidth = 2.4;
          c.setLineDash([10, 12]);
          c.beginPath();
          c.arc(0, 0, 26, 0, TAU);
          c.stroke();
          c.setLineDash([]);
          c.rotate(-this.now * 1.6);
          // lõi
          const cg = c.createRadialGradient(0, 0, 0, 0, 0, 16);
          cg.addColorStop(0, "#ffffff");
          cg.addColorStop(0.5, "#ffd23f");
          cg.addColorStop(1, "rgba(255,45,120,0.2)");
          c.fillStyle = cg;
          c.beginPath();
          c.arc(0, 0, 15, 0, TAU);
          c.fill();
          break;
        }
        case "wraith": {
          // wraith - hình tam giác mờ, trong suốt
          c.globalAlpha = 0.6 + Math.sin(e.t * 8) * 0.2;
          c.fillStyle = body;
          c.beginPath();
          c.moveTo(0, 14);
          c.lineTo(9, -10);
          c.lineTo(-9, -10);
          c.closePath();
          c.fill();
          c.globalAlpha = 1;
          // mắt sáng
          c.fillStyle = "#ffffff";
          c.beginPath();
          c.arc(0, -2, 2.5, 0, TAU);
          c.fill();
          break;
        }
        case "bomber": {
          // bomber - hình tròn với các gai nhọn
          c.fillStyle = body;
          c.beginPath();
          const spikes = 8;
          for (let i = 0; i < spikes * 2; i++) {
            const r = i % 2 === 0 ? 16 : 8;
            const a = (i / (spikes * 2)) * TAU - Math.PI / 2;
            const x = Math.cos(a) * r;
            const y = Math.sin(a) * r;
            if (i === 0) c.moveTo(x, y);
            else c.lineTo(x, y);
          }
          c.closePath();
          c.fill();
          // thân tối ở giữa
          c.fillStyle = "#3d1f0a";
          c.beginPath();
          c.arc(0, 0, 7, 0, TAU);
          c.fill();
          break;
        }
        case "splitter": {
          // splitter - hình thoi xoay
          c.rotate(e.t * 2.5);
          c.fillStyle = body;
          c.beginPath();
          c.moveTo(0, -14);
          c.lineTo(10, 0);
          c.lineTo(0, 14);
          c.lineTo(-10, 0);
          c.closePath();
          c.fill();
          // lõi nhỏ
          c.fillStyle = "#2a0f33";
          c.beginPath();
          c.arc(0, 0, 4, 0, TAU);
          c.fill();
          c.rotate(-e.t * 2.5);
          break;
        }
        case "hunter": {
          // hunter - mũi tên đỏ追踪
          const ang = Math.atan2(e.y - (this.me?.y || 0), e.x - (this.me?.x || 0));
          c.rotate(ang + Math.PI / 2);
          c.fillStyle = body;
          c.beginPath();
          c.moveTo(0, 13);
          c.lineTo(7, -8);
          c.lineTo(0, -3);
          c.lineTo(-7, -8);
          c.closePath();
          c.fill();
          // vệt đuôi
          c.fillStyle = hexA(body, 0.4);
          c.beginPath();
          c.moveTo(0, 10);
          c.lineTo(5, -12);
          c.lineTo(-5, -12);
          c.closePath();
          c.fill();
          c.rotate(-ang - Math.PI / 2);
          break;
        }
        case "sentinel": {
          // sentinel - khối vuông lớn với nòng súng
          c.fillStyle = body;
          c.fillRect(-14, -14, 28, 28);
          // nòng súng
          c.fillStyle = "#1a2340";
          c.fillRect(-4, 0, 8, 16);
          // lõi xanh
          c.fillStyle = "#00ffff";
          c.beginPath();
          c.arc(0, 0, 5, 0, TAU);
          c.fill();
          break;
        }
        case "miniboss": {
          const pul = 1 + Math.sin(this.now * 4) * 0.03;
          c.scale(pul, pul);
          c.fillStyle = body;
          c.beginPath();
          for (let i = 0; i < 10; i++) {
            const r = i % 2 === 0 ? 32 : 14;
            const a = (i / 10) * TAU - Math.PI / 2;
            const x = Math.cos(a) * r;
            const y = Math.sin(a) * r;
            if (i === 0) c.moveTo(x, y);
            else c.lineTo(x, y);
          }
          c.closePath();
          c.fill();
          c.strokeStyle = hexA(col, 0.7);
          c.lineWidth = 2;
          c.stroke();
          c.fillStyle = "#ff6b35";
          c.beginPath();
          c.arc(0, 0, 10, 0, TAU);
          c.fill();
          c.scale(1 / pul, 1 / pul);
          break;
        }
        case "hydra": {
          const pul = 1 + Math.sin(this.now * 5) * 0.04;
          c.scale(pul, pul);
          c.fillStyle = body;
          // dual lobes
          for (const side of [-1, 1] as const) {
            c.beginPath();
            c.ellipse(side * 28, 0, 26, 32, 0, 0, TAU);
            c.fill();
          }
          c.beginPath();
          c.ellipse(0, 4, 22, 28, 0, 0, TAU);
          c.fill();
          c.fillStyle = "#ffffff";
          c.beginPath(); c.arc(-28, -6, 5, 0, TAU); c.fill();
          c.beginPath(); c.arc(28, -6, 5, 0, TAU); c.fill();
          c.fillStyle = "#1a0010";
          c.beginPath(); c.arc(-28, -6, 2.2, 0, TAU); c.fill();
          c.beginPath(); c.arc(28, -6, 2.2, 0, TAU); c.fill();
          c.scale(1 / pul, 1 / pul);
          break;
        }
        case "prism": {
          c.rotate(this.now * 1.2);
          c.fillStyle = body;
          c.beginPath();
          for (let i = 0; i < 3; i++) {
            const a = (i / 3) * TAU - Math.PI / 2;
            const x = Math.cos(a) * 42;
            const y = Math.sin(a) * 42;
            if (i === 0) c.moveTo(x, y); else c.lineTo(x, y);
          }
          c.closePath();
          c.fill();
          c.strokeStyle = "#ffffff";
          c.lineWidth = 2;
          c.stroke();
          c.fillStyle = "#eaffff";
          c.beginPath(); c.arc(0, 0, 10, 0, TAU); c.fill();
          c.rotate(-this.now * 1.2);
          break;
        }
        case "serpent": {
          c.fillStyle = body;
          for (let i = 0; i < 5; i++) {
            const ox = Math.sin(this.now * 3 + i) * 6;
            c.beginPath();
            c.ellipse(ox, -i * 14 + 20, 18 - i * 2, 12, 0, 0, TAU);
            c.fill();
          }
          c.fillStyle = "#1a1400";
          c.beginPath(); c.arc(0, 22, 6, 0, TAU); c.fill();
          break;
        }
        case "fortress": {
          c.fillStyle = body;
          c.fillRect(-48, -28, 96, 56);
          c.fillStyle = hexA("#0a0618", 0.55);
          c.fillRect(-36, -16, 72, 32);
          c.fillStyle = "#ffd23f";
          c.fillRect(-6, 8, 12, 28);
          c.beginPath(); c.arc(0, 0, 12, 0, TAU); c.fill();
          break;
        }
        case "raider": {
          c.rotate(Math.sin(e.t * 2) * 0.15);
          c.fillStyle = body;
          c.beginPath();
          c.moveTo(0, 28);
          c.lineTo(22, -18);
          c.lineTo(0, -8);
          c.lineTo(-22, -18);
          c.closePath();
          c.fill();
          c.fillStyle = "#2a0c00";
          c.beginPath(); c.arc(0, 0, 7, 0, TAU); c.fill();
          break;
        }
        case "mortar": {
          c.fillStyle = body;
          c.beginPath();
          c.moveTo(-30, 10);
          c.lineTo(-18, -22);
          c.lineTo(18, -22);
          c.lineTo(30, 10);
          c.lineTo(12, 22);
          c.lineTo(-12, 22);
          c.closePath();
          c.fill();
          c.fillStyle = "#0a1628";
          c.fillRect(-5, -8, 10, 26);
          break;
        }
      }
      c.restore();

      // thanh máu nhỏ (bosses use HUD bar)
      if (!isBossKind(e.type) && e.hp < e.maxHp && e.maxHp > 1) {
        const wBar = 30;
        c.fillStyle = "rgba(5,6,15,0.7)";
        c.fillRect(e.x - wBar / 2, e.y - ENEMY_R[e.type] - 12, wBar, 4);
        c.fillStyle = "#ff2d78";
        c.fillRect(e.x - wBar / 2, e.y - ENEMY_R[e.type] - 12, (wBar * Math.max(0, e.hp)) / e.maxHp, 4);
      }
    }
  }

  private drawBullets(c: CanvasRenderingContext2D) {
    c.save();
    c.globalCompositeOperation = "lighter";
    for (const b of this.bullets) {
      if (b.from === "p") {
        c.strokeStyle = hexA(b.color, 0.5);
        c.lineWidth = b.homing ? 3 : 2;
        c.beginPath();
        c.moveTo(b.x - b.vx * 0.018, b.y - b.vy * 0.018);
        c.lineTo(b.x, b.y);
        c.stroke();
        c.fillStyle = b.color;
        c.beginPath();
        if (b.homing) c.arc(b.x, b.y, 5, 0, TAU);
        else {
          c.ellipse(b.x, b.y, 2.6, 7, Math.atan2(b.vy, b.vx) + Math.PI / 2, 0, TAU);
        }
        c.fill();
      } else {
        c.fillStyle = hexA(b.color, 0.35);
        c.beginPath();
        c.arc(b.x, b.y, b.r + 3.5, 0, TAU);
        c.fill();
        c.fillStyle = b.color;
        c.beginPath();
        c.arc(b.x, b.y, b.r, 0, TAU);
        c.fill();
        c.fillStyle = "#ffffff";
        c.beginPath();
        c.arc(b.x, b.y, b.r * 0.4, 0, TAU);
        c.fill();
      }
    }
    c.restore();
  }

  private drawPickups(c: CanvasRenderingContext2D) {
    for (const p of this.picks) {
      // Màu sắc cho từng loại vật phẩm mới
      let col: string;
      let label: string;
      switch (p.type) {
        case "pulse": col = "#9ffbff"; label = "P"; break;
        case "spread": col = "#ffd23f"; label = "S"; break;
        case "laser": col = "#ff4dff"; label = "L"; break;
        case "missile": col = "#b45cff"; label = "M"; break;
        case "sidewinder": col = "#00ffff"; label = "W"; break;
        case "plasma": col = "#7dff5e"; label = "P+"; break;
        case "burst": col = "#ff9d2e"; label = "B"; break;
        case "orbit": col = "#ff6b35"; label = "O"; break;
        case "rail": col = "#ffffff"; label = "R"; break;
        case "nova": col = "#ff2d78"; label = "N"; break;
        case "B": col = "#ff2d78"; label = "B"; break;
        case "H": col = "#7dff5e"; label = "H"; break;
        default: col = "#ffffff"; label = "?";
      }
      c.save();
      c.translate(p.x, p.y);
      const pul = 1 + Math.sin(p.t * 6) * 0.12;
      c.scale(pul, pul);
      c.rotate(Math.sin(p.t * 3) * 0.3);
      c.shadowColor = col;
      c.shadowBlur = 14;
      c.fillStyle = hexA(col, 0.25);
      c.beginPath();
      c.moveTo(0, -13);
      c.lineTo(11, 0);
      c.lineTo(0, 13);
      c.lineTo(-11, 0);
      c.closePath();
      c.fill();
      c.strokeStyle = col;
      c.lineWidth = 2;
      c.stroke();
      c.shadowBlur = 0;
      c.rotate(-Math.sin(p.t * 3) * 0.3);
      c.fillStyle = col;
      c.font = "9px 'Press Start 2P', monospace";
      c.textAlign = "center";
      c.textBaseline = "middle";
      c.fillText(label, 0, 1);
      c.restore();
    }
  }

  private drawParticles(c: CanvasRenderingContext2D) {
    for (const p of this.parts) {
      p.life -= 0; // life giảm trong update; giữ nguyên ở draw
      const a = Math.max(0, p.life / p.max);
      if (p.kind === "spark") {
        c.globalCompositeOperation = "lighter";
        c.fillStyle = hexA(p.color.startsWith("#") ? p.color : "#ffffff", a);
        c.fillRect(p.x - p.size / 2, p.y - p.size / 2, p.size, p.size);
        c.globalCompositeOperation = "source-over";
      } else if (p.kind === "puff") {
        c.fillStyle = hexA(p.color.startsWith("#") ? p.color : "#5a6aa0", a * 0.35);
        c.beginPath();
        c.arc(p.x, p.y, p.size * (1.6 - a * 0.6), 0, TAU);
        c.fill();
      } else if (p.kind === "ring") {
        c.globalCompositeOperation = "lighter";
        const r = p.size + (1 - a) * 90;
        c.strokeStyle = hexA(p.color.startsWith("#") ? p.color : "#ffffff", a * 0.9);
        c.lineWidth = 2 + a * 3;
        c.beginPath();
        c.arc(p.x, p.y, r, 0, TAU);
        c.stroke();
        c.globalCompositeOperation = "source-over";
      } else {
        // streak
        c.strokeStyle = hexA("#9fd8ff", a * 0.7);
        c.lineWidth = p.size;
        c.beginPath();
        c.moveTo(p.x - p.vx * 0.05, p.y - p.vy * 0.05);
        c.lineTo(p.x, p.y);
        c.stroke();
      }
    }
  }

  private drawPops(c: CanvasRenderingContext2D) {
    for (const p of this.pops) {
      const a = 1 - p.t / p.life;
      c.save();
      c.globalAlpha = Math.max(0, a);
      c.font = p.big ? "13px 'Press Start 2P', monospace" : "9px 'Press Start 2P', monospace";
      c.textAlign = "center";
      c.fillStyle = "#05060f";
      c.fillText(p.text, p.x + 2, p.y - p.t * 46 + 2);
      c.fillStyle = p.color;
      c.fillText(p.text, p.x, p.y - p.t * 46);
      c.restore();
    }
  }

  private drawBanner(c: CanvasRenderingContext2D) {
    if (!this.banner) return;
    const b = this.banner;
    const aIn = Math.min(1, b.t / 0.18);
    const aOut = Math.min(1, (b.life - b.t) / 0.4);
    const alpha = Math.max(0, Math.min(aIn, aOut));
    const scale = 1 + (1 - aIn) * 0.6;
    c.save();
    c.globalAlpha = alpha;
    c.translate(this.W / 2, this.H * 0.34);
    c.scale(scale, scale);
    c.font = "30px 'Press Start 2P', monospace";
    c.textAlign = "center";
    c.fillStyle = "#05060f";
    c.fillText(b.text, 4, 4);
    c.fillStyle = b.color;
    c.shadowColor = b.color;
    c.shadowBlur = 22;
    c.fillText(b.text, 0, 0);
    c.shadowBlur = 0;
    if (b.sub) {
      c.font = "600 15px 'Chakra Petch', sans-serif";
      c.fillStyle = "#eaf6ff";
      c.fillText(b.sub, 0, 34);
    }
    c.restore();
  }
}

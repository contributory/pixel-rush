/* ============================================================
   PIXEL RUSH — types
   Type definitions and interfaces for the game engine
   ============================================================ */

import type { PeerInfo } from "./net";

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

/* ---------------- entity types ---------------- */
export interface Bullet {
  x: number; y: number; vx: number; vy: number;
  dmg: number; r: number; from: "p" | "e"; color: string;
  homing?: boolean; dead?: boolean;
}

export type EnemyType = "drone" | "dart" | "spinner" | "tank" | "boss" | "hydra" | "prism" | "serpent" | "fortress" | "wraith" | "bomber" | "splitter" | "hunter" | "sentinel" | "miniboss" | "raider" | "mortar";

export interface Enemy {
  id: number; type: EnemyType;
  x: number; y: number;
  hp: number; maxHp: number;
  t: number; flash: number; shootT: number;
  baseX: number; anchorY: number; phase: number;
  dashVx: number; dashVy: number; burst: number;
  // guest-side interpolation
  tx: number; ty: number; thp: number;
  dead?: boolean;
}

export type WeaponType = "pulse" | "spread" | "laser" | "missile" | "sidewinder" | "plasma" | "burst" | "orbit" | "rail" | "nova";

export type PickType = WeaponType | "B" | "H";

export interface Pickup {
  id: number; type: PickType; x: number; y: number; t: number;
  tx: number; ty: number; dead?: boolean;
}

export interface Particle {
  x: number; y: number; vx: number; vy: number;
  life: number; max: number; size: number; color: string;
  kind: "spark" | "puff" | "ring" | "streak";
}

export interface Pop {
  x: number; y: number; text: string; color: string; t: number; life: number; big?: boolean;
}

export interface ShipState {
  id: string; name: string; color: string;
  x: number; y: number; vx: number;
  alive: boolean; lives: number; weapons: WeaponType[]; bombs: number;
  firing: boolean; cool: number; inv: number; respawn: number;
  tx: number; ty: number;
}

export interface SpawnEntry { at: number; type: EnemyType; x: number; phase: number }

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

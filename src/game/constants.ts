/* ============================================================
   PIXEL RUSH — constants
   Game constants, configuration data, and lookup tables
   ============================================================ */

import type { WeaponType, EnemyType } from "./types";

export const TAU = Math.PI * 2;
export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const rand = (a: number, b: number) => a + Math.random() * (b - a);
export const irand = (a: number, b: number) => Math.floor(rand(a, b + 1));

export function hexA(hex: string, a: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

export const PALETTE = ["#00f0ff", "#ff2d78", "#ffd23f", "#7dff5e"];

export const ENEMY_COLORS: Record<string, string> = {
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

export const ENEMY_SCORE: Record<string, number> = {
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

export const ENEMY_R: Record<string, number> = {
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
export const BOSS_TYPES = ["boss", "hydra", "prism", "serpent", "fortress"] as const;
/** Mid-tier bosses (wave multiples of 5, not 10). */
export const MINIBOSS_TYPES = ["miniboss", "raider", "mortar"] as const;

export function isBossKind(t: string): boolean {
  return (BOSS_TYPES as readonly string[]).includes(t);
}

export function isMinibossKind(t: string): boolean {
  return (MINIBOSS_TYPES as readonly string[]).includes(t);
}

export const WEAPON_TYPES: WeaponType[] = ["pulse", "spread", "laser", "missile", "sidewinder", "plasma", "burst", "orbit", "rail", "nova"];

export const WEAPON_LABEL: Record<WeaponType, string> = {
  pulse: "PULSE", spread: "SPREAD", laser: "LASER", missile: "MISSILE", sidewinder: "SIDEWINDER",
  plasma: "PLASMA", burst: "BURST", orbit: "ORBIT", rail: "RAIL", nova: "NOVA",
};

/** Storage keys */
export const HI_KEY = "pixelrush-hiscore";
export const PROFILE_KEY = "pixelrush-profile";

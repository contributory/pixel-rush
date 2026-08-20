import { useEffect, useRef, useState } from "react";
import {
  Engine,
  loadPlayerProfile,
  type HudData,
  type NetInfo,
  type OverStats,
  type Phase,
  type PlayerProfile,
} from "./game/engine";
import { audio, type BgmSource } from "./game/audio";
import { defaultWsUrl, fetchRooms, normalizeWsOrigin, type RoomInfo } from "./game/net";

/* ================= SVG icons (no emoji) ================= */

function ShipIcon({ color, size = 14 }: { color: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path
        d="M12 2 L14 9 L22 17 L15 15.5 L12 22 L9 15.5 L2 17 L10 9 Z"
        fill={color}
        stroke="rgba(255,255,255,0.35)"
        strokeWidth="0.8"
      />
    </svg>
  );
}

function BombIcon({ size = 11 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden>
      <path d="M12 2 L20 12 L12 22 L4 12 Z" fill="#ff2d78" stroke="#ffffff" strokeWidth="1" strokeOpacity="0.4" />
    </svg>
  );
}

function EnemyGlyph({ type }: { type: string }) {
  const common = { width: 26, height: 26, viewBox: "0 0 24 24" } as const;
  switch (type) {
    case "drone":
      return (
        <svg {...common}>
          <path d="M12 21 L21 7 L16 10 L12 4 L8 10 L3 7 Z" fill="#ff4d8f" />
        </svg>
      );
    case "dart":
      return (
        <svg {...common}>
          <path d="M12 22 L16 4 L12 9 L8 4 Z" fill="#ff9d2e" />
        </svg>
      );
    case "spinner":
      return (
        <svg {...common}>
          <path d="M10 2 h4 v7 h7 v4 h-7 v7 h-4 v-7 H3 v-4 h7 Z" fill="#7dff5e" />
        </svg>
      );
    case "tank":
      return (
        <svg {...common}>
          <path d="M4 12 L8 4 H16 L20 12 L16 20 H8 Z" fill="#b45cff" />
          <circle cx="12" cy="12" r="3" fill="#1c0f33" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M12 2 L21 7 V17 L12 22 L3 17 V7 Z" fill="#ff2d78" />
          <circle cx="12" cy="12" r="4" fill="#ffd23f" />
        </svg>
      );
  }
}

function PowerGlyph({ type }: { type: "W" | "B" | "H" }) {
  const col = type === "W" ? "#ffd23f" : type === "B" ? "#ff2d78" : "#7dff5e";
  return (
    <svg width={22} height={22} viewBox="0 0 24 24" aria-hidden>
      <path d="M12 2 L22 12 L12 22 L2 12 Z" fill="none" stroke={col} strokeWidth="2" />
      <text x="12" y="16" textAnchor="middle" fontSize="10" fontFamily="'Press Start 2P', monospace" fill={col}>
        {type}
      </text>
    </svg>
  );
}

function SpeakerIcon({ muted }: { muted: boolean }) {
  return (
    <svg width={16} height={16} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <path d="M4 9 v6 h4 l5 4 V5 L8 9 Z" fill="currentColor" stroke="none" />
      {muted ? (
        <path d="M16 9 l5 6 M21 9 l-5 6" strokeLinecap="round" />
      ) : (
        <path d="M16.5 8.5 a5 5 0 0 1 0 7 M19 6 a8.5 8.5 0 0 1 0 12" strokeLinecap="round" />
      )}
    </svg>
  );
}

function CopyIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="9" y="9" width="12" height="12" rx="1" />
      <path d="M5 15 H4 a1 1 0 0 1 -1 -1 V4 a1 1 0 0 1 1 -1 h10 a1 1 0 0 1 1 1 v1" />
    </svg>
  );
}

function DiceIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="15.5" cy="8.5" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="8.5" cy="15.5" r="1.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" aria-hidden>
      <path d="M21 12 a9 9 0 1 1 -2.6 -6.3" strokeLinecap="round" />
      <path d="M21 3 v5 h-5" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function EqBars() {
  return (
    <span className="inline-flex items-end gap-[2px] h-3" aria-hidden>
      {[0, 1, 2, 3].map((i) => (
        <span
          key={i}
          className="eq-bar w-[3px] bg-acid"
          style={{ height: "100%", animationDelay: `${i * 0.13}s` }}
        />
      ))}
    </span>
  );
}

function Key({ children }: { children: string }) {
  return <span className="keycap">{children}</span>;
}

function Radar({ size = 64 }: { size?: number }) {
  return (
    <div className="relative" style={{ width: size, height: size }}>
      <div className="absolute inset-0 border-2 border-line rounded-full" />
      <div className="absolute inset-0 rounded-full border-t-2 border-neon radar" />
      <div
        className="absolute rounded-full border-t-2 border-hot radar"
        style={{ inset: size * 0.19, animationDuration: "0.7s", animationDirection: "reverse" }}
      />
      <div className="absolute inset-0 flex items-center justify-center">
        <span className="w-1.5 h-1.5 bg-acid rounded-full glow-pulse" />
      </div>
    </div>
  );
}

/* ================= helpers ================= */

const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function genRoomCode(): string {
  let s = "";
  for (let i = 0; i < 5; i++) s += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  return s;
}

const TICKER =
  "INSERT COIN ▸ 1 CREDIT — 1 PLAY ▸ CO-OP UP TO 2 PILOTS OVER WEBSOCKET ▸ DENO RELAY — WS URL AUTO-DETECTED FROM PAGE ADDRESS ▸ BGM: PIXEL RUSH ▸ AUTO-FIRE ▸ K = BOMB ▸ BOSS EVERY 5TH WAVE ▸ ";

function Ticker() {
  return (
    <div className="relative overflow-hidden border-t border-line bg-deep/90 py-1.5 select-none">
      <div className="marquee-track">
        <span className="font-display text-[8px] tracking-widest text-dim pr-0">{TICKER.repeat(3)}</span>
        <span className="font-display text-[8px] tracking-widest text-dim pr-0">{TICKER.repeat(3)}</span>
      </div>
    </div>
  );
}

/* ================= menu ================= */

interface MenuProps {
  hud: HudData;
  name: string;
  setName: (v: string) => void;
  server: string;
  setServer: (v: string) => void;
  onAutoServer: () => void;
  mode: "create" | "join";
  setMode: (m: "create" | "join") => void;
  createdCode: string;
  rerollCode: () => void;
  joinCode: string;
  setJoinCode: (v: string) => void;
  joinErr: string | null;
  rooms: RoomInfo[];
  roomsErr: boolean;
  refreshRooms: () => void;
  onSolo: () => void;
  profile: PlayerProfile;
  onCreate: () => void;
  onJoin: (code: string) => void;
}

function MenuScreen(p: MenuProps) {
  return (
    <div className="absolute inset-0 z-30 flex flex-col overflow-y-auto scroll-slim">
      {/* cabinet top bar */}
      <div className="flex items-center justify-between px-5 sm:px-8 pt-4 pb-2">
        <div className="flex items-center gap-6 font-display text-[10px]">
          <span className="text-hot blink">1UP</span>
          <span className="text-dim">
            HI-SCORE <span className="text-gold">{String(p.hud.hi).padStart(7, "0")}</span>
          </span>
        </div>
        <div className="font-display text-[8px] text-dim hidden sm:block">CREDIT 01 — FREE PLAY</div>
      </div>

      <div className="flex-1 grid lg:grid-cols-[1.15fr_0.85fr] gap-8 items-start max-w-6xl w-full mx-auto px-5 sm:px-8 py-6">
        {/* ------ left: title + actions ------ */}
        <div className="slide-up">
          <div className="font-display text-[9px] text-neon tracking-widest mb-4">
            {"//"} NEON ARCADE SHOOT'EM UP <span className="blink">_</span>
          </div>
          <h1 className="title-float leading-none select-none">
            <span className="title-neon font-display block text-5xl sm:text-7xl xl:text-8xl">PIXEL</span>
            <span
              className="font-display block text-5xl sm:text-7xl xl:text-8xl text-gold ml-6 sm:ml-12"
              style={{ textShadow: "3px 3px 0 #ff2d78, 0 0 28px rgba(255,210,63,0.45)" }}
            >
              RUSH
            </span>
          </h1>

          <p className="mt-5 max-w-md text-dim text-sm sm:text-base font-medium leading-relaxed">
            Tear through enemy formations in a storm of neon bullets. Fly{" "}
            <span className="text-neon font-semibold">solo</span> or squad up —{" "}
            <span className="text-hot font-semibold">co-op for up to 2 pilots</span> over WebSocket. Shared
            score, shared bombs, shared fate.
          </p>

          <div className="mt-7 flex flex-col gap-3 max-w-md">
            {/* Pilot account — arsenal & wave persist across matches */}
            {(p.profile.wave > 1 || p.profile.weapons.length > 1 || p.profile.score > 0) && (
              <div className="panel-clip bg-panel/80 border border-gold/50 px-4 py-3">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-display text-[8px] text-gold tracking-wider">PILOT ACCOUNT</span>
                  <span className="font-display text-[7px] text-dim">NOT RESET EACH MATCH</span>
                </div>
                <div className="flex items-center justify-between font-display text-[9px]">
                  <span className="text-neon">WAVE {p.profile.wave}</span>
                  <span className="text-snow">SCORE {String(p.profile.score).padStart(7, "0")}</span>
                  <span className="text-acid">{p.profile.weapons.length} WPN</span>
                </div>
              </div>
            )}
            <button
              onClick={p.onSolo}
              className="btn-arcade panel-clip bg-neon text-ink text-sm px-6 py-4 flex items-center justify-between"
            >
              <span>▶ SOLO PLAY</span>
              <span className="text-[8px] opacity-70">1 PLAYER</span>
            </button>

            {/* ------ pilot display name (always editable) ------ */}
            <label className="panel-clip bg-panel/80 border border-line p-3 block">
              <div className="flex items-center justify-between mb-2">
                <span className="font-display text-[9px] text-neon tracking-wider">✎ PILOT NAME</span>
                <span className="font-display text-[7px] text-dim">SHOWN IN CO-OP</span>
              </div>
              <input
                value={p.name}
                onChange={(e) => p.setName(e.target.value.toUpperCase().slice(0, 12))}
                placeholder="YOUR NAME"
                maxLength={12}
                spellCheck={false}
                className="w-full bg-ink border border-line px-3 py-2.5 text-sm text-snow font-display tracking-wider placeholder:text-dim/50 focus:outline-none focus:border-neon"
              />
            </label>

            {/* ------ co-op: create / join ------ */}
            <div className="panel-clip bg-panel/80 border border-line p-3 mt-1">
              <div className="flex items-center justify-between mb-3">
                <span className="font-display text-[9px] text-hot tracking-wider">⚡ CO-OP SQUAD</span>
                <span className="font-display text-[7px] text-dim">UP TO 2 PILOTS</span>
              </div>

              <div className="grid grid-cols-2 gap-1 mb-3">
                {(["create", "join"] as const).map((m) => (
                  <button
                    key={m}
                    onClick={() => p.setMode(m)}
                    className={`font-display text-[9px] py-2 border transition-colors cursor-pointer ${
                      p.mode === m
                        ? "bg-hot text-ink border-hot"
                        : "bg-ink text-dim border-line hover:text-snow hover:border-hot/60"
                    }`}
                  >
                    {m === "create" ? "CREATE ROOM" : "JOIN ROOM"}
                  </button>
                ))}
              </div>

              {p.mode === "create" ? (
                <div className="slide-up">
                  <div className="flex items-center gap-2">
                    <div className="flex-1 bg-ink border border-gold/70 px-3 py-3 text-center">
                      <span className="font-display text-xl sm:text-2xl text-gold tracking-[0.3em]">
                        {p.createdCode}
                      </span>
                    </div>
                    <button
                      onClick={p.rerollCode}
                      title="Roll a new code"
                      className="btn-arcade panel-clip bg-ink text-dim hover:text-gold px-3 py-3.5 text-[9px] flex items-center gap-2"
                    >
                      <DiceIcon />
                    </button>
                  </div>
                  <button
                    onClick={p.onCreate}
                    className="btn-arcade panel-clip bg-hot text-ink text-[11px] px-5 py-3.5 mt-2 w-full flex items-center justify-between"
                  >
                    <span>CREATE ROOM ▸</span>
                    <span className="text-[7px] opacity-70">YOU BECOME HOST</span>
                  </button>
                  <p className="text-[10px] text-dim/80 mt-2 leading-snug">
                    Share the code — friends pick <b className="text-snow">JOIN ROOM</b> and type it in.
                  </p>
                  {p.joinErr && (
                    <div className="font-display text-[8px] text-hot mt-2">✕ {p.joinErr}</div>
                  )}
                </div>
              ) : (
                <div className="slide-up">
                  <div className="flex items-center gap-2">
                    <input
                      value={p.joinCode}
                      onChange={(e) => p.setJoinCode(e.target.value.toUpperCase().slice(0, 16))}
                      onKeyDown={(e) => e.key === "Enter" && p.onJoin(p.joinCode)}
                      placeholder="ROOM CODE"
                      spellCheck={false}
                      className="flex-1 bg-ink border border-line px-3 py-3 text-sm text-neon font-display tracking-[0.25em] placeholder:text-dim/50 placeholder:tracking-normal focus:outline-none focus:border-neon"
                    />
                    <button
                      onClick={() => p.onJoin(p.joinCode)}
                      className="btn-arcade panel-clip bg-neon text-ink text-[10px] px-4 py-3.5"
                    >
                      JOIN ▸
                    </button>
                  </div>
                  {p.joinErr && (
                    <div className="font-display text-[8px] text-hot mt-2">✕ {p.joinErr}</div>
                  )}
                </div>
              )}

              {/* connection settings */}
              <div className="grid sm:grid-cols-[1fr_1fr] gap-2 mt-3 pt-3 border-t border-line/70">
                <label className="block sm:col-span-2">
                  <span className="text-[10px] uppercase tracking-wider text-dim font-semibold">WS server</span>
                  <div className="flex items-center gap-1.5 mt-1">
                    <input
                      value={p.server}
                      onChange={(e) => p.setServer(e.target.value)}
                      spellCheck={false}
                      className="w-full bg-ink border border-line px-2 py-1.5 text-xs text-neon font-mono focus:outline-none focus:border-neon"
                    />
                    <button
                      onClick={p.onAutoServer}
                      title="Auto-detect from page address (same host, port 8000)"
                      className="btn-arcade shrink-0 text-[7px] px-2 py-2 bg-ink text-dim hover:text-neon"
                    >
                      AUTO
                    </button>
                  </div>
                </label>
              </div>
            </div>

            {/* ------ live rooms radar — always visible ------ */}
            <div className="panel-clip bg-panel/80 border border-line p-3 mt-1">
              <div className="flex items-center justify-between mb-2.5">
                <span className="flex items-center gap-2 font-display text-[9px] text-neon tracking-wider">
                  <span className={`w-1.5 h-1.5 rounded-full ${p.roomsErr ? "bg-hot" : "bg-acid glow-pulse"}`} />
                  LIVE ROOMS
                  <span className="text-[7px] text-dim">{p.roomsErr ? "OFFLINE" : `${p.rooms.length} OPEN`}</span>
                </span>
                <button
                  onClick={p.refreshRooms}
                  title="Scan for rooms"
                  className="btn-arcade text-[7px] px-2.5 py-1.5 bg-ink text-dim hover:text-neon flex items-center gap-1.5"
                >
                  <RefreshIcon /> SCAN
                </button>
              </div>

              {p.roomsErr ? (
                <p className="text-[10px] text-dim/80 leading-snug bg-ink/60 border border-line px-2.5 py-2">
                  Server offline. Run{" "}
                  <code className="text-acid">deno run -A main.ts</code>{" "}
                  — it serves the game and the relay on the same address, or press{" "}
                  <b className="text-neon">AUTO</b> / edit the WS server above.
                </p>
              ) : p.rooms.length === 0 ? (
                <p className="text-[10px] text-dim/80 leading-snug bg-ink/60 border border-line px-2.5 py-2">
                  No open rooms on this server — <b className="text-snow">CREATE ROOM</b> above and share the code.
                </p>
              ) : (
                <ul className="space-y-1.5 max-h-40 overflow-y-auto scroll-slim">
                  {p.rooms.map((r) => {
                    const full = r.players >= r.max;
                    return (
                      <li
                        key={r.room}
                        className={`flex items-center gap-3 bg-ink/60 border px-2.5 py-2 transition-colors ${
                          full ? "border-line opacity-60" : "border-line hover:border-neon/70 hover:bg-ink"
                        }`}
                      >
                        <span className="font-display text-[11px] text-gold tracking-[0.2em] w-24">{r.room}</span>
                        <span className="flex gap-1 items-center">
                          {Array.from({ length: r.max }).map((_, i) => (
                            <ShipIcon key={i} color={i < r.players ? "#00f0ff" : "#24306b"} size={11} />
                          ))}
                        </span>
                        <span className={`font-display text-[7px] ${full ? "text-hot" : "text-dim"}`}>
                          {r.players}/{r.max}
                        </span>
                        <span
                          className={`hidden sm:inline font-display text-[6px] px-1.5 py-1 border ${
                            r.status === "battle"
                              ? "text-hot border-hot/60 bg-hot/10 glow-pulse"
                              : "text-acid border-acid/40 bg-acid/10"
                          }`}
                        >
                          {r.status === "battle" ? "IN BATTLE" : "IN LOBBY"}
                        </span>
                        <button
                          onClick={() => p.onJoin(r.room)}
                          disabled={full}
                          className={`btn-arcade ml-auto text-[7px] px-3 py-1.5 ${
                            full ? "bg-panel text-dim" : "bg-acid/15 text-acid hover:bg-acid hover:text-ink"
                          }`}
                        >
                          {full ? "FULL" : "JOIN ▸"}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <div className="font-display text-[10px] text-gold blink mt-1">▸ PRESS START ◂</div>
          </div>
        </div>

        {/* ------ right: manual ------ */}
        <div className="panel-clip bg-panel/85 border border-line p-5 slide-up" style={{ animationDelay: "0.08s" }}>
          <h2 className="font-display text-[11px] text-neon mb-4 tracking-wider">COMBAT MANUAL</h2>
          <ul className="space-y-2.5 text-sm text-snow/90">
            <li className="flex items-center justify-between gap-3">
              <span className="text-dim font-medium">Move</span>
              <span className="flex gap-1"><Key>W</Key><Key>A</Key><Key>S</Key><Key>D</Key><span className="text-dim text-xs">/</span><Key>←↑↓→</Key></span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="text-dim font-medium">Auto-fire</span>
              <span className="font-display text-[9px] text-acid">ALWAYS ON</span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="text-dim font-medium">Bomb — clears bullets</span>
              <span className="flex gap-1"><Key>K</Key><span className="text-dim text-xs">/</span><Key>X</Key></span>
            </li>
            <li className="flex items-center justify-between gap-3">
              <span className="text-dim font-medium">Pause / Music</span>
              <span className="flex gap-1"><Key>P</Key><Key>M</Key></span>
            </li>
          </ul>

          <div className="h-px bg-line my-4" />
          <h3 className="font-display text-[9px] text-hot mb-3 tracking-wider">ENEMY INTEL</h3>
          <ul className="space-y-2">
            {[
              ["drone", "DRONE", "100", "sine weaver, easy pickings"],
              ["dart", "DART", "150", "dives straight at you"],
              ["spinner", "SPINNER", "250", "spins and snipes"],
              ["tank", "TANK", "300", "armored, fires 3-way"],
              ["boss", "BOSS", "5000", "every 5th wave — beware!"],
            ].map(([t, nm, sc, note]) => (
              <li key={t} className="flex items-center gap-3 text-sm">
                <EnemyGlyph type={t} />
                <span className="font-display text-[9px] w-16" style={{ color: "#eaf6ff" }}>{nm}</span>
                <span className="text-gold font-display text-[9px] w-12">{sc}</span>
                <span className="text-dim text-xs">{note}</span>
              </li>
            ))}
          </ul>

          <div className="h-px bg-line my-4" />
          <h3 className="font-display text-[9px] text-acid mb-3 tracking-wider">SUPPLY DROPS</h3>
          <ul className="space-y-2 text-xs text-dim">
            <li className="flex items-center gap-3"><PowerGlyph type="W" /><span><b className="text-gold">W</b> — weapon upgrade (4 tiers max)</span></li>
            <li className="flex items-center gap-3"><PowerGlyph type="B" /><span><b className="text-hot">B</b> — extra bomb</span></li>
            <li className="flex items-center gap-3"><PowerGlyph type="H" /><span><b className="text-acid">H</b> — extra reserve life</span></li>
          </ul>

          <div className="h-px bg-line my-4" />
          <p className="text-[11px] text-dim leading-relaxed">
            Chain kills to build a combo multiplier (up to <span className="text-gold">×4</span>). Getting hit
            drops your weapon one tier.
          </p>
        </div>
      </div>

      <Ticker />
    </div>
  );
}

/* ================= lobby ================= */

interface LobbyProps {
  net: NetInfo;
  room: string;
  pilotName: string;
  onStart: () => void;
  onLeave: () => void;
}

function LobbyScreen({ net, room, pilotName, onStart, onLeave }: LobbyProps) {
  const [copied, setCopied] = useState(false);
  const isHost = net.youHost;
  const displayName = (pilotName || "PILOT").toUpperCase().slice(0, 12);
  const squad = [{ id: "you", name: displayName, color: net.myColor, host: isHost }, ...net.peers.map((p) => ({ ...p, host: false }))];
  // Server caps rooms at 2 players
  const slots = Array.from({ length: 2 });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(room);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1300);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div className="absolute inset-0 z-30 flex flex-col overflow-y-auto scroll-slim">
      <div className="flex-1 flex items-center justify-center px-5 py-8">
        <div className="w-full max-w-2xl slide-up">
          <div className="flex items-center gap-3 mb-5">
            <span className="font-display text-[10px] text-hot blink">●</span>
            <h2 className="font-display text-sm sm:text-base text-snow tracking-wider">MISSION LOBBY</h2>
            <span className="ml-auto font-display text-[8px] text-dim">
              {squad.length}/2 PILOTS
            </span>
          </div>

          {/* room code */}
          <div className="panel-clip bg-panel/90 border border-gold/60 p-5">
            <div className="font-display text-[8px] text-dim mb-2 tracking-widest">ROOM CODE</div>
            <div className="flex items-center gap-3">
              <span className="font-display text-3xl sm:text-5xl text-gold tracking-[0.3em] select-all">
                {room}
              </span>
              <button
                onClick={copy}
                className={`btn-arcade panel-clip text-[8px] px-3 py-2.5 flex items-center gap-2 ${
                  copied ? "bg-acid text-ink" : "bg-ink text-dim hover:text-gold"
                }`}
              >
                <CopyIcon />
                {copied ? "COPIED!" : "COPY"}
              </button>
            </div>
            <p className="text-[11px] text-dim mt-3 leading-snug">
              Friends hit <b className="text-hot">JOIN ROOM</b> on the menu and enter this code — or pick the
              room from the live list. First pilot in is the <b className="text-gold">HOST</b>.
            </p>
          </div>

          {/* squad slots */}
          <div className="grid grid-cols-2 gap-2.5 mt-4">
            {slots.map((_, i) => {
              const pl = squad[i];
              return pl ? (
                <div
                  key={pl.id}
                  className="pop-in hud-chip panel-clip px-3.5 py-3 flex items-center gap-3"
                  style={{ borderColor: pl.color, animationDelay: `${i * 0.07}s` }}
                >
                  <ShipIcon color={pl.color} size={20} />
                  <div className="leading-tight min-w-0">
                    <div className="font-display text-[9px] truncate" style={{ color: pl.color }}>
                      {pl.id === "you" ? (pl as { name: string }).name + " (YOU)" : pl.name}
                    </div>
                    <div className="font-display text-[7px] text-dim mt-1">
                      {pl.host ? "★ HOST" : "PILOT"}
                    </div>
                  </div>
                  <span className="ml-auto w-2 h-2 rounded-full bg-acid glow-pulse" />
                </div>
              ) : (
                <div
                  key={`empty-${i}`}
                  className="hud-chip panel-clip px-3.5 py-3 flex items-center gap-3 border-dashed opacity-60"
                >
                  <ShipIcon color="#24306b" size={20} />
                  <span className="font-display text-[8px] text-dim blink">AWAITING PILOT...</span>
                </div>
              );
            })}
          </div>

          {/* actions */}
          <div className="flex flex-col sm:flex-row gap-3 mt-5 items-stretch">
            {isHost ? (
              <button
                onClick={onStart}
                className="btn-arcade panel-clip bg-acid text-ink text-xs px-6 py-4 flex items-center justify-between flex-1"
              >
                <span>▶ START MISSION</span>
                <span className="text-[7px] opacity-70">HOST ONLY</span>
              </button>
            ) : (
              <div className="flex-1 hud-chip panel-clip px-6 py-4 flex items-center justify-center gap-4">
                <Radar size={30} />
                <span className="font-display text-[9px] text-neon blink">WAITING FOR HOST TO START...</span>
              </div>
            )}
            <button
              onClick={onLeave}
              className="btn-arcade panel-clip text-hot bg-panel text-[10px] px-6 py-4"
            >
              ◂ LEAVE ROOM
            </button>
          </div>

          {isHost && squad.length === 1 && (
            <p className="text-[11px] text-dim/80 mt-3 text-center">
              You can launch solo — empty slots stay open for late joiners mid-battle.
            </p>
          )}
        </div>
      </div>
      <Ticker />
    </div>
  );
}

/* ================= HUD ================= */

function Hud({ hud, bgmPlaying, onLeave }: { hud: HudData; bgmPlaying: boolean; onLeave: () => void }) {
  const coop = hud.role !== "solo";
  const isTouch =
    typeof window !== "undefined" && !!window.matchMedia?.("(pointer: coarse)").matches;
  return (
    <div className="absolute inset-0 z-20 pointer-events-none select-none">
      {isTouch && (
        <div className="absolute bottom-3 inset-x-0 text-center font-display text-[8px] text-dim/80 tracking-wider">
          DRAG TO MOVE · AUTO-FIRE ON
        </div>
      )}
      {/* left: squad */}
      <div className="absolute top-3 left-3 flex flex-col gap-2">
        {hud.players.map((pl) => (
          <div key={pl.id} className="hud-chip panel-clip px-3 py-2 flex items-center gap-3" style={{ borderColor: pl.color }}>
            <ShipIcon color={pl.color} />
            <div className="leading-tight">
              <div className="font-display text-[8px]" style={{ color: pl.color }}>
                {pl.name}
                {pl.local ? " ▸YOU" : ""}
              </div>
              <div className="flex items-center gap-1 mt-1">
                {pl.alive ? (
                  <span className="flex gap-[3px]">
                    {Array.from({ length: pl.lives }).map((_, i) => (
                      <ShipIcon key={i} color={pl.color} size={9} />
                    ))}
                    {pl.lives === 0 && <span className="text-[9px] text-dim">+0</span>}
                  </span>
                ) : (
                  <span className="font-display text-[7px] text-hot blink">K.I.A.</span>
                )}
              </div>
            </div>
            <div className="ml-2 flex flex-col gap-1">
              <div className="flex gap-[3px]">
                {pl.weapons.map((w) => (
                  <span key={w} className="w-2 h-2" title={w.toUpperCase()} style={{ background: "#ffd23f" }} />
                ))}
              </div>
              <div className="flex gap-[3px] items-center">
                {Array.from({ length: pl.bombs }).map((_, i) => (
                  <BombIcon key={i} />
                ))}
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* right: score */}
      <div className="absolute top-3 right-3 text-right">
        <div className="hud-chip panel-clip px-4 py-2">
          <div className="font-display text-[8px] text-dim">SCORE</div>
          <div className="font-display text-sm sm:text-lg text-snow mt-1">{String(hud.score).padStart(7, "0")}</div>
          <div className="font-display text-[7px] text-dim mt-1">
            HI {String(Math.max(hud.hi, hud.score)).padStart(7, "0")}
          </div>
        </div>
        <div className="hud-chip panel-clip px-4 py-1.5 mt-2 inline-block">
          <span className="font-display text-[9px] text-neon">WAVE {hud.wave}</span>
          <span className="font-display text-[8px] text-dim ml-2">KILLS {hud.kills}</span>
        </div>
      </div>

      {/* combo */}
      {hud.combo >= 4 && (
        <div key={hud.combo} className="combo-pop absolute top-24 left-1/2 -translate-x-1/2 text-center">
          <div className="font-display text-xl text-gold" style={{ textShadow: "2px 2px 0 #ff2d78, 0 0 18px rgba(255,210,63,0.6)" }}>
            ×{hud.mult.toFixed(1)}
          </div>
          <div className="font-display text-[8px] text-dim mt-1">COMBO {hud.combo}</div>
        </div>
      )}

      {/* boss bar */}
      {hud.bossMax > 0 && (
        <div className="absolute top-3 left-1/2 -translate-x-1/2 w-[min(460px,56vw)]">
          <div className="flex justify-between font-display text-[8px] mb-1">
            <span className="text-hot blink">!! BOSS !!</span>
            <span className="text-dim">{Math.ceil((hud.bossHp / hud.bossMax) * 100)}%</span>
          </div>
          <div className="h-3 bg-ink border border-hot panel-clip overflow-hidden">
            <div
              className="h-full transition-[width] duration-150"
              style={{
                width: `${Math.max(0, (hud.bossHp / hud.bossMax) * 100)}%`,
                background: "linear-gradient(90deg, #ff2d78, #ffd23f)",
              }}
            />
          </div>
        </div>
      )}

      {/* bottom hint */}
      <div className="absolute bottom-2 left-1/2 -translate-x-1/2 font-body text-[11px] text-dim/80 tracking-wide whitespace-nowrap">
        {coop ? "K bomb — the host runs the battle" : "K bomb · P pause · M music"}
        <span className={`ml-3 inline-flex items-center gap-1 ${bgmPlaying ? "text-acid" : "text-dim"}`}>
          {bgmPlaying ? <EqBars /> : "♪"}
        </span>
      </div>

      {coop && (
        <button
          onClick={onLeave}
          className="pointer-events-auto absolute bottom-6 right-3 btn-arcade panel-clip text-[9px] text-dim bg-panel/80 px-3 py-2"
        >
          LEAVE
        </button>
      )}
    </div>
  );
}

/* ================= overlays ================= */

function PauseScreen({ onResume, onQuit }: { onResume: () => void; onQuit: () => void }) {
  return (
    <div className="absolute inset-0 z-30 bg-ink/80 backdrop-blur-[2px] flex flex-col items-center justify-center gap-6">
      <div className="pop-in font-display text-4xl sm:text-5xl text-neon" style={{ textShadow: "3px 3px 0 #ff2d78, 0 0 30px rgba(0,240,255,0.5)" }}>
        PAUSED
      </div>
      <p className="text-dim text-sm -mt-2">Battle on hold — the enemy will wait. Probably.</p>
      <div className="flex flex-col sm:flex-row gap-3">
        <button onClick={onResume} className="btn-arcade panel-clip bg-neon text-ink text-xs px-6 py-3">
          ▶ RESUME (P)
        </button>
        <button onClick={onQuit} className="btn-arcade panel-clip text-hot bg-panel text-xs px-6 py-3">
          MAIN MENU
        </button>
      </div>
    </div>
  );
}

function GameOverScreen({
  stats,
  hud,
  onRestart,
  onMenu,
}: {
  stats: OverStats | null;
  hud: HudData;
  onRestart: () => void;
  onMenu: () => void;
}) {
  const waitingHost = hud.role === "guest";
  const s = stats ?? { score: hud.score, wave: hud.wave, kills: hud.kills, bestCombo: 0, newRecord: false };
  return (
    <div className="absolute inset-0 z-30 bg-ink/70 flex items-center justify-center p-4">
      <div className="pop-in panel-clip bg-panel/95 border border-hot max-w-md w-full p-7 text-center">
        <div className="font-display text-3xl sm:text-4xl text-hot" style={{ textShadow: "3px 3px 0 #05060f, 0 0 26px rgba(255,45,120,0.7)" }}>
          GAME OVER
        </div>
        {s.newRecord && (
          <div className="blink font-display text-[10px] text-gold mt-3">★ NEW RECORD ★</div>
        )}
        {hud.role === "solo" && s.wave >= 1 && (
          <div className="font-display text-[8px] text-neon mt-3 opacity-80">
            ACCOUNT SAVED — ARSENAL & WAVE {s.wave} KEEP FOR NEXT MATCH
          </div>
        )}
        <div className="grid grid-cols-2 gap-3 mt-6 text-left">
          {[
            ["SCORE", String(s.score).padStart(7, "0"), "#eaf6ff"],
            ["WAVE", String(s.wave), "#00f0ff"],
            ["KILLS", String(s.kills), "#7dff5e"],
            ["BEST COMBO", String(s.bestCombo), "#ffd23f"],
          ].map(([label, val, col]) => (
            <div key={label} className="hud-chip panel-clip px-3 py-2.5">
              <div className="font-display text-[7px] text-dim">{label}</div>
              <div className="font-display text-xs mt-1" style={{ color: col }}>{val}</div>
            </div>
          ))}
        </div>
        <div className="flex flex-col sm:flex-row gap-3 mt-7 justify-center">
          {waitingHost ? (
            <button disabled className="btn-arcade panel-clip text-dim bg-ink text-[10px] px-5 py-3">
              WAITING FOR HOST TO RESTART...
            </button>
          ) : (
            <button onClick={onRestart} className="btn-arcade panel-clip bg-hot text-ink text-[10px] px-5 py-3">
              ▶ PLAY AGAIN (ENTER)
            </button>
          )}
          <button onClick={onMenu} className="btn-arcade panel-clip text-neon bg-ink text-[10px] px-5 py-3">
            MAIN MENU
          </button>
        </div>
      </div>
    </div>
  );
}

function ConnectingScreen({ onCancel, server }: { onCancel: () => void; server: string }) {
  return (
    <div className="absolute inset-0 z-30 bg-ink/85 flex flex-col items-center justify-center gap-5">
      <Radar size={64} />
      <div className="font-display text-[11px] text-neon">LINKING TO SERVER</div>
      <div className="font-mono text-xs text-dim">{server}</div>
      <button onClick={onCancel} className="btn-arcade panel-clip text-hot bg-panel text-[10px] px-5 py-2.5 mt-2">
        CANCEL
      </button>
    </div>
  );
}

/* ================= App ================= */

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const engineRef = useRef<Engine | null>(null);
  const [phase, setPhase] = useState<Phase>("menu");
  const [hud, setHud] = useState<HudData | null>(null);
  const [net, setNet] = useState<NetInfo>({
    connected: false, role: "solo", youHost: false, peers: [], error: null, myColor: "#00f0ff",
  });
  const [overStats, setOverStats] = useState<OverStats | null>(null);
  const [bgm, setBgm] = useState<{ playing: boolean; source: BgmSource }>({ playing: false, source: "none" });

  const [name, setNameState] = useState(() => {
    try {
      return localStorage.getItem("pixelrush-name") || `PILOT-${Math.floor(Math.random() * 90 + 10)}`;
    } catch {
      return "PILOT-01";
    }
  });
  const [server, setServerState] = useState(() => {
    try {
      return localStorage.getItem("pixelrush-server") || defaultWsUrl();
    } catch {
      return defaultWsUrl();
    }
  });
  const [room, setRoomState] = useState("------");
  const [mode, setMode] = useState<"create" | "join">("create");
  const [createdCode, setCreatedCode] = useState(genRoomCode);
  const [joinCode, setJoinCode] = useState("");
  const [joinErr, setJoinErr] = useState<string | null>(null);
  const [rooms, setRooms] = useState<RoomInfo[]>([]);
  const [roomsErr, setRoomsErr] = useState(false);
  const [roomsScan, setRoomsScan] = useState(0);
  const [profile, setProfile] = useState<PlayerProfile>(() => loadPlayerProfile());

  const setName = (v: string) => {
    setNameState(v);
    try { localStorage.setItem("pixelrush-name", v); } catch { /* ignore */ }
  };
  const setServer = (v: string) => {
    setServerState(v);
    setJoinErr(null);
    try { localStorage.setItem("pixelrush-server", v); } catch { /* ignore */ }
  };
  const setRoom = (v: string) => {
    setRoomState(v);
    try { localStorage.setItem("pixelrush-room", v); } catch { /* ignore */ }
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const engine = new Engine(canvas, {
      onPhase: (p, stats) => {
        setPhase(p);
        if (p === "gameover") setOverStats(stats ?? null);
        if (p === "menu" || p === "gameover") setProfile(loadPlayerProfile());
      },
      onHud: setHud,
      onNet: setNet,
    });
    engineRef.current = engine;
    audio.onBgmState = (playing, source) => setBgm({ playing, source });
    setHud(engine.getHud());
    return () => {
      engine.destroy();
      engineRef.current = null;
      audio.onBgmState = null;
    };
  }, []);

  // Poll the server for open rooms while the menu is on screen.
  useEffect(() => {
    if (phase !== "menu" || net.connected) return;
    let alive = true;
    const poll = async () => {
      try {
        const list = await fetchRooms(server);
        if (!alive) return;
        setRooms(list);
        setRoomsErr(false);
      } catch {
        if (!alive) return;
        setRooms([]);
        setRoomsErr(true);
      }
    };
    poll();
    const t = window.setInterval(poll, 3000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [phase, net.connected, server, roomsScan]);

  const eng = () => engineRef.current;
  const inGame = phase === "playing" || phase === "paused" || phase === "gameover";
  const pilot = name.trim() || "PILOT";

  const handleCreate = () => {
    setJoinErr(null);
    const origin = normalizeWsOrigin(server);
    if (!origin) {
      setJoinErr("Enter a valid WS server address");
      return;
    }
    // Persist the normalized form so next time AUTO/localStorage is clean
    if (origin !== server) setServer(origin);
    setRoom(createdCode);
    eng()?.startCoop(origin, createdCode, pilot);
  };

  const handleJoin = async (raw: string) => {
    const code = raw.trim().toUpperCase();
    if (!code) {
      setJoinErr("Enter a room code first");
      return;
    }
    // Pre-check capacity when the directory is reachable.
    try {
      const list = await fetchRooms(server);
      const target = list.find((r) => r.room === code);
      if (target && target.players >= target.max) {
        setJoinErr(`Room ${code} is full (${target.max}/${target.max})`);
        return;
      }
    } catch {
      /* directory unreachable — try connecting anyway */
    }
    setJoinErr(null);
    const origin = normalizeWsOrigin(server);
    if (!origin) {
      setJoinErr("Enter a valid WS server address");
      return;
    }
    if (origin !== server) setServer(origin);
    setRoom(code);
    eng()?.startCoop(origin, code, pilot);
  };

  return (
    <div className="fixed inset-0 bg-ink overflow-hidden">
      <canvas ref={canvasRef} className="absolute inset-0 z-0" />
      <div className="fx-scan absolute inset-0 z-10" />
      <div className="fx-vignette absolute inset-0 z-10" />

      {/* music toggle — always on top */}
      <button
        onClick={() => eng()?.toggleMute()}
        title="Mute / play music (M) — click to start BGM if blocked by browser"
        className="absolute top-3 left-1/2 -translate-x-1/2 z-40 hud-chip panel-clip px-3 py-2 flex items-center gap-2 text-snow hover:text-neon transition-colors cursor-pointer"
      >
        <SpeakerIcon muted={hud?.muted ?? audio.muted} />
        <span className="font-display text-[7px] hidden sm:inline text-dim">
          {hud?.muted || audio.muted
            ? "MUTED"
            : bgm.playing
              ? "BGM ON"
              : "TAP FOR MUSIC"}
        </span>
        {bgm.playing && !(hud?.muted ?? false) && <EqBars />}
      </button>

      {inGame && hud && (
        <Hud hud={hud} bgmPlaying={bgm.playing && !hud.muted} onLeave={() => eng()?.quitToMenu()} />
      )}

      {phase === "menu" && net.connected && (
        <LobbyScreen
          net={net}
          room={room}
          pilotName={pilot}
          onStart={() => eng()?.hostStart()}
          onLeave={() => eng()?.quitToMenu()}
        />
      )}

      {phase === "menu" && !net.connected && (
        <MenuScreen
          hud={hud ?? {
            phase: "menu", role: "solo", score: 0, hi: 0, wave: 0, combo: 0, mult: 1,
            kills: 0, bossHp: 0, bossMax: 0, players: [], muted: audio.muted,
          }}
          name={name}
          setName={setName}
          server={server}
          setServer={setServer}
          onAutoServer={() => setServer(defaultWsUrl())}
          mode={mode}
          setMode={(m) => { setMode(m); setJoinErr(null); }}
          createdCode={createdCode}
          rerollCode={() => setCreatedCode(genRoomCode())}
          joinCode={joinCode}
          setJoinCode={(v) => { setJoinCode(v); setJoinErr(null); }}
          joinErr={joinErr ?? net.error}
          rooms={rooms}
          roomsErr={roomsErr}
          refreshRooms={() => setRoomsScan((n) => n + 1)}
          onSolo={() => eng()?.startSolo()}
          profile={profile}
          onCreate={handleCreate}
          onJoin={handleJoin}
        />
      )}

      {phase === "connecting" && <ConnectingScreen server={`${server}/ws?room=${room}`} onCancel={() => eng()?.quitToMenu()} />}

      {phase === "paused" && (
        <PauseScreen onResume={() => eng()?.togglePause()} onQuit={() => eng()?.quitToMenu()} />
      )}

      {phase === "gameover" && hud && (
        <GameOverScreen
          stats={overStats}
          hud={hud}
          onRestart={() => eng()?.restart()}
          onMenu={() => eng()?.quitToMenu()}
        />
      )}
    </div>
  );
}

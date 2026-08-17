/**
 * PIXEL RUSH — Val Town Server
 * -----------------------------------------------------
 * HTTP Val entry point for Val Town.
 * Serves the pre-built `dist/` frontend and WebSocket relay.
 * Uses SQLite for persistent room and player state.
 */

import { serveFile } from "https://esm.town/v/std/utils@85-main/index.ts";
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

const MAX_PLAYERS = 4;

// Initialize Database
await sqlite.execute(`CREATE TABLE IF NOT EXISTS rooms_metadata (room_code TEXT PRIMARY KEY, status TEXT)`);
await sqlite.execute(`CREATE TABLE IF NOT EXISTS players (id TEXT PRIMARY KEY, room_code TEXT, name TEXT, color TEXT, is_host BOOLEAN)`);

// In-memory active connections
const activeConnections = new Map<string, WebSocket>();

interface Client {
  id: string;
  ws: WebSocket;
  room: string;
  name: string;
  color: string;
}

const pub = (p: any) => ({ id: p.id, name: p.name, color: p.color });

const send = (ws: WebSocket, obj: unknown) => {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {
    /* ignore broken socket */
  }
};

const broadcast = async (room: string, obj: unknown, except?: string) => {
  const players = (await sqlite.execute(`SELECT id FROM players WHERE room_code = ?`, [room])).rows as any[];
  for (const p of players) {
    const ws = activeConnections.get(p.id);
    if (ws && p.id !== except) send(ws, obj);
  }
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default async function (req: Request): Promise<Response> {
  const url = new URL(req.url);

  // ---------- room directory ----------
  if (url.pathname === "/rooms") {
    const rooms = (await sqlite.execute(`SELECT room_code, status FROM rooms_metadata`)).rows as any[];
    const result = [];
    for (const r of rooms) {
      const pilots = (await sqlite.execute(`SELECT id, name, color FROM players WHERE room_code = ?`, [r.room_code])).rows as any[];
      result.push({
        room: r.room_code,
        players: pilots.length,
        max: MAX_PLAYERS,
        status: r.status,
        pilots: pilots,
      });
    }
    return json({ maxPlayers: MAX_PLAYERS, rooms: result });
  }

  // ---------- WebSocket relay ----------
  if (url.pathname === "/ws") {
    if (req.headers.get("upgrade") !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 400 });
    }

    const room =
      (url.searchParams.get("room") ?? "default").trim().toUpperCase().slice(0, 16) || "default";

    const count = (await sqlite.execute(`SELECT COUNT(*) as cnt FROM players WHERE room_code = ?`, [room])).rows![0].cnt as number;
    if (count >= MAX_PLAYERS) {
      return json({ error: "room-full", room, max: MAX_PLAYERS }, 403);
    }

    const { socket, response } = Deno.upgradeWebSocket(req);
    const id = `p-${crypto.randomUUID().slice(0, 8)}`;
    
    socket.onopen = async () => {
      activeConnections.set(id, socket);
      const isHost = count === 0;
      if (isHost) {
        await sqlite.execute(`INSERT OR IGNORE INTO rooms_metadata (room_code, status) VALUES (?, ?)`, [room, "lobby"]);
      }
      await sqlite.execute(`INSERT INTO players (id, room_code, name, color, is_host) VALUES (?, ?, ?, ?, ?)`, 
        [id, room, "PILOT", "#00f0ff", isHost ? 1 : 0]);

      const peers = (await sqlite.execute(`SELECT id, name, color FROM players WHERE room_code = ? AND id != ?`, [room, id])).rows as any[];
      
      send(socket, {
        t: "welcome",
        id,
        room,
        youHost: isHost,
        maxPlayers: MAX_PLAYERS,
        peers: peers.map(pub),
      });
    };

    socket.onmessage = async (ev) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch { return; }

      if (msg.t === "join") {
        const name = String(msg.name ?? "PILOT").slice(0, 14);
        const color = String(msg.color ?? "#00f0ff").slice(0, 9);
        await sqlite.execute(`UPDATE players SET name = ?, color = ? WHERE id = ?`, [name, color, id]);
        await broadcast(room, { t: "peer-join", id, name, color }, id);
        return;
      }

      if (msg.t === "start") await sqlite.execute(`UPDATE rooms_metadata SET status = ? WHERE room_code = ?`, ["battle", room]);
      else if (msg.t === "lobby") await sqlite.execute(`UPDATE rooms_metadata SET status = ? WHERE room_code = ?`, ["lobby", room]);

      await broadcast(room, { ...msg, from: id }, id);
    };

    const leave = async () => {
      activeConnections.delete(id);
      const player = (await sqlite.execute(`SELECT is_host FROM players WHERE id = ?`, [id])).rows![0] as any;
      await sqlite.execute(`DELETE FROM players WHERE id = ?`, [id]);
      
      const remaining = (await sqlite.execute(`SELECT id FROM players WHERE room_code = ? ORDER BY is_host DESC`, [room])).rows as any[];
      
      if (remaining.length === 0) {
        await sqlite.execute(`DELETE FROM rooms_metadata WHERE room_code = ?`, [room]);
      } else if (player.is_host) {
        const newHost = remaining[0];
        await sqlite.execute(`UPDATE players SET is_host = 1 WHERE id = ?`, [newHost.id]);
        await broadcast(room, { t: "host", id: newHost.id });
      } else {
        await broadcast(room, { t: "peer-leave", id });
      }
    };

    socket.onclose = leave;
    socket.onerror = leave;

    return response;
  }

  // ---------- static frontend (no bundle — each module served individually) ----------
  // Serve files from the `frontend/` folder. The browser imports them as
  // ES modules; serveFile transpiles TSX/TS on the fly, so no build step,
  // no giant single-file bundle.
  const p = url.pathname === "/" ? "/frontend/index.html" : url.pathname;
  if (p.startsWith("/frontend/")) {
    return await serveFile(p, import.meta.url);
  }

  // Old /index.html used by Vite dev builds (dist/). Fallback:
  return new Response("Not found", { status: 404 });
}

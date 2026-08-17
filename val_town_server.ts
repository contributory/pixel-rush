/**
 * PIXEL RUSH — Val Town Server
 * -----------------------------------------------------
 * HTTP Val entry point for Val Town.
 * Serves the frontend and WebSocket relay using Val Town's native APIs.
 * Uses SQLite for persistent room and player state.
 */

import { serveFile } from "https://esm.town/v/std/utils@85-main/index.ts";
import { sqlite } from "https://esm.town/v/std/sqlite/main.ts";

const MAX_PLAYERS = 2;

// Initialize tables (idempotent — safe to run on every invocation)
await sqlite.execute(`
  CREATE TABLE IF NOT EXISTS rooms_metadata (
    room_code TEXT PRIMARY KEY, 
    status TEXT DEFAULT 'lobby'
  )
`);
await sqlite.execute(`
  CREATE TABLE IF NOT EXISTS players (
    id TEXT PRIMARY KEY, 
    room_code TEXT, 
    name TEXT DEFAULT 'PILOT', 
    color TEXT DEFAULT '#00f0ff', 
    is_host INTEGER DEFAULT 0
  )
`);

// In-memory active connections per room
const roomClients = new Map<string, Set<string>>();

interface ClientInfo {
  id: string;
  name: string;
  color: string;
  room: string;
  isHost: boolean;
}

const clients = new Map<string, { ws: WebSocket; info: ClientInfo }>();

const pub = (info: { id: string; name: string; color: string }) => ({ 
  id: info.id, 
  name: info.name || "PILOT", 
  color: info.color || "#00f0ff" 
});

const send = (ws: WebSocket, obj: unknown) => {
  try {
    ws.send(JSON.stringify(obj));
  } catch {
    /* ignore broken socket */
  }
};

const broadcastToRoom = (room: string, obj: unknown, exceptId?: string) => {
  const clientIds = roomClients.get(room);
  if (!clientIds) return;
  for (const clientId of clientIds) {
    if (clientId === exceptId) continue;
    const client = clients.get(clientId);
    if (client) send(client.ws, obj);
  }
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // CORS headers for cross-origin requests
  const corsHeaders = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "Content-Type, Upgrade",
  };

  // Handle preflight OPTIONS requests
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  // ---------- room directory API ----------
  if (url.pathname === "/rooms") {
    try {
      const roomsRes = await sqlite.execute("SELECT room_code, status FROM rooms_metadata");
      const rooms = roomsRes.rows as { room_code: string; status: string | null }[];
      const result: { room: string; players: number; max: number; status: string; pilots: { id: string; name: string; color: string }[] }[] = [];
      for (const r of rooms) {
        const pilotsRes = await sqlite.execute({
          sql: "SELECT id, name, color FROM players WHERE room_code = ?",
          args: [r.room_code],
        });
        const pilots = pilotsRes.rows as { id: string; name: string; color: string }[];
        result.push({
          room: r.room_code,
          players: pilots.length,
          max: MAX_PLAYERS,
          status: r.status || "lobby",
          pilots: pilots.map((p) => pub({ id: p.id, name: p.name, color: p.color })),
        });
      }
      return json({ maxPlayers: MAX_PLAYERS, rooms: result });
    } catch (e) {
      console.error("Rooms endpoint error:", e);
      return json({ error: "Database error", rooms: [] }, 500);
    }
  }

  // ---------- WebSocket relay ----------
  if (url.pathname === "/ws") {
    const upgradeHeader = req.headers.get("upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected a WebSocket upgrade", { status: 400, headers: corsHeaders });
    }

    const room = (url.searchParams.get("room") ?? "default").trim().toUpperCase().slice(0, 16) || "default";

    // Count current players in room
    const countRes = await sqlite.execute({
      sql: "SELECT COUNT(*) AS count FROM players WHERE room_code = ?",
      args: [room],
    });
    const count = (countRes.rows[0] as { count: number } | undefined)?.count ?? 0;

    if (count >= MAX_PLAYERS) {
      return json({ error: "room-full", room, max: MAX_PLAYERS }, 403);
    }

    // Upgrade to WebSocket using Val Town's native API
    // Val Town's native WebSocket upgrade endpoint; `response.webSocket` is
    // a runtime extension not present on the standard `Response` type.
    const { socket, response } = await fetch("https://websocket.val.town/", {
      method: "POST",
      headers: {
        "Upgrade": "websocket",
        "Connection": "Upgrade",
        "Sec-WebSocket-Key": crypto.randomUUID().replace(/-/g, "").slice(0, 24),
        "Sec-WebSocket-Version": "13",
      },
    }).then((r: any) => r.webSocket ? { socket: r.webSocket, response: new Response() } : Promise.reject("WS upgrade failed"));

    const id = `p-${crypto.randomUUID().slice(0, 8)}`;
    const isHost = count === 0;

    // Initialize client info
    const clientInfo: ClientInfo = { id, name: "PILOT", color: "#00f0ff", room, isHost };

    socket.addEventListener("open", async () => {
      // Store connection
      clients.set(id, { ws: socket, info: clientInfo });
      
      // Track room membership
      if (!roomClients.has(room)) {
        roomClients.set(room, new Set());
      }
      roomClients.get(room)!.add(id);

      // Create room metadata if host
      if (isHost) {
        await sqlite.execute({
          sql: "INSERT OR IGNORE INTO rooms_metadata (room_code, status) VALUES (?, ?)",
          args: [room, "lobby"],
        });
      }

      // Insert player into database
      await sqlite.execute({
        sql: "INSERT INTO players (id, room_code, name, color, is_host) VALUES (?, ?, ?, ?, ?)",
        args: [id, room, clientInfo.name, clientInfo.color, isHost ? 1 : 0],
      });

      // Get existing peers
      const peersRes = await sqlite.execute({
        sql: "SELECT id, name, color FROM players WHERE room_code = ? AND id != ?",
        args: [room, id],
      });
      const peers = peersRes.rows as { id: string; name: string; color: string }[];

      send(socket, {
        t: "welcome",
        id,
        room,
        youHost: isHost,
        maxPlayers: MAX_PLAYERS,
        peers: peers.map((p) => pub({ id: p.id, name: p.name, color: p.color })),
      });

      console.log(`[+] ${id} joined "${room}" (${isHost ? "HOST" : "guest"}) — ${count + 1}/${MAX_PLAYERS} pilots`);
    });

    socket.addEventListener("message", async (ev: any) => {
      let msg: Record<string, unknown>;
      try {
        msg = JSON.parse(String(ev.data));
      } catch {
        return;
      }

      const client = clients.get(id);
      if (!client) return;

      if (msg.t === "join") {
        const name = String(msg.name ?? "PILOT").slice(0, 14);
        const color = String(msg.color ?? "#00f0ff").slice(0, 9);
        client.info.name = name;
        client.info.color = color;
        
        await sqlite.execute({
          sql: "UPDATE players SET name = ?, color = ? WHERE id = ?",
          args: [name, color, id],
        });
        
        broadcastToRoom(room, { t: "peer-join", id, name, color }, id);
        console.log(`[~] ${id} is now "${name}" (room "${room}")`);
        return;
      }

      // Track match state
      if (msg.t === "start") {
        await sqlite.execute({
          sql: "UPDATE rooms_metadata SET status = ? WHERE room_code = ?",
          args: ["battle", room],
        });
      } else if (msg.t === "lobby") {
        await sqlite.execute({
          sql: "UPDATE rooms_metadata SET status = ? WHERE room_code = ?",
          args: ["lobby", room],
        });
      }

      // Relay signaling messages for WebRTC (offer, answer, ice-candidate)
      if (msg.t === "offer" || msg.t === "answer" || msg.t === "ice-candidate") {
        broadcastToRoom(room, { ...msg, from: id }, id);
        return;
      }

      // Relay other game messages to room
      broadcastToRoom(room, { ...msg, from: id }, id);
    });

    const cleanup = async () => {
      const client = clients.get(id);
      if (!client) return;

      const wasHost = client.info.isHost;
      clients.delete(id);
      
      const roomSet = roomClients.get(room);
      if (roomSet) {
        roomSet.delete(id);
        if (roomSet.size === 0) {
          roomClients.delete(room);
        }
      }

      // Remove player from database
      await sqlite.execute({ sql: "DELETE FROM players WHERE id = ?", args: [id] });

      // Check if room is empty
      const remainingRes = await sqlite.execute({
        sql: "SELECT id FROM players WHERE room_code = ? ORDER BY is_host DESC",
        args: [room],
      });
      const remaining = remainingRes.rows as { id: string }[];

      if (remaining.length === 0) {
        await sqlite.execute({ sql: "DELETE FROM rooms_metadata WHERE room_code = ?", args: [room] });
        console.log(`[-] ${id} left "${room}" — room deleted`);
      } else if (wasHost) {
        // Promote new host
        const newHostId = remaining[0].id;
        await sqlite.execute({ sql: "UPDATE players SET is_host = 1 WHERE id = ?", args: [newHostId] });
        const newHostClient = clients.get(newHostId);
        if (newHostClient) {
          newHostClient.info.isHost = true;
        }
        broadcastToRoom(room, { t: "host", id: newHostId });
        console.log(`[*] ${newHostId} is the new HOST of "${room}"`);
      } else {
        broadcastToRoom(room, { t: "peer-leave", id });
        console.log(`[-] ${id} left "${room}"`);
      }
    };

    socket.addEventListener("close", cleanup);
    socket.addEventListener("error", cleanup);

    return response;
  }

  // ---------- static frontend ----------
  // Serve files from the `frontend/` folder. The browser imports them as
  // ES modules; serveFile transpiles TSX/TS on the fly.
  const path = url.pathname === "/" ? "/frontend/index.html" : url.pathname;
  if (path.startsWith("/frontend/")) {
    try {
      return await serveFile(path, import.meta.url);
    } catch (e) {
      console.error("Serve file error:", e);
      return new Response("File not found", { status: 404, headers: corsHeaders });
    }
  }

  // Fallback:
  return new Response("Not found", { status: 404, headers: corsHeaders });
}

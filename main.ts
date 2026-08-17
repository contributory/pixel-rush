/**
 * PIXEL RUSH — Hono server (frontend + WebSocket relay + WebRTC signaling)
 * -----------------------------------------------------
 * One Node.js process serves the game frontend AND the multiplayer relay on a
 * single port (default 8000).
 *
 *   npm run dev     dev: Vite + Hono relay
 *   npm run build   build the frontend into dist/
 *   npm run start   prod: serve dist/ + relay
 *
 * Endpoints:
 *   /                    the game frontend
 *   /ws?room=ROOM_CODE   websocket relay (signaling for WebRTC)
 *   /rooms               open-room directory (for the LIVE ROOMS list)
 *   /status              JSON debug page
 *
 * The relay assigns ids, marks the first joiner as HOST, caps rooms at
 * MAX_PLAYERS, forwards signaling messages (offer/answer/ice-candidate) 
 * between players for WebRTC P2P sync, and announces joins / leaves / host changes.
 */

import { Hono } from "hono";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { Server as HttpServer } from "node:http";
import { WebSocketServer, WebSocket } from "ws";

const PORT = Number(process.env.PORT ?? 8000);
const DEV = process.env.NODE_ENV !== "production";
const MAX_PLAYERS = 2;

const __dirname = dirname(fileURLToPath(import.meta.url));
const DIST_DIR = join(__dirname, "dist");
const INDEX_HTML = join(DIST_DIR, "index.html");

interface Client {
  id: string;
  ws: WebSocket;
  room: string;
  name: string;
  color: string;
}

interface Pub {
  id: string;
  name: string;
  color: string;
}

const rooms = new Map<string, Client[]>();
const roomStatus = new Map<string, string>();
let seq = 0;

const pub = (c: Client): Pub => ({ id: c.id, name: c.name, color: c.color });

const send = (ws: WebSocket, obj: unknown) => {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  } catch {
    /* ignore broken socket */
  }
};

const broadcast = (room: Client[], obj: unknown, except?: string) => {
  for (const c of room) if (c.id !== except) send(c.ws, obj);
};

const app = new Hono();

// Serve the built frontend from dist/ in BOTH dev and prod.
// serveStatic falls through to the next handler when a file is missing,
// so /rooms, /status and the dev "/" fallback below still work.
app.use(
  "/*",
  serveStatic({
    root: DIST_DIR,
    rewriteRequestPath: (path) => {
      if (path === "/") return "/index.html";
      return path;
    },
  })
);

// Dev fallback: if dist/ hasn't been built yet, give a helpful message.
// For live reload during development, run `vite` on :5173 instead.
app.get("/", (c) => {
  if (existsSync(INDEX_HTML)) {
    return c.html(readFileSync(INDEX_HTML, "utf-8"));
  }
  return c.text("Run 'npm run build' first or start Vite dev server separately", 503);
});

app.use("*", async (c, next) => {
  c.header("access-control-allow-origin", "*");
  c.header("access-control-allow-methods", "GET, POST, OPTIONS");
  c.header("access-control-allow-headers", "Content-Type, Upgrade");
  await next();
});

app.get("/rooms", (c) => {
  return c.json({
    maxPlayers: MAX_PLAYERS,
    rooms: [...rooms.entries()].map(([room, list]) => ({
      room,
      players: list.length,
      max: MAX_PLAYERS,
      status: roomStatus.get(room) ?? "lobby",
      pilots: list.map(pub),
    })),
  });
});

app.get("/status", (c) => {
  return c.json({
    name: "PIXEL RUSH relay server",
    ws: `ws://localhost:${PORT}/ws?room=<ROOM_CODE>`,
    rooms: `http://localhost:${PORT}/rooms`,
    maxPlayers: MAX_PLAYERS,
    open: [...rooms.entries()].map(([room, list]) => ({
      room,
      players: list.map(pub),
    })),
  });
});

// ── WebSocket relay (co-op sync + WebRTC signaling) ─────────────────────────
// Lives on the same HTTP server: a `noServer` WebSocketServer is wired through
// the node server's `upgrade` event, so `/ws?room=CODE` works alongside the
// Hono HTTP routes above. The relay:
//   • sends a `welcome` to each new pilot (id / room / youHost / peers)
//   • announces `peer-join` / `peer-leave` to the rest of the room
//   • promotes the first remaining pilot to `host` when the host leaves
//   • forwards every other message (start/snap/ship/pshot/eshot/over + WebRTC
//     offer·answer·ice) to the other pilots, tagged with the sender's id.
const wss = new WebSocketServer({ noServer: true });

wss.on("connection", (ws, req) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const room = url.searchParams.get("room")?.trim().toUpperCase() || "default";
  const id = `p${++seq}`;
  const client: Client = { id, ws, room, name: "Pilot", color: "#888" };

  let list = rooms.get(room);
  if (!list) {
    list = [];
    rooms.set(room, list);
    roomStatus.set(room, "lobby");
  }

  // Room is full — refuse politely.
  if (list.length >= MAX_PLAYERS) {
    send(ws, { t: "error", msg: "Room is full" });
    ws.close(4001, "room full");
    return;
  }

  // First joiner becomes HOST. Welcome with the CURRENT members (excludes the
  // newcomer, who learns about them here and then announces itself via a
  // `join` message that we relay as `peer-join`).
  const youHost = list.length === 0;
  send(ws, {
    t: "welcome",
    id,
    room,
    youHost,
    maxPlayers: MAX_PLAYERS,
    peers: list.map(pub),
  });
  list.push(client);

  ws.on("message", (data) => {
    let m: Record<string, unknown>;
    try {
      m = JSON.parse(String(data)) as Record<string, unknown>;
    } catch {
      return; // ignore non-JSON frames
    }
    const t = String(m.t ?? "");

    if (t === "join") {
      // The client announces itself: record name/color, tell the room.
      client.name = typeof m.name === "string" ? m.name : client.name;
      client.color = typeof m.color === "string" ? m.color : client.color;
      broadcast(
        list,
        { t: "peer-join", from: client.id, id: client.id, name: client.name, color: client.color },
        client.id
      );
      return;
    }

    if (t === "bye") {
      ws.close(1000, "bye");
      return;
    }

    if (t === "start") roomStatus.set(room, "battle");
    else if (t === "lobby") roomStatus.set(room, "lobby");

    // Everything else is forwarded to the other pilots, tagged with the sender.
    m.from = client.id;
    broadcast(list, m, client.id);
  });

  ws.on("close", () => {
    const idx = list.indexOf(client);
    if (idx !== -1) list.splice(idx, 1);
    broadcast(list, { t: "peer-leave", id: client.id });
    if (list.length === 0) {
      rooms.delete(room);
      roomStatus.delete(room);
    } else {
      // The first remaining pilot takes over as HOST.
      broadcast(list, { t: "host", id: list[0].id });
    }
  });

  ws.on("error", () => {
    /* socket errors surface through 'close' */
  });
});

// Start the HTTP server, then attach WebSocket upgrade handling to it.
const server = serve(
  {
    fetch: app.fetch,
    port: PORT,
  },
  (info) => {
    console.log(`\n  ▓▓ PIXEL RUSH — Hono server ▓▓`);
    console.log(`  Mode:        ${DEV ? "dev" : "prod (dist/)"}`);
    console.log(`  Game (UI):   http://localhost:${info.port}/`);
    console.log(`  Rooms (API): http://localhost:${info.port}/rooms`);
    console.log(`  Status:      http://localhost:${info.port}/status`);
    console.log(`  Relay (WS):  ws://localhost:${info.port}/ws?room=CODE`);
    console.log(`  Max pilots:  ${MAX_PLAYERS} per room\n`);
  }
);

(server as HttpServer).on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

/**
 * PIXEL RUSH — WebSocket relay server (Deno)
 * ------------------------------------------
 * Run with Deno (zero config):
 *
 *     deno run --allow-net --allow-read server/main.ts
 *
 * Then open  http://localhost:8000  — the server also serves the built game
 * (dist/), and the game auto-detects the WS URL from the page address:
 *
 *   - page on port 8000        => connects to the same origin (ws://host:8000)
 *   - page on any other host   => connects to ws://<same host>:8000
 *
 * Endpoints:
 *   /                    the game frontend (dist/index.html)
 *   /assets/*, ...       static game files from dist/ (SPA fallback)
 *   /ws?room=ROOM_CODE   websocket relay
 *   /rooms               open-room directory (for the LIVE ROOMS list)
 *   /status              JSON debug page
 *
 * Default port is 8000 — override with the PORT env var.
 *
 * The relay assigns ids, marks the first joiner as HOST, caps rooms at
 * MAX_PLAYERS, forwards every game message to the other members of the
 * room, and announces joins / leaves / host changes.
 */

const PORT = Number(Deno.env.get("PORT") ?? 8000);
const MAX_PLAYERS = 4;

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
const roomStatus = new Map<string, string>(); // "lobby" | "battle"
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

const CORS = {
  "access-control-allow-origin": "*",
  "content-type": "application/json; charset=utf-8",
};

const json = (obj: unknown, status = 200) =>
  new Response(JSON.stringify(obj, null, 2), { status, headers: CORS });

/* ---------- static game files (dist/) ---------- */
const DIST = new URL("../dist/", import.meta.url);
const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".mp3": "audio/mpeg",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

async function staticFile(rel: string): Promise<Response | null> {
  if (rel.includes("..")) return null;
  try {
    const url = new URL(rel, DIST);
    const data = await Deno.readFile(url);
    const ext = rel.includes(".") ? rel.slice(rel.lastIndexOf(".")) : "";
    // Vite fingerprints /assets/* so they can be cached forever; HTML not.
    const cache = rel.startsWith("/assets/")
      ? "public, max-age=31536000, immutable"
      : "no-cache";
    return new Response(data, {
      headers: {
        "content-type": MIME[ext] ?? "application/octet-stream",
        "cache-control": cache,
      },
    });
  } catch {
    return null;
  }
}

Deno.serve({ port: PORT }, async (req) => {
  const url = new URL(req.url);

  // ---------- room directory (used by the lobby UI) ----------
  if (url.pathname === "/rooms") {
    return json({
      maxPlayers: MAX_PLAYERS,
      rooms: [...rooms.entries()].map(([room, list]) => ({
        room,
        players: list.length,
        max: MAX_PLAYERS,
        status: roomStatus.get(room) ?? "lobby",
        pilots: list.map(pub),
      })),
    });
  }

  // ---------- status page (quick debug) ----------
  if (url.pathname === "/status") {
    return json({
      name: "PIXEL RUSH relay server",
      ws: `ws://localhost:${PORT}/ws?room=<ROOM_CODE>`,
      rooms: `http://localhost:${PORT}/rooms`,
      maxPlayers: MAX_PLAYERS,
      open: [...rooms.entries()].map(([room, list]) => ({
        room,
        players: list.map(pub),
      })),
    });
  }

  // ---------- frontend: serve the built game from dist/ ----------
  if (url.pathname !== "/ws") {
    const asset = await staticFile(url.pathname === "/" ? "/index.html" : url.pathname);
    if (asset) return asset;
    const spa = await staticFile("/index.html"); // SPA fallback
    if (spa) return spa;
    return new Response("Not found — run `npm run build` first", { status: 404 });
  }
  if (req.headers.get("upgrade") !== "websocket") {
    return new Response("Expected a WebSocket upgrade", { status: 400 });
  }

  const room =
    (url.searchParams.get("room") ?? "default").trim().toUpperCase().slice(0, 16) || "default";

  // Enforce the 4-player cap before upgrading the connection.
  const existing = rooms.get(room);
  if (existing && existing.length >= MAX_PLAYERS) {
    return json({ error: "room-full", room, max: MAX_PLAYERS }, 403);
  }

  const { socket, response } = Deno.upgradeWebSocket(req);
  const id = `p${++seq}-${crypto.randomUUID().slice(0, 6)}`;
  let me: Client | null = null;

  socket.onopen = () => {
    const list = rooms.get(room) ?? [];
    const youHost = list.length === 0; // first joiner => HOST
    me = { id, ws: socket, room, name: "PILOT", color: "#00f0ff" };
    list.push(me);
    rooms.set(room, list);
    send(socket, {
      t: "welcome",
      id,
      room,
      youHost,
      maxPlayers: MAX_PLAYERS,
      peers: list.filter((c) => c !== me).map(pub),
    });
    console.log(
      `[+] ${id} joined "${room}" (${youHost ? "HOST" : "guest"}) — ${list.length}/${MAX_PLAYERS} pilots`,
    );
  };

  socket.onmessage = (ev) => {
    if (!me) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(ev.data));
    } catch {
      return;
    }
    const list = rooms.get(room);
    if (!list) return;

    if (msg.t === "join") {
      me.name = String(msg.name ?? "PILOT").slice(0, 14);
      me.color = String(msg.color ?? "#00f0ff").slice(0, 9);
      roomStatus.set(room, roomStatus.get(room) ?? "lobby");
      broadcast(list, { t: "peer-join", id, name: me.name, color: me.color }, id);
      console.log(`[~] ${id} is now "${me.name}" (room "${room}")`);
      return;
    }

    // Track match state so the room directory can show lobby / battle.
    if (msg.t === "start") roomStatus.set(room, "battle");
    else if (msg.t === "lobby") roomStatus.set(room, "lobby");

    // Everything else (ship, pshot, snap, start...) is relayed verbatim.
    broadcast(list, { ...msg, from: id }, id);
  };

  const leave = () => {
    const list = rooms.get(room);
    if (!list || !me) return;
    const idx = list.indexOf(me);
    if (idx < 0) return;
    const wasHost = idx === 0;
    list.splice(idx, 1);
    if (list.length === 0) {
      rooms.delete(room);
      roomStatus.delete(room);
    } else {
      broadcast(list, { t: "peer-leave", id });
      // Host left => promote the next player in line.
      if (wasHost) {
        const newHost = list[0];
        broadcast(list, { t: "host", id: newHost.id });
        console.log(`[*] ${newHost.id} is the new HOST of "${room}"`);
      }
    }
    console.log(`[-] ${id} left "${room}"`);
    me = null;
  };

  socket.onclose = leave;
  socket.onerror = leave;

  return response;
});

console.log(`\n  ▓▓ PIXEL RUSH — Deno server ▓▓`);
console.log(`  Game (UI):   http://localhost:${PORT}/`);
console.log(`  Relay (WS):  ws://localhost:${PORT}/ws?room=<ROOM_CODE>`);
console.log(`  Rooms (API): http://localhost:${PORT}/rooms`);
console.log(`  Status:      http://localhost:${PORT}/status`);
console.log(`  Max pilots:  ${MAX_PLAYERS} per room\n`);

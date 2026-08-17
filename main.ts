/**
 * PIXEL RUSH — Deno server (frontend + WebSocket relay)
 * -----------------------------------------------------
 * One Deno process serves the game frontend AND the multiplayer relay on a
 * single port (default 8000). No Node.js needed at runtime.
 *
 *   deno task dev     dev: Vite middleware mode + HMR (port 24678) + relay
 *   deno task build   build the frontend into dist/
 *   deno task start   prod: serve dist/ + relay
 *
 * Endpoints:
 *   /                    the game frontend
 *   /ws?room=ROOM_CODE   websocket relay
 *   /rooms               open-room directory (for the LIVE ROOMS list)
 *   /status              JSON debug page
 *
 * The relay assigns ids, marks the first joiner as HOST, caps rooms at
 * MAX_PLAYERS, forwards every game message to the other members of the
 * room, and announces joins / leaves / host changes.
 */

import { fileURLToPath } from "node:url";

const PORT = Number(Deno.env.get("PORT") ?? 8000);
const DEV = Deno.args.includes("--dev");
const MAX_PLAYERS = 2;

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

/* ---------- frontend: dev (Vite middleware mode + HMR) ---------- */
const ROOT = fileURLToPath(new URL(".", import.meta.url));

let vitePromise: Promise<any> | null = null;
function getVite(): Promise<any> {
  vitePromise ??= (async () => {
    const { createServer } = await import("npm:vite@6.4.3");
    const react = (await import("npm:@vitejs/plugin-react@4.7.0")).default;
    const tailwindcss = (await import("npm:@tailwindcss/vite@4.3.3")).default;
    const vite = await createServer({
      root: ROOT,
      // Vite's config loader can't resolve bare deps from its temp file under
      // Deno, so load the plugins directly (keep in sync with vite.config.js).
      configFile: false,
      plugins: [react(), tailwindcss()],
      server: { middlewareMode: true },
      appType: "spa",
    });
    return vite;
  })();
  return vitePromise;
}

/** Convert a fetch Request into a minimal Node IncomingMessage for Vite. */
function toNodeReq(req: Request): any {
  const url = new URL(req.url);
  const headers: Record<string, string> = {};
  for (const [k, v] of req.headers.entries()) headers[k.toLowerCase()] = v;
  if (!headers.host) headers.host = url.host;
  return {
    method: req.method,
    url: url.pathname + url.search,
    headers,
    rawHeaders: Object.entries(headers).flatMap(([k, v]) => [k, v]),
    httpVersion: "1.1",
    socket: { remoteAddress: "127.0.0.1", remotePort: 0, encrypted: false },
    connection: {},
  };
}

/** Bridge Vite's connect middleware to a fetch handler. */
function viteFetchHandler(vite: any): (req: Request) => Promise<Response> {
  const middlewares = vite.middlewares;
  return (req: Request) =>
    new Promise<Response>((resolve) => {
      let settled = false;
      const settle = (r: Response) => {
        if (!settled) {
          settled = true;
          resolve(r);
        }
      };
      const nodeRes: any = {
        statusCode: 200,
        headers: new Headers(),
        finished: false,
        chunks: [] as Uint8Array[],
        setHeader(k: string, v: any) {
          if (Array.isArray(v)) {
            this.headers.delete(k);
            for (const item of v) this.headers.append(k, String(item));
          } else {
            this.headers.set(k, String(v));
          }
        },
        getHeader(k: string) {
          return this.headers.get(k);
        },
        removeHeader(k: string) {
          this.headers.delete(k);
        },
        hasHeader(k: string) {
          return this.headers.has(k);
        },
        writeHead(status: number, h?: any) {
          this.statusCode = status;
          if (h) {
            if (Array.isArray(h)) {
              for (let i = 0; i < h.length; i += 2) this.setHeader(String(h[i]), h[i + 1]);
            } else {
              for (const [k, v] of Object.entries(h)) this.setHeader(k, v);
            }
          }
          return this;
        },
        write(c: any) {
          if (c != null) {
            if (typeof c === "string") this.chunks.push(new TextEncoder().encode(c));
            else if (c instanceof Uint8Array) this.chunks.push(c);
            else this.chunks.push(new TextEncoder().encode(String(c)));
          }
          return true;
        },
        end(c?: any) {
          if (c != null) this.write(c);
          this.finished = true;
          const body = this.chunks.length ? new Blob(this.chunks) : null;
          settle(new Response(body, { status: this.statusCode, headers: this.headers }));
        },
      };
      middlewares(toNodeReq(req), nodeRes, (err?: unknown) => {
        if (err) {
          settle(new Response(String((err as Error)?.message ?? err), { status: 500 }));
        } else if (!nodeRes.finished) {
          settle(new Response("Not found", { status: 404 }));
        }
      });
    });
}

/* ---------- static game files (dist/) ---------- */
const DIST = new URL("dist/", import.meta.url);
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
    // rel starts with "/" (e.g. "/index.html"); strip it so it resolves
    // relative to DIST instead of the filesystem root.
    const url = new URL(rel.replace(/^\/+/, ""), DIST);
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

  // ---------- frontend ----------
  if (url.pathname !== "/ws") {
    if (DEV) {
      const vite = await getVite();
      return await viteFetchHandler(vite)(req);
    }
    const asset = await staticFile(url.pathname === "/" ? "/index.html" : url.pathname);
    if (asset) return asset;
    const spa = await staticFile("/index.html"); // SPA fallback
    if (spa) return spa;
    return new Response("Not found — run `deno task build` first", { status: 404 });
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
console.log(`  Mode:        ${DEV ? "dev (Vite + HMR on :24678)" : "prod (dist/)"}`);
console.log(`  Game (UI):   http://localhost:${PORT}/`);
console.log(`  Relay (WS):  ws://localhost:${PORT}/ws?room=<ROOM_CODE>`);
console.log(`  Rooms (API): http://localhost:${PORT}/rooms`);
console.log(`  Status:      http://localhost:${PORT}/status`);
console.log(`  Max pilots:  ${MAX_PLAYERS} per room\n`);

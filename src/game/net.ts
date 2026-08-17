/* WebSocket client for co-op mode. JSON protocol, relay server (see main.ts). */

export type NetMsg = Record<string, unknown> & { t: string; from?: string };

export interface PeerInfo {
  id: string;
  name: string;
  color: string;
}

export interface RoomInfo {
  room: string;
  players: number;
  max: number;
  status?: "lobby" | "battle";
}

/** ws://host:port  ->  http://host:port (for the /rooms directory) */
export function httpBase(wsUrl: string): string {
  return wsUrl.trim().replace(/\/$/, "").replace(/^ws/i, "http");
}

/**
 * Auto-derive the relay server address from the page URL:
 *  - page served on port 8000  => the relay is the same origin
 *  - any other page (dev / preview) => relay on the same host, port 8000
 *  - https page => wss://
 */
export function defaultWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss://" : "ws://";
  const host = window.location.hostname;
  if (window.location.port === "8000") return `${proto}${window.location.host}`;
  return `${proto}${host}:8000`;
}

/** Ask the server for the list of open rooms. Throws when unreachable. */
export async function fetchRooms(wsUrl: string): Promise<RoomInfo[]> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${httpBase(wsUrl)}/rooms`, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = (await res.json()) as { rooms?: RoomInfo[] };
    return data.rooms ?? [];
  } finally {
    window.clearTimeout(timer);
  }
}

export class NetClient {
  id = "";
  youHost = false;
  room = "";
  maxPlayers = 4;
  peers: PeerInfo[] = [];
  onMsg: ((m: NetMsg) => void) | null = null;
  onPeers: ((peers: PeerInfo[]) => void) | null = null;
  onClose: (() => void) | null = null;
  private ws: WebSocket | null = null;
  private closedByMe = false;

  get open(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(url: string, name: string, colorFor: (peers: PeerInfo[]) => string): Promise<void> {
    return new Promise((resolve, reject) => {
      let settled = false;
      let ws: WebSocket;
      try {
        ws = new WebSocket(url);
      } catch (e) {
        reject(e instanceof Error ? e : new Error("Invalid server address"));
        return;
      }
      this.ws = ws;
      this.closedByMe = false;

      const timer = window.setTimeout(() => {
        if (!settled) {
          settled = true;
          this.close();
          reject(new Error("Connection timed out"));
        }
      }, 7000);

      ws.onmessage = (ev) => {
        let m: NetMsg;
        try {
          m = JSON.parse(String(ev.data)) as NetMsg;
        } catch {
          return;
        }
        if (m.t === "welcome") {
          this.id = String(m.id ?? "");
          this.youHost = !!m.youHost;
          this.room = String(m.room ?? "");
          this.maxPlayers = Number(m.maxPlayers ?? 4);
          this.peers = (m.peers as PeerInfo[]) ?? [];
          ws.send(JSON.stringify({ t: "join", name, color: colorFor(this.peers) }));
          window.clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve();
          }
          this.onPeers?.([...this.peers]);
          return;
        }
        if (m.t === "peer-join") {
          this.peers = [
            ...this.peers,
            { id: String(m.id), name: String(m.name), color: String(m.color) },
          ];
          this.onPeers?.([...this.peers]);
        } else if (m.t === "peer-leave") {
          this.peers = this.peers.filter((p) => p.id !== m.id);
          this.onPeers?.([...this.peers]);
        }
        this.onMsg?.(m);
      };

      ws.onerror = () => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error("Cannot reach the server"));
        }
      };

      ws.onclose = () => {
        if (!settled) {
          settled = true;
          window.clearTimeout(timer);
          reject(new Error("Connection closed by the server"));
        } else if (!this.closedByMe) {
          this.onClose?.();
        }
      };
    });
  }

  send(m: Record<string, unknown>) {
    if (this.open) {
      try {
        this.ws!.send(JSON.stringify(m));
      } catch {
        /* ignore */
      }
    }
  }

  close() {
    this.closedByMe = true;
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* ignore */
      }
    }
    this.ws = null;
  }
}

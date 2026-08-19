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
  return `${proto}${window.location.host}`;
}

/** Ask the server for the list of open rooms. Throws when unreachable. */
export async function fetchRooms(wsUrl: string): Promise<RoomInfo[]> {
  const ctrl = new AbortController();
  const timer = window.setTimeout(() => ctrl.abort(), 2500);
  try {
    const res = await fetch(`${httpBase(wsUrl)}/rooms`, {
      signal: ctrl.signal,
    });
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
  maxPlayers = 2;
  peers: PeerInfo[] = [];
  onMsg: ((m: NetMsg) => void) | null = null;
  onPeers: ((peers: PeerInfo[]) => void) | null = null;
  onClose: (() => void) | null = null;
  private ws: WebSocket | null = null;
  private closedByMe = false;

  // WebRTC
  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  get open(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  connect(
    url: string,
    name: string,
    colorFor: (peers: PeerInfo[]) => string,
  ): Promise<void> {
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

      ws.onmessage = async (ev) => {
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
          this.maxPlayers = Number(m.maxPlayers ?? 2);
          this.peers = (m.peers as PeerInfo[]) ?? [];
          ws.send(
            JSON.stringify({ t: "join", name, color: colorFor(this.peers) }),
          );
          window.clearTimeout(timer);
          if (!settled) {
            settled = true;
            resolve();
          }
          this.onPeers?.([...this.peers]);

          // Setup WebRTC after connection
          this.setupWebRTC();
          return;
        }

        // WebRTC Signaling messages
        if (m.t === "offer") {
          await this.handleOffer(m.offer as RTCSessionDescriptionInit);
          return;
        }
        if (m.t === "answer") {
          await this.handleAnswer(m.answer as RTCSessionDescriptionInit);
          return;
        }
        if (m.t === "ice-candidate") {
          await this.handleIceCandidate(m.candidate as RTCIceCandidateInit);
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

  // --- WebRTC Methods ---

  private async setupWebRTC() {
    const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
    this.pc = new RTCPeerConnection({ iceServers });

    this.pc.onicecandidate = (e) => {
      if (e.candidate && this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            t: "ice-candidate",
            candidate: e.candidate,
          }),
        );
      }
    };

    this.pc.oniceconnectionstatechange = () => {
      console.log("ICE connection state:", this.pc?.iceConnectionState);
      if (
        this.pc?.iceConnectionState === "failed" ||
        this.pc?.iceConnectionState === "disconnected"
      ) {
        console.warn(
          "WebRTC ICE failed, falling back to WebSocket for game state",
        );
      }
    };

    if (this.youHost) {
      // Host creates data channel
      this.dataChannel = this.pc.createDataChannel("game");
      this.setupDataChannelHandlers();

      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);

      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(
          JSON.stringify({
            t: "offer",
            offer: this.pc.localDescription,
          }),
        );
      }
    } else {
      // Guest receives data channel
      this.pc.ondatachannel = (e) => {
        this.dataChannel = e.channel;
        this.setupDataChannelHandlers();
      };
    }
  }

  private setupDataChannelHandlers() {
    if (!this.dataChannel) return;

    this.dataChannel.onopen = () => {
      console.log("WebRTC Data Channel Open");
      this.pendingCandidates = [];
    };

    this.dataChannel.onerror = (e) => {
      console.warn("WebRTC Data Channel error:", e);
    };

    this.dataChannel.onclose = () => {
      console.warn("WebRTC Data Channel closed, will fallback to WebSocket");
    };

    this.dataChannel.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        // Forward to onMsg handler
        this.onMsg?.(msg);
      } catch (err) {
        console.error("Failed to parse data channel message", err);
      }
    };
  }

  private async handleOffer(offer: RTCSessionDescriptionInit) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(
        JSON.stringify({
          t: "answer",
          answer: this.pc.localDescription,
        }),
      );
    }
  }

  private async handleAnswer(answer: RTCSessionDescriptionInit) {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(new RTCSessionDescription(answer));

    // Add pending candidates
    for (const candidate of this.pendingCandidates) {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }
  }

  private async handleIceCandidate(candidate: RTCIceCandidateInit) {
    if (!this.pc) return;

    if (this.pc.remoteDescription) {
      await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      this.pendingCandidates.push(candidate);
    }
  }

  // Send game state via WebRTC (Host only)
  broadcastState(state: Record<string, unknown>) {
    if (this.dataChannel && this.dataChannel.readyState === "open") {
      this.dataChannel.send(JSON.stringify(state));
    } else if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      // Fallback to WebSocket if data channel is not available
      this.ws.send(JSON.stringify(state));
    }
  }

  // --- End WebRTC Methods ---

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
    if (this.dataChannel) {
      try {
        this.dataChannel.close();
      } catch {}
      this.dataChannel = null;
    }
    if (this.pc) {
      try {
        this.pc.close();
      } catch {}
      this.pc = null;
    }
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

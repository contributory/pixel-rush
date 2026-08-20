/* HTTP long-poll client for co-op mode. RabbitMQ remains server-side only. */

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

/** Normalize http(s), ws(s), or a bare hostname to an HTTP origin. */
export function normalizeHttpOrigin(raw: string): string {
  let value = raw.trim();
  if (!value) return "";
  if (!/^[a-z][a-z0-9+.-]*:/i.test(value)) {
    const protocol = typeof window !== "undefined" && window.location.protocol === "https:"
      ? "https://"
      : "http://";
    value = protocol + value;
  }
  value = value.replace(/^ws:/i, "http:").replace(/^wss:/i, "https:");
  try {
    const parsed = new URL(value);
    const path = parsed.pathname.replace(/\/+$/, "").replace(/\/ws$/i, "");
    return `${parsed.origin}${path && path !== "/" ? path : ""}`;
  } catch {
    return "";
  }
}

/** Backward-compatible alias for server values saved by older releases. */
export const normalizeWsOrigin = normalizeHttpOrigin;

export function defaultHttpUrl(): string {
  return window.location.origin;
}

/** Backward-compatible alias used by existing UI state. */
export const defaultWsUrl = defaultHttpUrl;

export function httpBase(server: string): string {
  return normalizeHttpOrigin(server);
}

/** Ask the server for the list of open rooms. Throws when unreachable. */
export async function fetchRooms(server: string): Promise<RoomInfo[]> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 2500);
  try {
    const base = httpBase(server);
    if (!base) throw new Error("Invalid server address");
    const response = await fetch(`${base}/rooms`, {
      signal: controller.signal,
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const data = (await response.json()) as { rooms?: RoomInfo[] };
    return data.rooms ?? [];
  } finally {
    window.clearTimeout(timer);
  }
}

interface JoinResponse {
  id?: string;
  room?: string;
  youHost?: boolean;
  maxPlayers?: number;
  peers?: PeerInfo[];
  error?: string;
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

  private base = "";
  private closedByMe = false;
  private joined = false;
  private pollController: AbortController | null = null;
  private sendChain: Promise<void> = Promise.resolve();

  private pc: RTCPeerConnection | null = null;
  private dataChannel: RTCDataChannel | null = null;
  private pendingCandidates: RTCIceCandidateInit[] = [];

  get open(): boolean {
    return this.joined && !this.closedByMe;
  }

  async connect(
    server: string,
    room: string,
    name: string,
    colorFor: (peers: PeerInfo[]) => string,
  ): Promise<void> {
    this.base = normalizeHttpOrigin(server);
    this.room = room.trim().toUpperCase();
    this.closedByMe = false;
    if (!this.base || !this.room) throw new Error("Invalid server address or room");

    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 7000);
    let response: Response;
    try {
      response = await fetch(`${this.base}/join/${encodeURIComponent(this.room)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, color: "" }),
        signal: controller.signal,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "AbortError") {
        throw new Error("Connection timed out");
      }
      throw new Error("Cannot reach the server");
    } finally {
      window.clearTimeout(timer);
    }

    const data = (await response.json().catch(() => ({}))) as JoinResponse;
    if (!response.ok) throw new Error(data.error || `Server returned HTTP ${response.status}`);
    if (!data.id) throw new Error("Invalid response from server");

    this.id = data.id;
    this.room = data.room || this.room;
    this.youHost = !!data.youHost;
    this.maxPlayers = Number(data.maxPlayers ?? 2);
    this.peers = data.peers ?? [];
    this.joined = true;
    this.onPeers?.([...this.peers]);

    await this.post({ t: "join", name, color: colorFor(this.peers) });
    void this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (this.open) {
      this.pollController = new AbortController();
      try {
        const response = await fetch(
          `${this.base}/poll/${encodeURIComponent(this.room)}/${encodeURIComponent(this.id)}`,
          { signal: this.pollController.signal, cache: "no-store" },
        );
        if (response.status === 404) throw new Error("Session expired");
        if (!response.ok) throw new Error(`Poll failed: HTTP ${response.status}`);
        const data = (await response.json()) as { messages?: NetMsg[] };
        failures = 0;
        for (const message of data.messages ?? []) await this.handleMessage(message);
      } catch (error) {
        if (!this.open || (error instanceof DOMException && error.name === "AbortError")) return;
        failures += 1;
        if (failures >= 3) {
          this.joined = false;
          this.onClose?.();
          return;
        }
        await new Promise((resolve) => window.setTimeout(resolve, failures * 500));
      }
    }
  }

  private async handleMessage(message: NetMsg): Promise<void> {
    if (message.t === "offer") {
      await this.handleOffer(message.offer as RTCSessionDescriptionInit);
      return;
    }
    if (message.t === "answer") {
      await this.handleAnswer(message.answer as RTCSessionDescriptionInit);
      return;
    }
    if (message.t === "ice-candidate") {
      await this.handleIceCandidate(message.candidate as RTCIceCandidateInit);
      return;
    }
    if (message.t === "peer-join") {
      const peer = {
        id: String(message.id),
        name: String(message.name),
        color: String(message.color),
      };
      this.peers = [...this.peers.filter((p) => p.id !== peer.id), peer];
      this.onPeers?.([...this.peers]);
    } else if (message.t === "peer-leave") {
      this.peers = this.peers.filter((p) => p.id !== message.id);
      this.onPeers?.([...this.peers]);
    } else if (message.t === "host") {
      this.youHost = message.id === this.id;
    }
    this.onMsg?.(message);
  }

  private post(message: Record<string, unknown>): Promise<void> {
    if (!this.open) return Promise.resolve();
    const task = this.sendChain.then(async () => {
      const response = await fetch(
        `${this.base}/send/${encodeURIComponent(this.room)}/${encodeURIComponent(this.id)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(message),
          keepalive: true,
        },
      );
      if (!response.ok) throw new Error(`Send failed: HTTP ${response.status}`);
    });
    this.sendChain = task.catch(() => undefined);
    return task;
  }

  async startWebRTC(): Promise<void> {
    if (this.peers.length !== 1) throw new Error("WebRTC requires exactly 2 players in the room");
    if (!this.pc) await this.setupWebRTC(true);
  }

  private async setupWebRTC(createOffer: boolean): Promise<void> {
    this.pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
    });
    this.pc.onicecandidate = (event) => {
      if (event.candidate) this.send({ t: "ice-candidate", candidate: event.candidate });
    };
    this.pc.oniceconnectionstatechange = () => {
      if (this.pc?.iceConnectionState === "failed") {
        console.warn("WebRTC ICE failed; using HTTP relay fallback");
      }
    };
    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.setupDataChannelHandlers();
    };

    if (createOffer) {
      this.dataChannel = this.pc.createDataChannel("game");
      this.setupDataChannelHandlers();
      const offer = await this.pc.createOffer();
      await this.pc.setLocalDescription(offer);
      this.send({ t: "offer", offer: this.pc.localDescription });
    }
  }

  private setupDataChannelHandlers(): void {
    if (!this.dataChannel) return;
    this.dataChannel.onopen = () => {
      this.pendingCandidates = [];
    };
    this.dataChannel.onerror = (error) => console.warn("WebRTC DataChannel error", error);
    this.dataChannel.onmessage = (event) => {
      try {
        this.onMsg?.(JSON.parse(String(event.data)) as NetMsg);
      } catch {
        console.warn("Ignored invalid WebRTC message");
      }
    };
  }

  private async handleOffer(offer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) await this.setupWebRTC(false);
    await this.pc!.setRemoteDescription(offer);
    const answer = await this.pc!.createAnswer();
    await this.pc!.setLocalDescription(answer);
    this.send({ t: "answer", answer: this.pc!.localDescription });
    await this.flushCandidates();
  }

  private async handleAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    if (!this.pc) return;
    await this.pc.setRemoteDescription(answer);
    await this.flushCandidates();
  }

  private async handleIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    if (!this.pc || !this.pc.remoteDescription) {
      this.pendingCandidates.push(candidate);
      return;
    }
    await this.pc.addIceCandidate(candidate);
  }

  private async flushCandidates(): Promise<void> {
    if (!this.pc?.remoteDescription) return;
    for (const candidate of this.pendingCandidates.splice(0)) {
      await this.pc.addIceCandidate(candidate);
    }
  }

  broadcastState(state: Record<string, unknown>): void {
    if (this.dataChannel?.readyState === "open") {
      this.dataChannel.send(JSON.stringify(state));
    } else {
      this.send(state);
    }
  }

  send(message: Record<string, unknown>): void {
    void this.post(message).catch(() => undefined);
  }

  close(): void {
    if (this.closedByMe) return;
    const leaveUrl = this.id
      ? `${this.base}/leave/${encodeURIComponent(this.room)}/${encodeURIComponent(this.id)}`
      : "";
    this.closedByMe = true;
    this.joined = false;
    this.pollController?.abort();
    this.pollController = null;
    this.dataChannel?.close();
    this.dataChannel = null;
    this.pc?.close();
    this.pc = null;
    if (leaveUrl) {
      if (!navigator.sendBeacon(leaveUrl, new Blob([], { type: "application/json" }))) {
        void fetch(leaveUrl, { method: "POST", keepalive: true }).catch(() => undefined);
      }
    }
  }
}

import asyncio
import json
import time

from rabbit import INSTANCE_ID, RabbitHub
from sanic import Sanic
from sanic import json as json_response
from sanic.response import HTTPResponse

app = Sanic("PixelRushServer")

# Configuration
PORT = 8000
MAX_PLAYERS = 2
HEARTBEAT_SECONDS = 10
# Long-poll timeout: how long /poll holds an open connection waiting for messages.
# Keep below EdgeOne's upstream timeout (~30s).
POLL_TIMEOUT = 20

# Players on THIS instance.
# Shape: { "ROOM_CODE": [ {"id", "name", "color", "joined_at", "queue": asyncio.Queue}, ... ] }
CONNECTED_ROOMS: dict[str, list] = {}

# Shared room registry — merged from every instance via RabbitMQ.
ROOM_REGISTRY: dict[str, dict] = {}

seq = 0

# RabbitMQ hub — shares state & routes messages between instances
hub = RabbitHub()


# --- Helper Functions ---

def room_players(room_code: str) -> list:
    return ROOM_REGISTRY.get(room_code, {}).get("players", [])


def sort_players(players: list) -> list:
    return sorted(players, key=lambda p: (p.get("joined_at", 0), p.get("id", "")))


def rooms_from_registry() -> list:
    return [
        {
            "room": code,
            "players": len(info["players"]),
            "max": info["max"],
            "status": info["status"],
            "pilots": info["players"],
        }
        for code, info in ROOM_REGISTRY.items()
    ]


async def enqueue(room_code: str, message_dict: dict, except_id: str | None = None):
    """Push a message into every LOCAL player's queue (except except_id)."""
    for client in list(CONNECTED_ROOMS.get(room_code, [])):
        if client["id"] != except_id:
            try:
                client["queue"].put_nowait(message_dict)
            except asyncio.QueueFull:
                pass


async def relay(room_code: str, message_dict: dict, except_id: str | None = None):
    """Enqueue locally + publish to RabbitMQ so other instances receive it."""
    await enqueue(room_code, message_dict, except_id)
    try:
        await hub.publish_room_msg(room_code, message_dict)
    except Exception as e:
        print(f"[Relay] publish {room_code} failed: {e}")


async def publish_room_state(room_code: str, deleted: bool = False):
    """Update the local registry + publish a room-state snapshot to RabbitMQ."""
    current = ROOM_REGISTRY.get(room_code, {})
    local_ids = {c["id"] for c in CONNECTED_ROOMS.get(room_code, [])}
    merged = [p for p in current.get("players", []) if p["id"] not in local_ids]
    merged.extend(
        {
            "id": c["id"],
            "name": c["name"],
            "color": c["color"],
            "joined_at": c.get("joined_at", 0),
        }
        for c in CONNECTED_ROOMS.get(room_code, [])
    )
    merged = sort_players(merged)

    ts = time.time()
    state = {
        "room": room_code,
        "players": merged,
        "status": current.get("status", "lobby"),
        "max": MAX_PLAYERS,
        "deleted": deleted,
        "ts": ts,
    }
    if deleted:
        ROOM_REGISTRY.pop(room_code, None)
    else:
        src_ts = dict(current.get("src_ts", {}))
        src_ts[INSTANCE_ID] = ts
        ROOM_REGISTRY[room_code] = {**state, "src_ts": src_ts}
    try:
        await hub.publish_room_state(room_code, state)
    except Exception as e:
        print(f"[State] publish {room_code} failed: {e}")


async def handle_room_state(room_code: str, payload: dict):
    """Update the registry from another instance's state event."""
    if payload.get("deleted"):
        ROOM_REGISTRY.pop(room_code, None)
        return

    src = str(payload.get("src", ""))
    event_ts = payload.get("ts", 0)
    current = ROOM_REGISTRY.get(room_code, {})
    if event_ts < current.get("src_ts", {}).get(src, 0):
        return

    local_ids = {c["id"] for c in CONNECTED_ROOMS.get(room_code, [])}
    remote = [p for p in payload.get("players", []) if p["id"] not in local_ids]
    local = [
        {
            "id": c["id"],
            "name": c["name"],
            "color": c["color"],
            "joined_at": c.get("joined_at", 0),
        }
        for c in CONNECTED_ROOMS.get(room_code, [])
    ]

    src_ts = dict(current.get("src_ts", {}))
    src_ts[src] = event_ts
    ROOM_REGISTRY[room_code] = {
        "room": room_code,
        "players": sort_players(remote + local),
        "status": payload.get("status", "lobby"),
        "max": payload.get("max", MAX_PLAYERS),
        "ts": event_ts,
        "src_ts": src_ts,
    }


async def handle_room_msg(room_code: str, message: dict):
    """Deliver a message from another instance to local players."""
    await enqueue(room_code, message)


async def handle_sync_request():
    for room_code in list(CONNECTED_ROOMS.keys()):
        await publish_room_state(room_code)


async def heartbeat_loop():
    while True:
        await asyncio.sleep(HEARTBEAT_SECONDS)
        now = time.time()
        for room_code in list(CONNECTED_ROOMS.keys()):
            # Evict players whose last_seen is stale (no poll in 2× poll timeout)
            stale_ids = {
                c["id"]
                for c in CONNECTED_ROOMS.get(room_code, [])
                if now - c.get("last_seen", now) > POLL_TIMEOUT * 2
            }
            if stale_ids:
                for sid in stale_ids:
                    await _remove_player(room_code, sid)
            try:
                await publish_room_state(room_code)
            except Exception as e:
                print(f"[Heartbeat] publish {room_code} failed: {e}")


async def _remove_player(room_code: str, player_id: str):
    """Remove a player from local state, publish updates, transfer host if needed."""
    if room_code not in CONNECTED_ROOMS:
        return
    CONNECTED_ROOMS[room_code] = [
        c for c in CONNECTED_ROOMS[room_code] if c["id"] != player_id
    ]
    remaining = [p for p in room_players(room_code) if p["id"] != player_id]

    await relay(room_code, {"t": "peer-leave", "id": player_id})

    if not CONNECTED_ROOMS.get(room_code):
        CONNECTED_ROOMS.pop(room_code, None)
        await publish_room_state(room_code, deleted=True)
        try:
            await hub.unbind_room(room_code)
        except Exception:
            pass
    else:
        current = ROOM_REGISTRY.get(room_code, {})
        src_ts = dict(current.get("src_ts", {}))
        src_ts[INSTANCE_ID] = time.time()
        ROOM_REGISTRY[room_code] = {
            "room": room_code,
            "players": sort_players(remaining),
            "status": current.get("status", "lobby"),
            "max": MAX_PLAYERS,
            "ts": time.time(),
            "src_ts": src_ts,
        }
        await publish_room_state(room_code)
        if remaining:
            await relay(room_code, {"t": "host", "id": remaining[0]["id"]})


def _find_client(room_code: str, player_id: str) -> dict | None:
    for c in CONNECTED_ROOMS.get(room_code, []):
        if c["id"] == player_id:
            return c
    return None


# --- HTTP Routes ---

@app.get("/rooms")
async def get_rooms(request):
    return json_response({"maxPlayers": MAX_PLAYERS, "rooms": rooms_from_registry()})


@app.get("/status")
async def get_status(request):
    return json_response(
        {
            "name": "PIXEL RUSH Python relay server",
            "instance": INSTANCE_ID,
            "rabbitmq": hub.connected,
            "maxPlayers": MAX_PLAYERS,
            "open": [
                {"room": code, "players": info["players"]}
                for code, info in ROOM_REGISTRY.items()
            ],
        }
    )


# --- HTTP Polling API ---

@app.post("/join/<room_code:str>")
async def join_room(request, room_code: str):
    """Join or create a room. Returns {id, youHost, peers, maxPlayers}."""
    global seq
    room_code = room_code.strip().upper()

    if len(room_players(room_code)) >= MAX_PLAYERS:
        return json_response({"error": "Room is full"}, status=409)

    if room_code not in CONNECTED_ROOMS:
        CONNECTED_ROOMS[room_code] = []
        try:
            await hub.bind_room(room_code)
        except Exception as e:
            print(f"[Join] bind room {room_code} failed: {e}")

    seq += 1
    player_id = f"{INSTANCE_ID}-p{seq}"
    you_host = len(room_players(room_code)) == 0

    body: dict = request.json or {}
    client_info = {
        "id": player_id,
        "name": str(body.get("name", "Pilot"))[:32],
        "color": str(body.get("color", "#888"))[:16],
        "joined_at": time.time(),
        "last_seen": time.time(),
        "queue": asyncio.Queue(maxsize=256),
    }
    CONNECTED_ROOMS[room_code].append(client_info)
    await publish_room_state(room_code)

    existing_peers = [
        {"id": p["id"], "name": p["name"], "color": p["color"]}
        for p in room_players(room_code)
        if p["id"] != player_id
    ]

    return json_response(
        {
            "id": player_id,
            "room": room_code,
            "youHost": you_host,
            "maxPlayers": MAX_PLAYERS,
            "peers": existing_peers,
        }
    )


@app.get("/poll/<room_code:str>/<player_id:str>")
async def poll(request, room_code: str, player_id: str):
    """Long-poll: holds the connection until a message arrives or timeout.
    Returns {messages: [...]}. Client should call again immediately after."""
    room_code = room_code.strip().upper()
    client = _find_client(room_code, player_id)
    if client is None:
        return json_response({"error": "Not in room"}, status=404)

    client["last_seen"] = time.time()

    messages = []
    try:
        # Block until at least one message arrives, then drain the rest
        first = await asyncio.wait_for(client["queue"].get(), timeout=POLL_TIMEOUT)
        messages.append(first)
        while not client["queue"].empty():
            messages.append(client["queue"].get_nowait())
    except asyncio.TimeoutError:
        pass  # return empty list — client re-polls

    return json_response({"messages": messages})


@app.post("/send/<room_code:str>/<player_id:str>")
async def send_msg(request, room_code: str, player_id: str):
    """Send a message from a player to the room."""
    room_code = room_code.strip().upper()
    client = _find_client(room_code, player_id)
    if client is None:
        return json_response({"error": "Not in room"}, status=404)

    client["last_seen"] = time.time()

    try:
        m: dict = request.json or {}
    except Exception:
        return json_response({"error": "Invalid JSON"}, status=400)

    t = str(m.get("t", ""))

    if t == "join":
        # The client chooses a free color after receiving the existing peer list.
        client["name"] = str(m.get("name", client["name"]))[:32]
        client["color"] = str(m.get("color", client["color"]))[:16]
        await publish_room_state(room_code)
        await relay(
            room_code,
            {
                "t": "peer-join",
                "id": player_id,
                "name": client["name"],
                "color": client["color"],
            },
            except_id=player_id,
        )
    elif t == "bye":
        await _remove_player(room_code, player_id)
    elif t == "start":
        ROOM_REGISTRY.setdefault(
            room_code,
            {"room": room_code, "players": [], "status": "lobby", "max": MAX_PLAYERS, "ts": 0, "src_ts": {}},
        )["status"] = "battle"
        await publish_room_state(room_code)
        m["from"] = player_id
        await relay(room_code, m, except_id=player_id)
    elif t == "lobby":
        ROOM_REGISTRY.setdefault(
            room_code,
            {"room": room_code, "players": [], "status": "lobby", "max": MAX_PLAYERS, "ts": 0, "src_ts": {}},
        )["status"] = "lobby"
        await publish_room_state(room_code)
        m["from"] = player_id
        await relay(room_code, m, except_id=player_id)
    else:
        m["from"] = player_id
        await relay(room_code, m, except_id=player_id)

    return json_response({"ok": True})


@app.post("/leave/<room_code:str>/<player_id:str>")
async def leave_room(request, room_code: str, player_id: str):
    """Explicit leave (called on page unload / quit)."""
    room_code = room_code.strip().upper()
    await _remove_player(room_code, player_id)
    return json_response({"ok": True})


# --- Startup ---

@app.before_server_start
async def setup(app, loop):
    hub.on_room_state = handle_room_state
    hub.on_room_msg = handle_room_msg
    hub.on_sync_request = handle_sync_request
    try:
        await hub.connect()
        print(f"[RabbitMQ] Connected as instance {INSTANCE_ID}")
        await hub.request_sync()
    except Exception as e:
        print(f"[RabbitMQ] Connection failed — running single-instance mode: {e}")
    loop.create_task(heartbeat_loop())


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=True)
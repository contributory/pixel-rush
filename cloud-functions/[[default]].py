import asyncio
import json
import time

from rabbit import INSTANCE_ID, RabbitHub
from sanic import Sanic, Websocket
from sanic import json as json_response

app = Sanic("PixelRushServer")

# Configuration
PORT = 8000
MAX_PLAYERS = 2
HEARTBEAT_SECONDS = 10

# In-memory Socket Manager — only holds the real WebSocket connections of THIS INSTANCE
# Shape: { "ROOM_CODE": [ {"id": "p1", "ws": WebConnection, "name": "...", "color": "...", "joined_at": ...}, ... ] }
CONNECTED_ROOMS = {}
# Shared room registry — merged from every instance via RabbitMQ.
# Shape: {
#   "ROOM_CODE": {
#       "room", "players": [{"id","name","color","joined_at"}...],
#       "status", "max", "ts",
#       "src_ts": { instance_id: ts }   # last timestamp seen from each instance
#   }
# }
ROOM_REGISTRY = {}
seq = 0

# RabbitMQ hub — shares state & routes messages between instances
hub = RabbitHub()


# --- Helper Functions ---
def room_players(room_code: str) -> list:
    """Players of a room (local + remote) from the registry."""
    return ROOM_REGISTRY.get(room_code, {}).get("players", [])


def sort_players(players: list) -> list:
    """Sort by join order — ensures every instance picks the same host."""
    return sorted(players, key=lambda p: (p.get("joined_at", 0), p.get("id", "")))


def rooms_from_registry() -> list:
    """List rooms from the shared registry (all instances)."""
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


async def broadcast(room_code: str, message_dict: dict, except_id: str | None = None):
    """Send a message to the LOCAL clients in a room (except except_id)."""
    clients = CONNECTED_ROOMS.get(room_code, [])
    payload = json.dumps(message_dict)

    for client in list(clients):
        if client["id"] != except_id:
            try:
                await client["ws"].send(payload)
            except Exception as e:
                print(f"[WS Broadcast Error] {client['id']}: {e}")


async def relay(room_code: str, message_dict: dict, except_id: str | None = None):
    """Broadcast locally + publish to RabbitMQ so other instances receive it.

    Messages this instance published itself are ignored by its own consumer
    (via src), so there is no duplication with the local broadcast.
    """
    await broadcast(room_code, message_dict, except_id)
    try:
        await hub.publish_room_msg(room_code, message_dict)
    except Exception as e:
        print(f"[Relay] publish {room_code} failed: {e}")


async def publish_room_state(room_code: str, deleted: bool = False):
    """Update the local registry + publish a room-state snapshot to RabbitMQ.

    The snapshot contains this instance's LOCAL players + the REMOTE players
    known from the registry — every instance publishes a full snapshot, so the
    registry converges correctly.
    """
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
    # Ignore older snapshots from the same instance — avoids resurrecting departed players
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
    """Broadcast a message from another instance to the local clients in a room."""
    await broadcast(room_code, message)


async def handle_sync_request():
    """Another instance just connected — republish all local rooms so it can bootstrap."""
    for room_code in list(CONNECTED_ROOMS.keys()):
        await publish_room_state(room_code)


async def heartbeat_loop():
    """Periodically publish local room state — helps new instances bootstrap
    the registry and discover rooms that are still alive."""
    while True:
        await asyncio.sleep(HEARTBEAT_SECONDS)
        for room_code in list(CONNECTED_ROOMS.keys()):
            try:
                await publish_room_state(room_code)
            except Exception as e:
                print(f"[Heartbeat] publish {room_code} failed: {e}")


# --- HTTP Routes ---


@app.get("/rooms")
async def get_rooms(request):
    """API: list of open rooms — from the shared registry (all instances)."""
    return json_response({"maxPlayers": MAX_PLAYERS, "rooms": rooms_from_registry()})


@app.get("/status")
async def get_status(request):
    """API: server debug info."""
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


# --- WebSocket Route ---


@app.websocket("/ws")
async def ws_relay(request, ws: Websocket):
    global seq

    room_code = request.args.get("room", "DEFAULT").strip().upper()
    seq += 1
    player_id = f"{INSTANCE_ID}-p{seq}"

    # Reject if the room is full based on the shared registry (local + remote)
    if len(room_players(room_code)) >= MAX_PLAYERS:
        await ws.send(json.dumps({"t": "error", "msg": "Room is full"}))
        await ws.close(code=4001, reason="room full")
        return

    # Create the local room if missing + bind the queue to receive messages from other instances
    if room_code not in CONNECTED_ROOMS:
        CONNECTED_ROOMS[room_code] = []
        try:
            await hub.bind_room(room_code)
        except Exception as e:
            print(f"[WS] bind room {room_code} failed: {e}")

    clients = CONNECTED_ROOMS[room_code]

    # The first player (across the whole system) is the HOST
    you_host = len(room_players(room_code)) == 0

    client_info = {
        "id": player_id,
        "ws": ws,
        "name": "Pilot",
        "color": "#888",
        "joined_at": time.time(),
    }
    clients.append(client_info)

    # Update the local registry + publish so other instances know
    await publish_room_state(room_code)

    # Welcome — peers come from the registry (includes players on other instances)
    existing_peers = [
        {"id": p["id"], "name": p["name"], "color": p["color"]}
        for p in room_players(room_code)
        if p["id"] != player_id
    ]

    await ws.send(
        json.dumps(
            {
                "t": "welcome",
                "id": player_id,
                "room": room_code,
                "youHost": you_host,
                "maxPlayers": MAX_PLAYERS,
                "peers": existing_peers,
            }
        )
    )

    try:
        # Loop receiving data over the WebSocket
        async for msg_str in ws:
            try:
                m = json.loads(msg_str)
            except ValueError:
                continue  # skip non-JSON frames

            t = str(m.get("t", ""))

            if t == "join":
                client_info["name"] = str(m.get("name", client_info["name"]))
                client_info["color"] = str(m.get("color", client_info["color"]))
                await publish_room_state(room_code)
                await relay(
                    room_code,
                    {
                        "t": "peer-join",
                        "from": player_id,
                        "id": player_id,
                        "name": client_info["name"],
                        "color": client_info["color"],
                    },
                    except_id=player_id,
                )
                continue

            elif t == "bye":
                await ws.close(code=1000, reason="bye")
                break

            elif t == "start":
                ROOM_REGISTRY.setdefault(
                    room_code,
                    {
                        "room": room_code,
                        "players": [],
                        "status": "lobby",
                        "max": MAX_PLAYERS,
                        "ts": 0,
                        "src_ts": {},
                    },
                )["status"] = "battle"
                await publish_room_state(room_code)
            elif t == "lobby":
                ROOM_REGISTRY.setdefault(
                    room_code,
                    {
                        "room": room_code,
                        "players": [],
                        "status": "lobby",
                        "max": MAX_PLAYERS,
                        "ts": 0,
                        "src_ts": {},
                    },
                )["status"] = "lobby"
                await publish_room_state(room_code)

            # Relay WebRTC signaling & game state to the other peers
            m["from"] = player_id
            await relay(room_code, m, except_id=player_id)

    except Exception as e:
        print(f"[WS Exception] {player_id}: {e}")
    finally:
        # Handle disconnect
        if room_code in CONNECTED_ROOMS:
            CONNECTED_ROOMS[room_code] = [
                c for c in CONNECTED_ROOMS[room_code] if c["id"] != player_id
            ]

            # Remove the departed player from the registry
            remaining = [p for p in room_players(room_code) if p["id"] != player_id]

            await relay(room_code, {"t": "peer-leave", "id": player_id})

            if len(remaining) == 0:
                # Room is empty — remove from registry, publish deleted, unbind the queue
                del CONNECTED_ROOMS[room_code]
                await publish_room_state(room_code, deleted=True)
                try:
                    await hub.unbind_room(room_code)
                except Exception as e:
                    print(f"[WS] unbind room {room_code} failed: {e}")
            else:
                # Update the registry with the remaining players + publish
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
                # Transfer Host to the first remaining player (each client checks its own id)
                await relay(room_code, {"t": "host", "id": remaining[0]["id"]})


# --- Startup ---


@app.before_server_start
async def setup(app, loop):
    try:
        await hub.connect()
        print(f"[RabbitMQ] Connected as instance {INSTANCE_ID}")
        # Ask other instances to republish their state to bootstrap the registry
        await hub.request_sync()
    except Exception as e:
        print(f"[RabbitMQ] Connection failed — running single-instance mode: {e}")
    loop.create_task(heartbeat_loop())


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT, debug=True)
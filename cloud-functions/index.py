import json
from sanic import Sanic, json as json_response, html
from sanic.websockets import WebConnection

# Import thư viện EdgeOne Pages Blob SDK Python
from edgeone.pages_blob import get_store

app = Sanic("PixelRushServer")

# Configuration
PORT = 8000
MAX_PLAYERS = 2
BLOB_STORE_NAME = "pixel-rush-rooms"

# In-memory Socket Manager (Lưu giữ WebSocket kết nối thực tế trong RAM)
# Cấu trúc: { "ROOM_CODE": [ {"id": "p1", "ws": WebConnection, "name": "...", "color": "..."}, ... ] }
CONNECTED_ROOMS = {}
seq = 0


# --- Helper Functions ---
def get_room_key(room_code: str) -> str:
    return f"rooms/{room_code}.json"


def get_status_key(room_code: str) -> str:
    return f"status/{room_code}.json"


async def broadcast(room_code: str, message_dict: dict, except_id: str | None = None):
    """Gửi tin nhắn cho tất cả các client trong phòng ngoại trừ except_id"""
    clients = CONNECTED_ROOMS.get(room_code, [])
    payload = json.dumps(message_dict)

    for client in list(clients):
        if client["id"] != except_id:
            try:
                await client["ws"].send(payload)
            except Exception as e:
                print(f"[WS Broadcast Error] {client['id']}: {e}")


async def sync_room_to_blob(room_code: str):
    """Đồng bộ danh sách Player (không chứa object WebSocket) lên Blob Storage"""
    store = get_store(BLOB_STORE_NAME)
    clients = CONNECTED_ROOMS.get(room_code, [])

    players_data = [
        {"id": c["id"], "name": c["name"], "color": c["color"]} for c in clients
    ]

    await store.set_json(get_room_key(room_code), {"players": players_data})


# --- HTTP Routes ---


@app.get("/rooms")
async def get_rooms(request):
    """API Danh sách phòng chơi lấy từ EdgeOne Blob"""
    try:
        store = get_store(BLOB_STORE_NAME)
        blobs = await store.list(prefix="rooms/")

        room_list = []
        for blob in blobs.get("blobs", []):
            room_code = blob["key"].replace("rooms/", "").replace(".json", "")
            try:
                room_data = await store.get(blob["key"], type="json")
                if room_data and isinstance(room_data.get("players"), list):
                    status_data = (
                        await store.get(get_status_key(room_code), type="json") or {}
                    )
                    room_list.append(
                        {
                            "room": room_code,
                            "players": len(room_data["players"]),
                            "max": MAX_PLAYERS,
                            "status": status_data.get("status", "lobby"),
                            "pilots": room_data["players"],
                        }
                    )
            except Exception as e:
                print(f"Error reading room {room_code}: {e}")

        return json_response({"maxPlayers": MAX_PLAYERS, "rooms": room_list})
    except Exception as e:
        return json_response(
            {"error": "Failed to fetch rooms", "details": str(e)}, status=500
        )


@app.get("/status")
async def get_status(request):
    """API Debug thông tin server"""
    try:
        store = get_store(BLOB_STORE_NAME)
        blobs = await store.list(prefix="rooms/")

        open_rooms = []
        for blob in blobs.get("blobs", []):
            room_code = blob["key"].replace("rooms/", "").replace(".json", "")
            try:
                room_data = await store.get(blob["key"], type="json")
                if room_data and "players" in room_data:
                    open_rooms.append(
                        {"room": room_code, "players": room_data["players"]}
                    )
            except Exception as e:
                pass

        return json_response(
            {
                "name": "PIXEL RUSH Python relay server",
                "maxPlayers": MAX_PLAYERS,
                "open": open_rooms,
            }
        )
    except Exception as e:
        return json_response({"error": "Failed to fetch status"}, status=500)


# --- WebSocket Route ---


@app.websocket("/ws")
async def ws_relay(request, ws: WebConnection):
    global seq

    room_code = request.args.get("room", "DEFAULT").strip().upper()
    seq += 1
    player_id = f"p{seq}"

    store = get_store(BLOB_STORE_NAME)

    # Khởi tạo phòng trong RAM nếu chưa có
    if room_code not in CONNECTED_ROOMS:
        CONNECTED_ROOMS[room_code] = []

    clients = CONNECTED_ROOMS[room_code]

    # Kiểm tra phòng đầy
    if len(clients) >= MAX_PLAYERS:
        await ws.send(json.dumps({"t": "error", "msg": "Room is full"}))
        await ws.close(code=4001, reason="room full")
        return

    # Tạo client object
    client_info = {"id": player_id, "ws": ws, "name": "Pilot", "color": "#888"}

    you_host = len(clients) == 0
    clients.append(client_info)

    # Đồng bộ thông tin lên EdgeOne Blob
    await sync_room_to_blob(room_code)

    status_key = get_status_key(room_code)
    status_data = await store.get(status_key, type="json")
    if not status_data:
        await store.set_json(status_key, {"status": "lobby"})

    # Gửi tin nhắn Welcome
    existing_peers = [
        {"id": c["id"], "name": c["name"], "color": c["color"]}
        for c in clients
        if c["id"] != player_id
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
        # Vòng lặp nhận dữ liệu qua WebSocket
        async for msg_str in ws:
            try:
                m = json.loads(msg_str)
            except ValueError:
                continue  # Bỏ qua gói tin không phải JSON

            t = str(m.get("t", ""))

            if t == "join":
                client_info["name"] = str(m.get("name", client_info["name"]))
                client_info["color"] = str(m.get("color", client_info["color"]))

                await sync_room_to_blob(room_code)

                await broadcast(
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
                await store.set_json(status_key, {"status": "battle"})
            elif t == "lobby":
                await store.set_json(status_key, {"status": "lobby"})

            # Relay WebRTC Signaling & Game State sang các peer khác
            m["from"] = player_id
            await broadcast(room_code, m, except_id=player_id)

    except Exception as e:
        print(f"[WS Exception] {player_id}: {e}")
    finally:
        # Xử lý khi ngắt kết nối (Disconnect)
        if room_code in CONNECTED_ROOMS:
            CONNECTED_ROOMS[room_code] = [
                c for c in CONNECTED_ROOMS[room_code] if c["id"] != player_id
            ]
            remaining_clients = CONNECTED_ROOMS[room_code]

            await broadcast(room_code, {"t": "peer-leave", "id": player_id})

            if len(remaining_clients) == 0:
                del CONNECTED_ROOMS[room_code]
                await store.delete(get_room_key(room_code))
                await store.delete(status_key)
            else:
                await sync_room_to_blob(room_code)
                # Chuyển Host cho người chơi còn lại
                await broadcast(
                    room_code, {"t": "host", "id": remaining_clients[0]["id"]}
                )


# Handler mặc định tương thích với EdgeOne Functions
def handler(request):
    return app(request)


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=PORT)

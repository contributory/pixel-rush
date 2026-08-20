"""RabbitMQ hub — share room state & route messages between relay instances.

Replaces the Edge Function + Blob Storage entirely. Each relay instance connects
to the same RabbitMQ broker (topic exchange `pixel-rush`):

- **Room state** (`room.state`): each instance publishes a room-state snapshot;
  every other instance consumes it to maintain the shared `ROOM_REGISTRY`.
- **Sync request** (`room.sync`): a new instance publishes this to ask other
  instances to republish their current state (fast registry bootstrap).
- **Room messages** (`room.msg.<CODE>`): client messages (WebRTC signaling,
  game state, peer-join/leave...) are published to the room's routing key; only
  instances with clients in that room bind a queue and receive them.

Each instance has its own INSTANCE_ID; messages it published itself are ignored
(avoids echo/duplicates when broadcasting locally + via RabbitMQ).
"""

from __future__ import annotations

import json
import os
import uuid
from collections.abc import Awaitable, Callable
from typing import Any

import aio_pika
from aio_pika import DeliveryMode, ExchangeType, Message

RABBITMQ_URL = os.environ.get("RABBITMQ_URL", "amqp://guest:guest@localhost:5672/")
EXCHANGE_NAME = os.environ.get("RABBITMQ_EXCHANGE", "pixel-rush")
ROOM_STATE_KEY = "room.state"
ROOM_SYNC_KEY = "room.sync"
ROOM_MSG_PREFIX = "room.msg."

# Unique ID for this instance — used to ignore messages we published ourselves
INSTANCE_ID = uuid.uuid4().hex[:8]

RoomStateHandler = Callable[[str, dict[str, Any]], Awaitable[None]]
RoomMsgHandler = Callable[[str, dict[str, Any]], Awaitable[None]]
SyncHandler = Callable[[], Awaitable[None]]


class RabbitHub:
    """Shared RabbitMQ connection used by the whole relay instance."""

    def __init__(self) -> None:
        self._conn: aio_pika.abc.AbstractRobustConnection | None = None
        self._channel: aio_pika.abc.AbstractChannel | None = None
        self._exchange: aio_pika.abc.AbstractExchange | None = None
        self._state_queue: aio_pika.abc.AbstractQueue | None = None
        self._msg_queue: aio_pika.abc.AbstractQueue | None = None
        self._bound_rooms: set[str] = set()
        self.on_room_state: RoomStateHandler | None = None
        self.on_room_msg: RoomMsgHandler | None = None
        self.on_sync_request: SyncHandler | None = None

    @property
    def connected(self) -> bool:
        return self._conn is not None and not self._conn.is_closed

    async def connect(self) -> None:
        """Connect to the broker, declare exchange + queues, start consuming."""
        self._conn = await aio_pika.connect_robust(RABBITMQ_URL)
        self._channel = await self._conn.channel()
        await self._channel.set_qos(prefetch_count=100)
        self._exchange = await self._channel.declare_exchange(
            EXCHANGE_NAME, ExchangeType.TOPIC, durable=True
        )

        # Room-state queue — one queue per instance so it receives EVERY event
        # (a shared queue would be round-robined by RabbitMQ). Bound with the
        # `room.*` wildcard to get both room.state and room.sync.
        self._state_queue = await self._channel.declare_queue(
            f"pixel-rush.room-state.{INSTANCE_ID}", exclusive=True, auto_delete=True
        )
        await self._state_queue.bind(self._exchange, routing_key="room.*")
        await self._state_queue.consume(self._on_state_message)

        # Room-message queue — one queue per instance; only bound to a room's
        # routing key while this instance has clients in that room.
        self._msg_queue = await self._channel.declare_queue(
            f"pixel-rush.room-msg.{INSTANCE_ID}", exclusive=True, auto_delete=True
        )
        await self._msg_queue.consume(self._on_msg_message)

    async def close(self) -> None:
        if self._conn and not self._conn.is_closed:
            await self._conn.close()

    async def bind_room(self, room_code: str) -> None:
        """Start receiving messages for a room (when this instance has local clients)."""
        if room_code in self._bound_rooms:
            return
        await self._msg_queue.bind(
            self._exchange, routing_key=f"{ROOM_MSG_PREFIX}{room_code}"
        )
        self._bound_rooms.add(room_code)

    async def unbind_room(self, room_code: str) -> None:
        """Stop receiving messages for a room (when no local clients remain)."""
        if room_code not in self._bound_rooms:
            return
        await self._msg_queue.unbind(
            self._exchange, routing_key=f"{ROOM_MSG_PREFIX}{room_code}"
        )
        self._bound_rooms.discard(room_code)

    async def request_sync(self) -> None:
        """Ask other instances to republish their current room state."""
        await self._exchange.publish(
            Message(
                json.dumps({"src": INSTANCE_ID}).encode(),
                content_type="application/json",
            ),
            routing_key=ROOM_SYNC_KEY,
        )

    async def publish_room_state(self, room_code: str, state: dict[str, Any]) -> None:
        """Publish a room-state snapshot for every other instance."""
        payload = {"room": room_code, "src": INSTANCE_ID, **state}
        await self._exchange.publish(
            Message(
                json.dumps(payload).encode(),
                delivery_mode=DeliveryMode.PERSISTENT,
                content_type="application/json",
            ),
            routing_key=ROOM_STATE_KEY,
        )

    async def publish_room_msg(self, room_code: str, message: dict[str, Any]) -> None:
        """Publish a room message for other instances that have clients in the room."""
        payload = {"room": room_code, "src": INSTANCE_ID, "msg": message}
        await self._exchange.publish(
            Message(json.dumps(payload).encode(), content_type="application/json"),
            routing_key=f"{ROOM_MSG_PREFIX}{room_code}",
        )

    async def _on_state_message(
        self, message: aio_pika.abc.AbstractIncomingMessage
    ) -> None:
        async with message.process():
            try:
                payload = json.loads(message.body)
            except ValueError:
                return
            if payload.get("src") == INSTANCE_ID:
                return  # ignore events we published ourselves
            if message.routing_key == ROOM_SYNC_KEY:
                if self.on_sync_request:
                    await self.on_sync_request()
                return
            room_code = str(payload.get("room", ""))
            if self.on_room_state:
                await self.on_room_state(room_code, payload)

    async def _on_msg_message(
        self, message: aio_pika.abc.AbstractIncomingMessage
    ) -> None:
        async with message.process():
            try:
                payload = json.loads(message.body)
            except ValueError:
                return
            if payload.get("src") == INSTANCE_ID:
                return  # ignore messages we published ourselves (already broadcast locally)
            room_code = str(payload.get("room", ""))
            msg = payload.get("msg")
            if isinstance(msg, dict) and self.on_room_msg:
                await self.on_room_msg(room_code, msg)

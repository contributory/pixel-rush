"""Small local fallback for the EdgeOne Blob API used by the Python relay.

EdgeOne's documented Blob SDK is JavaScript-only. The Python function keeps
room state in its process memory instead, which is sufficient for the live
WebSocket connections handled by the same function instance.
"""

from __future__ import annotations

import copy
from typing import Any


_DATA: dict[str, Any] = {}


class Store:
    async def get(self, key: str, type: str = "text") -> Any:
        value = _DATA.get(key)
        if value is None:
            return None
        return copy.deepcopy(value) if type == "json" else value

    async def set_json(self, key: str, value: Any) -> None:
        _DATA[key] = copy.deepcopy(value)

    async def delete(self, key: str) -> None:
        _DATA.pop(key, None)

    async def list(self, prefix: str = "") -> dict[str, list[dict[str, str]]]:
        return {"blobs": [{"key": key} for key in _DATA if key.startswith(prefix)]}


_STORE = Store()


def get_store(name: str) -> Store:
    return _STORE

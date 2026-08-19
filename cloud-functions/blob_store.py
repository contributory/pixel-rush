"""Async HTTP client cho EdgeOne Blob API Edge Function.

SDK Blob của EdgeOne chỉ hỗ trợ JavaScript. Trước đây relay Python gọi Node
qua subprocess (blob_bridge.mjs) — cách này không hoạt động trên môi trường
deploy. Thay vào đó, module này gọi Edge Function JavaScript được deploy tại
/edge-functions/api/blob.js qua HTTP thông thường.
"""

from __future__ import annotations

import os
from typing import Any

import httpx

# Base URL của Edge Function đã deploy, ví dụ https://<project>.pages.dev
# (hoặc domain tuỳ chỉnh). Bắt buộc phải set; thiếu thì không gọi được Blob.
BLOB_API_URL = os.environ.get("BLOB_API_URL", "").rstrip("/")
DEFAULT_STORE = os.environ.get("BLOB_STORE_NAME", "pixel-rush-rooms")

_client = httpx.AsyncClient(timeout=15.0)


class BlobStore:
    """Wrapper async gọn gàng quanh Edge Function /api/blob."""

    def __init__(self, name: str = DEFAULT_STORE):
        self.name = name
        self.endpoint = f"{BLOB_API_URL}/api/blob"

    def _require_base(self) -> None:
        if not BLOB_API_URL:
            raise RuntimeError(
                "BLOB_API_URL is not set. Point it at the deployed Edge Function, "
                "e.g. https://<project>/api/blob"
            )

    async def _parse(self, response: httpx.Response) -> Any:
        try:
            payload = response.json()
        except ValueError:
            raise RuntimeError(
                f"Blob API returned non-JSON (HTTP {response.status_code})"
            ) from None
        if response.status_code >= 400 or not payload.get("ok"):
            raise RuntimeError(
                payload.get("error", f"Blob API error (HTTP {response.status_code})")
            )
        return payload.get("result")

    async def get(self, key: str, type: str = "text") -> Any:
        self._require_base()
        response = await _client.get(
            self.endpoint,
            params={"op": "get", "store": self.name, "key": key, "type": type},
        )
        return await self._parse(response)

    async def set_json(self, key: str, value: Any) -> None:
        self._require_base()
        response = await _client.post(
            self.endpoint,
            params={"store": self.name},
            json={"op": "setJSON", "key": key, "value": value},
        )
        await self._parse(response)

    async def list(self, prefix: str = "") -> Any:
        self._require_base()
        response = await _client.get(
            self.endpoint,
            params={"op": "list", "store": self.name, "prefix": prefix},
        )
        return await self._parse(response)

    async def delete(self, key: str) -> None:
        self._require_base()
        response = await _client.delete(
            self.endpoint,
            params={"op": "delete", "store": self.name, "key": key},
        )
        await self._parse(response)

"""Small Python-to-Node bridge for EdgeOne Pages Blob."""

import asyncio
import json
import subprocess
from pathlib import Path
from typing import Any


class BlobStore:
    def __init__(self, name: str):
        self.name = name
        self.bridge = Path(__file__).with_name("blob_bridge.mjs")

    async def _call(self, operation: str, **payload: Any) -> Any:
        request = {"store": self.name, "operation": operation, **payload}

        def run() -> Any:
            completed = subprocess.run(
                ["node", str(self.bridge)],
                input=json.dumps(request),
                text=True,
                capture_output=True,
                check=False,
                cwd=self.bridge.parent,
            )
            if completed.returncode != 0:
                detail = completed.stderr.strip() or completed.stdout.strip()
                raise RuntimeError(f"EdgeOne Blob bridge failed: {detail}")
            response = json.loads(completed.stdout)
            if not response.get("ok"):
                raise RuntimeError(response.get("error", "Unknown Blob error"))
            return response.get("result")

        return await asyncio.to_thread(run)

    async def get(self, key: str, type: str = "text") -> Any:
        return await self._call("get", key=key, type=type)

    async def set_json(self, key: str, value: Any) -> None:
        await self._call("setJSON", key=key, value=value)

    async def list(self, prefix: str = "") -> Any:
        return await self._call("list", prefix=prefix)

    async def delete(self, key: str) -> None:
        await self._call("delete", key=key)

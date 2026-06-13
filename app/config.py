from __future__ import annotations

import asyncio
import copy
import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_DEFAULT: dict[str, Any] = {
    "endpoints": [],
    "layout": {"count": 1, "slots": [None, None, None, None]},
}


class ConfigManager:
    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = asyncio.Lock()
        self._data: dict[str, Any] = json.loads(json.dumps(_DEFAULT))

    async def load(self) -> None:
        if not self._path.exists():
            return
        try:
            self._data = json.loads(self._path.read_text(encoding="utf-8"))
        except Exception:
            logger.warning("Config file corrupt or unreadable — using defaults")

    async def get(self) -> dict[str, Any]:
        async with self._lock:
            return copy.deepcopy(self._data)

    async def save(self, data: dict[str, Any]) -> None:
        async with self._lock:
            self._data = copy.deepcopy(data)
            self._path.parent.mkdir(parents=True, exist_ok=True)
            tmp = self._path.with_suffix(".tmp")
            tmp.write_text(
                json.dumps(data, ensure_ascii=False, indent=2),
                encoding="utf-8",
            )
            tmp.replace(self._path)

from __future__ import annotations

import logging
import math
import time
from collections.abc import AsyncGenerator
from typing import Any

import httpx
from fastapi import HTTPException

logger = logging.getLogger(__name__)

_TIMEOUT = httpx.Timeout(connect=10.0, read=300.0, write=30.0, pool=5.0)
_STREAM_DEADLINE = 600.0  # 10 minutes total per streaming request


def _clamp(val: Any, default: float, lo: float, hi: float) -> float:
    """Return val clamped to [lo, hi], or default if val is non-finite or invalid."""
    try:
        v = float(val)
        return max(lo, min(hi, v)) if math.isfinite(v) else default
    except (TypeError, ValueError):
        return default


def _build_payload(endpoint: dict[str, Any], body: dict[str, Any]) -> dict[str, Any]:
    payload: dict[str, Any] = {
        "messages":       body.get("messages", []),
        "stream":         True,
        "temperature":    _clamp(body.get("temperature"),    0.7, 0.0, 2.0),
        "top_p":          _clamp(body.get("top_p"),          0.9, 0.0, 1.0),
        "repeat_penalty": _clamp(body.get("repeat_penalty"), 1.1, 1.0, 2.0),
    }
    try:
        mt = int(body.get("max_tokens") or 0)
        if 0 < mt <= 262144:
            payload["max_tokens"] = mt
    except (TypeError, ValueError):
        pass
    if endpoint.get("model"):
        payload["model"] = endpoint["model"]
    return payload


async def proxy_stream(
    endpoint: dict[str, Any],
    body: dict[str, Any],
) -> AsyncGenerator[bytes, None]:
    url: str = endpoint["serverUrl"]
    if not endpoint.get("useRawUrl"):
        url = url.rstrip("/") + "/v1/chat/completions"

    headers: dict[str, str] = {"Content-Type": "application/json"}
    if endpoint.get("apiKey"):
        headers["Authorization"] = f"Bearer {endpoint['apiKey']}"

    payload = _build_payload(endpoint, body)
    client = httpx.AsyncClient(timeout=_TIMEOUT)

    try:
        req = client.build_request("POST", url, headers=headers, json=payload)
        response = await client.send(req, stream=True)
    except httpx.RequestError as exc:
        await client.aclose()
        logger.error("Proxy request error for %s: %s", url, exc)
        raise HTTPException(status_code=502, detail="Upstream connection error") from exc

    if not response.is_success:
        error_text = await response.aread()
        await client.aclose()
        raise HTTPException(
            status_code=response.status_code,
            detail=error_text.decode(errors="replace")[:500],
        )

    async def _stream() -> AsyncGenerator[bytes, None]:
        deadline = time.monotonic() + _STREAM_DEADLINE
        try:
            async for chunk in response.aiter_bytes():
                if time.monotonic() > deadline:
                    logger.warning("Stream deadline of %.0fs exceeded", _STREAM_DEADLINE)
                    break
                yield chunk
        finally:
            await response.aclose()
            await client.aclose()

    return _stream()

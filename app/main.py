from __future__ import annotations

import logging
import logging.handlers
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncGenerator

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .config import ConfigManager
from .proxy import proxy_stream

logger = logging.getLogger(__name__)

_config = ConfigManager(Path("data/config.json"))


def _setup_logging() -> None:
    log_path = Path("data/llm-ui.log")
    log_path.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
        handlers=[
            logging.StreamHandler(),
            logging.handlers.RotatingFileHandler(
                log_path, maxBytes=5 * 1024 * 1024, backupCount=3, encoding="utf-8"
            ),
        ],
    )


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    _setup_logging()
    await _config.load()
    logger.info("Config loaded")
    yield


_MAX_BODY = 50 * 1024 * 1024  # 50 MB

app = FastAPI(
    title="LLM UI",
    lifespan=_lifespan,
    docs_url=None,
    redoc_url=None,
    openapi_url=None,
)


@app.middleware("http")
async def _limit_body(request: Request, call_next: Any) -> Any:
    content_length = request.headers.get("content-length")
    try:
        if content_length and int(content_length) > _MAX_BODY:
            return JSONResponse(status_code=413, content={"detail": "Payload too large"})
    except ValueError:
        return JSONResponse(status_code=400, content={"detail": "Invalid Content-Length"})
    return await call_next(request)


@app.get("/api/config")
async def get_config() -> dict[str, Any]:
    return await _config.get()


@app.put("/api/config")
async def put_config(request: Request) -> dict[str, bool]:
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(data.get("endpoints"), list):
        raise HTTPException(status_code=422, detail="'endpoints' must be an array")
    await _config.save(data)
    return {"ok": True}


@app.post("/api/chat")
async def chat(request: Request) -> StreamingResponse:
    try:
        body = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    cfg = await _config.get()

    endpoint_id: str | None = body.get("endpointId")
    endpoint = next(
        (e for e in cfg.get("endpoints", []) if e.get("id") == endpoint_id),
        None,
    )
    if endpoint is None:
        raise HTTPException(status_code=404, detail="Endpoint not found")

    gen = await proxy_stream(endpoint, body)
    return StreamingResponse(
        gen,
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


app.mount("/", StaticFiles(directory="static", html=True), name="static")

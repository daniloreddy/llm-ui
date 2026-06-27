from __future__ import annotations

import asyncio
import logging
import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any, AsyncGenerator

from dotenv import load_dotenv

load_dotenv()

from fastapi import FastAPI, Form, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, RedirectResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from .auth import AuthManager, _client_ip
from .config import ConfigManager
from .proxy import proxy_stream

logger = logging.getLogger(__name__)

_config = ConfigManager(Path("data/config.json"))
_auth = AuthManager(auth_file=Path("data/auth.json"), cookie_name="llm_ui_session")

_PUBLIC_PATHS = {"/login", "/auth/login", "/auth/logout"}
_LOGIN_HTML = Path("static/login.html")


def _setup_logging() -> None:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s — %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )


async def _purge_loop() -> None:
    while True:
        await asyncio.sleep(600)  # every 10 minutes
        _auth.purge_expired_blocks()


@asynccontextmanager
async def _lifespan(app: FastAPI) -> AsyncGenerator[None, None]:
    _setup_logging()
    await _config.load()
    logger.info("Config loaded")
    _auth.load()
    if not _auth.is_configured():
        logger.warning("No password set — run: python scripts/set_password.py")
    task = asyncio.create_task(_purge_loop())
    yield
    task.cancel()


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


@app.middleware("http")
async def _auth_gate(request: Request, call_next: Any) -> Any:
    path = request.url.path
    if path in _PUBLIC_PATHS:
        return await call_next(request)

    token = request.cookies.get(_auth.cookie_name, "")
    if _auth.verify_token(token):
        return await call_next(request)

    if path.startswith("/api/"):
        return JSONResponse(status_code=401, content={"detail": "Unauthorized"})

    return RedirectResponse(url="/login", status_code=302)


@app.get("/login")
async def login_page() -> FileResponse:
    return FileResponse(_LOGIN_HTML)


@app.post("/auth/login")
async def auth_login(request: Request, password: str = Form(...)) -> RedirectResponse:
    headers = dict(request.headers)
    ip = _client_ip(headers, request.client.host if request.client else None)
    if not _auth.verify_password(password, ip):
        return RedirectResponse(url="/login?error=1", status_code=302)

    token = _auth.make_token()
    is_secure = _auth.is_secure_context(headers)
    response = RedirectResponse(url="/", status_code=302)
    response.set_cookie(
        _auth.cookie_name,
        token,
        httponly=True,
        secure=is_secure,
        samesite="strict",
        max_age=_auth._ttl,
    )
    logger.info("Successful login from %s", ip)
    return response


@app.get("/auth/logout")
async def auth_logout() -> RedirectResponse:
    response = RedirectResponse(url="/login", status_code=302)
    response.delete_cookie(_auth.cookie_name, samesite="strict")
    return response


@app.get("/api/config")
async def get_config() -> dict[str, Any]:
    return await _config.get()


@app.put("/api/config")
async def put_config(request: Request) -> dict[str, bool]:
    try:
        data = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")
    if not isinstance(data, dict):
        raise HTTPException(status_code=422, detail="Config must be an object")
    if not isinstance(data.get("endpoints"), list):
        raise HTTPException(status_code=422, detail="'endpoints' must be an array")
    for ep in data["endpoints"]:
        if not isinstance(ep, dict):
            raise HTTPException(status_code=422, detail="Each endpoint must be an object")
        if not isinstance(ep.get("id"), str) or not ep["id"]:
            raise HTTPException(status_code=422, detail="Each endpoint must have a non-empty string 'id'")
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

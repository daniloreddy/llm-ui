import pytest
from pathlib import Path
from httpx import AsyncClient, ASGITransport


@pytest.fixture
def app_with_tmp_config(tmp_path: Path, monkeypatch):
    """Return a fresh app instance pointing at a temp config file."""
    import app.main as main_mod
    import app.config as config_mod

    mgr = config_mod.ConfigManager(tmp_path / "config.json")
    monkeypatch.setattr(main_mod, "_config", mgr)
    return main_mod.app


@pytest.fixture
async def client(app_with_tmp_config):
    async with AsyncClient(
        transport=ASGITransport(app=app_with_tmp_config), base_url="http://test"
    ) as c:
        # Manually trigger lifespan load (TestClient skips it in some setups)
        import app.main as main_mod
        await main_mod._config.load()
        yield c


# ── /api/config ────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_get_config_returns_defaults(client: AsyncClient):
    r = await client.get("/api/config")
    assert r.status_code == 200
    body = r.json()
    assert body["endpoints"] == []
    assert "layout" in body


@pytest.mark.asyncio
async def test_put_config_saves_and_returns_ok(client: AsyncClient):
    payload = {
        "endpoints": [{"id": "1", "name": "Local"}],
        "layout": {"count": 1, "slots": ["1", None, None, None]},
    }
    r = await client.put("/api/config", json=payload)
    assert r.status_code == 200
    assert r.json() == {"ok": True}

    r2 = await client.get("/api/config")
    assert r2.json()["endpoints"][0]["name"] == "Local"


@pytest.mark.asyncio
async def test_put_config_rejects_invalid_json(client: AsyncClient):
    r = await client.put(
        "/api/config",
        content=b"NOT JSON",
        headers={"Content-Type": "application/json"},
    )
    assert r.status_code == 400


@pytest.mark.asyncio
async def test_put_config_rejects_endpoints_not_array(client: AsyncClient):
    r = await client.put("/api/config", json={"endpoints": 42, "layout": {}})
    assert r.status_code == 422


# ── /api/chat ──────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_chat_unknown_endpoint_returns_404(client: AsyncClient):
    r = await client.post("/api/chat", json={
        "endpointId": "does-not-exist",
        "messages": [{"role": "user", "content": "hi"}],
    })
    assert r.status_code == 404


@pytest.mark.asyncio
async def test_chat_missing_endpoint_id_returns_404(client: AsyncClient):
    r = await client.post("/api/chat", json={"messages": []})
    assert r.status_code == 404

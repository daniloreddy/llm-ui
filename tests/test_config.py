import json
import pytest
from pathlib import Path

from app.config import ConfigManager


@pytest.fixture
def tmp_config(tmp_path: Path) -> ConfigManager:
    return ConfigManager(tmp_path / "config.json")


@pytest.mark.asyncio
async def test_get_returns_defaults_when_no_file(tmp_config: ConfigManager):
    await tmp_config.load()
    data = await tmp_config.get()
    assert data["endpoints"] == []
    assert data["layout"]["count"] == 1


@pytest.mark.asyncio
async def test_save_and_reload(tmp_config: ConfigManager):
    payload = {
        "endpoints": [{"id": "abc", "name": "Test"}],
        "layout": {"count": 2, "slots": ["abc", None, None, None]},
    }
    await tmp_config.save(payload)

    fresh = ConfigManager(tmp_config._path)
    await fresh.load()
    data = await fresh.get()
    assert data["endpoints"][0]["name"] == "Test"
    assert data["layout"]["count"] == 2


@pytest.mark.asyncio
async def test_get_returns_deep_copy(tmp_config: ConfigManager):
    await tmp_config.load()
    data1 = await tmp_config.get()
    data1["endpoints"].append({"id": "injected"})

    data2 = await tmp_config.get()
    assert data2["endpoints"] == []  # internal state must be unaffected


@pytest.mark.asyncio
async def test_atomic_write_produces_no_tmp_on_success(tmp_config: ConfigManager):
    await tmp_config.save({"endpoints": [], "layout": {"count": 1, "slots": [None] * 4}})
    tmp_file = tmp_config._path.with_suffix(".tmp")
    assert not tmp_file.exists()


@pytest.mark.asyncio
async def test_corrupt_file_falls_back_to_defaults(tmp_path: Path):
    path = tmp_path / "config.json"
    path.write_text("NOT JSON", encoding="utf-8")
    mgr = ConfigManager(path)
    await mgr.load()
    data = await mgr.get()
    assert data["endpoints"] == []


@pytest.mark.asyncio
async def test_save_persists_to_disk(tmp_config: ConfigManager):
    payload = {"endpoints": [{"id": "x"}], "layout": {"count": 1, "slots": [None] * 4}}
    await tmp_config.save(payload)
    raw = json.loads(tmp_config._path.read_text(encoding="utf-8"))
    assert raw["endpoints"][0]["id"] == "x"


@pytest.mark.asyncio
async def test_load_missing_file_keeps_defaults(tmp_config: ConfigManager):
    assert not tmp_config._path.exists()
    await tmp_config.load()
    data = await tmp_config.get()
    assert isinstance(data["endpoints"], list)

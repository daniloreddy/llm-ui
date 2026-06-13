import pytest
from app.proxy import _clamp, _build_payload


class TestClamp:
    def test_within_range(self):
        assert _clamp(0.7, 0.5, 0.0, 1.0) == pytest.approx(0.7)

    def test_clamps_above_hi(self):
        assert _clamp(5.0, 0.7, 0.0, 2.0) == pytest.approx(2.0)

    def test_clamps_below_lo(self):
        assert _clamp(-1.0, 0.7, 0.0, 2.0) == pytest.approx(0.0)

    def test_none_returns_default(self):
        assert _clamp(None, 0.7, 0.0, 2.0) == pytest.approx(0.7)

    def test_nan_equivalent_null_returns_default(self):
        # JSON NaN serialises to null → Python None
        assert _clamp(None, 0.9, 0.0, 1.0) == pytest.approx(0.9)

    def test_string_non_numeric_returns_default(self):
        assert _clamp("bad", 1.1, 1.0, 2.0) == pytest.approx(1.1)

    def test_string_numeric_is_accepted(self):
        assert _clamp("0.5", 0.7, 0.0, 1.0) == pytest.approx(0.5)

    def test_boundary_lo(self):
        assert _clamp(0.0, 0.5, 0.0, 1.0) == pytest.approx(0.0)

    def test_boundary_hi(self):
        assert _clamp(1.0, 0.5, 0.0, 1.0) == pytest.approx(1.0)


class TestBuildPayload:
    def _ep(self, **kw):
        return {"model": "", "useRawUrl": False, **kw}

    def _body(self, **kw):
        return {
            "messages": [{"role": "user", "content": "hi"}],
            "temperature": 0.7,
            "top_p": 0.9,
            "repeat_penalty": 1.1,
            "max_tokens": 512,
            **kw,
        }

    def test_messages_present(self):
        p = _build_payload(self._ep(), self._body())
        assert p["messages"] == [{"role": "user", "content": "hi"}]

    def test_messages_missing_defaults_to_empty(self):
        body = self._body()
        del body["messages"]
        p = _build_payload(self._ep(), body)
        assert p["messages"] == []

    def test_stream_always_true(self):
        assert _build_payload(self._ep(), self._body())["stream"] is True

    def test_temperature_clamped(self):
        p = _build_payload(self._ep(), self._body(temperature=999))
        assert p["temperature"] == pytest.approx(2.0)

    def test_top_p_clamped(self):
        p = _build_payload(self._ep(), self._body(top_p=-0.5))
        assert p["top_p"] == pytest.approx(0.0)

    def test_repeat_penalty_clamped(self):
        p = _build_payload(self._ep(), self._body(repeat_penalty=0.0))
        assert p["repeat_penalty"] == pytest.approx(1.0)

    def test_null_temperature_uses_default(self):
        p = _build_payload(self._ep(), self._body(temperature=None))
        assert p["temperature"] == pytest.approx(0.7)

    def test_max_tokens_included_when_valid(self):
        p = _build_payload(self._ep(), self._body(max_tokens=1024))
        assert p["max_tokens"] == 1024

    def test_max_tokens_zero_excluded(self):
        p = _build_payload(self._ep(), self._body(max_tokens=0))
        assert "max_tokens" not in p

    def test_max_tokens_negative_excluded(self):
        p = _build_payload(self._ep(), self._body(max_tokens=-1))
        assert "max_tokens" not in p

    def test_max_tokens_above_limit_excluded(self):
        p = _build_payload(self._ep(), self._body(max_tokens=999999))
        assert "max_tokens" not in p

    def test_max_tokens_none_excluded(self):
        p = _build_payload(self._ep(), self._body(max_tokens=None))
        assert "max_tokens" not in p

    def test_model_included_when_set(self):
        p = _build_payload(self._ep(model="gpt-4o"), self._body())
        assert p["model"] == "gpt-4o"

    def test_model_excluded_when_empty(self):
        p = _build_payload(self._ep(model=""), self._body())
        assert "model" not in p

from __future__ import annotations

import hashlib
import hmac
import json
import logging
import os
import secrets
import time
from pathlib import Path

import jwt

logger = logging.getLogger(__name__)

_ALGORITHM = "HS256"

# IPs of trusted reverse proxies (Cloudflare, Apache, nginx, etc.)
# Set via env: TRUSTED_PROXIES=127.0.0.1,10.0.0.1
_TRUSTED_PROXIES: frozenset[str] = frozenset(
    ip for ip in os.getenv("TRUSTED_PROXIES", "127.0.0.1").split(",") if ip.strip()
)


def _client_ip(headers: dict[str, str], client_host: str | None) -> str:
    if client_host in _TRUSTED_PROXIES:
        cf = headers.get("cf-connecting-ip", "")
        if cf:
            return cf
        fwd = headers.get("x-forwarded-for", "")
        if fwd:
            return fwd.split(",")[0].strip()
    return client_host or "unknown"


class AuthManager:
    def __init__(
        self,
        auth_file: Path,
        cookie_name: str = "session",
        token_ttl: int = 7 * 24 * 3600,
    ) -> None:
        self._file = auth_file
        self.cookie_name = cookie_name
        self._ttl = token_ttl
        self._pw_hash: str = ""
        self._secret: str = ""

        # per-IP: (failure_count, last_failure_monotonic)
        self._failures: dict[str, tuple[int, float]] = {}
        self._MAX_FAILURES = 5
        self._BLOCK_SEC = 300

        # global login rate limit: max requests per window
        self._global_attempts: list[float] = []
        self._GLOBAL_MAX = 20
        self._GLOBAL_WINDOW = 60.0  # seconds

    def load(self) -> None:
        if self._file.exists():
            try:
                data = json.loads(self._file.read_text(encoding="utf-8"))
                self._pw_hash = data.get("password_hash", "")
                self._secret = data.get("secret", "")
            except Exception:
                logger.warning("auth.json unreadable — resetting state")
        if not self._secret:
            self._secret = secrets.token_hex(32)
            self._persist()
            logger.info("Auth secret generated and persisted")

    def _persist(self) -> None:
        self._file.parent.mkdir(parents=True, exist_ok=True)
        tmp = self._file.with_suffix(".tmp")
        tmp.write_text(
            json.dumps({"password_hash": self._pw_hash, "secret": self._secret}, indent=2),
            encoding="utf-8",
        )
        tmp.replace(self._file)

    def is_configured(self) -> bool:
        return bool(self._pw_hash)

    def set_password(self, password: str) -> None:
        salt = os.urandom(16)
        dk = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
        self._pw_hash = salt.hex() + ":" + dk.hex()
        if not self._secret:
            self._secret = secrets.token_hex(32)
        self._persist()
        logger.info("Password updated")

    def _global_rate_ok(self) -> bool:
        now = time.monotonic()
        cutoff = now - self._GLOBAL_WINDOW
        self._global_attempts = [t for t in self._global_attempts if t > cutoff]
        if len(self._global_attempts) >= self._GLOBAL_MAX:
            logger.warning("Global login rate limit hit (%d req/min)", self._GLOBAL_MAX)
            return False
        self._global_attempts.append(now)
        return True

    def verify_password(self, password: str, ip: str) -> bool:
        if not self._global_rate_ok():
            return False
        if self._is_blocked(ip):
            logger.warning("Login blocked for %s (too many failures)", ip)
            return False
        if not self._pw_hash:
            return False
        ok = False
        try:
            salt_hex, dk_hex = self._pw_hash.split(":", 1)
            salt = bytes.fromhex(salt_hex)
            expected = bytes.fromhex(dk_hex)
            actual = hashlib.scrypt(password.encode(), salt=salt, n=16384, r=8, p=1, dklen=32)
            ok = hmac.compare_digest(actual, expected)
        except Exception:
            ok = False
        if ok:
            self._failures.pop(ip, None)
        else:
            count, _ = self._failures.get(ip, (0, 0.0))
            self._failures[ip] = (count + 1, time.monotonic())
            logger.warning("Failed login from %s (attempt %d)", ip, count + 1)
        return ok

    def _is_blocked(self, ip: str) -> bool:
        count, last = self._failures.get(ip, (0, 0.0))
        if count >= self._MAX_FAILURES:
            if time.monotonic() - last < self._BLOCK_SEC:
                return True
            self._failures.pop(ip, None)
        return False

    def purge_expired_blocks(self) -> None:
        """Remove failure entries whose block window has expired. Call periodically."""
        cutoff = time.monotonic() - self._BLOCK_SEC
        expired = [ip for ip, (_, last) in self._failures.items() if last < cutoff]
        for ip in expired:
            del self._failures[ip]
        if expired:
            logger.debug("Purged %d expired login block(s)", len(expired))

    def make_token(self) -> str:
        payload = {"exp": int(time.time()) + self._ttl}
        return jwt.encode(payload, self._secret, algorithm=_ALGORITHM)

    def verify_token(self, token: str) -> bool:
        try:
            jwt.decode(token, self._secret, algorithms=[_ALGORITHM])
            return True
        except jwt.PyJWTError:
            return False

    def is_secure_context(self, headers: dict[str, str]) -> bool:
        if os.getenv("AUTH_SECURE_COOKIE") == "1":
            return True
        return headers.get("x-forwarded-proto") == "https"

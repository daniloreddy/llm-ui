#!/usr/bin/env python3
"""Set the auth password for LLM UI.

Usage:
    python scripts/set_password.py
"""
from __future__ import annotations

import subprocess
import sys
from pathlib import Path

_ROOT = Path(__file__).parent.parent
_VENV_DIR = _ROOT / ("venv" if sys.platform == "win32" else ".venv")
_VENV_PYTHON = _VENV_DIR / ("Scripts/python.exe" if sys.platform == "win32" else "bin/python")


def _bootstrap() -> None:
    if not _VENV_PYTHON.exists():
        subprocess.run([sys.executable, "-m", "venv", str(_VENV_DIR)], check=True)
        subprocess.run(
            [str(_VENV_PYTHON), "-m", "pip", "install", "-r", str(_ROOT / "requirements.txt")],
            check=True,
        )
    if Path(sys.executable).resolve() != _VENV_PYTHON.resolve():
        sys.exit(subprocess.run([str(_VENV_PYTHON), *sys.argv]).returncode)


_bootstrap()

import getpass  # noqa: E402

sys.path.insert(0, str(_ROOT))
from app.auth import AuthManager  # noqa: E402


def main() -> None:
    manager = AuthManager(auth_file=Path("data/auth.json"))
    manager.load()

    password = getpass.getpass("Nuova password: ")
    if not password:
        print("Errore: la password non può essere vuota.")
        sys.exit(1)

    confirm = getpass.getpass("Conferma password: ")
    if password != confirm:
        print("Errore: le password non corrispondono.")
        sys.exit(1)

    manager.set_password(password)
    print("Password impostata correttamente.")


if __name__ == "__main__":
    main()

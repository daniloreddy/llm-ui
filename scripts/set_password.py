#!/usr/bin/env python3
"""Set the auth password for LLM UI.

Usage:
    python scripts/set_password.py
"""
from __future__ import annotations

import getpass
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent))

from app.auth import AuthManager


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

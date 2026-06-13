#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
echo "=== Ruff ==="
./.venv/bin/ruff check .
echo "=== Mypy ==="
./.venv/bin/mypy app/
echo "=== Tests ==="
./.venv/bin/pytest tests/

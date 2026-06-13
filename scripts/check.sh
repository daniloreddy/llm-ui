#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

echo "=== Tailwind CSS ==="
bash scripts/setup-tailwind.sh
./bin/tailwindcss -i static/input.css -o static/tw.css --minify
echo "Generated static/tw.css"

echo "=== Ruff ==="
./.venv/bin/ruff check .
echo "=== Mypy ==="
./.venv/bin/mypy app/
echo "=== Tests ==="
./.venv/bin/pytest tests/

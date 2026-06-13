#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f ".venv/bin/activate" ]; then
    echo "[ERROR] .venv non trovato. Esegui: python -m venv .venv"
    exit 1
fi

echo "=== Tailwind CSS ==="
bash scripts/setup-tailwind.sh
./bin/tailwindcss -i static/input.css -o static/tw.css --minify
echo "Generated static/tw.css"

source .venv/bin/activate

exec uvicorn app.main:app --reload --reload-dir app --host 127.0.0.1 --port 8050

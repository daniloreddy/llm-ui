#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

if [ ! -f ".venv/bin/activate" ]; then
    echo "[setup] .venv not found — creating..."
    python3 -m venv .venv
    .venv/bin/pip install -r requirements.txt
fi

echo "=== Tailwind CSS ==="
bash scripts/setup-tailwind.sh
./bin/tailwindcss -i static/input.css -o static/tw.css --minify
echo "Generated static/tw.css"

source .venv/bin/activate

exec uvicorn app.main:app --reload --reload-dir app --host 127.0.0.1 --port 8050

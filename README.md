# llm-ui

A minimal chat interface for OpenAI-compatible LLM APIs.  
Python/FastAPI backend acts as a proxy — no CORS issues, no build step, no framework.

![Python](https://img.shields.io/badge/python-3.11%2B-blue)
![FastAPI](https://img.shields.io/badge/FastAPI-0.111%2B-009688)
![License](https://img.shields.io/badge/license-MIT-green)

## Features

- **Multi-endpoint** — configure any number of OpenAI-compatible endpoints (llama.cpp, Cloudflare AI Gateway, OpenRouter, etc.)
- **Multi-panel layout** — chat with 1–4 endpoints side by side; per-panel input or broadcast mode
- **Streaming** — token-by-token SSE streaming with stop-generation support
- **Regenerate** — resend the last prompt to get a different response
- **Prompt history** — navigate previously sent messages with ↑/↓ (per panel)
- **File attachments** — text files, PDFs (client-side extraction via PDF.js), images (multimodal)
- **Markdown rendering** — syntax highlighting via highlight.js; copy-code button on every block
- **Reasoning blocks** — `<think>`/`<thinking>` content collapsed into an expandable accordion
- **Token counter** — estimated token count for the current conversation
- **Per-panel console** — HTTP log drawer showing request/response details
- **Chat export** — Markdown or JSON per panel
- **Config export/import** — backup and restore all endpoints as JSON
- **Drag-and-drop** — reorder endpoints in the list
- **Clone endpoint** — duplicate an endpoint (including API key) to quickly create model variants
- **Font selection** — system font or any Google Font (presets + custom name)
- **i18n** — Italian and English UI; adding a language requires only two new files
- **Server-side persistence** — config stored in `data/config.json`, survives restarts

## Requirements

- Python 3.11+
- A running OpenAI-compatible LLM server (e.g. [llama.cpp](https://github.com/ggerganov/llama.cpp), Cloudflare AI Gateway, OpenRouter)

## Quick start

```bash
# 1. Clone
git clone https://github.com/your-username/llm-ui.git
cd llm-ui

# 2. Create virtualenv and install deps
python -m venv .venv
.venv\Scripts\pip install -r requirements.txt        # Windows
# .venv/bin/pip install -r requirements.txt          # Linux/macOS

# 3. Configure environment
cp .env.example .env
# edit .env if needed (defaults work for local / Cloudflare Tunnel)

# 4. Set the login password (once)
python scripts/set_password.py

# 5. Run
scripts\run.bat        # Windows
# bash scripts/run.sh  # Linux/macOS
```

Open [http://127.0.0.1:8050](http://127.0.0.1:8050) in your browser and log in.

## Authentication

All routes are protected by a session cookie (JWT, `HttpOnly`, `SameSite=Strict`).  
Set the password once before first run:

```bash
python scripts/set_password.py
```

To expose the app on the internet, use **Cloudflare Tunnel** — no port forwarding, automatic HTTPS:

```bash
cloudflared tunnel create llm-ui
cloudflared tunnel route dns llm-ui llm-ui.yourdomain.com
cloudflared tunnel run --url http://127.0.0.1:8050 llm-ui
```

See `.env.example` for tunable parameters (`TRUSTED_PROXIES`, `AUTH_SECURE_COOKIE`).

## Docker

The image is built and published automatically to GHCR on every push to `main`.  
You only need `docker-compose.yml` and a `.env` file — no local clone required.

```bash
# 1. Download docker-compose.yml
curl -O https://raw.githubusercontent.com/daniloreddy/llm-ui/main/docker-compose.yml

# 2. Create .env (adjust values as needed)
cat > .env <<'EOF'
# IPs of trusted reverse proxies (Cloudflare Tunnel, Apache, nginx).
# Default covers local proxy / Cloudflare Tunnel on the same host.
TRUSTED_PROXIES=127.0.0.1

# Uncomment to force the session cookie Secure flag (not needed behind Cloudflare Tunnel).
# AUTH_SECURE_COOKIE=1
EOF

# 3. Pull and start
docker compose pull
docker compose up -d

# 4. First run: set the login password
docker compose exec llm-ui python scripts/set_password.py
```

App available at [http://localhost:8050](http://localhost:8050).  
Config and auth data are persisted in `./data/` (created automatically). Logs go to stdout (`docker compose logs`).

### Local development (build from source)

```bash
git clone https://github.com/daniloreddy/llm-ui.git
cd llm-ui
cp .env.example .env
docker compose -f docker-compose-dev.yml up --build
```

## Configuration

Endpoints are managed entirely from the UI (Settings tab). Each endpoint stores:

| Field | Description |
|---|---|
| Name | Display label |
| Server URL | Base URL of the OpenAI-compatible API |
| Use raw URL | POST directly to the URL as-is (skip `/v1/chat/completions` append) |
| Model | Model identifier (optional — omitted if blank) |
| API Key | Bearer token (stored server-side, never exposed to the browser) |
| System prompt | Per-endpoint system message |
| Temperature / Top-p / Max tokens / Repeat penalty | Generation parameters |

## Project structure

```
.
├── app/
│   ├── main.py       # FastAPI app, auth middleware + routes, lifespan
│   ├── auth.py       # AuthManager — password hashing, JWT, rate limiting
│   ├── config.py     # ConfigManager (async, atomic writes)
│   └── proxy.py      # LLM streaming proxy
├── static/
│   ├── index.html    # SPA shell
│   ├── login.html    # Login page (self-contained, inline CSS)
│   ├── app.js        # All frontend logic
│   ├── style.css     # Custom styles
│   ├── input.css     # Tailwind v4 entry point
│   ├── tw.css        # Generated CSS — gitignored
│   ├── i18n/
│   │   ├── it.json   # Italian strings
│   │   └── en.json   # English strings
│   └── guide/
│       ├── it.html   # Italian user guide (lazy-loaded)
│       └── en.html   # English user guide (lazy-loaded)
├── tests/
│   ├── test_clamp.py   # Unit tests — _clamp, _build_payload
│   ├── test_config.py  # Unit tests — ConfigManager
│   └── test_api.py     # Integration tests — FastAPI endpoints
├── scripts/
│   ├── run.bat / run.sh                  # Start the server
│   ├── check.bat / check.sh              # Tailwind + ruff + mypy + pytest
│   ├── setup-tailwind.bat / .sh         # Download Tailwind CLI binary
│   └── set_password.py                  # Set the login password
├── bin/                      # Tailwind CLI binary — gitignored
├── data/                     # Runtime (gitignored): config.json, auth.json
├── .env.example              # Environment variable reference
├── Dockerfile
└── docker-compose.yml
```

## Development

```bash
# Install dev deps
.venv\Scripts\pip install -r requirements.dev.txt

# Generate CSS + lint + type-check + test
scripts\check.bat        # Windows
# bash scripts/check.sh  # Linux/macOS
```

The check script downloads the Tailwind CLI binary on first run (requires `curl`), then generates `static/tw.css`.

## License

MIT

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

# 3. Run
scripts\run.bat        # Windows
# bash scripts/run.sh  # Linux/macOS
```

Open [http://127.0.0.1:8050](http://127.0.0.1:8050) in your browser.

## Docker

```bash
docker compose up
```

App available at [http://localhost:8050](http://localhost:8050).  
Config and logs are persisted in `./data/` via a bind mount.

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
│   ├── main.py       # FastAPI app, routes, lifespan
│   ├── config.py     # ConfigManager (async, atomic writes)
│   └── proxy.py      # LLM streaming proxy
├── app/
│   ├── main.py       # FastAPI app, routes, lifespan
│   ├── config.py     # ConfigManager (async, atomic writes)
│   └── proxy.py      # LLM streaming proxy
├── static/
│   ├── index.html    # SPA shell
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
│   └── setup-tailwind.bat / .sh         # Download Tailwind CLI binary
├── bin/                      # Tailwind CLI binary — gitignored
├── data/                     # Runtime (gitignored): config.json, llm-ui.log
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

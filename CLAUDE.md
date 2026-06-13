# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Pure client-side SPA (no build step, no backend, no framework) for chatting with a local SLM via an OpenAI-compatible API (e.g. `llama.cpp` server). Open `index.html` directly in a browser — no server required.

## Running the App

Open `index.html` in a browser. No build, no install, no server needed.

For CORS-free local development (if the browser blocks `file://` requests):
```
python -m http.server 8000
# then open http://localhost:8000
```

Default target: `http://127.0.0.1:8080/v1/chat/completions`

## Architecture

Three files, no dependencies bundled locally:

| File | Role |
|------|------|
| `index.html` | SPA shell: two tab panels (Chat, Impostazioni), file input, attachment preview bar |
| `app.js` | All application logic: global state, tab switching, file processing, streaming fetch, localStorage persistence |
| `style.css` | Minimal overrides — custom range sliders, attachment preview, message bubbles, streaming cursor animation |

CDN dependencies (loaded in `index.html`):
- Tailwind CSS Play CDN
- PDF.js 3.11.174 + worker (for client-side PDF text extraction)

### State model (`app.js`)

`configState` — persisted to `localStorage` key `llm-ui-config`:
```
serverUrl, model, apiKey, systemPrompt,
temperature, top_p, max_tokens, repeat_penalty
```

`chatHistory` — in-memory array of `{role, content}` pairs, reset on ↺.

`attachedFiles` — transient array of `{name, kind, content, dataUrl?}`, cleared after each send.

### Message format

- Text/PDF attachments: appended as `[File allegato: name]\ncontent` to the user text string.
- Image attachments: sent as OpenAI multimodal `content` array `[{type:"text",...}, {type:"image_url", image_url:{url:"data:..."}}]`.
- `Authorization: Bearer <apiKey>` header added only when `apiKey` is non-empty.

### Streaming

Uses `fetch` + `ReadableStream`. SSE lines split on `\n`, parsed as `data: <json>`, delta content appended token-by-token to the assistant bubble. `[DONE]` terminates the stream.

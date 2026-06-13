#!/usr/bin/env bash
# Downloads the Tailwind CSS standalone binary if not already present.
set -euo pipefail
cd "$(dirname "$0")/.."

BIN_DIR="bin"
BIN="$BIN_DIR/tailwindcss"

if [ -x "$BIN" ]; then
  exit 0
fi

echo "[tailwind] Binary not found — downloading…"

OS="$(uname -s)"
ARCH="$(uname -m)"

case "${OS}_${ARCH}" in
  Linux_x86_64)   ASSET="tailwindcss-linux-x64" ;;
  Linux_aarch64)  ASSET="tailwindcss-linux-arm64" ;;
  Darwin_arm64)   ASSET="tailwindcss-macos-arm64" ;;
  Darwin_x86_64)  ASSET="tailwindcss-macos-x64" ;;
  *)
    echo "[tailwind] Unsupported platform: ${OS} ${ARCH}" >&2
    exit 1
    ;;
esac

echo "[tailwind] Fetching latest release…"
VERSION=$(curl -fsSL "https://api.github.com/repos/tailwindlabs/tailwindcss/releases/latest" \
  | grep '"tag_name"' \
  | head -1 \
  | sed 's/.*"tag_name": "\(.*\)".*/\1/')

if [ -z "$VERSION" ]; then
  echo "[tailwind] Could not determine latest version" >&2
  exit 1
fi

URL="https://github.com/tailwindlabs/tailwindcss/releases/download/${VERSION}/${ASSET}"
echo "[tailwind] Downloading ${VERSION} (${ASSET})…"

mkdir -p "$BIN_DIR"
curl -fsSL --progress-bar "$URL" -o "$BIN"
chmod +x "$BIN"

echo "[tailwind] Installed: $BIN"

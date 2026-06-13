@echo off
setlocal enabledelayedexpansion
cd /d "%~dp0\.."

set BIN_DIR=bin
set BIN=%BIN_DIR%\tailwindcss.exe

if exist "%BIN%" exit /b 0

echo [tailwind] Binary not found -- downloading...

echo [tailwind] Fetching latest release...
for /f "usebackq delims=" %%v in (`powershell -NoProfile -Command "(Invoke-RestMethod 'https://api.github.com/repos/tailwindlabs/tailwindcss/releases/latest').tag_name"`) do set VERSION=%%v

if "!VERSION!"=="" (
  echo [tailwind] Could not determine latest version
  exit /b 1
)

set ASSET=tailwindcss-windows-x64.exe
set URL=https://github.com/tailwindlabs/tailwindcss/releases/download/!VERSION!/!ASSET!
echo [tailwind] Downloading !VERSION! (!ASSET!)...

if not exist "%BIN_DIR%" mkdir "%BIN_DIR%"
curl -fsSL --progress-bar "%URL%" -o "%BIN%"

echo [tailwind] Installed: %BIN%

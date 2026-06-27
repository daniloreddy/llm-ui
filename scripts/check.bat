@echo off
cd /d "%~dp0\.."

if not exist "venv\Scripts\activate.bat" (
    echo [setup] venv not found -- creating...
    python -m venv venv
    venv\Scripts\pip install -r requirements.txt -r requirements.dev.txt
)

echo === Tailwind CSS ===
call scripts\setup-tailwind.bat
if errorlevel 1 exit /b 1
bin\tailwindcss.exe -i static\input.css -o static\tw.css --minify
echo Generated static\tw.css

echo === Ruff ===
venv\Scripts\ruff check .
echo === Mypy ===
venv\Scripts\mypy app\
echo === Tests ===
venv\Scripts\pytest tests\

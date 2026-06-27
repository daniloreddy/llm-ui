@echo off
cd /d "%~dp0\.."

if not exist "venv\Scripts\activate.bat" (
    echo [setup] venv not found -- creating...
    python -m venv venv
    venv\Scripts\pip install -r requirements.txt
)

echo === Tailwind CSS ===
call scripts\setup-tailwind.bat
if errorlevel 1 exit /b 1
bin\tailwindcss.exe -i static\input.css -o static\tw.css --minify
echo Generated static\tw.css

call venv\Scripts\activate.bat

uvicorn app.main:app --reload --reload-dir app --host 127.0.0.1 --port 8050

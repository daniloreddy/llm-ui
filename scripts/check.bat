@echo off
cd /d "%~dp0\.."
echo === Ruff ===
.venv\Scripts\ruff check .
echo === Mypy ===
.venv\Scripts\mypy app\
echo === Tests ===
.venv\Scripts\pytest tests\

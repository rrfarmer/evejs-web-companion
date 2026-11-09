@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 18 or newer is required.
  pause
  exit /b 1
)
echo Open http://localhost:8765/ in your browser.
echo Keep this window open. Press Ctrl+C to stop the offline server.
node serve.mjs
if errorlevel 1 pause

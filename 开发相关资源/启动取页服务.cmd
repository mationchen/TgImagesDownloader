@echo off
title Image Link Extractor - local fetch relay (127.0.0.1:8787)
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [ERROR] Node.js was not found in PATH.
  echo         Install Node.js, or run the HTML tool's "Method A" instead.
  echo.
  pause
  exit /b 1
)

echo ============================================================
echo  Local fetch relay for "图片链接提取器.html"  (Method B)
echo ------------------------------------------------------------
echo  URL   : http://127.0.0.1:8787/
echo  Port  : 8787   ^(kept busy until you stop this window^)
echo  Stop  : press Ctrl+C here, or just close this window
echo ============================================================
echo.
echo  Keep this window OPEN while using Method B in the HTML tool.
echo.

node "%~dp0fetch-server.js"

echo.
echo [stopped]
pause

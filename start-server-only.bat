@echo off
cd /d "%~dp0"

if not exist "%~dp0serve.ps1" (
    echo ERROR: serve.ps1 not found. Please extract the whole zip first.
    pause
    exit /b 1
)

echo Starting local server, WITHOUT auto-opening a browser...
echo After startup, copy the address printed below and open it in your browser.
echo Keep this window open - closing it stops the server.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1" -NoBrowser

if errorlevel 1 (
    echo.
    echo Startup failed, see messages above.
    pause
    exit /b 1
)

pause
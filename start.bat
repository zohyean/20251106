@echo off
cd /d "%~dp0"

if not exist "%~dp0serve.ps1" (
    echo ERROR: serve.ps1 not found. Please extract the whole zip first, then run start.bat again.
    echo Do NOT run files directly from inside the zip preview window.
    pause
    exit /b 1
)

echo Starting local server...
echo A browser window will open shortly. Keep this window open - closing it stops the server.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0serve.ps1"

if errorlevel 1 (
    echo.
    echo Startup failed, see messages above.
    pause
    exit /b 1
)

pause
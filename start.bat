@echo off
echo ============================================
echo  Physio Tracker - Starting...
echo ============================================
echo.

REM Start Ollama (if not already running)
echo [1/3] Starting Ollama...
tasklist /FI "IMAGENAME eq ollama.exe" 2>NUL | find /I /N "ollama.exe" >NUL
if "%ERRORLEVEL%"=="1" (
    start /B ollama serve
    echo       Ollama started.
) else (
    echo       Ollama already running.
)

REM Wait for Ollama to be ready
timeout /t 3 /nobreak >nul

REM Start Node.js server
echo [2/3] Starting Node.js server...
start /B node server.js

REM Wait for server to be ready
timeout /t 2 /nobreak >nul

REM Open browser
echo [3/3] Opening browser...
start http://localhost:5000

echo.
echo ============================================
echo  Physio Tracker running at:
echo  http://localhost:5000
echo ============================================
echo.
echo  Press Ctrl+C or run stop.bat to stop.
echo.
pause

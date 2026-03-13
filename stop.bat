@echo off
echo ============================================
echo  Physio Tracker - Stopping...
echo ============================================
echo.

echo Stopping Node.js server...
taskkill /F /IM node.exe /T 2>nul
if "%ERRORLEVEL%"=="0" (
    echo   Node.js stopped.
) else (
    echo   Node.js was not running.
)

echo Stopping Ollama...
taskkill /F /IM ollama.exe /T 2>nul
if "%ERRORLEVEL%"=="0" (
    echo   Ollama stopped.
) else (
    echo   Ollama was not running.
)

echo.
echo ============================================
echo  Physio Tracker stopped.
echo ============================================
echo.
pause

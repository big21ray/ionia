@echo off
echo Building Electron...
call npm run build:electron
if errorlevel 1 (
    echo Build failed!
    pause
    exit /b 1
)

echo Starting Vite dev server...
start "Vite Dev Server" cmd /k "npm run dev"

echo Waiting for Vite to start...
timeout /t 5 /nobreak >nul

echo Starting Electron...
call electron .

pause



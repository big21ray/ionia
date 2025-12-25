# PowerShell script to start Electron dev environment
Write-Host "Building Electron..." -ForegroundColor Cyan
npm run build:electron
if ($LASTEXITCODE -ne 0) {
    Write-Host "Build failed!" -ForegroundColor Red
    pause
    exit 1
}

Write-Host "Starting Vite dev server..." -ForegroundColor Cyan
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$PWD'; npm run dev" -WindowStyle Minimized

Write-Host "Waiting for Vite to start..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

Write-Host "Starting Electron..." -ForegroundColor Cyan
electron .


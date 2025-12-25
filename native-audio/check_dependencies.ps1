# Script to check for missing dependencies
Write-Host "Checking wasapi_capture.node dependencies..." -ForegroundColor Cyan

$modulePath = "build\Release\wasapi_capture.node"

if (-not (Test-Path $modulePath)) {
    Write-Host "ERROR: Module not found at $modulePath" -ForegroundColor Red
    exit 1
}

Write-Host "`nModule found: $modulePath" -ForegroundColor Green

# Check for Visual C++ Redistributables
Write-Host "`nChecking Visual C++ Redistributables..." -ForegroundColor Cyan
$vcredist = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*" | 
    Where-Object { $_.DisplayName -like "*Visual C++*Redistributable*" } | 
    Select-Object DisplayName, DisplayVersion

if ($vcredist) {
    Write-Host "Visual C++ Redistributables found:" -ForegroundColor Green
    $vcredist | ForEach-Object { Write-Host "  - $($_.DisplayName) $($_.DisplayVersion)" }
} else {
    Write-Host "WARNING: Visual C++ Redistributables not found in registry" -ForegroundColor Yellow
    Write-Host "  Download from: https://aka.ms/vs/17/release/vc_redist.x64.exe" -ForegroundColor Yellow
}

# Check for required DLLs
Write-Host "`nChecking FFmpeg DLLs..." -ForegroundColor Cyan
$requiredDlls = @("avcodec.dll", "avformat.dll", "avutil.dll", "swresample.dll")
$dllPath = "build\Release"

foreach ($dll in $requiredDlls) {
    $fullPath = Join-Path $dllPath $dll
    if (Test-Path $fullPath) {
        Write-Host "  [OK] $dll" -ForegroundColor Green
    } else {
        Write-Host "  [MISSING] $dll" -ForegroundColor Red
    }
}

# Try to load the module to see the actual error
Write-Host "`nAttempting to load module to check dependencies..." -ForegroundColor Cyan
try {
    $module = [System.Reflection.Assembly]::LoadFrom((Resolve-Path $modulePath).Path)
    Write-Host "Module loaded successfully!" -ForegroundColor Green
} catch {
    Write-Host "Error loading module: $($_.Exception.Message)" -ForegroundColor Red
    Write-Host "`nThis usually means:" -ForegroundColor Yellow
    Write-Host "  1. Missing Visual C++ Redistributables" -ForegroundColor Yellow
    Write-Host "  2. Missing DLL dependencies (use Dependency Walker or Dependencies.exe)" -ForegroundColor Yellow
    Write-Host "  3. Architecture mismatch (x64 vs x86)" -ForegroundColor Yellow
}

Write-Host "`nTo check for missing DLL dependencies, use:" -ForegroundColor Cyan
Write-Host "  - Dependencies.exe (https://github.com/lucasg/Dependencies)" -ForegroundColor White
Write-Host "  - Or: dumpbin /dependents build\Release\wasapi_capture.node" -ForegroundColor White


# Script de diagnostic complet pour wasapi_capture.node
Write-Host "========================================" -ForegroundColor Cyan
Write-Host "Diagnostic du module wasapi_capture.node" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan
Write-Host ""

$modulePath = "build\Release\wasapi_capture.node"
$dllPath = "build\Release"

# 1. Vérifier que le module existe
Write-Host "[1] Vérification du module..." -ForegroundColor Yellow
if (Test-Path $modulePath) {
    $moduleInfo = Get-Item $modulePath
    Write-Host "  [OK] Module trouvé: $modulePath" -ForegroundColor Green
    Write-Host "  Taille: $($moduleInfo.Length) bytes" -ForegroundColor White
    Write-Host "  Date: $($moduleInfo.LastWriteTime)" -ForegroundColor White
} else {
    Write-Host "  [ERREUR] Module non trouvé!" -ForegroundColor Red
    exit 1
}

# 2. Vérifier l'architecture de Node.js
Write-Host "`n[2] Vérification de l'architecture Node.js..." -ForegroundColor Yellow
$nodeArch = node -p "process.arch"
$nodeVersion = node -p "process.versions.node"
Write-Host "  Architecture Node.js: $nodeArch" -ForegroundColor White
Write-Host "  Version Node.js: $nodeVersion" -ForegroundColor White
if ($nodeArch -ne "x64") {
    Write-Host "  [ATTENTION] Node.js n'est pas x64!" -ForegroundColor Red
}

# 3. Vérifier les DLLs FFmpeg
Write-Host "`n[3] Vérification des DLLs FFmpeg..." -ForegroundColor Yellow
$requiredDlls = @("avcodec.dll", "avformat.dll", "avutil.dll", "swresample.dll")
$allPresent = $true
foreach ($dll in $requiredDlls) {
    $dllPath = Join-Path $dllPath $dll
    if (Test-Path $dllPath) {
        Write-Host "  [OK] $dll" -ForegroundColor Green
    } else {
        Write-Host "  [MANQUANT] $dll" -ForegroundColor Red
        $allPresent = $false
    }
}

# 4. Vérifier les Redistributables Visual C++
Write-Host "`n[4] Vérification des Redistributables Visual C++..." -ForegroundColor Yellow
$vcredist = Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*" | 
    Where-Object { $_.DisplayName -like "*Visual C++*Redistributable*" -and $_.DisplayName -like "*2015*" -or $_.DisplayName -like "*2017*" -or $_.DisplayName -like "*2019*" -or $_.DisplayName -like "*2022*" } | 
    Select-Object DisplayName, DisplayVersion

if ($vcredist) {
    Write-Host "  [OK] Redistributables trouvés:" -ForegroundColor Green
    $vcredist | ForEach-Object { Write-Host "    - $($_.DisplayName) $($_.DisplayVersion)" -ForegroundColor White }
} else {
    Write-Host "  [MANQUANT] Redistributables Visual C++ 2015-2022 non trouvés!" -ForegroundColor Red
    Write-Host "    Télécharger: https://aka.ms/vs/17/release/vc_redist.x64.exe" -ForegroundColor Yellow
}

# 5. Vérifier les DLLs système Visual C++
Write-Host "`n[5] Vérification des DLLs système Visual C++..." -ForegroundColor Yellow
$vcDlls = @(
    "C:\Windows\System32\msvcp140.dll",
    "C:\Windows\System32\vcruntime140.dll",
    "C:\Windows\System32\vcruntime140_1.dll",
    "C:\Windows\System32\msvcp140_atomic_wait.dll"
)
foreach ($dll in $vcDlls) {
    if (Test-Path $dll) {
        $version = (Get-Item $dll).VersionInfo.FileVersion
        Write-Host "  [OK] $(Split-Path $dll -Leaf) (v$version)" -ForegroundColor Green
    } else {
        Write-Host "  [MANQUANT] $(Split-Path $dll -Leaf)" -ForegroundColor Red
    }
}

# 6. Lister toutes les DLLs dans le répertoire
Write-Host "`n[6] DLLs présentes dans build\Release..." -ForegroundColor Yellow
$dlls = Get-ChildItem "build\Release" -Filter "*.dll"
if ($dlls) {
    Write-Host "  Total: $($dlls.Count) DLLs" -ForegroundColor White
    $dlls | ForEach-Object { Write-Host "    - $($_.Name)" -ForegroundColor White }
} else {
    Write-Host "  [AUCUNE] Aucune DLL trouvée!" -ForegroundColor Red
}

# 7. Essayer de charger le module
Write-Host "`n[7] Tentative de chargement du module..." -ForegroundColor Yellow
try {
    $testScript = @"
    try {
        const path = require('path');
        const modulePath = path.join(__dirname, 'build', 'Release', 'wasapi_capture.node');
        const m = require(modulePath);
        console.log('SUCCESS: Module chargé!');
        console.log('Exports:', Object.keys(m));
    } catch (err) {
        console.error('ERROR:', err.message);
        process.exit(1);
    }
"@
    $testScript | node
    if ($LASTEXITCODE -eq 0) {
        Write-Host "  [OK] Module chargé avec succès!" -ForegroundColor Green
    } else {
        Write-Host "  [ERREUR] Échec du chargement" -ForegroundColor Red
    }
} catch {
    Write-Host "  [ERREUR] $($_.Exception.Message)" -ForegroundColor Red
}

# 8. Recommandations
Write-Host "`n[8] Recommandations..." -ForegroundColor Yellow
Write-Host "  Pour diagnostiquer les dépendances manquantes:" -ForegroundColor White
Write-Host "    1. Télécharger Dependencies.exe:" -ForegroundColor White
Write-Host "       https://github.com/lucasg/Dependencies/releases" -ForegroundColor Cyan
Write-Host "    2. Ouvrir wasapi_capture.node avec Dependencies.exe" -ForegroundColor White
Write-Host "    3. Chercher les DLLs marquées en rouge (manquantes)" -ForegroundColor White
Write-Host ""
Write-Host "  Vérifier le linking:" -ForegroundColor White
Write-Host "    dumpbin /dependents build\Release\wasapi_capture.node" -ForegroundColor Cyan

Write-Host "`n========================================" -ForegroundColor Cyan
Write-Host "Diagnostic terminé" -ForegroundColor Cyan
Write-Host "========================================" -ForegroundColor Cyan


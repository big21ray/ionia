# Instructions de compilation

## Problème : Module natif non trouvé ou ne peut pas être chargé

### Solution 1 : Compiler le module

Le module doit être compilé avec Visual Studio. Si Python n'est pas installé, vous pouvez utiliser MSBuild directement :

```powershell
cd native-audio
# Utiliser MSBuild directement (sans Python)
# Ou installer Python 3.x et ajouter au PATH
```

### Solution 2 : Installer FFmpeg avec libx264 (Requis pour Electron)

**Important** : Pour que le module fonctionne correctement dans Electron, FFmpeg doit être compilé avec **libx264** (et non h264_mf qui ne fonctionne pas en mode STA).

#### Installation via vcpkg (Recommandé)

1. **Installer x264** :
```powershell
cd C:\vcpkg
.\vcpkg install x264:x64-windows
```

2. **Installer FFmpeg avec nonfree et x264** :
```powershell
.\vcpkg install ffmpeg[nonfree,x264]:x64-windows --recurse
```

**Note** : Le flag `--recurse` est nécessaire pour reconstruire FFmpeg avec les nouvelles fonctionnalités.

**⚠️ Important** : Si vous avez des problèmes de chargement du module, réinstallez FFmpeg sans cache pour forcer la compilation en RELEASE :
```powershell
.\vcpkg remove ffmpeg:x64-windows
.\vcpkg install ffmpeg[nonfree,x264]:x64-windows --no-binarycaching
```

Cela garantit que les DLLs sont compilées en mode RELEASE (pas DEBUG) et fonctionneront avec les Redistributables Visual C++ standard.

3. **Vérifier l'installation** :
```powershell
# Vérifier que x264 est installé
.\vcpkg list x264:x64-windows

# Vérifier que FFmpeg a la fonctionnalité x264
.\vcpkg list ffmpeg:x64-windows
```

Vous devriez voir `x264` dans la liste des fonctionnalités de FFmpeg.

4. **Rebuilder le module natif** :
```powershell
cd C:\Users\Karmine Corp\Documents\Ionia\native-audio
.\build_electron.bat
```

#### Pourquoi libx264 est nécessaire ?

- **Electron** initialise COM en mode **STA** (Single-Threaded Apartment)
- **h264_mf** (Windows Media Foundation) nécessite le mode **MTA** (Multi-Threaded Apartment)
- **libx264** fonctionne dans les deux modes, donc c'est la solution pour Electron

### Solution 3 : Copier les DLLs FFmpeg (RELEASE uniquement)

**⚠️ IMPORTANT : Utilisez uniquement les DLLs de RELEASE, pas les DLLs de DEBUG !**

Si le module existe mais ne peut pas être chargé, il manque probablement les DLLs FFmpeg. **Le problème le plus courant est d'utiliser des DLLs de DEBUG au lieu de RELEASE.**

#### Problème des DLLs de DEBUG vs RELEASE

Les DLLs de DEBUG (dans `buildtrees\x64-windows-dbg`) nécessitent :
- `VCRUNTIME140D.dll` (version debug - non disponible dans les Redistributables standard)
- `ucrtbased.dll` (version debug)

Ces DLLs ne sont **pas disponibles** dans les Redistributables Visual C++ standard, donc le module ne peut pas se charger.

#### Solution : Utiliser les DLLs de RELEASE

1. **Vérifier que FFmpeg est installé correctement** (avec DLLs de release) :
```powershell
cd C:\vcpkg
# Réinstaller FFmpeg sans cache pour forcer la compilation en release
.\vcpkg remove ffmpeg:x64-windows
.\vcpkg install ffmpeg[nonfree,x264]:x64-windows --no-binarycaching
```

2. **Copier les DLLs de RELEASE depuis installed\bin** :
```powershell
# Les DLLs de release sont dans installed\x64-windows\bin (pas dans buildtrees!)
$source = "C:\vcpkg\installed\x64-windows\bin"
$target = "C:\Users\Karmine Corp\Documents\Ionia\native-audio\build\Release"

# Copier toutes les DLLs FFmpeg
Copy-Item "$source\avcodec-61.dll" $target -Force
Copy-Item "$source\avformat-61.dll" $target -Force
Copy-Item "$source\avutil-59.dll" $target -Force
Copy-Item "$source\swscale-8.dll" $target -Force
Copy-Item "$source\swresample-5.dll" $target -Force
Copy-Item "$source\libx264-164.dll" $target -Force

# Ou copier toutes les DLLs d'un coup
Copy-Item "$source\*.dll" $target -Force
```

3. **Vérifier que les DLLs sont de type RELEASE** :
```powershell
# Utiliser dumpbin pour vérifier les dépendances
$dumpbin = "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe"
& $dumpbin /dependents "build\Release\avcodec-61.dll" | Select-String "VCRUNTIME"

# Doit afficher "VCRUNTIME140.dll" (sans le "D" = release)
# Si vous voyez "VCRUNTIME140D.dll" (avec "D" = debug), c'est le problème !
```

4. **Utiliser le script fix_dlls.bat** (mais vérifiez qu'il utilise installed\bin, pas buildtrees) :
```powershell
cd native-audio
.\fix_dlls.bat
```

**Note** : Si `fix_dlls.bat` trouve les DLLs dans `buildtrees` (debug), réinstallez FFmpeg avec `--no-binarycaching` pour forcer la compilation en release.

### Solution 4 : Compiler avec Visual Studio directement

Si node-gyp ne fonctionne pas, vous pouvez compiler avec Visual Studio :

1. Ouvrir `native-audio/build/wasapi_capture.sln` dans Visual Studio
2. Compiler en mode Release
3. Le fichier `.node` sera dans `build/Release/`

### Vérification

Après compilation, vérifiez :

```powershell
Test-Path "C:\Users\Karmine Corp\Documents\Ionia\native-audio\build\Release\wasapi_capture.node"
# Doit retourner True
```

Puis testez le chargement :

```powershell
cd "C:\Users\Karmine Corp\Documents\Ionia\native-audio"
node -e "const m = require('./build/Release/wasapi_capture.node'); console.log('OK!', Object.keys(m));"
```

### Diagnostic : Erreur "The specified module could not be found"

Si vous obtenez l'erreur `The specified module could not be found`, voici comment diagnostiquer :

#### 1. Vérifier les dépendances avec dumpbin

```powershell
# Trouver dumpbin (inclus avec Visual Studio)
$dumpbin = Get-ChildItem "C:\Program Files\Microsoft Visual Studio\*\Community\VC\Tools\MSVC\*\bin\Hostx64\x64\dumpbin.exe" | Select-Object -First 1

# Vérifier les dépendances du module
& $dumpbin /dependents "build\Release\wasapi_capture.node"

# Vérifier les dépendances des DLLs FFmpeg
& $dumpbin /dependents "build\Release\avcodec-61.dll"
```

**Signes de problème** :
- Si vous voyez `VCRUNTIME140D.dll` (avec "D") → DLLs de DEBUG
- Si vous voyez `ucrtbased.dll` → DLLs de DEBUG
- **Solution** : Utilisez des DLLs de RELEASE (voir Solution 3)

#### 2. Vérifier que les DLLs sont présentes

```powershell
$required = @("avcodec-61.dll", "avformat-61.dll", "avutil-59.dll", "swscale-8.dll", "swresample-5.dll")
foreach ($dll in $required) {
    $path = "build\Release\$dll"
    if (Test-Path $path) {
        Write-Host "[OK] $dll" -ForegroundColor Green
    } else {
        Write-Host "[MANQUANT] $dll" -ForegroundColor Red
    }
}
```

#### 3. Vérifier les Redistributables Visual C++

```powershell
Get-ItemProperty "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*" | 
    Where-Object { $_.DisplayName -like "*Visual C++*Redistributable*2015*" -or $_.DisplayName -like "*2017*" -or $_.DisplayName -like "*2019*" -or $_.DisplayName -like "*2022*" } | 
    Select-Object DisplayName
```

Si aucun n'est installé, téléchargez : https://aka.ms/vs/17/release/vc_redist.x64.exe




# Instructions de compilation

## Problème : Module natif non trouvé ou ne peut pas être chargé

### Solution 1 : Compiler le module

Le module doit être compilé avec Visual Studio. Si Python n'est pas installé, vous pouvez utiliser MSBuild directement :

```powershell
cd native-audio
# Utiliser MSBuild directement (sans Python)
# Ou installer Python 3.x et ajouter au PATH
```

### Solution 2 : Vérifier les DLLs FFmpeg

Si le module existe mais ne peut pas être chargé, il manque probablement les DLLs FFmpeg :

1. **Copier les DLLs depuis vcpkg** :
```powershell
# Copier depuis vcpkg vers le dossier build/Release
Copy-Item "C:\vcpkg\installed\x64-windows\bin\avcodec.dll" "C:\Users\Karmine Corp\Documents\Ionia\native-audio\build\Release\"
Copy-Item "C:\vcpkg\installed\x64-windows\bin\avformat.dll" "C:\Users\Karmine Corp\Documents\Ionia\native-audio\build\Release\"
Copy-Item "C:\vcpkg\installed\x64-windows\bin\avutil.dll" "C:\Users\Karmine Corp\Documents\Ionia\native-audio\build\Release\"
Copy-Item "C:\vcpkg\installed\x64-windows\bin\swresample.dll" "C:\Users\Karmine Corp\Documents\Ionia\native-audio\build\Release\"
```

2. **Ou ajouter le dossier bin de vcpkg au PATH** :
```powershell
$env:PATH += ";C:\vcpkg\installed\x64-windows\bin"
```

### Solution 3 : Compiler avec Visual Studio directement

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


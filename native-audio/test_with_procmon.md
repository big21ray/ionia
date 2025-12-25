# Instructions pour utiliser Process Monitor

## Télécharger Process Monitor
1. Aller sur : https://learn.microsoft.com/en-us/sysinternals/downloads/procmon
2. Télécharger Process Monitor (procmon.exe)
3. Exécuter procmon.exe (pas besoin d'installer)

## Configuration des filtres

1. **Arrêter la capture** (bouton "Capture" en haut à gauche)

2. **Ajouter un filtre pour le processus** :
   - Menu : Filter → Filter...
   - Ajouter :
     - Process Name is electron.exe then Include
   - Cliquer OK

3. **Ajouter un filtre pour les opérations** :
   - Menu : Filter → Filter...
   - Ajouter :
     - Operation is Load Image then Include
   - Cliquer OK

4. **Ajouter un filtre pour le chemin** :
   - Menu : Filter → Filter...
   - Ajouter :
     - Path contains wasapi_capture then Include
   - Cliquer OK

5. **Démarrer la capture** (bouton "Capture")

## Lancer Electron

Dans un autre terminal :
```bash
npm run electron:dev
```

## Analyser les résultats

Dans Process Monitor, chercher les lignes avec :
- **Result: NAME NOT FOUND** (en rouge)
- **Path** contenant le chemin vers wasapi_capture.node

Ces lignes indiqueront exactement quelle DLL manque.

## Alternative : Utiliser dumpbin pour toutes les dépendances

Si Process Monitor ne fonctionne pas, on peut utiliser dumpbin pour analyser toutes les dépendances transitives des DLLs FFmpeg.


# Guide de Test - Architecture Audio Unifiée

## Architecture Implémentée

```
WASAPI Source (ANY FORMAT)
   ↓
[ Capture Thread ]
   ↓
[ Convert to float32 ]
   ↓
[ Resample to 48000 Hz ]   ← TOUJOURS
   ↓
[ Channel adapt (mono → stereo, etc.) ]
   ↓
Unified AudioFrame (48k float32 stereo)
   ↓
Mixer (desktop + mic)
   ↓
Callback JavaScript
   ↓
FFmpeg / WAV Writer
```

## Tests Disponibles

### 1. Test avec debug_record_wav.js (Recommandé)

Ce script teste la capture audio complète et génère un fichier WAV pour vérification.

**Commandes :**

```bash
cd native-audio
node debug_record_wav.js
```

**Ce qui se passe :**
- Capture 10 secondes d'audio (desktop + mic en mode 'both')
- Traite les données via la pipeline unifiée
- Génère un fichier WAV : `debug_desktop_stereo_header_48000.wav`

**Résultats attendus :**
- Format retourné : `{ sampleRate: 48000, channels: 2, bitsPerSample: 32 }`
- Fichier WAV lisible avec un lecteur audio
- Audio propre sans grésillement (les deux sources sont resamplées à 48k avant mixage)

**Vérifications :**
```bash
# Vérifier le format du fichier WAV
ffprobe debug_desktop_stereo_header_48000.wav

# Ou simplement l'écouter
# Le fichier devrait être à 48000 Hz, stéréo, float32
```

### 2. Test des différents modes

Modifier `debug_record_wav.js` ligne 110 pour tester différents modes :

```javascript
// Mode desktop seulement
audioCapture = new WASAPICapture((buffer) => {
  chunks.push(Buffer.from(buffer));
}, 'desktop');

// Mode microphone seulement
audioCapture = new WASAPICapture((buffer) => {
  chunks.push(Buffer.from(buffer));
}, 'mic');

// Mode both (desktop + mic)
audioCapture = new WASAPICapture((buffer) => {
  chunks.push(Buffer.from(buffer));
}, 'both');
```

### 3. Test dans l'application Electron

L'application Electron utilise déjà cette architecture. Pour tester :

1. **Démarrer l'app :**
   ```bash
   npm run dev
   ```

2. **Utiliser les boutons de recording :**
   - **REC BOTH** : Enregistre desktop + microphone (mixés)
   - **REC DESK** : Enregistre desktop seulement
   - **REC MIC** : Enregistre microphone seulement

3. **Vérifier les logs :**
   - Dans la console, tu devrais voir : `Unified audio format: 48000 Hz, 2 channels, float32`
   - Le format retourné devrait toujours être 48000 Hz, 2 channels, 32-bit

### 4. Vérification des logs C++

Les logs stderr montrent le traitement de chaque source :

```
Desktop audio format (native): tag=65534, channels=8, rate=44100, bits=32, align=32
Microphone native format: tag=65534, channels=1, rate=48000, bits=32, align=4
Unified audio format: 48000 Hz, 2 channels, float32
```

**Ce qui se passe dans ProcessAudioFrame :**
- Desktop : 44100 Hz, 8ch → 48000 Hz, 2ch (resample + downmix)
- Mic : 48000 Hz, 1ch → 48000 Hz, 2ch (pas de resample, duplicate mono)

### 5. Test de performance

Pour vérifier que la pipeline fonctionne en temps réel :

```bash
# Lancer le script et vérifier les callbacks
node debug_record_wav.js

# Tu devrais voir :
# 📊 Callback called 100 times, total chunks: 100, last buffer size: XXXX bytes
# Les callbacks devraient être réguliers (pas de blocage)
```

## Problèmes Courants

### ❌ "No audio chunks captured"
- **Cause** : Aucune source audio active
- **Solution** : Joue de l'audio (YouTube, musique) et/ou parle dans le micro

### ❌ Fichier WAV vide ou très petit
- **Cause** : La pipeline ne fonctionne pas correctement
- **Solution** : Vérifier les logs stderr pour voir les erreurs de conversion/resampling

### ❌ Audio grésillant dans REC BOTH
- **Cause** : Problème de resampling ou de synchronisation
- **Solution** : Vérifier que les deux sources sont bien resamplées à 48k (voir logs)

### ❌ Format incorrect (pas 48000 Hz)
- **Cause** : `GetFormat()` ne retourne pas le format unifié
- **Solution** : Vérifier que `m_pwfxUnified` est bien initialisé dans `Initialize()`

## Format de Sortie Garanti

Avec cette architecture, le format de sortie est **TOUJOURS** :
- **Sample Rate** : 48000 Hz
- **Channels** : 2 (stéréo)
- **Bits per Sample** : 32 (float32)
- **Block Align** : 8 bytes (2ch × 4 bytes)
- **Byte Rate** : 384000 bytes/sec

Peu importe les formats des périphériques WASAPI, la sortie est toujours normalisée.



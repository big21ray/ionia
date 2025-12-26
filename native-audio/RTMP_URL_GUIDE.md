# Guide : Où écrire votre URL RTMP

## 📍 3 endroits pour définir l'URL RTMP

### 1️⃣ Test JavaScript (`all_tests.js`)

**Fichier** : `native-audio/all_tests.js` (ligne ~791)

**Méthode 1 : Modifier directement**
```javascript
// Ligne 791 dans all_tests.js
const rtmpUrl = 'rtmp://localhost:1935/live/test';  // ← MODIFIEZ ICI
```

**Méthode 2 : Variable d'environnement**
```bash
# Windows PowerShell
$env:RTMP_URL="rtmp://localhost:1935/live/test"
node all_tests.js

# Windows CMD
set RTMP_URL=rtmp://localhost:1935/live/test
node all_tests.js

# Linux/Mac
export RTMP_URL="rtmp://localhost:1935/live/test"
node all_tests.js
```

**Exemples d'URLs** :
- Local : `rtmp://localhost:1935/live/test`
- YouTube : `rtmp://a.rtmp.youtube.com/live2/VOTRE_STREAM_KEY`
- Twitch : `rtmp://live.twitch.tv/app/VOTRE_STREAM_KEY`

---

### 2️⃣ Application Electron (via prompt)

**Fichier** : `src/components/StreamButton.tsx` (ligne 51)

Actuellement, l'URL est demandée via un **prompt** à chaque clic sur le bouton "STREAM" :

```typescript
const rtmpUrl = prompt('Enter RTMP URL (e.g., rtmp://live.twitch.tv/app/STREAM_KEY):');
```

**Avantage** : Flexible, peut changer à chaque stream  
**Inconvénient** : Doit taper l'URL à chaque fois

---

### 3️⃣ Application Electron (URL par défaut)

Si vous voulez une URL par défaut sans prompt, modifiez `electron/main.ts` :

**Option A : URL hardcodée**
```typescript
// Dans electron/main.ts, ligne ~273
ipcMain.handle('stream:start', async (event, rtmpUrl?: string) => {
  // URL par défaut si non fournie
  const defaultRtmpUrl = 'rtmp://localhost:1935/live/test';
  const finalRtmpUrl = rtmpUrl || defaultRtmpUrl;
  
  // ... reste du code
});
```

**Option B : Fichier de configuration**
Créer `config.json` :
```json
{
  "rtmpUrl": "rtmp://localhost:1935/live/test"
}
```

Puis dans `electron/main.ts` :
```typescript
import config from '../config.json';

ipcMain.handle('stream:start', async (event, rtmpUrl?: string) => {
  const finalRtmpUrl = rtmpUrl || config.rtmpUrl;
  // ... reste du code
});
```

**Option C : Variable d'environnement**
```typescript
// Dans electron/main.ts
const defaultRtmpUrl = process.env.RTMP_URL || 'rtmp://localhost:1935/live/test';
```

---

## 🎯 Recommandation selon votre cas

### Pour le développement/test
→ **Modifier directement dans `all_tests.js`** (ligne 791)
```javascript
const rtmpUrl = 'rtmp://localhost:1935/live/test';
```

### Pour l'application Electron (flexible)
→ **Garder le prompt** dans `StreamButton.tsx` (actuel)
→ L'utilisateur entre l'URL à chaque fois

### Pour l'application Electron (URL fixe)
→ **Ajouter une URL par défaut** dans `electron/main.ts`
→ Ou créer un fichier de configuration

---

## 📝 Exemples d'URLs RTMP

### Serveur local (nginx-rtmp)
```
rtmp://localhost:1935/live/test
```

### YouTube Live
```
rtmp://a.rtmp.youtube.com/live2/VOTRE_STREAM_KEY
```
*Obtenir la clé : https://studio.youtube.com → Créer un événement en direct*

### Twitch
```
rtmp://live.twitch.tv/app/VOTRE_STREAM_KEY
```
*Obtenir la clé : https://dashboard.twitch.tv/settings/stream*

### SRS (Simple Realtime Server)
```
rtmp://localhost:1935/live/test
```

---

## 🔧 Test rapide

1. **Modifier `all_tests.js` ligne 791** :
   ```javascript
   const rtmpUrl = 'rtmp://localhost:1935/live/test';
   ```

2. **Démarrer un serveur RTMP local** (voir `STREAMING_TEST.md`)

3. **Décommenter la section 6** dans `all_tests.js`

4. **Exécuter** :
   ```bash
   cd native-audio
   node all_tests.js
   ```

---

## ❓ Questions fréquentes

**Q : Je veux tester avec YouTube/Twitch, où mettre l'URL ?**  
R : Modifiez la ligne 791 dans `all_tests.js` ou utilisez la variable d'environnement `RTMP_URL`.

**Q : Je veux que l'application Electron demande l'URL à chaque fois**  
R : C'est déjà le cas ! Le prompt dans `StreamButton.tsx` fait ça.

**Q : Je veux une URL par défaut dans Electron**  
R : Modifiez `electron/main.ts` pour ajouter une URL par défaut (voir Option A ci-dessus).

**Q : Comment obtenir une clé de stream YouTube/Twitch ?**  
R : 
- **YouTube** : https://studio.youtube.com → Créer un événement en direct → Copier la "Stream Key"
- **Twitch** : https://dashboard.twitch.tv/settings/stream → Copier la "Primary Stream Key"




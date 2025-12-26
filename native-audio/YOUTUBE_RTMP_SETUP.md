# Guide : Configuration YouTube Live RTMP

## 📺 Format de l'URL RTMP YouTube

L'URL RTMP pour YouTube Live est toujours :

```
rtmp://a.rtmp.youtube.com/live2/VOTRE_STREAM_KEY
```

**Remplacez `VOTRE_STREAM_KEY` par votre vraie clé de stream YouTube.**

---

## 🔑 Comment obtenir votre Stream Key YouTube

### Méthode 1 : YouTube Studio (Recommandé)

1. Allez sur https://studio.youtube.com
2. Cliquez sur **"Créer"** (en haut à droite) → **"Diffuser en direct"**
3. Ou allez dans **"Contenu"** → **"Diffusions en direct"** → **"Nouvelle diffusion"**
4. Dans la section **"Stream"**, vous verrez :
   - **Stream Key** : Une longue chaîne de caractères (ex: `abcd-efgh-ijkl-mnop-qrst-uvwx-yz12-3456`)
5. **Copiez cette clé** (cliquez sur "Révéler" si elle est masquée)

### Méthode 2 : Paramètres du canal

1. Allez sur https://studio.youtube.com
2. **Paramètres** (icône engrenage) → **"Diffusion"**
3. Dans **"Stream Key"**, vous verrez votre clé
4. **Copiez cette clé**

---

## 📝 Exemple complet

Si votre Stream Key YouTube est : `abcd-efgh-ijkl-mnop-qrst-uvwx-yz12-3456`

Votre URL RTMP sera :
```
rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop-qrst-uvwx-yz12-3456
```

---

## 🔧 Configuration dans le code

### Dans `all_tests.js` (ligne ~791)

```javascript
const rtmpUrl = 'rtmp://a.rtmp.youtube.com/live2/abcd-efgh-ijkl-mnop-qrst-uvwx-yz12-3456';
```

**⚠️ IMPORTANT : Remplacez `abcd-efgh-ijkl-mnop-qrst-uvwx-yz12-3456` par votre vraie clé !**

### Via variable d'environnement (plus sécurisé)

```bash
# Windows PowerShell
$env:RTMP_URL="rtmp://a.rtmp.youtube.com/live2/VOTRE_STREAM_KEY"
node all_tests.js

# Windows CMD
set RTMP_URL=rtmp://a.rtmp.youtube.com/live2/VOTRE_STREAM_KEY
node all_tests.js
```

### Dans l'application Electron

Quand vous cliquez sur le bouton "STREAM", entrez :
```
rtmp://a.rtmp.youtube.com/live2/VOTRE_STREAM_KEY
```

---

## ⚠️ Sécurité

**NE PARTAGEZ JAMAIS votre Stream Key publiquement !**

- Ne la commitez pas dans Git
- Ne la partagez pas sur les réseaux sociaux
- Ne la mettez pas dans des captures d'écran publiques

Si vous avez accidentellement partagé votre clé :
1. Allez sur https://studio.youtube.com
2. **Paramètres** → **"Diffusion"**
3. Cliquez sur **"Régénérer"** pour créer une nouvelle clé
4. L'ancienne clé ne fonctionnera plus

---

## ✅ Test rapide

1. **Obtenez votre Stream Key** (voir ci-dessus)
2. **Modifiez `all_tests.js` ligne 791** :
   ```javascript
   const rtmpUrl = 'rtmp://a.rtmp.youtube.com/live2/VOTRE_STREAM_KEY';
   ```
3. **Décommentez la section 6** dans `all_tests.js`
4. **Créez un événement en direct** sur YouTube Studio (ou utilisez "Diffusion en direct maintenant")
5. **Exécutez** :
   ```bash
   cd native-audio
   node all_tests.js
   ```
6. **Vérifiez sur YouTube Studio** que le stream arrive bien

---

## 🎥 Créer un événement en direct sur YouTube

1. Allez sur https://studio.youtube.com
2. Cliquez sur **"Créer"** → **"Diffuser en direct"**
3. Remplissez les informations :
   - **Titre** : "Test Stream"
   - **Description** : (optionnel)
   - **Visibilité** : "Non répertorié" (pour tester) ou "Public"
4. Cliquez sur **"Créer un événement"**
5. Dans la section **"Stream"**, vous verrez votre Stream Key
6. **Copiez la clé** et utilisez-la dans l'URL RTMP

---

## 🔍 Vérifier que le stream fonctionne

1. **Démarrez le stream** avec votre code
2. Allez sur YouTube Studio → **"Diffusions en direct"**
3. Vous devriez voir :
   - **"En direct"** avec un indicateur rouge
   - Le nombre de spectateurs
   - La qualité vidéo reçue

---

## ❓ Problèmes courants

### "Failed to open RTMP connection"
- Vérifiez que vous avez bien remplacé `VOTRE_STREAM_KEY` par votre vraie clé
- Vérifiez que l'événement en direct est créé sur YouTube
- Vérifiez votre connexion internet

### "Connection lost"
- Normal si la connexion est instable
- Le ReconnectThread devrait automatiquement reconnecter
- Vérifiez les logs pour voir les tentatives de reconnect

### Le stream ne s'affiche pas sur YouTube
- Attendez 10-30 secondes (délai de traitement YouTube)
- Vérifiez que l'événement est bien en mode "En direct"
- Vérifiez les stats dans votre code : `videoPackets` et `audioPackets` devraient augmenter

---

## 📚 Ressources

- **YouTube Live Streaming** : https://support.google.com/youtube/answer/2907883
- **YouTube Studio** : https://studio.youtube.com
- **Format RTMP YouTube** : `rtmp://a.rtmp.youtube.com/live2/STREAM_KEY`




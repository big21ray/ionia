# Guide de Test du Streaming RTMP

## Options pour tester le streaming

### Option 1 : Serveur RTMP local (Recommandé pour développement)

**Avantages** :
- Pas besoin de credentials
- Test rapide et facile
- Pas de limite de bande passante
- Parfait pour tester backpressure et reconnect

**Solutions** :

#### A. nginx-rtmp (Windows)
```bash
# Télécharger nginx avec module RTMP
# https://github.com/arut/nginx-rtmp-module/wiki/Installing-via-Build

# Configurer nginx.conf:
rtmp {
    server {
        listen 1935;
        application live {
            live on;
            record off;
        }
    }
}

# Démarrer nginx
nginx.exe

# URL RTMP: rtmp://localhost:1935/live/test
```

#### B. SRS (Simple Realtime Server)
```bash
# Télécharger SRS pour Windows
# https://github.com/ossrs/srs/releases

# Configurer conf/rtmp.conf:
listen              1935;
vhost __defaultVhost__ {
}

# Démarrer SRS
srs.exe -c conf/rtmp.conf

# URL RTMP: rtmp://localhost:1935/live/test
```

#### C. FFmpeg comme receiver (simple)
```bash
# Dans un terminal séparé, recevoir le stream:
ffmpeg -i rtmp://localhost:1935/live/test -c copy -f flv output.flv

# Ou pour visualiser:
ffplay rtmp://localhost:1935/live/test
```

### Option 2 : YouTube Live (Production)

**Avantages** :
- Test avec un vrai service
- Visualisation publique possible

**Inconvénients** :
- Nécessite un compte YouTube
- Nécessite une clé de stream (stream key)
- Limite de bande passante

**Setup** :
1. Aller sur https://studio.youtube.com
2. Créer un événement en direct
3. Copier la "Stream Key"
4. URL RTMP: `rtmp://a.rtmp.youtube.com/live2/VOTRE_STREAM_KEY`

### Option 3 : Twitch (Production)

**Avantages** :
- Test avec un vrai service
- Visualisation publique possible

**Inconvénients** :
- Nécessite un compte Twitch
- Nécessite une clé de stream
- Limite de bande passante

**Setup** :
1. Aller sur https://dashboard.twitch.tv/settings/stream
2. Copier la "Primary Stream Key"
3. URL RTMP: `rtmp://live.twitch.tv/app/VOTRE_STREAM_KEY`

### Option 4 : Service de test RTMP (Gratuit)

**Solutions** :
- **Restream.io** : Service gratuit pour tester
- **Streamlabs** : Service gratuit avec dashboard
- **OBS Ninja** : Service gratuit pour tests

## Test avec le code JavaScript

### Exemple de test basique

```javascript
const nativeModule = require('./index.js');

// Initialiser COM en STA mode (comme Electron)
if (nativeModule.initializeCOMInSTAMode) {
    nativeModule.initializeCOMInSTAMode();
}

const VideoAudioStreamer = nativeModule.VideoAudioStreamer;
const streamer = new VideoAudioStreamer();

// Option 1: Serveur RTMP local
const rtmpUrl = 'rtmp://localhost:1935/live/test';

// Option 2: YouTube Live
// const rtmpUrl = 'rtmp://a.rtmp.youtube.com/live2/VOTRE_STREAM_KEY';

// Option 3: Twitch
// const rtmpUrl = 'rtmp://live.twitch.tv/app/VOTRE_STREAM_KEY';

// Initialiser
streamer.initialize(rtmpUrl, 30, 5000000, true, 192000, 'both');

// Démarrer
streamer.start();

// Monitorer les stats
setInterval(() => {
    const stats = streamer.getStatistics();
    const isConnected = streamer.isConnected();
    const isBackpressure = streamer.isBackpressure();
    
    console.log(`Connected: ${isConnected}, Backpressure: ${isBackpressure}`);
    console.log(`Video: ${stats.videoPackets} packets, ${stats.videoPacketsDropped} dropped`);
    console.log(`Audio: ${stats.audioPackets} packets, ${stats.audioPacketsDropped} dropped`);
    console.log(`Buffer: ${stats.bufferSize} packets, ${stats.bufferLatencyMs}ms`);
}, 2000);

// Arrêter après 30 secondes
setTimeout(() => {
    streamer.stop();
    console.log('Stream stopped');
}, 30000);
```

## Test dans all_tests.js

Décommenter la section 6 dans `all_tests.js` :

```javascript
// ============================================================================
// SECTION 6: test_video_audio_streamer.js (ACTIVE)
// ============================================================================
async function testVideoAudioStreamer() {
    // ... code du test ...
}

testVideoAudioStreamer().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});
```

Puis exécuter :
```bash
cd native-audio
node all_tests.js
```

## Vérification du stream

### Avec FFmpeg
```bash
# Recevoir le stream
ffmpeg -i rtmp://localhost:1935/live/test -c copy -f flv output.flv

# Ou visualiser en direct
ffplay rtmp://localhost:1935/live/test
```

### Avec VLC
1. Ouvrir VLC
2. Media → Open Network Stream
3. URL: `rtmp://localhost:1935/live/test`
4. Play

### Avec OBS Studio
1. Ouvrir OBS Studio
2. Settings → Stream
3. Service: Custom
4. Server: `rtmp://localhost:1935/live`
5. Stream Key: `test`
6. Start Streaming (pour recevoir)

## Dépannage

### Erreur: "Failed to open RTMP connection"
- Vérifier que le serveur RTMP est démarré
- Vérifier l'URL RTMP (format: `rtmp://host:port/app/stream_key`)
- Vérifier le firewall (port 1935)

### Erreur: "Connection lost"
- Vérifier la connexion réseau
- Vérifier que le serveur RTMP est toujours actif
- Le ReconnectThread devrait automatiquement reconnecter

### Backpressure détecté
- Normal si le réseau est lent
- Les packets vidéo seront droppés, audio continuera
- Vérifier les stats: `videoPacketsDropped` devrait augmenter

### Pas de vidéo/audio
- Vérifier que les engines sont démarrés (`isRunning()`)
- Vérifier les stats: `videoPackets` et `audioPackets` devraient augmenter
- Vérifier les logs stderr pour les erreurs FFmpeg

## Recommandation

**Pour le développement** : Utiliser un serveur RTMP local (nginx-rtmp ou SRS)
**Pour la production** : Utiliser YouTube Live ou Twitch avec les vraies credentials




# Architecture de Streaming avec Backpressure & Reconnect

## 🧠 Schéma d'implémentation basé sur notre code C++

```
                         ┌──────────────────────┐
                         │  MONOTONIC CLOCK     │
                         │  (std::chrono)       │
                         │  m_startTime         │
                         └─────────┬────────────┘
                                   │
        ┌──────────────────────────┴──────────────────────────┐
        │                                                      │
        ▼                                                      ▼

┌──────────────────────┐                           ┌──────────────────────┐
│  AudioEngine         │                           │  CaptureThread       │
│  (CLOCK MASTER)      │                           │  (CFR)               │
│  - AudioTickThread() │                           │  - frameIntervalNs   │
│  - expected_frames(t)│                           │  - expectedFrame     │
│  - silence if missing│                           │  - duplicate frames  │
└─────────┬────────────┘                           └─────────┬────────────┘
          │                                                    │
          ▼                                                    ▼

┌──────────────────────┐                           ┌──────────────────────┐
│  AudioEncoder        │                           │  VideoEncoder        │
│  (AAC)               │                           │  (x264/NVENC)       │
│  - EncodeFrame()     │                           │  - EncodeFrame()     │
└─────────┬────────────┘                           └─────────┬────────────┘
          │                                                    │
          └──────────────┬──────────────────────┬────────────┘
                         ▼                      ▼

                 ┌────────────────────────────────────┐
                 │  StreamMuxer                       │
                 │  - WriteVideoPacket()              │
                 │  - WriteAudioPacket()             │
                 │  - av_interleaved_write_frame()   │
                 │  - NO timing logic                 │
                 │  - NO sync logic                   │
                 └───────────────┬────────────────────┘
                                 │
                                 ▼

                 ┌────────────────────────────────────┐
                 │  OUTPUT BUFFER (NEW)               │
                 │  StreamBuffer class                │
                 │  - queue<AVPacket*>                │
                 │  - maxSize (packets)               │
                 │  - currentLatency (ms)             │
                 │  - measureQueueTime()             │
                 └───────────────┬────────────────────┘
                                 │
                buffer full?     │
             ┌───────────────────┴───────────────────┐
             │                                       │
             ▼                                       ▼

┌──────────────────────────────┐        ┌──────────────────────────────┐
│  NETWORK SEND (FFmpeg RTMP)   │        │  BACKPRESSURE DETECTED        │
│  - av_interleaved_write_frame │        │  - buffer.size() > threshold │
│  - socket write               │        │  - latency > maxLatency      │
└──────────────┬───────────────┘        └──────────────┬───────────────┘
               │                                       │
               ▼                                       ▼

     STREAM OK (LIVE)                     DROP POLICY
                                           - drop VIDEO packets
                                           - keep AUDIO packets
                                           - NEVER block engines
                                           - m_dropVideoPackets = true

                                 │
                                 ▼

                     ┌──────────────────────────┐
                     │  CONNECTION STATUS        │
                     │  - m_isConnected          │
                     │  - checkRtmpConnection()  │
                     └──────────────┬───────────┘
                                    │ disconnected
                                    ▼

                     ┌──────────────────────────┐
                     │  RECONNECT LOOP           │
                     │  - keep engines running   │
                     │  - drop all packets       │
                     │  - retryRtmpConnection()  │
                     │  - exponential backoff     │
                     └──────────────┬───────────┘
                                    │ success
                                    ▼

                     ┌──────────────────────────┐
                     │  STREAM RESUMED           │
                     │  - clear buffer            │
                     │  - m_dropVideoPackets=false│
                     │  - resume at NOW          │
                     └──────────────────────────┘
```

## 🔧 Composants à créer/modifier

### 1. StreamBuffer (nouveau)
```cpp
class StreamBuffer {
    std::queue<AVPacket*> m_packets;
    size_t m_maxSize;
    std::chrono::high_resolution_clock::time_point m_firstPacketTime;
    
    bool CanAcceptPacket();
    void AddPacket(AVPacket* packet);
    AVPacket* GetNextPacket();
    int64_t GetCurrentLatencyMs();
    void Clear();
};
```

### 2. StreamMuxer (modifier)
- Ajouter détection de backpressure
- Ajouter drop policy
- Ajouter gestion de buffer

### 3. VideoAudioStreamerAddon (nouveau wrapper N-API)
- Similaire à VideoAudioRecorderAddon
- Utilise StreamMuxer au lieu de VideoMuxer
- Gère reconnect loop
- Gère backpressure

## 📋 Flux de données

### Normal flow:
1. AudioEngine produit frames → AudioEncoder → StreamMuxer → StreamBuffer → Network
2. CaptureThread produit frames → VideoEncoder → StreamMuxer → StreamBuffer → Network

### Backpressure flow:
1. StreamBuffer détecte buffer plein (latency > threshold)
2. Active `m_dropVideoPackets = true`
3. StreamMuxer::WriteVideoPacket() retourne false immédiatement (drop)
4. StreamMuxer::WriteAudioPacket() continue normalement
5. Quand buffer se vide, `m_dropVideoPackets = false`

### Reconnect flow:
1. Détection: `av_interleaved_write_frame()` retourne erreur réseau
2. Marquer `m_isConnected = false`
3. Engines continuent (AudioEngine + CaptureThread)
4. Tous les packets sont droppés (pas ajoutés au buffer)
5. Reconnect thread essaie de reconnecter avec backoff exponentiel
6. Succès → `m_isConnected = true`, clear buffer, reprendre streaming

## 🎯 Points clés

1. **Engines jamais bloqués**: AudioEngine et CaptureThread continuent toujours
2. **Mux passif**: StreamMuxer ne fait que muxer, pas de timing
3. **Buffer limité**: StreamBuffer a une taille max (ex: 100 packets)
4. **Drop vidéo**: En cas de backpressure, drop vidéo, garder audio
5. **Reconnect transparent**: Les engines ne savent pas qu'on reconnecte
6. **Clock continue**: Le temps ne s'arrête jamais




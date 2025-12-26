# 🧠 Schéma d'implémentation Streaming - Notre Architecture C++

## Architecture actuelle vs Architecture avec streaming

### ✅ Ce qu'on a déjà (réutilisable à 100%)

```
┌──────────────────────┐
│  AudioEngine         │  ✅ Clock master (GetMonotonicTimeMs)
│  - Tick()            │  ✅ expected_frames(t)
│  - silence if missing│  ✅ Jamais bloqué
└─────────┬────────────┘
          │
          ▼
┌──────────────────────┐
│  AudioEncoder        │  ✅ Encode AAC
│  - EncodeFrame()     │  ✅ BYTES ONLY
└─────────┬────────────┘
          │
          ▼
┌──────────────────────┐
│  CaptureThread       │  ✅ CFR (frameIntervalNs)
│  - expectedFrame     │  ✅ Duplicate frames
│  - Jamais bloqué     │
└─────────┬────────────┘
          │
          ▼
┌──────────────────────┐
│  VideoEncoder        │  ✅ Encode H.264
│  - EncodeFrame()     │  ✅ BYTES ONLY
└──────────────────────┘
```

### 🔧 Ce qu'on doit ajouter/modifier

```
┌─────────────────────────────────────────────────────────────┐
│  StreamMuxer (MODIFIER)                                     │
│  ✅ Déjà créé                                                │
│  🔧 Ajouter:                                                 │
│     - bool m_dropVideoPackets                                │
│     - bool m_isConnected                                     │
│     - StreamBuffer* m_buffer                                 │
│     - bool CheckBackpressure()                               │
│     - bool CheckRtmpConnection()                             │
│     - bool ReconnectRtmp()                                   │
└─────────┬────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│  StreamBuffer (NOUVEAU)                                     │
│  - queue<AVPacket*> m_packets                               │
│  - mutex m_mutex                                             │
│  - size_t m_maxSize = 100                                    │
│  - int64_t m_maxLatencyMs = 2000                             │
│  - CanAcceptPacket() → false si buffer plein                │
│  - GetCurrentLatencyMs()                                     │
└─────────┬────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│  NetworkSendThread (NOUVEAU thread)                         │
│  - Dequeue packets du StreamBuffer                           │
│  - av_interleaved_write_frame()                             │
│  - Détecte erreurs réseau → trigger reconnect                │
└─────────┬────────────────────────────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────────────────────────┐
│  ReconnectThread (NOUVEAU thread)                            │
│  - Loop de reconnect avec backoff exponentiel                │
│  - Drop all packets pendant reconnect                        │
│  - Clear buffer au succès                                    │
└─────────────────────────────────────────────────────────────┘
```

## 🔄 Flux complet avec backpressure

```
┌──────────────────────────────────────────────────────────────┐
│  ÉTAPE 1: Engines produisent (jamais bloqués)               │
└──────────────────────────────────────────────────────────────┘
         │
         ├─ AudioEngine::Tick() → AudioEncoder → StreamMuxer
         └─ CaptureThread → VideoEncoder → StreamMuxer
         
┌──────────────────────────────────────────────────────────────┐
│  ÉTAPE 2: StreamMuxer reçoit packets                         │
└──────────────────────────────────────────────────────────────┘
         │
         ├─ WriteAudioPacket()
         │   └─→ Toujours ajouté au buffer ✅
         │
         └─ WriteVideoPacket()
             ├─ Check: m_dropVideoPackets == true?
             │   ├─ YES → return false (drop) ❌
             │   └─ NO → Ajouter au buffer ✅
             │
             └─ Check: m_isConnected == false?
                 └─ YES → return false (drop) ❌

┌──────────────────────────────────────────────────────────────┐
│  ÉTAPE 3: StreamBuffer gère la queue                         │
└──────────────────────────────────────────────────────────────┘
         │
         ├─ AddPacket()
         │   ├─ Check: buffer.size() > maxSize?
         │   │   └─ YES → Set m_dropVideoPackets = true
         │   │
         │   ├─ Check: latency > maxLatencyMs?
         │   │   └─ YES → Set m_dropVideoPackets = true
         │   │
         │   └─ Add packet to queue ✅
         │
         └─ GetCurrentLatencyMs()
             └─ Calcul: (now - firstPacketTime)

┌──────────────────────────────────────────────────────────────┐
│  ÉTAPE 4: NetworkSendThread envoie                           │
└──────────────────────────────────────────────────────────────┘
         │
         ├─ Loop:
         │   ├─ Dequeue packet from StreamBuffer
         │   ├─ av_interleaved_write_frame()
         │   │   ├─ Success → Continue ✅
         │   │   └─ Error → Set m_isConnected = false
         │   │
         │   └─ Check: buffer.size() < threshold?
         │       └─ YES → Set m_dropVideoPackets = false
         │
         └─ Si m_isConnected == false:
             └─ Signal ReconnectThread

┌──────────────────────────────────────────────────────────────┐
│  ÉTAPE 5: ReconnectThread (si nécessaire)                    │
└──────────────────────────────────────────────────────────────┘
         │
         ├─ Set m_dropAllPackets = true
         ├─ Loop avec backoff exponentiel:
         │   ├─ Try StreamMuxer::ReconnectRtmp()
         │   ├─ Success → Set m_isConnected = true
         │   │   ├─ Clear StreamBuffer
         │   │   ├─ Set m_dropAllPackets = false
         │   │   └─ Resume streaming at NOW
         │   │
         │   └─ Failure → Wait (exponential backoff)
         │
         └─ Engines continuent pendant reconnect ✅
```

## 🎯 Modifications concrètes dans StreamMuxer

### Dans `stream_muxer.h`:
```cpp
class StreamMuxer {
private:
    // ... existing members ...
    
    // NEW: Backpressure & Reconnect
    bool m_dropVideoPackets;      // Drop vidéo si backpressure
    bool m_isConnected;            // État connexion RTMP
    bool m_dropAllPackets;         // Drop tout pendant reconnect
    StreamBuffer* m_buffer;        // Buffer pour packets (optionnel)
    
    // NEW: Methods
    bool CheckBackpressure();
    bool CheckRtmpConnection();
    bool ReconnectRtmp();
};
```

### Dans `stream_muxer.cpp`:
```cpp
bool StreamMuxer::WriteVideoPacket(...) {
    // NEW: Check drop flags
    if (m_dropVideoPackets || m_dropAllPackets || !m_isConnected) {
        return false;  // Drop packet
    }
    
    // ... existing code ...
    
    // NEW: Check backpressure after adding to buffer
    if (m_buffer && CheckBackpressure()) {
        m_dropVideoPackets = true;
    }
    
    // ... rest of existing code ...
}

bool StreamMuxer::WriteAudioPacket(...) {
    // NEW: Check drop all flag (mais jamais drop audio seul)
    if (m_dropAllPackets || !m_isConnected) {
        return false;
    }
    
    // ... existing code (always succeeds if connected) ...
}
```

## 📝 Nouveau fichier: StreamBuffer

### `stream_buffer.h`:
```cpp
#ifndef STREAM_BUFFER_H
#define STREAM_BUFFER_H

#include <queue>
#include <mutex>
#include <chrono>
#include <cstdint>

extern "C" {
#include <libavformat/avformat.h>
}

class StreamBuffer {
public:
    StreamBuffer(size_t maxSize = 100, int64_t maxLatencyMs = 2000);
    ~StreamBuffer();
    
    bool CanAcceptPacket();
    bool AddPacket(AVPacket* packet);  // Returns false if dropped
    AVPacket* GetNextPacket();  // Returns nullptr if empty
    int64_t GetCurrentLatencyMs();
    size_t GetSize();
    void Clear();
    
private:
    std::queue<AVPacket*> m_packets;
    std::mutex m_mutex;
    size_t m_maxSize;
    int64_t m_maxLatencyMs;
    std::chrono::high_resolution_clock::time_point m_firstPacketTime;
};

#endif
```

## 🧩 Nouveau wrapper: VideoAudioStreamerAddon

### Basé sur `wasapi_video_audio_recorder.cpp` mais:
- Utilise `StreamMuxer` au lieu de `VideoMuxer`
- Ajoute `NetworkSendThread`
- Ajoute `ReconnectThread`
- Même structure que `VideoAudioRecorderAddon`

### Threads dans VideoAudioStreamerAddon:
1. ✅ `CaptureThread` - réutilisé tel quel
2. ✅ `AudioTickThread` - réutilisé tel quel
3. 🔧 `NetworkSendThread` - NOUVEAU
4. 🔧 `ReconnectThread` - NOUVEAU

## 🔑 Règles d'or (OBS-style)

1. **Engines jamais bloqués**: AudioEngine et CaptureThread continuent toujours
2. **Mux passif**: StreamMuxer muxe, pas de timing
3. **Buffer limité**: StreamBuffer a une taille max
4. **Drop vidéo**: En cas de backpressure, drop vidéo, garder audio
5. **Reconnect transparent**: Engines ne savent pas qu'on reconnecte
6. **Clock continue**: Le temps ne s'arrête jamais
7. **Pas de backlog**: Après reconnect, on repart au présent




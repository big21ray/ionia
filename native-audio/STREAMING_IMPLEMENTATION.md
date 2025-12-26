# 🧠 Schéma d'implémentation Streaming avec Backpressure & Reconnect
## Basé sur notre architecture C++ existante

```
                         ┌──────────────────────┐
                         │  MONOTONIC CLOCK     │
                         │  std::chrono         │
                         │  m_startTime         │
                         │  (déjà existant)     │
                         └─────────┬────────────┘
                                   │
        ┌──────────────────────────┴──────────────────────────┐
        │                                                      │
        ▼                                                      ▼

┌──────────────────────┐                           ┌──────────────────────┐
│  AudioEngine         │                           │  CaptureThread       │
│  (CLOCK MASTER)      │                           │  (CFR)               │
│  ✅ Déjà implémenté  │                           │  ✅ Déjà implémenté  │
│  - Tick()            │                           │  - frameIntervalNs   │
│  - expected_frames(t)│                           │  - expectedFrame     │
│  - silence if missing│                           │  - duplicate frames  │
└─────────┬────────────┘                           └─────────┬────────────┘
          │                                                    │
          ▼                                                    ▼

┌──────────────────────┐                           ┌──────────────────────┐
│  AudioEncoder        │                           │  VideoEncoder        │
│  ✅ Déjà implémenté  │                           │  ✅ Déjà implémenté  │
│  - EncodeFrame()     │                           │  - EncodeFrame()     │
└─────────┬────────────┘                           └─────────┬────────────┘
          │                                                    │
          └──────────────┬──────────────────────┬────────────┘
                         ▼                      ▼

                 ┌────────────────────────────────────┐
                 │  StreamMuxer                       │
                 │  ✅ Déjà créé                       │
                 │  - WriteVideoPacket()              │
                 │  - WriteAudioPacket()              │
                 │  - av_interleaved_write_frame()   │
                 │  🔧 À MODIFIER:                    │
                 │     + backpressure detection       │
                 │     + drop policy                  │
                 └───────────────┬────────────────────┘
                                 │
                                 ▼

                 ┌────────────────────────────────────┐
                 │  StreamBuffer (NOUVEAU)            │
                 │  class StreamBuffer                │
                 │  - queue<AVPacket*>               │
                 │  - maxSize (ex: 100 packets)       │
                 │  - currentLatency (ms)             │
                 │  - CanAcceptPacket()               │
                 │  - GetCurrentLatencyMs()           │
                 └───────────────┬────────────────────┘
                                 │
                buffer full?     │
             ┌───────────────────┴───────────────────┐
             │                                       │
             ▼                                       ▼

┌──────────────────────────────┐        ┌──────────────────────────────┐
│  NetworkSendThread (NOUVEAU)  │        │  BACKPRESSURE DETECTED        │
│  - Dequeue packets            │        │  - buffer.size() > threshold │
│  - av_interleaved_write_frame │        │  - latency > maxLatency      │
│  - Check connection status    │        │  - Set m_dropVideoPackets=true│
└──────────────┬───────────────┘        └──────────────┬───────────────┘
               │                                       │
               ▼                                       ▼

     STREAM OK (LIVE)                     DROP POLICY
                                           StreamMuxer::WriteVideoPacket()
                                           → return false (drop)
                                           StreamMuxer::WriteAudioPacket()
                                           → continue (keep)

                                 │
                                 ▼

                     ┌──────────────────────────┐
                     │  ConnectionMonitor       │
                     │  (NOUVEAU)                │
                     │  - CheckRtmpStatus()      │
                     │  - Detect disconnect      │
                     └──────────────┬───────────┘
                                    │ disconnected
                                    ▼

                     ┌──────────────────────────┐
                     │  ReconnectThread (NOUVEAU)│
                     │  - Keep engines running   │
                     │  - Drop all packets        │
                     │  - RetryRtmpConnection()   │
                     │  - Exponential backoff     │
                     └──────────────┬───────────┘
                                    │ success
                                    ▼

                     ┌──────────────────────────┐
                     │  STREAM RESUMED           │
                     │  - Clear buffer            │
                     │  - m_dropVideoPackets=false│
                     │  - Resume at NOW          │
                     └──────────────────────────┘
```

## 🔧 Composants à créer/modifier

### 1. StreamBuffer (NOUVEAU fichier)
**Fichier**: `native-audio/src/stream_buffer.h` / `.cpp`

```cpp
class StreamBuffer {
private:
    std::queue<AVPacket*> m_packets;
    std::mutex m_mutex;
    size_t m_maxSize;  // Max packets (ex: 100)
    int64_t m_maxLatencyMs;  // Max latency (ex: 2000ms)
    std::chrono::high_resolution_clock::time_point m_firstPacketTime;
    
public:
    bool CanAcceptPacket();
    bool AddPacket(AVPacket* packet);  // Returns false if dropped
    AVPacket* GetNextPacket();  // Returns nullptr if empty
    int64_t GetCurrentLatencyMs();
    size_t GetSize();
    void Clear();
};
```

### 2. StreamMuxer (MODIFIER)
**Fichier**: `native-audio/src/stream_muxer.h` / `.cpp`

**Ajouts**:
- `bool m_dropVideoPackets` - flag pour drop vidéo en cas de backpressure
- `bool m_isConnected` - état de connexion RTMP
- `StreamBuffer* m_buffer` - pointeur vers buffer (optionnel, ou intégré)
- `bool CheckBackpressure()` - détecte si buffer plein
- `bool CheckRtmpConnection()` - vérifie état connexion

**Modifications**:
- `WriteVideoPacket()` - retourne false si `m_dropVideoPackets == true`
- `WriteAudioPacket()` - continue toujours (jamais droppé)

### 3. VideoAudioStreamerAddon (NOUVEAU fichier)
**Fichier**: `native-audio/src/wasapi_video_audio_streamer.cpp`

**Basé sur**: `wasapi_video_audio_recorder.cpp`

**Différences**:
- Utilise `StreamMuxer` au lieu de `VideoMuxer`
- Ajoute `NetworkSendThread` - thread qui envoie packets du buffer
- Ajoute `ReconnectThread` - thread qui gère reconnect
- Ajoute `ConnectionMonitor` - vérifie état connexion

**Threads**:
1. `CaptureThread` - capture vidéo (existant, réutilisé)
2. `AudioTickThread` - tick audio (existant, réutilisé)
3. `NetworkSendThread` - envoie packets réseau (NOUVEAU)
4. `ReconnectThread` - gère reconnect (NOUVEAU)

## 📋 Flux de données détaillé

### Normal Flow (pas de backpressure):
```
AudioEngine::Tick()
  → AudioEncoder::EncodeFrame()
    → StreamMuxer::WriteAudioPacket()
      → StreamBuffer::AddPacket() ✅
        → NetworkSendThread::Dequeue()
          → av_interleaved_write_frame() ✅
            → RTMP socket ✅

CaptureThread
  → VideoEncoder::EncodeFrame()
    → StreamMuxer::WriteVideoPacket()
      → StreamBuffer::AddPacket() ✅
        → NetworkSendThread::Dequeue()
          → av_interleaved_write_frame() ✅
            → RTMP socket ✅
```

### Backpressure Flow:
```
StreamBuffer::AddPacket()
  → Check: buffer.size() > maxSize || latency > maxLatency
    → YES: Set m_dropVideoPackets = true

StreamMuxer::WriteVideoPacket()
  → Check: m_dropVideoPackets == true
    → YES: return false (drop packet) ❌
    → NO: Add to buffer ✅

StreamMuxer::WriteAudioPacket()
  → Always: Add to buffer ✅ (jamais droppé)

NetworkSendThread
  → Dequeue packets
  → Send to RTMP
  → When buffer.size() < threshold: Set m_dropVideoPackets = false
```

### Reconnect Flow:
```
NetworkSendThread
  → av_interleaved_write_frame() returns error
    → Set m_isConnected = false
    → Signal ReconnectThread

ReconnectThread
  → While !m_isConnected:
      → Drop all packets (m_dropAllPackets = true)
      → Try StreamMuxer::ReconnectRtmp()
      → Wait with exponential backoff
  → On success:
      → Set m_isConnected = true
      → Set m_dropAllPackets = false
      → Clear StreamBuffer
      → Resume streaming at NOW (pas de backlog)
```

## 🎯 Points clés d'implémentation

### 1. Engines jamais bloqués
- ✅ AudioEngine::Tick() continue toujours
- ✅ CaptureThread continue toujours
- ✅ Même si buffer plein ou reconnect

### 2. Drop Policy
```cpp
// Dans StreamMuxer::WriteVideoPacket()
if (m_dropVideoPackets) {
    return false;  // Drop vidéo
}

// Dans StreamMuxer::WriteAudioPacket()
// Toujours return true (jamais droppé)
```

### 3. Backpressure Detection
```cpp
// Dans StreamBuffer ou StreamMuxer
bool CheckBackpressure() {
    return (m_buffer->GetSize() > m_maxSize) || 
           (m_buffer->GetCurrentLatencyMs() > m_maxLatencyMs);
}
```

### 4. Reconnect Logic
```cpp
// Dans ReconnectThread
void ReconnectLoop() {
    int retryCount = 0;
    while (!m_isConnected && !m_shouldStop) {
        // Drop all packets
        m_dropAllPackets = true;
        
        // Try reconnect
        if (m_streamMuxer->ReconnectRtmp()) {
            m_isConnected = true;
            m_dropAllPackets = false;
            m_buffer->Clear();
            break;
        }
        
        // Exponential backoff
        int delayMs = std::min(1000 * (1 << retryCount), 30000);
        std::this_thread::sleep_for(std::chrono::milliseconds(delayMs));
        retryCount++;
    }
}
```

### 5. Network Send Thread
```cpp
void NetworkSendThread() {
    while (!m_shouldStop) {
        AVPacket* packet = m_buffer->GetNextPacket();
        if (packet) {
            if (m_isConnected) {
                int ret = av_interleaved_write_frame(m_formatContext, packet);
                if (ret < 0) {
                    // Connection lost
                    m_isConnected = false;
                }
            }
            av_packet_free(&packet);
        } else {
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
}
```

## 🔄 Intégration avec code existant

### Réutilisation:
- ✅ AudioEngine (clock master) - déjà implémenté
- ✅ CaptureThread (CFR) - déjà implémenté
- ✅ VideoEncoder - déjà implémenté
- ✅ AudioEncoder - déjà implémenté
- ✅ StreamMuxer - déjà créé (à modifier)

### Nouveau:
- 🔧 StreamBuffer - buffer limité avec latency tracking
- 🔧 NetworkSendThread - thread d'envoi réseau
- 🔧 ReconnectThread - thread de reconnect
- 🔧 VideoAudioStreamerAddon - wrapper N-API pour streaming

## 📊 Métriques à tracker

- `m_videoPacketsDropped` - packets vidéo droppés
- `m_audioPacketsDropped` - packets audio droppés (devrait être 0)
- `m_reconnectCount` - nombre de reconnects
- `m_currentLatencyMs` - latence actuelle du buffer
- `m_maxLatencyMs` - latence max observée




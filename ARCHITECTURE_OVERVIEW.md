# Ionia: Video/Audio Recorder/Streamer Engine - Architecture Overview

## 🎯 Project Summary
**Ionia** is an Electron-based desktop application with a native C++ recording and streaming engine. It captures desktop video + audio and can:
- **Record** to MP4 files (video + audio synchronized)
- **Stream** to RTMP servers (live streaming)

**Technology Stack:**
- Frontend: React + TypeScript (Electron)
- Backend: C++ (Windows-native)
- Video Capture: DXGI (Desktop Duplication)
- Audio Capture: WASAPI (Windows Audio Session API)
- Encoding: FFmpeg (libavcodec, libavformat)
- Video Codecs: H.264 (NVENC or x264)
- Audio Codec: AAC

---

## 📊 High-Level Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│ CAPTURE LAYER                                                   │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────┐        ┌──────────────────────┐       │
│ │  DesktopDuplication │        │   AudioCapture       │       │
│ │  (DXGI)             │        │   (WASAPI)           │       │
│ │ - GPU frame capture │        │ - Desktop loopback   │       │
│ │ - RGBA32 format     │        │ - Microphone input   │       │
│ │ - Native resolution │        │ - Resampling to 48kHz│       │
│ └─────────┬───────────┘        └──────────┬───────────┘       │
│           │                                 │                    │
└───────────┼─────────────────────────────────┼────────────────────┘
            │                                 │
            ▼                                 ▼
┌─────────────────────────────────────────────────────────────────┐
│ PROCESSING LAYER                                                │
├─────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────┐        ┌──────────────────────┐       │
│ │  VideoEncoder       │        │   AudioEngine        │       │
│ │  (libavcodec)       │        │   (Clock Master)     │       │
│ │ - H.264 encoding    │        │ - Mixes desktop+mic  │       │
│ │ - NVENC or x264     │        │ - OBS-like timing    │       │
│ │ - Keyframes every Ns│        │ - 48kHz, stereo      │       │
│ └─────────┬───────────┘        └──────────┬───────────┘       │
│           │                                 │                    │
│           │                    ┌────────────┴─────────┐          │
│           │                    ▼                       ▼          │
│           │            ┌──────────────────┐  ┌──────────────────┐│
│           │            │ AudioEncoder     │  │ AudioPacket      ││
│           │            │ (libavcodec AAC) │  │ Manager          ││
│           │            └────────┬─────────┘  │ (PTS handling)   ││
│           │                     │            └──────────────────┘│
│           │                     │                                 │
└───────────┼─────────────────────┼─────────────────────────────────┘
            │                     │
            ▼                     ▼
┌─────────────────────────────────────────────────────────────────┐
│ MUXING LAYER                                                    │
├─────────────────────────────────────────────────────────────────┤
│ ┌──────────────────────────────────────────────────────────┐   │
│ │  Muxer (VideoMuxer or StreamMuxer)                       │   │
│ │  - Interleaves video & audio packets                      │   │
│ │  - Sets PTS/DTS for proper sync                          │   │
│ │  - av_interleaved_write_frame()                          │   │
│ └──────────────────┬───────────────────────────────────────┘   │
│                    │                                             │
└────────────────────┼─────────────────────────────────────────────┘
                     │
        ┌────────────┴────────────┐
        ▼                         ▼
   MP4 File                  RTMP Stream
   (Recording)               (Live Stream)
```

---

## 🔌 Component Deep Dive

### 1. **DesktopDuplication** (DXGI Capture)
**File:** [native-audio/src/desktop_duplication.h/cpp](native-audio/src/desktop_duplication.h)

**Purpose:** Captures desktop frames from GPU using DXGI Desktop Duplication API

**Key Features:**
- Captures at native resolution
- Outputs RGBA32 format (32 bits: Red, Green, Blue, Alpha)
- Hardware-accelerated via Direct3D 11
- Low-latency GPU→CPU transfer
- Monotonic timestamps

**How it works:**
```
D3D11Device → IDXGIOutput1 → IDXGIOutputDuplication
  ↓
Acquire Frame (DXGI_OUTDUPL_FRAME_INFO)
  ↓
Convert GPU texture → RGBA32 buffer
  ↓
Copy to system memory
```

**Typical output:** 1920×1080 RGBA at 30 FPS = 248 MB/s data

---

### 2. **AudioCapture** (WASAPI)
**File:** [native-audio/src/audio_capture.h/cpp](native-audio/src/audio_capture.h)

**Purpose:** Captures audio from desktop + microphone using WASAPI

**Key Features:**
- Desktop audio (loopback capture)
- Microphone input
- Dual-thread event-driven capture (not polling)
- Automatic resampling to 48 kHz
- Conversion to float32 stereo
- Support for mixed capture modes: "mic", "desktop", or "both"

**Data Flow:**
```
Desktop Loopback (native format)  →  ConvertToFloat32()  →  Resample(48kHz)  →  AdaptChannels(stereo)
Microphone (native format)        →  ConvertToFloat32()  →  Resample(48kHz)  →  AdaptChannels(stereo)
                                                                    ↓
                                        Callback: FeedAudioData(data, frames, "desktop"/"mic")
```

**Important:** Audio data is **NOT** encoded here, just captured and normalized to:
- Sample rate: 48000 Hz
- Format: float32 (range -1.0 to 1.0)
- Channels: 2 (stereo, interleaved: L0, R0, L1, R1, ...)

---

### 3. **AudioEngine** (Clock Master - OBS-like)
**File:** [native-audio/src/audio_engine.h/cpp](native-audio/src/audio_engine.h)

**Purpose:** Acts as the **timing master** for the entire pipeline. Uses a monotonic clock to maintain sync.

**Key Concepts:**
- **Monotonic Clock:** Uses `QueryPerformanceCounter` (high-resolution Windows timer)
- **Frame Counting:** Tracks frames sent in 48kHz units
- **Non-blocking mixing:** Always produces output, uses silence if data missing

**How AudioEngine works:**

1. **Initialization:**
   ```cpp
   engine.Initialize(callback);  // Register callback
   engine.Start();               // Start monotonic clock (m_startTimeMs = now)
   ```

2. **Feed Audio Data:**
   ```cpp
   AudioCapture → engine.FeedAudioData(data, frames, "desktop");
   AudioCapture → engine.FeedAudioData(data, frames, "mic");
   // Data is buffered (thread-safe with mutex)
   ```

3. **Tick() - Called every ~10ms from JavaScript:**
   ```cpp
   void AudioEngine::Tick() {
       // Calculate elapsed time since start
       currentTime = GetMonotonicTimeMs();
       elapsedMs = currentTime - m_startTimeMs;
       
       // How many frames SHOULD we have sent by now?
       expectedFrames = (elapsedMs * 48000) / 1000;
       
       // How many frames are missing?
       framesToSend = expectedFrames - m_framesSent;
       
       // Clamp to max 100ms per tick
       outputFrames = min(framesToSend, 4800);
       
       // Mix audio from buffers (OBS-like: non-blocking)
       MixAudio(outputFrames, output);
       
       // Create AudioPacket with explicit PTS
       packet = CreatePacket(output, outputFrames, m_framesSent);
       
       // Send to callback (→ AudioEncoder)
       m_callback(packet);
       
       m_framesSent += outputFrames;
   }
   ```

4. **Mixing Logic:**
   ```cpp
   // For each frame: mix desktop + mic
   mixed = desktopSample + (micSample * 1.2);  // 1.2x gain on mic
   
   // Clamp to [-1.0, 1.0] to prevent clipping
   if (mixed > 1.0) mixed = 1.0;
   if (mixed < -1.0) mixed = -1.0;
   
   // If one source missing, use silence (0.0) for that source
   ```

**Why this design?**
- OBS uses a "clock master" approach to ensure smooth, artifact-free streaming
- Never blocks waiting for audio (always produces output)
- Handles underruns gracefully (produces silence)
- PTS stays synchronized with real time

---

### 4. **VideoEncoder** (libavcodec - H.264)
**File:** [native-audio/src/video_encoder.h/cpp](native-audio/src/video_encoder.h)

**Purpose:** Encodes raw RGBA frames to H.264 bitstream

**Key Features:**
- Supports NVENC (NVIDIA GPU acceleration) or x264 (CPU software)
- Keyframes inserted every N frames
- Outputs bitstream only (NO timestamps - muxer adds them)
- Thread-safe

**How it works:**
```cpp
// Initialize
encoder.Initialize(1920, 1080, 30, 5000000, useNvenc=true);

// Encode frame
std::vector<EncodedPacket> packets = encoder.EncodeFrame(rgba_buffer);

// Each packet is just raw bytes - NO PTS/DTS
// The muxer is responsible for adding timestamps!
```

**Important Design:**
- VideoEncoder does NOT handle timing
- DesktopDuplication provides raw frames
- CaptureThread duplicates frames to match 30 FPS output (CFR = Constant Frame Rate)
- Muxer assigns PTS based on frame count

---

### 5. **AudioEncoder** (libavcodec - AAC)
**File:** [native-audio/src/audio_encoder.h/cpp](native-audio/src/audio_encoder.h)

**Purpose:** Encodes float32 PCM audio to AAC bitstream

**Data Format Conversion:**
```
AudioEngine output (interleaved):  [L0, R0, L1, R1, L2, R2, ...]
                    ↓
AudioEncoder converts to planar:  [L0, L1, L2, ...] and [R0, R1, R2, ...]
                    ↓
AAC encoder frame (1024 samples)
                    ↓
Encoded AAC packet (raw bytes)
```

**Important:** Like VideoEncoder, AudioEncoder outputs bytes only - no timestamps.

---

### 6. **Muxers** (libavformat)

#### **VideoMuxer** (MP4 File Output)
**File:** [native-audio/src/video_muxer.h/cpp](native-audio/src/video_muxer.h)

Combines video + audio into MP4 file with proper timestamping.

#### **StreamMuxer** (RTMP Stream Output)
**File:** [native-audio/src/stream_muxer.h/cpp](native-audio/src/stream_muxer.h)

Combines video + audio for RTMP streaming. Adds:
- Backpressure detection (buffer full → drop video frames)
- RTMP connection status
- Reconnect logic

**Muxing process:**
```cpp
// Video packet
muxer.WriteVideoPacket(encoded_bytes, frameIndex);
  ↓
// Create AVPacket with PTS = frameIndex
// Rescale PTS to stream time_base
// av_interleaved_write_frame() → socket or file
  
// Audio packet
muxer.WriteAudioPacket(encoded_bytes, ptsFrames);
  ↓
// Create AVPacket with PTS
// av_interleaved_write_frame() → socket or file
```

**Key Formula:**
```cpp
// PTS = Presentation Time Stamp (when to display the frame)
pts = frameIndex;  // For video: frame numbers
pts = sampleIndex / 48000;  // For audio: in seconds

// Then av_interleaved_write_frame() handles interleaving and actual writing
```

---

## 🎬 Recording Flow (VideoAudioRecorder)
**File:** [native-audio/src/wasapi_video_audio_recorder.cpp](native-audio/src/wasapi_video_audio_recorder.cpp)

### Thread Organization:
```
JavaScript (Electron)
  ↓
  ├─ Thread 1: CaptureThread (Desktop Video)
  │   DesktopDuplication → VideoEncoder → VideoMuxer
  │
  ├─ Thread 2: AudioCaptureThread (Desktop + Mic)
  │   AudioCapture → WASAPI callbacks
  │
  ├─ Thread 3: AudioTickThread (10ms timer)
  │   AudioEngine.Tick() → AudioEncoder → VideoMuxer
  │
  └─ Main: JavaScript Initialization & Control
      Start/Stop/GetStats
```

### Execution Flow:

1. **Initialize:**
   ```cpp
   recorder.Initialize(outputPath, fps=30, videoBitrate, useNvenc, audioBitrate, audioMode="both");
   
   // Creates:
   // - DesktopDuplication (DXGI)
   // - AudioCapture (WASAPI)
   // - VideoEncoder (H.264)
   // - AudioEngine (clock master)
   // - AudioEncoder (AAC)
   // - VideoMuxer (MP4)
   ```

2. **Start:**
   ```cpp
   recorder.Start();
   
   // Starts threads:
   // - CaptureThread (runs in loop, captures frames)
   // - AudioTickThread (10ms timer, calls AudioEngine::Tick())
   // - AudioCapture (WASAPI event-driven)
   ```

3. **CaptureThread Loop:**
   ```cpp
   while (running) {
       // Capture frame from DXGI
       DesktopDuplication.CaptureFrame(rgba_buffer);
       
       // Duplicate frame if necessary (match target FPS)
       if (frame_time >= expected_frame_time) {
           // Encode frame
           packets = VideoEncoder.EncodeFrame(rgba_buffer);
           
           // Write to muxer
           for (packet in packets) {
               VideoMuxer.WriteVideoPacket(packet, frameIndex);
           }
           
           m_frameNumber++;
       }
       
       // Limit to ~30 FPS
       sleep(~33ms);
   }
   ```

4. **AudioTickThread Loop:**
   ```cpp
   while (running) {
       // Every 10ms
       sleep(10ms);
       
       // AudioEngine calculates expected frames
       AudioEngine.Tick();
       
       // AudioEngine callback:
       // → AudioEncoder.EncodeFrames(pcmData)
       // → VideoMuxer.WriteAudioPacket(encoded_data)
   }
   ```

5. **Stop:**
   ```cpp
   recorder.Stop();
   
   // Stops all threads
   // Flushes encoders (get remaining packets)
   // Finalizes MP4 file
   // Closes all resources
   ```

---

## 🌐 Streaming Flow (VideoAudioStreamer - Planned)
**File:** [native-audio/src/wasapi_video_audio_streamer.cpp](native-audio/src/wasapi_video_audio_streamer.cpp) (not yet implemented, schema in docs)

### New Components:
1. **StreamBuffer:** Queues packets to handle network latency
2. **NetworkSendThread:** Dequeues packets and sends via RTMP
3. **ReconnectThread:** Handles RTMP disconnections

### Backpressure Handling:
```
If StreamBuffer is full (high latency):
  → Set m_dropVideoPackets = true
  → VideoPackets are dropped (bandwidth preserved for audio)
  → AudioPackets are kept (never drop audio)
  
When buffer clears:
  → Set m_dropVideoPackets = false
  → Resume sending video
```

---

## 🔄 Audio/Video Synchronization

### Key Principle: **PTS (Presentation Time Stamp)**

All timing is driven by **frame/sample counts**, not wall-clock time:

**Video PTS:**
```
frameIndex 0 → PTS = 0
frameIndex 1 → PTS = 1 / fps (e.g., 1/30 = 0.033 seconds)
frameIndex N → PTS = N / fps
```

**Audio PTS:**
```
sampleIndex 0 → PTS = 0
sampleIndex 1 → PTS = 1 / 48000 = 20.8 µs
sampleIndex N → PTS = N / 48000
```

**In FFmpeg:**
```cpp
// Video
avPacket->pts = frameIndex;  // Frame number
avPacket->stream->time_base = {1, fps};  // Interpret as frame time

// Audio  
avPacket->pts = sampleIndex;  // Sample number
avPacket->stream->time_base = {1, 48000};  // Interpret as audio time
```

**FFmpeg's av_interleaved_write_frame() then:**
1. Converts both to common time base (e.g., microseconds)
2. Interleaves packets by PTS
3. Ensures A/V sync

---

## 🛠️ Key Implementation Details

### **Monotonic Clock (AudioEngine)**
```cpp
// Uses high-performance counter for smooth, monotonic timing
QueryPerformanceCounter() → converts to milliseconds
// Alternative fallback: GetTickCount64()
```

### **Thread Safety**
```cpp
// Audio buffers protected by mutex
std::lock_guard<std::mutex> lock(m_bufferMutex);
m_desktopBuffer.insert(...);
```

### **Interleaved Audio Format**
```
Input:  [L0, R0, L1, R1, L2, R2, ...]  (48000 Hz, 48000 samples/sec)
         └─frame 0──┘ └─frame 1──┘

For 1 second of stereo audio:
  48000 frames × 2 channels × 4 bytes (float32) = 384 KB
```

### **H.264 Codec Selection**
```cpp
// Electron runs in COM STA mode
// Some codecs require MTA mode

comMode = detect_com_mode();
if (comMode == STA) {
    // h264_mf (Media Foundation) will fail → use libx264
    videoEncoder.Initialize(..., useNvenc=false, comInSTAMode=true);
} else {
    // MTA mode → can use NVENC or x264
    videoEncoder.Initialize(..., useNvenc=true);
}
```

---

## 📊 Data Rates

| Component | Rate | Calculation |
|-----------|------|-------------|
| Video (1920×1080, 30 FPS, RGBA) | 248 MB/s | 1920 × 1080 × 4 bytes × 30 |
| Video (H.264 5 Mbps) | 625 KB/s | 5,000,000 bits / 8 |
| Audio (48 kHz, stereo, float32) | 384 KB/s | 48000 × 2 channels × 4 bytes |
| Audio (AAC 192 kbps) | 24 KB/s | 192,000 bits / 8 |

---

## 🚀 Current Status

### ✅ Implemented
- Desktop video capture (DXGI)
- Desktop + Microphone audio capture (WASAPI)
- Video encoding (H.264 via NVENC/x264)
- Audio encoding (AAC)
- Video + Audio recording to MP4
- Audio synchronization via monotonic clock
- COM mode detection for codec selection

### 🚧 Next Steps
- Streaming to RTMP (StreamMuxer + StreamBuffer)
- Backpressure handling for streaming
- Reconnect logic for dropped connections
- UI improvements (Stream button, settings)

---

## 📚 Files Map

| File | Purpose |
|------|---------|
| [native-audio/src/desktop_duplication.h/cpp](native-audio/src/desktop_duplication.h) | DXGI frame capture |
| [native-audio/src/audio_capture.h/cpp](native-audio/src/audio_capture.h) | WASAPI audio capture |
| [native-audio/src/audio_engine.h/cpp](native-audio/src/audio_engine.h) | Clock master, mixing |
| [native-audio/src/audio_encoder.h/cpp](native-audio/src/audio_encoder.h) | AAC encoding |
| [native-audio/src/video_encoder.h/cpp](native-audio/src/video_encoder.h) | H.264 encoding |
| [native-audio/src/video_muxer.h/cpp](native-audio/src/video_muxer.h) | MP4 file output |
| [native-audio/src/stream_muxer.h/cpp](native-audio/src/stream_muxer.h) | RTMP stream output |
| [native-audio/src/wasapi_video_audio_recorder.cpp](native-audio/src/wasapi_video_audio_recorder.cpp) | Main recorder addon (N-API) |
| [src/App.tsx](src/App.tsx) | React front-end |
| [src/components/RecordingButton.tsx](src/components/RecordingButton.tsx) | Recording UI |
| [src/components/StreamButton.tsx](src/components/StreamButton.tsx) | Streaming UI |

---

## 🎯 Architecture Highlights

1. **OBS-like Clock Master:** AudioEngine uses monotonic clock for smooth A/V sync
2. **Non-blocking design:** Never waits for audio (produces silence if missing)
3. **GPU-accelerated:** DXGI for video, NVENC for encoding
4. **FFmpeg-based:** libavcodec + libavformat for encoding/muxing
5. **Thread-safe:** Mutex-protected buffers, atomic flags
6. **Platform-specific:** Windows-only (DXGI, WASAPI, COM)

This architecture is production-ready for recording and designed for streaming with backpressure handling.

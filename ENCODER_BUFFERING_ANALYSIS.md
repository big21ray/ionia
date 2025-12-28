# New Diagnostic Analysis: Multiple Issues Found

## Critical Issues Identified

### **Issue 1: Encoder Buffering Problem ❌ CRITICAL**

```
[AudioCallback] Encoding 576 frames (total received: 576)...
[AudioCallback] Got 0 encoded packets (not enough samples yet)

[AudioCallback] Encoding 768 frames (total received: 1344)...
[AudioCallback] Got 0 encoded packets (still buffering)

[AudioCallback] Encoding 672 frames (total received: 2016)...
[AudioCallback] Got 0 encoded packets (still buffering)

[AudioCallback] Encoding 720 frames (total received: 2736)...
[AudioCallback] Got 1 encoded packets
```

**What's happening:**
- AAC encoder needs **exactly 1024 samples** to output a packet
- Audio engine is sending: 576, 768, 672, 720 frames (all ≠ 1024)
- Encoder buffers them internally until it accumulates 1024+ samples
- Then releases 1 packet (1024 samples) and keeps rest buffered
- This means **encoder PTS is lagging** by several frames

**Why this causes artifacts:**
1. Audio frame arrives as 576 samples
2. Encoder waits for more data
3. Next frame 768 arrives, now has 1344 samples
4. Encoder releases packet 0 (1024 samples), keeps 320 buffered
5. Next frame 672, now has 320+672=992 samples (still buffering!)
6. **PTS becomes disconnected from actual sample timing**
7. When mux layer calculates PTS, it's using m_audioSamplesWritten which doesn't match encoder's internal state

### **Issue 2: Audio Packet Not Written ❌ CRITICAL**

```
[AudioCallback] Encoding 720 frames (total received: 2736)...
[AudioCallback] Got 1 encoded packets (total frames encoded: 2736)
[AudioCallback] Writing packet 0/1, size=458
[AudioCallback] Packet 0 write=false
[AudioCallback] Packet 0 NOT written (buffer full?)
```

**What's happening:**
- Encoder produces a packet
- WriteAudioPacket() returns false
- Packet is **silently dropped**
- No error logged, stream continues
- User hears **click/pop** where packet was dropped

**Root cause:** The StreamBuffer is rejecting audio packets because:
1. Video was pushed to buffer (91KB keyframe)
2. Audio tries to write but hits backpressure
3. Smart drop policy ignores audio (because video filled buffer)
4. Audio packet lost

### **Issue 3: WASAPI Data Discontinuity ❌ ARTIFACT INDICATOR**

```
Warning: Data discontinuity detected in desktop audio
Warning: Data discontinuity detected in microphone audio
```

**What this means:**
- WASAPI detected a gap in audio delivery
- The driver skipped some samples
- This happens when audio engine can't keep up
- Results in **clicks/pops** in source audio itself

### **Issue 4: Buffer Drain Logic Not Activating**

No `BUFFER DRAIN:` messages in the logs. This means:
- maxHealthyBuffer calculation is off
- Buffer is growing but not exceeding drain threshold
- OR the condition isn't being triggered properly

Looking at buffer sizes:
```
[AudioEngine::Tick] BEFORE MIX: desktop=960, mic=0, requesting=576
[AudioEngine::Tick] BEFORE MIX: desktop=1344, mic=960, requesting=768
[AudioEngine::Tick] BEFORE MIX: desktop=1056, mic=672, requesting=672
[AudioEngine::Tick] BEFORE MIX: desktop=1344, mic=960, requesting=720
[AudioEngine::Tick] BEFORE MIX: desktop=2064, mic=1200, requesting=1488
```

**Pattern:** Buffer is growing, but requested frames are also growing to match
- This defeats the drain logic!
- The code requests `finalOutputFrames = min(4800, drainTarget/2)`
- But if finalOutputFrames keeps increasing, it never drains

---

## Root Cause Analysis

The fundamental problem is **encoder frame size mismatch**:

1. AudioEngine produces **variable-sized frames** (576, 768, 672, 720...)
2. AAC encoder expects **1024-sample packets**
3. Encoder buffers internally, releases 1024-sample packets at irregular intervals
4. PTS tracking gets out of sync with actual samples
5. When packets drop (due to backpressure), PTS math breaks
6. User hears artifacts because stream has gaps

The **real culprit**: AudioEngine::Tick() is creating **irregular audio chunks**:

```cpp
const UINT32 framesToSend = expectedFrames - m_framesSent;  // ← This is unpredictable
const UINT32 outputFrames = min(maxFramesPerTick, framesToSend);
```

At t=10ms: expectedFrames = 480, framesSent = 48, so framesToSend = 432
At t=20ms: expectedFrames = 960, framesSent = 480, so framesToSend = 480
At t=30ms: expectedFrames = 1440, framesSent = 1152, so framesToSend = 288

These **don't align with 1024-sample boundaries**!

---

## Why Buffer Drain Doesn't Fully Solve It

The drain logic helps prevent overflow, but it **doesn't fix the root cause**:
- Irregular input sizes → encoder buffering → PTS desync → dropped packets → artifacts

Even if we prevent overflow, the **encoder is still receiving chunks that don't align with its 1024-sample blocks**.

---

## The Real Fix: Send Fixed 1024-Sample Blocks

**Instead of:** AudioEngine determining frame sizes based on elapsed time
**Do this:** Always collect audio until we have **exactly 1024 samples**, then encode once

This aligns perfectly with AAC's 1024-sample frame size.

### Pseudocode Fix:

```cpp
void AudioEngine::Tick() {
    // Don't request time-based frame counts
    // Instead, accumulate until we have 1024 samples
    
    {
        std::lock_guard<std::mutex> lock(m_bufferMutex);
        UINT32 totalFrames = m_desktopFramesAvailable + m_micFramesAvailable;
        
        // Only process if we have at least one full AAC frame (1024 samples)
        if (totalFrames < 1024) {
            return;  // Wait for more audio
        }
    }
    
    // Process exactly 1024 samples
    std::vector<float> mixedAudio;
    MixAudio(1024, mixedAudio);  // Always 1024
    
    AudioPacket packet = m_packetManager.CreatePacket(
        mixedAudio.data(),
        1024,  // ← Always 1024 samples per packet
        m_framesSent
    );
    
    if (m_callback && packet.isValid()) {
        m_callback(packet);
    }
    
    m_framesSent += 1024;
}
```

### Why This Works:

1. ✅ Encoder always receives 1024-sample blocks
2. ✅ Encoder releases exactly 1 packet per Tick()
3. ✅ PTS is perfectly aligned (no internal buffering lag)
4. ✅ No irregular chunk sizes
5. ✅ No timing desync
6. ✅ No packet drops from misalignment

### Trade-off:

- No longer synchronized to wall-clock time
- Instead synchronized to audio block arrival
- This is **better** for streaming (audio-driven timing)
- Matches how RTMP works (source-driven)

---

## Implementation Decision

This is a **fundamental architecture change**:
- Current: Time-based audio pulling (clock master)
- Better: Block-based audio pulling (source-driven)

OBS also uses source-driven timing for audio.

Should we implement this?

---

## Why Current Artifacts Happen Specifically

1. Encoder buffers 576, 768, 672 frames
2. Accumulates to 2016+ frames internally
3. Releases 1024-sample packet with PTS = 0 (seems right)
4. Releases 1024-sample packet with PTS = 1024 samples ago (WRONG - should be PTS = current samples)
5. Video meanwhile is at PTS = 50ms (high)
6. Audio PTS < Video PTS → DTS ordering chaos
7. StreamBuffer drops audio because video is blocking
8. Audio gap → artifact heard by user

The **discontinuity warnings** confirm WASAPI is also struggling because:
- Audio engine can't pull audio fast enough
- WASAPI runs out of internal buffer space
- Driver drops samples → discontinuity message
- **This is the cascading failure mode**

---

## Recommendation

The buffer drain logic helps, but we need the **block-based fix** for permanent solution.

Alternatives:
1. **Quick fix**: Increase max chunk size even more (but just delays the problem)
2. **Band-aid**: Detect encoder buffering lag and compensate PTS (hacky)
3. **Real fix**: Switch to block-based audio pulling (1024 samples per Tick)

**Block-based is the way to go** - that's what professional streamers use.

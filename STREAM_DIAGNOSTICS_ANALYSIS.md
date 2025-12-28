# Stream Diagnostic Analysis: Artifact Root Causes

## Critical Issues Found (Levels 2-5)

### **Level 2: Buffer Health ❌ CRITICAL**

```
[AudioEngine::Tick] BEFORE MIX: desktop=480 frames, mic=0 frames, requesting=48 frames
ÔØî AUDIO OVERRUN RISK: desktop buffer has 480 frames (need ~48, latency building!)
```

**Problem**: Desktop audio buffer is accumulating 10x the requested audio
- Desktop is supplying: **480 frames every 10ms** (at 44.1kHz originally, resampled to 48kHz)
- AudioEngine is requesting: **48 frames every 10ms**
- Result: Buffer grows: 480 → 1104 → 1392 → overflow

**Why this causes artifacts:**
- Latency keeps building (480 + 480 + 480... frames stacking up)
- When buffer eventually fills, packets get dropped
- This creates audio gaps/pops when stream catches up

**Root cause**: Desktop capture is delivering audio **10x faster than expected**
- Expected: 48 frames/10ms = 48,000 Hz/1000 = 48 frames per tick
- Getting: 480 frames/10ms = 480 × 100 = 48,000 Hz ✓ sample rate is correct
- But frame block size is wrong!

---

### **Level 3: Encoding Consistency ✅ OK**

```
[AudioCallback] Encoding 48 frames (total received: 48)... 
[AudioCallback] Got 0 encoded packets (not enough samples)

[AudioCallback] Encoding 672 frames (total received: 3408)...
[AudioCallback] Got 1 encoded packets (total frames encoded: 3408)
[Audio AUDIT] Pkt 0: size=484 bytes, numSamples=1024, pts=0 ms, duration=21 ms

[AudioCallback] Encoding 768 frames (total received: 4176)...
[AudioCallback] Got 1 encoded packets (total frames encoded: 4176)
[Audio AUDIT] Pkt 1: size=434 bytes, numSamples=1024, pts=21 ms, duration=21 ms
```

**Good news**: 
- ✅ All encoded packets are exactly **1024 samples** (never varies)
- ✅ This is perfect - consistent encoding output
- No irregular sample counts

**But the input varies wildly:**
- First: 48 frames → not enough, 0 packets (waits for more)
- Second: 672 frames → 1 packet
- Third: 768 frames → 1 packet

**Analysis**: Encoder is handling the buffer overflow gracefully by buffering and releasing fixed 1024-sample packets. This is good encoder design, but it's masking the upstream problem.

---

### **Level 4: Timestamp Jitter ✅ PERFECT**

```
Audio delta ms = 21 (expected ~21)
Audio delta ms = 21 (expected ~21)
Audio delta ms = 22 (expected ~21)  ← rounding
Audio delta ms = 21 (expected ~21)
Audio delta ms = 22 (expected ~21)
Audio delta ms = 21 (expected ~21)
[all subsequent packets: 21-22 consistently]
```

**Perfect jitter characteristics:**
- ✅ All deltas between 21-22ms (expected for 1024 samples @ 48kHz)
- ✅ No gaps (delta < 19)
- ✅ No bursts (delta > 24)
- ✅ No time_base issues

**Conclusion**: Muxer is working perfectly. PTS/DTS timing is rock solid.

---

### **Level 5: Monotonic DTS ✅ PERFECT**

```
[StreamBuffer] GetNextPacket: sent_dts=0, remaining=0
[StreamBuffer] GetNextPacket: sent_dts=21, remaining=0
[StreamBuffer] GetNextPacket: sent_dts=50, remaining=0
[... all monotonically increasing ...]
```

**No violations found:**
- ✅ DTS values increasing: 0 → 21 → 50 → 71 → ...
- ✅ No packets dropped for DTS violations
- ✅ StreamBuffer ordering working

---

## Real Root Cause: Audio Capture Buffer Overflow

### The Artifact Chain

```
1. WASAPI desktop callback delivers 480 frames per 10ms tick
   ↓
2. AudioEngine::Tick() requests only 48 frames per tick
   ↓
3. Buffer accumulates: 480 → 960 → 1440 → 1920 → overflow
   ↓
4. SmartBufferDrop policy kicks in to prevent memory explosion
   ↓
5. Audio packets are dropped/skipped (video P-frames drop first, but then audio...)
   ↓
6. Playback has gaps → user hears clicks/pops
```

### Why Deltas Still Look Perfect

The diagnostics show perfect 21-22ms deltas **because they're measuring what got through**. When a packet is dropped, there's no delta logged. So we see:

```
Audio delta = 21ms (packets 0-1)
Audio delta = 21ms (packets 1-2)
[packet 2 might be dropped but not logged]
Audio delta = 21ms (packets 3-4)
```

The **skipped packet shows up as a gap in the stream**, not as a jitter measurement.

---

## Why This Happens: AudioEngine Tick Timing Mismatch

**AudioEngine::Tick() calculates frames like this:**

```cpp
const UINT64 currentTimeMs = GetMonotonicTimeMs();
const UINT64 elapsedMs = currentTimeMs - m_startTimeMs;
const UINT64 expectedFrames = (elapsedMs * SAMPLE_RATE) / 1000;  // 48000
const UINT64 framesToSend = expectedFrames - m_framesSent;

// Limit to 100ms max
const UINT32 maxFramesPerTick = (SAMPLE_RATE / 10);  // 4800 frames = 100ms
const UINT32 outputFrames = (std::min)(framesToSend, maxFramesPerTick);
```

**But WASAPI is running at 10ms intervals:**
- Each 10ms, WASAPI delivers 480 frames (at 48kHz)
- Each 10ms, AudioEngine runs Tick()
- AudioEngine's expected elapsed time in first tick = ~10ms
- Expected frames = 10 × 48000 / 1000 = **480 frames**

**So why does it request 48 frames first?**

Looking at the code flow:
1. WASAPI callback: adds 480 frames to buffer
2. AudioTickThread runs immediately (before buffer has 5 blocks)
3. AudioEngine::Tick() at t=0-5ms: elapsedMs still very small (only a few ms)
4. expectedFrames = small value (like 48)
5. Requests 48 frames, encodes them
6. Buffer still has 480-48=432 frames left

**Then next tick:**
1. Another WASAPI delivers 480 frames (buffer now ~912)
2. AudioEngine::Tick() at t=~10ms: elapsedMs = 10ms
3. expectedFrames = 480
4. But has already sent 48, so framesToSend = 480-48 = 432
5. Requests 432 frames (adds 480 more from new WASAPI) = buffer grows

This is the **early tick problem**: The AudioTickThread is sometimes running before enough audio has accumulated.

---

## Solution Options

### Option 1: **Sleep Synchronization** (Recommended)
Make AudioTickThread sleep only after sending audio, not on a fixed 10ms cycle:

```cpp
// Instead of: always sleep 10ms
while (!shouldStop) {
    Tick();
    std::this_thread::sleep_for(10ms);  // ❌ Fixed interval
}

// Do this:
while (!shouldStop) {
    Tick();
    // Only sleep if we sent audio
    // If buffer is too full, skip sleep to drain faster
}
```

### Option 2: **Adaptive Frame Request**
Make AudioEngine request frames based on actual buffer state:

```cpp
// Current: request based on time
const UINT32 outputFrames = (elapsedMs * SAMPLE_RATE) / 1000;

// Better: request based on buffer + time
const UINT32 outputFrames = std::max(
    (elapsedMs * SAMPLE_RATE) / 1000,  // time-based
    desktopBufferFrames / 2  // drain buffer if overfull
);
```

### Option 3: **Increase AudioTickThread Frequency**
Run Tick() every 1-2ms instead of 10ms to consume audio faster:

```cpp
std::this_thread::sleep_for(2ms);  // was 10ms
```

### Option 4: **Buffer Cap with Drop Policy**
Prevent buffer from growing too large:

```cpp
if (desktopBufferFrames > 1920) {  // max 40ms buffer
    // Drop oldest audio frames to prevent overflow
    DesktopBuffer.erase(0, desktopBufferFrames - 1920);
}
```

---

## Which Fix Should We Try?

**Best approach**: **Option 1 + Option 2** combined:
1. Keep fixed 10ms sleep interval
2. But calculate outputFrames to include buffer drain logic

This prevents the buffer from ever growing too large while maintaining stable timing.

---

## To Verify the Fix Works

After implementing the fix, look for:

```
[AudioEngine::Tick] BEFORE MIX: desktop=480 frames, mic=480 frames, requesting=480 frames
✅ Buffer in healthy range (1-2x requested)

[AudioEngine::Tick] BEFORE MIX: desktop=520 frames, mic=510 frames, requesting=480 frames
✅ Slight buffer growth but draining properly

[AudioEngine::Tick] BEFORE MIX: desktop=3000 frames, mic=2500 frames, requesting=480 frames
❌ STILL BROKEN - buffer overflow not fixed
```

The buffer should **oscillate** around 480 frames, not grow infinitely.

---

## Why Artifacts Happen With This Overflow

When buffer hits max (say 100,000 frames) and we finally drop packets:
1. Audio engine stops accepting new WASAPI frames
2. Existing buffer drains at mux rate (1024 samples per 21ms)
3. Stream plays back audio from OLD buffered data
4. New audio from WASAPI is lost
5. When it resumes, there's a **gap** between old and new audio
6. Gap shows up as a **click/pop/crackle** in playback

The diagnostic shows:
- Audio deltas: 21, 21, 21 (drain at normal rate)
- (dropped packet not logged)
- Audio delta: 21 (resume at normal rate)
- But the gap was there in the stream

YouTube's FLV parser accepts the DTS ordering but audio renderer hears the gap → artifact.

---

## Next Steps

1. **Implement buffer drain logic** in AudioEngine::Tick()
2. **Rebuild**
3. **Stream and check** for:
   - Fewer OVERRUN messages
   - No buffer growth over time
   - Hopefully no more artifacts
4. **Share new diagnostics**

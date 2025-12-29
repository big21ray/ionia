# CRITICAL FIX: Frame Timeline Deadlock

## Problem Identified 🚨

VideoTickThread had a **logical deadlock** that prevented video streaming from progressing:

### Root Cause
```cpp
// OLD CODE (BROKEN)
if (currentFrame < expectedFrame) {
    if (m_videoEngine->PopFrameFromBuffer(frame)) {
        // Encode and advance ONLY if frame exists
        auto packets = m_videoEncoder->EncodeFrame(frame.data());
        m_streamMuxer->WriteVideoPacket(&p, currentFrame);
        m_videoEngine->AdvanceFrameNumber();  // ❌ ONLY HERE
    }
    // else: NO ADVANCE!  ← THIS IS THE BUG
}
```

### What Happened
1. Expected frame count keeps increasing (CFR clock is working)
2. If PopFrameFromBuffer() returns false (no captured frame), **AdvanceFrameNumber() is never called**
3. currentFrame gets stuck
4. expectedFrame keeps growing
5. Infinite wait: `while (currentFrame < expectedFrame)`
6. No more encoding, no more network packets
7. Stream freezes completely

### Why This Happened
The original logic treated frame advancement as tied to frame encoding. If there's no frame to encode, it assumed there's nothing to advance.

This recreates the exact OBS problem we were trying to fix:
- **Capture thread** becomes the clock master (by controlling when frames exist)
- **VideoTickThread** waits passively for frames
- **Network backpressure** can cause capture to stall
- **Entire stream freezes**

## Solution Applied ✅

**Frame duplication with unconditional frame advancement** (OBS-like CFR):

```cpp
// NEW CODE (FIXED)
if (currentFrame < expectedFrame) {
    // Try to get a real frame
    bool hasFrame = m_videoEngine->PopFrameFromBuffer(frame);
    
    // If no real frame, use last frame (duplication)
    if (!hasFrame) {
        if (!m_videoEngine->GetLastFrame(frame)) {
            // No last frame? Use black frame as fallback
            std::fill(frame.begin(), frame.end(), 0);
        }
        hasFrame = true;
    }
    
    // Encode the frame (real or duplicated or black)
    if (hasFrame) {
        auto packets = m_videoEncoder->EncodeFrame(frame.data());
        m_streamMuxer->WriteVideoPacket(&p, currentFrame);
    }
    
    // ✅ ALWAYS advance, regardless of frame availability
    m_videoEngine->AdvanceFrameNumber();
}
```

### Key Changes
1. **Separated frame availability from frame advancement**
   - Frame advancement is now independent of capture
   - Clock master stays in control, not capture

2. **Added frame duplication**
   - If no new frame: use last frame
   - If no last frame: use black frame
   - This ensures VideoTickThread can always encode something

3. **Added methods to VideoEngine**
   - `bool GetLastFrame(std::vector<uint8_t>& out)` - retrieve last captured frame
   - Used for duplication when capture lags

4. **Unconditional frame number advancement**
   - `AdvanceFrameNumber()` called every cycle, always
   - Timeline progresses at CFR rate, independent of capture

## Impact

| Aspect | Before | After |
|--------|--------|-------|
| Frame advancement | Blocked on capture | Constant CFR rate |
| Capture lag handling | Infinite wait | Frame duplication |
| Stream progression | Freezes after capture stops | Continues indefinitely |
| Timeline | Captures controls | CFR clock controls |
| Encoder load | Varies with capture | Constant (CFR) |

## Testing

Run (preferred): `..\\run_streamer_debug.cmd <youtubeStreamKey>`

Or run directly:

`node test_stream_youtube_end_to_end.js <youtubeStreamKey>`

Expected output:
```
[TEST:1s] Video frames: 0, packets: 1, audio packets: 48
[TEST:2s] Video frames: 0, packets: 2, audio packets: 96
[TEST:3s] Video frames: 0, packets: 3, audio packets: 144
...
[TEST] ✅ SUCCESS: Video stream progressed!
```

The key is: **video packets keep incrementing even if frames aren't being captured**, because we're duplicating frames to maintain CFR.

## Architecture Summary

```
CaptureThread (best-effort)
    ↓ PushFrame() (when available)
    ↓
VideoEngine Ring Buffer (4 frames, non-blocking)
    ↓
VideoTickThread (CFR clock master)
    ├─ Try PopFrameFromBuffer()
    ├─ Fail? Use GetLastFrame()
    ├─ Still nothing? Use black frame
    ├─ ✅ Always AdvanceFrameNumber()
    └─ Encode → Mux → Network
    
Result: Clock master controls timeline, capture feeds frames when possible
```

This is exactly how OBS works and why it has smooth streaming even with variable capture rates.

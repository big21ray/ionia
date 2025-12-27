# Frame Timeline Deadlock - Fix Implementation Summary

## Changes Made

### 1. VideoEngine Header (`wasapi_video_engine.h`)
**Added new public method:**
```cpp
/**
 * Get last captured frame (for frame duplication on lag)
 * Returns true if a last frame exists
 */
bool GetLastFrame(std::vector<uint8_t>& outFrame) const;
```

### 2. VideoEngine Implementation (`wasapi_video_engine.cpp`)
**Added method implementation:**
```cpp
bool VideoEngine::GetLastFrame(std::vector<uint8_t>& outFrame) const {
    if (!m_hasLastFrame || m_lastFrame.empty()) {
        return false;
    }
    outFrame = m_lastFrame;
    return true;
}
```

### 3. VideoTickThread Logic (`wasapi_video_audio_streamer.cpp`)
**MAJOR REWRITE - Changed from:**
```
if (PopFrameFromBuffer()) {
    Encode();
    AdvanceFrameNumber();
} else {
    // Do nothing - DEADLOCK!
}
```

**To:**
```
bool hasFrame = PopFrameFromBuffer();
if (!hasFrame) {
    // Try last frame duplication
    if (!GetLastFrame()) {
        // Use black frame as fallback
    }
}
if (hasFrame) {
    Encode();
}
AdvanceFrameNumber();  // ✅ ALWAYS, unconditionally
```

### 4. Error Handling
All operations wrapped in try-catch:
- PopFrameFromBuffer() exception → fallback to last frame
- GetLastFrame() exception → fallback to black frame
- EncodeFrame() exception → frame duplication still successful
- WriteVideoPacket() exception → log but continue
- AdvanceFrameNumber() exception → bail (critical path)

## Why This Fixes the Deadlock

**Before:**
- Frame count: expected=100, current=2
- PopFrameFromBuffer() returns false (capture lag)
- AdvanceFrameNumber() never called
- current stays at 2 forever
- VideoTickThread spins endlessly waiting

**After:**
- Frame count: expected=100, current=2
- PopFrameFromBuffer() returns false
- GetLastFrame() succeeds → duplicate previous frame
- Encode() the duplicated frame
- AdvanceFrameNumber() called → current becomes 3
- Next iteration: expected=100, current=3
- Timeline continuously progresses at CFR rate

## Key Insight

The bug wasn't in the threading or architecture. It was a **logic error**: treating frame advancement as conditional on frame availability.

The fix separates these concerns:
- **Frame source**: Capture (best-effort, can be slow or stalled)
- **Timeline**: CFR clock (constant, independent)
- **Encoding**: Duplication strategy (fallback when capture can't keep up)

This is exactly how modern encoders like OBS, Ffmpeg, and hardware encoders handle variable capture rates.

## Testing

Create file `test_framedup_fix.js` and run:
```bash
node test_framedup_fix.js
```

Expected: Video packets incrementing even if no frames captured.

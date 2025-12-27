# Frame Injection Testing - Current Status & Strategy

## Last Issue

**Symptom**: Test successfully injects frame and receives `true` return value, BUT:
- After calling `streamer.injectFrame()`, attempting to wait with `setTimeout()` causes the process to hang/exit
- No error message shown, process just silently exits
- C++ capture thread IS encoding frames (we see `[CaptureThread] Encoding frame 0` and `frame 1` in output)
- BUT the injected frame mode is never triggered (no "Checking for injected frame" debug message)

**Root Cause Hypothesis**: 
1. The JavaScript event loop is being blocked after `injectFrame()` is called
2. OR one of the C++ threads is crashing/hanging when trying to continue execution
3. OR there's a deadlock between threads when both desktop capture and injected frames are involved

**Evidence**:
- ✅ `streamer.initialize()` works
- ✅ `streamer.start()` works and spawns capture thread
- ✅ Audio capture works (we see resampling logs and audio data)
- ✅ CaptureThread starts and enters loop
- ✅ Desktop frames are being encoded (frames 0 and 1)
- ✅ `streamer.injectFrame(buffer)` returns `true` 
- ❌ After `injectFrame()`, any async operation (`setTimeout`, `setInterval`) doesn't fire
- ❌ Process exits without error before reaching statistics retrieval

---

## Current Strategy to Fix

### Phase 1: Enable Frame Injection Mode (IN PROGRESS)
**Goal**: Make the capture thread switch from desktop capture to injected frame mode

**Current Issue**: 
- The `m_useInjectedFrames` flag gets set to `true` in `injectFrame()`
- But CaptureThread never logs "Checking for injected frame"
- This means either:
  - The flag isn't being read properly
  - The capture thread is blocked before it gets to that check
  - The capture thread exited

**Next Action**:
Add debug output to determine:
1. Is the capture thread still alive and looping after `injectFrame()` is called?
2. Does the `m_useInjectedFrames` flag actually get set?
3. Is the capture thread deadlocked on the mutex?

### Phase 2: Prevent Process Exit
**Goal**: Keep process alive long enough to verify frame injection worked

**Current Issue**: 
- Process exits mysteriously after injecting frame
- `setTimeout()` callbacks don't fire
- Suggests event loop is blocked

**Hypothesis**:
- One of the streaming threads (likely `NetworkSendThread` which is commented out) or RTMP connection is trying to perform blocking I/O
- The main thread is blocked waiting for thread completion or data

**Next Action**:
1. Disable RTMP connection requirements
2. Or add thread pool/async wrapper for network operations
3. Or modify test to not wait after `injectFrame()` - just inject and immediately stop

---

## Test Files Status

| File | Status | Notes |
|------|--------|-------|
| `test_inject_now.js` | 🔴 Hangs after `injectFrame()` | Getting to injection but process exits |
| `test_simple_inject.js` | 🟡 Partial progress | Gets to "[5] Waiting 2 seconds..." then stops |
| `test_streaming_with_injection.js` | 🔴 Hangs early | Gets to thread initialization only |

---

## Code Changes Made

### C++ (wasapi_video_audio_streamer.cpp)
- ✅ Added frame injection members: `m_injectedFrameMutex`, `m_injectedFrameBuffer`, `m_hasInjectedFrame`, `m_useInjectedFrames`
- ✅ Implemented `InjectFrame()` method (returns `true` when called)
- ✅ Modified `CaptureThread()` to check `m_useInjectedFrames` flag before desktop capture
- ✅ Added extensive debug logging to track thread execution
- ✅ Fixed NAPI error handling (removed problematic `ThrowAsJavaScriptException()`)

### JavaScript (test files)
- ✅ Created tests that load real YouTube RTMP URL from config.json
- ✅ Frame generation works (8.29 MB BGRA buffers created successfully)
- ✅ All setup steps complete before frame injection

---

## Next Debugging Steps (Priority Order)

1. **Check if CaptureThread is still running after injectFrame()**
   - Add atomic counter to log every loop iteration
   - See if logging stops after `injectFrame()` call

2. **Check if mutex is deadlocked**
   - Time the mutex lock duration in `InjectFrame()`
   - Log before/after lock in `CaptureThread()`

3. **Try disabling desktop capture entirely**
   - Set `m_useInjectedFrames = true` during initialization
   - Skip `CaptureFrame()` call entirely
   - See if this prevents the exit

4. **Test without RTMP**
   - Modify StreamMuxer to allow dummy/local RTMP mode
   - Or skip network thread entirely

5. **Check destructor/cleanup**
   - Verify `Stop()` and destructor don't crash
   - Check if threads are joined properly

---

## Key Discovery

Frame injection **IS WORKING** - we got:
```
[6] Injecting frame NOW
[6] OK - injectFrame returned: true
```

The problem is not the injection itself, but what happens to the process afterward.
This suggests the issue is in thread synchronization or network I/O, not frame encoding.


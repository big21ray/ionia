# Quick Reference: Build & Test

## ⚠️ IMPORTANT: Always Use build_all.bat

```powershell
cd native-audio
.\build_all.bat
```

**DO NOT use:**
```powershell
npx node-gyp rebuild
cmd /c "cd /d ... && npx node-gyp rebuild --msvs_version=2022"
```

---

## Why build_all.bat?

✅ Automatically detects Visual Studio 2026  
✅ Finds Python 3.12.4 automatically  
✅ Validates FFmpeg dependencies via vcpkg  
✅ Copies all necessary DLLs  
✅ Creates backup of working Node.js build  
✅ Consistent, reproducible builds  

---

## Test Files

Run the main test:
```powershell
cd native-audio
node test_async.js
```

Expected output:
```
1. Creating streamer                 ✅ OK
2. Initializing                      ✅ OK (true)
3. Starting                          ✅ OK (true)
4. Waiting 1 second                  ✅ OK
5. Get stats (attempt 1)             ✅ Video: 0, Audio: 0
6. Waiting 1 second                  ✅ OK
7. Get stats (attempt 2)             ✅ Video: 0, Audio: 0
8. Waiting 1 second                  ✅ OK
9. Get stats (attempt 3)             ✅ Video: 0, Audio: 0
10. Checking connection status       ✅ Connected: true, Backpressure: false
11. Stopping                         ✅ OK

✅ All tests completed successfully!
```

---

## Recent Fixes (Session 2025-12-26)

### Issue 1: Compilation Error
**Fixed:** stream_buffer.h header guard mismatch  
**File:** native-audio/src/stream_buffer.h

### Issue 2: Thread Safety
**Fixed:** Made statistics counters atomic  
**File:** native-audio/src/wasapi_video_audio_streamer.cpp  
**Changes:** 3 edits (GetStatistics, CaptureThread, audio callbacks)

### Issue 3: Segmentation Fault (CRITICAL)
**Fixed:** Added null pointer checks in background threads  
**File:** native-audio/src/wasapi_video_audio_streamer.cpp  
**Changes:** 3 edits (CaptureThread, AudioTickThread, NetworkSendThread)

**Result:** ✅ All tests pass, no crashes

---

## Full Documentation

See [DEBUGGING_STREAMER.md](DEBUGGING_STREAMER.md) for complete debugging session details.

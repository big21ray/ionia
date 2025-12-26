# Why COM Threading Error in Electron but Not in Test Script

## The Root Cause

The error `[h264_mf @ ...] COM must not be in STA mode` occurs because of **COM (Component Object Model) threading mode differences** between Node.js and Electron.

## COM Threading Modes

Windows COM has two threading modes:
- **STA (Single-Threaded Apartment)**: One thread per apartment, message pump required
- **MTA (Multi-Threaded Apartment)**: Multiple threads, no message pump

## Why Test Script Works

**`test_video_audio_recorder.js` (Plain Node.js):**

1. **No COM Pre-initialization**: Node.js doesn't initialize COM by default
2. **Your Code Initializes COM**: In `audio_capture.cpp:70`, your code explicitly initializes COM in **MTA mode**:
   ```cpp
   HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
   ```
3. **FFmpeg Finds h264_mf**: When FFmpeg's `avcodec_find_encoder(AV_CODEC_ID_H264)` runs, it finds `h264_mf` (Windows Media Foundation)
4. **h264_mf Works**: Since COM is in MTA mode (which your code set), `h264_mf` works fine
5. **Success**: Video encoder initializes successfully

## Why Electron Fails

**Electron App:**

1. **Electron Pre-initializes COM in STA Mode**: Electron's main process is a **GUI application**, and Windows GUI applications automatically initialize COM in **STA mode** when they start
2. **COM Already Initialized**: By the time your code runs, COM is already initialized in STA mode
3. **Your Code Can't Change It**: In `audio_capture.cpp:70`, your code tries to initialize COM:
   ```cpp
   HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
   ```
   But this returns `RPC_E_CHANGED_MODE` because COM is already initialized in STA mode
4. **FFmpeg Finds h264_mf**: When FFmpeg's `avcodec_find_encoder(AV_CODEC_ID_H264)` runs, it still finds `h264_mf`
5. **h264_mf Fails**: `h264_mf` requires MTA mode, but COM is in STA mode (set by Electron)
6. **Error**: `[h264_mf @ ...] COM must not be in STA mode`

## The Code Flow

### Test Script (Node.js)
```
Node.js starts
  ↓
No COM initialization
  ↓
Your code: CoInitializeEx(NULL, COINIT_MULTITHREADED) → SUCCESS (MTA mode)
  ↓
FFmpeg: avcodec_find_encoder(AV_CODEC_ID_H264) → finds h264_mf
  ↓
h264_mf: Works (COM is in MTA mode) ✅
```

### Electron App
```
Electron starts (GUI application)
  ↓
Windows automatically: CoInitializeEx(NULL, COINIT_APARTMENTTHREADED) → STA mode
  ↓
Your code: CoInitializeEx(NULL, COINIT_MULTITHREADED) → RPC_E_CHANGED_MODE (can't change)
  ↓
FFmpeg: avcodec_find_encoder(AV_CODEC_ID_H264) → finds h264_mf
  ↓
h264_mf: Fails (COM is in STA mode, but h264_mf needs MTA) ❌
```

## Why h264_mf Requires MTA

Windows Media Foundation (`h264_mf`) is designed for multi-threaded scenarios and requires MTA mode because:
- It uses asynchronous operations
- It needs to work across multiple threads
- STA mode would block operations

## The Solution

Instead of trying to change COM mode (which is impossible once Electron initializes it), we **explicitly request `libx264`** instead of letting FFmpeg auto-select `h264_mf`:

```cpp
// OLD (auto-selects h264_mf, which fails in Electron)
m_codec = avcodec_find_encoder(AV_CODEC_ID_H264);

// NEW (explicitly request libx264, works in both environments)
m_codec = avcodec_find_encoder_by_name("libx264");
```

`libx264` doesn't use Windows COM, so it works in both STA and MTA modes.

## Summary

| Environment | COM Mode | Codec Found | Result |
|------------|----------|-------------|--------|
| **Node.js Test** | MTA (your code sets it) | `h264_mf` | ✅ Works |
| **Electron** | STA (Electron sets it) | `h264_mf` | ❌ Fails |
| **Both (with fix)** | Any | `libx264` | ✅ Works |

The fix ensures we use `libx264` which doesn't depend on COM threading mode, making it work in both environments.





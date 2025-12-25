# Electron App Flow Explanation

## Architecture Overview

Electron uses a **multi-process architecture**:
- **Main Process** (`main.ts`): Node.js process that manages windows and system APIs
- **Renderer Process** (`RecordingButton.tsx`): React app running in a browser window (isolated from Node.js)
- **Preload Script** (`preload.js`): Bridge between main and renderer processes

## Data Flow: Recording Start

```
┌─────────────────────────────────────────────────────────────┐
│  RecordingButton.tsx (Renderer Process - React UI)        │
│  - User clicks REC button                                   │
│  - Calls: window.electronAPI.startRecording()              │
└───────────────────────┬─────────────────────────────────────┘
                        │ IPC (Inter-Process Communication)
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  preload.js (Preload Script - Security Bridge)              │
│  - Exposes safe API to renderer                             │
│  - Forwards: ipcRenderer.invoke('recording:start')         │
└───────────────────────┬─────────────────────────────────────┘
                        │ IPC Message
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  main.ts (Main Process - Node.js)                          │
│  - Receives: ipcMain.handle('recording:start')             │
│  - Loads native module: VideoAudioRecorder                  │
│  - Creates instance and initializes                         │
│  - Returns: { success: true/false, error?: string }        │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  native-audio/index.js (Native Module Loader)              │
│  - Loads: build/Release/wasapi_capture.node                 │
│  - Exports: VideoAudioRecorder class                        │
└───────────────────────┬─────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────┐
│  wasapi_capture.node (C++ Native Module)                   │
│  - VideoAudioRecorder::Initialize()                         │
│  - Initializes Desktop Duplication, Video Encoder, etc.    │
└─────────────────────────────────────────────────────────────┘
```

## Step-by-Step Flow

### 1. **RecordingButton.tsx** (Renderer Process)
```typescript
// User clicks button
const handleToggleRecording = async () => {
  // Calls the exposed API
  const result = await window.electronAPI?.startRecording();
  // result = { success: false, error: 'Failed to initialize Video Encoder' }
}
```

**Key Points:**
- Runs in the **renderer process** (browser-like environment)
- **Cannot** directly access Node.js APIs or native modules
- Uses `window.electronAPI` which is exposed by `preload.js`
- All communication with main process is **asynchronous** (Promises)

### 2. **preload.js** (Preload Script)
```javascript
contextBridge.exposeInMainWorld('electronAPI', {
  startRecording: () => ipcRenderer.invoke('recording:start'),
});
```

**Key Points:**
- Runs in a **special context** with access to both Node.js and renderer APIs
- Uses `contextBridge` for **secure** API exposure (prevents renderer from accessing full Node.js)
- `ipcRenderer.invoke()` sends a **message** to the main process and waits for a response
- This is the **only** way renderer can communicate with main process

### 3. **main.ts** (Main Process)
```typescript
// Load native module at startup (lines 12-35)
let VideoAudioRecorder: any = null;
const nativeModule = require(path.join(nativeAudioPath, 'index.js'));
VideoAudioRecorder = nativeModule.VideoAudioRecorder;

// Handle IPC message (lines 72-134)
ipcMain.handle('recording:start', async () => {
  // Create instance
  videoAudioRecorder = new VideoAudioRecorder();
  
  // Initialize (THIS IS WHERE THE ERROR OCCURS)
  const initialized = videoAudioRecorder.initialize(...);
  if (!initialized) {
    return { success: false, error: 'Failed to initialize recorder' };
  }
  
  // Start recording
  const started = videoAudioRecorder.start();
  return { success: true, outputPath: recordingOutputPath };
});
```

**Key Points:**
- Runs in the **main process** with full Node.js access
- Can load native modules, access file system, etc.
- `ipcMain.handle()` **listens** for messages from renderer
- Returns a Promise that resolves to the response
- **Synchronous** operations (like native module calls) block the main thread

### 4. **native-audio/index.js** (Module Loader)
```javascript
// Tries to load the compiled .node file
nativeModule = require('build/Release/wasapi_capture.node');

// Exports the C++ class
module.exports = {
  VideoAudioRecorder: nativeModule.VideoAudioRecorder
};
```

**Key Points:**
- Loads the compiled C++ module (`.node` file)
- Must be in the correct location with all DLLs

### 5. **C++ Native Module** (wasapi_video_audio_recorder.cpp)
```cpp
// Line 159: This is where your error is thrown
if (!m_videoEncoder->Initialize(m_width, m_height, m_fps, m_videoBitrate, m_useNvenc)) {
    Napi::Error::New(env, "Failed to initialize Video Encoder").ThrowAsJavaScriptException();
    return env.Undefined();
}
```

**Key Points:**
- The error is thrown when `VideoEncoder::Initialize()` returns `false`
- This happens in the C++ code, not JavaScript

## Why "Failed to initialize Video Encoder" Occurs

The error is thrown at **line 160** in `wasapi_video_audio_recorder.cpp`. The `VideoEncoder::Initialize()` can fail for several reasons:

### Possible Causes:

1. **FFmpeg Codec Not Found** (video_encoder.cpp:77-79)
   ```cpp
   m_codec = avcodec_find_encoder(AV_CODEC_ID_H264);
   if (!m_codec) {
       return false;  // "H.264 encoder not found"
   }
   ```
   - FFmpeg wasn't compiled with H.264 support
   - Missing FFmpeg DLLs at runtime

2. **Codec Context Allocation Failed** (video_encoder.cpp:85-88)
   ```cpp
   m_codecContext = avcodec_alloc_context3(m_codec);
   if (!m_codecContext) {
       return false;  // "Failed to allocate codec context"
   }
   ```
   - Out of memory
   - FFmpeg library issue

3. **Frame Allocation Failed** (video_encoder.cpp:50-53)
   ```cpp
   if (!AllocateFrame()) {
       return false;  // "Failed to allocate frame"
   }
   ```
   - Out of memory
   - Invalid dimensions

4. **Codec Open Failed** (video_encoder.cpp:112-117)
   ```cpp
   int ret = avcodec_open2(m_codecContext, m_codec, nullptr);
   if (ret < 0) {
       return false;  // Codec couldn't be opened
   }
   ```
   - Invalid codec parameters
   - Missing codec dependencies

## How to Debug

### 1. Check Electron Console (Main Process)
The C++ code writes to `stderr`, which appears in the **Electron main process console**:
- Look for messages like:
  - `[VideoEncoder] Failed to initialize codec`
  - `[VideoEncoder] H.264 encoder not found`
  - `[VideoEncoder] Failed to allocate codec context`
  - `[VideoEncoder] Failed to allocate frame`

### 2. Check FFmpeg DLLs
The native module needs FFmpeg DLLs in the same directory:
```powershell
# Check if DLLs exist
cd native-audio\build\Release
dir *.dll
# Should see: avcodec.dll, avformat.dll, avutil.dll, swresample.dll
```

### 3. Test Native Module Directly
```javascript
// In native-audio directory
node test_video_audio_recorder.js
```

### 4. Add More Logging
In `main.ts`, add more detailed error handling:
```typescript
try {
  const initialized = videoAudioRecorder.initialize(...);
  if (!initialized) {
    console.error('❌ Initialize returned false');
    // Check Electron console for C++ error messages
    return { success: false, error: 'Failed to initialize recorder. Check Electron console for details.' };
  }
} catch (error) {
  console.error('❌ Exception during initialize:', error);
  return { success: false, error: error.message };
}
```

## Summary

**Flow:** RecordingButton → preload.js → main.ts → native module → C++

**Error Location:** C++ code in `wasapi_video_audio_recorder.cpp:160`

**Most Likely Cause:** Missing FFmpeg DLLs or FFmpeg not compiled with H.264 support

**Next Steps:**
1. Check Electron main process console for detailed C++ error messages
2. Verify FFmpeg DLLs are in `native-audio/build/Release/`
3. Test the native module directly with `test_video_audio_recorder.js`


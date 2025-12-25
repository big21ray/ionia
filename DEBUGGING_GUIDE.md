# Debugging "Failed to initialize Video Encoder" Error

## File Relationship

- **Source TypeScript**: `electron/main.ts` (line 122)
- **Compiled JavaScript**: `dist-electron/electron/main.js` (line 108)
- **Compilation**: `npm run build:electron` compiles TypeScript → JavaScript

## The Error Flow

```
electron/main.ts:122
  ↓ (TypeScript compilation)
dist-electron/electron/main.js:108
  ↓ (JavaScript execution)
videoAudioRecorder.initialize() 
  ↓ (C++ native code)
wasapi_video_audio_recorder.cpp:160
  ↓ (C++ throws exception)
"Failed to initialize Video Encoder"
```

## How to Find the Real C++ Error

The JavaScript error is just a wrapper. The **real error** is printed to `stderr` by the C++ code. You need to check the **Electron main process console** (not the browser DevTools).

### Step 1: Check Electron Console

When you run `npm run electron:dev`, look at the **terminal/console** where Electron is running. You should see messages like:

```
[VideoEncoder] Failed to initialize codec
[VideoEncoder] H.264 encoder not found
[VideoEncoder] Failed to allocate codec context
[VideoEncoder] Failed to allocate frame
```

These messages are printed **before** the JavaScript exception is thrown.

### Step 2: Common C++ Error Messages

1. **`[VideoEncoder] H.264 encoder not found`**
   - **Cause**: FFmpeg DLLs not found or FFmpeg not compiled with H.264
   - **Fix**: Ensure DLLs are in `native-audio/build/Release/`

2. **`[VideoEncoder] Failed to allocate codec context`**
   - **Cause**: Out of memory or FFmpeg initialization issue
   - **Fix**: Check if FFmpeg DLLs are correct version

3. **`[VideoEncoder] Failed to allocate frame`**
   - **Cause**: Invalid dimensions or out of memory
   - **Fix**: Check desktop dimensions

4. **`[VideoEncoder] Failed to initialize codec`**
   - **Cause**: Codec couldn't be opened (check for more details above)

### Step 3: Verify DLLs Are Loaded

Add this debug code to `electron/main.ts` before loading the module:

```typescript
// Debug: Check if DLLs exist
const dllPath = path.join(nativeAudioPath, 'build/Release');
console.log('🔍 Checking DLL path:', dllPath);
console.log('🔍 DLL path exists:', fs.existsSync(dllPath));
if (fs.existsSync(dllPath)) {
  const dlls = fs.readdirSync(dllPath).filter(f => f.endsWith('.dll'));
  console.log('🔍 Found DLLs:', dlls);
}
```

### Step 4: Test Native Module Directly

Run the test script to see if it works outside Electron:

```powershell
cd native-audio
node test_video_audio_recorder.js
```

If this works but Electron doesn't, it's a PATH/DLL loading issue.

## Quick Fix Checklist

- [ ] Check Electron console (terminal) for `[VideoEncoder]` messages
- [ ] Verify DLLs exist: `native-audio/build/Release/*.dll`
- [ ] Check if PATH includes DLL directory (we added this in main.ts)
- [ ] Test with `test_video_audio_recorder.js` to isolate the issue
- [ ] Rebuild native module: `npm run build:native:electron`

## Understanding the Stack Trace

```
Error: Failed to initialize Video Encoder
    at file:///C:/Users/Karmine%20Corp/Documents/Ionia/dist-electron/electron/main.js:108:50
```

- `main.js:108` = Compiled JavaScript (line 108)
- `main.ts:122` = Source TypeScript (line 122)
- The actual C++ error is in `stderr`, not in this stack trace!


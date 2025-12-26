// Load the native module
// In development, it's in build/Release/
// In production, it should be in the same directory
const path = require('path');
const fs = require('fs');

let nativeModule;
const isDev = process.env.NODE_ENV === 'development';

// Try to load the native module
const possiblePaths = [
  path.join(__dirname, 'build/Release/wasapi_capture.node'),
  path.join(__dirname, 'build/Debug/wasapi_capture.node'),
  path.join(__dirname, 'wasapi_capture.node'),
];

let lastError = null;
for (const modulePath of possiblePaths) {
  if (fs.existsSync(modulePath)) {
    try {
      nativeModule = require(modulePath);
      break;
    } catch (err) {
      lastError = err;
      console.warn(`Failed to load native module from ${modulePath}:`, err.message);
      if (err.stack) {
        console.warn('Stack trace:', err.stack);
      }
    }
  }
}

if (!nativeModule) {
  let errorMsg = 'WASAPI native module not found.';
  
  if (lastError) {
    errorMsg = `WASAPI native module found but failed to load:\n${lastError.message}\n\nPossible causes:\n- Missing FFmpeg DLLs (avcodec.dll, avformat.dll, avutil.dll, swresample.dll)\n  → Copy from C:\\vcpkg\\installed\\x64-windows\\bin to the same directory as wasapi_capture.node\n- Architecture mismatch (x64 vs x86)\n- Missing Visual C++ Redistributables\n- Module needs to be recompiled: cd native-audio && npm install`;
    
    if (lastError.stack) {
      errorMsg += `\n\nStack trace:\n${lastError.stack}`;
    }
  } else {
    errorMsg += ' Run "npm install" in native-audio directory first.';
  }
  
  throw new Error(errorMsg);
}

// Export modules
module.exports = {
  WASAPICapture: nativeModule.WASAPICapture,
  AudioEngine: nativeModule.AudioEngine,
  AudioEngineEncoder: nativeModule.AudioEngineEncoder,
  VideoRecorder: nativeModule.VideoRecorder || null,  // May not be available if not compiled
  VideoAudioRecorder: nativeModule.VideoAudioRecorder || null,  // May not be available if not compiled
  VideoAudioStreamer: nativeModule.VideoAudioStreamer || null,  // May not be available if not compiled
  // Utility functions for testing COM mode
  initializeCOMInSTAMode: nativeModule.initializeCOMInSTAMode || null,
  checkCOMMode: nativeModule.checkCOMMode || null
};







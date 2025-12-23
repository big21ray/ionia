# WASAPI Audio Capture Native Module

This is a C++ native Node.js addon for capturing desktop audio on Windows using WASAPI (Windows Audio Session API) loopback.

## Building

### Prerequisites

1. **Visual Studio Build Tools** or **Visual Studio** with C++ workload
   - Download from: https://visualstudio.microsoft.com/downloads/
   - Make sure "Desktop development with C++" is installed

2. **Node.js** (v18 or higher)

3. **Python** (for node-gyp)
   - Usually comes with Node.js or can be installed separately

### Build Commands

```bash
# Build the native module
npm run build:native

# Clean and rebuild
npm run rebuild:native
```

## Usage

```typescript
import { WASAPICapture } from './native-audio';

const capture = new WASAPICapture((audioData: Buffer) => {
  // Process audio data here
  console.log(`Received ${audioData.length} bytes of audio`);
});

// Get audio format
const format = capture.getFormat();
console.log('Sample Rate:', format?.sampleRate);
console.log('Channels:', format?.channels);

// Start capturing
capture.start();

// Later, stop capturing
capture.stop();
```

## Architecture

- **audio_capture.h/cpp**: Core WASAPI capture implementation
- **wasapi_capture.cpp**: Node.js addon bindings using node-addon-api
- **binding.gyp**: Build configuration for node-gyp

## Technical Details

- Uses WASAPI loopback mode to capture desktop audio
- Captures from the default audio renderer (speakers/headphones)
- Outputs 16-bit PCM audio
- Thread-safe callback system for audio data delivery





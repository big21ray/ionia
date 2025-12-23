# Integration Example

This shows how to integrate the WASAPI native module with FFmpeg for recording.

## Basic Integration

```typescript
import { WASAPICapture } from '../native-audio';
import { spawn } from 'child_process';
import { Writable } from 'stream';

let audioCapture: WASAPICapture | null = null;
let ffmpegProcess: ChildProcess | null = null;

// Start recording with audio
function startRecording() {
  // Start FFmpeg with pipe for audio input
  const ffmpegArgs = [
    '-f', 'gdigrab',
    '-framerate', '30',
    '-i', 'desktop',
    '-f', 's16le',  // 16-bit signed little-endian PCM
    '-ar', '48000',  // Sample rate (adjust to match capture)
    '-ac', '2',  // Stereo
    '-i', 'pipe:0',  // Read audio from stdin
    '-c:v', 'libx264',
    '-c:a', 'aac',
    '-map', '0:v:0',
    '-map', '1:a:0',
    'output.mp4'
  ];
  
  ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
  
  // Create audio capture
  audioCapture = new WASAPICapture((audioData: Buffer) => {
    // Write audio data to FFmpeg's stdin
    if (ffmpegProcess?.stdin && !ffmpegProcess.stdin.destroyed) {
      ffmpegProcess.stdin.write(audioData);
    }
  });
  
  // Get format and adjust FFmpeg args if needed
  const format = audioCapture.getFormat();
  console.log('Audio format:', format);
  
  // Start capturing
  audioCapture.start();
}

// Stop recording
function stopRecording() {
  if (audioCapture) {
    audioCapture.stop();
    audioCapture = null;
  }
  
  if (ffmpegProcess) {
    ffmpegProcess.stdin?.end();
    // Send 'q' to FFmpeg to finalize
    ffmpegProcess.stdin?.write('q\n');
    ffmpegProcess = null;
  }
}
```

## Notes

- The audio format from WASAPI might vary (sample rate, channels)
- You may need to resample/convert the audio to match FFmpeg's expected format
- Consider using FFmpeg's `-af` filter for resampling if needed






const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;
const AudioEngine = nativeModule.AudioEngine;

// FFmpeg process
let ffmpegProcess = null;

// Create output directory
const outputDir = __dirname;
const outputPath = path.join(outputDir, 'debug_ffmpeg_output_obs_like.mp4');

console.log('🎬 Starting FFmpeg recording test (OBS-like with C++ AudioEngine)...');
console.log('📁 Output will be:', outputPath);

// FFmpeg command
const ffmpegArgs = [
  // Video input (desktop capture)
  '-f', 'gdigrab',
  '-framerate', '30',
  '-i', 'desktop',
  
  // Audio input (from pipe - mixed desktop + mic)
  '-f', 'f32le',  // 32-bit float little-endian
  '-ar', '48000',  // Sample rate (unified format)
  '-ac', '2',  // Stereo
  '-use_wallclock_as_timestamps', '1',  // Use wallclock for timestamps (prevents crackle)
  '-i', 'pipe:0',  // Read from stdin
  
  // Video codec
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-crf', '23',
  '-pix_fmt', 'yuv420p',
  '-r', '30',
  
  // Audio codec
  '-c:a', 'aac',
  '-b:a', '192k',
  '-ar', '48000',
  '-ac', '2',
  
  // Mapping
  '-map', '0:v:0',
  '-map', '1:a:0',
  
  // Output options
  '-shortest',
  '-y',  // Overwrite
  outputPath
];

console.log('🎥 Starting FFmpeg...');
ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
});

let audioBytesSent = 0;
let isRecording = true;
let isWaitingForDrain = false;
let desktopCallbackCount = 0;
let micCallbackCount = 0;

// Handle FFmpeg stdout
ffmpegProcess.stdout.on('data', (data) => {
  // FFmpeg usually writes to stderr, but just in case
});

// Handle FFmpeg stderr (this is where FFmpeg logs)
ffmpegProcess.stderr.on('data', (data) => {
  const output = data.toString();
  if (output.includes('frame=') || output.includes('error') || output.includes('Error')) {
    process.stdout.write(`FFmpeg: ${output}`);
  }
});

// Handle FFmpeg exit
ffmpegProcess.on('exit', (code) => {
  console.log(`\n🎬 FFmpeg exited with code ${code}`);
  if (code === 0) {
    console.log(`✅ Recording saved: ${outputPath}`);
    const stats = fs.statSync(outputPath);
    console.log(`📦 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  } else {
    console.error(`❌ FFmpeg failed with code ${code}`);
  }
  process.exit(code);
});

ffmpegProcess.on('error', (err) => {
  console.error('❌ Failed to start FFmpeg:', err);
  process.exit(1);
});

// Initialize Audio Engine (C++ - OBS-like clock master, mixing, pacing)
console.log('🎵 Initializing Audio Engine (C++)...');
const audioEngine = new AudioEngine();

// Initialize Audio Engine with callback for mixed audio output
const initialized = audioEngine.initialize((mixedBuffer, numFrames) => {
  // This callback is called by AudioEngine when mixed audio is ready
  // mixedBuffer is a Buffer containing float32 samples (interleaved stereo)
  // numFrames is the number of frames (stereo frames = 2 samples per frame)
  
  if (!isRecording || !ffmpegProcess || !ffmpegProcess.stdin) {
    return;
  }

  // Convert Buffer to the format FFmpeg expects (f32le)
  // mixedBuffer is already float32, so we can write it directly
  const bytesPerFrame = 2 * 4; // 2 channels * 4 bytes (float32)
  const bufferSize = numFrames * bytesPerFrame;

  // Ensure buffer size matches
  let audioData = mixedBuffer;
  if (mixedBuffer.length !== bufferSize) {
    // If size doesn't match, create a properly sized buffer
    audioData = Buffer.alloc(bufferSize);
    const copySize = Math.min(mixedBuffer.length, bufferSize);
    mixedBuffer.copy(audioData, 0, 0, copySize);
    // Fill remainder with silence if needed
    if (copySize < bufferSize) {
      audioData.fill(0, copySize);
    }
  }

  try {
    const canWrite = ffmpegProcess.stdin.write(audioData, (err) => {
      if (err) {
        console.error('❌ Error writing to FFmpeg:', err);
        isRecording = false;
        isWaitingForDrain = false;
      }
    });

    if (!canWrite && !isWaitingForDrain) {
      isWaitingForDrain = true;
      ffmpegProcess.stdin.once('drain', () => {
        isWaitingForDrain = false;
      });
    }

    audioBytesSent += audioData.length;
  } catch (err) {
    console.error('❌ Error sending audio to FFmpeg:', err);
    isRecording = false;
    isWaitingForDrain = false;
  }
});

if (!initialized) {
  console.error('❌ Failed to initialize Audio Engine');
  process.exit(1);
}

// Initialize audio capture
console.log('🎤 Initializing WASAPI audio capture...');
const audioCapture = new WASAPICapture((buffer, source, format) => {
  if (!isRecording) {
    return;
  }

  if (!buffer || buffer.length === 0) {
    return;
  }

  // Feed audio data to Audio Engine (C++ handles mixing, pacing, clock master)
  // Buffer contains float32, 48kHz, stereo (already processed by AudioCapture C++)
  const bytesPerFrame = format.channels * (format.bitsPerSample / 8); // 8 bytes for stereo float32
  const numFrames = buffer.length / bytesPerFrame;

  // Convert Buffer to Float32Array for AudioEngine
  // Buffer is already float32, so we can use it directly
  const float32Buffer = Buffer.from(buffer); // Create a copy that AudioEngine can use

  // Feed to Audio Engine
  audioEngine.feedAudioData(float32Buffer, numFrames, source);

  if (source === 'desktop') {
    desktopCallbackCount++;
  } else if (source === 'mic') {
    micCallbackCount++;
  }
}, 'both');

// Get format
const format = audioCapture.getFormat();
if (format) {
  console.log(`🎵 Unified audio format: ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
}

// Start Audio Engine (clock master - OBS-like)
console.log('⏱️ Starting Audio Engine (clock master)...');
const engineStarted = audioEngine.start();
if (!engineStarted) {
  console.error('❌ Failed to start Audio Engine');
  process.exit(1);
}

// Start capture
console.log('⏺ Starting audio capture...');
const captureStarted = audioCapture.start();
if (!captureStarted) {
  console.error('❌ Failed to start audio capture');
  process.exit(1);
}

console.log('✅ Audio capture and engine started');
console.log('⏺ Recording for ~10 seconds...');
console.log('(Press Ctrl+C to stop early)\n');

// Use a timer to tick Audio Engine (every 10ms)
// Audio Engine (C++) handles clock master, pacing, and mixing
const tickInterval = setInterval(() => {
  if (isRecording) {
    audioEngine.tick(); // C++ handles all the logic
  }
}, 10); // 10ms - Audio Engine controls actual send rate

// Record for ~10 seconds
setTimeout(() => {
  console.log('\n🛑 Stopping capture...');
  isRecording = false;
  
  // Stop the tick interval
  clearInterval(tickInterval);
  
  // Final tick to flush any remaining audio
  audioEngine.tick();
  
  // Wait a bit for buffers to flush
  setTimeout(() => {
    const ptsFrames = audioEngine.getCurrentPTSFrames();
    const ptsSeconds = audioEngine.getCurrentPTSSeconds();
    console.log(`📊 Desktop callbacks: ${desktopCallbackCount}`);
    console.log(`📊 Mic callbacks: ${micCallbackCount}`);
    console.log(`📊 Audio Engine PTS: ${ptsFrames} frames (${ptsSeconds.toFixed(2)} seconds)`);
    console.log(`📦 Audio bytes sent to FFmpeg: ${(audioBytesSent / 1024 / 1024).toFixed(2)} MB`);
    
    // Stop Audio Engine
    audioEngine.stop();
    
    // Stop audio capture
    audioCapture.stop();
    
    // Close FFmpeg stdin to signal EOF
    if (ffmpegProcess && ffmpegProcess.stdin) {
      console.log('📝 Closing FFmpeg stdin...');
      ffmpegProcess.stdin.end();
    }
  }, 200);
}, 10000);

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\n\n🛑 Interrupted by user');
  isRecording = false;
  clearInterval(tickInterval);
  audioEngine.tick();
  setTimeout(() => {
    audioEngine.stop();
    audioCapture.stop();
    if (ffmpegProcess && ffmpegProcess.stdin) {
      ffmpegProcess.stdin.end();
    }
    process.exit(0);
  }, 200);
});

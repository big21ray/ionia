const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;

// Audio buffers
let desktopChunks = [];
let micChunks = [];
let desktopFormat = null;
let micFormat = null;
let desktopCallbackCount = 0;
let micCallbackCount = 0;

// FFmpeg process
let ffmpegProcess = null;

// Create output directory
const outputDir = __dirname;
const outputPath = path.join(outputDir, 'debug_ffmpeg_output.mp4');

console.log('🎬 Starting FFmpeg recording test...');
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

// Audio pacing (like OBS) - send audio at a constant rate based on real-time
let pacingStartTime = null;
let pacingFramesSent = 0;
const PACING_SAMPLE_RATE = 48000;
const PACING_CHANNELS = 2;
const PACING_BYTES_PER_FRAME = PACING_CHANNELS * 4; // 2 channels * 4 bytes (float32)
const PACING_FRAMES_PER_10MS = Math.floor(PACING_SAMPLE_RATE / 100); // 480 frames per 10ms

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

// Function to mix desktop and mic audio with pacing (like OBS)
function mixAndSendToFFmpeg() {
  if (!isRecording || !ffmpegProcess || !ffmpegProcess.stdin) {
    return;
  }

  const format = desktopFormat || micFormat;
  if (!format) {
    return;
  }

  // Initialize pacing start time
  if (pacingStartTime === null) {
    pacingStartTime = Date.now();
    pacingFramesSent = 0;
  }

  // Calculate how many frames we should have sent by now (based on real-time)
  const elapsedMs = Date.now() - pacingStartTime;
  const expectedFrames = Math.floor((elapsedMs / 1000) * PACING_SAMPLE_RATE);
  const framesToSend = expectedFrames - pacingFramesSent;

  // Don't send more than we have buffered, and limit to reasonable chunks
  const maxFramesToSend = Math.min(framesToSend, PACING_FRAMES_PER_10MS * 2); // Max 20ms at a time

  if (maxFramesToSend <= 0) {
    return; // Not time to send yet
  }

  const bytesPerFrame = format.channels * (format.bitsPerSample / 8); // 8 bytes for stereo float32
  const desktopPcm = desktopChunks.length > 0 ? Buffer.concat(desktopChunks) : null;
  const micPcm = micChunks.length > 0 ? Buffer.concat(micChunks) : null;

  if (!desktopPcm && !micPcm) {
    return;
  }

  const desktopFrames = desktopPcm ? desktopPcm.length / bytesPerFrame : 0;
  const micFrames = micPcm ? micPcm.length / bytesPerFrame : 0;
  
  // Use the minimum of both to ensure synchronization
  // But also respect pacing - don't send more than we should
  let outputFrames;
  if (desktopFrames === 0 && micFrames === 0) {
    return;
  } else if (desktopFrames === 0) {
    // Only mic - send what we have, but respect pacing
    outputFrames = Math.min(micFrames, maxFramesToSend);
  } else if (micFrames === 0) {
    // Only desktop - send what we have, but respect pacing
    outputFrames = Math.min(desktopFrames, maxFramesToSend);
  } else {
    // Both available - use minimum to ensure alignment, but respect pacing
    outputFrames = Math.min(desktopFrames, micFrames, maxFramesToSend);
  }

  if (outputFrames === 0) {
    return;
  }

  // Mix the two streams - only mix frames that exist in both
  const mixedBuffer = Buffer.alloc(outputFrames * bytesPerFrame);
  const micGain = 0.9; // Slight gain reduction for mic

  for (let frame = 0; frame < outputFrames; frame++) {
    for (let ch = 0; ch < format.channels; ch++) {
      let desktopSample = 0;
      let micSample = 0;

      // Get desktop sample (only if we have desktop data)
      if (desktopPcm && frame < desktopFrames) {
        const offset = frame * bytesPerFrame + ch * (format.bitsPerSample / 8);
        desktopSample = desktopPcm.readFloatLE(offset);
      }

      // Get mic sample (only if we have mic data)
      if (micPcm && frame < micFrames) {
        const offset = frame * bytesPerFrame + ch * (format.bitsPerSample / 8);
        micSample = micPcm.readFloatLE(offset) * micGain;
      }

      // Mix and clamp
      let mixed = desktopSample + micSample;
      if (mixed > 1.0) mixed = 1.0;
      if (mixed < -1.0) mixed = -1.0;

      // Write mixed sample
      const outputOffset = frame * bytesPerFrame + ch * (format.bitsPerSample / 8);
      mixedBuffer.writeFloatLE(mixed, outputOffset);
    }
  }

  // Keep any remaining unaligned frames in buffers for next mix
  const desktopBytesUsed = outputFrames * bytesPerFrame;
  const micBytesUsed = outputFrames * bytesPerFrame;
  
  if (desktopPcm && desktopPcm.length > desktopBytesUsed) {
    // Keep remaining desktop data
    const remaining = desktopPcm.subarray(desktopBytesUsed);
    desktopChunks = [remaining];
  } else {
    desktopChunks = [];
  }
  
  if (micPcm && micPcm.length > micBytesUsed) {
    // Keep remaining mic data
    const remaining = micPcm.subarray(micBytesUsed);
    micChunks = [remaining];
  } else {
    micChunks = [];
  }

  // Send to FFmpeg
  try {
    const canWrite = ffmpegProcess.stdin.write(mixedBuffer, (err) => {
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
        // Try to send more data if available
        mixAndSendToFFmpeg();
      });
    }

    audioBytesSent += mixedBuffer.length;
    
    // Update pacing counter
    pacingFramesSent += outputFrames;
  } catch (err) {
    console.error('❌ Error sending audio to FFmpeg:', err);
    isRecording = false;
    isWaitingForDrain = false;
  }
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

  // Store format info
  if (source === 'desktop') {
    if (!desktopFormat) {
      desktopFormat = format;
      console.log(`🎵 Desktop format (unified): ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
    }
    desktopChunks.push(buffer);
    desktopCallbackCount++;
  } else if (source === 'mic') {
    if (!micFormat) {
      micFormat = format;
      console.log(`🎵 Mic format (unified): ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
    }
    micChunks.push(buffer);
    micCallbackCount++;
  }

  // Don't mix here - let the timer handle it for better synchronization
}, 'both');

// Get format
const format = audioCapture.getFormat();
if (format) {
  console.log(`🎵 Unified audio format: ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
}

// Start capture
console.log('⏺ Starting audio capture...');
const started = audioCapture.start();
if (!started) {
  console.error('❌ Failed to start audio capture');
  process.exit(1);
}

console.log('✅ Audio capture started');
console.log('⏺ Recording for ~10 seconds...');
console.log('(Press Ctrl+C to stop early)\n');

// Use a timer to mix and send audio regularly with pacing (every 10ms)
// This ensures audio is sent at a constant rate based on real-time, like OBS
const mixInterval = setInterval(() => {
  if (isRecording) {
    mixAndSendToFFmpeg();
  }
}, 10); // 10ms - pacing will control actual send rate

// Record for ~10 seconds
setTimeout(() => {
  console.log('\n🛑 Stopping capture...');
  isRecording = false;
  
  // Stop the mixing interval
  clearInterval(mixInterval);
  
  // Mix and send any remaining audio
  mixAndSendToFFmpeg();
  
  // Wait a bit for buffers to flush
  setTimeout(() => {
    console.log(`📊 Desktop callbacks: ${desktopCallbackCount}`);
    console.log(`📊 Mic callbacks: ${micCallbackCount}`);
    console.log(`📦 Audio bytes sent to FFmpeg: ${(audioBytesSent / 1024 / 1024).toFixed(2)} MB`);
    
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
  clearInterval(mixInterval);
  mixAndSendToFFmpeg();
  setTimeout(() => {
    audioCapture.stop();
    if (ffmpegProcess && ffmpegProcess.stdin) {
      ffmpegProcess.stdin.end();
    }
    process.exit(0);
  }, 200);
});


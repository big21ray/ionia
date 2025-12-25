const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;
const AudioEngine = nativeModule.AudioEngine;

// ============================================================================
// DEBUG: Simulate Electron Audio Flow
// ============================================================================
// Ce script simule exactement ce que fait Electron :
// - WASAPICapture → AudioEngine → PCM → FFmpeg stdin
// - Pas d'encodage AAC dans le module natif
// - FFmpeg encode l'audio en AAC
// ============================================================================

console.log('🔍 DEBUG: Simulating Electron Audio Flow');
console.log('   WASAPICapture → AudioEngine → PCM → FFmpeg stdin');
console.log('   Recording for 10 seconds...\n');

// Output file
const outputDir = __dirname;
const outputPath = path.join(outputDir, 'debug_electron_audio.mp4');

// Remove existing file
if (fs.existsSync(outputPath)) {
  fs.unlinkSync(outputPath);
  console.log('🗑️  Removed existing output file');
}

console.log('📁 Output file:', outputPath);

// Statistics
let stats = {
  wasapiCallbacks: { desktop: 0, mic: 0 },
  engineFeeds: { desktop: 0, mic: 0 },
  engineTicks: 0,
  pcmPacketsReceived: 0,
  pcmBytesSent: 0,
  ffmpegErrors: []
};

// Recording state
let isRecording = true;
let recordingStartTime = null;
let ffmpegProcess = null;
let audioEngine = null;
let audioCapture = null;

// ============================================================================
// FFmpeg Setup
// ============================================================================

console.log('🎬 Setting up FFmpeg...');
const ffmpegArgs = [
  // Video input - screen capture
  '-f', 'gdigrab',
  '-framerate', '30',
  '-i', 'desktop',
  
  // Audio input - from pipe (32-bit float little-endian PCM)
  '-f', 'f32le',
  '-ar', '48000',
  '-ac', '2',
  '-use_wallclock_as_timestamps', '1',
  '-i', 'pipe:0',
  
  // Sync flags
  '-async', '1',
  '-vsync', '1',
  
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
  
  // Map streams
  '-map', '0:v:0',
  '-map', '1:a:0',
  
  // Output options
  '-shortest',
  '-movflags', '+frag_keyframe+empty_moov',
  '-f', 'mp4',
  '-y',
  outputPath
];

console.log('FFmpeg command:', 'ffmpeg', ffmpegArgs.join(' '));

ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
});

// Handle FFmpeg errors
if (ffmpegProcess.stderr) {
  ffmpegProcess.stderr.on('data', (data) => {
    const output = data.toString();
    const lines = output.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        if (trimmed.toLowerCase().includes('error') || 
            trimmed.toLowerCase().includes('failed')) {
          console.error('FFmpeg error:', trimmed);
          stats.ffmpegErrors.push(trimmed);
        } else if (trimmed.includes('frame=') || 
                   trimmed.includes('fps=') ||
                   trimmed.includes('size=') ||
                   trimmed.includes('time=')) {
          console.log('FFmpeg:', trimmed);
        }
      }
    }
  });
}

ffmpegProcess.on('error', (error) => {
  console.error('❌ Failed to start FFmpeg:', error);
  process.exit(1);
});

ffmpegProcess.on('close', (code) => {
  console.log(`\n🎬 FFmpeg finished with exit code: ${code}`);
  if (code !== 0) {
    console.error('❌ FFmpeg exited with error');
  }
});

// ============================================================================
// AudioEngine Setup
// ============================================================================

console.log('🎵 Initializing AudioEngine...');

// Check if AudioEngine is available
if (!AudioEngine) {
  console.error('❌ AudioEngine not available!');
  console.error('   Make sure the native module is compiled and loaded');
  process.exit(1);
}

audioEngine = new AudioEngine();

// Initialize AudioEngine with callback that sends PCM to FFmpeg
const audioEngineInitialized = audioEngine.initialize((packet) => {
  // This callback receives AudioPackets (PCM float32) from AudioEngine
  if (!isRecording || !ffmpegProcess?.stdin || ffmpegProcess.stdin.destroyed) {
    return;
  }

  const stdin = ffmpegProcess.stdin;
  if (stdin.writableEnded) {
    isRecording = false;
    return;
  }

  // Extract PCM data from AudioPacket
  const pcmData = packet.data; // Buffer containing float32 PCM
  if (!pcmData || pcmData.length === 0) {
    return;
  }

  stats.pcmPacketsReceived++;
  stats.pcmBytesSent += pcmData.length;

  // Send PCM data to FFmpeg
  try {
    const canWrite = stdin.write(pcmData, (err) => {
      if (err) {
        console.warn('Audio write error:', err.message || err);
        isRecording = false;
      }
    });

    if (!canWrite) {
      stdin.once('drain', () => {
        // Continue after drain
      });
    }
  } catch (err) {
    console.error('❌ Error sending audio to FFmpeg:', err);
    isRecording = false;
  }
});

if (!audioEngineInitialized) {
  console.error('❌ Failed to initialize AudioEngine');
  console.error('   Possible causes:');
  console.error('   - Callback function issue');
  console.error('   - AudioEngine internal error');
  process.exit(1);
}

console.log('✅ AudioEngine initialized successfully\n');

// ============================================================================
// WASAPI Capture Setup
// ============================================================================

console.log('🎤 Initializing WASAPI capture...');

audioCapture = new WASAPICapture((buffer, source, format) => {
  if (!isRecording || !audioEngine) {
    return;
  }

  if (!buffer || buffer.length === 0) {
    return;
  }

  stats.wasapiCallbacks[source]++;

  // Feed audio data to AudioEngine (it will handle mixing and pacing)
  const bytesPerFrame = format.channels * (format.bitsPerSample / 8);
  const numFrames = buffer.length / bytesPerFrame;
  audioEngine.feedAudioData(buffer, numFrames, source);
  stats.engineFeeds[source]++;
}, 'both');

// Get format info
const format = audioCapture.getFormat();
if (format) {
  console.log(`✅ WASAPI Capture initialized`);
  console.log(`   Format: ${format.sampleRate} Hz, ${format.channels} channels, ${format.bitsPerSample} bits\n`);
} else {
  console.error('❌ Failed to get format from WASAPI capture');
  process.exit(1);
}

// ============================================================================
// Start Recording
// ============================================================================

console.log('🎙️  Starting recording...\n');

// Start AudioEngine first
if (!audioEngine.start()) {
  console.error('❌ Failed to start AudioEngine');
  process.exit(1);
}
console.log('✅ AudioEngine started');

// Start WASAPI capture
if (!audioCapture.start()) {
  console.error('❌ Failed to start WASAPI capture');
  process.exit(1);
}
console.log('✅ WASAPI capture started\n');

recordingStartTime = Date.now();
console.log('✅ Recording started, will record for 10 seconds...\n');

// Tick AudioEngine every 10ms (OBS-like)
const tickInterval = setInterval(() => {
  if (!isRecording) {
    clearInterval(tickInterval);
    return;
  }
  
  try {
    if (audioEngine) {
      audioEngine.tick();
      stats.engineTicks++;
    }
    
    // Log progress every second
    const elapsed = Date.now() - recordingStartTime;
    if (elapsed > 0 && elapsed % 1000 < 10) {
      const elapsedSeconds = (elapsed / 1000).toFixed(1);
      const pts = audioEngine ? audioEngine.getCurrentPTSSeconds() : 0;
      
      console.log(`⏱️  ${elapsedSeconds}s - WASAPI: desktop=${stats.wasapiCallbacks.desktop}, mic=${stats.wasapiCallbacks.mic}, Engine feeds: desktop=${stats.engineFeeds.desktop}, mic=${stats.engineFeeds.mic}, Ticks: ${stats.engineTicks}, PCM packets: ${stats.pcmPacketsReceived}, PCM bytes: ${(stats.pcmBytesSent/1024).toFixed(1)}KB, PTS: ${pts.toFixed(3)}s`);
    }
  } catch (error) {
    console.error('❌ Error in tick interval:', error);
  }
}, 10); // 10ms tick interval

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  isRecording = false;
  clearInterval(tickInterval);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection:', reason);
  isRecording = false;
  clearInterval(tickInterval);
  process.exit(1);
});

// Record for 10 seconds
console.log('⏳ Waiting 10 seconds...\n');
setTimeout(() => {
  console.log('\n⏹️  Stopping recording...\n');
  isRecording = false;
  
  clearInterval(tickInterval);
  
  // Final tick to flush
  if (audioEngine) {
    audioEngine.tick();
  }
  
  // Wait a bit for flush
  setTimeout(() => {
    // Stop AudioEngine
    if (audioEngine) {
      audioEngine.stop();
      console.log('✅ AudioEngine stopped');
    }
    
    // Stop capture
    if (audioCapture) {
      audioCapture.stop();
      console.log('✅ WASAPI capture stopped');
    }
    
    // Close FFmpeg stdin
    if (ffmpegProcess && ffmpegProcess.stdin) {
      ffmpegProcess.stdin.end(() => {
        console.log('✅ FFmpeg stdin closed');
      });
    }
    
    // Wait for FFmpeg to finish
    setTimeout(() => {
      console.log('\n📊 Final Statistics:');
      console.log(`   WASAPI callbacks: desktop=${stats.wasapiCallbacks.desktop}, mic=${stats.wasapiCallbacks.mic}`);
      console.log(`   Engine feeds: desktop=${stats.engineFeeds.desktop}, mic=${stats.engineFeeds.mic}`);
      console.log(`   Engine ticks: ${stats.engineTicks}`);
      console.log(`   PCM packets received: ${stats.pcmPacketsReceived}`);
      console.log(`   PCM bytes sent to FFmpeg: ${(stats.pcmBytesSent / 1024 / 1024).toFixed(2)} MB`);
      
      if (stats.ffmpegErrors.length > 0) {
        console.log(`\n⚠️  FFmpeg errors (${stats.ffmpegErrors.length}):`);
        stats.ffmpegErrors.slice(0, 5).forEach(err => console.log(`   - ${err}`));
      }
      
      // Check output file
      if (fs.existsSync(outputPath)) {
        const fileStats = fs.statSync(outputPath);
        console.log(`\n✅ Output file: ${outputPath}`);
        console.log(`   Size: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);
      } else {
        console.log(`\n❌ Output file not found: ${outputPath}`);
      }
      
      console.log('\n🎉 Debug complete!');
      
      process.exit(0);
    }, 2000); // Wait 2 seconds for FFmpeg to finalize
  }, 500); // Wait 500ms after stop
}, 10000); // 10 seconds


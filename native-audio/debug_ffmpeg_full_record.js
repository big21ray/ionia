const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;
const AudioEngine = nativeModule.AudioEngine;

// ============================================================================
// DEBUG: Full FFmpeg Recording Test
// ============================================================================
// Ce script teste le flux complet Electron :
// - Vidéo : FFmpeg gdigrab (screen capture)
// - Audio Desktop + Microphone : WASAPI → AudioEngine → PCM → FFmpeg stdin
// - FFmpeg muxe tout dans un fichier MP4
// ============================================================================

console.log('🔍 DEBUG: Full FFmpeg Recording Test');
console.log('   Video: FFmpeg gdigrab (screen capture)');
console.log('   Audio: WASAPI → AudioEngine → PCM → FFmpeg stdin');
console.log('   Output: MP4 file with video + desktop audio + microphone audio');
console.log('   Recording for 10 seconds...\n');

// Output file
const outputDir = __dirname;
const outputPath = path.join(outputDir, 'debug_ffmpeg_full_record.mp4');

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
  ffmpegErrors: [],
  ffmpegFrames: 0,
  ffmpegTime: null
};

// Recording state
let isRecording = true;
let recordingStartTime = null;
let ffmpegProcess = null;
let audioEngine = null;
let audioCapture = null;
let audioWriteErrorLogged = false;

// ============================================================================
// FFmpeg Setup
// ============================================================================

console.log('🎬 Setting up FFmpeg...');
const ffmpegArgs = [
  // Video input - screen capture (gdigrab)
  '-f', 'gdigrab',
  '-framerate', '30',
  '-i', 'desktop',
  
  // Audio input - from pipe (32-bit float little-endian PCM)
  // Format: 48000 Hz, 2 channels (stereo), float32
  '-f', 'f32le',
  '-ar', '48000',
  '-ac', '2',
  '-use_wallclock_as_timestamps', '1',
  '-i', 'pipe:0',
  
  // Sync flags
  '-async', '1',
  '-vsync', '1',
  
  // Video codec settings
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-crf', '23',
  '-pix_fmt', 'yuv420p',
  '-r', '30',
  
  // Audio codec settings
  '-c:a', 'aac',
  '-b:a', '192k',
  '-ar', '48000',
  '-ac', '2',
  
  // Map streams: video from input 0, audio from input 1
  '-map', '0:v:0',
  '-map', '1:a:0',
  
  // Output options
  '-shortest',  // Stop when shortest stream ends
  '-movflags', '+frag_keyframe+empty_moov',  // Fragmented MP4
  '-f', 'mp4',
  '-y',  // Overwrite output
  outputPath
];

console.log('FFmpeg command:', 'ffmpeg', ffmpegArgs.join(' '));
console.log('');

ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
});

// Handle FFmpeg stdout (usually empty for MP4)
if (ffmpegProcess.stdout) {
  ffmpegProcess.stdout.on('data', (data) => {
    // Usually empty for MP4 output
  });
}

// Handle FFmpeg stderr (FFmpeg outputs to stderr)
if (ffmpegProcess.stderr) {
  ffmpegProcess.stderr.on('data', (data) => {
    const output = data.toString();
    const lines = output.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        // Parse frame info
        const frameMatch = trimmed.match(/frame=\s*(\d+)/);
        if (frameMatch) {
          stats.ffmpegFrames = parseInt(frameMatch[1]);
        }
        
        // Parse time info
        const timeMatch = trimmed.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          const seconds = parseFloat(timeMatch[3]);
          stats.ffmpegTime = hours * 3600 + minutes * 60 + seconds;
        }
        
        // Log important lines
        if (trimmed.toLowerCase().includes('error') || 
            trimmed.toLowerCase().includes('failed') ||
            trimmed.toLowerCase().includes('cannot') ||
            trimmed.toLowerCase().includes('unable')) {
          console.error('❌ FFmpeg error:', trimmed);
          stats.ffmpegErrors.push(trimmed);
        } else if (trimmed.includes('frame=') || 
                   trimmed.includes('fps=') ||
                   trimmed.includes('size=') ||
                   trimmed.includes('time=') ||
                   trimmed.includes('bitrate=')) {
          // Log progress every second or so
          if (trimmed.includes('time=')) {
            console.log('📹 FFmpeg:', trimmed);
          }
        }
      }
    }
  });
}

ffmpegProcess.on('error', (error) => {
  console.error('❌ Failed to start FFmpeg:', error);
  console.error('   Make sure FFmpeg is installed and in your PATH');
  process.exit(1);
});

ffmpegProcess.on('close', (code) => {
  console.log(`\n🎬 FFmpeg finished with exit code: ${code}`);
  if (code !== 0) {
    console.error('❌ FFmpeg exited with error');
    if (stats.ffmpegErrors.length > 0) {
      console.error('   Errors:');
      stats.ffmpegErrors.slice(0, 5).forEach(err => console.error(`   - ${err}`));
    }
  } else {
    console.log('✅ FFmpeg completed successfully');
  }
});

// Handle stdin errors
if (ffmpegProcess.stdin) {
  ffmpegProcess.stdin.on('error', (err) => {
    const code = err?.code || '';
    if (code === 'EPIPE' || code === 'EOF') {
      if (!audioWriteErrorLogged) {
        console.warn('⚠️  FFmpeg stdin closed (EPIPE/EOF) - this is normal when FFmpeg finishes');
        audioWriteErrorLogged = true;
      }
      isRecording = false;
      return;
    }
    console.error('❌ Unexpected stdin error:', err);
  });
}

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
        if (!audioWriteErrorLogged) {
          console.warn('⚠️  Audio write error:', err.message || err);
          audioWriteErrorLogged = true;
        }
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
}, 'both');  // Capture both desktop and microphone

// Get format info
const format = audioCapture.getFormat();
if (format) {
  console.log(`✅ WASAPI Capture initialized`);
  console.log(`   Format: ${format.sampleRate} Hz, ${format.channels} channels, ${format.bitsPerSample} bits`);
  console.log(`   Mode: both (desktop + microphone)\n`);
} else {
  console.error('❌ Failed to get format from WASAPI capture');
  process.exit(1);
}

// ============================================================================
// Start Recording
// ============================================================================

console.log('🎙️  Starting recording...\n');

// Start AudioEngine first (clock master)
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
console.log('📊 Progress will be logged every second:\n');

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
      
      console.log(`⏱️  ${elapsedSeconds}s - WASAPI: desktop=${stats.wasapiCallbacks.desktop}, mic=${stats.wasapiCallbacks.mic} | ` +
                  `Engine: feeds=${stats.engineFeeds.desktop + stats.engineFeeds.mic}, ticks=${stats.engineTicks} | ` +
                  `PCM: packets=${stats.pcmPacketsReceived}, bytes=${(stats.pcmBytesSent/1024/1024).toFixed(2)}MB | ` +
                  `PTS: ${pts.toFixed(3)}s | ` +
                  `FFmpeg: frames=${stats.ffmpegFrames}, time=${stats.ffmpegTime ? stats.ffmpegTime.toFixed(1) + 's' : 'N/A'}`);
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
      console.log(`   FFmpeg frames encoded: ${stats.ffmpegFrames}`);
      console.log(`   FFmpeg time: ${stats.ffmpegTime ? stats.ffmpegTime.toFixed(2) + 's' : 'N/A'}`);
      
      if (stats.ffmpegErrors.length > 0) {
        console.log(`\n⚠️  FFmpeg errors (${stats.ffmpegErrors.length}):`);
        stats.ffmpegErrors.slice(0, 5).forEach(err => console.log(`   - ${err}`));
      }
      
      // Check output file
      console.log('\n📁 Checking output file...');
      if (fs.existsSync(outputPath)) {
        const fileStats = fs.statSync(outputPath);
        console.log(`✅ Output file: ${outputPath}`);
        console.log(`   Size: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);
        
        if (fileStats.size === 0) {
          console.error('❌ ERROR: File exists but is empty!');
        } else {
          // Check MP4 structure
          const buffer = Buffer.alloc(Math.min(1024, fileStats.size));
          const fd = fs.openSync(outputPath, 'r');
          fs.readSync(fd, buffer, 0, buffer.length, 0);
          fs.closeSync(fd);
          
          const boxType = buffer.toString('ascii', 4, 8);
          if (boxType === 'ftyp') {
            console.log(`   ✅ Valid MP4 file (starts with 'ftyp' box)`);
          } else {
            console.error(`   ❌ Invalid MP4 file (box type: ${boxType})`);
          }
        }
      } else {
        console.error(`❌ Output file not found: ${outputPath}`);
      }
      
      console.log('\n🎉 Test complete!');
      console.log('   Review the statistics above to verify recording worked correctly.');
      console.log(`   You can play the file with: ${outputPath}`);
      
      process.exit(0);
    }, 3000); // Wait 3 seconds for FFmpeg to finalize
  }, 500); // Wait 500ms after stop
}, 10000); // 10 seconds




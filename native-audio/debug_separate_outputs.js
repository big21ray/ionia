const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;
const AudioEngineEncoder = nativeModule.AudioEngineEncoder;

// ============================================================================
// DEBUG: Separate Outputs Test
// ============================================================================
// Ce script génère deux fichiers séparés :
// 1. output_screen.mp4 : Vidéo seule (FFmpeg gdigrab)
// 2. output_both.mp4 : Audio seul (desktop + microphone mixé via AudioEngineEncoder)
// ============================================================================

console.log('🔍 DEBUG: Separate Outputs Test');
console.log('   Output 1: output_screen.mp4 (video only)');
console.log('   Output 2: output_both.mp4 (audio only - desktop + microphone)');
console.log('   Recording for 10 seconds...\n');

// Output files
const outputDir = __dirname;
const videoOutputPath = path.join(outputDir, 'output_screen.mp4');
const audioOutputPath = path.join(outputDir, 'output_both.mp4');

// Remove existing files
if (fs.existsSync(videoOutputPath)) {
  fs.unlinkSync(videoOutputPath);
  console.log('🗑️  Removed existing video file');
}
if (fs.existsSync(audioOutputPath)) {
  fs.unlinkSync(audioOutputPath);
  console.log('🗑️  Removed existing audio file');
}

console.log('📁 Video output:', videoOutputPath);
console.log('📁 Audio output:', audioOutputPath);
console.log('');

// Statistics
let stats = {
  video: {
    ffmpegFrames: 0,
    ffmpegTime: null,
    errors: []
  },
  audio: {
    wasapiCallbacks: { desktop: 0, mic: 0 },
    engineFeeds: { desktop: 0, mic: 0 },
    engineTicks: 0,
    encodedPackets: 0,
    encodedBytes: 0,
    muxedPackets: 0,
    muxedBytes: 0
  }
};

// Recording state
let isRecording = true;
let recordingStartTime = null;
let ffmpegVideoProcess = null;
let audioEngineEncoder = null;
let audioCapture = null;

// ============================================================================
// FFmpeg Video Setup (video only, no audio)
// ============================================================================

console.log('🎬 Setting up FFmpeg for video capture...');
const ffmpegVideoArgs = [
  // Video input - screen capture (gdigrab)
  '-f', 'gdigrab',
  '-framerate', '30',
  '-i', 'desktop',
  
  // Limit duration to 10 seconds
  '-t', '10',
  
  // Video codec settings
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-crf', '23',
  '-pix_fmt', 'yuv420p',
  '-r', '30',
  
  // No audio (video only)
  '-an',
  
  // Output options
  '-movflags', '+frag_keyframe+empty_moov',  // Fragmented MP4
  '-f', 'mp4',
  '-y',  // Overwrite output
  videoOutputPath
];

console.log('FFmpeg video command:', 'ffmpeg', ffmpegVideoArgs.join(' '));
console.log('');

ffmpegVideoProcess = spawn('ffmpeg', ffmpegVideoArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
});

// Handle FFmpeg video stderr
if (ffmpegVideoProcess.stderr) {
  ffmpegVideoProcess.stderr.on('data', (data) => {
    const output = data.toString();
    const lines = output.split('\n');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed) {
        // Parse frame info
        const frameMatch = trimmed.match(/frame=\s*(\d+)/);
        if (frameMatch) {
          stats.video.ffmpegFrames = parseInt(frameMatch[1]);
        }
        
        // Parse time info
        const timeMatch = trimmed.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (timeMatch) {
          const hours = parseInt(timeMatch[1]);
          const minutes = parseInt(timeMatch[2]);
          const seconds = parseFloat(timeMatch[3]);
          stats.video.ffmpegTime = hours * 3600 + minutes * 60 + seconds;
        }
        
        // Log errors
        if (trimmed.toLowerCase().includes('error') || 
            trimmed.toLowerCase().includes('failed')) {
          console.error('❌ FFmpeg video error:', trimmed);
          stats.video.errors.push(trimmed);
        } else if (trimmed.includes('frame=') && trimmed.includes('time=')) {
          console.log('📹 Video:', trimmed);
        }
      }
    }
  });
}

ffmpegVideoProcess.on('error', (error) => {
  console.error('❌ Failed to start FFmpeg video:', error);
});

ffmpegVideoProcess.on('close', (code) => {
  console.log(`\n🎬 FFmpeg video finished with exit code: ${code}`);
  if (code !== 0 && code !== null) {
    console.error('❌ FFmpeg video exited with error');
  } else {
    console.log('✅ FFmpeg video completed successfully');
  }
});

// ============================================================================
// AudioEngineEncoder Setup (audio only, MP4 output)
// ============================================================================

console.log('🎵 Initializing AudioEngineEncoder for audio capture...');

// Check if AudioEngineEncoder is available
if (!AudioEngineEncoder) {
  console.error('❌ AudioEngineEncoder not available!');
  console.error('   Make sure the native module is compiled and loaded');
  process.exit(1);
}

audioEngineEncoder = new AudioEngineEncoder();

// Initialize with MP4 output (useRawAac = false)
const audioInitialized = audioEngineEncoder.initialize(audioOutputPath, 192000, false);
if (!audioInitialized) {
  console.error('❌ Failed to initialize AudioEngineEncoder');
  console.error('   Possible causes:');
  console.error('   - FFmpeg libraries not found');
  console.error('   - Invalid output path');
  console.error('   - Codec initialization failed');
  process.exit(1);
}

console.log(`✅ AudioEngineEncoder initialized`);
console.log(`   Output: ${audioOutputPath}`);
console.log(`   Bitrate: 192 kbps\n`);

// ============================================================================
// WASAPI Capture Setup
// ============================================================================

console.log('🎤 Initializing WASAPI capture...');

audioCapture = new WASAPICapture((buffer, source, format) => {
  if (!isRecording || !audioEngineEncoder) {
    return;
  }

  if (!buffer || buffer.length === 0) {
    return;
  }

  stats.audio.wasapiCallbacks[source]++;

  // Feed audio data to AudioEngineEncoder
  const bytesPerFrame = format.channels * (format.bitsPerSample / 8);
  const numFrames = buffer.length / bytesPerFrame;
  audioEngineEncoder.feedAudioData(buffer, numFrames, source);
  stats.audio.engineFeeds[source]++;
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

// Start AudioEngineEncoder
if (!audioEngineEncoder.start()) {
  console.error('❌ Failed to start AudioEngineEncoder');
  process.exit(1);
}
console.log('✅ AudioEngineEncoder started');

// Start WASAPI capture
if (!audioCapture.start()) {
  console.error('❌ Failed to start WASAPI capture');
  process.exit(1);
}
console.log('✅ WASAPI capture started\n');

recordingStartTime = Date.now();
console.log('✅ Recording started, will record for 10 seconds...\n');
console.log('📊 Progress will be logged every second:\n');

// Tick AudioEngineEncoder every 10ms
const tickInterval = setInterval(() => {
  if (!isRecording) {
    clearInterval(tickInterval);
    return;
  }
  
  try {
    if (audioEngineEncoder) {
      audioEngineEncoder.tick();
      stats.audio.engineTicks++;
      
      // Update statistics
      stats.audio.encodedPackets = audioEngineEncoder.getEncodedPackets();
      stats.audio.encodedBytes = audioEngineEncoder.getEncodedBytes();
      stats.audio.muxedPackets = audioEngineEncoder.getMuxedPackets();
      stats.audio.muxedBytes = audioEngineEncoder.getMuxedBytes();
    }
    
    // Log progress every second
    const elapsed = Date.now() - recordingStartTime;
    if (elapsed > 0 && elapsed % 1000 < 10) {
      const elapsedSeconds = (elapsed / 1000).toFixed(1);
      const pts = audioEngineEncoder ? audioEngineEncoder.getCurrentPTSSeconds() : 0;
      
      console.log(`⏱️  ${elapsedSeconds}s - ` +
                  `Video: frames=${stats.video.ffmpegFrames}, time=${stats.video.ffmpegTime ? stats.video.ffmpegTime.toFixed(1) + 's' : 'N/A'} | ` +
                  `Audio: WASAPI desktop=${stats.audio.wasapiCallbacks.desktop}, mic=${stats.audio.wasapiCallbacks.mic} | ` +
                  `Engine ticks=${stats.audio.engineTicks} | ` +
                  `Encoded: ${stats.audio.encodedPackets} packets (${(stats.audio.encodedBytes/1024).toFixed(1)}KB) | ` +
                  `Muxed: ${stats.audio.muxedPackets} packets (${(stats.audio.muxedBytes/1024).toFixed(1)}KB) | ` +
                  `PTS: ${pts.toFixed(3)}s`);
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
  if (audioEngineEncoder) {
    audioEngineEncoder.tick();
  }
  
  // Wait a bit for flush
  setTimeout(() => {
    // Stop AudioEngineEncoder
    if (audioEngineEncoder) {
      audioEngineEncoder.stop();
      console.log('✅ AudioEngineEncoder stopped');
    }
    
    // Stop capture
    if (audioCapture) {
      audioCapture.stop();
      console.log('✅ WASAPI capture stopped');
    }
    
    // FFmpeg video will stop automatically after 10 seconds (due to -t 10)
    // Just wait for it to finish naturally
    console.log('⏳ Waiting for FFmpeg video to finish (it will stop automatically after 10s)...');
    
    // Wait for processes to finish
    setTimeout(() => {
      // Final statistics
      stats.audio.encodedPackets = audioEngineEncoder ? audioEngineEncoder.getEncodedPackets() : 0;
      stats.audio.encodedBytes = audioEngineEncoder ? audioEngineEncoder.getEncodedBytes() : 0;
      stats.audio.muxedPackets = audioEngineEncoder ? audioEngineEncoder.getMuxedPackets() : 0;
      stats.audio.muxedBytes = audioEngineEncoder ? audioEngineEncoder.getMuxedBytes() : 0;
      
      console.log('\n📊 Final Statistics:');
      console.log('\n📹 Video:');
      console.log(`   FFmpeg frames encoded: ${stats.video.ffmpegFrames}`);
      console.log(`   FFmpeg time: ${stats.video.ffmpegTime ? stats.video.ffmpegTime.toFixed(2) + 's' : 'N/A'}`);
      if (stats.video.errors.length > 0) {
        console.log(`   Errors: ${stats.video.errors.length}`);
        stats.video.errors.slice(0, 3).forEach(err => console.log(`     - ${err}`));
      }
      
      console.log('\n🎵 Audio:');
      console.log(`   WASAPI callbacks: desktop=${stats.audio.wasapiCallbacks.desktop}, mic=${stats.audio.wasapiCallbacks.mic}`);
      console.log(`   Engine feeds: desktop=${stats.audio.engineFeeds.desktop}, mic=${stats.audio.engineFeeds.mic}`);
      console.log(`   Engine ticks: ${stats.audio.engineTicks}`);
      console.log(`   Encoded packets: ${stats.audio.encodedPackets}`);
      console.log(`   Encoded bytes: ${(stats.audio.encodedBytes / 1024 / 1024).toFixed(2)} MB`);
      console.log(`   Muxed packets: ${stats.audio.muxedPackets}`);
      console.log(`   Muxed bytes: ${(stats.audio.muxedBytes / 1024 / 1024).toFixed(2)} MB`);
      
      // Check output files
      console.log('\n📁 Checking output files...');
      
      // Video file
      if (fs.existsSync(videoOutputPath)) {
        const fileStats = fs.statSync(videoOutputPath);
        console.log(`✅ Video file: ${videoOutputPath}`);
        console.log(`   Size: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);
        
        if (fileStats.size === 0) {
          console.error('   ❌ ERROR: File exists but is empty!');
        } else {
          const buffer = Buffer.alloc(Math.min(1024, fileStats.size));
          const fd = fs.openSync(videoOutputPath, 'r');
          fs.readSync(fd, buffer, 0, buffer.length, 0);
          fs.closeSync(fd);
          const boxType = buffer.toString('ascii', 4, 8);
          if (boxType === 'ftyp') {
            console.log(`   ✅ Valid MP4 file`);
          } else {
            console.error(`   ❌ Invalid MP4 file (box type: ${boxType})`);
          }
        }
      } else {
        console.error(`❌ Video file not found: ${videoOutputPath}`);
      }
      
      // Audio file
      if (fs.existsSync(audioOutputPath)) {
        const fileStats = fs.statSync(audioOutputPath);
        console.log(`✅ Audio file: ${audioOutputPath}`);
        console.log(`   Size: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);
        
        if (fileStats.size === 0) {
          console.error('   ❌ ERROR: File exists but is empty!');
        } else {
          const buffer = Buffer.alloc(Math.min(1024, fileStats.size));
          const fd = fs.openSync(audioOutputPath, 'r');
          fs.readSync(fd, buffer, 0, buffer.length, 0);
          fs.closeSync(fd);
          const boxType = buffer.toString('ascii', 4, 8);
          if (boxType === 'ftyp') {
            console.log(`   ✅ Valid MP4 file`);
          } else {
            console.error(`   ❌ Invalid MP4 file (box type: ${boxType})`);
          }
        }
      } else {
        console.error(`❌ Audio file not found: ${audioOutputPath}`);
      }
      
      console.log('\n🎉 Test complete!');
      console.log(`   Video file: ${videoOutputPath}`);
      console.log(`   Audio file: ${audioOutputPath}`);
      console.log('   You can play both files to verify they work correctly.');
      
      process.exit(0);
    }, 3000); // Wait 3 seconds for processes to finalize
  }, 500); // Wait 500ms after stop
}, 10000); // 10 seconds


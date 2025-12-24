const path = require('path');
const fs = require('fs');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;
const VideoRecorder = nativeModule.VideoRecorder;

// ============================================================================
// DEBUG: Video Recorder Test (Native C++ Implementation)
// ============================================================================
// Ce script teste le VideoRecorder natif C++ qui combine :
// - Desktop Duplication (DXGI) pour capture vidéo
// - Video Encoder (NVENC/x264) pour encoder H.264
// - Audio Engine + Encoder pour capturer et encoder audio
// - Video Muxer pour combiner vidéo + audio dans un MP4
// ============================================================================

console.log('🔍 DEBUG: Video Recorder Test (Native C++)');
console.log('   Video: DXGI Desktop Duplication → H.264 Encoder');
console.log('   Audio: WASAPI → AudioEngine → AAC Encoder');
console.log('   Output: MP4 file with video + audio');
console.log('   Recording for 10 seconds...\n');

// Output file
const outputDir = __dirname;
const outputPath = path.join(outputDir, 'debug_video_recorder.mp4');

// Remove existing file
if (fs.existsSync(outputPath)) {
  fs.unlinkSync(outputPath);
  console.log('🗑️  Removed existing output file');
}

console.log('📁 Output file:', outputPath);
console.log('');

// Statistics
let stats = {
  wasapiCallbacks: { desktop: 0, mic: 0 },
  videoFrames: 0,
  videoPackets: 0,
  audioPackets: 0
};

// Recording state
let isRecording = true;
let recordingStartTime = null;
let videoRecorder = null;
let audioCapture = null;

// ============================================================================
// Video Recorder Setup
// ============================================================================

console.log('🎬 Initializing Video Recorder...');

if (!VideoRecorder) {
  console.error('❌ VideoRecorder not available!');
  console.error('   Make sure the native module is compiled with video support');
  process.exit(1);
}

videoRecorder = new VideoRecorder();

// Initialize Video Recorder
// Parameters: outputPath, fps, videoBitrate, audioBitrate, useNvenc
const initialized = videoRecorder.initialize(
  outputPath,
  30,        // fps
  5000000,   // video bitrate (5 Mbps)
  192000,    // audio bitrate (192 kbps)
  true       // use NVENC (if available, falls back to x264)
);

if (!initialized) {
  console.error('❌ Failed to initialize Video Recorder');
  console.error('   Possible causes:');
  console.error('   - DXGI Desktop Duplication not available');
  console.error('   - Video encoder initialization failed');
  console.error('   - Audio engine initialization failed');
  console.error('   - FFmpeg libraries not found');
  process.exit(1);
}

console.log('✅ Video Recorder initialized');
console.log('');

// ============================================================================
// WASAPI Capture Setup
// ============================================================================

console.log('🎤 Initializing WASAPI capture...');

audioCapture = new WASAPICapture((buffer, source, format) => {
  if (!isRecording || !videoRecorder) {
    return;
  }

  if (!buffer || buffer.length === 0) {
    return;
  }

  stats.wasapiCallbacks[source]++;

  // Feed audio data to Video Recorder
  const bytesPerFrame = format.channels * (format.bitsPerSample / 8);
  const numFrames = buffer.length / bytesPerFrame;
  
  // VideoRecorder expects float32 data
  videoRecorder.feedAudioData(buffer, numFrames, source);
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

// Start WASAPI capture first
if (!audioCapture.start()) {
  console.error('❌ Failed to start WASAPI capture');
  process.exit(1);
}
console.log('✅ WASAPI capture started');

// Start Video Recorder
if (!videoRecorder.start()) {
  console.error('❌ Failed to start Video Recorder');
  process.exit(1);
}
console.log('✅ Video Recorder started\n');

recordingStartTime = Date.now();
console.log('✅ Recording started, will record for 10 seconds...\n');
console.log('📊 Progress will be logged every second:\n');

// Log progress every second
const progressInterval = setInterval(() => {
  if (!isRecording) {
    clearInterval(progressInterval);
    return;
  }

  try {
    const elapsed = Date.now() - recordingStartTime;
    const elapsedSeconds = (elapsed / 1000).toFixed(1);
    const pts = videoRecorder.getCurrentPTSSeconds();
    const recorderStats = videoRecorder.getStatistics();

    console.log(`⏱️  ${elapsedSeconds}s - ` +
                `WASAPI: desktop=${stats.wasapiCallbacks.desktop}, mic=${stats.wasapiCallbacks.mic} | ` +
                `Video: frames=${recorderStats.videoFramesCaptured}, packets=${recorderStats.videoPacketsEncoded} | ` +
                `Audio: packets=${recorderStats.audioPacketsEncoded} | ` +
                `PTS: ${pts.toFixed(3)}s`);
  } catch (error) {
    console.error('❌ Error getting statistics:', error);
  }
}, 1000);

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  isRecording = false;
  clearInterval(progressInterval);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('❌ Unhandled rejection:', reason);
  isRecording = false;
  clearInterval(progressInterval);
  process.exit(1);
});

// Record for 10 seconds
console.log('⏳ Waiting 10 seconds...\n');
setTimeout(() => {
  console.log('\n⏹️  Stopping recording...\n');
  isRecording = false;
  
  clearInterval(progressInterval);
  
  // Stop Video Recorder
  if (videoRecorder) {
    videoRecorder.stop();
    console.log('✅ Video Recorder stopped');
  }
  
  // Stop capture
  if (audioCapture) {
    audioCapture.stop();
    console.log('✅ WASAPI capture stopped');
  }
  
  // Wait a bit for finalization
  setTimeout(() => {
    // Final statistics
    const recorderStats = videoRecorder.getStatistics();
    
    console.log('\n📊 Final Statistics:');
    console.log(`   WASAPI callbacks: desktop=${stats.wasapiCallbacks.desktop}, mic=${stats.wasapiCallbacks.mic}`);
    console.log(`   Video frames captured: ${recorderStats.videoFramesCaptured}`);
    console.log(`   Video packets encoded: ${recorderStats.videoPacketsEncoded}`);
    console.log(`   Audio packets encoded: ${recorderStats.audioPacketsEncoded}`);
    console.log(`   Video packets muxed: ${recorderStats.videoPacketsMuxed}`);
    console.log(`   Audio packets muxed: ${recorderStats.audioPacketsMuxed}`);
    console.log(`   Total bytes: ${(recorderStats.totalBytes / 1024 / 1024).toFixed(2)} MB`);
    
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
    console.log(`   You can play the file with: ${outputPath}`);
    
    process.exit(0);
  }, 2000); // Wait 2 seconds for finalization
}, 10000); // 10 seconds



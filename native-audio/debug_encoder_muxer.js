const path = require('path');
const fs = require('fs');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;
const AudioEngineEncoder = nativeModule.AudioEngineEncoder;

console.log('🎬 Testing Audio Engine with AAC Encoding and MP4 Muxing (OBS-like)...');
console.log('   - AudioEngine: clock master, mixing, pacing');
console.log('   - AudioEncoder: PCM → AAC (libavcodec)');
console.log('   - AudioMuxer: AAC → MP4 (libavformat)');
console.log('   - PTS Control: explicit from AudioEngine\n');

// Output file
const outputDir = __dirname;
const outputPath = path.join(outputDir, 'debug_encoder_muxer_output.mp4');

// Remove existing file if it exists
if (fs.existsSync(outputPath)) {
  fs.unlinkSync(outputPath);
  console.log('🗑️  Removed existing output file');
}

console.log('📁 Output will be:', outputPath);

// Statistics
let desktopCallbackCount = 0;
let micCallbackCount = 0;
let isRecording = false;

// Initialize Audio Engine with Encoder and Muxer
console.log('🎵 Initializing Audio Engine with Encoder and Muxer...');
const audioEngine = new AudioEngineEncoder();

// Initialize with output path and bitrate (192kbps)
const initialized = audioEngine.initialize(outputPath, 192000);
if (!initialized) {
  console.error('❌ Failed to initialize Audio Engine with Encoder/Muxer');
  console.error('   Make sure FFmpeg libraries are available:');
  console.error('   - Set FFMPEG_INCLUDE environment variable (e.g., C:/ffmpeg/include)');
  console.error('   - Set FFMPEG_LIB environment variable (e.g., C:/ffmpeg/lib)');
  process.exit(1);
}

// Initialize audio capture
console.log('🎤 Initializing WASAPI audio capture...');
const audioCapture = new WASAPICapture((buffer, source, format) => {
  if (!isRecording) return;
  if (!buffer || buffer.length === 0) return;

  // Feed raw audio data to the C++ AudioEngine
  // The C++ AudioEngine will handle:
  //   - Buffering, mixing, pacing
  //   - Creating AVPackets with explicit PTS
  //   - Encoding PCM → AAC
  //   - Muxing AAC → MP4
  const bytesPerFrame = format.channels * (format.bitsPerSample / 8);
  const numFrames = buffer.length / bytesPerFrame;

  audioEngine.feedAudioData(buffer, numFrames, source);

  if (source === 'desktop') desktopCallbackCount++;
  else if (source === 'mic') micCallbackCount++;
}, 'both');

// Get format
const format = audioCapture.getFormat();
if (format) {
  console.log(`🎵 Unified audio format: ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
}

// Start Audio Engine (clock master - OBS-like)
console.log('⏱️ Starting Audio Engine (clock master, encoding, muxing)...');
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

isRecording = true;
console.log('✅ Audio capture and engine started');
console.log('⏺ Recording for ~10 seconds...');
console.log('   (Audio will be encoded to AAC and muxed to MP4)');
console.log('(Press Ctrl+C to stop early)\n');

// Use a timer to tick Audio Engine (every 10ms)
// Audio Engine (C++) handles:
//   - Clock master, pacing, mixing
//   - Creating AVPackets with PTS
//   - Encoding PCM → AAC
//   - Muxing AAC → MP4
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
    const encodedPackets = audioEngine.getEncodedPackets();
    const encodedBytes = audioEngine.getEncodedBytes();
    const muxedPackets = audioEngine.getMuxedPackets();
    const muxedBytes = audioEngine.getMuxedBytes();
    
    console.log('\n📊 Final Statistics:');
    console.log(`   Desktop callbacks: ${desktopCallbackCount}`);
    console.log(`   Mic callbacks: ${micCallbackCount}`);
    console.log(`   Audio Engine PTS: ${ptsFrames} frames (${ptsSeconds.toFixed(2)}s)`);
    console.log(`   Encoded packets: ${encodedPackets}`);
    console.log(`   Encoded bytes: ${(encodedBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Muxed packets: ${muxedPackets}`);
    console.log(`   Muxed bytes: ${(muxedBytes / 1024 / 1024).toFixed(2)} MB`);
    
    // Stop Audio Engine (this will flush encoder and finalize muxer)
    audioEngine.stop();
    
    // Stop audio capture
    audioCapture.stop();
    
    // Check if output file exists
    if (fs.existsSync(outputPath)) {
      const stats = fs.statSync(outputPath);
      console.log(`\n✅ Recording saved: ${outputPath}`);
      console.log(`📦 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      console.log(`   Duration: ~${ptsSeconds.toFixed(2)} seconds`);
    } else {
      console.error(`\n❌ Output file not found: ${outputPath}`);
    }
    
    console.log('\n✅ Test completed!');
    console.log('   Audio was encoded to AAC and muxed to MP4 with explicit PTS control');
    
    process.exit(0);
  }, 500);
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
    process.exit(0);
  }, 500);
});


const path = require('path');
const fs = require('fs');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;
const AudioEngine = nativeModule.AudioEngine;

console.log('🎬 Testing AVPackets with PTS Control (OBS-like)...');
console.log('   - AudioEngine creates AVPackets with explicit PTS');
console.log('   - PTS is controlled from C++ AudioEngine');
console.log('   - No encoding, just PCM data with PTS\n');

// Statistics
let packetCount = 0;
let totalBytes = 0;
let totalFrames = 0;
let firstPTS = null;
let lastPTS = null;
let lastPTSSeconds = null;
let isRecording = false;

// Initialize Audio Engine (C++ - OBS-like clock master, mixing, pacing, AVPackets)
const audioEngine = new AudioEngine();

// Initialize Audio Engine with callback for AVPackets
const initialized = audioEngine.initialize((packet) => {
  // This callback receives AVPackets with explicit PTS from the C++ AudioEngine
  if (!isRecording) return;
  if (!packet || !packet.data) return;

  // Extract AVPacket properties
  const data = packet.data;  // Buffer containing PCM float32
  const pts = packet.pts;  // PTS in frames (time_base = 1/48000)
  const dts = packet.dts;  // DTS in frames (for audio: DTS = PTS)
  const duration = packet.duration;  // Duration in frames
  const streamIndex = packet.streamIndex;  // Stream index
  const ptsSeconds = packet.ptsSeconds;  // PTS in seconds
  const dtsSeconds = packet.dtsSeconds;  // DTS in seconds
  const durationSeconds = packet.durationSeconds;  // Duration in seconds

  // Track first and last PTS
  if (firstPTS === null) {
    firstPTS = pts;
    console.log(`📦 First packet: PTS=${pts} frames (${ptsSeconds.toFixed(3)}s), duration=${duration} frames (${durationSeconds.toFixed(3)}s)`);
  }
  lastPTS = pts;
  lastPTSSeconds = ptsSeconds;

  // Update statistics
  packetCount++;
  totalBytes += data.length;
  totalFrames += duration;

  // Log every 100 packets (to avoid spam)
  if (packetCount % 100 === 0) {
    const elapsedSeconds = ptsSeconds;
    const expectedFrames = Math.floor(elapsedSeconds * 48000);
    const drift = totalFrames - expectedFrames;
    const driftMs = (drift / 48000) * 1000;
    
    console.log(`📊 Packets: ${packetCount}, PTS: ${pts} frames (${ptsSeconds.toFixed(2)}s), Drift: ${drift} frames (${driftMs.toFixed(2)}ms)`);
  }
});

if (!initialized) {
  console.error('❌ Failed to initialize C++ Audio Engine');
  process.exit(1);
}

// Initialize audio capture
console.log('🎤 Initializing WASAPI audio capture...');
const audioCapture = new WASAPICapture((buffer, source, format) => {
  if (!isRecording) return;
  if (!buffer || buffer.length === 0) return;

  // Feed raw audio data to the C++ AudioEngine
  // The C++ AudioEngine will handle buffering, mixing, pacing, and creating AVPackets with PTS
  const bytesPerFrame = format.channels * (format.bitsPerSample / 8);
  const numFrames = buffer.length / bytesPerFrame;

  audioEngine.feedAudioData(buffer, numFrames, source);
}, 'both');

// Get format
const format = audioCapture.getFormat();
if (format) {
  console.log(`🎵 Unified audio format: ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
}

// Start Audio Engine (clock master - OBS-like)
console.log('⏱️ Starting Audio Engine (clock master, AVPacket creation)...');
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
console.log('   (AVPackets with PTS will be created by C++ AudioEngine)');
console.log('(Press Ctrl+C to stop early)\n');

// Use a timer to tick Audio Engine (every 10ms)
// Audio Engine (C++) handles clock master, pacing, mixing, and AVPacket creation with PTS
const tickInterval = setInterval(() => {
  if (isRecording) {
    audioEngine.tick(); // C++ handles all the logic and creates AVPackets
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
    
    console.log('\n📊 Final Statistics:');
    console.log(`   Total AVPackets: ${packetCount}`);
    console.log(`   Total bytes: ${(totalBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Total frames: ${totalFrames}`);
    console.log(`   First PTS: ${firstPTS} frames (${firstPTS !== null ? (firstPTS / 48000).toFixed(3) : 0}s)`);
    console.log(`   Last PTS: ${lastPTS} frames (${lastPTSSeconds !== null ? lastPTSSeconds.toFixed(3) : 0}s)`);
    console.log(`   Audio Engine PTS: ${ptsFrames} frames (${ptsSeconds.toFixed(2)}s)`);
    
    // Calculate drift
    const expectedFrames = Math.floor(ptsSeconds * 48000);
    const drift = totalFrames - expectedFrames;
    const driftMs = (drift / 48000) * 1000;
    console.log(`   Expected frames: ${expectedFrames}`);
    console.log(`   Drift: ${drift} frames (${driftMs.toFixed(2)}ms)`);
    
    // Verify PTS continuity
    if (packetCount > 0) {
      const avgPacketSize = totalBytes / packetCount;
      const avgDuration = totalFrames / packetCount;
      console.log(`   Avg packet size: ${(avgPacketSize / 1024).toFixed(2)} KB`);
      console.log(`   Avg packet duration: ${avgDuration.toFixed(1)} frames (${(avgDuration / 48000 * 1000).toFixed(2)}ms)`);
    }
    
    // Stop Audio Engine
    audioEngine.stop();
    
    // Stop audio capture
    audioCapture.stop();
    
    console.log('\n✅ Test completed!');
    console.log('   AVPackets with explicit PTS were created by C++ AudioEngine');
    console.log('   PTS is controlled from C++ (OBS-like)');
    
    process.exit(0);
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
    process.exit(0);
  }, 200);
});




const path = require('path');
const fs = require('fs');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;
const AudioEngine = nativeModule.AudioEngine;

// ============================================================================
// TEST: AudioPacketManager (via AudioEngine)
// ============================================================================
// Ce script teste AudioPacketManager qui crée des AudioPackets avec PTS
// AudioPacketManager est utilisé en interne par AudioEngine
// On vérifie que les AudioPackets créés ont les bonnes propriétés :
// - PTS (Presentation Time Stamp) en frames
// - DTS (Decode Time Stamp) = PTS (audio, pas de B-frames)
// - Duration en frames
// - Data (PCM float32)
// ============================================================================

console.log('🔍 Testing AudioPacketManager (via AudioEngine)');
console.log('   This verifies that AudioPackets are created correctly with PTS');
console.log('   Recording for 20 seconds to check for drift...\n');

// Output file
const outputDir = __dirname;
const outputPath = path.join(outputDir, 'test_audiopacketmanager.wav');

// WAV file handle
let wavFile = null;
let wavDataSize = 0;

// Statistics
let totalPackets = 0;
let totalFrames = 0;
let expectedPTS = 0;
let ptsErrors = 0;
let lastPTS = -1;
let lastDuration = 0;

// Recording state
let isRecording = true;
let recordingStartTime = null;

// Audio format
const AUDIO_ENGINE_SAMPLE_RATE = 48000;
const AUDIO_ENGINE_CHANNELS = 2;
const AUDIO_ENGINE_BYTES_PER_SAMPLE = 4; // float32
const AUDIO_ENGINE_BITS_PER_SAMPLE = 32;

// ============================================================================
// WAV File Functions
// ============================================================================

function writeWavHeader(sampleRate, channels, bitsPerSample) {
  const header = Buffer.alloc(44);
  let offset = 0;
  
  // RIFF header
  header.write('RIFF', offset); offset += 4;
  header.writeUInt32LE(0, offset); offset += 4; // File size - 8 (will be updated later)
  header.write('WAVE', offset); offset += 4;
  
  // fmt chunk
  header.write('fmt ', offset); offset += 4;
  header.writeUInt32LE(16, offset); offset += 4; // fmt chunk size
  header.writeUInt16LE(3, offset); offset += 2; // Audio format (3 = IEEE float)
  header.writeUInt16LE(channels, offset); offset += 2;
  header.writeUInt32LE(sampleRate, offset); offset += 4;
  header.writeUInt32LE(sampleRate * channels * (bitsPerSample / 8), offset); offset += 4; // Byte rate
  header.writeUInt16LE(channels * (bitsPerSample / 8), offset); offset += 2; // Block align
  header.writeUInt16LE(bitsPerSample, offset); offset += 2;
  
  // data chunk
  header.write('data', offset); offset += 4;
  header.writeUInt32LE(0, offset); offset += 4; // Data size (will be updated later)
  
  return header;
}

function initWavFile(filePath, sampleRate, channels, bitsPerSample) {
  try {
    const fileHandle = fs.openSync(filePath, 'w');
    const header = writeWavHeader(sampleRate, channels, bitsPerSample);
    fs.writeSync(fileHandle, header, 0, header.length);
    return { fileHandle, dataSize: 0 };
  } catch (err) {
    console.error(`❌ Failed to create WAV file ${filePath}:`, err);
    process.exit(1);
  }
}

function finalizeWavFile(fileHandle, dataSize) {
  if (!fileHandle) return;
  
  try {
    // Update file size in RIFF header
    fs.writeSync(fileHandle, Buffer.from([dataSize & 0xFF, (dataSize >> 8) & 0xFF, (dataSize >> 16) & 0xFF, (dataSize >> 24) & 0xFF]), 0, 4, 4);
    
    // Update data size in data chunk
    const dataChunkSize = dataSize;
    fs.writeSync(fileHandle, Buffer.from([dataChunkSize & 0xFF, (dataChunkSize >> 8) & 0xFF, (dataChunkSize >> 16) & 0xFF, (dataChunkSize >> 24) & 0xFF]), 0, 4, 40);
    
    // Update total file size (dataSize + 36 bytes of header after "RIFF" and size)
    const totalFileSize = dataSize + 36;
    fs.writeSync(fileHandle, Buffer.from([totalFileSize & 0xFF, (totalFileSize >> 8) & 0xFF, (totalFileSize >> 16) & 0xFF, (totalFileSize >> 24) & 0xFF]), 0, 4, 4);
    
    fs.closeSync(fileHandle);
  } catch (err) {
    console.error(`❌ Failed to finalize WAV file:`, err);
  }
}

// ============================================================================
// WASAPI Capture Setup
// ============================================================================

// Create WASAPI capture instance
const capture = new WASAPICapture((buffer, source, format) => {
  if (!isRecording) return;
  
  // Get format info
  const sampleRate = format.sampleRate;
  const channels = format.channels;
  const bitsPerSample = format.bitsPerSample;
  const blockAlign = format.blockAlign;
  
  // Calculate data size and frames
  const dataSize = buffer.length;
  const numFrames = dataSize / blockAlign;
  
  // Feed audio data to AudioEngine
  if (engine && engine.isRunning()) {
    engine.feedAudioData(buffer, numFrames, source);
  }
}, 'both'); // Capture both desktop and mic

// Get format info
const format = capture.getFormat();
if (format) {
  console.log(`✅ WASAPI Capture initialized`);
  console.log(`   Format: ${format.sampleRate} Hz, ${format.channels} channels, ${format.bitsPerSample} bits\n`);
} else {
  console.error('❌ Failed to get format from WASAPI capture');
  process.exit(1);
}

// ============================================================================
// AudioEngine Setup
// ============================================================================

// Initialize WAV file
const result = initWavFile(outputPath, AUDIO_ENGINE_SAMPLE_RATE, AUDIO_ENGINE_CHANNELS, AUDIO_ENGINE_BITS_PER_SAMPLE);
wavFile = result.fileHandle;
wavDataSize = result.dataSize;

console.log(`📝 WAV file initialized: ${AUDIO_ENGINE_SAMPLE_RATE} Hz, ${AUDIO_ENGINE_CHANNELS}ch, ${AUDIO_ENGINE_BITS_PER_SAMPLE}-bit\n`);

// Create AudioEngine instance
const engine = new AudioEngine();

// Initialize AudioEngine with callback that verifies AudioPackets
if (!engine.initialize((packet) => {
  if (!isRecording || !wavFile) return;
  
  // Verify AudioPacket properties
  const pts = packet.pts;
  const dts = packet.dts;
  const duration = packet.duration;
  const dataSize = packet.data.length;
  
  // Verify: DTS should equal PTS for audio (no B-frames)
  if (dts !== pts) {
    console.warn(`⚠️  Warning: DTS (${dts}) != PTS (${pts}) - should be equal for audio`);
    ptsErrors++;
  }
  
  // Verify: PTS should be continuous (no gaps, no jumps)
  if (lastPTS >= 0) {
    const expectedNextPTS = lastPTS + lastDuration;
    if (pts !== expectedNextPTS) {
      const gap = pts - expectedNextPTS;
      if (Math.abs(gap) > 1) { // Allow 1 frame tolerance
        console.warn(`⚠️  Warning: PTS gap detected. Expected ${expectedNextPTS}, got ${pts} (gap: ${gap} frames)`);
        ptsErrors++;
      }
    }
  }
  
  // Verify: Duration should match data size
  const expectedDataSize = duration * AUDIO_ENGINE_CHANNELS * AUDIO_ENGINE_BYTES_PER_SAMPLE;
  if (dataSize !== expectedDataSize) {
    console.warn(`⚠️  Warning: Data size mismatch. Expected ${expectedDataSize}, got ${dataSize}`);
    ptsErrors++;
  }
  
  // Verify: PTS should be non-negative
  if (pts < 0) {
    console.warn(`⚠️  Warning: Negative PTS: ${pts}`);
    ptsErrors++;
  }
  
  // Verify: Duration should be positive
  if (duration <= 0) {
    console.warn(`⚠️  Warning: Invalid duration: ${duration}`);
    ptsErrors++;
  }
  
  // Write packet data to WAV file
  fs.writeSync(wavFile, packet.data, 0, dataSize);
  wavDataSize += dataSize;
  
  // Update statistics
  totalPackets++;
  totalFrames += duration;
  lastPTS = pts;
  lastDuration = duration;
  
  // Log first few packets and periodically to check for drift
  if (totalPackets <= 5 || totalPackets % 100 === 0) {
    const ptsSeconds = (pts / AUDIO_ENGINE_SAMPLE_RATE).toFixed(3);
    const expectedPTS = totalFrames;
    const drift = pts - expectedPTS;
    console.log(`📦 Packet #${totalPackets}: PTS=${pts} frames (${ptsSeconds}s), Expected=${expectedPTS}, Drift=${drift} frames, Duration=${duration} frames`);
  }
})) {
  console.error('❌ Failed to initialize AudioEngine');
  process.exit(1);
}

// ============================================================================
// Start Recording
// ============================================================================

console.log('🎙️  Starting WASAPI capture and AudioEngine...\n');

if (!capture.start()) {
  console.error('❌ Failed to start WASAPI capture');
  process.exit(1);
}

if (!engine.start()) {
  console.error('❌ Failed to start AudioEngine');
  process.exit(1);
}

recordingStartTime = Date.now();

// Tick engine every 10ms (OBS-like)
const tickInterval = setInterval(() => {
  if (!isRecording) {
    clearInterval(tickInterval);
    return;
  }
  
  // Tick engine
  engine.tick();
  
  // Log progress every second with drift calculation
  const elapsed = Date.now() - recordingStartTime;
  if (elapsed > 0 && elapsed % 1000 < 10) {
    const elapsedSeconds = (elapsed / 1000).toFixed(1);
    const currentPTS = engine.getCurrentPTSFrames();
    const currentPTSSeconds = engine.getCurrentPTSSeconds();
    const expectedFrames = Math.floor((elapsed / 1000) * AUDIO_ENGINE_SAMPLE_RATE);
    const driftFrames = currentPTS - expectedFrames;
    const driftMs = (driftFrames / AUDIO_ENGINE_SAMPLE_RATE) * 1000;
    console.log(`⏱️  ${elapsedSeconds}s - Packets: ${totalPackets}, Frames: ${totalFrames}, Current PTS: ${currentPTS} frames (${currentPTSSeconds.toFixed(3)}s), Expected: ${expectedFrames}, Drift: ${driftFrames} frames (${driftMs.toFixed(2)}ms), Errors: ${ptsErrors}`);
  }
}, 10); // 10ms tick interval

// Record for 20 seconds
setTimeout(() => {
  console.log('\n⏹️  Stopping recording...\n');
  isRecording = false;
  
  clearInterval(tickInterval);
  
  // Stop engine
  engine.stop();
  capture.stop();
  
  // Finalize WAV file
  if (wavFile) {
    finalizeWavFile(wavFile, wavDataSize);
    console.log(`✅ WAV file written: ${outputPath}`);
    console.log(`   Size: ${(wavDataSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Packets: ${totalPackets}, Total frames: ${totalFrames}`);
    const duration = totalFrames / AUDIO_ENGINE_SAMPLE_RATE;
    console.log(`   Duration: ${duration.toFixed(2)} seconds\n`);
  }
  
  // Calculate final drift
  const totalElapsedMs = Date.now() - recordingStartTime;
  const expectedTotalFrames = Math.floor((totalElapsedMs / 1000) * AUDIO_ENGINE_SAMPLE_RATE);
  const finalDriftFrames = totalFrames - expectedTotalFrames;
  const finalDriftMs = (finalDriftFrames / AUDIO_ENGINE_SAMPLE_RATE) * 1000;
  const finalDriftPercent = (finalDriftFrames / expectedTotalFrames) * 100;
  
  // Report PTS verification results
  console.log('📊 AudioPacketManager Verification Results:');
  console.log(`   Total packets: ${totalPackets}`);
  console.log(`   Total frames: ${totalFrames}`);
  console.log(`   Expected frames: ${expectedTotalFrames}`);
  console.log(`   Final drift: ${finalDriftFrames} frames (${finalDriftMs.toFixed(2)}ms, ${finalDriftPercent.toFixed(4)}%)`);
  console.log(`   PTS errors: ${ptsErrors}`);
  console.log(`   Last PTS: ${lastPTS} frames (${(lastPTS / AUDIO_ENGINE_SAMPLE_RATE).toFixed(3)}s)`);
  
  // Drift analysis
  if (Math.abs(finalDriftFrames) <= 1) {
    console.log('\n✅ No significant drift detected (within 1 frame tolerance)');
  } else if (Math.abs(finalDriftFrames) <= 10) {
    console.log(`\n⚠️  Minor drift detected: ${finalDriftFrames} frames (${finalDriftMs.toFixed(2)}ms)`);
    console.log('   This is acceptable for most use cases');
  } else {
    console.log(`\n❌ Significant drift detected: ${finalDriftFrames} frames (${finalDriftMs.toFixed(2)}ms)`);
    console.log('   This may cause synchronization issues');
  }
  
  if (ptsErrors === 0) {
    console.log('\n✅ All AudioPackets verified successfully!');
    console.log('   - PTS is continuous');
    console.log('   - DTS = PTS (correct for audio)');
    console.log('   - Duration matches data size');
    console.log('   - No gaps or jumps detected');
  } else {
    console.log(`\n⚠️  Found ${ptsErrors} PTS verification errors`);
    console.log('   Check the warnings above for details');
  }
  
  console.log('\n🎉 Test complete!');
  console.log(`   Check the WAV file: ${outputPath}`);
  console.log('   If artefacts are present, check the PTS errors above.\n');
  
  process.exit(0);
}, 20000); // 20 seconds


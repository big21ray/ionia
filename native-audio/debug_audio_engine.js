const path = require('path');
const fs = require('fs');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;
const AudioEngine = nativeModule.AudioEngine;

// ============================================================================
// TEST: AudioEngine (WASAPI → AudioEngine → WAV Files)
// ============================================================================
// Ce script teste la partie AudioEngine (lignes 14-20 de ARTEFACTS_DEBUG.md)
// - Capture depuis WASAPI
// - Feed les données à AudioEngine (FeedAudioData)
// - Utilise AudioEngine::Tick() pour obtenir le mix
// - Écrit les résultats dans des fichiers WAV (desktop, mic, both mixé)
// ============================================================================

console.log('🔍 Testing AudioEngine (WASAPI → AudioEngine → WAV files)');
console.log('   This tests the AudioEngine mixing and clock master logic');
console.log('   Recording for 10 seconds...\n');

// Output files
const outputDir = __dirname;
const desktopOutputPath = path.join(outputDir, 'test_audioengine_desktop.wav');
const micOutputPath = path.join(outputDir, 'test_audioengine_mic.wav');
const bothOutputPath = path.join(outputDir, 'test_audioengine_both.wav');

// WAV file handles
let desktopWavFile = null;
let desktopWavDataSize = 0;
let micWavFile = null;
let micWavDataSize = 0;
let bothWavFile = null;
let bothWavDataSize = 0;

// Statistics
let desktopPackets = 0;
let micPackets = 0;
let bothPackets = 0;
let desktopTotalFrames = 0;
let micTotalFrames = 0;
let bothTotalFrames = 0;

// Recording state
let isRecording = true;
let recordingStartTime = null;

// Audio format (from WASAPI, should be 48kHz stereo float32)
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
  
  // Feed audio data to AudioEngines
  // FeedAudioData expects: (Buffer, numFrames, source)
  // The buffer already contains float32 data from WASAPI
  
  if (source === 'desktop') {
    // Feed to desktop-only engine
    if (engineDesktop && engineDesktop.isRunning()) {
      engineDesktop.feedAudioData(buffer, numFrames, 'desktop');
    }
    
    // Feed to both engine
    if (engineBoth && engineBoth.isRunning()) {
      engineBoth.feedAudioData(buffer, numFrames, 'desktop');
    }
  } else if (source === 'mic') {
    // Feed to mic-only engine
    if (engineMic && engineMic.isRunning()) {
      engineMic.feedAudioData(buffer, numFrames, 'mic');
    }
    
    // Feed to both engine
    if (engineBoth && engineBoth.isRunning()) {
      engineBoth.feedAudioData(buffer, numFrames, 'mic');
    }
  }
}, 'both'); // Capture both desktop and mic

// Get format info
const format = capture.getFormat();
if (format) {
  console.log(`✅ WASAPI Capture initialized`);
  console.log(`   Format: ${format.sampleRate} Hz, ${format.channels} channels, ${format.bitsPerSample} bits`);
  console.log(`   Block align: ${format.blockAlign} bytes`);
  console.log(`   Bytes per second: ${format.bytesPerSecond}\n`);
} else {
  console.error('❌ Failed to get format from WASAPI capture');
  process.exit(1);
}

// ============================================================================
// AudioEngine Setup
// ============================================================================

// Initialize WAV files
const resultDesktop = initWavFile(desktopOutputPath, AUDIO_ENGINE_SAMPLE_RATE, AUDIO_ENGINE_CHANNELS, AUDIO_ENGINE_BITS_PER_SAMPLE);
desktopWavFile = resultDesktop.fileHandle;
desktopWavDataSize = resultDesktop.dataSize;

const resultMic = initWavFile(micOutputPath, AUDIO_ENGINE_SAMPLE_RATE, AUDIO_ENGINE_CHANNELS, AUDIO_ENGINE_BITS_PER_SAMPLE);
micWavFile = resultMic.fileHandle;
micWavDataSize = resultMic.dataSize;

const resultBoth = initWavFile(bothOutputPath, AUDIO_ENGINE_SAMPLE_RATE, AUDIO_ENGINE_CHANNELS, AUDIO_ENGINE_BITS_PER_SAMPLE);
bothWavFile = resultBoth.fileHandle;
bothWavDataSize = resultBoth.dataSize;

console.log(`📝 WAV files initialized: ${AUDIO_ENGINE_SAMPLE_RATE} Hz, ${AUDIO_ENGINE_CHANNELS}ch, ${AUDIO_ENGINE_BITS_PER_SAMPLE}-bit\n`);

// Create 3 AudioEngine instances:
// 1. Desktop-only (for desktop.wav)
// 2. Mic-only (for mic.wav)
// 3. Both (for both.wav - mixed)

// Desktop-only engine
const engineDesktop = new AudioEngine();

// Mic-only engine
const engineMic = new AudioEngine();

// Both engine (mixed)
const engineBoth = new AudioEngine();

// Initialize all engines with callbacks
if (!engineDesktop.initialize((packet) => {
  if (!isRecording || !desktopWavFile) return;
  
  // packet.data is PCM float32 (already in correct format)
  const dataSize = packet.data.length;
  fs.writeSync(desktopWavFile, packet.data, 0, dataSize);
  desktopWavDataSize += dataSize;
  desktopPackets++;
  desktopTotalFrames += packet.duration;
})) {
  console.error('❌ Failed to initialize desktop AudioEngine');
  process.exit(1);
}

if (!engineMic.initialize((packet) => {
  if (!isRecording || !micWavFile) return;
  
  const dataSize = packet.data.length;
  fs.writeSync(micWavFile, packet.data, 0, dataSize);
  micWavDataSize += dataSize;
  micPackets++;
  micTotalFrames += packet.duration;
})) {
  console.error('❌ Failed to initialize mic AudioEngine');
  process.exit(1);
}

if (!engineBoth.initialize((packet) => {
  if (!isRecording || !bothWavFile) return;
  
  const dataSize = packet.data.length;
  fs.writeSync(bothWavFile, packet.data, 0, dataSize);
  bothWavDataSize += dataSize;
  bothPackets++;
  bothTotalFrames += packet.duration;
})) {
  console.error('❌ Failed to initialize both AudioEngine');
  process.exit(1);
}

// ============================================================================
// Start Recording
// ============================================================================

console.log('🎙️  Starting WASAPI capture and AudioEngines...\n');

if (!capture.start()) {
  console.error('❌ Failed to start WASAPI capture');
  process.exit(1);
}

// Start all AudioEngines
if (!engineDesktop.start()) {
  console.error('❌ Failed to start desktop AudioEngine');
  process.exit(1);
}

if (!engineMic.start()) {
  console.error('❌ Failed to start mic AudioEngine');
  process.exit(1);
}

if (!engineBoth.start()) {
  console.error('❌ Failed to start both AudioEngine');
  process.exit(1);
}

recordingStartTime = Date.now();

// Tick all engines every 10ms (OBS-like)
const tickInterval = setInterval(() => {
  if (!isRecording) {
    clearInterval(tickInterval);
    return;
  }
  
  // Tick all engines
  engineDesktop.tick();
  engineMic.tick();
  engineBoth.tick();
  
  // Log progress every second
  const elapsed = Date.now() - recordingStartTime;
  if (elapsed > 0 && elapsed % 1000 < 10) {
    const elapsedSeconds = (elapsed / 1000).toFixed(1);
    console.log(`⏱️  ${elapsedSeconds}s - Desktop: ${desktopPackets} packets (${desktopTotalFrames} frames), Mic: ${micPackets} packets (${micTotalFrames} frames), Both: ${bothPackets} packets (${bothTotalFrames} frames)`);
  }
}, 10); // 10ms tick interval

// Record for 10 seconds
setTimeout(() => {
  console.log('\n⏹️  Stopping recording...\n');
  isRecording = false;
  
  clearInterval(tickInterval);
  
  // Stop all engines
  engineDesktop.stop();
  engineMic.stop();
  engineBoth.stop();
  
  capture.stop();
  
  // Finalize WAV files
  if (desktopWavFile) {
    finalizeWavFile(desktopWavFile, desktopWavDataSize);
    console.log(`✅ Desktop WAV file written: ${desktopOutputPath}`);
    console.log(`   Size: ${(desktopWavDataSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Packets: ${desktopPackets}, Total frames: ${desktopTotalFrames}`);
    const desktopDuration = desktopTotalFrames / AUDIO_ENGINE_SAMPLE_RATE;
    console.log(`   Duration: ${desktopDuration.toFixed(2)} seconds\n`);
  }
  
  if (micWavFile) {
    finalizeWavFile(micWavFile, micWavDataSize);
    console.log(`✅ Microphone WAV file written: ${micOutputPath}`);
    console.log(`   Size: ${(micWavDataSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Packets: ${micPackets}, Total frames: ${micTotalFrames}`);
    const micDuration = micTotalFrames / AUDIO_ENGINE_SAMPLE_RATE;
    console.log(`   Duration: ${micDuration.toFixed(2)} seconds\n`);
  }
  
  if (bothWavFile) {
    finalizeWavFile(bothWavFile, bothWavDataSize);
    console.log(`✅ Mixed (both) WAV file written: ${bothOutputPath}`);
    console.log(`   Size: ${(bothWavDataSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Packets: ${bothPackets}, Total frames: ${bothTotalFrames}`);
    const bothDuration = bothTotalFrames / AUDIO_ENGINE_SAMPLE_RATE;
    console.log(`   Duration: ${bothDuration.toFixed(2)} seconds\n`);
  }
  
  console.log('🎉 Test complete!');
  console.log('   Check the WAV files for artefacts:');
  console.log(`   - ${desktopOutputPath} (desktop via AudioEngine)`);
  console.log(`   - ${micOutputPath} (mic via AudioEngine)`);
  console.log(`   - ${bothOutputPath} (mixed desktop + mic via AudioEngine)`);
  console.log('\n   If artefacts are present in these files, the problem is in AudioEngine.');
  console.log('   If no artefacts, the problem is in Encoder/Muxer.\n');
  
  process.exit(0);
}, 10000); // 10 seconds


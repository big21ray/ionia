const path = require('path');
const fs = require('fs');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;
const AudioEngineEncoder = nativeModule.AudioEngineEncoder;

// ============================================================================
// TEST: AudioEncoder::EncodeFrames() (via AudioEngineEncoder)
// ============================================================================
// Ce script teste AudioEncoder::EncodeFrames() qui encode PCM → AAC
// - Capture depuis WASAPI
// - Feed à AudioEngine (mix)
// - AudioEncoder encode PCM → AAC
// - AudioMuxer écrit AAC → MP4
// On vérifie que l'encodage fonctionne correctement sans artefacts
// ============================================================================

console.log('🔍 Testing AudioEncoder::EncodeFrames() (WASAPI → AudioEngine → AudioEncoder → MP4)');
console.log('   This tests the AAC encoding step');
console.log('   Recording for 10 seconds...\n');

// Output files
const outputDir = __dirname;
const bothOutputPath = path.join(outputDir, 'test_audioencoder_both.mp4');
const desktopOutputPath = path.join(outputDir, 'test_audioencoder_desktop.mp4');
const micOutputPath = path.join(outputDir, 'test_audioencoder_mic.mp4');

// Recording state
let isRecording = true;
let recordingStartTime = null;

// Statistics
let bothStats = { packets: 0, bytes: 0 };
let desktopStats = { packets: 0, bytes: 0 };
let micStats = { packets: 0, bytes: 0 };

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
  
  // Feed audio data to AudioEngineEncoders
  if (source === 'desktop') {
    if (engineBoth && engineBoth.isRunning()) {
      engineBoth.feedAudioData(buffer, numFrames, 'desktop');
    }
    if (engineDesktop && engineDesktop.isRunning()) {
      engineDesktop.feedAudioData(buffer, numFrames, 'desktop');
    }
  } else if (source === 'mic') {
    if (engineBoth && engineBoth.isRunning()) {
      engineBoth.feedAudioData(buffer, numFrames, 'mic');
    }
    if (engineMic && engineMic.isRunning()) {
      engineMic.feedAudioData(buffer, numFrames, 'mic');
    }
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
// AudioEngineEncoder Setup
// ============================================================================

// Create 3 AudioEngineEncoder instances:
// 1. Desktop-only (for desktop.mp4)
// 2. Mic-only (for mic.mp4)
// 3. Both (for both.mp4 - mixed)

// Desktop-only encoder
const engineDesktop = new AudioEngineEncoder();
if (!engineDesktop.initialize(desktopOutputPath, 192000)) {
  console.error('❌ Failed to initialize desktop AudioEngineEncoder');
  process.exit(1);
}

// Mic-only encoder
const engineMic = new AudioEngineEncoder();
if (!engineMic.initialize(micOutputPath, 192000)) {
  console.error('❌ Failed to initialize mic AudioEngineEncoder');
  process.exit(1);
}

// Both encoder (mixed)
const engineBoth = new AudioEngineEncoder();
if (!engineBoth.initialize(bothOutputPath, 192000)) {
  console.error('❌ Failed to initialize both AudioEngineEncoder');
  process.exit(1);
}

console.log(`📝 AudioEngineEncoders initialized`);
console.log(`   Output files:`);
console.log(`   - ${bothOutputPath} (mixed desktop + mic)`);
console.log(`   - ${desktopOutputPath} (desktop only)`);
console.log(`   - ${micOutputPath} (mic only)`);
console.log(`   Bitrate: 192 kbps\n`);

// ============================================================================
// Start Recording
// ============================================================================

console.log('🎙️  Starting WASAPI capture and AudioEngineEncoders...\n');

if (!capture.start()) {
  console.error('❌ Failed to start WASAPI capture');
  process.exit(1);
}

// Start all encoders
if (!engineDesktop.start()) {
  console.error('❌ Failed to start desktop AudioEngineEncoder');
  process.exit(1);
}

if (!engineMic.start()) {
  console.error('❌ Failed to start mic AudioEngineEncoder');
  process.exit(1);
}

if (!engineBoth.start()) {
  console.error('❌ Failed to start both AudioEngineEncoder');
  process.exit(1);
}

recordingStartTime = Date.now();
console.log('✅ Recording started, will record for 10 seconds...\n');

// Tick all engines every 10ms (OBS-like)
const tickInterval = setInterval(() => {
  if (!isRecording) {
    clearInterval(tickInterval);
    return;
  }
  
  try {
    // Tick all engines
    engineDesktop.tick();
    engineMic.tick();
    engineBoth.tick();
    
    // Update statistics
    bothStats.packets = engineBoth.getEncodedPackets();
    bothStats.bytes = engineBoth.getEncodedBytes();
    desktopStats.packets = engineDesktop.getEncodedPackets();
    desktopStats.bytes = engineDesktop.getEncodedBytes();
    micStats.packets = engineMic.getEncodedPackets();
    micStats.bytes = engineMic.getEncodedBytes();
    
    // Log progress every second
    const elapsed = Date.now() - recordingStartTime;
    if (elapsed > 0 && elapsed % 1000 < 10) {
      const elapsedSeconds = (elapsed / 1000).toFixed(1);
      const bothPTS = engineBoth.getCurrentPTSSeconds();
      const desktopPTS = engineDesktop.getCurrentPTSSeconds();
      const micPTS = engineMic.getCurrentPTSSeconds();
      console.log(`⏱️  ${elapsedSeconds}s - Both: ${bothStats.packets} packets (${(bothStats.bytes/1024).toFixed(1)}KB, PTS: ${bothPTS.toFixed(3)}s), Desktop: ${desktopStats.packets} packets, Mic: ${micStats.packets} packets`);
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
  
  // Stop all engines
  engineDesktop.stop();
  engineMic.stop();
  engineBoth.stop();
  
  capture.stop();
  
  // Final statistics
  bothStats.packets = engineBoth.getEncodedPackets();
  bothStats.bytes = engineBoth.getEncodedBytes();
  desktopStats.packets = engineDesktop.getEncodedPackets();
  desktopStats.bytes = engineDesktop.getEncodedBytes();
  micStats.packets = engineMic.getEncodedPackets();
  micStats.bytes = engineMic.getEncodedBytes();
  
  console.log('📊 AudioEncoder Statistics:');
  console.log(`   Both (mixed):`);
  console.log(`     Packets: ${bothStats.packets}`);
  console.log(`     Bytes: ${(bothStats.bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`     File: ${bothOutputPath}`);
  console.log(`   Desktop:`);
  console.log(`     Packets: ${desktopStats.packets}`);
  console.log(`     Bytes: ${(desktopStats.bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`     File: ${desktopOutputPath}`);
  console.log(`   Mic:`);
  console.log(`     Packets: ${micStats.packets}`);
  console.log(`     Bytes: ${(micStats.bytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`     File: ${micOutputPath}\n`);
  
  // Check if files exist and have content
  const checkFile = (filePath, name) => {
    if (fs.existsSync(filePath)) {
      const stats = fs.statSync(filePath);
      if (stats.size > 0) {
        console.log(`✅ ${name}: ${filePath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
        return true;
      } else {
        console.log(`⚠️  ${name}: ${filePath} exists but is empty`);
        return false;
      }
    } else {
      console.log(`❌ ${name}: ${filePath} not found`);
      return false;
    }
  };
  
  console.log('📁 Generated files:');
  const bothOk = checkFile(bothOutputPath, 'Both (mixed)');
  const desktopOk = checkFile(desktopOutputPath, 'Desktop');
  const micOk = checkFile(micOutputPath, 'Mic');
  
  console.log('\n🎉 Test complete!');
  console.log('   Check the MP4 files for artefacts:');
  console.log(`   - ${bothOutputPath}`);
  console.log(`   - ${desktopOutputPath}`);
  console.log(`   - ${micOutputPath}`);
  console.log('\n   If artefacts are present in these files, the problem is in AudioEncoder::EncodeFrames().');
  console.log('   If no artefacts, the problem is in AudioMuxer or later stages.\n');
  
  if (bothOk && desktopOk && micOk) {
    console.log('✅ All files generated successfully!');
  } else {
    console.log('⚠️  Some files are missing or empty - check the errors above');
  }
  
  process.exit(0);
}, 10000); // 10 seconds


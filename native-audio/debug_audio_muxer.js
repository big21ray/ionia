const path = require('path');
const fs = require('fs');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;
const AudioEngineEncoder = nativeModule.AudioEngineEncoder;

// ============================================================================
// TEST: AudioMuxer (MP4 container creation)
// ============================================================================
// Ce script teste AudioMuxer qui muxe les packets AAC dans un conteneur MP4
// - Capture depuis WASAPI
// - Feed à AudioEngine (mix)
// - AudioEncoder encode PCM → AAC
// - AudioMuxer écrit AAC → MP4 (avec PTS, DTS, timestamps)
// On génère 3 fichiers MP4 pour tester : both, desktop, mic
// ============================================================================

console.log('🔍 Testing AudioMuxer (WASAPI → AudioEngine → AudioEncoder → AudioMuxer → MP4)');
console.log('   This tests the MP4 muxing step with explicit PTS control');
console.log('   Recording for 10 seconds...\n');

// Output files
const outputDir = __dirname;
const bothOutputPath = path.join(outputDir, 'test_audiomuxer_both.mp4');
const desktopOutputPath = path.join(outputDir, 'test_audiomuxer_desktop.mp4');
const micOutputPath = path.join(outputDir, 'test_audiomuxer_mic.mp4');

// Statistics
let bothStats = { packets: 0, bytes: 0, muxedPackets: 0, muxedBytes: 0 };
let desktopStats = { packets: 0, bytes: 0, muxedPackets: 0, muxedBytes: 0 };
let micStats = { packets: 0, bytes: 0, muxedPackets: 0, muxedBytes: 0 };

// Recording state
let isRecording = true;
let recordingStartTime = null;

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
// AudioEngineEncoder Setup (MP4 mode - default)
// ============================================================================

console.log(`📝 AudioEngineEncoders initialized (MP4 mode)`);
console.log(`   Output files:`);
console.log(`   - ${bothOutputPath} (mixed desktop + mic)`);
console.log(`   - ${desktopOutputPath} (desktop only)`);
console.log(`   - ${micOutputPath} (mic only)`);
console.log(`   Bitrate: 192 kbps\n`);

// Remove existing files
[bothOutputPath, desktopOutputPath, micOutputPath].forEach(filePath => {
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
});

// Create 3 AudioEngineEncoder instances (MP4 mode by default, no useRawAac flag)
const engineDesktop = new AudioEngineEncoder();
const engineMic = new AudioEngineEncoder();
const engineBoth = new AudioEngineEncoder();

// Initialize with MP4 output (default mode, useRawAac = false)
if (!engineDesktop.initialize(desktopOutputPath, 192000, false)) {
  console.error('❌ Failed to initialize desktop AudioEngineEncoder');
  process.exit(1);
}

if (!engineMic.initialize(micOutputPath, 192000, false)) {
  console.error('❌ Failed to initialize mic AudioEngineEncoder');
  process.exit(1);
}

if (!engineBoth.initialize(bothOutputPath, 192000, false)) {
  console.error('❌ Failed to initialize both AudioEngineEncoder');
  process.exit(1);
}

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
    bothStats.muxedPackets = engineBoth.getMuxedPackets();
    bothStats.muxedBytes = engineBoth.getMuxedBytes();
    
    desktopStats.packets = engineDesktop.getEncodedPackets();
    desktopStats.bytes = engineDesktop.getEncodedBytes();
    desktopStats.muxedPackets = engineDesktop.getMuxedPackets();
    desktopStats.muxedBytes = engineDesktop.getMuxedBytes();
    
    micStats.packets = engineMic.getEncodedPackets();
    micStats.bytes = engineMic.getEncodedBytes();
    micStats.muxedPackets = engineMic.getMuxedPackets();
    micStats.muxedBytes = engineMic.getMuxedBytes();
    
    // Log progress every second
    const elapsed = Date.now() - recordingStartTime;
    if (elapsed > 0 && elapsed % 1000 < 10) {
      const elapsedSeconds = (elapsed / 1000).toFixed(1);
      const bothPTS = engineBoth.getCurrentPTSSeconds();
      const desktopPTS = engineDesktop.getCurrentPTSSeconds();
      const micPTS = engineMic.getCurrentPTSSeconds();
      
      console.log(`⏱️  ${elapsedSeconds}s - Both: ${bothStats.muxedPackets} muxed packets (${(bothStats.muxedBytes/1024).toFixed(1)}KB, PTS: ${bothPTS.toFixed(3)}s), Desktop: ${desktopStats.muxedPackets} packets, Mic: ${micStats.muxedPackets} packets`);
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
  
  // Stop all engines (this will flush encoder and finalize muxer)
  engineDesktop.stop();
  engineMic.stop();
  engineBoth.stop();
  
  capture.stop();
  
  // Wait a bit for finalization
  setTimeout(() => {
    // Final statistics
    bothStats.packets = engineBoth.getEncodedPackets();
    bothStats.bytes = engineBoth.getEncodedBytes();
    bothStats.muxedPackets = engineBoth.getMuxedPackets();
    bothStats.muxedBytes = engineBoth.getMuxedBytes();
    
    desktopStats.packets = engineDesktop.getEncodedPackets();
    desktopStats.bytes = engineDesktop.getEncodedBytes();
    desktopStats.muxedPackets = engineDesktop.getMuxedPackets();
    desktopStats.muxedBytes = engineDesktop.getMuxedBytes();
    
    micStats.packets = engineMic.getEncodedPackets();
    micStats.bytes = engineMic.getEncodedBytes();
    micStats.muxedPackets = engineMic.getMuxedPackets();
    micStats.muxedBytes = engineMic.getMuxedBytes();
    
    console.log('📊 AudioMuxer Statistics:');
    console.log(`   Both (mixed):`);
    console.log(`     Encoded packets: ${bothStats.packets}`);
    console.log(`     Encoded bytes: ${(bothStats.bytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`     Muxed packets: ${bothStats.muxedPackets}`);
    console.log(`     Muxed bytes: ${(bothStats.muxedBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`     File: ${bothOutputPath}`);
    console.log(`   Desktop:`);
    console.log(`     Encoded packets: ${desktopStats.packets}`);
    console.log(`     Encoded bytes: ${(desktopStats.bytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`     Muxed packets: ${desktopStats.muxedPackets}`);
    console.log(`     Muxed bytes: ${(desktopStats.muxedBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`     File: ${desktopOutputPath}`);
    console.log(`   Mic:`);
    console.log(`     Encoded packets: ${micStats.packets}`);
    console.log(`     Encoded bytes: ${(micStats.bytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`     Muxed packets: ${micStats.muxedPackets}`);
    console.log(`     Muxed bytes: ${(micStats.muxedBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`     File: ${micOutputPath}\n`);
    
    // Check if files exist and have content
    const checkFile = (filePath, name) => {
      if (fs.existsSync(filePath)) {
        const stats = fs.statSync(filePath);
        if (stats.size > 0) {
          console.log(`✅ ${name}: ${filePath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
          
          // Check if file is valid MP4 (starts with ftyp box)
          const buffer = Buffer.alloc(8);
          const fd = fs.openSync(filePath, 'r');
          fs.readSync(fd, buffer, 0, 8, 0);
          fs.closeSync(fd);
          
          // MP4 files start with a box size (4 bytes) followed by 'ftyp' (4 bytes)
          const boxType = buffer.toString('ascii', 4, 8);
          if (boxType === 'ftyp') {
            console.log(`   ✅ Valid MP4 file (starts with 'ftyp' box)`);
          } else {
            console.log(`   ⚠️  File exists but may not be a valid MP4 (box type: ${boxType})`);
          }
          
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
    
    console.log('📁 Generated MP4 files:');
    const bothOk = checkFile(bothOutputPath, 'Both (mixed)');
    const desktopOk = checkFile(desktopOutputPath, 'Desktop');
    const micOk = checkFile(micOutputPath, 'Mic');
    
    console.log('\n🎉 Test complete!');
    console.log('   Check the MP4 files for:');
    console.log(`   - Valid MP4 container structure`);
    console.log(`   - Proper PTS/DTS timestamps`);
    console.log(`   - Audio playback in VLC/media player`);
    console.log(`   - No artefacts or sync issues\n`);
    
    if (bothOk && desktopOk && micOk) {
      console.log('✅ All MP4 files generated successfully!');
      console.log('   You can now test playback in VLC or any media player.');
    } else {
      console.log('⚠️  Some files are missing or empty - check the errors above');
    }
    
    process.exit(0);
  }, 500); // Wait 500ms for finalization
}, 10000); // 10 seconds




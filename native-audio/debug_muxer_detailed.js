const path = require('path');
const fs = require('fs');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;
const AudioEngineEncoder = nativeModule.AudioEngineEncoder;

// ============================================================================
// DETAILED DEBUG: AudioMuxer
// ============================================================================
// Ce script teste AudioMuxer avec des logs détaillés pour identifier les problèmes
// - Logs chaque étape du muxing
// - Vérifie les packets encodés vs muxés
// - Vérifie la structure du fichier MP4 généré
// - Teste avec différentes durées
// ============================================================================

console.log('🔍 DETAILED DEBUG: AudioMuxer');
console.log('   This script provides detailed logging for AudioMuxer debugging');
console.log('   Recording for 5 seconds...\n');

// Output file
const outputDir = __dirname;
const outputPath = path.join(outputDir, 'debug_muxer_detailed.mp4');

// Remove existing file
if (fs.existsSync(outputPath)) {
  fs.unlinkSync(outputPath);
  console.log('🗑️  Removed existing output file');
}

console.log('📁 Output file:', outputPath);

// Statistics with detailed tracking
let stats = {
  wasapiCallbacks: { desktop: 0, mic: 0 },
  engineFeeds: { desktop: 0, mic: 0 },
  engineTicks: 0,
  encodedPackets: 0,
  encodedBytes: 0,
  muxedPackets: 0,
  muxedBytes: 0,
  lastEncodedPackets: 0,
  lastMuxedPackets: 0,
  lastEncodedBytes: 0,
  lastMuxedBytes: 0
};

// Recording state
let isRecording = true;
let recordingStartTime = null;
let lastStatsLog = Date.now();

// ============================================================================
// WASAPI Capture Setup
// ============================================================================

console.log('🎤 Initializing WASAPI capture...');
const capture = new WASAPICapture((buffer, source, format) => {
  if (!isRecording) return;
  
  if (!buffer || buffer.length === 0) {
    console.warn(`⚠️  Empty buffer received from ${source}`);
    return;
  }
  
  stats.wasapiCallbacks[source]++;
  
  // Get format info
  const sampleRate = format.sampleRate;
  const channels = format.channels;
  const bitsPerSample = format.bitsPerSample;
  const blockAlign = format.blockAlign;
  
  // Calculate data size and frames
  const dataSize = buffer.length;
  const numFrames = dataSize / blockAlign;
  
  // Log first callback from each source
  if (stats.wasapiCallbacks[source] === 1) {
    console.log(`📥 First ${source} callback: ${numFrames} frames, ${dataSize} bytes`);
    console.log(`   Format: ${sampleRate} Hz, ${channels}ch, ${bitsPerSample}-bit`);
  }
  
  // Feed audio data to AudioEngine
  if (engine && engine.isRunning()) {
    engine.feedAudioData(buffer, numFrames, source);
    stats.engineFeeds[source]++;
  }
}, 'both');

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
// AudioEngineEncoder Setup (MP4 mode)
// ============================================================================

console.log('🎵 Initializing AudioEngineEncoder (MP4 mode)...');
const engine = new AudioEngineEncoder();

// Initialize with MP4 output (default mode, useRawAac = false)
const initialized = engine.initialize(outputPath, 192000, false);
if (!initialized) {
  console.error('❌ Failed to initialize AudioEngineEncoder');
  console.error('   Possible causes:');
  console.error('   - FFmpeg libraries not found');
  console.error('   - Invalid output path');
  console.error('   - Codec initialization failed');
  process.exit(1);
}

console.log(`✅ AudioEngineEncoder initialized`);
console.log(`   Output: ${outputPath}`);
console.log(`   Bitrate: 192 kbps\n`);

// ============================================================================
// Start Recording
// ============================================================================

console.log('🎙️  Starting WASAPI capture and AudioEngineEncoder...\n');

if (!capture.start()) {
  console.error('❌ Failed to start WASAPI capture');
  process.exit(1);
}

// Start engine
if (!engine.start()) {
  console.error('❌ Failed to start AudioEngineEncoder');
  process.exit(1);
}

recordingStartTime = Date.now();
lastStatsLog = Date.now();
console.log('✅ Recording started, will record for 5 seconds...\n');

// Tick engine every 10ms and log detailed stats
const tickInterval = setInterval(() => {
  if (!isRecording) {
    clearInterval(tickInterval);
    return;
  }
  
  try {
    // Tick engine
    engine.tick();
    stats.engineTicks++;
    
    // Update statistics
    const currentEncodedPackets = engine.getEncodedPackets();
    const currentEncodedBytes = engine.getEncodedBytes();
    const currentMuxedPackets = engine.getMuxedPackets();
    const currentMuxedBytes = engine.getMuxedBytes();
    
    // Check for changes
    const encodedPacketsDelta = currentEncodedPackets - stats.lastEncodedPackets;
    const muxedPacketsDelta = currentMuxedPackets - stats.lastMuxedPackets;
    const encodedBytesDelta = currentEncodedBytes - stats.lastEncodedBytes;
    const muxedBytesDelta = currentMuxedBytes - stats.lastMuxedBytes;
    
    stats.encodedPackets = currentEncodedPackets;
    stats.encodedBytes = currentEncodedBytes;
    stats.muxedPackets = currentMuxedPackets;
    stats.muxedBytes = currentMuxedBytes;
    
    // Log every second with detailed info
    const now = Date.now();
    if (now - lastStatsLog >= 1000) {
      const elapsed = (now - recordingStartTime) / 1000;
      const pts = engine.getCurrentPTSSeconds();
      
      console.log(`⏱️  ${elapsed.toFixed(1)}s - Stats:`);
      console.log(`   WASAPI callbacks: desktop=${stats.wasapiCallbacks.desktop}, mic=${stats.wasapiCallbacks.mic}`);
      console.log(`   Engine feeds: desktop=${stats.engineFeeds.desktop}, mic=${stats.engineFeeds.mic}`);
      console.log(`   Engine ticks: ${stats.engineTicks}`);
      console.log(`   Encoded: ${stats.encodedPackets} packets (${(stats.encodedBytes/1024).toFixed(1)}KB) [+${encodedPacketsDelta} packets, +${(encodedBytesDelta/1024).toFixed(1)}KB]`);
      console.log(`   Muxed: ${stats.muxedPackets} packets (${(stats.muxedBytes/1024).toFixed(1)}KB) [+${muxedPacketsDelta} packets, +${(muxedBytesDelta/1024).toFixed(1)}KB]`);
      console.log(`   PTS: ${pts.toFixed(3)}s`);
      
      // Check for issues
      if (encodedPacketsDelta > 0 && muxedPacketsDelta === 0) {
        console.warn(`   ⚠️  WARNING: Encoded packets increased but muxed packets did not!`);
      }
      if (stats.encodedPackets > stats.muxedPackets + 10) {
        console.warn(`   ⚠️  WARNING: Large gap between encoded (${stats.encodedPackets}) and muxed (${stats.muxedPackets}) packets!`);
      }
      if (stats.wasapiCallbacks.desktop === 0 && stats.wasapiCallbacks.mic === 0) {
        console.warn(`   ⚠️  WARNING: No WASAPI callbacks received!`);
      }
      
      console.log('');
      
      lastStatsLog = now;
      stats.lastEncodedPackets = currentEncodedPackets;
      stats.lastMuxedPackets = currentMuxedPackets;
      stats.lastEncodedBytes = currentEncodedBytes;
      stats.lastMuxedBytes = currentMuxedBytes;
    }
  } catch (error) {
    console.error('❌ Error in tick interval:', error);
    console.error('Stack:', error.stack);
  }
}, 10); // 10ms tick interval

// Handle uncaught errors
process.on('uncaughtException', (error) => {
  console.error('❌ Uncaught exception:', error);
  console.error('Stack:', error.stack);
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

// Record for 5 seconds
console.log('⏳ Waiting 5 seconds...\n');
setTimeout(() => {
  console.log('\n⏹️  Stopping recording...\n');
  isRecording = false;
  
  clearInterval(tickInterval);
  
  // Final tick to flush
  engine.tick();
  
  // Wait a bit for finalization
  setTimeout(() => {
    // Stop engine (this will flush encoder and finalize muxer)
    engine.stop();
    
    capture.stop();
    
    // Wait a bit more for finalization
    setTimeout(() => {
      // Final statistics
      stats.encodedPackets = engine.getEncodedPackets();
      stats.encodedBytes = engine.getEncodedBytes();
      stats.muxedPackets = engine.getMuxedPackets();
      stats.muxedBytes = engine.getMuxedBytes();
      
      console.log('📊 Final Statistics:');
      console.log(`   WASAPI callbacks: desktop=${stats.wasapiCallbacks.desktop}, mic=${stats.wasapiCallbacks.mic}`);
      console.log(`   Engine feeds: desktop=${stats.engineFeeds.desktop}, mic=${stats.engineFeeds.mic}`);
      console.log(`   Engine ticks: ${stats.engineTicks}`);
      console.log(`   Encoded packets: ${stats.encodedPackets}`);
      console.log(`   Encoded bytes: ${(stats.encodedBytes / 1024 / 1024).toFixed(2)} MB`);
      console.log(`   Muxed packets: ${stats.muxedPackets}`);
      console.log(`   Muxed bytes: ${(stats.muxedBytes / 1024 / 1024).toFixed(2)} MB`);
      console.log(`   PTS: ${engine.getCurrentPTSSeconds().toFixed(3)}s\n`);
      
      // Check for issues
      if (stats.encodedPackets === 0) {
        console.error('❌ ERROR: No packets were encoded!');
        console.error('   Possible causes:');
        console.error('   - No audio data received from WASAPI');
        console.error('   - AudioEncoder not receiving data');
        console.error('   - AudioEncoder initialization failed');
      }
      
      if (stats.muxedPackets === 0) {
        console.error('❌ ERROR: No packets were muxed!');
        console.error('   Possible causes:');
        console.error('   - AudioMuxer not receiving encoded packets');
        console.error('   - AudioMuxer initialization failed');
        console.error('   - File write permissions issue');
      }
      
      if (stats.encodedPackets > 0 && stats.muxedPackets === 0) {
        console.error('❌ ERROR: Packets were encoded but not muxed!');
        console.error('   This indicates a problem in AudioMuxer::WritePacket()');
      }
      
      if (stats.encodedPackets > stats.muxedPackets + 1) {
        console.warn(`⚠️  WARNING: ${stats.encodedPackets - stats.muxedPackets} packets were encoded but not muxed`);
        console.warn('   This might be normal if the last packet is still being processed');
      }
      
      // Check if file exists and has content
      console.log('📁 Checking output file...');
      if (fs.existsSync(outputPath)) {
        const fileStats = fs.statSync(outputPath);
        console.log(`✅ File exists: ${outputPath}`);
        console.log(`   Size: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);
        
        if (fileStats.size === 0) {
          console.error('❌ ERROR: File exists but is empty!');
          console.error('   AudioMuxer may have failed to write data');
        } else {
          // Check MP4 structure
          const buffer = Buffer.alloc(Math.min(1024, fileStats.size));
          const fd = fs.openSync(outputPath, 'r');
          fs.readSync(fd, buffer, 0, buffer.length, 0);
          fs.closeSync(fd);
          
          // Check for MP4 signature
          const boxType = buffer.toString('ascii', 4, 8);
          if (boxType === 'ftyp') {
            console.log(`   ✅ Valid MP4 file (starts with 'ftyp' box)`);
            
            // Check for moov box (should be present in non-fragmented MP4)
            const fileContent = fs.readFileSync(outputPath);
            const moovIndex = fileContent.indexOf('moov');
            if (moovIndex >= 0) {
              console.log(`   ✅ Contains 'moov' box at offset ${moovIndex}`);
            } else {
              console.warn(`   ⚠️  'moov' box not found (might be fragmented MP4)`);
            }
            
            // Check for mdat box (audio data)
            const mdatIndex = fileContent.indexOf('mdat');
            if (mdatIndex >= 0) {
              console.log(`   ✅ Contains 'mdat' box at offset ${mdatIndex}`);
            } else {
              console.warn(`   ⚠️  'mdat' box not found (no audio data?)`);
            }
          } else {
            console.error(`   ❌ Invalid MP4 file (box type: ${boxType})`);
            console.error('   Expected "ftyp" but got something else');
          }
        }
      } else {
        console.error(`❌ ERROR: Output file not found: ${outputPath}`);
        console.error('   AudioMuxer may have failed to create the file');
      }
      
      console.log('\n🎉 Debug complete!');
      console.log('   Review the statistics above to identify issues.');
      
      process.exit(0);
    }, 500); // Wait 500ms for finalization
  }, 200); // Wait 200ms after stop
}, 5000); // 5 seconds




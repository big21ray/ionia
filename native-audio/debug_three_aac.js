const path = require('path');
const fs = require('fs');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;
const AudioEngineEncoder = nativeModule.AudioEngineEncoder;

console.log('🎬 Testing Audio Engine with AAC Encoding (3 separate files)...');
console.log('   - debug_both.aac: Desktop + Mic mixed');
console.log('   - debug_desktop.aac: Desktop only');
console.log('   - debug_mic.aac: Mic only');
console.log('   - Using C++ AudioEngineEncoder (OBS-like)\n');

// Output files
const outputDir = __dirname;
const outputBoth = path.join(outputDir, 'debug_both.aac');
const outputDesktop = path.join(outputDir, 'debug_desktop.aac');
const outputMic = path.join(outputDir, 'debug_mic.aac');

// Remove existing files if they exist
[outputBoth, outputDesktop, outputMic].forEach(file => {
  if (fs.existsSync(file)) {
    fs.unlinkSync(file);
    console.log(`🗑️  Removed existing: ${path.basename(file)}`);
  }
});

console.log('📁 Output files:');
console.log(`   ${path.basename(outputBoth)}`);
console.log(`   ${path.basename(outputDesktop)}`);
console.log(`   ${path.basename(outputMic)}\n`);

// Statistics
let desktopCallbackCount = 0;
let micCallbackCount = 0;
let isRecording = false;

// Initialize 3 Audio Engine Encoders (one for each output)
console.log('🎵 Initializing 3 Audio Engine Encoders...');

const encoderBoth = new AudioEngineEncoder();
const encoderDesktop = new AudioEngineEncoder();
const encoderMic = new AudioEngineEncoder();

// Initialize with output paths and bitrate (192kbps)
const initializedBoth = encoderBoth.initialize(outputBoth, 192000);
const initializedDesktop = encoderDesktop.initialize(outputDesktop, 192000);
const initializedMic = encoderMic.initialize(outputMic, 192000);

if (!initializedBoth || !initializedDesktop || !initializedMic) {
  console.error('❌ Failed to initialize one or more Audio Engine Encoders');
  console.error('   Make sure FFmpeg libraries are available');
  process.exit(1);
}

console.log('✅ All 3 encoders initialized');

// Initialize audio capture
console.log('🎤 Initializing WASAPI audio capture...');
const audioCapture = new WASAPICapture((buffer, source, format) => {
  if (!isRecording) return;
  if (!buffer || buffer.length === 0) return;

  const bytesPerFrame = format.channels * (format.bitsPerSample / 8);
  const numFrames = buffer.length / bytesPerFrame;

  // Feed audio data to the appropriate encoders
  if (source === 'desktop') {
    // Feed desktop to both and desktop encoders
    encoderBoth.feedAudioData(buffer, numFrames, source);
    encoderDesktop.feedAudioData(buffer, numFrames, source);
    desktopCallbackCount++;
  } else if (source === 'mic') {
    // Feed mic to both and mic encoders
    encoderBoth.feedAudioData(buffer, numFrames, source);
    encoderMic.feedAudioData(buffer, numFrames, source);
    micCallbackCount++;
  }
}, 'both');

// Get format
const format = audioCapture.getFormat();
if (format) {
  console.log(`🎵 Unified audio format: ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
}

// Start all 3 Audio Engines
console.log('⏱️ Starting all 3 Audio Engines...');
const startedBoth = encoderBoth.start();
const startedDesktop = encoderDesktop.start();
const startedMic = encoderMic.start();

if (!startedBoth || !startedDesktop || !startedMic) {
  console.error('❌ Failed to start one or more Audio Engines');
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
console.log('✅ Audio capture and all engines started');
console.log('⏺ Recording for ~10 seconds...');
console.log('   (Audio will be encoded to AAC in 3 separate files)');
console.log('(Press Ctrl+C to stop early)\n');

// Use a timer to tick all 3 Audio Engines (every 10ms)
const tickInterval = setInterval(() => {
  if (isRecording) {
    encoderBoth.tick();      // Encodes and muxes both
    encoderDesktop.tick();   // Encodes and muxes desktop only
    encoderMic.tick();       // Encodes and muxes mic only
  }
}, 10); // 10ms - Audio Engine controls actual send rate

// Record for ~10 seconds
setTimeout(() => {
  console.log('\n🛑 Stopping capture...');
  isRecording = false;
  
  // Stop the tick interval
  clearInterval(tickInterval);
  
  // Final tick to flush any remaining audio
  encoderBoth.tick();
  encoderDesktop.tick();
  encoderMic.tick();
  
  // Wait a bit for buffers to flush
  setTimeout(() => {
    // Get statistics from all encoders
    const statsBoth = {
      ptsFrames: encoderBoth.getCurrentPTSFrames(),
      ptsSeconds: encoderBoth.getCurrentPTSSeconds(),
      encodedPackets: encoderBoth.getEncodedPackets(),
      encodedBytes: encoderBoth.getEncodedBytes(),
      muxedPackets: encoderBoth.getMuxedPackets(),
      muxedBytes: encoderBoth.getMuxedBytes()
    };

    const statsDesktop = {
      ptsFrames: encoderDesktop.getCurrentPTSFrames(),
      ptsSeconds: encoderDesktop.getCurrentPTSSeconds(),
      encodedPackets: encoderDesktop.getEncodedPackets(),
      encodedBytes: encoderDesktop.getEncodedBytes(),
      muxedPackets: encoderDesktop.getMuxedPackets(),
      muxedBytes: encoderDesktop.getMuxedBytes()
    };

    const statsMic = {
      ptsFrames: encoderMic.getCurrentPTSFrames(),
      ptsSeconds: encoderMic.getCurrentPTSSeconds(),
      encodedPackets: encoderMic.getEncodedPackets(),
      encodedBytes: encoderMic.getEncodedBytes(),
      muxedPackets: encoderMic.getMuxedPackets(),
      muxedBytes: encoderMic.getMuxedBytes()
    };
    
    console.log('\n📊 Final Statistics:');
    console.log(`   Desktop callbacks: ${desktopCallbackCount}`);
    console.log(`   Mic callbacks: ${micCallbackCount}`);
    
    console.log('\n📊 Both (Desktop + Mic):');
    console.log(`   PTS: ${statsBoth.ptsFrames} frames (${statsBoth.ptsSeconds.toFixed(2)}s)`);
    console.log(`   Encoded packets: ${statsBoth.encodedPackets}`);
    console.log(`   Encoded bytes: ${(statsBoth.encodedBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Muxed packets: ${statsBoth.muxedPackets}`);
    console.log(`   Muxed bytes: ${(statsBoth.muxedBytes / 1024 / 1024).toFixed(2)} MB`);
    
    console.log('\n📊 Desktop only:');
    console.log(`   PTS: ${statsDesktop.ptsFrames} frames (${statsDesktop.ptsSeconds.toFixed(2)}s)`);
    console.log(`   Encoded packets: ${statsDesktop.encodedPackets}`);
    console.log(`   Encoded bytes: ${(statsDesktop.encodedBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Muxed packets: ${statsDesktop.muxedPackets}`);
    console.log(`   Muxed bytes: ${(statsDesktop.muxedBytes / 1024 / 1024).toFixed(2)} MB`);
    
    console.log('\n📊 Mic only:');
    console.log(`   PTS: ${statsMic.ptsFrames} frames (${statsMic.ptsSeconds.toFixed(2)}s)`);
    console.log(`   Encoded packets: ${statsMic.encodedPackets}`);
    console.log(`   Encoded bytes: ${(statsMic.encodedBytes / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Muxed packets: ${statsMic.muxedPackets}`);
    console.log(`   Muxed bytes: ${(statsMic.muxedBytes / 1024 / 1024).toFixed(2)} MB`);
    
    // Stop all encoders (this will flush encoder and finalize muxer)
    encoderBoth.stop();
    encoderDesktop.stop();
    encoderMic.stop();
    
    // Stop audio capture
    audioCapture.stop();
    
    // Check if output files exist
    console.log('\n📁 Output files:');
    [outputBoth, outputDesktop, outputMic].forEach(file => {
      if (fs.existsSync(file)) {
        const stats = fs.statSync(file);
        console.log(`   ✅ ${path.basename(file)}: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
      } else {
        console.log(`   ❌ ${path.basename(file)}: NOT FOUND`);
      }
    });
    
    console.log('\n✅ Test completed!');
    console.log('   Audio was encoded to AAC in 3 separate files with explicit PTS control');
    
    process.exit(0);
  }, 500);
}, 10000);

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\n\n🛑 Interrupted by user');
  isRecording = false;
  clearInterval(tickInterval);
  encoderBoth.tick();
  encoderDesktop.tick();
  encoderMic.tick();
  setTimeout(() => {
    encoderBoth.stop();
    encoderDesktop.stop();
    encoderMic.stop();
    audioCapture.stop();
    process.exit(0);
  }, 500);
});


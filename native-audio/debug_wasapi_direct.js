const path = require('path');
const fs = require('fs');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;

// ============================================================================
// TEST: WASAPI Capture Direct → WAV Files
// ============================================================================
// Ce script teste UNIQUEMENT la partie WASAPI Capture (lignes 7-10 de ARTEFACTS_DEBUG.md)
// - Capture desktop et mic directement depuis WASAPI
// - Écrit les données brutes dans des fichiers .wav
// - Permet de vérifier si les artefacts viennent de la capture WASAPI elle-même
// ============================================================================

console.log('🔍 Testing WASAPI Capture Direct → WAV files');
console.log('   This isolates the WASAPI capture step to check for artefacts');
console.log('   Recording for 10 seconds...\n');

// Output files
const outputDir = __dirname;
const desktopOutputPath = path.join(outputDir, 'test_wasapi_desktop.wav');
const micOutputPath = path.join(outputDir, 'test_wasapi_mic.wav');

// WAV file handles
let desktopWavFile = null;
let desktopWavDataSize = 0;
let micWavFile = null;
let micWavDataSize = 0;

// Statistics
let desktopChunks = 0;
let micChunks = 0;
let desktopTotalFrames = 0;
let micTotalFrames = 0;

// Recording state
let isRecording = true;
let recordingStartTime = null;

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
// Callback signature: (buffer, source, format)
const capture = new WASAPICapture((buffer, source, format) => {
  if (!isRecording) return;
  
  // Get format info
  const sampleRate = format.sampleRate;
  const channels = format.channels;
  const bitsPerSample = format.bitsPerSample;
  const blockAlign = format.blockAlign;
  
  // Calculate data size (buffer.length is the actual data size)
  const dataSize = buffer.length;
  const numFrames = dataSize / blockAlign;
  
  // Initialize WAV files on first chunk (if not already initialized)
  if (source === 'desktop' && !desktopWavFile) {
    console.log(`📝 Desktop format: ${sampleRate} Hz, ${channels} channels, ${bitsPerSample} bits`);
    const result = initWavFile(desktopOutputPath, sampleRate, channels, bitsPerSample);
    desktopWavFile = result.fileHandle;
    desktopWavDataSize = result.dataSize;
  }
  
  if (source === 'mic' && !micWavFile) {
    console.log(`📝 Microphone format: ${sampleRate} Hz, ${channels} channels, ${bitsPerSample} bits`);
    const result = initWavFile(micOutputPath, sampleRate, channels, bitsPerSample);
    micWavFile = result.fileHandle;
    micWavDataSize = result.dataSize;
  }
  
  // Write audio data to appropriate WAV file
  if (source === 'desktop' && desktopWavFile) {
    fs.writeSync(desktopWavFile, buffer, 0, dataSize);
    desktopWavDataSize += dataSize;
    desktopChunks++;
    desktopTotalFrames += numFrames;
  } else if (source === 'mic' && micWavFile) {
    fs.writeSync(micWavFile, buffer, 0, dataSize);
    micWavDataSize += dataSize;
    micChunks++;
    micTotalFrames += numFrames;
  }
  
  // NOTE: We don't create a "both" file here because desktop and mic chunks
  // arrive asynchronously from different threads. A proper mix requires:
  // 1. Buffering chunks from both sources
  // 2. Synchronizing by timestamp/frame
  // 3. Mixing sample-by-sample: mixed[i] = desktop[i] + mic[i]
  // This is what AudioEngine::MixAudio() does in C++.
  // For WASAPI testing, we only need desktop.wav and mic.wav separately.
  
  // Log progress every second
  if (recordingStartTime) {
    const elapsed = Date.now() - recordingStartTime;
    if (elapsed > 0 && elapsed % 1000 < 100) { // Log roughly every second
      const elapsedSeconds = (elapsed / 1000).toFixed(1);
      console.log(`⏱️  ${elapsedSeconds}s - Desktop: ${desktopChunks} chunks (${desktopTotalFrames} frames), Mic: ${micChunks} chunks (${micTotalFrames} frames)`);
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
// Start Recording
// ============================================================================

console.log('🎙️  Starting WASAPI capture...\n');

if (!capture.start()) {
  console.error('❌ Failed to start WASAPI capture');
  process.exit(1);
}

recordingStartTime = Date.now();

// Record for 10 seconds
setTimeout(() => {
  console.log('\n⏹️  Stopping recording...\n');
  isRecording = false;
  
  capture.stop();
  
  // Finalize WAV files
  if (desktopWavFile) {
    finalizeWavFile(desktopWavFile, desktopWavDataSize);
    console.log(`✅ Desktop WAV file written: ${desktopOutputPath}`);
    console.log(`   Size: ${(desktopWavDataSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Chunks: ${desktopChunks}, Total frames: ${desktopTotalFrames}`);
    const desktopDuration = desktopTotalFrames / format.sampleRate;
    console.log(`   Duration: ${desktopDuration.toFixed(2)} seconds\n`);
  }
  
  if (micWavFile) {
    finalizeWavFile(micWavFile, micWavDataSize);
    console.log(`✅ Microphone WAV file written: ${micOutputPath}`);
    console.log(`   Size: ${(micWavDataSize / 1024 / 1024).toFixed(2)} MB`);
    console.log(`   Chunks: ${micChunks}, Total frames: ${micTotalFrames}`);
    const micDuration = micTotalFrames / format.sampleRate;
    console.log(`   Duration: ${micDuration.toFixed(2)} seconds\n`);
  }
  
  console.log('🎉 Test complete!');
  console.log('   Check the WAV files for artefacts:');
  console.log(`   - ${desktopOutputPath} (desktop only)`);
  console.log(`   - ${micOutputPath} (mic only)`);
  console.log('\n   NOTE: For a proper mix (desktop + mic), use AudioEngine::MixAudio()');
  console.log('   which synchronizes and mixes the sources sample-by-sample.');
  console.log('\n   If artefacts are present in these files, the problem is in WASAPI capture.');
  console.log('   If no artefacts, the problem is in AudioEngine/Encoder/Muxer.\n');
  
  process.exit(0);
}, 10000); // 10 seconds


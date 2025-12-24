const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load the native module
const nativeModule = require('./index.js');
const WASAPICapture = nativeModule.WASAPICapture;

// ============================================================================
// AUDIO ENCODING: Utilise FFmpeg pour encoder en AAC
// ============================================================================
// L'encoding se fait via FFmpeg (comme dans debug_record_ffmpeg.js)
// Pas d'encoding C++ - tout passe par FFmpeg
// ============================================================================

// ============================================================================
// ÉTAPE 1: WASAPI CAPTURE (NO MIX, NO TIMING)
// ============================================================================
// OBS reçoit: buffers, timestamps approximatifs, formats variables
// OBS ne fait AUCUN pacing ici, ne mélange RIEN ici
// Il empile juste des samples.
// ============================================================================

// Audio buffers (empilés comme OBS - pas de mix, pas de timing)
let desktopChunks = [];
let micChunks = [];
let desktopFormat = null;
let micFormat = null;
let desktopCallbackCount = 0;
let micCallbackCount = 0;

// Create output directory
const outputDir = __dirname;
const desktopOutputPath = path.join(outputDir, 'debug_desktop_output.wav');
const micOutputPath = path.join(outputDir, 'debug_mic_output.wav');
const bothOutputPath = path.join(outputDir, 'debug_both.wav');
// Note: Encoding AAC is done via FFmpeg (see debug_record_ffmpeg.js)

console.log('🎬 Testing WASAPI → Audio Engine → WAV output (OBS-like architecture)...');
console.log('   Encoding AAC via FFmpeg (see debug_record_ffmpeg.js for example)');
console.log('📁 Desktop WAV output:', desktopOutputPath);
console.log('📁 Mic WAV output:', micOutputPath);
console.log('📁 Mixed WAV output:', bothOutputPath);

// WAV file writers (separate for desktop, mic, and mixed)
let desktopWavFileHandle = null;
let desktopWavDataSize = 0;
let micWavFileHandle = null;
let micWavDataSize = 0;
let bothWavFileHandle = null;
let bothWavDataSize = 0;

let desktopAudioBytesWritten = 0;
let micAudioBytesWritten = 0;
let bothAudioBytesWritten = 0;
let isRecording = true;

// Note: Encoding AAC is done via FFmpeg (see debug_record_ffmpeg.js)
// This script only outputs WAV files for verification

// ============================================================================
// WAV FILE WRITER (pour vérifier la logique sans FFmpeg)
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

function writeWavData(fileHandle, dataSize, data) {
  if (!fileHandle) {
    return dataSize;
  }
  try {
    fs.writeSync(fileHandle, data, 0, data.length);
    return dataSize + data.length;
  } catch (err) {
    console.error('❌ Error writing to WAV file:', err);
    isRecording = false;
    return dataSize;
  }
}

function finalizeWavFile(filePath, fileHandle, dataSize, sourceName) {
  if (!fileHandle) {
    return;
  }
  try {
    // Update file size in RIFF header
    const fileSize = 36 + dataSize; // 36 = header size - 8, dataSize = data size
    fs.writeSync(fileHandle, Buffer.from([fileSize & 0xFF, (fileSize >> 8) & 0xFF, (fileSize >> 16) & 0xFF, (fileSize >> 24) & 0xFF]), 0, 4, 4);
    
    // Update data size in data chunk
    fs.writeSync(fileHandle, Buffer.from([dataSize & 0xFF, (dataSize >> 8) & 0xFF, (dataSize >> 16) & 0xFF, (dataSize >> 24) & 0xFF]), 0, 4, 40);
    
    fs.closeSync(fileHandle);
    console.log(`✅ ${sourceName} WAV file finalized: ${(dataSize / 1024 / 1024).toFixed(2)} MB of audio data`);
  } catch (err) {
    console.error(`❌ Error finalizing ${sourceName} WAV file:`, err);
  }
}

// ============================================================================
// ÉTAPE 2: AUDIO ENGINE OBS = CLOCK MASTER
// ============================================================================
// C'est LE point clé que le code doit copier.
// OBS calcule à chaque tick:
//   expected_samples = (now - start_time) * sample_rate
//   to_send = expected_samples - sent_samples
//   si to_send > 0 → produire de l'audio
//   si source absente → silence
//   jamais de "rattrapage brutal"
// Le temps appartient à OBS, pas au périphérique.
// ============================================================================

// Monotonic clock (OBS-like) - insensible aux ajustements système
const nowMs = () => Number(process.hrtime.bigint() / 1_000_000n);

// Audio Engine constants (OBS-like)
const AUDIO_ENGINE_SAMPLE_RATE = 48000;  // Unified format (C++ already resampled)
const AUDIO_ENGINE_CHANNELS = 2;  // Stereo (C++ already adapted)
const AUDIO_ENGINE_BYTES_PER_SAMPLE = 4;  // float32
const AUDIO_ENGINE_BYTES_PER_FRAME = AUDIO_ENGINE_CHANNELS * AUDIO_ENGINE_BYTES_PER_SAMPLE;  // 8 bytes per frame

// Audio Engine state (OBS-like)
let audioEngineStartTime = null;  // When audio engine started (monotonic clock)
let audioEngineFramesSent = 0;  // Total FRAMES sent (OBS-like: count in frames, not samples)
let lastLogTime = 0;  // For periodic logging

// WAV file will be initialized when format is known

// ============================================================================
// ÉTAPE 3: MIXING OBS (non bloquant)
// ============================================================================
// OBS:
//   - mixe chaque source indépendamment
//   - si une source n'a rien → 0.0
//   - aucune attente entre mic / desktop
// Contrairement à min(desktop, mic).
// ============================================================================

// Function to mix desktop and mic audio (OBS-like: non-blocking)
function mixAudioSources(desktopPcm, micPcm, numFrames, bytesPerFrame, format) {
  const mixedBuffer = Buffer.alloc(numFrames * bytesPerFrame);
  const micGain = 0.9;  // Slight gain reduction for mic

  const desktopFrames = desktopPcm ? desktopPcm.length / bytesPerFrame : 0;
  const micFrames = micPcm ? micPcm.length / bytesPerFrame : 0;

  for (let frame = 0; frame < numFrames; frame++) {
    for (let ch = 0; ch < format.channels; ch++) {
      let desktopSample = 0;
      let micSample = 0;

      // OBS-like: Get desktop sample if available, otherwise use silence (0)
      if (desktopPcm && frame < desktopFrames) {
        const offset = frame * bytesPerFrame + ch * AUDIO_ENGINE_BYTES_PER_SAMPLE;
        desktopSample = desktopPcm.readFloatLE(offset);
      }
      // else: desktopSample = 0 (silence) - OBS behavior

      // OBS-like: Get mic sample if available, otherwise use silence (0)
      if (micPcm && frame < micFrames) {
        const offset = frame * bytesPerFrame + ch * AUDIO_ENGINE_BYTES_PER_SAMPLE;
        micSample = micPcm.readFloatLE(offset) * micGain;
      }
      // else: micSample = 0 (silence) - OBS behavior

      // Mix and clamp
      let mixed = desktopSample + micSample;
      if (mixed > 1.0) mixed = 1.0;
      if (mixed < -1.0) mixed = -1.0;

      // Write mixed sample
      const outputOffset = frame * bytesPerFrame + ch * AUDIO_ENGINE_BYTES_PER_SAMPLE;
      mixedBuffer.writeFloatLE(mixed, outputOffset);
    }
  }

  return mixedBuffer;
}

// ============================================================================
// ÉTAPE 4: RESAMPLING (déjà fait en C++ comme OBS)
// ============================================================================
// Le code C++ fait déjà:
//   - ConvertToFloat32 → tout devient float32
//   - ResampleToTarget → tout devient 48 kHz
//   - AdaptChannels → tout devient stéréo
// Donc on reçoit déjà du float32, 48kHz, stéréo.
// Une seule horloge audio dans tout le système.
// ============================================================================

// ============================================================================
// ÉTAPE 5: AUDIO ENGINE TICK (OBS-like)
// ============================================================================
// OBS calcule à chaque tick:
//   expected_samples = (now - start_time) * sample_rate
//   to_send = expected_samples - sent_samples
//   si to_send > 0 → produire de l'audio
//   si source absente → silence
//   jamais de "rattrapage brutal"
// ============================================================================

function audioEngineTick() {
  if (!isRecording) {
    return;
  }

  const format = desktopFormat || micFormat;
  if (!format) {
    return;  // No format yet, wait
  }

  // Initialize WAV files when formats are known
  if (!desktopWavFileHandle && desktopFormat) {
    const result = initWavFile(desktopOutputPath, desktopFormat.sampleRate, desktopFormat.channels, desktopFormat.bitsPerSample);
    desktopWavFileHandle = result.fileHandle;
    desktopWavDataSize = result.dataSize;
    console.log(`📝 Desktop WAV file initialized: ${desktopFormat.sampleRate} Hz, ${desktopFormat.channels}ch, ${desktopFormat.bitsPerSample}-bit`);
  }
  if (!micWavFileHandle && micFormat) {
    const result = initWavFile(micOutputPath, micFormat.sampleRate, micFormat.channels, micFormat.bitsPerSample);
    micWavFileHandle = result.fileHandle;
    micWavDataSize = result.dataSize;
    console.log(`📝 Mic WAV file initialized: ${micFormat.sampleRate} Hz, ${micFormat.channels}ch, ${micFormat.bitsPerSample}-bit`);
  }
  if (!bothWavFileHandle && format) {
    const result = initWavFile(bothOutputPath, format.sampleRate, format.channels, format.bitsPerSample);
    bothWavFileHandle = result.fileHandle;
    bothWavDataSize = result.dataSize;
    console.log(`📝 Mixed (both) WAV file initialized: ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
  }
  
  // Note: Encoding AAC is done via FFmpeg (see debug_record_ffmpeg.js for example)
  // This script only outputs WAV files for verification

  // Initialize audio engine start time (monotonic clock - OBS-like)
  if (audioEngineStartTime === null) {
    audioEngineStartTime = nowMs();
    audioEngineFramesSent = 0;
    console.log('⏱️ Audio Engine started (OBS-like clock master)');
  }

  // OBS-like: Calculate expected FRAMES based on real-time
  // Sample rate = FRAMES per second (not samples mono)
  const elapsedMs = nowMs() - audioEngineStartTime;
  const expectedFrames = Math.floor((elapsedMs / 1000) * AUDIO_ENGINE_SAMPLE_RATE);
  const framesToSend = expectedFrames - audioEngineFramesSent;

  if (framesToSend <= 0) {
    return;  // Not time to send yet (OBS never sends ahead of time)
  }
  
  // Limit to reasonable chunks (max 100ms at a time to allow catch-up)
  // This allows the Audio Engine to catch up if it falls behind
  const maxFramesPerTick = Math.floor((AUDIO_ENGINE_SAMPLE_RATE / 1000) * 100);  // 100ms = 4800 frames @ 48kHz
  const outputFrames = Math.min(framesToSend, maxFramesPerTick);

  if (outputFrames === 0) {
    return;
  }

  const bytesPerFrame = format.channels * (format.bitsPerSample / 8);  // 8 bytes for stereo float32
  const desktopPcm = desktopChunks.length > 0 ? Buffer.concat(desktopChunks) : null;
  const micPcm = micChunks.length > 0 ? Buffer.concat(micChunks) : null;

  // OBS-like: Always send outputFrames frames (required by timing), use silence if needed
  // This ensures we always produce the correct amount of audio data
  
  // Calculate frames available from each source
  const desktopFramesAvailable = desktopPcm ? desktopPcm.length / bytesPerFrame : 0;
  const micFramesAvailable = micPcm ? micPcm.length / bytesPerFrame : 0;
  
  // Debug: Log if we're sending silence
  if (outputFrames > 0 && desktopFramesAvailable === 0 && micFramesAvailable === 0) {
    // This is normal - we're sending silence because buffers are empty
    // This ensures continuous audio stream even when no data is available
  }
  
  // OBS-like: Mix audio sources for the "both" file (non-blocking)
  // Always mix outputFrames frames, using silence if a source is missing
  const mixedBuffer = mixAudioSources(desktopPcm, micPcm, outputFrames, bytesPerFrame, format);
  
  // Write to WAV file (for debugging)
  bothWavDataSize = writeWavData(bothWavFileHandle, bothWavDataSize, mixedBuffer);
  bothAudioBytesWritten += mixedBuffer.length;
  
  // Note: Encoding AAC is done via FFmpeg (see debug_record_ffmpeg.js)

  // OBS-like: Process each source independently (no mixing, separate files)
  // Desktop processing - always send outputFrames frames
  const desktopFramesToUse = Math.min(outputFrames, desktopFramesAvailable);
  
  // Desktop processing with encoding
  let desktopFinalBuffer = null;
  
  if (desktopFramesToUse > 0 && desktopPcm) {
    // We have desktop data - use it
    const desktopBuffer = desktopPcm.subarray(0, desktopFramesToUse * bytesPerFrame);
    desktopWavDataSize = writeWavData(desktopWavFileHandle, desktopWavDataSize, desktopBuffer);
    desktopAudioBytesWritten += desktopBuffer.length;
    
    // Keep remaining desktop data
    if (desktopPcm.length > desktopFramesToUse * bytesPerFrame) {
      const remaining = desktopPcm.subarray(desktopFramesToUse * bytesPerFrame);
      desktopChunks = [remaining];
    } else {
      desktopChunks = [];
    }
    
    desktopFinalBuffer = desktopBuffer;
  }
  
  // Fill remaining frames with silence if needed
  if (desktopFramesToUse < outputFrames) {
    const silenceFrames = outputFrames - desktopFramesToUse;
    const silence = Buffer.alloc(silenceFrames * bytesPerFrame, 0);
    desktopWavDataSize = writeWavData(desktopWavFileHandle, desktopWavDataSize, silence);
    desktopAudioBytesWritten += silence.length;
    
    // Combine with existing buffer or use silence
    if (desktopFinalBuffer) {
      desktopFinalBuffer = Buffer.concat([desktopFinalBuffer, silence]);
    } else {
      desktopFinalBuffer = silence;
    }
  }
  
  // Note: Encoding AAC is done via FFmpeg (see debug_record_ffmpeg.js)
  
  // Mic processing - always send outputFrames frames
  const micFramesToUse = Math.min(outputFrames, micFramesAvailable);
  let micFinalBuffer = null;
  
  if (micFramesToUse > 0 && micPcm) {
    // We have mic data - use it
    const micBuffer = micPcm.subarray(0, micFramesToUse * bytesPerFrame);
    micWavDataSize = writeWavData(micWavFileHandle, micWavDataSize, micBuffer);
    micAudioBytesWritten += micBuffer.length;
    
    // Keep remaining mic data
    if (micPcm.length > micFramesToUse * bytesPerFrame) {
      const remaining = micPcm.subarray(micFramesToUse * bytesPerFrame);
      micChunks = [remaining];
    } else {
      micChunks = [];
    }
    
    micFinalBuffer = micBuffer;
  }
  
  // Fill remaining frames with silence if needed
  if (micFramesToUse < outputFrames) {
    const silenceFrames = outputFrames - micFramesToUse;
    const silence = Buffer.alloc(silenceFrames * bytesPerFrame, 0);
    micWavDataSize = writeWavData(micWavFileHandle, micWavDataSize, silence);
    micAudioBytesWritten += silence.length;
    
    // Combine with existing buffer or use silence
    if (micFinalBuffer) {
      micFinalBuffer = Buffer.concat([micFinalBuffer, silence]);
    } else {
      micFinalBuffer = silence;
    }
  }
  
  // Note: Encoding AAC is done via FFmpeg (see debug_record_ffmpeg.js)
  
  // Update audio engine frames sent (OBS-like)
  // Always send outputFrames frames (required by timing)
  // NO multiplication by channels here - we count in FRAMES
  audioEngineFramesSent += outputFrames;
  
  // Log progress periodically
  const now = nowMs();
  if (now - lastLogTime > 1000) {  // Every second
    const expectedFrames = Math.floor((now - audioEngineStartTime) / 1000 * AUDIO_ENGINE_SAMPLE_RATE);
    const drift = audioEngineFramesSent - expectedFrames;
    console.log(`⏱️ Audio Engine: sent=${audioEngineFramesSent} frames, expected=${expectedFrames} frames, drift=${drift} frames`);
    console.log(`   Output: ${outputFrames} frames, Desktop available: ${desktopFramesAvailable}, Mic available: ${micFramesAvailable}`);
    
    // Note: Encoding AAC is done via FFmpeg (see debug_record_ffmpeg.js)
    lastLogTime = now;
  }
}

// ============================================================================
// ÉTAPE 1: WASAPI CAPTURE (NO MIX, NO TIMING)
// ============================================================================
// OBS reçoit: buffers, timestamps approximatifs, formats variables
// OBS ne fait AUCUN pacing ici, ne mélange RIEN ici
// Il empile juste des samples.
// ============================================================================

// Initialize audio capture
console.log('🎤 Initializing WASAPI audio capture (OBS-like: no mix, no timing)...');
const audioCapture = new WASAPICapture((buffer, source, format) => {
  if (!isRecording) {
    return;
  }

  if (!buffer || buffer.length === 0) {
    return;
  }

  // Store format info (unified format: 48kHz, stereo, float32 - already resampled in C++)
  if (source === 'desktop') {
    if (!desktopFormat) {
      desktopFormat = format;
      console.log(`🎵 Desktop format (unified from C++): ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
      console.log(`   ✅ C++ already did: ConvertToFloat32 + ResampleToTarget(48kHz) + AdaptChannels(stereo)`);
    }
    desktopChunks.push(buffer);  // Just stack samples (OBS-like: no mix, no timing)
    desktopCallbackCount++;
  } else if (source === 'mic') {
    if (!micFormat) {
      micFormat = format;
      console.log(`🎵 Mic format (unified from C++): ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
      console.log(`   ✅ C++ already did: ConvertToFloat32 + ResampleToTarget(48kHz) + AdaptChannels(stereo)`);
    }
    micChunks.push(buffer);  // Just stack samples (OBS-like: no mix, no timing)
    micCallbackCount++;
  }

  // OBS-like: Don't mix here, don't do timing here
  // Just stack samples - Audio Engine will handle timing and mixing
}, 'both');

// Get format (unified format: 48kHz, stereo, float32)
const format = audioCapture.getFormat();
if (format) {
  console.log(`🎵 Unified audio format (from C++ resampling): ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
  console.log(`   ✅ C++ already did resampling like OBS (libswresample equivalent)`);
}

// Start capture
console.log('⏺ Starting audio capture...');
const started = audioCapture.start();
if (!started) {
  console.error('❌ Failed to start audio capture');
  process.exit(1);
}

console.log('✅ Audio capture started');
console.log('⏺ Recording for ~10 seconds...');
console.log('(Press Ctrl+C to stop early)\n');

// ============================================================================
// AUDIO ENGINE TICK (OBS-like: every 10ms)
// ============================================================================
// OBS calcule à chaque tick:
//   expected_samples = (now - start_time) * sample_rate
//   to_send = expected_samples - sent_samples
//   si to_send > 0 → produire de l'audio
//   si source absente → silence
//   jamais de "rattrapage brutal"
// ============================================================================

// Use a timer to tick audio engine regularly (every 10ms - OBS-like)
// This ensures audio is sent at a constant rate based on real-time, like OBS
const audioEngineInterval = setInterval(() => {
  if (isRecording) {
    audioEngineTick();
  }
}, 10); // 10ms - Audio Engine will control actual send rate

// Record for ~10 seconds
setTimeout(() => {
  console.log('\n🛑 Stopping capture...');
  isRecording = false;
  
  // Stop the audio engine interval
  clearInterval(audioEngineInterval);
  
  // Final audio engine tick to send any remaining audio
  audioEngineTick();
  
  // Wait a bit for buffers to flush
  setTimeout(() => {
    const elapsedTime = nowMs() - audioEngineStartTime;
    const elapsedSeconds = elapsedTime / 1000;
    const expectedFrames = Math.floor(elapsedSeconds * AUDIO_ENGINE_SAMPLE_RATE);
    const expectedBytes = expectedFrames * (format.channels * (format.bitsPerSample / 8));
    
    console.log(`\n📊 Statistics:`);
    console.log(`   Recording duration: ${elapsedSeconds.toFixed(2)} seconds`);
    console.log(`   Desktop callbacks: ${desktopCallbackCount}`);
    console.log(`   Mic callbacks: ${micCallbackCount}`);
    console.log(`   Desktop audio bytes written: ${(desktopAudioBytesWritten / 1024 / 1024).toFixed(2)} MB (expected: ${(expectedBytes / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`   Mic audio bytes written: ${(micAudioBytesWritten / 1024 / 1024).toFixed(2)} MB (expected: ${(expectedBytes / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`   Mixed (both) audio bytes written: ${(bothAudioBytesWritten / 1024 / 1024).toFixed(2)} MB (expected: ${(expectedBytes / 1024 / 1024).toFixed(2)} MB)`);
    console.log(`   Audio Engine frames sent: ${audioEngineFramesSent} (expected: ${expectedFrames})`);
    console.log(`   Audio Engine drift: ${audioEngineFramesSent - expectedFrames} frames (${((audioEngineFramesSent - expectedFrames) / AUDIO_ENGINE_SAMPLE_RATE).toFixed(3)} seconds)`);
    
    // Note: Encoding AAC is done via FFmpeg (see debug_record_ffmpeg.js)
    
    // Stop audio capture
    audioCapture.stop();
    
    // Finalize WAV files
    finalizeWavFile(desktopOutputPath, desktopWavFileHandle, desktopWavDataSize, 'Desktop');
    finalizeWavFile(micOutputPath, micWavFileHandle, micWavDataSize, 'Mic');
    finalizeWavFile(bothOutputPath, bothWavFileHandle, bothWavDataSize, 'Mixed (both)');
    
    console.log(`\n✅ Test complete! Check the following files to verify audio quality:`);
    console.log(`   📁 Desktop WAV: ${desktopOutputPath}`);
    console.log(`   📁 Mic WAV: ${micOutputPath}`);
    console.log(`   📁 Mixed WAV: ${bothOutputPath}`);
    console.log(`\n   Note: Encoding AAC is done via FFmpeg (see debug_record_ffmpeg_obs_like.js)`);
    process.exit(0);
  }, 200);
}, 10000);

// Handle Ctrl+C
process.on('SIGINT', () => {
  console.log('\n\n🛑 Interrupted by user');
  isRecording = false;
  clearInterval(audioEngineInterval);
  audioEngineTick();
  setTimeout(() => {
    audioCapture.stop();
    finalizeWavFile(desktopOutputPath, desktopWavFileHandle, desktopWavDataSize, 'Desktop');
    finalizeWavFile(micOutputPath, micWavFileHandle, micWavDataSize, 'Mic');
    finalizeWavFile(bothOutputPath, bothWavFileHandle, bothWavDataSize, 'Mixed (both)');
    
    // Note: Encoding AAC is done via FFmpeg (see debug_record_ffmpeg_obs_like.js)
    
    process.exit(0);
  }, 200);
});


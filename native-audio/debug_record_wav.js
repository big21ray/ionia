// Simple audio-only debug recorder for WASAPI desktop loopback.
// Records ~10 seconds of raw desktop audio to a WAV file so you can
// listen to exactly what WASAPI provides, without Electron/FFmpeg.

/* eslint-disable no-console */

const fs = require('fs');
const path = require('path');

const { WASAPICapture } = require('./index.js');

function createWavBuffer(pcmBuffer, sampleRate, channels, bitsPerSample) {
  const byteRate = sampleRate * channels * (bitsPerSample / 8);
  const blockAlign = channels * (bitsPerSample / 8);
  const dataSize = pcmBuffer.length;
  const headerSize = 44;
  const buffer = Buffer.alloc(headerSize + dataSize);

  // RIFF header
  buffer.write('RIFF', 0); // ChunkID
  buffer.writeUInt32LE(36 + dataSize, 4); // ChunkSize
  buffer.write('WAVE', 8); // Format

  // fmt subchunk
  buffer.write('fmt ', 12); // Subchunk1ID
  buffer.writeUInt32LE(16, 16); // Subchunk1Size (16 for PCM)

  // AudioFormat: 3 = IEEE float, 1 = PCM int16
  // Our WASAPI mix format for desktop is 32‑bit float, so use 3 when bitsPerSample === 32.
  const isFloat = bitsPerSample === 32;
  buffer.writeUInt16LE(isFloat ? 3 : 1, 20); // AudioFormat

  buffer.writeUInt16LE(channels, 22); // NumChannels
  buffer.writeUInt32LE(sampleRate, 24); // SampleRate
  buffer.writeUInt32LE(byteRate, 28); // ByteRate
  buffer.writeUInt16LE(blockAlign, 32); // BlockAlign
  buffer.writeUInt16LE(bitsPerSample, 34); // BitsPerSample

  // data subchunk
  buffer.write('data', 36); // Subchunk2ID
  buffer.writeUInt32LE(dataSize, 40); // Subchunk2Size

  // PCM data
  pcmBuffer.copy(buffer, headerSize);

  return buffer;
}

// Downmix multi‑canal → stéréo (float32) côté Node, sans toucher au C++
function downmixToStereoFloat32(pcmBuffer, channels) {
  if (channels === 2) {
    // Déjà stéréo, rien à faire
    return pcmBuffer;
  }

  const bytesPerSample = 4; // float32
  const totalSamples = pcmBuffer.length / bytesPerSample;
  const totalFrames = Math.floor(totalSamples / channels);

  const outChannels = 2;
  const outBuffer = Buffer.alloc(totalFrames * outChannels * bytesPerSample);

  for (let frame = 0; frame < totalFrames; frame++) {
    const inBase = frame * channels * bytesPerSample;

    let left = 0;
    let right = 0;

    if (channels >= 2) {
      // Garde uniquement L/R (canaux 0 et 1)
      left = pcmBuffer.readFloatLE(inBase + 0 * bytesPerSample);
      right = pcmBuffer.readFloatLE(inBase + 1 * bytesPerSample);
    } else if (channels === 1) {
      // Mono → duplique en L/R
      const mono = pcmBuffer.readFloatLE(inBase);
      left = mono;
      right = mono;
    } else {
      // Cas bizarre : pas de canaux
      continue;
    }

    const outBase = frame * outChannels * bytesPerSample;
    outBuffer.writeFloatLE(left, outBase);
    outBuffer.writeFloatLE(right, outBase + bytesPerSample);
  }

  return outBuffer;
}

async function main() {
  console.log('🔊 Starting WASAPI audio recording with resampling (48000 Hz, stereo)...');

  let audioCapture = null;
  const desktopChunks = [];
  const micChunks = [];
  let desktopFormat = null;
  let micFormat = null;
  let desktopCallbackCount = 0;
  let micCallbackCount = 0;

  try {
    audioCapture = new WASAPICapture((buffer, source, format) => {
      // source is "desktop" or "mic"
      // format is now the unified format (always 48000 Hz, stereo, float32) after resampling
      if (source === 'desktop') {
        desktopCallbackCount++;
        desktopChunks.push(Buffer.from(buffer));
        if (!desktopFormat) {
          desktopFormat = format;
          console.log(`🎵 Desktop format (unified): ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
        }
        if (desktopCallbackCount <= 5 || desktopCallbackCount % 100 === 0) {
          const bytesPerFrame = format.channels * (format.bitsPerSample / 8);
          const framesInBuffer = buffer.length / bytesPerFrame;
          console.log(`📊 Desktop callback #${desktopCallbackCount}: ${framesInBuffer} frames, ${buffer.length} bytes`);
        }
      } else if (source === 'mic') {
        micCallbackCount++;
        micChunks.push(Buffer.from(buffer));
        if (!micFormat) {
          micFormat = format;
          console.log(`🎵 Mic format (unified): ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
        }
        if (micCallbackCount <= 5 || micCallbackCount % 100 === 0) {
          const bytesPerFrame = format.channels * (format.bitsPerSample / 8);
          const framesInBuffer = buffer.length / bytesPerFrame;
          console.log(`📊 Mic callback #${micCallbackCount}: ${framesInBuffer} frames, ${buffer.length} bytes`);
        }
      }
    }, 'both'); // both desktop and microphone

    const started = audioCapture.start();
    if (!started) {
      console.error('❌ Failed to start WASAPI capture');
      process.exit(1);
    }

    console.log('⏺ Recording for ~10 seconds...');
    await new Promise((resolve) => setTimeout(resolve, 10000));

    console.log('🛑 Stopping capture...');
    try {
      audioCapture.stop();
    } catch (e) {
      console.warn('⚠️ Error while stopping capture (ignored):', e.message || e);
    }
  } catch (err) {
    console.error('❌ Error during capture:', err);
    if (audioCapture) {
      try {
        audioCapture.stop();
      } catch (_) {
        // ignore
      }
    }
  }

  console.log(`📊 Desktop callbacks: ${desktopCallbackCount}, chunks: ${desktopChunks.length}`);
  console.log(`📊 Mic callbacks: ${micCallbackCount}, chunks: ${micChunks.length}`);

  // Mix both streams if both are available
  let mixedPcm = null;
  let mixedFrames = 0;
  if (desktopChunks.length > 0 && micChunks.length > 0 && desktopFormat && micFormat) {
    console.log('\n=== Mixing Desktop + Mic ===');
    const desktopPcm = Buffer.concat(desktopChunks);
    const micPcm = Buffer.concat(micChunks);
    
    const desktopBytesPerFrame = desktopFormat.channels * (desktopFormat.bitsPerSample / 8);
    const micBytesPerFrame = micFormat.channels * (micFormat.bitsPerSample / 8);
    
    const desktopFrames = desktopPcm.length / desktopBytesPerFrame;
    const micFrames = micPcm.length / micBytesPerFrame;
    
    // Both should be at 48000 Hz, stereo, float32 now
    const outputFrames = Math.max(desktopFrames, micFrames);
    mixedFrames = outputFrames;
    
    console.log(`   Desktop: ${desktopFrames.toFixed(2)} frames`);
    console.log(`   Mic: ${micFrames.toFixed(2)} frames`);
    console.log(`   Output: ${outputFrames.toFixed(2)} frames`);
    
    // Mix the two streams
    mixedPcm = Buffer.alloc(outputFrames * desktopBytesPerFrame);
    const micGain = 0.9; // Slight gain reduction for mic to avoid clipping
    
    for (let frame = 0; frame < outputFrames; frame++) {
      for (let ch = 0; ch < desktopFormat.channels; ch++) {
        let desktopSample = 0;
        let micSample = 0;
        
        // Get desktop sample
        if (frame < desktopFrames) {
          const offset = frame * desktopBytesPerFrame + ch * (desktopFormat.bitsPerSample / 8);
          desktopSample = desktopPcm.readFloatLE(offset);
        }
        
        // Get mic sample
        if (frame < micFrames) {
          const offset = frame * micBytesPerFrame + ch * (micFormat.bitsPerSample / 8);
          micSample = micPcm.readFloatLE(offset) * micGain;
        }
        
        // Mix and clamp
        let mixed = desktopSample + micSample;
        if (mixed > 1.0) mixed = 1.0;
        if (mixed < -1.0) mixed = -1.0;
        
        // Write mixed sample
        const outputOffset = frame * desktopBytesPerFrame + ch * (desktopFormat.bitsPerSample / 8);
        mixedPcm.writeFloatLE(mixed, outputOffset);
      }
    }
    
    console.log(`✅ Mixed: ${mixedPcm.length} bytes`);
  }

  // Write mixed WAV file (if both sources available)
  if (mixedPcm && desktopFormat) {
    console.log('\n=== Writing Mixed Output ===');
    const mixedWav = createWavBuffer(
      mixedPcm,
      desktopFormat.sampleRate,
      desktopFormat.channels,
      desktopFormat.bitsPerSample
    );
    const mixedPath = path.join(__dirname, 'debug_both_processed.wav');
    fs.writeFileSync(mixedPath, mixedWav);
    console.log(`✅ Mixed WAV written: ${mixedPath}`);
    console.log(`   Format: ${desktopFormat.sampleRate} Hz, ${desktopFormat.channels}ch, ${desktopFormat.bitsPerSample}-bit`);
    console.log(`   Frames: ${mixedFrames.toFixed(2)}, Duration: ${(mixedFrames / desktopFormat.sampleRate).toFixed(2)}s`);
  }

  // Write desktop WAV file
  if (desktopChunks.length > 0 && desktopFormat) {
    const desktopPcm = Buffer.concat(desktopChunks);
    const bytesPerFrame = desktopFormat.channels * (desktopFormat.bitsPerSample / 8);
    const totalFrames = desktopPcm.length / bytesPerFrame;
    const durationSeconds = totalFrames / desktopFormat.sampleRate;
    
    console.log(`📦 Desktop (processed): ${desktopPcm.length} bytes, ${totalFrames.toFixed(2)} frames, ${durationSeconds.toFixed(2)}s`);
    console.log(`   Format: ${desktopFormat.sampleRate} Hz, ${desktopFormat.channels}ch, ${desktopFormat.bitsPerSample}-bit`);
    
    const desktopWav = createWavBuffer(
      desktopPcm,
      desktopFormat.sampleRate,
      desktopFormat.channels,
      desktopFormat.bitsPerSample
    );
    const desktopPath = path.join(__dirname, 'debug_desktop_processed.wav');
    fs.writeFileSync(desktopPath, desktopWav);
    console.log(`✅ Desktop WAV written: ${desktopPath}`);
  } else {
    console.warn('⚠️ No desktop audio captured');
  }

  // Write mic WAV file
  if (micChunks.length > 0 && micFormat) {
    const micPcm = Buffer.concat(micChunks);
    const bytesPerFrame = micFormat.channels * (micFormat.bitsPerSample / 8);
    const totalFrames = micPcm.length / bytesPerFrame;
    const durationSeconds = totalFrames / micFormat.sampleRate;
    
    console.log(`📦 Mic (processed): ${micPcm.length} bytes, ${totalFrames.toFixed(2)} frames, ${durationSeconds.toFixed(2)}s`);
    console.log(`   Format: ${micFormat.sampleRate} Hz, ${micFormat.channels}ch, ${micFormat.bitsPerSample}-bit`);
    
    const micWav = createWavBuffer(
      micPcm,
      micFormat.sampleRate,
      micFormat.channels,
      micFormat.bitsPerSample
    );
    const micPath = path.join(__dirname, 'debug_mic_processed.wav');
    fs.writeFileSync(micPath, micWav);
    console.log(`✅ Mic WAV written: ${micPath}`);
  } else {
    console.warn('⚠️ No mic audio captured');
  }
  
  // Explicitly exit to ensure clean termination
  process.exit(0);
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err);
  process.exit(1);
});


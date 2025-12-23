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
  console.log('🔊 Starting WASAPI desktop debug recording (audio only)...');

  let audioCapture = null;
  const chunks = [];
  let format = null;

  try {
    // audioCapture = new WASAPICapture((buffer) => {
    //   chunks.push(Buffer.from(buffer));
    // }, 'desktop'); // desktop/headset only
    
    audioCapture = new WASAPICapture((buffer) => {
      chunks.push(Buffer.from(buffer));
    }, 'mic'); // microphone only

    format = audioCapture.getFormat();
    console.log('🎵 WASAPI format (from C++):', format);

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

  if (!format) {
    console.error('❌ No audio format available');
    process.exit(1);
  }

  const pcmData = Buffer.concat(chunks);
  console.log(`📦 Captured ${pcmData.length} bytes of PCM audio`);

  // Downmix multi‑canal → stéréo float32 si besoin
  let outPcm = pcmData;
  let outChannels = format.channels;
  let outBits = format.bitsPerSample;

  if (format.bitsPerSample === 32 && format.channels !== 2) {
    console.log(`🎚 Downmixing ${format.channels}ch float32 → 2ch float32 (stereo)`);
    outPcm = downmixToStereoFloat32(pcmData, format.channels);
    outChannels = 2;
    outBits = 32;
  } else if (format.channels === 1 && format.bitsPerSample === 32) {
    console.log('🎚 Duplicating mono float32 → stereo');
    outPcm = downmixToStereoFloat32(pcmData, 1);
    outChannels = 2;
    outBits = 32;
  } else {
    console.log('🎚 No downmix applied (already stereo or non-float format)');
  }

  const baseName = path.join(__dirname, 'debug_desktop_stereo');

  // WAV avec sampleRate = format.sampleRate
  const wavHeaderRate = createWavBuffer(
    outPcm,
    format.sampleRate,
    outChannels,
    outBits
  );
  fs.writeFileSync(baseName + `_header_${format.sampleRate}.wav`, wavHeaderRate);

  console.log('✅ Debug WAV written to:');
  console.log('🎵 WASAPI format (from C++):', format);
  console.log(`  - ${baseName}_header_${format.sampleRate}.wav`);
}

main().catch((err) => {
  console.error('❌ Unexpected error:', err);
  process.exit(1);
});


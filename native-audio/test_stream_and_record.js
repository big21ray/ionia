#!/usr/bin/env node

// Streams to YouTube RTMP while recording locally to MP4.
// Output file: native-audio/test_stream_video.mp4
//
// Usage:
//   node test_stream_and_record.js <youtubeStreamKey>
//   node test_stream_and_record.js <rtmpUrl>
//   set RTMP_URL=<rtmpUrl> && node test_stream_and_record.js
//
// Optional:
//   set DURATION_SECONDS=60

const path = require('path');
const fs = require('fs');
const nativeModule = require('./index.js');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function redactRtmpUrl(url) {
  if (!url) return '';
  return url.replace(/(rtmp:\/\/[^/]+\/[^/]+\/)([^/?#]+)/i, (_, prefix, key) => {
    const tail = key.length >= 4 ? key.slice(-4) : key;
    return `${prefix}****-${tail}`;
  });
}

function resolveRtmpUrl() {
  const arg = process.argv[2];
  const envUrl = process.env.IONIA_RTMP_URL || process.env.RTMP_URL;
  const envKey = process.env.YOUTUBE_STREAM_KEY;

  if (arg) return arg.startsWith('rtmp://') ? arg : `rtmp://a.rtmp.youtube.com/live2/${arg}`;
  if (envUrl) return envUrl;
  if (envKey) return `rtmp://a.rtmp.youtube.com/live2/${envKey}`;
  return null;
}

async function main() {
  console.log('[TEST] Stream + record end-to-end test');
  console.log('='.repeat(60));

  if (!nativeModule.VideoAudioStreamer) {
    console.error('[TEST] ❌ VideoAudioStreamer is not available in the native module');
    process.exit(1);
  }
  if (!nativeModule.VideoAudioRecorder) {
    console.error('[TEST] ❌ VideoAudioRecorder is not available in the native module');
    process.exit(1);
  }

  // Prefer a stable COM mode before creating any capture objects.
  if (nativeModule.initializeCOMInSTAMode) {
    if (!nativeModule.initializeCOMInSTAMode()) {
      console.error('[TEST] ❌ Failed to initialize COM in STA mode');
      process.exit(1);
    }
  }

  const rtmpUrl = resolveRtmpUrl();
  if (!rtmpUrl) {
    console.error('[TEST] ❌ Missing RTMP target. Provide one of:');
    console.error('  - node test_stream_and_record.js <youtubeStreamKey>');
    console.error('  - node test_stream_and_record.js <rtmpUrl>');
    console.error('  - set RTMP_URL=<rtmpUrl>');
    console.error('  - set YOUTUBE_STREAM_KEY=<youtubeStreamKey>');
    process.exit(1);
  }

  const durationSeconds = Number(process.env.DURATION_SECONDS || '60');
  const outPath = path.join(__dirname, 'test_stream_video.mp4');

  // Best-effort cleanup.
  try {
    if (fs.existsSync(outPath)) fs.unlinkSync(outPath);
  } catch {
    // ignore
  }

  console.log(`[TEST] RTMP: ${redactRtmpUrl(rtmpUrl)}`);
  console.log(`[TEST] Local output: ${outPath}`);
  console.log(`[TEST] Duration: ${durationSeconds}s`);

  const fps = 20;
  const videoBitrate = 3_000_000;
  const audioBitrate = 192_000;
  const useNvenc = true;
  const audioMode = 'both';

  const recorder = new nativeModule.VideoAudioRecorder();
  const streamer = new nativeModule.VideoAudioStreamer();

  console.log('\n[TEST] Initializing recorder...');
  if (!recorder.initialize(outPath, fps, videoBitrate, useNvenc, audioBitrate, audioMode)) {
    console.error('[TEST] ❌ Recorder initialize failed');
    process.exit(1);
  }
  console.log(`[TEST] ✓ Recorder codec: ${recorder.getCodecName ? recorder.getCodecName() : '(unknown)'}`);

  console.log('\n[TEST] Initializing streamer...');
  if (!streamer.initialize(rtmpUrl, fps, videoBitrate, useNvenc, audioBitrate, audioMode)) {
    console.error('[TEST] ❌ Streamer initialize failed');
    process.exit(1);
  }
  console.log(`[TEST] ✓ Streamer codec: ${streamer.getCodecName ? streamer.getCodecName() : '(unknown)'}`);

  console.log('\n[TEST] Starting recorder...');
  if (!recorder.start()) {
    console.error('[TEST] ❌ Recorder start failed');
    process.exit(1);
  }
  console.log('[TEST] ✓ Recorder started');

  console.log('[TEST] Starting streamer...');
  if (!streamer.start()) {
    console.error('[TEST] ❌ Streamer start failed');
    recorder.stop();
    process.exit(1);
  }
  console.log('[TEST] ✓ Streamer started');

  console.log(`\n[TEST] Running for ${durationSeconds}s...`);
  const start = Date.now();

  for (;;) {
    const elapsed = Math.floor((Date.now() - start) / 1000);
    if (elapsed >= durationSeconds) break;

    const sStats = streamer.getStatistics ? streamer.getStatistics() : null;
    const rStats = recorder.getStatistics ? recorder.getStatistics() : null;

    if (sStats && rStats) {
      console.log(
        `[${elapsed}s] stream: V=${sStats.videoFrames} P=${sStats.videoPackets} A=${sStats.audioPackets} | ` +
          `record: V=${rStats.videoFramesCaptured || rStats.videoFrames || 0} P=${rStats.videoPacketsEncoded || rStats.videoPackets || 0} A=${rStats.audioPacketsEncoded || rStats.audioPackets || 0}`
      );
    } else {
      console.log(`[${elapsed}s] running...`);
    }

    await sleep(1000);
  }

  console.log('\n[TEST] Stopping streamer...');
  try {
    streamer.stop();
  } catch (e) {
    console.warn('[TEST] ⚠ Streamer stop threw:', e && e.message ? e.message : e);
  }

  console.log('[TEST] Stopping recorder...');
  try {
    recorder.stop();
  } catch (e) {
    console.warn('[TEST] ⚠ Recorder stop threw:', e && e.message ? e.message : e);
  }

  // Give FFmpeg a moment to finalize MP4.
  await sleep(500);

  if (!fs.existsSync(outPath)) {
    console.error('[TEST] ❌ Output file was not created:', outPath);
    process.exit(1);
  }

  const st = fs.statSync(outPath);
  console.log(`[TEST] ✓ Output file size: ${(st.size / 1024 / 1024).toFixed(2)} MB`);

  if (st.size < 256 * 1024) {
    console.warn('[TEST] ⚠ Output file is very small; verify it contains media');
  }

  console.log('[TEST] ✅ Done');
}

main().catch((err) => {
  console.error('[TEST] ❌ Fatal error:', err && err.stack ? err.stack : err);
  process.exit(1);
});

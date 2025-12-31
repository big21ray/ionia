#!/usr/bin/env node

/**
 * Test streaming with VideoEngine-based pacing
 * This test creates a VideoAudioStreamer with VideoEngine CFR pacing
 */

const binding = require('./build/Release/wasapi_capture');
const fs = require('fs');
const path = require('path');

const streamer = new binding.VideoAudioStreamer();

console.log('[Test] Creating streaming session...');

// Test parameters
const RTMP_URL = 'rtmp://localhost:1935/live/stream';  // Local RTMP server
const FPS = 30;
const VIDEO_BITRATE = 5_000_000;  // 5 Mbps
const AUDIO_BITRATE = 192_000;    // 192 kbps
const USE_NVENC = false;  // Use software encoder for testing
const AUDIO_MODE = 'both';  // desktop + mic

console.log('Initializing streamer...');
console.log(`  RTMP URL: ${RTMP_URL}`);
console.log(`  FPS: ${FPS}`);
console.log(`  Video Bitrate: ${(VIDEO_BITRATE / 1_000_000).toFixed(1)} Mbps`);
console.log(`  Audio Bitrate: ${(AUDIO_BITRATE / 1000).toFixed(0)} kbps`);
console.log(`  Audio Mode: ${AUDIO_MODE}`);
console.log(`  Encoder: ${USE_NVENC ? 'NVIDIA NVENC' : 'Software (libx264)'}`);

const success = streamer.initialize(
    RTMP_URL,
    FPS,
    VIDEO_BITRATE,
    USE_NVENC,
    AUDIO_BITRATE,
    AUDIO_MODE
);

if (!success) {
    console.error('[ERROR] Failed to initialize streamer');
    process.exit(1);
}

console.log('[OK] Streamer initialized');

// Check codec
const codec = streamer.getCodecName();
console.log(`[OK] Codec: ${codec}`);

// Start streaming
console.log('[Test] Starting streaming session...');
if (!streamer.start()) {
    console.error('[ERROR] Failed to start streaming');
    process.exit(1);
}

console.log('[OK] Streaming started');

// Run for 5 seconds and collect statistics
const runDuration = 5000;  // 5 seconds
console.log(`\n[Test] Running for ${(runDuration / 1000).toFixed(1)} seconds...`);
console.log('');

const startTime = Date.now();
let lastStatsTime = startTime;
let lastFrames = 0;
let lastVideoPackets = 0;
let lastAudioPackets = 0;

const statsInterval = setInterval(() => {
    const now = Date.now();
    const elapsed = (now - startTime) / 1000;
    
    const stats = streamer.getStatistics();
    const deltaTime = (now - lastStatsTime) / 1000;
    const deltaFrames = stats.videoFrames - lastFrames;
    const deltaVideoPackets = stats.videoPackets - lastVideoPackets;
    const deltaAudioPackets = stats.audioPackets - lastAudioPackets;
    
    const fps = deltaFrames / deltaTime;
    const videoPps = deltaVideoPackets / deltaTime;
    const audioPps = deltaAudioPackets / deltaTime;
    
    console.log(`[${elapsed.toFixed(2)}s] Frames: ${stats.videoFrames} ` +
                `| Video Packets: ${stats.videoPackets} (${videoPps.toFixed(1)} pps) ` +
                `| Audio Packets: ${stats.audioPackets} (${audioPps.toFixed(1)} pps) ` +
                `| FPS: ${fps.toFixed(1)}`);
    
    lastStatsTime = now;
    lastFrames = stats.videoFrames;
    lastVideoPackets = stats.videoPackets;
    lastAudioPackets = stats.audioPackets;
}, 1000);

// Stop after duration
setTimeout(() => {
    clearInterval(statsInterval);
    
    console.log('\n[Test] Stopping streaming session...');
    if (!streamer.stop()) {
        console.error('[ERROR] Failed to stop streamer');
        process.exit(1);
    }
    
    console.log('[OK] Streaming stopped');
    
    // Final statistics
    const stats = streamer.getStatistics();
    console.log('\n[Results] Final Statistics:');
    console.log(`  Frames Captured: ${stats.videoFrames}`);
    console.log(`  Video Packets Encoded: ${stats.videoPackets}`);
    console.log(`  Audio Packets Encoded: ${stats.audioPackets}`);
    console.log(`  Expected Video Packets @ 30fps: ~${(5 * 30).toFixed(0)}`);
    console.log(`  Expected Audio Packets @ 100Hz: ~${(5 * 100).toFixed(0)}`);
    
    // Verify CFR (Constant Frame Rate)
    const expectedVideoPackets = FPS * 5;  // 5 seconds at 30fps
    const actualVideoPackets = stats.videoPackets;
    const variance = Math.abs(actualVideoPackets - expectedVideoPackets);
    
    if (variance <= 2) {
        console.log(`\n[SUCCESS] CFR Pacing: ${actualVideoPackets} packets (expected ~${expectedVideoPackets}) ✅`);
    } else {
        console.log(`\n[WARNING] CFR Variance: ${actualVideoPackets} packets (expected ~${expectedVideoPackets}, variance: ${variance})`);
    }
    
    if (stats.audioPackets > 0) {
        console.log(`[SUCCESS] Audio Pacing: ${stats.audioPackets} packets ✅`);
    } else {
        console.log(`[WARNING] No audio packets received`);
    }
    
    process.exit(0);
}, runDuration);

// Handle graceful exit on Ctrl+C
process.on('SIGINT', () => {
    console.log('\n[Test] Interrupted, stopping...');
    clearInterval(statsInterval);
    streamer.stop();
    process.exit(0);
});

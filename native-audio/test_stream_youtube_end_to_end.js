#!/usr/bin/env node

const addon = require('./build/Release/wasapi_video_audio');

console.log('[TEST] YouTube RTMP end-to-end stream test');
console.log('='.repeat(60));

function redactRtmpUrl(url) {
    if (!url) return '';
    // Best-effort redaction: keep scheme/host/path prefix, hide last path segment.
    return url.replace(/(rtmp:\/\/[^/]+\/[^/]+\/)([^/?#]+)/i, (_, prefix, key) => {
        const tail = key.length >= 4 ? key.slice(-4) : key;
        return `${prefix}****-${tail}`;
    });
}

// Resolve RTMP target:
// 1) argv[2] (either full rtmp://... or a YouTube stream key)
// 2) env RTMP_URL / IONIA_RTMP_URL
// 3) env YOUTUBE_STREAM_KEY
const arg = process.argv[2];
const envUrl = process.env.IONIA_RTMP_URL || process.env.RTMP_URL;
const envKey = process.env.YOUTUBE_STREAM_KEY;

let rtmpUrl = null;
if (arg) {
    rtmpUrl = arg.startsWith('rtmp://') ? arg : `rtmp://a.rtmp.youtube.com/live2/${arg}`;
} else if (envUrl) {
    rtmpUrl = envUrl;
} else if (envKey) {
    rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${envKey}`;
}

if (!rtmpUrl) {
    console.error('[TEST] ❌ Missing RTMP target. Provide one of:');
    console.error('  - node test_stream_youtube_end_to_end.js <youtubeStreamKey>');
    console.error('  - node test_stream_youtube_end_to_end.js <rtmpUrl>');
    console.error('  - set RTMP_URL=<rtmpUrl>');
    console.error('  - set YOUTUBE_STREAM_KEY=<youtubeStreamKey>');
    process.exit(1);
}

console.log(`[TEST] Using RTMP URL: ${redactRtmpUrl(rtmpUrl)}\n`);

const streamer = new addon.VideoAudioStreamer();

try {
    console.log('[TEST] Initializing streamer...');
    const initialized = streamer.initialize(rtmpUrl, 20, 3000000, true, 192000, 'both');
    if (!initialized) {
        console.error('[TEST] ❌ Initialize failed');
        process.exit(1);
    }
    console.log('[TEST] ✓ Initialize succeeded\n');

    console.log('[TEST] Starting streamer...');
    const started = streamer.start();
    if (!started) {
        console.error('[TEST] ❌ Start failed');
        process.exit(1);
    }
    console.log('[TEST] ✓ Start succeeded\n');

    console.log('[TEST] Monitoring for 60 seconds...');
    console.log('[TEST] Expected behavior:');
    console.log('[TEST]   - VideoTickThread should keep advancing frame numbers');
    console.log('[TEST]   - expectedFrame >= currentFrame (timeline progresses)');
    console.log('[TEST]   - Even if no frames are captured, AdvanceFrameNumber() still called\n');

    let lastStats = null;
    let secondsElapsed = 0;
    
    const monitorInterval = setInterval(() => {
        secondsElapsed++;
        const stats = streamer.getStatistics();
        
        console.log(`[TEST:${secondsElapsed}s] Video frames: ${stats.videoFrames}, packets: ${stats.videoPackets}, audio packets: ${stats.audioPackets}`);
        
        if (lastStats) {
            const videoFramesDelta = stats.videoFrames - lastStats.videoFrames;
            const videoPacketsDelta = stats.videoPackets - lastStats.videoPackets;
            const audioPacketsDelta = stats.audioPackets - lastStats.audioPackets;
            
            if (videoPacketsDelta > 0) {
                console.log(`[TEST:${secondsElapsed}s]   ✓ Video packets generated (+${videoPacketsDelta})`);
            } else {
                console.log(`[TEST:${secondsElapsed}s]   ⚠ No new video packets this second`);
            }
            
            if (audioPacketsDelta > 0) {
                console.log(`[TEST:${secondsElapsed}s]   ✓ Audio packets captured (+${audioPacketsDelta})`);
            }
        }
        
        lastStats = stats;
        
        if (secondsElapsed >= 60) {
            clearInterval(monitorInterval);
            console.log('\n[TEST] Stopping streamer...');
            streamer.stop();
            
            const finalStats = streamer.getStatistics();
            console.log('[TEST] Final stats:');
            console.log(`[TEST]   - Video frames captured: ${finalStats.videoFrames}`);
            console.log(`[TEST]   - Video packets encoded: ${finalStats.videoPackets}`);
            console.log(`[TEST]   - Audio packets: ${finalStats.audioPackets}`);
            
            if (finalStats.videoPackets > 0) {
                console.log('\n[TEST] ✅ SUCCESS: Video stream progressed!');
                console.log('[TEST] The frame duplication fix is working correctly.');
                process.exit(0);
            } else {
                console.log('\n[TEST] ❌ FAILURE: No video packets generated!');
                console.log('[TEST] The stream is still stuck.');
                process.exit(1);
            }
        }
    }, 1000);
    
} catch (err) {
    console.error('[TEST] Exception:', err.message);
    process.exit(1);
}

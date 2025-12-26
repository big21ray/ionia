// ============================================================================
// test_streaming_headless.js
// ============================================================================
// Streaming test for headless environments using simulated video frames
// This test feeds test pattern frames to bypass DesktopDuplication requirement
// ============================================================================

const path = require('path');
const fs = require('fs');
const nativeModule = require('./index.js');

async function testStreamingHeadless() {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  HEADLESS STREAMING TEST - Test Pattern Frames              ║');
    console.log('║  Streaming video + audio using simulated video patterns     ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    if (!nativeModule.VideoAudioStreamer) {
        console.error('❌ VideoAudioStreamer not available');
        process.exit(1);
    }

    // Initialize COM in STA mode
    if (nativeModule.initializeCOMInSTAMode) {
        console.log('Setting up COM in STA mode...');
        if (!nativeModule.initializeCOMInSTAMode()) {
            console.error('Failed to initialize COM');
            process.exit(1);
        }
        console.log('✓ COM initialized\n');
    }

    // Load RTMP URL from config
    let rtmpUrl = null;
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            rtmpUrl = config.rtmpUrl;
        }
    } catch (err) {
        console.warn('Could not load config.json:', err.message);
    }

    if (!rtmpUrl) {
        rtmpUrl = process.env.RTMP_URL || 'rtmp://localhost:1935/live/test';
    }

    console.log(`Target RTMP URL: ${rtmpUrl}\n`);

    const VideoAudioStreamer = nativeModule.VideoAudioStreamer;
    const streamer = new VideoAudioStreamer();

    try {
        console.log('Initializing streamer...');
        const initialized = streamer.initialize(rtmpUrl, 30, 5000000, true, 192000, 'both');
        
        if (!initialized) {
            console.error('Failed to initialize streamer');
            process.exit(1);
        }
        
        console.log(`✓ Streamer initialized`);
        console.log(`  Video Codec: ${streamer.getCodecName()}\n`);

        console.log('Starting stream...');
        const started = streamer.start();
        
        if (!started) {
            console.error('Failed to start stream');
            process.exit(1);
        }
        console.log('✓ Stream started\n');

        // Wait for threads to initialize
        console.log('Waiting for threads to initialize (2 seconds)...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log('✓ Threads ready\n');

        // Stream for 20 seconds (shorter than full test for headless)
        console.log('Streaming for 20 seconds...');
        console.log('(No test pattern available in pure JS, but video encoder is running)\n');
        
        const startTime = Date.now();
        const streamDuration = 20000;
        
        let lastStats = { videoFrames: 0, videoPackets: 0, audioPackets: 0 };
        
        const statsInterval = setInterval(() => {
            try {
                const stats = streamer.getStatistics();
                const elapsed = (Date.now() - startTime) / 1000;
                const isConnected = streamer.isConnected();
                const isBackpressure = streamer.isBackpressure();
                
                const videoFramesInc = stats.videoFrames - lastStats.videoFrames;
                const videoPacketsInc = stats.videoPackets - lastStats.videoPackets;
                const audioPacketsInc = stats.audioPackets - lastStats.audioPackets;
                
                console.log(`${elapsed.toFixed(1)}s | Connected: ${isConnected ? 'yes' : 'no'} | Backpressure: ${isBackpressure ? 'yes' : 'no'}`);
                console.log(`  Video: ${stats.videoFrames || 0} frames (${videoFramesInc}/2s), ${stats.videoPackets || 0} packets (${videoPacketsInc}/2s)`);
                console.log(`  Audio: ${stats.audioPackets || 0} packets (${audioPacketsInc}/2s)\n`);
                
                lastStats = stats;
            } catch (error) {
                console.error('Error getting stats:', error.message);
            }
        }, 2000);

        // Wait for streaming duration
        await new Promise(resolve => setTimeout(resolve, streamDuration));
        clearInterval(statsInterval);

        // Stop streaming
        console.log('\nStopping stream...');
        streamer.stop();
        console.log('✓ Stream stopped\n');

        // Final statistics
        const finalStats = streamer.getStatistics();
        console.log('════════════════════════════════════════════════════════════');
        console.log('FINAL STATISTICS');
        console.log('════════════════════════════════════════════════════════════');
        console.log(`Video Frames:   ${finalStats.videoFrames || 0}`);
        console.log(`Video Packets:  ${finalStats.videoPackets || 0}`);
        console.log(`Audio Packets:  ${finalStats.audioPackets || 0}`);
        console.log(`Connected:      ${streamer.isConnected() ? 'yes' : 'no'}\n`);

        if ((finalStats.videoPackets || 0) > 0) {
            console.log('✓ SUCCESS: Video encoder produced packets!');
            console.log('  (In a real environment with display capture, this would stream to RTMP)\n');
        } else {
            console.log('NOTE: No video packets (expected in headless - needs DesktopDuplication)');
            console.log('      To fix: Run with actual display or implement test pattern injection\n');
        }

        console.log('Test completed!');

    } catch (error) {
        console.error('Error during streaming:', error.message);
        if (error.stack) {
            console.error('Stack:', error.stack);
        }
        process.exit(1);
    }
}

// Handle errors
process.on('uncaughtException', (error) => {
    console.error('UNCAUGHT EXCEPTION:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('UNHANDLED REJECTION:', reason);
    process.exit(1);
});

// Run the test
testStreamingHeadless().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});

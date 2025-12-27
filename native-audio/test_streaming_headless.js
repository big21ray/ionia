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

        // For headless testing, use a local test RTMP URL (won't connect, but encoder will run)
        // Comment this out if you have a real RTMP server
        const testRtmpUrl = 'rtmp://127.0.0.1:1935/live/test';
        console.log('NOTE: Using local test RTMP URL (won\'t actually connect)\n');

        const VideoAudioStreamer = nativeModule.VideoAudioStreamer;
        const streamer = new VideoAudioStreamer();

        try {
            console.log('Initializing streamer...');
            const initialized = streamer.initialize(testRtmpUrl, 30, 5000000, true, 192000, 'both');
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

        // Stream for 10 seconds with injected test pattern frames
        console.log('Streaming for 10 seconds with test pattern frames...\n');
        
        const startTime = Date.now();
        const streamDuration = 10000;
        const frameInterval = 1000 / 30;  // ~33ms per frame @ 30fps
        
        let nextFrameTime = Date.now();
        let frameCount = 0;
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

        // Generate test frames and inject them
        console.log('Starting frame injection loop...\n');
        
        while (Date.now() - startTime < streamDuration) {
            const now = Date.now();
            
            if (now >= nextFrameTime) {
                // Generate a simple test pattern frame (color bars)
                const frameData = Buffer.alloc(1920 * 1080 * 4);
                
                // Create 8 color bars
                const barWidth = 1920 / 8;
                const colors = [
                    { b: 255, g: 255, r: 255 },  // White
                    { b: 255, g: 255, r: 0 },    // Yellow
                    { b: 0, g: 255, r: 255 },    // Cyan
                    { b: 0, g: 255, r: 0 },      // Green
                    { b: 255, g: 0, r: 255 },    // Magenta
                    { b: 255, g: 0, r: 0 },      // Red
                    { b: 0, g: 0, r: 255 },      // Blue
                    { b: 0, g: 0, r: 0 }         // Black
                ];
                
                for (let y = 0; y < 1080; y++) {
                    for (let x = 0; x < 1920; x++) {
                        const barIndex = Math.floor(x / barWidth);
                        const color = colors[barIndex];
                        const offset = (y * 1920 + x) * 4;
                        frameData[offset] = color.b;
                        frameData[offset + 1] = color.g;
                        frameData[offset + 2] = color.r;
                        frameData[offset + 3] = 255;
                    }
                }
                
                // Inject the frame
                streamer.injectFrame(frameData);
                frameCount++;
                nextFrameTime += frameInterval;
                
                // Show progress every 30 frames
                if (frameCount % 30 === 0) {
                    const elapsed = (now - startTime) / 1000;
                    process.stdout.write(`  Generated ${frameCount} frames (${elapsed.toFixed(1)}s)...\r`);
                }
            }
            
            // Small sleep to not busy-wait
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        
        clearInterval(statsInterval);
        process.stdout.write('\n');
        console.log(`\nTotal frames injected: ${frameCount}\n`);

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

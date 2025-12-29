// ============================================================================
// test_streaming_with_injection.js
// ============================================================================
// Test streaming with optimized frame injection
// ============================================================================

const path = require('path');
const fs = require('fs');
const nativeModule = require('./index.js');

// Pre-generate a single test pattern frame once
function generateTestPattern() {
    const frameData = Buffer.alloc(1920 * 1080 * 4);
    
    // Create 8 color bars (simple pattern)
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
    
    return frameData;
}

async function testStreaming() {
    console.log('\nHEADLESS STREAMING TEST - With Frame Injection\n');

    if (!nativeModule.VideoAudioStreamer) {
        console.error('VideoAudioStreamer not available');
        process.exit(1);
    }

    // Initialize COM
    if (nativeModule.initializeCOMInSTAMode) {
        console.log('Initializing COM...');
        if (!nativeModule.initializeCOMInSTAMode()) {
            console.error('Failed to initialize COM');
            process.exit(1);
        }
        console.log('OK\n');
    }

    // Load RTMP URL
    let rtmpUrl = null;
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            rtmpUrl = config.rtmpUrl;
        }
    } catch (err) {
        console.warn('Could not load config.json');
    }

    if (!rtmpUrl) {
        rtmpUrl = process.env.RTMP_URL || 'rtmp://localhost:1935/live/test';
    }

    console.log(`RTMP URL: ${rtmpUrl}\n`);

    const streamer = new nativeModule.VideoAudioStreamer();

    try {
        console.log('Initializing streamer...');
        if (!streamer.initialize(rtmpUrl, 30, 5000000, true, 192000, 'both')) {
            console.error('Failed to initialize streamer');
            process.exit(1);
        }
        console.log(`OK - Codec: ${streamer.getCodecName()}\n`);

        console.log('Starting stream...');
        if (!streamer.start()) {
            console.error('Failed to start stream');
            process.exit(1);
        }
        console.log('OK\n');

        // Pre-generate test pattern
        console.log('Generating test pattern frame...');
        const testFrame = generateTestPattern();
        console.log(`OK - Frame size: ${testFrame.length} bytes (${(testFrame.length / 1024 / 1024).toFixed(2)} MB)\n`);

        // Wait for threads to initialize
        console.log('Waiting for threads...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log('OK\n');

        // Stream for 10 seconds
        console.log('Streaming for 10 seconds...\n');
        
        const startTime = Date.now();
        const streamDuration = 10000;
        const frameInterval = 1000 / 30;  // ~33ms per frame @ 30fps
        
        let nextFrameTime = Date.now();
        let injectedCount = 0;
        let statsIntervalHandle;
        
        // Stats every 2 seconds
        statsIntervalHandle = setInterval(() => {
            const stats = streamer.getStatistics();
            const elapsed = (Date.now() - startTime) / 1000;
            console.log(`${elapsed.toFixed(1)}s - Video: ${stats.videoFrames || 0} frames, ${stats.videoPackets || 0} packets | Audio: ${stats.audioPackets || 0} packets`);
        }, 2000);

        // Inject frames
        while (Date.now() - startTime < streamDuration) {
            const now = Date.now();
            
            if (now >= nextFrameTime) {
                try {
                    streamer.injectFrame(testFrame);
                    injectedCount++;
                    nextFrameTime += frameInterval;
                    
                    if (injectedCount % 30 === 0) {
                        console.log(`Injected ${injectedCount} frames...`);
                    }
                } catch (error) {
                    console.error('Error injecting frame:', error.message);
                    break;
                }
            }
            
            // Sleep 1ms
            await new Promise(resolve => setTimeout(resolve, 1));
        }
        
        clearInterval(statsIntervalHandle);
        console.log(`\nTotal frames injected: ${injectedCount}\n`);

        // Stop
        console.log('Stopping stream...');
        streamer.stop();
        console.log('OK\n');

        // Final stats
        const finalStats = streamer.getStatistics();
        console.log('════════════════════════════════════════════════════════════');
        console.log('FINAL STATISTICS');
        console.log('════════════════════════════════════════════════════════════');
        console.log(`Video Frames:   ${finalStats.videoFrames || 0}`);
        console.log(`Video Packets:  ${finalStats.videoPackets || 0}`);
        console.log(`Audio Packets:  ${finalStats.audioPackets || 0}`);
        console.log(`Connected:      ${streamer.isConnected() ? 'yes' : 'no'}\n`);

        if ((finalStats.videoPackets || 0) > 0) {
            console.log('SUCCESS: Video encoder produced packets with injected frames!');
        } else {
            console.log('No video packets produced (frame injection may have failed)');
        }

    } catch (error) {
        console.error('Error:', error.message);
        process.exit(1);
    }
}

testStreaming().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});

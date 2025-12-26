const path = require('path');
const fs = require('fs');
const nativeModule = require('./index.js');

async function testStream() {
    console.log('📡 Testing RTMP Streaming to YouTube...\n');

    if (!nativeModule.VideoAudioStreamer) {
        console.error('❌ VideoAudioStreamer not available. Make sure the native module is compiled.');
        process.exit(1);
    }

    // Initialize COM in STA mode
    if (nativeModule.initializeCOMInSTAMode) {
        console.log('🔧 Initializing COM in STA mode...');
        if (!nativeModule.initializeCOMInSTAMode()) {
            console.error('❌ Failed to initialize COM');
            process.exit(1);
        }
        console.log('✅ COM initialized\n');
    }

    // Load RTMP URL from config.json
    let rtmpUrl = null;
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            rtmpUrl = config.rtmpUrl;
            console.log('✅ RTMP URL loaded from config.json');
        }
    } catch (err) {
        console.warn('⚠️  Could not load config.json:', err.message);
    }

    if (!rtmpUrl) {
        rtmpUrl = process.env.RTMP_URL || 'rtmp://localhost:1935/live/test';
        console.warn('⚠️  Using default or environment RTMP URL');
    }

    console.log(`📡 RTMP URL: ${rtmpUrl}\n`);

    const VideoAudioStreamer = nativeModule.VideoAudioStreamer;
    const streamer = new VideoAudioStreamer();

    try {
        // Initialize: rtmpUrl, fps, videoBitrate, useNvenc, audioBitrate, audioMode
        console.log('🔧 Initializing streamer...');
        const initialized = streamer.initialize(rtmpUrl, 30, 5000000, true, 192000, 'both');
        
        if (!initialized) {
            console.error('❌ Failed to initialize streamer');
            process.exit(1);
        }
        
        console.log('✅ Streamer initialized');
        console.log(`📹 Video Codec: ${streamer.getCodecName()}\n`);

        // Start streaming
        console.log('▶️  Starting stream...');
        const started = streamer.start();
        
        if (!started) {
            console.error('❌ Failed to start stream');
            process.exit(1);
        }
        console.log('✅ Stream started\n');

        // Wait for threads to initialize
        console.log('⏳ Waiting 2 seconds for threads to initialize...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log('✅ Threads initialized\n');

        // Stream for 30 seconds
        console.log('⏱️  Streaming for 30 seconds...');
        console.log('   (Check YouTube Live Dashboard to see if stream is receiving data)\n');
        
        const startTime = Date.now();
        const statsInterval = setInterval(() => {
            try {
                const stats = streamer.getStatistics();
                const elapsed = (Date.now() - startTime) / 1000;
                const isConnected = streamer.isConnected();
                const isBackpressure = streamer.isBackpressure();
                
                console.log(`📊 ${elapsed.toFixed(1)}s | Connected: ${isConnected ? '✅' : '❌'} | Backpressure: ${isBackpressure ? '⚠️' : '✅'}`);
                console.log(`   Video: ${stats.videoFrames || 0} frames, ${stats.videoPackets || 0} packets`);
                console.log(`   Audio: ${stats.audioPackets || 0} packets\n`);
            } catch (error) {
                console.error('❌ Error getting stats:', error.message);
            }
        }, 2000);

        // Wait 30 seconds
        await new Promise(resolve => setTimeout(resolve, 30000));
        clearInterval(statsInterval);

        // Stop streaming
        console.log('\n⏹️  Stopping stream...');
        streamer.stop();
        console.log('✅ Stream stopped\n');

        // Final statistics
        const finalStats = streamer.getStatistics();
        console.log('📊 Final Statistics:');
        console.log(`   Video Frames: ${finalStats.videoFrames || 0}`);
        console.log(`   Video Packets: ${finalStats.videoPackets || 0}`);
        console.log(`   Audio Packets: ${finalStats.audioPackets || 0}`);
        console.log(`   Connected: ${streamer.isConnected() ? '✅' : '❌'}\n`);

        console.log('✅ Test completed!');
        console.log('   Check YouTube Live Dashboard to verify stream was received.\n');

    } catch (error) {
        console.error('\n❌ Error during streaming:', error);
        if (error.stack) {
            console.error('Stack trace:', error.stack);
        }
        process.exit(1);
    }
}

// Handle errors
process.on('uncaughtException', (error) => {
    console.error('\n❌ UNCAUGHT EXCEPTION:', error);
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    console.error('\n❌ UNHANDLED REJECTION:', reason);
    process.exit(1);
});

// Run the test
testStream().catch(error => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
});


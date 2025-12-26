// Simple debug test for VideoAudioStreamer
const path = require('path');
const fs = require('fs');
const nativeModule = require('./index.js');

async function debugStreamer() {
    console.log('🔍 DEBUG: VideoAudioStreamer Component Test\n');

    if (!nativeModule.VideoAudioStreamer) {
        console.error('❌ VideoAudioStreamer not loaded');
        process.exit(1);
    }

    // Load RTMP URL
    let rtmpUrl = null;
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));
        rtmpUrl = cfg.rtmpUrl;
    } catch (e) {
        console.error('❌ No config.json found. Create one with:');
        console.error('   { "rtmpUrl": "rtmp://..." }');
        process.exit(1);
    }

    console.log(`📡 RTMP URL: ${rtmpUrl}\n`);

    // Initialize COM
    console.log('🔧 Initializing COM in STA mode...');
    if (nativeModule.initializeCOMInSTAMode) {
        nativeModule.initializeCOMInSTAMode();
        console.log('✅ COM initialized\n');
    }

    // Create streamer
    const streamer = new nativeModule.VideoAudioStreamer();
    console.log('✅ VideoAudioStreamer instance created\n');

    // Initialize
    console.log('🔧 Initializing streamer...');
    try {
        const ok = streamer.initialize(
            rtmpUrl,
            30,              // fps
            5_000_000,       // video bitrate
            true,            // use NVENC
            192_000,         // audio bitrate
            'both'           // audio mode
        );
        if (!ok) {
            console.error('❌ Initialize returned false');
            process.exit(1);
        }
        console.log('✅ Streamer initialized\n');
    } catch (e) {
        console.error('❌ Initialize threw:', e.message);
        process.exit(1);
    }

    // Get codec name
    try {
        const codec = streamer.getCodecName();
        console.log(`📹 Codec: ${codec}\n`);
    } catch (e) {
        console.error('❌ getCodecName threw:', e.message);
    }

    // Start
    console.log('▶️  Starting stream...');
    try {
        const ok = streamer.start();
        if (!ok) {
            console.error('❌ Start returned false');
            process.exit(1);
        }
        console.log('✅ Stream started\n');
    } catch (e) {
        console.error('❌ Start threw:', e.message);
        process.exit(1);
    }

    // Give threads time to initialize
    console.log('⏱️  Waiting 2 seconds for threads to start...');
    await new Promise(r => setTimeout(r, 2000));
    console.log('✅ Ready to monitor\n');

    // Monitor for 15 seconds
    let monitorTime = 0;
    const startTime = Date.now();

    const monitor = setInterval(() => {
        try {
            const stats = streamer.getStatistics();
            const isRunning = streamer.isRunning();
            const isConnected = streamer.isConnected();
            const isBackpressure = streamer.isBackpressure();

            const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

            console.log(
                `[${elapsed}s] ` +
                `Running=${isRunning} | ` +
                `Connected=${isConnected} | ` +
                `Backpressure=${isBackpressure} | ` +
                `Video=${stats.videoFrames}/${stats.videoPackets} | ` +
                `Audio=${stats.audioPackets}`
            );

            // Check for stall
            if (elapsed > 5 && stats.videoPackets === 0) {
                console.error('❌ No video packets after 5s - encoder stalled');
                process.exit(1);
            }

            if (elapsed > 8 && !isConnected) {
                console.error('❌ Not connected after 8s - RTMP failed');
                process.exit(1);
            }

            monitorTime = elapsed;
        } catch (e) {
            console.error('❌ Error during monitoring:', e.message);
        }
    }, 1000);

    // Run for 15 seconds
    await new Promise(r => setTimeout(r, 15_000));
    clearInterval(monitor);

    // Stop
    console.log('\n⏹️  Stopping stream...');
    try {
        streamer.stop();
        console.log('✅ Stream stopped');
    } catch (e) {
        console.error('❌ Stop threw:', e.message);
    }

    // Final stats
    try {
        const final = streamer.getStatistics();
        console.log('\n📊 FINAL STATS');
        console.log(`   Video Frames: ${final.videoFrames}`);
        console.log(`   Video Packets: ${final.videoPackets}`);
        console.log(`   Audio Packets: ${final.audioPackets}`);

        if (final.videoPackets > 0) {
            console.log('\n✅ STREAM WORKING - packets sent to RTMP');
            console.log('   (Check YouTube Studio for incoming stream)');
        } else {
            console.log('\n⚠️  WARNING - No packets sent');
            console.log('   Check:');
            console.log('   1. RTMP URL is correct');
            console.log('   2. Network/firewall allows RTMP');
            console.log('   3. Stream key is valid');
        }
    } catch (e) {
        console.error('❌ Error getting final stats:', e.message);
    }

    console.log('\n🏁 Test complete');
}

debugStreamer().catch(err => {
    console.error('\n❌ FATAL ERROR');
    console.error(err);
    process.exit(1);
});

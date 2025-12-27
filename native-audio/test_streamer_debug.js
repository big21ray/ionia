#!/usr/bin/env node
/**
 * Test Streamer - Debug version
 * Logs everything and doesn't auto-stop
 */

const WasapiCapture = require('./build/Release/wasapi_capture.node');

// CRITICAL: Keep process alive!
process.stdin.resume();

// Catch uncaught exceptions
process.on('uncaughtException', (err) => {
    console.error('\n❌ UNCAUGHT EXCEPTION:');
    console.error('Message:', err.message);
    console.error('Stack:', err.stack);
    process.exit(1);
});

async function main() {
    const YOUTUBE_STREAM_KEY = '3avj-5j6r-utec-qp7m-86hq';
    const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${YOUTUBE_STREAM_KEY}`;

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Streamer Debug Test');
    console.log('═══════════════════════════════════════════════════════════\n');
    console.log(`🌐 RTMP: ${rtmpUrl}\n`);

    try {
        console.log('[1] Creating streamer instance...');
        const streamer = new WasapiCapture.VideoAudioStreamer();
        console.log('✅ Instance created\n');
        
        console.log('[2] Initializing streamer...');
        const initialized = streamer.initialize(
            rtmpUrl,
            30,              // FPS
            5000000,         // Video bitrate
            false,           // Use NVENC
            192000,          // Audio bitrate
            'both'           // Audio mode
        );
        
        if (!initialized) {
            console.error('❌ Initialize failed');
            process.exit(1);
        }
        console.log('✅ Initialized\n');
        
        console.log('[3] Starting stream...');
        const started = streamer.start();
        if (!started) {
            console.error('❌ Start failed');
            process.exit(1);
        }
        console.log('✅ Started\n');
        
        console.log('[4] Monitoring stream (press Ctrl+C to stop)...\n');
        
        // Test immediate call first
        console.log('[TEST] Attempting first stats call immediately...');
        try {
            console.log('  - isRunning()');
            const isRunning = streamer.isRunning();
            console.log(`    = ${isRunning}`);
            
            console.log('  - isConnected()');
            const isConnected = streamer.isConnected();
            console.log(`    = ${isConnected}`);
            
            console.log('  - getStatistics()');
            const stats = streamer.getStatistics();
            console.log(`    = Got stats object`);
            console.log(`    Video frames: ${stats.videoFrames}`);
            console.log(`    Video packets: ${stats.videoPackets}`);
            console.log(`    Audio packets: ${stats.audioPackets}`);
        } catch (e) {
            console.error('❌ IMMEDIATE TEST FAILED:', e.message);
            console.error('Stack:', e.stack);
            process.exit(1);
        }
        
        console.log('\n[OK] Immediate test passed, starting monitoring loop...\n');
        
        // Monitor continuously (don't auto-stop)
        let iteration = 0;
        const monitorInterval = setInterval(() => {
            iteration++;
            console.log(`[${iteration}] Checking stats...`);
            try {
                console.log('  - Calling isRunning()...');
                const isRunning = streamer.isRunning();
                console.log(`    ✓ isRunning=${isRunning}`);
                
                console.log('  - Calling isConnected()...');
                const isConnected = streamer.isConnected();
                console.log(`    ✓ isConnected=${isConnected}`);
                
                console.log('  - Calling getStatistics()...');
                const stats = streamer.getStatistics();
                console.log(`    ✓ Got stats`);
                
                console.log(`  → Video: ${stats.videoFrames || '?'} frames, ${stats.videoPackets || '?'} packets`);
                console.log(`  → Audio: ${stats.audioPackets || '?'} packets\n`);
                
            } catch (e) {
                console.error(`[${iteration}] ❌ Error:`, e.message);
                console.error('Stack:', e.stack);
                clearInterval(monitorInterval);
                process.exit(1);
            }
        }, 2000);  // Every 2 seconds
        
        // Graceful shutdown on Ctrl+C
        process.on('SIGINT', () => {
            console.log('\n\n[SHUTDOWN] Stopping stream...');
            clearInterval(monitorInterval);
            
            try {
                streamer.stop();
                console.log('✅ Stream stopped');
            } catch (e) {
                console.error('⚠️  Error stopping:', e.message);
            }
            
            console.log('\n✅ Test complete\n');
            process.exit(0);
        });
        
    } catch (error) {
        console.error('❌ Exception:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

// Run and don't exit until user presses Ctrl+C
main().catch(err => {
    console.error('❌ Fatal error:', err);
    process.exit(1);
});

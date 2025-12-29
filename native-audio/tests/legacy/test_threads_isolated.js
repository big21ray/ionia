#!/usr/bin/env node
/**
 * Test individual threads in isolation
 * Helps identify which thread is causing the crash
 */

const WasapiCapture = require('./build/Release/wasapi_capture.node');
process.stdin.resume();

const YOUTUBE_STREAM_KEY = '3avj-5j6r-utec-qp7m-86hq';
const RTMP_URL = `rtmp://a.rtmp.youtube.com/live2/${YOUTUBE_STREAM_KEY}`;

// Thread configurations to test
const THREAD_CONFIGS = [
    {
        name: "NONE (all disabled)",
        capture: false,
        videoTick: false,
        audioTick: false
    },
    {
        name: "CaptureThread ONLY",
        capture: true,
        videoTick: false,
        audioTick: false
    },
    {
        name: "VideoTickThread ONLY",
        capture: false,
        videoTick: true,
        audioTick: false
    },
    {
        name: "AudioTickThread ONLY",
        capture: false,
        videoTick: false,
        audioTick: true
    },
    {
        name: "Capture + VideoTick",
        capture: true,
        videoTick: true,
        audioTick: false
    },
    {
        name: "Capture + AudioTick",
        capture: true,
        videoTick: false,
        audioTick: true
    },
    {
        name: "VideoTick + AudioTick",
        capture: false,
        videoTick: true,
        audioTick: true
    },
    {
        name: "ALL THREADS",
        capture: true,
        videoTick: true,
        audioTick: true
    }
];

let currentConfigIndex = 0;

async function testConfig(config) {
    console.log('\n' + '='.repeat(70));
    console.log(`TEST: ${config.name}`);
    console.log('='.repeat(70));
    console.log(`  Capture: ${config.capture ? '✓' : '✗'}`);
    console.log(`  VideoTick: ${config.videoTick ? '✓' : '✗'}`);
    console.log(`  AudioTick: ${config.audioTick ? '✓' : '✗'}\n`);

    try {
        const streamer = new WasapiCapture.VideoAudioStreamer();
        console.log('[INIT] Creating streamer...');
        
        // Set thread configuration BEFORE initialization
        console.log('[INIT] Setting thread config...');
        streamer.setThreadConfig(config.capture, config.videoTick, config.audioTick);
        
        console.log('[INIT] Initializing...');
        const initialized = streamer.initialize(
            RTMP_URL,
            30,              // FPS
            5000000,         // Video bitrate
            false,           // Use NVENC
            192000,          // Audio bitrate
            'both'           // Audio mode
        );
        
        if (!initialized) {
            console.error('❌ Initialize failed');
            return false;
        }
        console.log('[INIT] ✓ Initialized');
        
        console.log('[CONFIG] Setting thread configuration...');
        streamer.setThreadConfig(config.capture, config.videoTick, config.audioTick);
        console.log('[CONFIG] ✓ Configuration applied');
        
        console.log('[START] Starting stream...');
        const started = streamer.start();
        if (!started) {
            console.error('❌ Start failed');
            return false;
        }
        console.log('[START] ✓ Stream started');
        
        // Run for 3 seconds
        console.log('[TEST] Running for 3 seconds...');
        await new Promise(resolve => {
            let elapsed = 0;
            const interval = setInterval(() => {
                elapsed += 0.1;
                process.stdout.write('.');
                if (elapsed >= 3) {
                    clearInterval(interval);
                    resolve();
                }
            }, 100);
        });
        console.log('\n[TEST] ✓ 3 seconds completed without crash');
        
        // Get stats
        try {
            const stats = streamer.getStatistics();
            console.log(`[STATS] Video: ${stats.videoFrames} frames, ${stats.videoPackets} packets`);
            console.log(`[STATS] Audio: ${stats.audioPackets} packets`);
        } catch (e) {
            console.error(`[STATS] Error getting stats: ${e.message}`);
        }
        
        // Stop
        console.log('[STOP] Stopping stream...');
        streamer.stop();
        console.log('[STOP] ✓ Stopped');
        
        console.log('✅ CONFIG PASSED\n');
        return true;
        
    } catch (err) {
        console.error('❌ CONFIG FAILED:', err.message);
        if (err.stack) {
            console.error('Stack:', err.stack);
        }
        return false;
    }
}

async function runAllTests() {
    console.log('\n' + '█'.repeat(70));
    console.log('  THREAD ISOLATION TEST - Testing each thread combination');
    console.log('█'.repeat(70));
    
    const results = [];
    
    for (let i = 0; i < THREAD_CONFIGS.length; i++) {
        const config = THREAD_CONFIGS[i];
        console.log(`\n[${i + 1}/${THREAD_CONFIGS.length}] Testing: ${config.name}`);
        
        const passed = await testConfig(config);
        results.push({
            name: config.name,
            passed: passed
        });
        
        // Wait 1 second between tests
        await new Promise(resolve => setTimeout(resolve, 1000));
    }
    
    // Summary
    console.log('\n' + '█'.repeat(70));
    console.log('  TEST SUMMARY');
    console.log('█'.repeat(70));
    
    results.forEach((result, i) => {
        const status = result.passed ? '✓ PASS' : '✗ FAIL';
        console.log(`${(i + 1).toString().padStart(2)}. ${status}  ${result.name}`);
    });
    
    const passedCount = results.filter(r => r.passed).length;
    console.log(`\nTotal: ${passedCount}/${results.length} passed\n`);
    
    // Analyze failures
    const failed = results.filter(r => !r.passed);
    if (failed.length > 0) {
        console.log('❌ FAILED CONFIGURATIONS:');
        failed.forEach(f => {
            console.log(`   - ${f.name}`);
        });
    }
    
    process.exit(0);
}

runAllTests().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

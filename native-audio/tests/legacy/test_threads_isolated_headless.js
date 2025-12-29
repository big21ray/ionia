#!/usr/bin/env node
/**
 * Thread isolation test with FRAME INJECTION (no desktop capture needed)
 * This tests each thread combination without requiring a physical display
 */

const WasapiCapture = require('./build/Release/wasapi_capture.node');
process.stdin.resume();

const YOUTUBE_STREAM_KEY = '3avj-5j6r-utec-qp7m-86hq';
const RTMP_URL = `rtmp://a.rtmp.youtube.com/live2/${YOUTUBE_STREAM_KEY}`;

// Create a dummy ARGB frame (1920x1080 = 8294400 bytes for ARGB)
const WIDTH = 1920;
const HEIGHT = 1080;
const FRAME_SIZE = WIDTH * HEIGHT * 4;

function createDummyFrame() {
    const frame = Buffer.alloc(FRAME_SIZE);
    // Fill with a simple pattern (blue)
    for (let i = 0; i < FRAME_SIZE; i += 4) {
        frame[i] = 0;      // Blue
        frame[i + 1] = 0;  // Green
        frame[i + 2] = 255; // Red
        frame[i + 3] = 255; // Alpha
    }
    return frame;
}

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
let passCount = 0;
let failCount = 0;
const results = [];

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
            30,         // fps
            5000000,    // video bitrate
            true,       // use NVENC
            192000,     // audio bitrate
            'both'      // audio mode
        );

        if (!initialized) {
            console.log('❌ Initialize failed');
            results.push({ config: config.name, status: 'FAIL', reason: 'Initialize returned false' });
            failCount++;
            return;
        }

        console.log('✓ Initialize succeeded');

        // Inject a dummy frame to enable frame mode
        console.log('[TEST] Injecting dummy frame...');
        const dummyFrame = createDummyFrame();
        streamer.injectFrame(dummyFrame);

        console.log('[TEST] Starting stream...');
        const started = streamer.start();
        if (!started) {
            console.log('❌ Start failed');
            results.push({ config: config.name, status: 'FAIL', reason: 'Start returned false' });
            failCount++;
            return;
        }

        console.log('✓ Start succeeded');

        // Keep injecting frames every 100ms for 3 seconds
        const testDuration = 3000;
        const frameInterval = 100;
        let frameCount = 0;
        let lastStats = null;

        await new Promise(resolve => {
            const startTime = Date.now();
            const frameTimer = setInterval(() => {
                if (Date.now() - startTime > testDuration) {
                    clearInterval(frameTimer);
                    resolve();
                    return;
                }

                try {
                    streamer.injectFrame(dummyFrame);
                    frameCount++;
                    
                    if (frameCount % 10 === 0) {
                        const stats = streamer.getStatistics();
                        process.stdout.write('.');
                    }
                } catch (e) {
                    console.error(`[Frame inject error] ${e.message}`);
                }
            }, frameInterval);
        });

        console.log('\n[TEST] Stopping stream...');
        streamer.stop();

        const finalStats = streamer.getStatistics();
        console.log(`[STATS] Video frames: ${finalStats.videoFrames}, Video packets: ${finalStats.videoPackets}, Audio packets: ${finalStats.audioPackets}`);

        // Determine pass/fail
        // PASS if we got at least 1 video packet (frames were processed)
        const isPass = finalStats.videoPackets > 0 || config.videoTick === false;
        
        if (isPass) {
            console.log('✓ PASS');
            results.push({ config: config.name, status: 'PASS', stats: finalStats });
            passCount++;
        } else {
            console.log('✗ FAIL - No video packets generated');
            results.push({ config: config.name, status: 'FAIL', reason: 'No video packets', stats: finalStats });
            failCount++;
        }

    } catch (err) {
        console.error(`❌ Exception: ${err.message}`);
        console.error(err.stack);
        results.push({ config: config.name, status: 'FAIL', reason: `Exception: ${err.message}` });
        failCount++;
    }
}

async function runAllTests() {
    console.log('\n' + '█'.repeat(70));
    console.log('  THREAD ISOLATION TEST (HEADLESS MODE - FRAME INJECTION)');
    console.log('█'.repeat(70));

    for (const config of THREAD_CONFIGS) {
        await testConfig(config);
    }

    // Print summary
    console.log('\n' + '█'.repeat(70));
    console.log('  TEST SUMMARY');
    console.log('█'.repeat(70));
    
    for (let i = 0; i < results.length; i++) {
        const r = results[i];
        const status = r.status === 'PASS' ? '✓' : '✗';
        console.log(` ${i + 1}. ${status} ${r.status.padEnd(4)} ${r.config}`);
    }

    console.log(`\nTotal: ${passCount}/${THREAD_CONFIGS.length} passed`);

    if (failCount > 0) {
        console.log(`\n❌ FAILED CONFIGURATIONS:`);
        for (const r of results) {
            if (r.status === 'FAIL') {
                console.log(`   - ${r.config}`);
                if (r.reason) {
                    console.log(`     Reason: ${r.reason}`);
                }
            }
        }
    }

    console.log('\n');
    process.exit(0);
}

runAllTests().catch(err => {
    console.error('Fatal error:', err);
    process.exit(1);
});

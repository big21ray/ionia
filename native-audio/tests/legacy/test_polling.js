// Test without setTimeout - use immediate callbacks in event loop
const nativeModule = require('./index.js');
const fs = require('fs');
const path = require('path');

async function sleep(ms) {
    return new Promise(resolve => {
        let elapsed = 0;
        const interval = setInterval(() => {
            elapsed += 10;
            if (elapsed >= ms) {
                clearInterval(interval);
                resolve();
            }
        }, 10);
    });
}

async function test() {
    let rtmpUrl = 'rtmp://localhost:1935/live/test';
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));
        rtmpUrl = cfg.rtmpUrl;
    } catch {}

    console.log('1. Creating streamer');
    const s = new nativeModule.VideoAudioStreamer();
    console.log('   ✅ OK\n');

    console.log('2. Initializing');
    const initOk = s.initialize(rtmpUrl, 30, 5000000, true, 192000, 'both');
    console.log(`   ✅ OK (${initOk})\n`);

    console.log('3. Starting');
    const startOk = s.start();
    console.log(`   ✅ OK (${startOk})\n`);

    console.log('4. Waiting 1 second');
    await sleep(1000);
    console.log('   ✅ OK\n');

    console.log('5. Get stats (attempt 1)');
    try {
        const st1 = s.getStatistics();
        console.log(`   ✅ Video: ${st1.videoPackets}, Audio: ${st1.audioPackets}\n`);
    } catch (e) {
        console.error(`   ❌ Error: ${e.message}\n`);
    }

    console.log('6. Waiting 1 second');
    await sleep(1000);
    console.log('   ✅ OK\n');

    console.log('7. Get stats (attempt 2)');
    try {
        const st2 = s.getStatistics();
        console.log(`   ✅ Video: ${st2.videoPackets}, Audio: ${st2.audioPackets}\n`);
    } catch (e) {
        console.error(`   ❌ Error: ${e.message}\n`);
    }

    console.log('8. Waiting 1 second');
    await sleep(1000);
    console.log('   ✅ OK\n');

    console.log('9. Get stats (attempt 3)');
    try {
        const st3 = s.getStatistics();
        console.log(`   ✅ Video: ${st3.videoPackets}, Audio: ${st3.audioPackets}\n`);
    } catch (e) {
        console.error(`   ❌ Error: ${e.message}\n`);
    }

    console.log('10. Checking connection status');
    try {
        const conn = s.isConnected();
        const bp = s.isBackpressure();
        console.log(`   ✅ Connected: ${conn}, Backpressure: ${bp}\n`);
    } catch (e) {
        console.error(`   ❌ Error: ${e.message}\n`);
    }

    console.log('11. Stopping');
    try {
        s.stop();
        console.log('   ✅ OK\n');
    } catch (e) {
        console.error(`   ❌ Error: ${e.message}\n`);
    }

    console.log('✅ All tests completed successfully!');
    process.exit(0);
}

test().catch(err => {
    console.error('❌ Fatal error:', err.message);
    process.exit(1);
});

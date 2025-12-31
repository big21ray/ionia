// Test with explicit error handling
const nativeModule = require('./index.js');
const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err);
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('❌ Unhandled rejection:', reason);
    process.exit(1);
});

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

    console.log('4. About to wait 1 second');
    
    // Wait with timeout tracking
    const delay = (ms) => new Promise(r => {
        console.log(`   [Setting timer for ${ms}ms]`);
        const timer = setTimeout(() => {
            console.log(`   [Timer fired!]`);
            r();
        }, ms);
    });

    await delay(1000);
    console.log('   ✅ Completed wait\n');

    console.log('5. Get stats');
    try {
        const st = s.getStatistics();
        console.log(`   ✅ Stats: ${JSON.stringify(st)}\n`);
    } catch (e) {
        console.error(`   ❌ Error: ${e.message}\n`);
    }

    console.log('6. Stopping');
    try {
        s.stop();
        console.log('   ✅ OK\n');
    } catch (e) {
        console.error(`   ❌ Error: ${e.message}\n`);
    }

    console.log('✅ Test completed!');
    process.exit(0);
}

console.log('Starting test...\n');
test().catch(err => {
    console.error('❌ Fatal error:', err.message, err.stack);
    process.exit(1);
});

// Safety timeout
setTimeout(() => {
    console.error('\n⚠️  Test timeout - forcing exit');
    process.exit(1);
}, 10000);

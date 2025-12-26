// Test with detailed output
const nativeModule = require('./index.js');
const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err.message);
    console.error(err.stack);
    process.exit(1);
});

process.on('exit', (code) => {
    console.error(`\n>>> Process exiting with code ${code}`);
});

async function test() {
    let rtmpUrl = 'rtmp://localhost:1935/live/test';
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));
        rtmpUrl = cfg.rtmpUrl;
    } catch {}

    console.log('[1] Create streamer');
    const s = new nativeModule.VideoAudioStreamer();
    console.log('[1] ✅');

    console.log('[2] Initialize');
    const initOk = s.initialize(rtmpUrl, 30, 5000000, true, 192000, 'both');
    console.log(`[2] ✅ (${initOk})`);

    console.log('[3] Start');
    const startOk = s.start();
    console.log(`[3] ✅ (${startOk})`);

    console.log('[4] Setting timer for 2 seconds');
    await new Promise((resolve) => {
        console.log('[4a] Timer callback set');
        const t = setTimeout(() => {
            console.log('[4b] Timer fired!');
            resolve();
        }, 2000);
    });
    console.log('[4c] After await');

    console.log('[5] Get stats');
    const st = s.getStatistics();
    console.log(`[5] ✅ Video=${st.videoPackets}, Audio=${st.audioPackets}`);

    console.log('[6] Stop');
    s.stop();
    console.log('[6] ✅');

    console.log('\n✅ Test passed!');
    process.exit(0);
}

console.log('>>>  Test starting\n');
test().catch(err => {
    console.error('❌ Fatal error:', err.message);
    console.error(err.stack);
    process.exit(1);
});

// Safety timeout
setTimeout(() => {
    console.error('\n⚠️  Test timeout after 6 seconds - forcing exit');
    process.exit(1);
}, 6000);

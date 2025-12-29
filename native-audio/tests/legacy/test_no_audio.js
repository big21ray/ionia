// Test without audio - check if problem is audio-related
const nativeModule = require('./index.js');
const fs = require('fs');
const path = require('path');

process.on('uncaughtException', (err) => {
    console.error('❌ Uncaught exception:', err.message);
    console.error(err.stack);
    process.exit(1);
});

async function test() {
    let rtmpUrl = 'rtmp://localhost:1935/live/test';
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));
        rtmpUrl = cfg.rtmpUrl;
    } catch {}

    console.log('[1] Create');
    const s = new nativeModule.VideoAudioStreamer();
    console.log('[1] ✅');

    console.log('[2] Init (no audio - using empty mode)');
    // Try with empty/no audio mode
    const initOk = s.initialize(rtmpUrl, 30, 5000000, true, 192000, '');
    console.log(`[2] ✅ (${initOk})`);

    console.log('[3] Start');
    const startOk = s.start();
    console.log(`[3] ✅ (${startOk})`);

    console.log('[4] Timer test');
    await new Promise((resolve) => {
        console.log('[4a] Timer set');
        setTimeout(() => {
            console.log('[4b] Timer fired!');
            resolve();
        }, 1000);
    });
    console.log('[4c] Done');

    console.log('[5] Get stats');
    const st = s.getStatistics();
    console.log(`[5] ✅ Video=${st.videoPackets}, Audio=${st.audioPackets}`);

    console.log('[6] Stop');
    s.stop();
    console.log('[6] ✅');

    console.log('\n✅ Success!');
    process.exit(0);
}

console.log('Starting...\n');
test().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});

setTimeout(() => {
    console.error('\n⚠️  Timeout - forcing exit');
    process.exit(1);
}, 8000);

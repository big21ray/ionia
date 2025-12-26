// Minimal test to check if video frames are being captured
const nativeModule = require('./index.js');
const fs = require('fs');
const path = require('path');

async function test() {
    let rtmpUrl = 'rtmp://localhost:1935/live/test';
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));
        rtmpUrl = cfg.rtmpUrl;
    } catch {}

    console.log('Creating streamer...');
    const s = new nativeModule.VideoAudioStreamer();

    console.log('Initializing...');
    const initOk = s.initialize(rtmpUrl, 30, 5000000, true, 192000, 'desktop');
    console.log(`Init OK: ${initOk}`);

    console.log('Starting...');
    const startOk = s.start();
    console.log(`Start OK: ${startOk}`);

    console.log('Waiting for video frames to encode...\n');

    let capturedFrames = 0;
    let previousFrames = 0;

    for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));

        const stats = s.getStatistics();
        const newFrames = stats.videoPackets;
        const framesDelta = newFrames - previousFrames;

        console.log(`[${i + 1}s] Video packets: ${stats.videoPackets}, Delta: ${framesDelta}, Audio: ${stats.audioPackets}`);

        if (framesDelta > 0) {
            capturedFrames++;
        }

        previousFrames = newFrames;
    }

    console.log(`\n✅ Analysis:`);
    console.log(`   Total seconds with video activity: ${capturedFrames}/10`);

    if (capturedFrames === 0) {
        console.log(`   ❌ FAILED: No video packets produced`);
        console.log(`   Possible issues:`);
        console.log(`     - DXGI desktop capture not working`);
        console.log(`     - Video encoder not receiving frames`);
        console.log(`     - Frame encoding failing silently`);
    } else {
        console.log(`   ✅ SUCCESS: Video pipeline working`);
    }

    console.log('\nStopping...');
    s.stop();
    console.log('Done!');
    process.exit(capturedFrames > 0 ? 0 : 1);
}

test().catch(err => {
    console.error('❌ Error:', err.message);
    process.exit(1);
});

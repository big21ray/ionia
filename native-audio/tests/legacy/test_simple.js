// Direct stats printing - no intervals
const nativeModule = require('./index.js');
const fs = require('fs');
const path = require('path');

let rtmpUrl = 'rtmp://localhost:1935/live/test';
try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));
    rtmpUrl = cfg.rtmpUrl;
} catch {}

console.log('Step 1: Creating streamer');
const s = new nativeModule.VideoAudioStreamer();
console.log('✅ Created\n');

console.log('Step 2: Initializing');
const initOk = s.initialize(rtmpUrl, 30, 5000000, true, 192000, 'both');
console.log(`✅ Initialized (ok=${initOk})\n`);

console.log('Step 3: Starting');
const startOk = s.start();
console.log(`✅ Started (ok=${startOk})\n`);

console.log('Step 4: Sleeping 1 second');
setTimeout(() => {
    try {
        console.log('\nStep 5: Get stats (attempt 1)');
        const st1 = s.getStatistics();
        console.log(`Video: ${st1.videoPackets} packets, Audio: ${st1.audioPackets} packets`);
        
        console.log('\nStep 6: Sleep 1 second');
        setTimeout(() => {
            try {
                console.log('\nStep 7: Get stats (attempt 2)');
                const st2 = s.getStatistics();
                console.log(`Video: ${st2.videoPackets} packets, Audio: ${st2.audioPackets} packets`);
                
                console.log('\nStep 8: Sleep 1 second');
                setTimeout(() => {
                    try {
                        console.log('\nStep 9: Get stats (attempt 3)');
                        const st3 = s.getStatistics();
                        console.log(`Video: ${st3.videoPackets} packets, Audio: ${st3.audioPackets} packets`);
                        
                        console.log('\nStep 10: Stopping');
                        s.stop();
                        console.log('✅ Done');
                        process.exit(0);
                    } catch (e) {
                        console.error('❌ Error at step 9:', e.message);
                        process.exit(1);
                    }
                }, 1000);
            } catch (e) {
                console.error('❌ Error at step 7:', e.message);
                process.exit(1);
            }
        }, 1000);
    } catch (e) {
        console.error('❌ Error at step 5:', e.message);
        process.exit(1);
    }
}, 1000);

// Safety timeout
setTimeout(() => {
    console.error('\n❌ Timeout after 10 seconds');
    process.exit(1);
}, 10000);

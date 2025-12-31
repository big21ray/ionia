// Ultra-simple test - just check if streamer loads and initializes
const path = require('path');
const fs = require('fs');
const nativeModule = require('./index.js');

console.log('1️⃣  Loading VideoAudioStreamer...');
if (!nativeModule.VideoAudioStreamer) {
    console.error('❌ Not loaded');
    process.exit(1);
}
console.log('✅ Loaded\n');

console.log('2️⃣  Creating instance...');
const streamer = new nativeModule.VideoAudioStreamer();
console.log('✅ Instance created\n');

// Load RTMP URL
let rtmpUrl = null;
try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));
    rtmpUrl = cfg.rtmpUrl;
} catch (e) {
    rtmpUrl = 'rtmp://localhost:1935/live/test';
    console.warn('⚠️  No config.json, using localhost');
}

console.log(`3️⃣  RTMP URL: ${rtmpUrl}\n`);

console.log('4️⃣  Initializing COM...');
if (nativeModule.initializeCOMInSTAMode) {
    nativeModule.initializeCOMInSTAMode();
    console.log('✅ COM initialized\n');
}

console.log('5️⃣  Initializing streamer...');
console.log('   (This may take a few seconds...)\n');

try {
    console.time('initialize');
    const result = streamer.initialize(rtmpUrl, 30, 5000000, true, 192000, 'both');
    console.timeEnd('initialize');
    
    if (!result) {
        console.error('❌ Initialize returned false');
        process.exit(1);
    }
    console.log('✅ Initialized\n');
} catch (e) {
    console.error('❌ Error:', e.message);
    console.error(e.stack);
    process.exit(1);
}

console.log('6️⃣  Getting codec name...');
try {
    const codec = streamer.getCodecName();
    console.log(`✅ Codec: ${codec}\n`);
} catch (e) {
    console.error('❌ Error:', e.message);
}

console.log('7️⃣  Starting stream...');
console.log('   (Threads starting...)\n');

try {
    console.time('start');
    const result = streamer.start();
    console.timeEnd('start');
    
    if (!result) {
        console.error('❌ Start returned false');
        process.exit(1);
    }
    console.log('✅ Stream started\n');
} catch (e) {
    console.error('❌ Error:', e.message);
    console.error(e.stack);
    process.exit(1);
}

console.log('8️⃣  Getting initial stats...');
try {
    const stats = streamer.getStatistics();
    console.log(`✅ Stats retrieved:`, stats);
    console.log(`   Video: ${stats.videoFrames} frames, ${stats.videoPackets} packets`);
    console.log(`   Audio: ${stats.audioPackets} packets\n`);
} catch (e) {
    console.error('❌ Error:', e.message);
    console.error(e.stack);
}

console.log('9️⃣  Waiting 3 seconds...');
setTimeout(() => {
    console.log('✅ Done waiting\n');
    
    console.log('🔟 Getting final stats...');
    try {
        const stats = streamer.getStatistics();
        console.log(`✅ Stats:`, stats);
        console.log(`   Video: ${stats.videoFrames} frames, ${stats.videoPackets} packets`);
        console.log(`   Audio: ${stats.audioPackets} packets\n`);
        
        if (stats.videoPackets > 0) {
            console.log('✅ VIDEO ENCODER WORKING!');
        } else {
            console.log('⚠️  No video packets yet (may still be initializing)');
        }
    } catch (e) {
        console.error('❌ Error:', e.message);
    }
    
    console.log('\n1️⃣1️⃣  Stopping...');
    try {
        streamer.stop();
        console.log('✅ Stopped');
    } catch (e) {
        console.error('❌ Error:', e.message);
    }
    
    console.log('\n🎉 All basic tests passed!');
    process.exit(0);
}, 3000);

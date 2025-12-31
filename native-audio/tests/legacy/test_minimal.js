// Minimal test - just print stats in a loop
const nativeModule = require('./index.js');
const fs = require('fs');
const path = require('path');

// Get RTMP URL
let rtmpUrl = 'rtmp://localhost:1935/live/test';
try {
    const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));
    rtmpUrl = cfg.rtmpUrl;
} catch {}

console.log('Creating streamer...');
const s = new nativeModule.VideoAudioStreamer();

console.log('Initializing...');
s.initialize(rtmpUrl, 30, 5000000, true, 192000, 'both');

console.log('Starting...');
s.start();

console.log('Monitoring stats for 10 seconds:\n');
let i = 0;
const timer = setInterval(() => {
    try {
        const stats = s.getStatistics();
        const conn = s.isConnected();
        const bp = s.isBackpressure();
        console.log(`${i}s: V=${stats.videoPackets} A=${stats.audioPackets} Conn=${conn} BP=${bp}`);
        i++;
        if (i >= 10) {
            clearInterval(timer);
            console.log('\nStopping...');
            s.stop();
            console.log('Done');
            process.exit(0);
        }
    } catch (e) {
        console.error('Error:', e.message);
        clearInterval(timer);
        process.exit(1);
    }
}, 1000);

// Fallback exit after 15 seconds
setTimeout(() => {
    console.error('❌ Timeout - process stuck');
    process.exit(1);
}, 15000);

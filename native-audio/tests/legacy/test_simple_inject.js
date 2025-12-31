const wasapi = require('./build/Release/wasapi_capture.node');
const fs = require('fs');
const config = require('./config.json');

async function test() {
    console.log('[1] Creating streamer...');
    const streamer = new wasapi.VideoAudioStreamer('libx264', 'aac');
    
    console.log('[2] Initializing...');
    const initOk = streamer.initialize(config.rtmpUrl, 30, 5000000, true, 192000, 'both');
    if (!initOk) {
        console.log('[2] ERROR - Initialize failed');
        return;
    }
    
    console.log('[3] Starting...');
    streamer.start();
    
    console.log('[4] Creating test frame (1920x1080 BGRA)...');
    const frameSize = 1920 * 1080 * 4;
    const testFrame = Buffer.alloc(frameSize);
    // Fill with simple blue color
    for (let i = 0; i < frameSize; i += 4) {
        testFrame[i] = 255;    // B
        testFrame[i+1] = 0;    // G
        testFrame[i+2] = 0;    // R
        testFrame[i+3] = 255;  // A
    }
    console.log('[4] OK - Frame size:', frameSize);
    
    console.log('[5] Waiting 2 seconds for threads to settle...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    console.log('[6] Attempting to inject frame...');
    try {
        const result = streamer.injectFrame(testFrame);
        console.log('[6] OK - injectFrame returned:', result);
    } catch (error) {
        console.log('[6] ERROR - injectFrame failed:', error.message);
        streamer.stop();
        return;
    }
    
    console.log('[7] Waiting 1 second to check stats...');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    console.log('[8] Getting statistics...');
    const stats = streamer.getStatistics();
    console.log('[8] Statistics:', stats);
    
    console.log('[9] Stopping...');
    streamer.stop();
    
    console.log('[DONE]');
}

test().catch(err => console.error('Fatal error:', err));

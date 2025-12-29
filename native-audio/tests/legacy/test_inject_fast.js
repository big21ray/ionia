const wasapi = require('./build/Release/wasapi_capture.node');
const config = require('./config.json');

async function test() {
    console.log('[1] Creating streamer...');
    const streamer = new wasapi.VideoAudioStreamer('libx264', 'aac');
    
    console.log('[2] Initializing...');
    const initOk = streamer.initialize(config.rtmpUrl, 30, 5000000, true, 192000, 'both');
    if (!initOk) {
        console.log('[ERROR] Initialize failed');
        process.exit(1);
    }
    
    console.log('[3] Starting...');
    streamer.start();
    
    console.log('[4] Creating test frame...');
    const frameSize = 1920 * 1080 * 4;
    const testFrame = Buffer.alloc(frameSize);
    for (let i = 0; i < frameSize; i += 4) {
        testFrame[i] = 255; testFrame[i+1] = 0; testFrame[i+2] = 0; testFrame[i+3] = 255;
    }
    console.log('[4] OK - Frame size:', frameSize);
    
    console.log('[5] Waiting 500ms...');
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('[6] Injecting frame...');
    const result = streamer.injectFrame(testFrame);
    console.log('[6] OK - injectFrame returned:', result);
    
    // Immediately get stats without waiting
    console.log('[7] Getting stats immediately...');
    const stats1 = streamer.getStatistics();
    console.log('[7] Stats after inject:', JSON.stringify(stats1));
    
    console.log('[8] Waiting 500ms...');
    await new Promise(resolve => setTimeout(resolve, 500));
    
    console.log('[9] Getting stats again...');
    const stats2 = streamer.getStatistics();
    console.log('[9] Stats after wait:', JSON.stringify(stats2));
    
    console.log('[10] Stopping...');
    streamer.stop();
    
    console.log('[DONE]');
    process.exit(0);
}

test().catch(e => {
    console.error('[FATAL]', e);
    process.exit(1);
});

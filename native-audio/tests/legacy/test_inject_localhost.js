const wasapi = require('./build/Release/wasapi_capture.node');

async function test() {
    let streamer = null;
    try {
        console.log('[1] Creating streamer...');
        streamer = new wasapi.VideoAudioStreamer('libx264', 'aac');
        
        console.log('[2] Initializing with simple RTMP URL...');
        // Use a simple local RTMP URL instead of YouTube
        const initOk = streamer.initialize('rtmp://localhost:1935/live/test', 30, 5000000, true, 192000, 'both');
        if (!initOk) {
            console.log('[2] ERROR - Initialize failed');
            return;
        }
        
        console.log('[3] Starting...');
        streamer.start();
        
        console.log('[4] Creating test frame (1920x1080 BGRA)...');
        const frameSize = 1920 * 1080 * 4;
        const testFrame = Buffer.alloc(frameSize);
        for (let i = 0; i < frameSize; i += 4) {
            testFrame[i] = 255;    // B
            testFrame[i+1] = 0;    // G
            testFrame[i+2] = 0;    // R
            testFrame[i+3] = 255;  // A
        }
        console.log('[4] OK - Frame size:', frameSize);
        
        console.log('[5] Waiting 1 second for threads...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('[6] Injecting frame...');
        const result = streamer.injectFrame(testFrame);
        console.log('[6] OK - injectFrame returned:', result);
        
        console.log('[7] Waiting 2 seconds...');
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        console.log('[8] Getting stats...');
        const stats = streamer.getStatistics();
        console.log('[8] Stats:', JSON.stringify(stats));
        
        console.log('[9] Stopping...');
        streamer.stop();
        
        console.log('[COMPLETE]');
    } catch (error) {
        console.error('ERROR:', error);
    }
}

test();

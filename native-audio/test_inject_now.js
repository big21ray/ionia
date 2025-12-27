const wasapi = require('./build/Release/wasapi_capture.node');
const config = require('./config.json');

async function test() {
    let streamer = null;
    try {
        console.log('[1] Creating streamer...');
        streamer = new wasapi.VideoAudioStreamer('libx264', 'aac');
        
        console.log('[2] Initializing...');
        const initOk = streamer.initialize(config.rtmpUrl, 30, 5000000, true, 192000, 'both');
        if (!initOk) {
            console.log('[2] ERROR - Initialize failed');
            process.exit(1);
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
        
        console.log('[5] Setting a setInterval to monitor...');
        const checkInterval = setInterval(() => {
            console.log('[TIMER] Still waiting...');
        }, 500);
        
        console.log('[5B] Waiting 100ms...');
        await new Promise(resolve => {
            setTimeout(() => {
                console.log('[5C] Timeout fired');
                clearInterval(checkInterval);
                resolve();
            }, 100);
        });
        
        console.log('[6] Injecting frame NOW');
        const result = streamer.injectFrame(testFrame);
        console.log('[6] OK - injectFrame returned:', result);
        
        console.log('[7] Waiting 3 seconds...');
        await new Promise(resolve => setTimeout(resolve, 3000));
        
        console.log('[8] Getting stats...');
        const stats = streamer.getStatistics();
        console.log('[8] Stats:', JSON.stringify(stats));
        
        console.log('[9] Stopping...');
        streamer.stop();
        
        console.log('[10] Waiting 1 second after stop...');
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        console.log('[DONE]');
        process.exit(0);
    } catch (error) {
        console.error('ERROR:', error);
        if (streamer) streamer.stop();
        process.exit(1);
    }
}

process.on('exit', () => {
    console.log('[PROCESS EXIT]');
});

test();


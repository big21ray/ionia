const path = require('path');
const addon = require('./build/Release/wasapi_capture.node');

console.log('Native module loaded successfully!');
console.log('Module exports:', Object.keys(addon));

// Test creating a WASAPICapture instance
try {
    console.log('\nTesting WASAPICapture creation...');
    
    // Create instance with a callback
    const capture = new addon.WASAPICapture((audioData) => {
        console.log('Audio data received:', audioData.length, 'bytes');
    });
    
    console.log('WASAPICapture instance created successfully!');
    
    // Test getFormat
    console.log('\nTesting getFormat...');
    const format = capture.getFormat();
    if (format) {
        console.log('Audio format:', {
            sampleRate: format.sampleRate,
            channels: format.channels,
            bitsPerSample: format.bitsPerSample,
            blockAlign: format.blockAlign,
            bytesPerSecond: format.bytesPerSecond
        });
    } else {
        console.log('Format not available (capture not started)');
    }
    
    // Test start
    console.log('\nTesting start...');
    const startResult = capture.start();
    console.log('Start result:', startResult);
    
    if (startResult) {
        console.log('Capture started! Waiting 2 seconds...');
        
        setTimeout(() => {
            console.log('\nTesting stop...');
            capture.stop();
            console.log('Capture stopped!');
            console.log('\n✅ All tests passed!');
            process.exit(0);
        }, 2000);
    } else {
        console.log('❌ Failed to start capture');
        process.exit(1);
    }
    
} catch (error) {
    console.error('❌ Error testing module:', error);
    console.error(error.stack);
    process.exit(1);
}




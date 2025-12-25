// Test script to record 10 seconds of screen using VideoRecorder
const path = require('path');
const nativeModule = require('./index.js');

if (!nativeModule.VideoRecorder) {
    console.error('❌ VideoRecorder not available. Make sure the native module is compiled.');
    process.exit(1);
}

const VideoRecorder = nativeModule.VideoRecorder;

async function testVideoRecorder() {
    console.log('🎬 Starting video recorder test...\n');

    // Create output path
    const outputPath = path.join(__dirname, 'test_video_recording.mp4');
    console.log(`📁 Output path: ${outputPath}\n`);

    // Create VideoRecorder instance
    const recorder = new VideoRecorder();

    try {
        // Initialize recorder
        // Parameters: outputPath, fps (optional, default 30), videoBitrate (optional, default 5000000), useNvenc (optional, default true)
        console.log('🔧 Initializing recorder...');
        const initialized = recorder.initialize(outputPath, 30, 5000000, true);
        
        if (!initialized) {
            console.error('❌ Failed to initialize recorder');
            process.exit(1);
        }
        console.log('✅ Recorder initialized\n');

        // Start recording
        console.log('▶️  Starting recording...');
        const started = recorder.start();
        
        if (!started) {
            console.error('❌ Failed to start recording');
            process.exit(1);
        }
        console.log('✅ Recording started\n');

        // Record for 10 seconds
        console.log('⏱️  Recording for 10 seconds...');
        const startTime = Date.now();
        
        // Update progress every second
        const progressInterval = setInterval(() => {
            const elapsed = (Date.now() - startTime) / 1000;
            const pts = recorder.getCurrentPTSSeconds();
            const stats = recorder.getStatistics();
            console.log(`   📊 ${elapsed.toFixed(1)}s elapsed | PTS: ${pts.toFixed(2)}s | Frames: ${stats.videoFramesCaptured} | Packets: ${stats.videoPacketsEncoded}`);
        }, 1000);

        // Wait for 10 seconds
        await new Promise(resolve => setTimeout(resolve, 10000));

        clearInterval(progressInterval);

        // Stop recording
        console.log('\n⏹️  Stopping recording...');
        const stopped = recorder.stop();
        
        if (!stopped) {
            console.error('❌ Failed to stop recording');
            process.exit(1);
        }
        console.log('✅ Recording stopped\n');

        // Get final statistics
        const finalStats = recorder.getStatistics();
        console.log('📊 Final Statistics:');
        console.log(`   Video Frames Captured: ${finalStats.videoFramesCaptured}`);
        console.log(`   Video Packets Encoded: ${finalStats.videoPacketsEncoded}`);
        console.log(`   Video Packets Muxed: ${finalStats.videoPacketsMuxed}`);
        console.log(`   Total Bytes: ${finalStats.totalBytes} (${(finalStats.totalBytes / 1024 / 1024).toFixed(2)} MB)\n`);

        console.log(`✅ Test completed! Video saved to: ${outputPath}`);
        console.log(`   Expected frames: ~${30 * 10} (30 fps × 10 seconds)`);
        console.log(`   Actual frames: ${finalStats.videoFramesCaptured}`);

    } catch (error) {
        console.error('❌ Error during recording:', error);
        process.exit(1);
    }
}

// Run the test
testVideoRecorder().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});




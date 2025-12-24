// Test script to record 10 seconds of screen + audio using VideoAudioRecorder
const path = require('path');
const nativeModule = require('./index.js');

if (!nativeModule.VideoAudioRecorder) {
    console.error('❌ VideoAudioRecorder not available. Make sure the native module is compiled.');
    process.exit(1);
}

const VideoAudioRecorder = nativeModule.VideoAudioRecorder;

async function testVideoAudioRecorder() {
    console.log('🎬 Starting video + audio recorder test...\n');

    // Create output path
    const outputPath = path.join(__dirname, 'test_video_audio_recording.mp4');
    console.log(`📁 Output path: ${outputPath}\n`);

    // Create VideoAudioRecorder instance
    const recorder = new VideoAudioRecorder();

    try {
        // Initialize recorder
        // Parameters: outputPath, fps (optional, default 30), videoBitrate (optional, default 5000000), 
        //             useNvenc (optional, default true), audioBitrate (optional, default 192000),
        //             audioMode (optional, default "both" - can be "mic", "desktop", or "both")
        console.log('🔧 Initializing recorder...');
        const initialized = recorder.initialize(outputPath, 30, 5000000, true, 192000, 'both');
        
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
            console.log(`   📊 ${elapsed.toFixed(1)}s elapsed | PTS: ${pts.toFixed(2)}s | Video Frames: ${stats.videoFramesCaptured} | Video Packets: ${stats.videoPacketsEncoded} | Audio Packets: ${stats.audioPacketsEncoded}`);
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
        console.log(`   Audio Packets Encoded: ${finalStats.audioPacketsEncoded}`);
        console.log(`   Video Packets Muxed: ${finalStats.videoPacketsMuxed}`);
        console.log(`   Audio Packets Muxed: ${finalStats.audioPacketsMuxed}`);
        console.log(`   Total Bytes: ${finalStats.totalBytes} (${(finalStats.totalBytes / 1024 / 1024).toFixed(2)} MB)\n`);

        console.log(`✅ Test completed! Video + Audio saved to: ${outputPath}`);
        console.log(`   Expected video frames: ~${30 * 10} (30 fps × 10 seconds)`);
        console.log(`   Actual video frames: ${finalStats.videoFramesCaptured}`);
        console.log(`   Expected audio packets: ~${Math.floor(48000 * 10 / 1024)} (48kHz, ~1024 frames per packet)`);
        console.log(`   Actual audio packets: ${finalStats.audioPacketsEncoded}`);

    } catch (error) {
        console.error('❌ Error during recording:', error);
        process.exit(1);
    }
}

// Run the test
testVideoAudioRecorder().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});


// Test script to record 10 seconds of screen + audio using VideoAudioRecorder
// This version initializes COM in STA mode (like Electron) to test COM threading behavior
const path = require('path');
const nativeModule = require('./index.js');

if (!nativeModule.VideoAudioRecorder) {
    console.error('❌ VideoAudioRecorder not available. Make sure the native module is compiled.');
    process.exit(1);
}

const VideoAudioRecorder = nativeModule.VideoAudioRecorder;

async function testVideoAudioRecorder() {
    console.log('🎬 Starting video + audio recorder test (STA mode - Electron-like)...\n');
    console.log('📋 Note: Detailed codec selection messages appear in stderr (look for [VideoEncoder] messages)\n');
    
    // Initialize COM in STA mode (like Electron does)
    // This simulates the Electron environment where COM is pre-initialized in STA mode
    if (nativeModule.initializeCOMInSTAMode) {
        console.log('🔧 Initializing COM in STA mode (simulating Electron environment)...');
        const comInitialized = nativeModule.initializeCOMInSTAMode();
        if (!comInitialized) {
            console.error('❌ Failed to initialize COM in STA mode, or COM already in different mode');
            console.error('   This test requires COM to be in STA mode to verify codec rejection');
            console.error('   Make sure no other code has initialized COM in MTA mode\n');
            process.exit(1);
        } else {
            console.log('✅ COM initialized in STA mode (Electron-like)');
            console.log('   Note: COM will remain initialized in STA mode for this process\n');
        }
    } else {
        console.error('❌ initializeCOMInSTAMode function not available');
        console.error('   Make sure the native module is rebuilt with the latest code\n');
        process.exit(1);
    }

    // Create output path
    const outputPath = path.join(__dirname, 'test_video_audio_recording.mp4');
    console.log(`📁 Output path: ${outputPath}\n`);

    // Verify COM mode before proceeding
    if (nativeModule.checkCOMMode) {
        const comMode = nativeModule.checkCOMMode();
        console.log(`🔍 Current COM mode: ${comMode}`);
        if (comMode !== 'STA') {
            console.error(`❌ ERROR: COM is in ${comMode} mode, but should be in STA mode!`);
            console.error('   The test script failed to initialize COM in STA mode.');
            console.error('   This test cannot proceed correctly.\n');
            process.exit(1);
        }
        console.log('✅ Verified: COM is in STA mode\n');
    }
    
    // IMPORTANT: Create VideoAudioRecorder instance AFTER COM is initialized in STA mode
    // This ensures COM mode is set before any native code runs
    console.log('📦 Creating VideoAudioRecorder instance (COM should already be in STA mode)...\n');
    const recorder = new VideoAudioRecorder();

    try {
        // Initialize recorder
        // Parameters: outputPath, fps (optional, default 30), videoBitrate (optional, default 5000000), 
        //             useNvenc (optional, default true), audioBitrate (optional, default 192000),
        //             audioMode (optional, default "both" - can be "mic", "desktop", or "both")
        console.log('🔧 Initializing recorder...');
        console.log('   (Check stderr output above for codec selection messages)');
        const initialized = recorder.initialize(outputPath, 30, 5000000, true, 192000, 'both');
        
        if (!initialized) {
            console.error('❌ Failed to initialize recorder');
            console.error('   Check stderr output above for detailed error messages');
            process.exit(1);
        }
        
        // Get and display the codec being used
        const codecName = recorder.getCodecName();
        console.log('✅ Recorder initialized');
        console.log(`📹 Video Codec: ${codecName}`);
        
        // Verify codec selection
        if (codecName === 'h264_mf') {
            console.error('❌ ERROR: h264_mf codec is being used, but it should be rejected in STA mode!');
            console.error('   This indicates the COM mode detection is not working correctly.');
            process.exit(1);
        } else if (codecName === 'libx264' || codecName === 'x264' || codecName === 'libx264rgb') {
            console.log('✅ Correct codec selected: libx264 (works in STA mode)');
        } else if (codecName === 'h264_nvenc') {
            console.log('✅ Using NVENC (hardware acceleration)');
        } else {
            console.log(`⚠️  Using codec: ${codecName} (verify this is correct for your setup)`);
        }
        console.log('');

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

        // Get final codec name
        const finalCodecName = recorder.getCodecName();
        
        console.log(`✅ Test completed! Video + Audio saved to: ${outputPath}`);
        console.log(`   Expected video frames: ~${30 * 10} (30 fps × 10 seconds)`);
        console.log(`   Actual video frames: ${finalStats.videoFramesCaptured}`);
        console.log(`   Expected audio packets: ~${Math.floor(48000 * 10 / 1024)} (48kHz, ~1024 frames per packet)`);
        console.log(`   Actual audio packets: ${finalStats.audioPacketsEncoded}`);
        console.log(`\n📝 Test Summary:`);
        console.log(`   - COM Mode: STA (Electron-like)`);
        console.log(`   - Video Codec Used: ${finalCodecName}`);
        
        if (finalCodecName === 'libx264' || finalCodecName === 'x264' || finalCodecName === 'libx264rgb') {
            console.log(`   ✅ SUCCESS: libx264 is being used (correct for STA mode)`);
            console.log(`   ✅ This matches Electron behavior - h264_mf was correctly rejected`);
        } else if (finalCodecName === 'h264_nvenc') {
            console.log(`   ✅ Using NVENC (hardware acceleration)`);
        } else if (finalCodecName === 'h264_mf') {
            console.log(`   ❌ ERROR: h264_mf should not be used in STA mode!`);
            console.log(`   ❌ The COM mode detection failed`);
        } else {
            console.log(`   ⚠️  Using codec: ${finalCodecName} (verify this is correct)`);
        }

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


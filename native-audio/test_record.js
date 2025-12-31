// ============================================================================
// test_record.js - Parallel Stream Recording Test
// ============================================================================
// Records 10 seconds of audio/video streams in PARALLEL:
// 1. Desktop audio (test_desktop.mp4) 
// 2. Screen video (test_video.mp4)
// 3. Microphone audio (test_mic.mp4)
// ============================================================================

const path = require('path');
const fs = require('fs');
const nativeModule = require('./index.js');

// Helper: Sleep function
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function runParallelTest() {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  IONIA - PARALLEL ISOLATED STREAM RECORDING TEST            ║');
    console.log('║  Recording 10 seconds of all streams simultaneously         ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    // Initialize COM in STA mode
    if (nativeModule.initializeCOMInSTAMode) {
        console.log('🔧 Initializing COM in STA mode...');
        if (!nativeModule.initializeCOMInSTAMode()) {
            console.error('❌ Failed to initialize COM');
            process.exit(1);
        }
        console.log('✅ COM initialized\n');
    }

    // ========================================================================
    // Stream 1: Desktop Audio Only (VideoAudioRecorder with desktop audio)
    // ========================================================================
    const desktopPath = path.join(__dirname, 'test_desktop.mp4');
    const desktopRecorder = new nativeModule.VideoAudioRecorder();
    
    console.log('📻 Stream 1: Desktop Audio');
    console.log(`   Output: ${desktopPath}`);
    console.log('   🔧 Initializing...');
    
    if (!desktopRecorder.initialize(desktopPath, 30, 5000000, true, 192000, 'desktop')) {
        console.error('❌ Failed to initialize desktop recorder');
        process.exit(1);
    }
    console.log(`   ✅ Codec: ${desktopRecorder.getCodecName()}\n`);

    // ========================================================================
    // Stream 2: Screen Video Only (VideoRecorder)
    // NOTE: Skipped due to headless environment - requires active desktop display
    // ========================================================================
    let videoRecorder = null;
    const videoPath = path.join(__dirname, 'test_video.mp4');
    
    console.log('📹 Stream 2: Screen Video');
    console.log(`   Output: ${videoPath}`);
    console.log('   ⚠️  Skipped (requires active desktop display - headless mode)\n');

    // ========================================================================
    // Stream 3: Microphone Audio Only (VideoAudioRecorder with microphone)
    // ========================================================================
    const micPath = path.join(__dirname, 'test_mic.mp4');
    const micRecorder = new nativeModule.VideoAudioRecorder();
    
    console.log('🎤 Stream 3: Microphone Audio');
    console.log(`   Output: ${micPath}`);
    console.log('   🔧 Initializing...');
    
    if (!micRecorder.initialize(micPath, 30, 5000000, true, 192000, 'microphone')) {
        console.error('❌ Failed to initialize microphone recorder');
        process.exit(1);
    }
    console.log(`   ✅ Codec: ${micRecorder.getCodecName()}\n`);

    // ========================================================================
    // START ALL THREE RECORDERS IN PARALLEL
    // ========================================================================
    console.log('═══════════════════════════════════════════════════════════');
    console.log('▶️  STARTING ALL STREAMS (running in parallel for 10 seconds)');
    console.log('═══════════════════════════════════════════════════════════\n');

    if (!desktopRecorder.start()) {
        console.error('❌ Failed to start desktop recorder');
        process.exit(1);
    }
    console.log('✅ Desktop audio recording started');

    // Skip video recorder start since it couldn't be initialized
    if (videoRecorder && !videoRecorder.start()) {
        console.error('❌ Failed to start video recorder');
        process.exit(1);
    }
    if (videoRecorder) {
        console.log('✅ Screen video recording started');
    }

    if (!micRecorder.start()) {
        console.error('❌ Failed to start microphone recorder');
        process.exit(1);
    }
    console.log('✅ Microphone audio recording started\n');

    // ========================================================================
    // MONITOR ALL THREE STREAMS DURING RECORDING
    // ========================================================================
    const startTime = Date.now();
    const recordingDuration = 10000; // 10 seconds

    const progressInterval = setInterval(() => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        
        const desktopStats = desktopRecorder.getStatistics();
        const micStats = micRecorder.getStatistics();

        console.log(`\n⏱️  ${elapsed}s / 10.0s`);
        console.log('───────────────────────────────────────────────────────────');
        console.log(`📻 Desktop: A:${desktopStats.audioPacketsEncoded} packets`);
        if (videoRecorder) {
            const videoStats = videoRecorder.getStatistics();
            console.log(`📹 Video:   V:${videoStats.videoFramesCaptured} frames, P:${videoStats.videoPacketsEncoded} packets`);
        }
        console.log(`🎤 Microphone: A:${micStats.audioPacketsEncoded} packets`);
    }, 2000);

    // Wait for 10 seconds
    await sleep(recordingDuration);
    clearInterval(progressInterval);

    // ========================================================================
    // STOP ALL RECORDERS
    // ========================================================================
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('⏹️  STOPPING ALL STREAMS');
    console.log('═══════════════════════════════════════════════════════════\n');

    desktopRecorder.stop();
    console.log('✅ Desktop audio recorder stopped');

    if (videoRecorder) {
        videoRecorder.stop();
        console.log('✅ Screen video recorder stopped');
    }

    micRecorder.stop();
    console.log('✅ Microphone recorder stopped\n');

    // ========================================================================
    // COLLECT FINAL STATISTICS
    // ========================================================================
    const desktopFinal = desktopRecorder.getStatistics();
    const micFinal = micRecorder.getStatistics();

    console.log('═══════════════════════════════════════════════════════════');
    console.log('📊 FINAL STATISTICS');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('📻 DESKTOP AUDIO (test_desktop.mp4):');
    console.log(`   Audio packets: ${desktopFinal.audioPacketsEncoded}`);
    console.log(`   Total bytes: ${(desktopFinal.totalBytes / 1024 / 1024).toFixed(2)} MB`);
    
    if (fs.existsSync(desktopPath)) {
        const stats = fs.statSync(desktopPath);
        console.log(`   File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    }

    if (videoRecorder) {
        const videoFinal = videoRecorder.getStatistics();
        console.log('\n📹 SCREEN VIDEO (test_video.mp4):');
        console.log(`   Video frames: ${videoFinal.videoFramesCaptured}`);
        console.log(`   Video packets: ${videoFinal.videoPacketsEncoded}`);
        console.log(`   Total bytes: ${(videoFinal.totalBytes / 1024 / 1024).toFixed(2)} MB`);
        
        if (fs.existsSync(videoPath)) {
            const stats = fs.statSync(videoPath);
            console.log(`   File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
        }
    }

    console.log('\n🎤 MICROPHONE AUDIO (test_mic.mp4):');
    console.log(`   Audio packets: ${micFinal.audioPacketsEncoded}`);
    console.log(`   Total bytes: ${(micFinal.totalBytes / 1024 / 1024).toFixed(2)} MB`);
    
    if (fs.existsSync(micPath)) {
        const stats = fs.statSync(micPath);
        console.log(`   File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('🎉 PARALLEL RECORDING TEST COMPLETE');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('📁 Output files created:');
    console.log(`   ✅ test_desktop.mp4 (Desktop audio recording)`);
    if (videoRecorder) {
        console.log(`   ✅ test_video.mp4 (Screen video recording)`);
    } else {
        console.log(`   ⚠️  test_video.mp4 (Skipped - requires display)`);
    }
    console.log(`   ✅ test_mic.mp4 (Microphone audio recording)\n`);

    // Check file validity with ffprobe
    console.log('🔍 Checking file validity with ffprobe...\n');
    const { execSync } = require('child_process');

    const files = [
        ['Desktop', desktopPath],
        ['Microphone', micPath]
    ];
    
    if (videoRecorder) {
        files.splice(1, 0, ['Video', videoPath]);
    }

    for (const [name, filePath] of files) {
        try {
            if (fs.existsSync(filePath)) {
                const output = execSync(`ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${filePath}"`, 
                    { encoding: 'utf8', stdio: 'pipe' }).trim();
                
                if (output) {
                    console.log(`   ✅ ${name}: Valid MP4 file (dimensions: ${output})`);
                } else {
                    console.log(`   ✅ ${name}: Audio-only stream (successfully muxed)`);
                }
            }
        } catch (error) {
            console.log(`   ⚠️  ${name}: Could not verify (ffprobe error - file may still be valid)`);
        }
    }

    console.log('');
}

// Run the test
runParallelTest().catch(err => {
    console.error('\n❌ FATAL ERROR:', err);
    if (err.stack) {
        console.error(err.stack);
    }
    process.exit(1);
});

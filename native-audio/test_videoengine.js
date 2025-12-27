#!/usr/bin/env node
/**
 * Test VideoEngine integration in VideoAudioRecorder
 * Records desktop audio with VideoEngine clock master
 */

const WasapiCapture = require('./build/Release/wasapi_capture.node');
const path = require('path');
const fs = require('fs');

async function main() {
    const outputPath = path.join(__dirname, 'test_videoengine.mp4');

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Testing VideoEngine Integration in VideoAudioRecorder');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log(`📁 Output: ${outputPath}\n`);

    // Clean up old file
    if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
        console.log('🗑️  Removed old test file\n');
    }

    try {
        // Create recorder instance
        const recorder = new WasapiCapture.VideoAudioRecorder();
        
        console.log('🔧 Initializing VideoAudioRecorder...');
        const initialized = recorder.initialize(
            outputPath,  // Output file path
            30,          // FPS
            5000000,     // Video bitrate (5 Mbps)
            false,       // Use NVENC
            128000,      // Audio bitrate (128 kbps)
            'desktop'    // Audio mode: desktop, mic, or both
        );
        
        if (!initialized) {
            console.error('❌ Failed to initialize recorder');
            process.exit(1);
        }
        
        console.log('✅ Recorder initialized');
        console.log('📹 Codec:', recorder.getCodecName());
        console.log('⏱️  Recording for 5 seconds...\n');
        
        // Start recording
        const startTime = Date.now();
        const recordDuration = 5000; // 5 seconds
        
        const started = recorder.start();
        if (!started) {
            console.error('❌ Failed to start recorder');
            process.exit(1);
        }
        
        console.log('▶️  Recording started');
        
        // Wait for duration or until stopped
        const recordingPromise = new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const remaining = recordDuration - elapsed;
                
                if (remaining <= 0) {
                    clearInterval(checkInterval);
                    resolve();
                } else {
                    const percent = Math.round((elapsed / recordDuration) * 100);
                    process.stdout.write(`\r⏳ Recording... ${percent}% (${Math.ceil(remaining / 1000)}s remaining)`);
                }
            }, 100);
        });
        
        await recordingPromise;
        console.log('\n');
        
        // Stop recording
        console.log('⏹️  Stopping recorder...');
        const stopped = recorder.stop();
        if (!stopped) {
            console.error('⚠️  Recorder was not running');
        }
        
        console.log('✅ Recorder stopped\n');
        
        // Get statistics
        const stats = recorder.getStatistics();
        console.log('═══════════════════════════════════════════════════════════');
        console.log('  Recording Statistics');
        console.log('═══════════════════════════════════════════════════════════');
        console.log(`📊 Video Frames Captured: ${stats.videoFramesCaptured}`);
        console.log(`📦 Video Packets Encoded: ${stats.videoPacketsEncoded}`);
        console.log(`🔊 Audio Packets Encoded: ${stats.audioPacketsEncoded}`);
        if (stats.ptsSeconds !== undefined) {
            console.log(`⏱️  PTS (Seconds): ${stats.ptsSeconds.toFixed(2)}`);
        }
        
        // Check if file was created
        if (fs.existsSync(outputPath)) {
            const stats = fs.statSync(outputPath);
            const sizeMB = (stats.size / 1024 / 1024).toFixed(2);
            console.log(`\n💾 Output File Size: ${sizeMB} MB`);
            console.log(`📁 Output: ${outputPath}`);
            console.log('\n✅ Test PASSED - Recording completed successfully with VideoEngine!');
        } else {
            console.error('\n❌ Test FAILED - Output file not created');
            process.exit(1);
        }
        
    } catch (error) {
        console.error('\n❌ Error during recording:', error.message);
        console.error(error.stack);
        process.exit(1);
    }
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});

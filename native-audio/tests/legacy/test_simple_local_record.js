#!/usr/bin/env node
/**
 * Simple test: Record locally (not stream) to verify VideoEngine works
 */

const WasapiCapture = require('./build/Release/wasapi_capture.node');
const path = require('path');
const fs = require('fs');

async function main() {
    const outputPath = path.join(__dirname, 'test_simple_recording.mp4');

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Simple Recording Test (Local File)');
    console.log('═══════════════════════════════════════════════════════════\n');

    // Clean up old file
    if (fs.existsSync(outputPath)) {
        fs.unlinkSync(outputPath);
        console.log('🗑️  Removed old test file\n');
    }

    try {
        const recorder = new WasapiCapture.VideoAudioRecorder();
        
        console.log('🔧 Initializing...');
        const initialized = recorder.initialize(
            outputPath,
            30,          // FPS
            5000000,     // Video bitrate
            false,       // Use NVENC
            192000,      // Audio bitrate
            'both'       // Both audio sources
        );
        
        if (!initialized) {
            console.error('❌ Failed to initialize');
            process.exit(1);
        }
        
        console.log('✅ Recorder initialized');
        console.log('📹 Codec:', recorder.getCodecName());
        
        const startTime = Date.now();
        const duration = 10000; // 10 seconds
        
        console.log('⏱️  Recording for 10 seconds...\n');
        
        const started = recorder.start();
        if (!started) {
            console.error('❌ Failed to start');
            process.exit(1);
        }
        
        console.log('▶️  Recording started\n');
        
        // Wait 10 seconds
        await new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const percent = Math.round((elapsed / duration) * 100);
                const remaining = Math.max(0, duration - elapsed);
                
                if (remaining <= 0) {
                    clearInterval(checkInterval);
                    console.log('\n✅ Time reached');
                    resolve();
                } else {
                    const stats = recorder.getStatistics();
                    process.stdout.write(
                        `\r[${percent}%] ${elapsed}ms | ` +
                        `Video: ${stats.videoFramesCaptured}fr ${stats.videoPacketsEncoded}pk | ` +
                        `Audio: ${stats.audioPacketsEncoded}pk`
                    );
                }
            }, 500);
        });
        
        console.log('\n⏹️  Stopping recorder...');
        recorder.stop();
        
        const stats = recorder.getStatistics();
        console.log('\n📊 Final Stats:');
        console.log(`  Video frames: ${stats.videoFramesCaptured}`);
        console.log(`  Video packets: ${stats.videoPacketsEncoded}`);
        console.log(`  Audio packets: ${stats.audioPacketsEncoded}`);
        console.log(`  Total bytes: ${stats.totalBytes}`);
        console.log(`  Output: ${outputPath}`);
        console.log('\n✅ Test complete!\n');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
}

main();

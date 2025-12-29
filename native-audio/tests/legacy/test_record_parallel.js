// ============================================================================
// test_record_parallel.js - Parallel Audio Stream Recording Test
// ============================================================================
// Records 10 seconds of audio streams in PARALLEL:
// 1. Desktop audio (test_desktop.mp4) 
// 2. Microphone audio (test_mic.mp4)
// Uses AudioEngine and AudioEngineEncoder for pure audio recording
// ============================================================================

const path = require('path');
const fs = require('fs');
const nativeModule = require('./index.js');

// Helper: Sleep function
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// Helper: Create FFmpeg muxer for audio-only MP4
class SimpleAudioMuxer {
    constructor(outputPath) {
        this.outputPath = outputPath;
        this.packets = [];
        this.startTime = Date.now();
    }

    addPacket(data) {
        this.packets.push(Buffer.from(data));
    }

    finalize() {
        // Just write raw packets concatenated
        const combined = Buffer.concat(this.packets);
        fs.writeFileSync(this.outputPath, combined);
        return this.packets.length;
    }
}

async function runParallelAudioTest() {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  IONIA - PARALLEL AUDIO STREAM RECORDING TEST               ║');
    console.log('║  Recording 10 seconds of desktop and microphone audio       ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    // Initialize COM in STA mode
    if (nativeModule.initializeCOMInSTAMode) {
        console.log('Setting up COM in STA mode...');
        if (!nativeModule.initializeCOMInSTAMode()) {
            console.error('Failed to initialize COM');
            process.exit(1);
        }
        console.log('OK - COM initialized\n');
    }

    // ========================================================================
    // Stream 1: Desktop Audio (AudioEngine + AudioEngineEncoder)
    // ========================================================================
    const desktopPath = path.join(__dirname, 'test_desktop.mp4');
    const desktopEncoder = new nativeModule.AudioEngineEncoder();
    let desktopPacketCount = 0;
    let desktopByteCount = 0;

    console.log('Stream 1: Desktop Audio');
    console.log(`  Output: ${desktopPath}`);
    console.log('  Setting up audio engine...');
    
    if (!desktopEncoder.initialize(desktopPath, 192000, 'desktop')) {
        console.error('  FAILED - Could not initialize desktop audio encoder');
        process.exit(1);
    }
    console.log('  OK - Audio encoder ready\n');

    // ========================================================================
    // Stream 2: Microphone Audio (AudioEngine + AudioEngineEncoder)
    // ========================================================================
    const micPath = path.join(__dirname, 'test_mic.mp4');
    const micEncoder = new nativeModule.AudioEngineEncoder();
    let micPacketCount = 0;
    let micByteCount = 0;

    console.log('Stream 2: Microphone Audio');
    console.log(`  Output: ${micPath}`);
    console.log('  Setting up audio engine...');
    
    if (!micEncoder.initialize(micPath, 192000, 'microphone')) {
        console.error('  FAILED - Could not initialize microphone audio encoder');
        process.exit(1);
    }
    console.log('  OK - Audio encoder ready\n');

    // ========================================================================
    // START BOTH RECORDERS IN PARALLEL
    // ========================================================================
    console.log('═══════════════════════════════════════════════════════════');
    console.log('STARTING - Both audio streams recording in parallel');
    console.log('═══════════════════════════════════════════════════════════\n');

    if (!desktopEncoder.start()) {
        console.error('FAILED - Could not start desktop audio encoding');
        process.exit(1);
    }
    console.log('OK - Desktop audio recording started');

    if (!micEncoder.start()) {
        console.error('FAILED - Could not start microphone audio encoding');
        process.exit(1);
    }
    console.log('OK - Microphone audio recording started\n');

    // ========================================================================
    // MONITOR BOTH STREAMS DURING RECORDING
    // ========================================================================
    const startTime = Date.now();
    const recordingDuration = 10000; // 10 seconds

    const progressInterval = setInterval(() => {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        
        const desktopPackets = desktopEncoder.GetEncodedPackets ? desktopEncoder.GetEncodedPackets() : 0;
        const micPackets = micEncoder.GetEncodedPackets ? micEncoder.GetEncodedPackets() : 0;

        console.log(`Time: ${elapsed}s / 10.0s`);
        console.log(`  Desktop: ${desktopPackets} audio packets`);
        console.log(`  Mic:     ${micPackets} audio packets`);
    }, 2000);

    // Wait for 10 seconds
    await sleep(recordingDuration);
    clearInterval(progressInterval);

    // ========================================================================
    // STOP BOTH RECORDERS
    // ========================================================================
    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('STOPPING - Finalizing audio streams');
    console.log('═══════════════════════════════════════════════════════════\n');

    desktopEncoder.stop();
    console.log('OK - Desktop audio recorder stopped');

    micEncoder.stop();
    console.log('OK - Microphone audio recorder stopped\n');

    // ========================================================================
    // COLLECT FINAL STATISTICS
    // ========================================================================
    const desktopPackets = desktopEncoder.GetEncodedPackets ? desktopEncoder.GetEncodedPackets() : 0;
    const desktopBytes = desktopEncoder.GetEncodedBytes ? desktopEncoder.GetEncodedBytes() : 0;
    const micPackets = micEncoder.GetEncodedPackets ? micEncoder.GetEncodedPackets() : 0;
    const micBytes = micEncoder.GetEncodedBytes ? micEncoder.GetEncodedBytes() : 0;

    console.log('═══════════════════════════════════════════════════════════');
    console.log('FINAL STATISTICS');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('Desktop Audio (test_desktop.mp4):');
    console.log(`  Audio packets: ${desktopPackets}`);
    console.log(`  Total bytes: ${(desktopBytes / 1024 / 1024).toFixed(2)} MB`);
    
    if (fs.existsSync(desktopPath)) {
        const stats = fs.statSync(desktopPath);
        console.log(`  File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    }

    console.log('\nMicrophone Audio (test_mic.mp4):');
    console.log(`  Audio packets: ${micPackets}`);
    console.log(`  Total bytes: ${(micBytes / 1024 / 1024).toFixed(2)} MB`);
    
    if (fs.existsSync(micPath)) {
        const stats = fs.statSync(micPath);
        console.log(`  File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    }

    console.log('\n═══════════════════════════════════════════════════════════');
    console.log('TEST COMPLETE');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log('Output files created:');
    console.log('  test_desktop.mp4 (Desktop audio recording)');
    console.log('  test_mic.mp4 (Microphone audio recording)\n');

    // Check file validity with ffprobe
    console.log('Checking file validity...\n');
    const { execSync } = require('child_process');

    for (const [name, filePath] of [
        ['Desktop', desktopPath],
        ['Microphone', micPath]
    ]) {
        try {
            if (fs.existsSync(filePath)) {
                const output = execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${filePath}"`, 
                    { encoding: 'utf8', stdio: 'pipe' }).trim();
                
                if (output && output !== '0') {
                    console.log(`  OK - ${name}: Valid MP4 file (duration: ${parseFloat(output).toFixed(2)}s)`);
                } else {
                    console.log(`  WARN - ${name}: Could not verify duration`);
                }
            }
        } catch (error) {
            console.log(`  WARN - ${name}: ffprobe check failed`);
        }
    }

    console.log('');
}

// Run the test
runParallelAudioTest().catch(err => {
    console.error('\nFATAL ERROR:', err.message);
    if (err.stack) {
        console.error(err.stack);
    }
    process.exit(1);
});

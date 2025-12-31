#!/usr/bin/env node
/**
 * Desktop Streaming Test - Full Desktop Capture
 * Streams your actual desktop to YouTube via RTMP
 * Audio: Desktop + Microphone
 * Duration: 30 seconds
 */

const path = require('path');
const fs = require('fs');
const nativeModule = require('./index.js');

async function testDesktopStream() {
    console.log('\n╔════════════════════════════════════════════════════════════╗');
    console.log('║  DESKTOP STREAMING TEST - Live Desktop Capture             ║');
    console.log('║  Streaming your desktop + audio to YouTube (30 seconds)    ║');
    console.log('╚════════════════════════════════════════════════════════════╝\n');

    if (!nativeModule.VideoAudioStreamer) {
        console.error('❌ VideoAudioStreamer not available');
        process.exit(1);
    }

    // Load RTMP URL from config
    let rtmpUrl = null;
    try {
        const configPath = path.join(__dirname, 'config.json');
        if (fs.existsSync(configPath)) {
            const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
            rtmpUrl = config.rtmpUrl;
            console.log('✓ Loaded RTMP URL from config.json');
        }
    } catch (err) {
        console.warn('⚠️  Could not load config.json:', err.message);
    }

    if (!rtmpUrl) {
        rtmpUrl = process.env.RTMP_URL;
        if (!rtmpUrl) {
            console.error('❌ No RTMP URL provided!');
            console.error('   Set RTMP_URL environment variable or create config.json');
            process.exit(1);
        }
    }

    console.log(`Target RTMP URL: ${rtmpUrl}\n`);

    // Create streamer
    const streamer = new nativeModule.VideoAudioStreamer();
    
    console.log('Initializing streamer...');
    const initOk = streamer.initialize(
        rtmpUrl,
        30,          // FPS
        5000000,     // Video bitrate (5 Mbps)
        false,       // No NVENC (use libx264)
        192000,      // Audio bitrate (192 kbps)
        'both'       // Audio mode: desktop + microphone
    );

    if (!initOk) {
        console.error('❌ Streamer initialization failed');
        process.exit(1);
    }

    console.log('✓ Streamer initialized');
    console.log(`  Connected: ${streamer.isConnected()}`);
    console.log(`  Backpressure: ${streamer.isBackpressure()}\n`);

    // Start streaming
    console.log('Starting stream...');
    if (!streamer.start()) {
        console.error('❌ Failed to start streaming');
        process.exit(1);
    }

    console.log('✓ Stream started\n');
    console.log('═══════════════════════════════════════════════════════════');
    console.log('  STREAMING YOUR DESKTOP FOR 30 SECONDS');
    console.log('  Check YouTube to verify audio quality');
    console.log('═══════════════════════════════════════════════════════════\n');

    // Stream for 30 seconds
    const duration = 30;
    let lastStats = null;
    
    for (let i = 1; i <= duration; i++) {
        await new Promise(resolve => setTimeout(resolve, 1000));
        
        const stats = streamer.getStatistics();
        const videoDelta = lastStats ? stats.videoPackets - lastStats.videoPackets : stats.videoPackets;
        const audioDelta = lastStats ? stats.audioPackets - lastStats.audioPackets : stats.audioPackets;
        
        console.log(`[${i}/${duration}s] Video: ${stats.videoPackets} packets (Δ${videoDelta}), Audio: ${stats.audioPackets} packets (Δ${audioDelta})`);
        
        lastStats = stats;
    }

    console.log('\n⏹️  Stopping stream...');
    streamer.stop();
    
    const finalStats = streamer.getStatistics();
    console.log('✓ Stream stopped\n');

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  STREAMING STATISTICS');
    console.log('═══════════════════════════════════════════════════════════');
    console.log(`📹 Video Packets: ${finalStats.videoPackets}`);
    console.log(`🎤 Audio Packets: ${finalStats.audioPackets}`);
    console.log('═══════════════════════════════════════════════════════════\n');
    
    console.log('✅ Desktop streaming test completed!');
    console.log('   Check the stream on YouTube to verify audio quality.\n');
}

testDesktopStream().catch(err => {
    console.error('Error:', err);
    process.exit(1);
});

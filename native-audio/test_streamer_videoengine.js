#!/usr/bin/env node
/**
 * Test VideoEngine integration in VideoAudioStreamer
 * Streams to RTMP server with VideoEngine clock master
 */

const WasapiCapture = require('./build/Release/wasapi_capture.node');
const path = require('path');

async function main() {
    // RTMP URL - change this to your YouTube Stream Key
    // Get your Stream Key from: https://studio.youtube.com/channel/[YOUR_CHANNEL]/streaming/manage
    // Format: rtmp://a.rtmp.youtube.com/live2/{YOUR_STREAM_KEY}
    const YOUTUBE_STREAM_KEY = '3avj-5j6r-utec-qp7m-86hq'; // Replace with your actual stream key
    const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${YOUTUBE_STREAM_KEY}`;

    console.log('═══════════════════════════════════════════════════════════');
    console.log('  Testing VideoEngine Integration in VideoAudioStreamer');
    console.log('═══════════════════════════════════════════════════════════\n');

    console.log(`🌐 RTMP URL: ${rtmpUrl}\n`);

    try {
        // Create streamer instance
        const streamer = new WasapiCapture.VideoAudioStreamer();
        
        console.log('🔧 Initializing VideoAudioStreamer...');
        const initialized = streamer.initialize(
            rtmpUrl,         // RTMP URL
            30,              // FPS
            5000000,         // Video bitrate (5 Mbps)
            false,           // Use NVENC
            192000,          // Audio bitrate (192 kbps)
            'both'           // Audio mode: desktop, mic, or both
        );
        
        if (!initialized) {
            console.error('❌ Failed to initialize streamer');
            process.exit(1);
        }
        
        console.log('✅ Streamer initialized');
        console.log('📹 Codec:', streamer.getCodecName());
        console.log('⏱️  Streaming for 10 seconds...\n');
        
        // Start streaming
        const startTime = Date.now();
        const streamDuration = 10000; // 10 seconds
        
        const started = streamer.start();
        if (!started) {
            console.error('❌ Failed to start streamer');
            process.exit(1);
        }
        
        console.log('▶️  Streaming started');
        
        // Monitor streaming progress
        const streamingPromise = new Promise((resolve) => {
            const checkInterval = setInterval(() => {
                const elapsed = Date.now() - startTime;
                const remaining = streamDuration - elapsed;
                
                if (remaining <= 0) {
                    clearInterval(checkInterval);
                    console.log('\n⏳ Duration reached, ending stream');
                    resolve();
                } else {
                    const percent = Math.round((elapsed / streamDuration) * 100);
                    try {
                        const stats = streamer.getStatistics();
                        const videoFrames = stats.videoFrames || 0;
                        const videoPackets = stats.videoPackets || 0;
                        const audioPackets = stats.audioPackets || 0;
                        const isConnected = streamer.isConnected() ? '✅' : '❌';
                        const isRunning = streamer.isRunning() ? '▶️' : '⏸️';
                        
                        process.stdout.write(
                            `\r⏳ ${elapsed}ms (${percent}%) | ` +
                            `Video: ${videoFrames} fr, ${videoPackets} pkt | ` +
                            `Audio: ${audioPackets} pkt | ` +
                            `Connected: ${isConnected} Running: ${isRunning}`
                        );
                    } catch (e) {
                        console.log(`\n❌ Error getting stats: ${e.message}`);
                        clearInterval(checkInterval);
                        resolve();
                    }
                }
            }, 500);  // Check every 500ms instead of 100ms
        });
        
        await streamingPromise;
        console.log('\n');
        
        // Stop streaming
        console.log('⏹️  Stopping stream...');
        try {
            streamer.stop();
        } catch (e) {
            console.warn('⚠️  Warning during stop:', e.message);
        }
        
        // Get final statistics
        try {
            const stats = streamer.getStatistics();
            console.log('\n📊 Streaming Statistics:');
            console.log(`  Video frames captured: ${stats.videoFrames || 0}`);
            console.log(`  Video packets sent: ${stats.videoPackets || 0}`);
            console.log(`  Audio packets sent: ${stats.audioPackets || 0}`);
        } catch (e) {
            console.warn('⚠️  Could not retrieve final statistics');
        }
        console.log('\n✅ Stream test complete!\n');
        
    } catch (error) {
        console.error('❌ Error:', error.message);
        console.error('Stack:', error.stack);
        process.exit(1);
    }
    
    console.log('Process ending normally...');
}

main().catch(console.error);

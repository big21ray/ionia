// ============================================================================
// CONSOLIDATED TEST FILE - All Debug and Test Scripts
// ============================================================================
// This file contains all test and debug scripts consolidated into one file.
// Uncomment the section you want to run by removing the /* ... */ block comments.
// The last section (test_video_audio_recorder) is active by default.
// ============================================================================

const path = require('path');
const fs = require('fs');
// Note: We use ONLY FFmpeg libraries (libavcodec, libavformat, etc.) via native C++ code
// We do NOT use the ffmpeg.exe executable

// Load the native module
const nativeModule = require('./index.js');

// ============================================================================
// SECTION 1: test_video_audio_recorder.js (ACTIVE)
// ============================================================================
// Test script to record 10 seconds of screen + audio using VideoAudioRecorder
// This version initializes COM in STA mode (like Electron) to test COM threading behavior
// ============================================================================

async function testVideoAudioRecorder() {
    console.log('🎬 Starting video + audio recorder test (STA mode - Electron-like)...\n');
    console.log('📋 Note: Detailed codec selection messages appear in stderr (look for [VideoEncoder] messages)\n');
    
    if (!nativeModule.VideoAudioRecorder) {
        console.error('❌ VideoAudioRecorder not available. Make sure the native module is compiled.');
        process.exit(1);
    }

    const VideoAudioRecorder = nativeModule.VideoAudioRecorder;
    
    // Initialize COM in STA mode (like Electron does)
    if (nativeModule.initializeCOMInSTAMode) {
        console.log('🔧 Initializing COM in STA mode (simulating Electron environment)...');
        const comInitialized = nativeModule.initializeCOMInSTAMode();
        if (!comInitialized) {
            console.error('❌ Failed to initialize COM in STA mode, or COM already in different mode');
            process.exit(1);
        } else {
            console.log('✅ COM initialized in STA mode (Electron-like)\n');
        }
    } else {
        console.error('❌ initializeCOMInSTAMode function not available');
        process.exit(1);
    }

    const outputPath = path.join(__dirname, 'test_video_audio_recording.mp4');
    console.log(`📁 Output path: ${outputPath}\n`);

    if (nativeModule.checkCOMMode) {
        const comMode = nativeModule.checkCOMMode();
        console.log(`🔍 Current COM mode: ${comMode}`);
        if (comMode !== 'STA') {
            console.error(`❌ ERROR: COM is in ${comMode} mode, but should be in STA mode!`);
            process.exit(1);
        }
        console.log('✅ Verified: COM is in STA mode\n');
    }
    
    const recorder = new VideoAudioRecorder();

    try {
        console.log('🔧 Initializing recorder...');
        const initialized = recorder.initialize(outputPath, 30, 5000000, true, 192000, 'both');
        
        if (!initialized) {
            console.error('❌ Failed to initialize recorder');
            process.exit(1);
        }
        
        let codecName = 'unknown';
        if (typeof recorder.getCodecName === 'function') {
            codecName = recorder.getCodecName();
        }

        console.log('✅ Recorder initialized');
        console.log(`📹 Video Codec: ${codecName}`);

        if (codecName === 'h264_mf') {
            console.error('❌ ERROR: h264_mf codec is being used, but it should be rejected in STA mode!');
            process.exit(1);
        } else if (codecName === 'libx264' || codecName === 'x264' || codecName === 'libx264rgb') {
            console.log('✅ Correct codec selected: libx264 (works in STA mode)');
        } else if (codecName === 'h264_nvenc') {
            console.log('✅ Using NVENC (hardware acceleration)');
        } else if (codecName === 'unknown') {
            console.log('ℹ️  getCodecName not exposed on VideoAudioRecorder; relying on stderr logs for codec selection');
        }
        console.log('');

        console.log('▶️  Starting recording...');
        const started = recorder.start();
        
        if (!started) {
            console.error('❌ Failed to start recording');
            process.exit(1);
        }
        console.log('✅ Recording started\n');

        console.log('⏱️  Recording for 10 seconds...');
        const startTime = Date.now();
        
        const progressInterval = setInterval(() => {
            const elapsed = (Date.now() - startTime) / 1000;
            const pts = (typeof recorder.getCurrentPTSSeconds === 'function')
                ? recorder.getCurrentPTSSeconds()
                : NaN;
            const stats = (typeof recorder.getStatistics === 'function')
                ? recorder.getStatistics()
                : null;

            const ptsText = Number.isFinite(pts) ? `${pts.toFixed(2)}s` : 'n/a';
            const videoFrames = stats?.videoFramesCaptured ?? 'n/a';
            const videoPackets = stats?.videoPacketsEncoded ?? 'n/a';
            const audioPackets = stats?.audioPacketsEncoded ?? 'n/a';

            console.log(`   📊 ${elapsed.toFixed(1)}s elapsed | PTS: ${ptsText} | Video Frames: ${videoFrames} | Video Packets: ${videoPackets} | Audio Packets: ${audioPackets}`);
        }, 1000);

        await new Promise(resolve => setTimeout(resolve, 10000));
        clearInterval(progressInterval);

        console.log('\n⏹️  Stopping recording...');
        const stopped = recorder.stop();
        
        if (!stopped) {
            console.error('❌ Failed to stop recording');
            process.exit(1);
        }
        console.log('✅ Recording stopped\n');

        const finalStats = (typeof recorder.getStatistics === 'function') ? recorder.getStatistics() : {};
        console.log('📊 Final Statistics:');
        console.log(`   Video Frames Captured: ${finalStats.videoFramesCaptured}`);
        console.log(`   Video Packets Encoded: ${finalStats.videoPacketsEncoded}`);
        console.log(`   Audio Packets Encoded: ${finalStats.audioPacketsEncoded}`);
        console.log(`   Video Packets Muxed: ${finalStats.videoPacketsMuxed}`);
        console.log(`   Audio Packets Muxed: ${finalStats.audioPacketsMuxed}`);
        const totalBytes = (typeof finalStats.totalBytes === 'number') ? finalStats.totalBytes : NaN;
        const totalBytesText = Number.isFinite(totalBytes)
            ? `${totalBytes} (${(totalBytes / 1024 / 1024).toFixed(2)} MB)`
            : 'n/a';
        console.log(`   Total Bytes: ${totalBytesText}\n`);

        const finalCodecName = (typeof recorder.getCodecName === 'function') ? recorder.getCodecName() : 'unknown';
        
        console.log(`✅ Test completed! Video + Audio saved to: ${outputPath}`);
        console.log(`   Expected video frames: ~${30 * 10} (30 fps × 10 seconds)`);
        console.log(`   Actual video frames: ${finalStats.videoFramesCaptured}`);
        console.log(`\n📝 Test Summary:`);
        console.log(`   - COM Mode: STA (Electron-like)`);
        console.log(`   - Video Codec Used: ${finalCodecName}`);
        
        if (finalCodecName === 'libx264' || finalCodecName === 'x264' || finalCodecName === 'libx264rgb') {
            console.log(`   ✅ SUCCESS: libx264 is being used (correct for STA mode)`);
        } else if (finalCodecName === 'h264_nvenc') {
            console.log(`   ✅ Using NVENC (hardware acceleration)`);
        }

    } catch (error) {
        console.error('❌ Error during recording:', error);
        process.exit(1);
    }
}

// Run the active test
testVideoAudioRecorder().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});

// ============================================================================
// SECTION 2: test_video_recorder.js (COMMENTED)
// ============================================================================
// Test script to record 10 seconds of screen using VideoRecorder (video only)
// ============================================================================
/*
async function testVideoRecorder() {
    console.log('🎬 Starting video recorder test...\n');

    if (!nativeModule.VideoRecorder) {
        console.error('❌ VideoRecorder not available. Make sure the native module is compiled.');
        process.exit(1);
    }

    const VideoRecorder = nativeModule.VideoRecorder;
    const outputPath = path.join(__dirname, 'test_video_recording.mp4');
    console.log(`📁 Output path: ${outputPath}\n`);

    const recorder = new VideoRecorder();

    try {
        console.log('🔧 Initializing recorder...');
        const initialized = recorder.initialize(outputPath, 30, 5000000, true);
        
        if (!initialized) {
            console.error('❌ Failed to initialize recorder');
            process.exit(1);
        }
        console.log('✅ Recorder initialized\n');

        console.log('▶️  Starting recording...');
        const started = recorder.start();
        
        if (!started) {
            console.error('❌ Failed to start recording');
            process.exit(1);
        }
        console.log('✅ Recording started\n');

        console.log('⏱️  Recording for 10 seconds...');
        const startTime = Date.now();
        
        const progressInterval = setInterval(() => {
            const elapsed = (Date.now() - startTime) / 1000;
            const pts = recorder.getCurrentPTSSeconds();
            const stats = recorder.getStatistics();
            console.log(`   📊 ${elapsed.toFixed(1)}s elapsed | PTS: ${pts.toFixed(2)}s | Frames: ${stats.videoFramesCaptured} | Packets: ${stats.videoPacketsEncoded}`);
        }, 1000);

        await new Promise(resolve => setTimeout(resolve, 10000));
        clearInterval(progressInterval);

        console.log('\n⏹️  Stopping recording...');
        const stopped = recorder.stop();
        
        if (!stopped) {
            console.error('❌ Failed to stop recording');
            process.exit(1);
        }
        console.log('✅ Recording stopped\n');

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

testVideoRecorder().catch(error => {
    console.error('❌ Fatal error:', error);
    process.exit(1);
});
*/

// ============================================================================
// SECTION 3: REMOVED - test_duration.js
// ============================================================================
// This section was removed because it used the ffprobe.exe executable via spawn()
// We use ONLY FFmpeg libraries (libavcodec, libavformat, etc.) via native C++ code
// ============================================================================

// ============================================================================
// SECTION 4: debug_video_recorder.js (COMMENTED)
// ============================================================================
// DEBUG: Video Recorder Test (Native C++ Implementation)
// Tests VideoRecorder with WASAPI capture feeding audio
// ============================================================================
/*
const WASAPICapture = nativeModule.WASAPICapture;
const VideoRecorder = nativeModule.VideoRecorder;

console.log('🔍 DEBUG: Video Recorder Test (Native C++)');
console.log('   Video: DXGI Desktop Duplication → H.264 Encoder');
console.log('   Audio: WASAPI → AudioEngine → AAC Encoder');
console.log('   Output: MP4 file with video + audio');
console.log('   Recording for 10 seconds...\n');

const outputPath = path.join(__dirname, 'debug_video_recorder.mp4');

if (fs.existsSync(outputPath)) {
  fs.unlinkSync(outputPath);
  console.log('🗑️  Removed existing output file');
}

let stats = {
  wasapiCallbacks: { desktop: 0, mic: 0 },
  videoFrames: 0,
  videoPackets: 0,
  audioPackets: 0
};

let isRecording = true;
let recordingStartTime = null;
let videoRecorder = null;
let audioCapture = null;

console.log('🎬 Initializing Video Recorder...');

if (!VideoRecorder) {
  console.error('❌ VideoRecorder not available!');
  process.exit(1);
}

videoRecorder = new VideoRecorder();

const initialized = videoRecorder.initialize(
  outputPath,
  30,
  5000000,
  192000,
  true
);

if (!initialized) {
  console.error('❌ Failed to initialize Video Recorder');
  process.exit(1);
}

console.log('✅ Video Recorder initialized\n');

console.log('🎤 Initializing WASAPI capture...');

audioCapture = new WASAPICapture((buffer, source, format) => {
  if (!isRecording || !videoRecorder) {
    return;
  }

  if (!buffer || buffer.length === 0) {
    return;
  }

  stats.wasapiCallbacks[source]++;

  const bytesPerFrame = format.channels * (format.bitsPerSample / 8);
  const numFrames = buffer.length / bytesPerFrame;
  
  videoRecorder.feedAudioData(buffer, numFrames, source);
}, 'both');

const format = audioCapture.getFormat();
if (format) {
  console.log(`✅ WASAPI Capture initialized`);
  console.log(`   Format: ${format.sampleRate} Hz, ${format.channels} channels, ${format.bitsPerSample} bits\n`);
} else {
  console.error('❌ Failed to get format from WASAPI capture');
  process.exit(1);
}

console.log('🎙️  Starting recording...\n');

if (!audioCapture.start()) {
  console.error('❌ Failed to start WASAPI capture');
  process.exit(1);
}
console.log('✅ WASAPI capture started');

if (!videoRecorder.start()) {
  console.error('❌ Failed to start Video Recorder');
  process.exit(1);
}
console.log('✅ Video Recorder started\n');

recordingStartTime = Date.now();

const progressInterval = setInterval(() => {
  if (!isRecording) {
    clearInterval(progressInterval);
    return;
  }

  try {
    const elapsed = Date.now() - recordingStartTime;
    const elapsedSeconds = (elapsed / 1000).toFixed(1);
    const pts = videoRecorder.getCurrentPTSSeconds();
    const recorderStats = videoRecorder.getStatistics();

    console.log(`⏱️  ${elapsedSeconds}s - ` +
                `WASAPI: desktop=${stats.wasapiCallbacks.desktop}, mic=${stats.wasapiCallbacks.mic} | ` +
                `Video: frames=${recorderStats.videoFramesCaptured}, packets=${recorderStats.videoPacketsEncoded} | ` +
                `Audio: packets=${recorderStats.audioPacketsEncoded} | ` +
                `PTS: ${pts.toFixed(3)}s`);
  } catch (error) {
    console.error('❌ Error getting statistics:', error);
  }
}, 1000);

setTimeout(() => {
  console.log('\n⏹️  Stopping recording...\n');
  isRecording = false;
  
  clearInterval(progressInterval);
  
  if (videoRecorder) {
    videoRecorder.stop();
    console.log('✅ Video Recorder stopped');
  }
  
  if (audioCapture) {
    audioCapture.stop();
    console.log('✅ WASAPI capture stopped');
  }
  
  setTimeout(() => {
    const recorderStats = videoRecorder.getStatistics();
    
    console.log('\n📊 Final Statistics:');
    console.log(`   WASAPI callbacks: desktop=${stats.wasapiCallbacks.desktop}, mic=${stats.wasapiCallbacks.mic}`);
    console.log(`   Video frames captured: ${recorderStats.videoFramesCaptured}`);
    console.log(`   Video packets encoded: ${recorderStats.videoPacketsEncoded}`);
    console.log(`   Audio packets encoded: ${recorderStats.audioPacketsEncoded}`);
    console.log(`   Total bytes: ${(recorderStats.totalBytes / 1024 / 1024).toFixed(2)} MB`);
    
    if (fs.existsSync(outputPath)) {
      const fileStats = fs.statSync(outputPath);
      console.log(`\n✅ Output file: ${outputPath}`);
      console.log(`   Size: ${(fileStats.size / 1024 / 1024).toFixed(2)} MB`);
    }
    
    process.exit(0);
  }, 2000);
}, 10000);
*/

// ============================================================================
// SECTION 5: REMOVED - debug_record_ffmpeg.js
// ============================================================================
// This section was removed because it used the ffmpeg.exe executable via spawn()
// We use ONLY FFmpeg libraries (libavcodec, libavformat, etc.) via native C++ code
// ============================================================================

// ============================================================================
// SECTION 6: test_video_audio_streamer.js (COMMENTED - STREAMING TEST)
// ============================================================================
// Test script to stream video + audio to RTMP server using VideoAudioStreamer
// This tests the streaming functionality with backpressure and reconnect handling
// ============================================================================

/* COMMENTED OUT - STREAMING TEST NOT NEEDED RIGHT NOW
// async function testVideoAudioStreamer() {
//     console.log('📡 Starting video + audio streamer test (RTMP streaming)...\n');
//     console.log('📋 Note: This test requires a valid RTMP URL (e.g., Twitch, YouTube Live)\n');
//     
//     if (!nativeModule.VideoAudioStreamer) {
//         console.error('❌ VideoAudioStreamer not available. Make sure the native module is compiled with streaming support.');
//         process.exit(1);
//     }
//
//     const VideoAudioStreamer = nativeModule.VideoAudioStreamer;
//     
//     // Initialize COM in STA mode (like Electron does)
//     if (nativeModule.initializeCOMInSTAMode) {
//         console.log('🔧 Initializing COM in STA mode (simulating Electron environment)...');
//         const comInitialized = nativeModule.initializeCOMInSTAMode();
//         if (!comInitialized) {
//             console.error('❌ Failed to initialize COM in STA mode, or COM already in different mode');
//             process.exit(1);
//         } else {
//             console.log('✅ COM initialized in STA mode (Electron-like)\n');
//         }
//     } else {
//         console.error('❌ initializeCOMInSTAMode function not available');
//         process.exit(1);
//     }
//
//     // RTMP URL - LECTURE SÉCURISÉE (jamais commitée dans Git)
//     // Option 1: Fichier config.json (recommandé - dans .gitignore)
//     // let rtmpUrl = null;
//     // try {
//     //     const configPath = path.join(__dirname, 'config.json');
//     //     if (fs.existsSync(configPath)) {
//     //         const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
//     //         rtmpUrl = config.rtmpUrl;
//     //         console.log('✅ RTMP URL chargée depuis config.json');
//     //     }
//     // } catch (err) {
//     //     console.warn('⚠️  Impossible de charger config.json:', err.message);
//     // }
//     //     
//     // // Option 2: Variable d'environnement (si config.json n'existe pas)
//     // if (!rtmpUrl) {
//     //     rtmpUrl = process.env.RTMP_URL;
//     //     if (rtmpUrl) {
//     //         console.log('✅ RTMP URL chargée depuis variable d\'environnement RTMP_URL');
//     //     }
//     // }
//     //     
//     // // Option 3: Valeur par défaut (fallback)
//     // if (!rtmpUrl) {
//     //     rtmpUrl = 'rtmp://localhost:1935/live/test';
//     //     console.warn('⚠️  Utilisation de l\'URL par défaut (local). Créez config.json ou définissez RTMP_URL');
//     // }
//     //     
//     // // ⚠️ SÉCURITÉ: Ne jamais mettre votre clé directement dans ce fichier !
//     // // Utilisez config.json (dans .gitignore) ou la variable d'environnement RTMP_URL
//     // // 
//     // // Exemples d'URLs:
//     // //   YouTube: 'rtmp://a.rtmp.youtube.com/live2/VOTRE_STREAM_KEY'
//     // //   Local: 'rtmp://localhost:1935/live/test'
//     // //   Twitch: 'rtmp://live.twitch.tv/app/VOTRE_STREAM_KEY'
//     // console.log(`📡 RTMP URL: ${rtmpUrl}`);
//     // console.log('   (URL chargée depuis config.json, variable d\'environnement RTMP_URL, ou valeur par défaut)\n');
//     //
//     // const streamer = new VideoAudioStreamer();
//     //
//     // try {
//     //     console.log('🔧 Initializing streamer...');
//     //     const initialized = streamer.initialize(rtmpUrl, 30, 5000000, true, 192000, 'both');
//     //     
//     //     if (!initialized) {
//     //         console.error('❌ Failed to initialize streamer');
//     //         process.exit(1);
//     //     }
//     //     
//     //     const codecName = streamer.getCodecName();
//     //     console.log('✅ Streamer initialized');
//     //     console.log(`📹 Video Codec: ${codecName}`);
//     //     console.log(`📡 RTMP URL: ${rtmpUrl}\n`);
//     //
//     //     console.log('▶️  Starting stream...');
//     //     const started = streamer.start();
//     //     
//     //     if (!started) {
//     //         console.error('❌ Failed to start stream');
//     //         process.exit(1);
//     //     }
//     //     console.log('✅ Stream started\n');
//     //     
//     //     // CRITICAL: Give threads time to start before continuing
//     //     console.log('[DEBUG] Waiting 2 seconds for threads to initialize...');
//     //     await new Promise(resolve => setTimeout(resolve, 2000));
//     //     console.log('[DEBUG] Thread initialization wait completed\n');
//     //
//     //     console.log('⏱️  Streaming for 30 seconds...');
//     //     console.log('   (Monitor for backpressure, reconnect, and drop statistics)\n');
//     //     const startTime = Date.now();
//     //     
//     //     let progressInterval = null;
//     //     let statsErrorCount = 0;
//     //     
//     //     try {
//     //         progressInterval = setInterval(() => {
//     //             try {
//     //                 const elapsed = (Date.now() - startTime) / 1000;
//     //                 const stats = streamer.getStatistics();
//     //                 const isConnected = streamer.isConnected();
//     //                 const isBackpressure = streamer.isBackpressure();
//     //                 
//     //                 console.log(`   📊 ${elapsed.toFixed(1)}s elapsed | Connected: ${isConnected ? '✅' : '❌'} | Backpressure: ${isBackpressure ? '⚠️' : '✅'}`);
//     //                 console.log(`      Video: ${stats.videoFrames || 0} frames, ${stats.videoPackets || 0} packets`);
//     //                 console.log(`      Audio: ${stats.audioPackets || 0} packets`);
//     //                 console.log('');
//     //                 statsErrorCount = 0; // Reset error count on success
//     //             } catch (error) {
//     //                 statsErrorCount++;
//     //                 console.error(`❌ Error getting stats (attempt ${statsErrorCount}):`, error);
//     //                 if (statsErrorCount >= 3) {
//     //                     console.error('❌ Too many errors getting stats, stopping interval');
//     //                     if (progressInterval) {
//     //                         clearInterval(progressInterval);
//     //                         progressInterval = null;
//     //                     }
//     //                 }
//     //             }
//     //         }, 2000);
//     //     } catch (error) {
//     //         console.error('❌ Error setting up stats interval:', error);
//     //     }
//     //
//     //     console.log('⏳ Waiting 30 seconds...');
//     //     
//     //     // Wait 30 seconds
//     //     await new Promise(resolve => setTimeout(resolve, 30000));
//     //     clearInterval(progressInterval);
//     //
//     //     console.log('\n⏹️  Stopping stream...');
//     //     try {
//     //         const stopped = streamer.stop();
//     //         
//     //         if (!stopped) {
//     //             console.error('❌ Failed to stop stream');
//     //             process.exit(1);
//     //         }
//     //         console.log('✅ Stream stopped\n');
//     //     } catch (error) {
//     //         console.error('❌ Error stopping stream:', error);
//     //         process.exit(1);
//     //     }
//     //
//     //     console.log('📊 Getting final statistics...');
//     //     let finalStats;
//     //     try {
//     //         finalStats = streamer.getStatistics();
//     //         console.log('✅ Statistics retrieved\n');
//     //     } catch (error) {
//     //         console.error('❌ Error getting statistics:', error);
//     //         console.error('   This might indicate the streamer crashed or was destroyed');
//     //         process.exit(1);
//     //     }
//     //     console.log('📊 Final Statistics:');
//     //     console.log(`   Video Frames: ${finalStats.videoFrames || 0}`);
//     //     console.log(`   Video Packets: ${finalStats.videoPackets || 0}`);
//     //     console.log(`   Audio Packets: ${finalStats.audioPackets || 0}\n`);
//     //
//     //     console.log('📝 Getting codec name...');
//     //     let finalCodecName;
//     //     try {
//     //         finalCodecName = streamer.getCodecName();
//     //     } catch (error) {
//     //         console.error('❌ Error getting codec name:', error);
//     //         finalCodecName = 'unknown';
//     //     }
//     //     
//     //     console.log(`\n✅ Test completed! Streamed to: ${rtmpUrl}`);
//     //     console.log(`\n📝 Test Summary:`);
//     //     console.log(`   - COM Mode: STA (Electron-like)`);
//     //     console.log(`   - Video Codec Used: ${finalCodecName}`);
//     //     console.log(`   - Connected: ${streamer.isConnected() ? '✅' : '❌'}`);
//     //
//     // } catch (error) {
//     //     console.error('\n❌ Error during streaming:', error);
//     //     if (error.stack) {
//     //         console.error('Stack trace:', error.stack);
//     //     }
//     //     process.exit(1);
//     // }
// }

// Handle uncaught errors
process.on('uncaughtException', (error) => {
    console.error('\n❌ UNCAUGHT EXCEPTION:', error);
    if (error.stack) {
        console.error('Stack trace:', error.stack);
    }
    process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('\n❌ UNHANDLED REJECTION:', reason);
    process.exit(1);
});

// Keep process alive - prevent premature exit
process.stdin.resume();

// // Run the streaming test (commented out - using the active test below)
// testVideoAudioStreamer().catch(error => {
//     console.error('\n❌ Fatal error in test:', error);
//     if (error.stack) {
//         console.error('Stack trace:', error.stack);
//     }
//     process.exit(1);
// });

// ============================================================================
// SECTION 6: test_video_audio_streamer.js (COMMENTED - STREAMING TEST)
// OBS-style RTMP validation test
// ============================================================================

async function testVideoAudioStreamer() {
    console.log('\n📡 RTMP STREAMING TEST (OBS-style validation)\n');

    const VideoAudioStreamer = nativeModule.VideoAudioStreamer;
    if (!VideoAudioStreamer) {
        throw new Error('VideoAudioStreamer not available');
    }

    // ---- RTMP URL loading ---------------------------------------------------
    let rtmpUrl = null;
    try {
        const cfg = JSON.parse(fs.readFileSync(path.join(__dirname, 'config.json')));
        rtmpUrl = cfg.rtmpUrl;
        console.log('✅ RTMP URL loaded from config.json');
    } catch {}

    if (!rtmpUrl) {
        rtmpUrl = process.env.RTMP_URL;
        console.log('✅ RTMP URL loaded from env');
    }

    if (!rtmpUrl) {
        throw new Error('❌ No RTMP URL provided');
    }

    console.log(`📡 RTMP URL: ${rtmpUrl}\n`);

    // ---- COM init -----------------------------------------------------------
    if (nativeModule.initializeCOMInSTAMode) {
        console.log('🔧 Initializing COM in STA (Electron-like)');
        nativeModule.initializeCOMInSTAMode();
    }

    const streamer = new VideoAudioStreamer();

    console.log('🔧 Initializing streamer...');
    if (!streamer.initialize(rtmpUrl, 30, 5_000_000, true, 192_000, 'both')) {
        throw new Error('❌ streamer.initialize failed');
    }

    console.log(`📹 Codec: ${streamer.getCodecName()}`);

    console.log('\n▶️  STARTING STREAM');
    if (!streamer.start()) {
        throw new Error('❌ streamer.start failed');
    }

    // ---- OBS-style runtime validation --------------------------------------
    let lastStats = null;
    let firstPacketTime = null;
    let firstBufferDrain = null;
    let startTime = Date.now();

    const interval = setInterval(() => {
        const t = ((Date.now() - startTime) / 1000).toFixed(1);
        const stats = streamer.getStatistics();

        if (!lastStats) {
            console.log(`[${t}s] stats snapshot:`, stats);
        }

        // Detect first outgoing packet
        if (!firstPacketTime && stats.videoPackets > 0) {
            firstPacketTime = t;
            console.log(`✅ FIRST VIDEO PACKET SENT @ ${t}s`);
        }

        // Detect buffer drain (critical) - bufferSize might not be in stats
        if (!firstBufferDrain && stats.videoPackets > 0) {
            firstBufferDrain = t;
            console.log(`✅ PACKETS FLOWING @ ${t}s`);
        }

        // Hard assertions (fail fast)
        if (t > 5 && stats.videoPackets === 0) {
            console.error('❌ No video packets after 5s → encoder or muxer stalled');
            process.exit(1);
        }

        if (t > 8 && !streamer.isConnected()) {
            console.error('❌ RTMP not connected after 8s');
            process.exit(1);
        }

        console.log(
            `[${t}s] ` +
            `Vpkt=${stats.videoPackets || 0} ` +
            `Apkt=${stats.audioPackets || 0} ` +
            `Conn=${streamer.isConnected()}`
        );

        lastStats = stats;
    }, 1000);

    // ---- Fixed runtime (OBS default: 20s is enough) -------------------------
    await new Promise(r => setTimeout(r, 20_000));
    clearInterval(interval);

    console.log('\n⏹️  STOPPING STREAM');
    streamer.stop();

    const final = streamer.getStatistics();

    console.log('\n📊 FINAL STATS');
    console.log(final);

    // ---- Final verdict ------------------------------------------------------
    if (final.videoPackets === 0) {
        throw new Error('❌ STREAM FAILED: no packets sent');
    }

    if (!firstBufferDrain) {
        throw new Error('❌ STREAM FAILED: no packets flowing');
    }

    console.log('\n🎉 STREAM PIPELINE VALID');
    console.log('👉 If YouTube Studio still shows nothing:');
    console.log('   - RTMP key / ingest issue');
    console.log('   - or network firewall');
}

// ----------------------------------------------------------------------------

testVideoAudioStreamer().catch(err => {
    console.error('\n❌ TEST FAILED');
    console.error(err);
    process.exit(1);
});
*/  // END COMMENTED OUT SECTION 6

// ============================================================================
// NOTE: Additional debug scripts (debug_audio_*.js, debug_wasapi_*.js, etc.)
// are available in the original files. They can be added to this consolidated
// file if needed. For now, only the most commonly used tests are included.
// ============================================================================


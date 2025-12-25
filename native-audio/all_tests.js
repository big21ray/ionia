// ============================================================================
// CONSOLIDATED TEST FILE - All Debug and Test Scripts
// ============================================================================
// This file contains all test and debug scripts consolidated into one file.
// Uncomment the section you want to run by removing the /* ... */ block comments.
// The last section (test_video_audio_recorder) is active by default.
// ============================================================================

const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// Load the native module
const nativeModule = require('./index.js');

// ============================================================================
// SECTION 1: test_video_audio_recorder.js (ACTIVE - DEFAULT)
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
        
        const codecName = recorder.getCodecName();
        console.log('✅ Recorder initialized');
        console.log(`📹 Video Codec: ${codecName}`);
        
        if (codecName === 'h264_mf') {
            console.error('❌ ERROR: h264_mf codec is being used, but it should be rejected in STA mode!');
            process.exit(1);
        } else if (codecName === 'libx264' || codecName === 'x264' || codecName === 'libx264rgb') {
            console.log('✅ Correct codec selected: libx264 (works in STA mode)');
        } else if (codecName === 'h264_nvenc') {
            console.log('✅ Using NVENC (hardware acceleration)');
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
            const pts = recorder.getCurrentPTSSeconds();
            const stats = recorder.getStatistics();
            console.log(`   📊 ${elapsed.toFixed(1)}s elapsed | PTS: ${pts.toFixed(2)}s | Video Frames: ${stats.videoFramesCaptured} | Video Packets: ${stats.videoPacketsEncoded} | Audio Packets: ${stats.audioPacketsEncoded}`);
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
        console.log(`   Audio Packets Encoded: ${finalStats.audioPacketsEncoded}`);
        console.log(`   Video Packets Muxed: ${finalStats.videoPacketsMuxed}`);
        console.log(`   Audio Packets Muxed: ${finalStats.audioPacketsMuxed}`);
        console.log(`   Total Bytes: ${finalStats.totalBytes} (${(finalStats.totalBytes / 1024 / 1024).toFixed(2)} MB)\n`);

        const finalCodecName = recorder.getCodecName();
        
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
// SECTION 3: test_duration.js (COMMENTED)
// ============================================================================
// Quick test script to verify video duration using ffprobe
// ============================================================================
/*
const videoPath = path.join(__dirname, 'test_video_recording.mp4');

if (!fs.existsSync(videoPath)) {
    console.error(`❌ Video file not found: ${videoPath}`);
    console.error('   Please run test_video_recorder.js first to create the video file.');
    process.exit(1);
}

console.log('🔍 Checking video duration with ffprobe...\n');
console.log(`📁 File: ${videoPath}\n`);

const ffprobe = spawn('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    videoPath
], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
});

let output = '';
let errorOutput = '';

ffprobe.stdout.on('data', (data) => {
    output += data.toString();
});

ffprobe.stderr.on('data', (data) => {
    errorOutput += data.toString();
});

ffprobe.on('close', (code) => {
    if (code !== 0) {
        console.error('❌ ffprobe failed:', errorOutput);
        process.exit(1);
    }
    
    const durations = output.trim().split('\n').filter(line => line.trim() !== '');
    const formatDuration = parseFloat(durations[0] || durations[durations.length - 1]);
    
    console.log('📊 Duration Results:');
    console.log(`   Format duration: ${formatDuration.toFixed(3)} seconds`);
    console.log(`   Expected: ~10.000 seconds (10 seconds recording)`);
    console.log(`   Difference: ${Math.abs(formatDuration - 10.0).toFixed(3)} seconds\n`);
    
    if (Math.abs(formatDuration - 10.0) < 0.5) {
        console.log('✅ Duration is correct! (within 0.5s tolerance)');
    } else {
        console.log('❌ Duration is incorrect!');
    }
    
    const stats = fs.statSync(videoPath);
    console.log(`\n📦 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    
    process.exit(0);
});

ffprobe.on('error', (error) => {
    console.error('❌ Failed to run ffprobe:', error.message);
    process.exit(1);
});
*/

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
// SECTION 5: debug_record_ffmpeg.js (COMMENTED)
// ============================================================================
// FFmpeg recording test with WASAPI audio capture
// ============================================================================
/*
const WASAPICapture = nativeModule.WASAPICapture;

let desktopChunks = [];
let micChunks = [];
let desktopFormat = null;
let micFormat = null;
let desktopCallbackCount = 0;
let micCallbackCount = 0;

let ffmpegProcess = null;

const outputPath = path.join(__dirname, 'debug_ffmpeg_output.mp4');

console.log('🎬 Starting FFmpeg recording test...');
console.log('📁 Output will be:', outputPath);

const ffmpegArgs = [
  '-f', 'gdigrab',
  '-framerate', '30',
  '-i', 'desktop',
  '-f', 'f32le',
  '-ar', '48000',
  '-ac', '2',
  '-use_wallclock_as_timestamps', '1',
  '-i', 'pipe:0',
  '-c:v', 'libx264',
  '-preset', 'veryfast',
  '-crf', '23',
  '-pix_fmt', 'yuv420p',
  '-r', '30',
  '-c:a', 'aac',
  '-b:a', '192k',
  '-ar', '48000',
  '-ac', '2',
  '-map', '0:v:0',
  '-map', '1:a:0',
  '-shortest',
  '-y',
  outputPath
];

console.log('🎥 Starting FFmpeg...');
ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
  stdio: ['pipe', 'pipe', 'pipe'],
  windowsHide: true
});

let audioBytesSent = 0;
let isRecording = true;
let isWaitingForDrain = false;

let pacingStartTime = null;
let pacingFramesSent = 0;
const PACING_SAMPLE_RATE = 48000;
const PACING_CHANNELS = 2;
const PACING_BYTES_PER_FRAME = PACING_CHANNELS * 4;
const PACING_FRAMES_PER_10MS = Math.floor(PACING_SAMPLE_RATE / 100);

ffmpegProcess.stderr.on('data', (data) => {
  const output = data.toString();
  if (output.includes('frame=') || output.includes('error') || output.includes('Error')) {
    process.stdout.write(`FFmpeg: ${output}`);
  }
});

ffmpegProcess.on('exit', (code) => {
  console.log(`\n🎬 FFmpeg exited with code ${code}`);
  if (code === 0) {
    console.log(`✅ Recording saved: ${outputPath}`);
    const stats = fs.statSync(outputPath);
    console.log(`📦 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
  } else {
    console.error(`❌ FFmpeg failed with code ${code}`);
  }
  process.exit(code);
});

function mixAndSendToFFmpeg() {
  if (!isRecording || !ffmpegProcess || !ffmpegProcess.stdin) {
    return;
  }

  const format = desktopFormat || micFormat;
  if (!format) {
    return;
  }

  if (pacingStartTime === null) {
    pacingStartTime = Date.now();
    pacingFramesSent = 0;
  }

  const elapsedMs = Date.now() - pacingStartTime;
  const expectedFrames = Math.floor((elapsedMs / 1000) * PACING_SAMPLE_RATE);
  const framesToSend = expectedFrames - pacingFramesSent;
  const maxFramesToSend = Math.min(framesToSend, PACING_FRAMES_PER_10MS * 2);

  if (maxFramesToSend <= 0) {
    return;
  }

  const bytesPerFrame = format.channels * (format.bitsPerSample / 8);
  const desktopPcm = desktopChunks.length > 0 ? Buffer.concat(desktopChunks) : null;
  const micPcm = micChunks.length > 0 ? Buffer.concat(micChunks) : null;

  if (!desktopPcm && !micPcm) {
    return;
  }

  const desktopFrames = desktopPcm ? desktopPcm.length / bytesPerFrame : 0;
  const micFrames = micPcm ? micPcm.length / bytesPerFrame : 0;
  
  let outputFrames;
  if (desktopFrames === 0 && micFrames === 0) {
    return;
  } else if (desktopFrames === 0) {
    outputFrames = Math.min(micFrames, maxFramesToSend);
  } else if (micFrames === 0) {
    outputFrames = Math.min(desktopFrames, maxFramesToSend);
  } else {
    outputFrames = Math.min(desktopFrames, micFrames, maxFramesToSend);
  }

  if (outputFrames === 0) {
    return;
  }

  const mixedBuffer = Buffer.alloc(outputFrames * bytesPerFrame);
  const micGain = 0.9;

  for (let frame = 0; frame < outputFrames; frame++) {
    for (let ch = 0; ch < format.channels; ch++) {
      let desktopSample = 0;
      let micSample = 0;

      if (desktopPcm && frame < desktopFrames) {
        const offset = frame * bytesPerFrame + ch * (format.bitsPerSample / 8);
        desktopSample = desktopPcm.readFloatLE(offset);
      }

      if (micPcm && frame < micFrames) {
        const offset = frame * bytesPerFrame + ch * (format.bitsPerSample / 8);
        micSample = micPcm.readFloatLE(offset) * micGain;
      }

      let mixed = desktopSample + micSample;
      if (mixed > 1.0) mixed = 1.0;
      if (mixed < -1.0) mixed = -1.0;

      const outputOffset = frame * bytesPerFrame + ch * (format.bitsPerSample / 8);
      mixedBuffer.writeFloatLE(mixed, outputOffset);
    }
  }

  const desktopBytesUsed = outputFrames * bytesPerFrame;
  const micBytesUsed = outputFrames * bytesPerFrame;
  
  if (desktopPcm && desktopPcm.length > desktopBytesUsed) {
    const remaining = desktopPcm.subarray(desktopBytesUsed);
    desktopChunks = [remaining];
  } else {
    desktopChunks = [];
  }
  
  if (micPcm && micPcm.length > micBytesUsed) {
    const remaining = micPcm.subarray(micBytesUsed);
    micChunks = [remaining];
  } else {
    micChunks = [];
  }

  try {
    const canWrite = ffmpegProcess.stdin.write(mixedBuffer, (err) => {
      if (err) {
        console.error('❌ Error writing to FFmpeg:', err);
        isRecording = false;
        isWaitingForDrain = false;
      }
    });

    if (!canWrite && !isWaitingForDrain) {
      isWaitingForDrain = true;
      ffmpegProcess.stdin.once('drain', () => {
        isWaitingForDrain = false;
        mixAndSendToFFmpeg();
      });
    }

    audioBytesSent += mixedBuffer.length;
    pacingFramesSent += outputFrames;
  } catch (err) {
    console.error('❌ Error sending audio to FFmpeg:', err);
    isRecording = false;
    isWaitingForDrain = false;
  }
}

console.log('🎤 Initializing WASAPI audio capture...');
const audioCapture = new WASAPICapture((buffer, source, format) => {
  if (!isRecording) {
    return;
  }

  if (!buffer || buffer.length === 0) {
    return;
  }

  if (source === 'desktop') {
    if (!desktopFormat) {
      desktopFormat = format;
      console.log(`🎵 Desktop format: ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
    }
    desktopChunks.push(buffer);
    desktopCallbackCount++;
  } else if (source === 'mic') {
    if (!micFormat) {
      micFormat = format;
      console.log(`🎵 Mic format: ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
    }
    micChunks.push(buffer);
    micCallbackCount++;
  }
}, 'both');

const format = audioCapture.getFormat();
if (format) {
  console.log(`🎵 Unified audio format: ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
}

console.log('⏺ Starting audio capture...');
const started = audioCapture.start();
if (!started) {
  console.error('❌ Failed to start audio capture');
  process.exit(1);
}

console.log('✅ Audio capture started');
console.log('⏺ Recording for ~10 seconds...\n');

const mixInterval = setInterval(() => {
  if (isRecording) {
    mixAndSendToFFmpeg();
  }
}, 10);

setTimeout(() => {
  console.log('\n🛑 Stopping capture...');
  isRecording = false;
  
  clearInterval(mixInterval);
  mixAndSendToFFmpeg();
  
  setTimeout(() => {
    console.log(`📊 Desktop callbacks: ${desktopCallbackCount}`);
    console.log(`📊 Mic callbacks: ${micCallbackCount}`);
    console.log(`📦 Audio bytes sent to FFmpeg: ${(audioBytesSent / 1024 / 1024).toFixed(2)} MB`);
    
    audioCapture.stop();
    
    if (ffmpegProcess && ffmpegProcess.stdin) {
      console.log('📝 Closing FFmpeg stdin...');
      ffmpegProcess.stdin.end();
    }
  }, 200);
}, 10000);

process.on('SIGINT', () => {
  console.log('\n\n🛑 Interrupted by user');
  isRecording = false;
  clearInterval(mixInterval);
  mixAndSendToFFmpeg();
  setTimeout(() => {
    audioCapture.stop();
    if (ffmpegProcess && ffmpegProcess.stdin) {
      ffmpegProcess.stdin.end();
    }
    process.exit(0);
  }, 200);
});
*/

// ============================================================================
// NOTE: Additional debug scripts (debug_audio_*.js, debug_wasapi_*.js, etc.)
// are available in the original files. They can be added to this consolidated
// file if needed. For now, only the most commonly used tests are included.
// ============================================================================


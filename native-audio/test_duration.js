// Quick test script to verify video duration using ffprobe
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const videoPath = path.join(__dirname, 'test_video_recording.mp4');

if (!fs.existsSync(videoPath)) {
    console.error(`❌ Video file not found: ${videoPath}`);
    console.error('   Please run test_video_recorder.js first to create the video file.');
    process.exit(1);
}

console.log('🔍 Checking video duration with ffprobe...\n');
console.log(`📁 File: ${videoPath}\n`);

// Use ffprobe to get duration
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
        console.error('\n💡 Make sure ffprobe is in your PATH or install FFmpeg');
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
        console.log(`   Expected ~10 seconds, got ${formatDuration.toFixed(3)} seconds`);
    }
    
    // Also show file size
    const stats = fs.statSync(videoPath);
    console.log(`\n📦 File size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
    
    process.exit(0);
});

ffprobe.on('error', (error) => {
    console.error('❌ Failed to run ffprobe:', error.message);
    console.error('\n💡 Make sure ffprobe is in your PATH');
    console.error('   You can install FFmpeg from: https://ffmpeg.org/download.html');
    process.exit(1);
});



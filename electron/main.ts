import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, ChildProcess, exec } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';
import { createRequire } from 'module';

const execAsync = promisify(exec);
const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load native WASAPI module
let WASAPICapture: any = null;
try {
  // In development, __dirname points to dist-electron/electron
  // In production, it points to the packaged electron folder
  const isDev = process.env.NODE_ENV === 'development' || !app?.isPackaged;
  const nativeAudioPath = isDev
    ? path.join(__dirname, '../../native-audio')
    : path.join(process.resourcesPath || __dirname, 'native-audio');
  
  const nativeModule = require(path.join(nativeAudioPath, 'index.js'));
  WASAPICapture = nativeModule.WASAPICapture;
  console.log('✅ WASAPI native module loaded successfully from:', nativeAudioPath);
} catch (error) {
  console.error('❌ Failed to load WASAPI native module:', error);
  console.error('Make sure to run "npm run build:native" first');
}

// Recording state
let recordingProcess: ChildProcess | null = null;
let recordingOutputPath: string | null = null;
let audioCapture: any = null;
let audioBytesReceived = 0;
let audioFormat: any = null;
let audioBuffer: Buffer[] = [];
let audioBufferSize = 0;
let audioBlockAlign = 8; // Will be set from format (8 bytes for 32-bit float stereo: 2ch * 4 bytes)
let isRecordingAudio = false; // Flag to prevent processing audio after stop
let audioWriteErrorLogged = false; // Avoid spamming EOF errors
const AUDIO_BUFFER_THRESHOLD = 8192;

// Audio pacing (like OBS) - send audio at a constant rate based on real-time
let pacingStartTime: number | null = null;
let pacingFramesSent = 0;
const PACING_SAMPLE_RATE = 48000;
const PACING_CHANNELS = 2;
const PACING_BYTES_PER_FRAME = PACING_CHANNELS * 4; // 2 channels * 4 bytes (float32)
const PACING_FRAMES_PER_10MS = Math.floor(PACING_SAMPLE_RATE / 100); // 480 frames per 10ms

// Separate buffers for desktop and mic (both at 48000 Hz, stereo, float32 after resampling)
let desktopAudioBuffer: Buffer[] = [];
let micAudioBuffer: Buffer[] = [];
let desktopFormat: any = null;
let micFormat: any = null;

// Flag to prevent multiple drain listeners
let isWaitingForDrain = false;

// Function to mix desktop and mic audio buffers and send to FFmpeg with pacing (like OBS)
function mixAndSendAudio() {
  if (!isRecordingAudio) {
    return;
  }
  
  if (!recordingProcess?.stdin || recordingProcess.stdin.destroyed) {
    return;
  }

  const stdin = recordingProcess.stdin;
  if ((stdin as any).writableEnded) {
    isRecordingAudio = false;
    return;
  }

  // Initialize pacing start time
  if (pacingStartTime === null) {
    pacingStartTime = Date.now();
    pacingFramesSent = 0;
    console.log('⏱️ Audio pacing initialized');
  }

  // Calculate how many frames we should have sent by now (based on real-time)
  const elapsedMs = Date.now() - pacingStartTime;
  const expectedFrames = Math.floor((elapsedMs / 1000) * PACING_SAMPLE_RATE);
  const framesToSend = expectedFrames - pacingFramesSent;

  // Don't send more than we have buffered, and limit to reasonable chunks
  // But always send at least some data if we have it (don't wait too long)
  // If we have no audio data yet, force sending silence to start FFmpeg
  const desktopPcm = desktopAudioBuffer.length > 0 ? Buffer.concat(desktopAudioBuffer) : null;
  const micPcm = micAudioBuffer.length > 0 ? Buffer.concat(micAudioBuffer) : null;
  const hasNoAudio = !desktopPcm && !micPcm;
  
  const maxFramesToSend = hasNoAudio 
    ? PACING_FRAMES_PER_10MS // Always send at least 10ms of silence if no audio
    : Math.max(
        Math.min(framesToSend, PACING_FRAMES_PER_10MS * 2), // Max 20ms at a time
        framesToSend > 0 ? PACING_FRAMES_PER_10MS : 0 // But send at least 10ms worth if we're behind
      );

  if (maxFramesToSend <= 0 && !hasNoAudio) {
    return; // Not time to send yet (only if we have audio data)
  }

  // Get the unified format (should be the same for both)
  const format = desktopFormat || micFormat;
  
  // If format not available yet, use default (48000 Hz, stereo, float32)
  const bytesPerFrame = format 
    ? format.channels * (format.bitsPerSample / 8) 
    : PACING_BYTES_PER_FRAME; // 8 bytes for stereo float32

  // If no audio data yet, send silence to keep FFmpeg happy
  // This prevents FFmpeg from blocking at 0 fps waiting for audio
  if (hasNoAudio) {
    // Send a small chunk of silence (10ms = 480 frames @ 48kHz)
    const silenceFrames = Math.min(maxFramesToSend, PACING_FRAMES_PER_10MS);
    const silenceBuffer = Buffer.alloc(silenceFrames * bytesPerFrame);
    silenceBuffer.fill(0); // Fill with zeros (silence)
    
    try {
      const canWrite = stdin.write(silenceBuffer, (err) => {
        if (err) {
          if (!audioWriteErrorLogged) {
            console.warn('Audio write error (silence):', err.message || err);
            audioWriteErrorLogged = true;
          }
          isRecordingAudio = false;
        }
      });
      
      if (!canWrite && !isWaitingForDrain) {
        isWaitingForDrain = true;
        stdin.once('drain', () => {
          isWaitingForDrain = false;
        });
      }
      
      // Update pacing counter even for silence
      pacingFramesSent += silenceFrames;
      audioBytesReceived += silenceBuffer.length;
      
      // Debug: log first few silence sends
      if (pacingFramesSent <= PACING_FRAMES_PER_10MS * 5) {
        console.log(`🔇 Sent ${silenceFrames} frames of silence (total: ${pacingFramesSent} frames)`);
      }
    } catch (err) {
      console.error('❌ Error sending silence:', err);
    }
    return;
  }

  // Need format for mixing
  if (!format) {
    return;
  }

  const desktopFrames = desktopPcm ? desktopPcm.length / bytesPerFrame : 0;
  const micFrames = micPcm ? micPcm.length / bytesPerFrame : 0;
  
  // Use the minimum of both to ensure synchronization
  // But also respect pacing - don't send more than we should
  let outputFrames: number;
  if (desktopFrames === 0 && micFrames === 0) {
    return;
  } else if (desktopFrames === 0) {
    // Only mic - send what we have, but respect pacing
    outputFrames = Math.min(micFrames, maxFramesToSend);
  } else if (micFrames === 0) {
    // Only desktop - send what we have, but respect pacing
    outputFrames = Math.min(desktopFrames, maxFramesToSend);
  } else {
    // Both available - use minimum to ensure alignment, but respect pacing
    outputFrames = Math.min(desktopFrames, micFrames, maxFramesToSend);
  }

  if (outputFrames === 0) {
    return;
  }

  // Mix the two streams
  const mixedBuffer = Buffer.alloc(outputFrames * bytesPerFrame);
  const micGain = 0.9; // Slight gain reduction for mic

  for (let frame = 0; frame < outputFrames; frame++) {
    for (let ch = 0; ch < format.channels; ch++) {
      let desktopSample = 0;
      let micSample = 0;

      // Get desktop sample
      if (desktopPcm && frame < desktopFrames) {
        const offset = frame * bytesPerFrame + ch * (format.bitsPerSample / 8);
        desktopSample = desktopPcm.readFloatLE(offset);
      }

      // Get mic sample
      if (micPcm && frame < micFrames) {
        const offset = frame * bytesPerFrame + ch * (format.bitsPerSample / 8);
        micSample = micPcm.readFloatLE(offset) * micGain;
      }

      // Mix and clamp
      let mixed = desktopSample + micSample;
      if (mixed > 1.0) mixed = 1.0;
      if (mixed < -1.0) mixed = -1.0;

      // Write mixed sample
      const outputOffset = frame * bytesPerFrame + ch * (format.bitsPerSample / 8);
      mixedBuffer.writeFloatLE(mixed, outputOffset);
    }
  }

  // Clear buffers
  desktopAudioBuffer = [];
  micAudioBuffer = [];

  // Send mixed audio to FFmpeg
  try {
    const alignedSize = Math.floor(mixedBuffer.length / audioBlockAlign) * audioBlockAlign;
    if (alignedSize >= audioBlockAlign) {
      const chunk = mixedBuffer.subarray(0, alignedSize);
      audioBytesReceived += chunk.length;
      
      // Update pacing counter
      pacingFramesSent += outputFrames;
      
      // Debug: log first few audio sends
      if (pacingFramesSent <= PACING_FRAMES_PER_10MS * 10) {
        console.log(`🎵 Sent ${outputFrames} frames of mixed audio (total: ${pacingFramesSent} frames, ${(audioBytesReceived / 1024).toFixed(1)} KB)`);
      }
      
      const canWrite = stdin.write(chunk, (err) => {
        if (err) {
          if (!audioWriteErrorLogged) {
            console.warn('Audio write error (likely FFmpeg stdin closed):', err.message || err);
            audioWriteErrorLogged = true;
          }
          isRecordingAudio = false;
          isWaitingForDrain = false;
        }
      });

      if (!canWrite && !isWaitingForDrain) {
        isWaitingForDrain = true;
        stdin.once('drain', () => {
          isWaitingForDrain = false;
          // Try to send more data if available
          mixAndSendAudio();
        });
      }
    }
  } catch (err) {
    // Ignore write errors
    isWaitingForDrain = false;
  }
}

const createWindow = () => {
  // Create the browser window
  const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
  const preloadPath = isDev
    ? path.join(__dirname, '../../electron/preload.js')
    : path.join(__dirname, 'preload.js');
  
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // Handle file dialog
  ipcMain.handle('dialog:openFile', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      properties: ['openFile'],
      filters: [
        { name: 'Videos', extensions: ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'flv', 'wmv'] },
        { name: 'All Files', extensions: ['*'] },
      ],
    });
    return { canceled, filePaths };
  });

  // Handle recording start
  ipcMain.handle('recording:start', async (_event, mode?: 'both' | 'desktop' | 'mic') => {
    if (recordingProcess) {
      return { success: false, error: 'Recording already in progress' };
    }

    try {
      // Create recordings folder if it doesn't exist
      // Use app.getPath('userData') for production, or __dirname for development
      const basePath = app.isPackaged 
        ? app.getPath('userData') 
        : path.join(__dirname, '../../');
      const recordingsDir = path.join(basePath, 'recordings');
      if (!fs.existsSync(recordingsDir)) {
        fs.mkdirSync(recordingsDir, { recursive: true });
      }

      // Generate output filename with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      recordingOutputPath = path.join(recordingsDir, `recording_${timestamp}.mp4`);

      // Normalize capture mode
      const captureMode: 'both' | 'desktop' | 'mic' =
        mode === 'desktop' || mode === 'mic' || mode === 'both' ? mode : 'both';

      // Initialize audio capture if available
      let audioSampleRate = 48000;
      let audioChannels = 2;
      audioBytesReceived = 0;
      audioFormat = null;
      audioBuffer = [];
      audioBufferSize = 0;
      desktopAudioBuffer = [];
      micAudioBuffer = [];
      desktopFormat = null;
      micFormat = null;
      isRecordingAudio = false; // Reset flag for new recording
      audioWriteErrorLogged = false; // Reset EOF error flag
      isWaitingForDrain = false; // Reset drain flag
      pacingStartTime = null; // Reset pacing
      pacingFramesSent = 0;

      if (WASAPICapture) {
        try {
          console.log(`🎤 Initializing WASAPI audio capture (mode: ${captureMode})...`);
          // Store capture mode for use in callback
          const currentCaptureMode = captureMode;
          // Capture according to requested mode - callback now receives (buffer, source, format)
          audioCapture = new WASAPICapture((audioData: Buffer, source: string, format: any) => {
            // Early return if recording has stopped
            if (!isRecordingAudio) {
              return;
            }

            if (!audioData || audioData.length === 0) {
              return;
            }

            // Store format info for each source
            if (source === 'desktop') {
              if (!desktopFormat) {
                desktopFormat = format;
                console.log(`🎵 Desktop format (unified): ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
                audioBlockAlign = format.blockAlign || 8;
              }
              desktopAudioBuffer.push(audioData);
            } else if (source === 'mic') {
              if (!micFormat) {
                micFormat = format;
                console.log(`🎵 Mic format (unified): ${format.sampleRate} Hz, ${format.channels}ch, ${format.bitsPerSample}-bit`);
                audioBlockAlign = format.blockAlign || 8;
              }
              micAudioBuffer.push(audioData);
            }

            // Mix and send when we have enough data
            // Calculate buffered sizes efficiently
            let desktopBuffered = 0;
            let micBuffered = 0;
            for (const buf of desktopAudioBuffer) desktopBuffered += buf.length;
            for (const buf of micAudioBuffer) micBuffered += buf.length;
            const totalBuffered = desktopBuffered + micBuffered;

            // Send if we have enough data:
            // - Mode "desktop": send when desktop buffer >= threshold
            // - Mode "mic": send when mic buffer >= threshold  
            // - Mode "both": send when total >= threshold (don't wait for both, mix what we have)
            const shouldSend = 
              (currentCaptureMode === 'desktop' && desktopBuffered >= AUDIO_BUFFER_THRESHOLD) ||
              (currentCaptureMode === 'mic' && micBuffered >= AUDIO_BUFFER_THRESHOLD) ||
              (currentCaptureMode === 'both' && totalBuffered >= AUDIO_BUFFER_THRESHOLD);

            if (shouldSend) {
              mixAndSendAudio();
            }
          }, captureMode);

          // Get audio format (unified format: always 48000 Hz, stereo, float32)
          audioFormat = audioCapture.getFormat();
          if (audioFormat) {
            audioSampleRate = audioFormat.sampleRate; // Should be 48000
            audioChannels = audioFormat.channels; // Should be 2 (stereo)
            audioBlockAlign = audioFormat.blockAlign || 8; // 8 bytes for stereo float32
            console.log(`🎵 Audio format (unified after resampling):`, {
              sampleRate: audioFormat.sampleRate,
              channels: audioFormat.channels,
              bitsPerSample: audioFormat.bitsPerSample,
              blockAlign: audioFormat.blockAlign,
              bytesPerSecond: audioFormat.bytesPerSecond
            });
            console.log(`🎤 Recording audio mode: ${captureMode}`);
          } else {
            console.log('⚠️ Audio format not available yet (will be available after start)');
          }
        } catch (error) {
          console.error('❌ Failed to initialize audio capture:', error);
          audioCapture = null;
        }
      } else {
        console.log('⚠️ WASAPI native module not available - recording without audio');
      }

      // FFmpeg command for screen recording with optional audio
      const ffmpegArgs: string[] = [
        // Video input - screen capture
        '-f', 'gdigrab',
        '-framerate', '30',  // Lock at 30 fps
        '-i', 'desktop',
      ];

      // Add audio input if audio capture is available
      if (audioCapture) {
        // Audio input configuration (unified format: 48000 Hz, stereo, float32)
        console.log(`🎵 Audio input: ${audioChannels} channels at ${audioSampleRate} Hz (unified format after resampling)`);
        ffmpegArgs.push(
          // Audio input - from pipe (32-bit float little-endian PCM, unified format)
          '-f', 'f32le',  // 32-bit float little-endian PCM
          '-ar', String(audioSampleRate),  // Input sample rate (48000 Hz after resampling)
          '-ac', String(audioChannels),  // Stereo (2 channels)
          '-use_wallclock_as_timestamps', '1',  // Use wallclock for timestamps (prevents crackle)
          '-i', 'pipe:0'  // Read audio from stdin
        );
      }

      // Sync flags (like OBS) - helps with audio/video synchronization
      ffmpegArgs.push(
        '-async', '1',  // Audio sync method (1 = resample audio to match video)
        '-vsync', '1'   // Video sync method (1 = cfr - constant frame rate)
      );

      // Video codec - optimized for RAM usage (max 400 MB)
      ffmpegArgs.push(
        '-c:v', 'libx264',
        '-preset', 'veryfast',  // Slightly slower than ultrafast but uses less RAM
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-r', '30'  // Output framerate (match input)
      );

      // Add audio codec and mapping if audio is available
      if (audioCapture) {
        // Build audio encoding args (input is already 48000 Hz, stereo after resampling)
        const audioCodecArgs = [
          // Audio codec
          '-c:a', 'aac',  // AAC codec
          '-b:a', '192k',  // Audio bitrate
          '-ar', '48000',  // Output sample rate (same as input after resampling)
          '-ac', '2',  // Always output stereo (same as input)
        ];

        console.log(`🎵 Audio output: stereo at 48000 Hz (already resampled and mixed in C++)`);
        
        ffmpegArgs.push(
          ...audioCodecArgs,
          // Map video and audio streams
          '-map', '0:v:0',
          '-map', '1:a:0'
        );
      }

      // RAM usage limits (like Medal - max 400 MB)
      ffmpegArgs.push(
        '-bufsize', '8M',  // Encoding buffer size (limits RAM for encoding)
        '-maxrate', '10M',  // Maximum bitrate (helps control buffer size)
        '-threads', '2',  // Limit threads to reduce RAM usage
        // Removed -shortest to let video drive encoding (audio will sync via pacing)
        '-movflags', '+frag_keyframe+empty_moov',  // Use fragmented MP4 - more tolerant of interruptions
        '-f', 'mp4',  // Explicitly specify MP4 format
        
        // Output
        '-y',  // Overwrite output file
        recordingOutputPath
      );

      console.log('Starting recording with FFmpeg...');
      console.log('Output path:', recordingOutputPath);
      console.log('FFmpeg args:', ffmpegArgs.join(' '));
      if (audioCapture) {
        console.log('🎤 Audio capture ready - will start after FFmpeg');
      }

      return new Promise((resolve) => {
        let errorOccurred = false;
        let ffmpegOutput = '';

        recordingProcess = spawn('ffmpeg', ffmpegArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],  // Use pipe for stdin to send audio data
          windowsHide: true  // Hide the Windows console window
        });

        // Protéger stdin contre les erreurs de type EPIPE / EOF pour éviter les crashs du main process
        if (recordingProcess.stdin) {
          recordingProcess.stdin.on('error', (err: any) => {
            const code = err?.code || '';
            if (code === 'EPIPE' || code === 'EOF') {
              if (!audioWriteErrorLogged) {
                console.warn('stdin error (FFmpeg probably closed pipe):', code);
                audioWriteErrorLogged = true;
              }
              isRecordingAudio = false;
              audioBuffer = [];
              audioBufferSize = 0;
              return;
            }
            console.error('Unexpected stdin error:', err);
          });
        }

        // Handle immediate spawn errors (FFmpeg not found, etc.)
        recordingProcess.on('error', (error) => {
          if (!errorOccurred) {
            errorOccurred = true;
            console.error('Failed to start FFmpeg:', error);
            const errorMessage = error.message || 'Failed to start FFmpeg. Make sure FFmpeg is installed and in your PATH.';
            recordingProcess = null;
            recordingOutputPath = null;
            resolve({ success: false, error: errorMessage });
          }
        });

        // Capture all FFmpeg output (it outputs to stderr)
        if (recordingProcess.stderr) {
          recordingProcess.stderr.on('data', (data) => {
            const output = data.toString();
            ffmpegOutput += output;
            // Log important lines (frame info, errors, EOF detection)
            const lines = output.split('\n');
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed) {
                // Log frame info, errors, and EOF-related messages
                if (trimmed.includes('frame=') || 
                    trimmed.includes('fps=') ||
                    trimmed.includes('size=') ||
                    trimmed.includes('time=') ||
                    trimmed.toLowerCase().includes('error') ||
                    trimmed.toLowerCase().includes('failed') ||
                    trimmed.toLowerCase().includes('eof') ||
                    trimmed.toLowerCase().includes('end of file') ||
                    trimmed.toLowerCase().includes('stream') && trimmed.toLowerCase().includes('end')) {
                  console.log('FFmpeg:', trimmed);
                }
              }
            }
            
            // Check for errors
            if (output.toLowerCase().includes('error') || 
                output.toLowerCase().includes('failed') ||
                output.toLowerCase().includes('cannot') ||
                output.toLowerCase().includes('unable')) {
              console.error('FFmpeg error detected:', output);
              if (!errorOccurred && recordingProcess) {
                errorOccurred = true;
                recordingProcess.kill();
                recordingProcess = null;
                recordingOutputPath = null;
                resolve({ success: false, error: `FFmpeg error: ${output.substring(0, 200)}` });
              }
            }
          });
        }

        // Wait a bit to see if spawn fails immediately
        setTimeout(() => {
          if (!errorOccurred) {
            // Check if process is still alive
            if (recordingProcess && !recordingProcess.killed) {
              // Start audio capture if available
              if (audioCapture) {
                try {
                  console.log('🎤 Starting audio capture...');
                  isRecordingAudio = true; // Set flag before starting
                  pacingStartTime = Date.now(); // Start pacing immediately
                  pacingFramesSent = 0;
                  
                  // Start audio pacing timer IMMEDIATELY (before capture starts)
                  // This ensures FFmpeg gets data right away (silence initially)
                  console.log('⏱️ Starting audio pacing timer...');
                  const audioSendInterval = setInterval(() => {
                    if (isRecordingAudio) {
                      mixAndSendAudio();
                    } else {
                      clearInterval(audioSendInterval);
                    }
                  }, 10); // 10ms - pacing will control actual send rate
                  
                  // Store interval ID to clear it later
                  (recordingProcess as any).audioSendInterval = audioSendInterval;
                  console.log('✅ Audio pacing timer started');
                  
                  const audioStarted = audioCapture.start();
                  if (audioStarted) {
                    console.log('✅ Audio capture started successfully');
                    // Update format if it wasn't available before
                    if (!audioFormat) {
                      audioFormat = audioCapture.getFormat();
                      if (audioFormat) {
                        audioBlockAlign = audioFormat.blockAlign || 4;
                        console.log('🎵 Audio format:', {
                          sampleRate: audioFormat.sampleRate,
                          channels: audioFormat.channels,
                          bitsPerSample: audioFormat.bitsPerSample,
                          blockAlign: audioFormat.blockAlign
                        });
                      }
                    }
                  } else {
                    console.error('❌ Failed to start audio capture');
                    isRecordingAudio = false;
                  }
                } catch (error) {
                  console.error('❌ Error starting audio capture:', error);
                  isRecordingAudio = false;
                }
              }

              // Log audio statistics periodically
              const audioStatsInterval = setInterval(() => {
                if (audioBytesReceived > 0 && isRecordingAudio) {
                  const mbReceived = (audioBytesReceived / 1024 / 1024).toFixed(2);
                  console.log(`🎵 Audio data received: ${mbReceived} MB`);
                }
              }, 5000); // Every 5 seconds

              recordingProcess.on('close', (code) => {
                clearInterval(audioStatsInterval);
                // This is just for cleanup - the actual completion message is in the stop handler
                if (audioBytesReceived > 0) {
                  const totalMB = (audioBytesReceived / 1024 / 1024).toFixed(2);
                  console.log(`🎵 Total audio data captured: ${totalMB} MB`);
                }
                recordingProcess = null;
                recordingOutputPath = null;
              });

              resolve({ success: true, outputPath: recordingOutputPath });
            } else {
              resolve({ success: false, error: 'FFmpeg process failed to start or died immediately' });
            }
          }
        }, 1000); // Wait 1 second to catch immediate errors and see initial FFmpeg output
      });
    } catch (error) {
      console.error('Recording start error:', error);
      recordingProcess = null;
      recordingOutputPath = null;
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Handle getting audio capture status
  ipcMain.handle('recording:audioStatus', async () => {
    return {
      hasAudio: !!audioCapture,
      bytesReceived: audioBytesReceived,
      format: audioFormat,
      hasNativeModule: !!WASAPICapture
    };
  });

  // Handle recording stop
  ipcMain.handle('recording:stop', async () => {
    if (!recordingProcess) {
      return { success: false, error: 'No recording in progress' };
    }

    try {
      const outputPath = recordingOutputPath;
      const processToStop = recordingProcess;
      
      // Stop audio capture and flush remaining data
      if (audioCapture) {
        try {
          console.log('🎤 Stopping audio capture...');
          // Set flag FIRST to immediately stop processing any new callbacks
          isRecordingAudio = false;
          isWaitingForDrain = false;
          
          // Stop the native capture - don't wait if it blocks
          // Call stop() but continue immediately to avoid blocking
          try {
            // Try to stop, but don't wait for it
            if (audioCapture) {
              try {
                audioCapture.stop();
              } catch (err) {
                console.error('Error calling audioCapture.stop():', err);
              }
            }
          } catch (stopError) {
            console.error('Error stopping audio capture:', stopError);
          }
          
          // Give it a tiny bit of time, but don't wait long
          await new Promise(resolve => setTimeout(resolve, 50));
          
          // Clear the audio capture reference to prevent any lingering callbacks
          audioCapture = null;
          
          console.log('✅ Audio capture stopped');
          
          // Small delay to ensure all audio callbacks complete
          await new Promise(resolve => setTimeout(resolve, 200));
          console.log('📦 Flushing audio buffer...');
          
          // Mix and send any remaining audio
          mixAndSendAudio();
          
          // Flush any remaining buffered audio (aligned to block boundaries)
          if (audioBuffer.length > 0 && processToStop?.stdin && !processToStop.stdin.destroyed && audioBlockAlign > 0) {
            try {
              const combinedBuffer = Buffer.concat(audioBuffer);
              const alignedSize = Math.floor(combinedBuffer.length / audioBlockAlign) * audioBlockAlign;
              const stdin = processToStop.stdin;
              if (alignedSize >= audioBlockAlign && stdin) { // Must have at least one complete frame
                try {
                  const canWrite = stdin.write(combinedBuffer.subarray(0, alignedSize));
                  console.log(`📤 Flushed ${alignedSize} bytes to FFmpeg (canWrite: ${canWrite})`);
                  
                  // Only wait for drain if write returned false, and with timeout
                  if (!canWrite) {
                    await Promise.race([
                      new Promise<void>(resolve => {
                        stdin.once('drain', () => {
                          console.log('✅ Flush drain completed');
                          resolve();
                        });
                      }),
                      new Promise<void>(resolve => {
                        setTimeout(() => {
                          console.warn('⚠️ Flush drain timeout (500ms) - continuing anyway');
                          resolve();
                        }, 500);
                      })
                    ]);
                  }
                } catch (writeErr) {
                  console.warn('⚠️ Error writing to stdin during flush:', writeErr);
                }
              }
            } catch (err) {
              console.error('Error flushing audio buffer:', err);
            }
          } else {
            if (audioBuffer.length === 0) {
              console.log('📦 No audio buffer to flush');
            } else {
              console.log('📦 Skipping flush (stdin not available)');
            }
          }
          
          if (audioBytesReceived > 0) {
            const totalMB = (audioBytesReceived / 1024 / 1024).toFixed(2);
            console.log(`🎵 Final audio data captured: ${totalMB} MB`);
          }
          
          // Clean up audio state
          audioBytesReceived = 0;
          audioFormat = null;
          audioBuffer = [];
          audioBufferSize = 0;
          console.log('🧹 Audio state cleaned up');
        } catch (error) {
          console.error('Error stopping audio capture:', error);
        }
      }
      
      console.log('🔄 Preparing to close FFmpeg stdin...');
      
      // Clear the reference immediately so UI can update
      recordingProcess = null;
      recordingOutputPath = null;

      // Close stdin properly to signal end of audio stream
      // Since stdin is used for audio input (pipe:0), closing it signals EOF to FFmpeg
      // FFmpeg will stop when stdin closes and finalize
      if (processToStop.stdin && !processToStop.stdin.destroyed) {
        // Wait a bit more to ensure all audio data is written
        await new Promise(resolve => setTimeout(resolve, 200));
        
        console.log('📝 Closing stdin to signal EOF to FFmpeg...');
        console.log('   (FFmpeg will stop when stdin closes and finalize)');
        
        // Ensure stdin is flushed before closing
        if (processToStop.stdin.writable) {
          // Force flush any remaining data
          processToStop.stdin.cork();
          processToStop.stdin.uncork();
        }
        
        // End the stdin stream to signal EOF for audio input
        // This tells FFmpeg that the audio stream has ended
        // FFmpeg should stop encoding and finalize when stdin closes
        processToStop.stdin.end(() => {
          console.log('✅ Stdin end callback fired - stream closed');
        });
        
        // Wait a moment for the end callback
        await new Promise(resolve => setTimeout(resolve, 100));
        
        console.log(`   stdin.destroyed: ${processToStop.stdin.destroyed}`);
        console.log(`   Waiting for FFmpeg to detect EOF and finalize...`);
      } else {
        // If stdin is not available, something went wrong
        console.log('⚠️ Stdin not available - cannot signal EOF to FFmpeg');
        console.log(`   stdin exists: ${!!processToStop.stdin}`);
        if (processToStop.stdin) {
          console.log(`   stdin.destroyed: ${processToStop.stdin.destroyed}`);
        }
      }
      
      // Attendre que FFmpeg termine et finalize le fichier
      // FFmpeg devrait s'arrêter automatiquement quand stdin se ferme
      return new Promise((resolve) => {
        // Timeout de sécurité : si FFmpeg ne se ferme pas après 15 secondes, on envoie un terminate propre
        const safetyTimeout = setTimeout(() => {
          if (!processToStop.killed) {
            console.warn('⚠️ FFmpeg did not close after 15s - sending terminate signal...');
            processToStop.kill(); // Terminate propre (pas SIGKILL)
          }
        }, 15000); // 15 secondes de timeout

        processToStop.on('close', (code) => {
          clearTimeout(safetyTimeout);
          console.log(`\n🎬 FFmpeg finished with exit code: ${code}`);
          
          // Petit délai pour laisser le système de fichiers/MP4 écrire les headers
          setTimeout(() => {
            if (code === 0 || code === null || code === 130) {
              if (outputPath && fs.existsSync(outputPath)) {
                const stats = fs.statSync(outputPath);
                const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);
                console.log(`📁 Recording file size: ${fileSizeMB} MB`);
                
                if (stats.size > 1024) {
                  try {
                    const fileHandle = fs.openSync(outputPath, 'r');
                    const buffer = Buffer.alloc(8);
                    fs.readSync(fileHandle, buffer, 0, 8, stats.size - 8);
                    fs.closeSync(fileHandle);
                    console.log('✅ Recording file appears to be valid');
                    console.log(`\n🎉 Recording finished successfully!`);
                    console.log(`📂 Saved to: ${outputPath}\n`);
                    resolve({ success: true, outputPath });
                  } catch (verifyError) {
                    console.warn('⚠️ Could not verify file integrity, but file exists:', verifyError);
                    console.log(`\n🎉 Recording finished (verification skipped)`);
                    console.log(`📂 Saved to: ${outputPath}\n`);
                    resolve({ success: true, outputPath, warning: 'File verification failed' });
                  }
                } else {
                  console.error('❌ Recording file is too small (likely incomplete):', stats.size, 'bytes');
                  resolve({ success: false, error: `Recording file is too small (${stats.size} bytes) - may be incomplete` });
                }
              } else {
                console.error('❌ Recording file was not created!');
                resolve({ success: false, error: 'Recording file was not created' });
              }
            } else {
              console.error(`❌ FFmpeg exited with error code: ${code}`);
              resolve({ success: false, error: `FFmpeg exited with code ${code}` });
            }
          }, 3000);
        });
      });
    } catch (error) {
      console.error('Recording stop error:', error);
      recordingProcess = null;
      recordingOutputPath = null;
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Load the app
  // In development, load from Vite dev server
  // In production, load from built files
  const loadApp = () => {
    const isDev = process.env.NODE_ENV === 'development' || !app.isPackaged;
    if (isDev) {
      mainWindow.loadURL('http://localhost:5173').catch((err) => {
        console.error('Failed to load dev server, retrying...', err);
        // Retry after 2 seconds
        setTimeout(loadApp, 2000);
      });
      mainWindow.webContents.openDevTools();
    } else {
      mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
    }
  };
  
  loadApp();
};

// This method will be called when Electron has finished initialization
app.on('ready', createWindow);

// Quit when all windows are closed
app.on('window-all-closed', () => {
  if (process.env.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});


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
let audioBlockAlign = 4; // Will be set from format (typically 4 bytes for 16-bit stereo)
let isRecordingAudio = false; // Flag to prevent processing audio after stop
let audioWriteErrorLogged = false; // Avoid spamming EOF errors
const AUDIO_BUFFER_THRESHOLD = 8192; // Send when we have at least 8KB buffered (multiple of block align)

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
  ipcMain.handle('recording:start', async () => {
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

      // Initialize audio capture if available
      let audioSampleRate = 48000;
      let audioChannels = 2;
      audioBytesReceived = 0;
      audioFormat = null;
      audioBuffer = [];
      audioBufferSize = 0;
      isRecordingAudio = false; // Reset flag for new recording
      audioWriteErrorLogged = false; // Reset EOF error flag

      if (WASAPICapture) {
        try {
          console.log('🎤 Initializing WASAPI audio capture (desktop + microphone)...');
          // Capture both desktop/headset and microphone
          audioCapture = new WASAPICapture((audioData: Buffer) => {
            // Early return if recording has stopped - check FIRST before anything else
            if (!isRecordingAudio) {
              return; // Don't process, don't log, just return immediately
            }
            
            const stdin = recordingProcess?.stdin;
            if (!stdin || stdin.destroyed || (stdin as any).writableEnded) {
              isRecordingAudio = false; // Also set flag if process is gone
              return;
            }
            
            // Only process if we have valid data and know the block align
            if (audioData.length === 0 || audioBlockAlign === 0) {
              return;
            }
            
            // Double-check flag before incrementing (race condition protection)
            if (!isRecordingAudio) {
              return;
            }
            
            audioBytesReceived += audioData.length;
            
            // Buffer audio data to ensure proper alignment
            audioBuffer.push(audioData);
            audioBufferSize += audioData.length;
            
            // Flush buffer when it reaches threshold (ensuring it's aligned to block size)
            // We need at least one complete frame (blockAlign bytes)
            if (audioBufferSize >= Math.max(AUDIO_BUFFER_THRESHOLD, audioBlockAlign)) {
              try {
                // Combine all buffered chunks
                const combinedBuffer = Buffer.concat(audioBuffer);
                
                // Ensure buffer is aligned to block boundaries - only send complete frames
                const alignedSize = Math.floor(combinedBuffer.length / audioBlockAlign) * audioBlockAlign;
                
                if (alignedSize >= audioBlockAlign) { // Must have at least one complete frame
                  // Write aligned portion (guard against EOF errors)
                  const chunk = combinedBuffer.subarray(0, alignedSize);
                  const canWrite = stdin.write(chunk, (err) => {
                    if (err) {
                      // FFmpeg closed stdin (write EOF) – stop audio gracefully
                      if (!audioWriteErrorLogged) {
                        console.warn('Audio write error (likely FFmpeg stdin closed):', err.message || err);
                        audioWriteErrorLogged = true;
                      }
                      isRecordingAudio = false;
                      audioBuffer = [];
                      audioBufferSize = 0;
                    }
                  });
                  
                  // Keep any remaining unaligned data in buffer
                  if (alignedSize < combinedBuffer.length) {
                    audioBuffer = [combinedBuffer.subarray(alignedSize)];
                    audioBufferSize = combinedBuffer.length - alignedSize;
                  } else {
                    audioBuffer = [];
                    audioBufferSize = 0;
                  }
                  
                  // If write buffer is full, wait for drain
                  if (!canWrite) {
                    stdin.once('drain', () => {
                      // Continue writing when buffer drains
                    });
                  }
                }
              } catch (err) {
                // Ignore write errors (pipe might be closed)
                audioBuffer = [];
                audioBufferSize = 0;
              }
            }
          }, 'both');  // Capture mode: 'both' = desktop/headset + microphone

          // Get audio format
          audioFormat = audioCapture.getFormat();
          if (audioFormat) {
            audioSampleRate = audioFormat.sampleRate;
            // Use actual channel count - FFmpeg can handle multi-channel audio
            // We'll let FFmpeg downmix if needed
            audioChannels = audioFormat.channels;
            audioBlockAlign = audioFormat.blockAlign || 4;
          console.log('🎵 Audio format detected (mixed desktop + microphone):', {
            sampleRate: audioFormat.sampleRate,
            channels: audioFormat.channels,
            bitsPerSample: audioFormat.bitsPerSample,
            blockAlign: audioFormat.blockAlign,
            bytesPerSecond: audioFormat.bytesPerSecond
          });
          console.log('🎤 Recording desktop/headset audio only (debugging mode)');
          
          // Warn if we have unusual channel count
          if (audioFormat.channels > 2) {
            console.log(`⚠️ WARNING: Audio has ${audioFormat.channels} channels - this may cause distortion if not handled correctly`);
            console.log(`   Block align: ${audioFormat.blockAlign} bytes (expected ${audioFormat.channels * audioFormat.bitsPerSample / 8} bytes)`);
          }
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
        // Use actual sample rate from capture for input
        // FFmpeg will resample to 48 kHz in output if needed
        console.log(`🎵 Audio input: ${audioChannels} channels at ${audioSampleRate} Hz (raw WASAPI format)`);
        
        ffmpegArgs.push(
          // Audio input - from pipe (32‑bit float little-endian PCM, as provided by WASAPI)
          '-f', 'f32le',
          '-ar', String(audioSampleRate),  // Input sample rate (from capture)
          '-ac', String(audioChannels),  // Use actual channel count from capture
          '-i', 'pipe:0'  // Read audio from stdin
        );
      }

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
        // Build audio encoding args
        const audioCodecArgs = [
          // Audio codec
          '-c:a', 'aac',
          '-b:a', '192k',  // Audio bitrate
        ];
        
        // Utiliser EXACTEMENT la fréquence du device (ex: 44100 Hz),
        // pour éviter tout resampling et artefacts associés
        audioCodecArgs.push('-ar', String(audioSampleRate));
        audioCodecArgs.push('-ac', '2');  // Always output stereo (FFmpeg will downmix if needed)
        // For multi-channel sources (e.g. 7.1), explicitly use front-left/right only to avoid weird artefacts
        // This avoids mixing LFE/center/rear channels into stereo in a way that can sound harsh
        audioCodecArgs.push('-filter:a', 'pan=stereo|c0=c0|c1=c1');
        
        if (audioChannels > 2) {
          console.log(`🎵 Downmixing ${audioChannels} channels to stereo at 48 kHz (output), input rate = ${audioSampleRate} Hz`);
        } else {
          console.log(`🎵 Output: stereo at 48 kHz, input rate = ${audioSampleRate} Hz`);
        }
        
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
        '-shortest',  // Finish encoding when the shortest input stream ends (ensures sync)
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
      // With -shortest flag, FFmpeg should stop when audio ends and finalize
      if (processToStop.stdin && !processToStop.stdin.destroyed) {
        // Wait a bit more to ensure all audio data is written
        await new Promise(resolve => setTimeout(resolve, 200));
        
        console.log('📝 Closing stdin to signal EOF to FFmpeg...');
        console.log('   (With -shortest flag, FFmpeg should stop when audio stream ends)');
        
        // Ensure stdin is flushed before closing
        if (processToStop.stdin.writable) {
          // Force flush any remaining data
          processToStop.stdin.cork();
          processToStop.stdin.uncork();
        }
        
        // End the stdin stream to signal EOF for audio input
        // This tells FFmpeg that the audio stream has ended
        // With -shortest, FFmpeg should stop encoding and finalize
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
      // Avec -shortest, FFmpeg devrait s'arrêter automatiquement quand stdin se ferme
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


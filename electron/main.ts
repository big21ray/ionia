import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn, ChildProcess, exec } from 'child_process';
import fs from 'fs';
import { promisify } from 'util';

const execAsync = promisify(exec);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Recording state
let recordingProcess: ChildProcess | null = null;
let recordingOutputPath: string | null = null;

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

      // FFmpeg command for screen recording
      // Video: gdigrab (Windows screen capture)
      // Audio: Temporarily disabled - WASAPI not available in this FFmpeg build
      // TODO: Add audio support later (may need different FFmpeg build or use dshow/other method)
      const ffmpegArgs = [
        // Video input - screen capture
        '-f', 'gdigrab',
        '-framerate', '30',  // Lock at 30 fps
        '-i', 'desktop',
        
        // Video codec - optimized for RAM usage (max 400 MB)
        '-c:v', 'libx264',
        '-preset', 'veryfast',  // Slightly slower than ultrafast but uses less RAM
        '-crf', '23',
        '-pix_fmt', 'yuv420p',
        '-r', '30',  // Output framerate (match input)
        
        // RAM usage limits (like Medal - max 400 MB)
        '-bufsize', '8M',  // Encoding buffer size (limits RAM for encoding)
        '-maxrate', '10M',  // Maximum bitrate (helps control buffer size)
        '-threads', '2',  // Limit threads to reduce RAM usage
        
        // MP4 container options
        // Note: Removed +faststart as it requires file rewrite at end which may not complete
        // Standard MP4 with metadata at end works fine for most players
        
        // No audio for now (WASAPI not supported in this FFmpeg build)
        // Will add audio support later using alternative method
        
        // Output
        '-y',  // Overwrite output file
        recordingOutputPath
      ];

      console.log('Starting recording with FFmpeg...');
      console.log('Output path:', recordingOutputPath);
      console.log('FFmpeg args:', ffmpegArgs.join(' '));

      return new Promise((resolve) => {
        let errorOccurred = false;
        let ffmpegOutput = '';

        recordingProcess = spawn('ffmpeg', ffmpegArgs, {
          stdio: ['pipe', 'pipe', 'pipe'],  // Use pipe for stdin so we can send 'q' to quit gracefully
          windowsHide: true  // Hide the Windows console window
        });

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
            // Log important lines (frame info, errors)
            const lines = output.split('\n');
            for (const line of lines) {
              const trimmed = line.trim();
              if (trimmed) {
                // Log frame info and errors
                if (trimmed.includes('frame=') || 
                    trimmed.includes('fps=') ||
                    trimmed.toLowerCase().includes('error') ||
                    trimmed.toLowerCase().includes('failed')) {
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
              recordingProcess.on('close', (code) => {
                console.log(`Recording finished with code ${code}`);
                if (code === 0) {
                  console.log('Recording saved to:', recordingOutputPath);
                  // Verify file exists
                  if (recordingOutputPath && !fs.existsSync(recordingOutputPath)) {
                    console.error('Warning: Recording file was not created!');
                  }
                } else if (code !== null && code !== 0) {
                  console.error('Recording failed with code:', code);
                  console.error('FFmpeg output:', ffmpegOutput);
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

  // Handle recording stop
  ipcMain.handle('recording:stop', async () => {
    if (!recordingProcess) {
      return { success: false, error: 'No recording in progress' };
    }

    try {
      const outputPath = recordingOutputPath;
      const processToStop = recordingProcess;
      
      // Clear the reference immediately so UI can update
      recordingProcess = null;
      recordingOutputPath = null;

      // Send 'q' to FFmpeg's stdin to gracefully quit (this finalizes the file)
      // This is more reliable than SIGINT as it tells FFmpeg to finish encoding and write headers
      if (processToStop.stdin && !processToStop.stdin.destroyed) {
        processToStop.stdin.write('q\n');
        processToStop.stdin.end();
      } else {
        // Fallback to SIGINT if stdin is not available
        processToStop.kill('SIGINT');
      }
      
      // Wait for FFmpeg to properly finalize the file
      return new Promise((resolve) => {
        const timeout = setTimeout(() => {
          console.warn('FFmpeg finalization timeout - file may be incomplete');
          // Force kill if it takes too long
          if (!processToStop.killed) {
            processToStop.kill('SIGKILL');
          }
          resolve({ success: true, outputPath, warning: 'Finalization timeout' });
        }, 10000); // 10 second timeout

        processToStop.on('close', (code) => {
          clearTimeout(timeout);
          console.log(`Recording finalized with code ${code}`);
          
          // Longer delay to ensure FFmpeg has written all headers and file system has flushed
          setTimeout(() => {
            if (code === 0 || code === null || code === 130) { // 130 = SIGINT (normal termination)
              // Verify file exists and has content
              if (outputPath && fs.existsSync(outputPath)) {
                const stats = fs.statSync(outputPath);
                console.log(`Recording file size: ${(stats.size / 1024 / 1024).toFixed(2)} MB`);
                if (stats.size > 1024) { // At least 1KB (very short recording)
                  console.log('Recording saved successfully to:', outputPath);
                  resolve({ success: true, outputPath });
                } else {
                  console.error('Recording file is too small (likely incomplete):', stats.size, 'bytes');
                  resolve({ success: false, error: `Recording file is too small (${stats.size} bytes) - may be incomplete` });
                }
              } else {
                console.error('Recording file was not created!');
                resolve({ success: false, error: 'Recording file was not created' });
              }
            } else {
              console.error('Recording finalization failed with code:', code);
              resolve({ success: false, error: `FFmpeg exited with code ${code}` });
            }
          }, 2000); // Wait 2 seconds for FFmpeg to write headers and file system to flush
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


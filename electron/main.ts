import { app, BrowserWindow, dialog, ipcMain } from 'electron';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Load native VideoAudioRecorder module
let VideoAudioRecorder: any = null;
let VideoAudioStreamer: any = null;
try {
  // In development, __dirname points to dist-electron/electron
  // In production, it points to the packaged electron folder
  const isDev = process.env.NODE_ENV === 'development' || !app?.isPackaged;
  const nativeAudioPath = isDev
    ? path.join(__dirname, '../../native-audio')
    : path.join(process.resourcesPath || __dirname, 'native-audio');
  
  // Add DLL directory to PATH so Windows can find FFmpeg DLLs
  // Windows looks for DLLs in: 1) Same dir as .exe, 2) Same dir as .node file, 3) PATH
  const dllPath = path.join(nativeAudioPath, 'build/Release');
  if (fs.existsSync(dllPath)) {
    const currentPath = process.env.PATH || '';
    if (!currentPath.includes(dllPath)) {
      process.env.PATH = `${dllPath};${currentPath}`;
      console.log('📁 Added DLL path to PATH:', dllPath);
    }
  } else {
    console.warn('⚠️ DLL directory not found:', dllPath);
  }
  
  const nativeModule = require(path.join(nativeAudioPath, 'index.js'));
  VideoAudioRecorder = nativeModule.VideoAudioRecorder;
  VideoAudioStreamer = nativeModule.VideoAudioStreamer;
  console.log('✅ Native module loaded successfully from:', nativeAudioPath);
  console.log('📦 Available exports:', Object.keys(nativeModule));
  if (VideoAudioRecorder) {
    console.log('✅ VideoAudioRecorder native module loaded successfully');
  } else {
    console.error('❌ VideoAudioRecorder is null/undefined in native module');
    console.error('Available exports:', Object.keys(nativeModule));
  }

  if (VideoAudioStreamer) {
    console.log('✅ VideoAudioStreamer native module loaded successfully');
  } else {
    console.error('❌ VideoAudioStreamer is null/undefined in native module');
  }
} catch (error) {
  console.error('❌ Failed to load native module:', error);
  console.error('Make sure to run "npm run build:native" first');
}

// Recording state
let videoAudioRecorder: any = null;
let recordingOutputPath: string | null = null;

// Streaming state
let videoAudioStreamer: any = null;
let streamingRtmpUrl: string | null = null;


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

  // Handle recording start - using VideoAudioRecorder like test_video_audio_recorder.js
  ipcMain.handle('recording:start', async () => {
    if (videoAudioRecorder) {
      return { success: false, error: 'Recording already in progress' };
    }

    if (!VideoAudioRecorder) {
      return { success: false, error: 'VideoAudioRecorder not available. Make sure the native module is compiled.' };
    }

    try {
      // Create recordings folder if it doesn't exist
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

      // Debug: Check DLL path before initialization
      const isDev = process.env.NODE_ENV === 'development' || !app?.isPackaged;
      const debugNativeAudioPath = isDev
        ? path.join(__dirname, '../../native-audio')
        : path.join(process.resourcesPath || __dirname, 'native-audio');
      const dllPath = path.join(debugNativeAudioPath, 'build/Release');
      console.log('🔍 Debug: DLL path:', dllPath);
      console.log('🔍 Debug: DLL path exists:', fs.existsSync(dllPath));
      if (fs.existsSync(dllPath)) {
        const dlls = fs.readdirSync(dllPath).filter((f: string) => f.endsWith('.dll'));
        console.log('🔍 Debug: Found DLLs:', dlls.length, 'files');
        const requiredDlls = ['avcodec.dll', 'avformat.dll', 'avutil.dll', 'swresample.dll'];
        for (const dll of requiredDlls) {
          const exists = fs.existsSync(path.join(dllPath, dll));
          console.log(`🔍 Debug: ${dll}: ${exists ? '✅' : '❌'}`);
        }
      }

      // Create VideoAudioRecorder instance
      console.log('🎬 Creating VideoAudioRecorder instance...');
      videoAudioRecorder = new VideoAudioRecorder();

      // Initialize recorder
      // Parameters: outputPath, fps (optional, default 30), videoBitrate (optional, default 5000000), 
      //             useNvenc (optional, default true), audioBitrate (optional, default 192000),
      //             audioMode (optional, default "both" - can be "mic", "desktop", or "both")
      console.log('🔧 Initializing recorder...');
      console.log(`   Output: ${recordingOutputPath}`);
      console.log(`   Settings: 30fps, 5Mbps video, NVENC=true, 192kbps audio, mode=both`);
      console.log('⚠️  IMPORTANT: Check the console ABOVE for C++ error messages starting with [VideoEncoder]');
      console.log('⚠️  These messages appear BEFORE the JavaScript exception and show the real error!');
      
      let initialized: boolean;
      try {
        initialized = videoAudioRecorder.initialize(recordingOutputPath, 30, 5000000, true, 192000, 'both');
      } catch (initError: any) {
        console.error('❌ Exception during VideoAudioRecorder initialization:', initError);
        console.error('Error details:', {
          message: initError?.message,
          stack: initError?.stack,
          name: initError?.name
        });
        console.error('⚠️  The C++ error message should appear ABOVE this line in the console!');
        console.error('⚠️  Look for lines starting with [VideoEncoder] to see the real error.');
        videoAudioRecorder = null;
        recordingOutputPath = null;
        const errorMsg = initError?.message || String(initError);
        return { success: false, error: `Failed to initialize VideoAudioRecorder: ${errorMsg}. Check Electron console ABOVE for [VideoEncoder] error messages.` };
      }
      
      if (!initialized) {
        console.error('❌ Failed to initialize recorder (returned false)');
        console.error('   Check Electron console above for C++ error messages from VideoEncoder');
        console.error('   Common causes:');
        console.error('   - Missing FFmpeg DLLs in native-audio/build/Release/');
        console.error('   - FFmpeg not compiled with H.264 support');
        console.error('   - Codec initialization failed');
        videoAudioRecorder = null;
        recordingOutputPath = null;
        return { success: false, error: 'Failed to initialize recorder. Check Electron console for C++ error details (look for [VideoEncoder] messages).' };
      }
      console.log('✅ Recorder initialized');

      // Start recording
      console.log('▶️  Starting recording...');
      let started: boolean;
      try {
        started = videoAudioRecorder.start();
      } catch (startError: any) {
        console.error('❌ Exception during VideoAudioRecorder start:', startError);
        videoAudioRecorder = null;
        recordingOutputPath = null;
        return { success: false, error: `Failed to start VideoAudioRecorder: ${startError?.message || startError}` };
      }
      
      if (!started) {
        console.error('❌ Failed to start recording (returned false)');
        videoAudioRecorder = null;
        recordingOutputPath = null;
        return { success: false, error: 'Failed to start recording' };
      }
      console.log('✅ Recording started');
      console.log(`📁 Output: ${recordingOutputPath}`);

      return { success: true, outputPath: recordingOutputPath };
    } catch (error) {
      console.error('❌ Error during recording start:', error);
      videoAudioRecorder = null;
      recordingOutputPath = null;
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Handle recording stop - using VideoAudioRecorder like test_video_audio_recorder.js
  ipcMain.handle('recording:stop', async () => {
    if (!videoAudioRecorder) {
      return { success: false, error: 'No recording in progress' };
    }

    try {
      const outputPath = recordingOutputPath;
      const recorderToStop = videoAudioRecorder;
      
      // Stop recording
      console.log('⏹️  Stopping recording...');
      const stopped = recorderToStop.stop();
      
      if (!stopped) {
        console.error('❌ Failed to stop recording');
        videoAudioRecorder = null;
        recordingOutputPath = null;
        return { success: false, error: 'Failed to stop recording' };
      }
      console.log('✅ Recording stopped');

      // Clear the reference
      videoAudioRecorder = null;
      const finalOutputPath = recordingOutputPath;
      recordingOutputPath = null;

      // Wait a bit for file to be finalized
      await new Promise(resolve => setTimeout(resolve, 500));

      // Get final statistics
      const finalStats = recorderToStop.getStatistics();
      console.log('📊 Final Statistics:');
      console.log(`   Video Frames Captured: ${finalStats.videoFramesCaptured}`);
      console.log(`   Video Packets Encoded: ${finalStats.videoPacketsEncoded}`);
      console.log(`   Audio Packets Encoded: ${finalStats.audioPacketsEncoded}`);
      console.log(`   Video Packets Muxed: ${finalStats.videoPacketsMuxed}`);
      console.log(`   Audio Packets Muxed: ${finalStats.audioPacketsMuxed}`);
      console.log(`   Total Bytes: ${finalStats.totalBytes} (${(finalStats.totalBytes / 1024 / 1024).toFixed(2)} MB)`);

      // Verify file exists and is valid
      if (finalOutputPath && fs.existsSync(finalOutputPath)) {
        const stats = fs.statSync(finalOutputPath);
        const fileSizeMB = (stats.size / 1024 / 1024).toFixed(2);
        console.log(`📁 Recording file size: ${fileSizeMB} MB`);
        
        if (stats.size > 1024) {
          console.log('✅ Recording file appears to be valid');
          console.log(`\n🎉 Recording finished successfully!`);
          console.log(`📂 Saved to: ${finalOutputPath}\n`);
          return { success: true, outputPath: finalOutputPath };
        } else {
          console.error('❌ Recording file is too small (likely incomplete):', stats.size, 'bytes');
          return { success: false, error: `Recording file is too small (${stats.size} bytes) - may be incomplete` };
        }
      } else {
        console.error('❌ Recording file was not created!');
        return { success: false, error: 'Recording file was not created' };
      }
    } catch (error) {
      console.error('❌ Error during recording stop:', error);
      videoAudioRecorder = null;
      recordingOutputPath = null;
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Handle streaming start
  ipcMain.handle('stream:start', async (event, rtmpUrl: string) => {
    if (videoAudioStreamer) {
      return { success: false, error: 'Streaming already in progress' };
    }

    if (videoAudioRecorder) {
      return { success: false, error: 'Recording in progress. Stop recording before starting stream.' };
    }

    if (!VideoAudioStreamer) {
      return { success: false, error: 'VideoAudioStreamer not available. Make sure the native module is compiled.' };
    }

    if (!rtmpUrl || rtmpUrl.trim() === '') {
      return { success: false, error: 'RTMP URL is required' };
    }

    try {
      streamingRtmpUrl = rtmpUrl.trim();
      console.log('📡 Starting stream to:', streamingRtmpUrl);

      console.log('🎥 Creating VideoAudioStreamer instance...');
      videoAudioStreamer = new VideoAudioStreamer();

      console.log('🔧 Initializing streamer...');
      console.log('   Settings: 30fps, 5Mbps video, NVENC=true, 192kbps audio, mode=both');
      let initialized: boolean;
      try {
        initialized = videoAudioStreamer.initialize(streamingRtmpUrl, 30, 5000000, true, 192000, 'both');
      } catch (initError: any) {
        console.error('❌ Exception during VideoAudioStreamer initialization:', initError);
        videoAudioStreamer = null;
        streamingRtmpUrl = null;
        const errorMsg = initError?.message || String(initError);
        return { success: false, error: `Failed to initialize stream: ${errorMsg}` };
      }

      if (!initialized) {
        console.error('❌ Failed to initialize stream (returned false)');
        videoAudioStreamer = null;
        streamingRtmpUrl = null;
        return { success: false, error: 'Failed to initialize stream. Check Electron console for C++ error details.' };
      }

      console.log('▶️  Starting stream...');
      let started: boolean;
      try {
        started = videoAudioStreamer.start();
      } catch (startError: any) {
        console.error('❌ Exception during VideoAudioStreamer start:', startError);
        videoAudioStreamer = null;
        streamingRtmpUrl = null;
        return { success: false, error: `Failed to start stream: ${startError?.message || startError}` };
      }

      if (!started) {
        console.error('❌ Failed to start stream (returned false)');
        videoAudioStreamer = null;
        streamingRtmpUrl = null;
        return { success: false, error: 'Failed to start stream' };
      }

      console.log('✅ Streaming started');
      return { success: true, rtmpUrl: streamingRtmpUrl };
    } catch (error) {
      console.error('❌ Error during stream start:', error);
      videoAudioStreamer = null;
      streamingRtmpUrl = null;
      return { success: false, error: error instanceof Error ? error.message : 'Unknown error' };
    }
  });

  // Handle streaming stop
  ipcMain.handle('stream:stop', async () => {
    if (!videoAudioStreamer) {
      return { success: false, error: 'No streaming in progress' };
    }

    try {
      const streamerToStop = videoAudioStreamer;
      const rtmpUrl = streamingRtmpUrl;
      
      console.log('⏹️  Stopping stream...');

      let stopped: boolean;
      try {
        stopped = streamerToStop.stop();
      } catch (stopError: any) {
        console.error('❌ Exception during VideoAudioStreamer stop:', stopError);
        videoAudioStreamer = null;
        streamingRtmpUrl = null;
        return { success: false, error: `Failed to stop stream: ${stopError?.message || stopError}` };
      }

      if (!stopped) {
        console.error('❌ Failed to stop stream (returned false)');
        videoAudioStreamer = null;
        streamingRtmpUrl = null;
        return { success: false, error: 'Failed to stop stream' };
      }
      
      videoAudioStreamer = null;
      streamingRtmpUrl = null;
      
      console.log('✅ Stream stopped');
      return { success: true, rtmpUrl };
    } catch (error) {
      console.error('❌ Error during stream stop:', error);
      videoAudioStreamer = null;
      streamingRtmpUrl = null;
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


/// <reference types="vite/client" />

interface ElectronAPI {
  openFileDialog: () => Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;
  startRecording: () => Promise<{
    success: boolean;
    outputPath?: string;
    error?: string;
  }>;
  stopRecording: () => Promise<{
    success: boolean;
    outputPath?: string;
    error?: string;
  }>;
  startStream: (rtmpUrl: string) => Promise<{
    success: boolean;
    rtmpUrl?: string;
    error?: string;
  }>;
  stopStream: () => Promise<{
    success: boolean;
    rtmpUrl?: string;
    error?: string;
  }>;
}

interface Window {
  electronAPI: ElectronAPI;
}



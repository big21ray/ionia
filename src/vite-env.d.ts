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
}

interface Window {
  electronAPI: ElectronAPI;
}



/// <reference types="vite/client" />

interface ElectronAPI {
  openFileDialog: () => Promise<{
    canceled: boolean;
    filePaths: string[];
  }>;
  startRecording: (
    mode?: 'both' | 'desktop' | 'mic'
  ) => Promise<{
    success: boolean;
    outputPath?: string;
    error?: string;
  }>;
  stopRecording: () => Promise<{
    success: boolean;
    outputPath?: string;
    error?: string;
  }>;
  getAudioStatus: () => Promise<{
    hasAudio: boolean;
    bytesReceived: number;
    format: {
      sampleRate: number;
      channels: number;
      bitsPerSample: number;
      blockAlign: number;
      bytesPerSecond: number;
    } | null;
    hasNativeModule: boolean;
  }>;
}

interface Window {
  electronAPI: ElectronAPI;
}



const { contextBridge, ipcRenderer } = require('electron');

// Expose protected methods that allow the renderer process to use
// the ipcRenderer without exposing the entire object
contextBridge.exposeInMainWorld('electronAPI', {
  openFileDialog: () => ipcRenderer.invoke('dialog:openFile'),
  startRecording: (mode) => ipcRenderer.invoke('recording:start', mode),
  stopRecording: () => ipcRenderer.invoke('recording:stop'),
  getAudioStatus: () => ipcRenderer.invoke('recording:audioStatus'),
});



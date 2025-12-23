import { useState, useEffect } from 'react';

interface RecordingButtonProps {
  className?: string;
}

const RecordingButton = ({ className = '' }: RecordingButtonProps) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const [audioStatus, setAudioStatus] = useState<{
    hasAudio: boolean;
    bytesReceived: number;
    format: any;
    hasNativeModule: boolean;
  } | null>(null);

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    let audioStatusInterval: NodeJS.Timeout | null = null;
    
    if (isRecording) {
      interval = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);

      // Check audio status periodically
      const checkAudioStatus = async () => {
        try {
          const status = await window.electronAPI?.getAudioStatus();
          if (status) {
            setAudioStatus(status);
          }
        } catch (error) {
          console.error('Failed to get audio status:', error);
        }
      };

      // Check immediately and then every 2 seconds
      checkAudioStatus();
      audioStatusInterval = setInterval(checkAudioStatus, 2000);
    } else {
      setRecordingTime(0);
      setAudioStatus(null);
    }

    return () => {
      if (interval) clearInterval(interval);
      if (audioStatusInterval) clearInterval(audioStatusInterval);
    };
  }, [isRecording]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleToggleRecording = async () => {
    try {
      if (isRecording) {
        // Stop recording - update UI immediately
        setIsRecording(false);
        
        // Stop recording in background
        const result = await window.electronAPI?.stopRecording();
        if (!result?.success) {
          console.error('Failed to stop recording:', result);
          // UI already updated, just log the error
          alert(`Failed to stop recording: ${result?.error || 'Unknown error'}`);
        }
      } else {
        // Start recording
        const result = await window.electronAPI?.startRecording();
        console.log('Recording result:', result);
        if (result?.success) {
          setIsRecording(true);
        } else {
          console.error('Failed to start recording:', result);
          const errorMsg = result?.error || result?.message || 'Unknown error. Check console for details.';
          alert(`Failed to start recording: ${errorMsg}`);
        }
      }
    } catch (error) {
      console.error('Recording error:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      alert(`Recording error: ${errorMsg}`);
      // Make sure UI state is correct on error
      if (isRecording) {
        setIsRecording(false);
      }
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  return (
    <div className="flex flex-col items-start space-y-2">
    <button
      onClick={handleToggleRecording}
      className={`flex items-center space-x-2 px-4 py-2 rounded-lg transition-all ${
        isRecording
          ? 'bg-red-600 hover:bg-red-700 text-white'
          : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
      } ${className}`}
      title={isRecording ? 'Stop Recording' : 'Start Recording'}
    >
      <div className={`w-3 h-3 rounded-full ${isRecording ? 'bg-white animate-pulse' : 'bg-gray-400'}`} />
      <span className="text-sm font-semibold">
        {isRecording ? `REC ${formatTime(recordingTime)}` : 'REC'}
      </span>
    </button>
      
      {isRecording && audioStatus && (
        <div className="text-xs text-gray-400 bg-gray-800 px-3 py-2 rounded">
          {audioStatus.hasAudio ? (
            <div className="flex flex-col space-y-1">
              <div className="flex items-center space-x-2">
                <span className="text-green-400">🎤</span>
                <span>Audio: Desktop + Mic (Mixed)</span>
              </div>
              {audioStatus.format && (
                <div className="text-gray-500 pl-5">
                  {audioStatus.format.sampleRate}Hz, {audioStatus.format.channels}ch
                </div>
              )}
              {audioStatus.bytesReceived > 0 && (
                <div className="text-gray-500 pl-5">
                  {formatBytes(audioStatus.bytesReceived)} captured
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center space-x-2">
              <span className="text-yellow-400">⚠️</span>
              <span>Audio: {audioStatus.hasNativeModule ? 'Not capturing' : 'Module not loaded'}</span>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default RecordingButton;


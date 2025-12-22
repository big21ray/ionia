import { useState, useEffect } from 'react';

interface RecordingButtonProps {
  className?: string;
}

const RecordingButton = ({ className = '' }: RecordingButtonProps) => {
  const [isRecording, setIsRecording] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    
    if (isRecording) {
      interval = setInterval(() => {
        setRecordingTime((prev) => prev + 1);
      }, 1000);
    } else {
      setRecordingTime(0);
    }

    return () => {
      if (interval) clearInterval(interval);
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

  return (
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
  );
};

export default RecordingButton;


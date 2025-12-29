import { useState, useEffect } from 'react';

interface StreamButtonProps {
  className?: string;
}

const StreamButton = ({ className = '' }: StreamButtonProps) => {
  const [isStreaming, setIsStreaming] = useState(false);
  const [streamTime, setStreamTime] = useState(0);

  useEffect(() => {
    let interval: NodeJS.Timeout | null = null;
    
    if (isStreaming) {
      interval = setInterval(() => {
        setStreamTime((prev) => prev + 1);
      }, 1000);
    } else {
      setStreamTime(0);
    }

    return () => {
      if (interval) clearInterval(interval);
    };
  }, [isStreaming]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  };

  const handleToggleStream = async () => {
    try {
      if (isStreaming) {
        // Stop streaming - update UI immediately
        setIsStreaming(false);
        
        // Stop streaming in background
        const result = await window.electronAPI?.stopStream();
        if (!result?.success) {
          console.error('Failed to stop streaming:', result);
          alert(`Failed to stop streaming: ${result?.error || 'Unknown error'}`);
          // Restore UI state on error
          setIsStreaming(true);
        } else {
          console.log('✅ Streaming stopped successfully');
        }
      } else {
        // Start streaming with hardcoded YouTube stream key
        const streamKey = '3avj-5j6r-utec-qp7m-86hq';
        const rtmpUrl = `rtmp://a.rtmp.youtube.com/live2/${streamKey}`;

        // Start streaming
        const result = await window.electronAPI?.startStream(rtmpUrl);
        console.log('Streaming result:', result);
        if (result?.success) {
          setIsStreaming(true);
        } else {
          console.error('Failed to start streaming:', result);
          const errorMsg = result?.error || result?.message || 'Unknown error. Check console for details.';
          alert(`Failed to start streaming: ${errorMsg}`);
        }
      }
    } catch (error) {
      console.error('Streaming error:', error);
      const errorMsg = error instanceof Error ? error.message : String(error);
      alert(`Streaming error: ${errorMsg}`);
      // Make sure UI state is correct on error
      if (isStreaming) {
        setIsStreaming(false);
      }
    }
  };

  return (
    <button
      onClick={handleToggleStream}
      className={`flex items-center space-x-2 px-4 py-2 rounded-lg text-sm font-semibold transition-all ${
        isStreaming
          ? 'bg-purple-600 hover:bg-purple-700 text-white'
          : 'bg-gray-700 hover:bg-gray-600 text-gray-200'
      } ${className}`}
      title={isStreaming ? 'Stop streaming' : 'Start streaming (YouTube)'}
    >
      <div
        className={`w-3 h-3 rounded-full ${
          isStreaming ? 'bg-white animate-pulse' : 'bg-gray-400'
        }`}
      />
      <span>
        {isStreaming ? `LIVE ${formatTime(streamTime)}` : 'STREAM'}
      </span>
    </button>
  );
};

export default StreamButton;




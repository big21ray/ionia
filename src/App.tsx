import { useState } from 'react';
import VideoPlayer from './components/VideoPlayer';
import FileBrowser from './components/FileBrowser';
import RecordingButton from './components/RecordingButton';
import StreamButton from './components/StreamButton';

function App() {
  const [videoPath, setVideoPath] = useState<string | null>(null);

  const handleFileSelect = (path: string) => {
    setVideoPath(path);
  };

  return (
    <div className="w-screen h-screen bg-black overflow-hidden relative">
      {/* Recording Button - Top Left */}
      <div className="absolute top-4 left-4 z-50 flex items-center space-x-2">
        <RecordingButton />
        <StreamButton />
      </div>

      {videoPath ? (
        <VideoPlayer videoPath={videoPath} />
      ) : (
        <div className="flex items-center justify-center h-full">
          <FileBrowser onFileSelect={handleFileSelect} />
        </div>
      )}
    </div>
  );
}

export default App;


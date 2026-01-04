import { useEffect, useState } from 'react';
import VideoPlayer from './components/VideoPlayer';
import FileBrowser from './components/FileBrowser';
import RecordingButton from './components/RecordingButton';
import StreamButton from './components/StreamButton';
import WebVideoPlayer from './components/WebVideoPlayer';

function App() {
  const [videoPath, setVideoPath] = useState<string | null>(null);
  const [webSrc, setWebSrc] = useState<string | null>(null);

  // Browser-friendly entry point: /player/?src=/vod-raw/live/foo.flv
  useEffect(() => {
    try {
      const src = new URL(window.location.href).searchParams.get('src');
      if (src) {
        setWebSrc(src);
      }
    } catch {
      // Ignore invalid URL environments.
    }
  }, []);

  const toIoniaVideoUrl = (pathOrUrl: string) =>
    `ionia-video://open?path=${encodeURIComponent(pathOrUrl)}`;

  const handleFileSelect = (path: string) => {
    if (
      path.startsWith('blob:') ||
      path.startsWith('ionia-video://') ||
      path.startsWith('http://') ||
      path.startsWith('https://')
    ) {
      setVideoPath(path);
      return;
    }

    // Covers raw Windows paths and file:// URLs.
    setVideoPath(toIoniaVideoUrl(path));
  };

  const isElectron = typeof window !== 'undefined' && !!(window as any).electronAPI;

  // Hosted player mode: /player/?src=...
  // Never show local (Electron) controls in this mode.
  if (webSrc) {
    return <WebVideoPlayer src={webSrc} />;
  }

  return (
    <div className="w-screen h-screen bg-black overflow-hidden relative">
      {/* Local (Electron) controls only */}
      {isElectron && !webSrc && (
        <div className="absolute top-4 left-4 z-50 flex items-center space-x-2">
          <RecordingButton />
          <StreamButton />
        </div>
      )}

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


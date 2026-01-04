import VideoPlayer from './VideoPlayer';

interface WebVideoPlayerProps {
  src: string;
}

const WebVideoPlayer = ({ src }: WebVideoPlayerProps) => {
  return (
    <div className="w-screen h-screen bg-black overflow-hidden relative">
      <VideoPlayer videoPath={src} mode="web" />
    </div>
  );
};

export default WebVideoPlayer;

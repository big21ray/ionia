import { useRef, useState, useEffect } from 'react';

interface VideoPlayerProps {
  videoPath: string;
  mode?: 'web' | 'electron';
}

const VideoPlayer = ({ videoPath, mode = 'electron' }: VideoPlayerProps) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const flvPlayerRef = useRef<any>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [showControls, setShowControls] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const [previousVolume, setPreviousVolume] = useState(1);
  const [playbackSpeed, setPlaybackSpeed] = useState(1.0);
  const [showSpeedIndicator, setShowSpeedIndicator] = useState(false);
  const [showSpeedMenu, setShowSpeedMenu] = useState(false);
  const speedMenuRef = useRef<HTMLDivElement>(null);
  const inactivityTimerRef = useRef<NodeJS.Timeout | null>(null);
  const speedIndicatorTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    let cancelled = false;
    const video = videoRef.current;
    if (!video) return;

    const cleanupFlv = () => {
      const flvPlayer = flvPlayerRef.current;
      if (!flvPlayer) return;
      try {
        flvPlayer.pause();
      } catch {
        // ignore
      }
      try {
        flvPlayer.unload();
      } catch {
        // ignore
      }
      try {
        flvPlayer.detachMediaElement();
      } catch {
        // ignore
      }
      try {
        flvPlayer.destroy();
      } catch {
        // ignore
      }
      flvPlayerRef.current = null;
    };

    const setNativeSrc = () => {
      cleanupFlv();
      video.src = videoPath;
      video.load();
    };

    const attachFlvIfPossible = async () => {
      cleanupFlv();

      // Only the hosted web player uses flv.js.
      if (mode !== 'web') {
        setNativeSrc();
        return;
      }

      const isFlv = /\.flv(\?|#|$)/i.test(videoPath);
      if (!isFlv) {
        setNativeSrc();
        return;
      }

      const flvjsModule = await import('flv.js');
      const flvjs = flvjsModule.default;
      if (cancelled) return;

      if (!flvjs?.isSupported?.()) {
        setNativeSrc();
        return;
      }

      video.removeAttribute('src');
      video.load();

      const player = flvjs.createPlayer(
        {
          type: 'flv',
          url: videoPath,
        },
        {
          enableStashBuffer: false,
        },
      );

      player.attachMediaElement(video);
      player.load();
      flvPlayerRef.current = player;
    };

    void attachFlvIfPossible();

    return () => {
      cancelled = true;
      cleanupFlv();
    };
  }, [videoPath, mode]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const updateTime = () => setCurrentTime(video.currentTime);
    const updateDuration = () => setDuration(video.duration);

    video.addEventListener('timeupdate', updateTime);
    video.addEventListener('loadedmetadata', updateDuration);

    // Apply playback speed
    video.playbackRate = playbackSpeed;

    return () => {
      video.removeEventListener('timeupdate', updateTime);
      video.removeEventListener('loadedmetadata', updateDuration);
    };
  }, [playbackSpeed]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyPress = (e: KeyboardEvent) => {
      // Only handle if video player is focused (window is selected)
      // Don't interfere with input fields or text areas
      const activeElement = document.activeElement;
      if (
        activeElement?.tagName === 'INPUT' ||
        activeElement?.tagName === 'TEXTAREA' ||
        (activeElement instanceof HTMLElement && activeElement.isContentEditable)
      ) {
        return;
      }

      const video = videoRef.current;
      if (!video) return;

      const key = e.key;
      const isCtrl = e.ctrlKey || e.metaKey;
      const currentSpeed = video.playbackRate; // Get current speed from video element

      // Handle different keyboard shortcuts
      switch (key) {
        // Play/Pause
        case ' ':
        case 'p':
        case 'P':
          e.preventDefault(); // Prevent page scroll on space
          if (video.paused) {
            video.play();
            setIsPlaying(true);
          } else {
            video.pause();
            setIsPlaying(false);
          }
          showControlsAndStartTimer();
          break;

        // Mute/Unmute
        case 'm':
        case 'M':
          e.preventDefault();
          // Use the existing toggleMute logic
          if (video.volume === 0) {
            // Unmute - restore to 0.5 if no previous volume
            video.volume = 0.5;
            setVolume(0.5);
            setIsMuted(false);
          } else {
            // Mute - save current volume and set to 0
            setPreviousVolume(video.volume);
            video.volume = 0;
            setVolume(0);
            setIsMuted(true);
          }
          setShowControls(true);
          break;

        // Fullscreen
        case 'f':
        case 'F':
          e.preventDefault();
          toggleFullscreen();
          showControlsAndStartTimer();
          break;

        // Skip backward/forward (speed-dependent: 3 seconds * playback speed)
        case 'ArrowLeft':
          e.preventDefault();
          const skipBackwardAmount = 3 * currentSpeed;
          video.currentTime = Math.max(0, video.currentTime - skipBackwardAmount);
          setCurrentTime(video.currentTime);
          setShowControls(true);
          break;
        case 'ArrowRight':
          e.preventDefault();
          const skipForwardAmount = 3 * currentSpeed;
          const maxTime = duration || video.duration || 0;
          video.currentTime = Math.min(maxTime, video.currentTime + skipForwardAmount);
          setCurrentTime(video.currentTime);
          showControlsAndStartTimer();
          break;

        // Delete/Backspace - go back 15 seconds
        case 'Delete':
        case 'Backspace':
          e.preventDefault();
          if (isCtrl) {
            // Ctrl+Delete: go back 30 seconds
            video.currentTime = Math.max(0, video.currentTime - 30);
            setCurrentTime(video.currentTime);
          } else {
            // Delete: go back 15 seconds
            video.currentTime = Math.max(0, video.currentTime - 15);
            setCurrentTime(video.currentTime);
          }
          setShowControls(true);
          break;

        // Number keys 1-6 for speed selection
        case '1':
          e.preventDefault();
          e.stopPropagation();
          setPlaybackSpeed(0.2);
          video.playbackRate = 0.2;
          showControlsAndStartTimer();
          setShowSpeedIndicator(true);
          if (speedIndicatorTimerRef.current) {
            clearTimeout(speedIndicatorTimerRef.current);
          }
          speedIndicatorTimerRef.current = setTimeout(() => {
            setShowSpeedIndicator(false);
          }, 2000);
          break;
        case '2':
          e.preventDefault();
          e.stopPropagation();
          setPlaybackSpeed(0.5);
          video.playbackRate = 0.5;
          showControlsAndStartTimer();
          setShowSpeedIndicator(true);
          if (speedIndicatorTimerRef.current) {
            clearTimeout(speedIndicatorTimerRef.current);
          }
          speedIndicatorTimerRef.current = setTimeout(() => {
            setShowSpeedIndicator(false);
          }, 2000);
          break;
        case '3':
          e.preventDefault();
          e.stopPropagation();
          setPlaybackSpeed(1.0);
          video.playbackRate = 1.0;
          showControlsAndStartTimer();
          setShowSpeedIndicator(true);
          if (speedIndicatorTimerRef.current) {
            clearTimeout(speedIndicatorTimerRef.current);
          }
          speedIndicatorTimerRef.current = setTimeout(() => {
            setShowSpeedIndicator(false);
          }, 2000);
          break;
        case '4':
          e.preventDefault();
          e.stopPropagation();
          setPlaybackSpeed(1.5);
          video.playbackRate = 1.5;
          showControlsAndStartTimer();
          setShowSpeedIndicator(true);
          if (speedIndicatorTimerRef.current) {
            clearTimeout(speedIndicatorTimerRef.current);
          }
          speedIndicatorTimerRef.current = setTimeout(() => {
            setShowSpeedIndicator(false);
          }, 2000);
          break;
        case '5':
          e.preventDefault();
          e.stopPropagation();
          setPlaybackSpeed(2.0);
          video.playbackRate = 2.0;
          showControlsAndStartTimer();
          setShowSpeedIndicator(true);
          if (speedIndicatorTimerRef.current) {
            clearTimeout(speedIndicatorTimerRef.current);
          }
          speedIndicatorTimerRef.current = setTimeout(() => {
            setShowSpeedIndicator(false);
          }, 2000);
          break;
        case '6':
          e.preventDefault();
          e.stopPropagation();
          setPlaybackSpeed(5.0);
          video.playbackRate = 5.0;
          showControlsAndStartTimer();
          setShowSpeedIndicator(true);
          if (speedIndicatorTimerRef.current) {
            clearTimeout(speedIndicatorTimerRef.current);
          }
          speedIndicatorTimerRef.current = setTimeout(() => {
            setShowSpeedIndicator(false);
          }, 2000);
          break;
        default:
          return;
      }
    };

    window.addEventListener('keydown', handleKeyPress);
    return () => {
      window.removeEventListener('keydown', handleKeyPress);
      if (speedIndicatorTimerRef.current) {
        clearTimeout(speedIndicatorTimerRef.current);
      }
    };
  }, [isMuted, previousVolume]);

  // Start timer to hide controls after 3 seconds of being shown
  const startHideTimer = () => {
    // Clear existing timer
    if (inactivityTimerRef.current) {
      clearTimeout(inactivityTimerRef.current);
      inactivityTimerRef.current = null;
    }

    // Set timer to hide controls after 3 seconds
    inactivityTimerRef.current = setTimeout(() => {
      setShowControls(false);
    }, 3000);
  };

  // Show controls and start hide timer - call this on any interaction
  const showControlsAndStartTimer = () => {
    setShowControls(true);
    startHideTimer();
  };

  // Handle hover on control elements - show controls
  const handleControlsHover = () => {
    setShowControls(true);
    startHideTimer();
  };

  // Handle mouse leave from control area - hide after timer
  const handleControlsLeave = () => {
    // Don't hide immediately, let the timer handle it
    // Timer will hide after 3 seconds if no interaction
  };

  // Cleanup timers on unmount
  useEffect(() => {
    return () => {
      if (inactivityTimerRef.current) {
        clearTimeout(inactivityTimerRef.current);
      }
    };
  }, []);

  // Close speed menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (speedMenuRef.current && !speedMenuRef.current.contains(event.target as Node)) {
        setShowSpeedMenu(false);
      }
    };

    if (showSpeedMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
    };
  }, [showSpeedMenu]);

  // Available playback speeds
  const speedOptions = [0.2, 0.5, 1.0, 1.5, 2.0, 5.0];

  const handleSpeedChange = (speed: number) => {
    const video = videoRef.current;
    if (!video) return;

    setPlaybackSpeed(speed);
    video.playbackRate = speed;
    setShowSpeedMenu(false);
    setShowControls(true);
    setShowSpeedIndicator(true);
    
    if (speedIndicatorTimerRef.current) {
      clearTimeout(speedIndicatorTimerRef.current);
    }
    speedIndicatorTimerRef.current = setTimeout(() => {
      setShowSpeedIndicator(false);
    }, 2000);
  };

  const togglePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;

    if (isPlaying) {
      video.pause();
    } else {
      video.play();
    }
    setIsPlaying(!isPlaying);
    showControlsAndStartTimer(); // Show controls and start timer
  };

  const skipBackward = () => {
    const video = videoRef.current;
    if (!video) return;
    const skipAmount = 3 * playbackSpeed;
    video.currentTime = Math.max(0, video.currentTime - skipAmount);
    setCurrentTime(video.currentTime);
    showControlsAndStartTimer(); // Show controls and start timer
  };

  const skipForward = () => {
    const video = videoRef.current;
    if (!video) return;
    const skipAmount = 3 * playbackSpeed;
    video.currentTime = Math.min(duration, video.currentTime + skipAmount);
    setCurrentTime(video.currentTime);
    showControlsAndStartTimer(); // Show controls and start timer
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;

    const newTime = parseFloat(e.target.value);
    video.currentTime = newTime;
    setCurrentTime(newTime);
    showControlsAndStartTimer(); // Show controls but don't reset inactivity timer
  };

  const handleVolumeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const video = videoRef.current;
    if (!video) return;

    const newVolume = parseFloat(e.target.value);
    video.volume = newVolume;
    setVolume(newVolume);
    setIsMuted(newVolume === 0);
    if (newVolume > 0) {
      setPreviousVolume(newVolume);
    }
    showControlsAndStartTimer(); // Show controls but don't reset inactivity timer
  };

  const toggleMute = () => {
    const video = videoRef.current;
    if (!video) return;

    if (isMuted) {
      // Unmute - restore previous volume
      video.volume = previousVolume > 0 ? previousVolume : 0.5;
      setVolume(video.volume);
      setIsMuted(false);
    } else {
      // Mute - save current volume and set to 0
      setPreviousVolume(volume);
      video.volume = 0;
      setVolume(0);
      setIsMuted(true);
    }
    showControlsAndStartTimer(); // Show controls but don't reset inactivity timer
  };

  const toggleFullscreen = () => {
    const container = containerRef.current;
    if (!container) return;

    if (!document.fullscreenElement) {
      // Enter fullscreen
      container.requestFullscreen().catch((err) => {
        console.error('Error attempting to enable fullscreen:', err);
      });
    } else {
      // Exit fullscreen
      document.exitFullscreen().catch((err) => {
        console.error('Error attempting to exit fullscreen:', err);
      });
    }
  };

  const formatTime = (seconds: number): string => {
    if (isNaN(seconds)) return '0:00';
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div
      ref={containerRef}
      className="relative w-full h-full bg-black"
    >
      {/* Video */}
      <video
        ref={videoRef}
        className="w-full h-full object-contain"
        onPlay={() => setIsPlaying(true)}
        onPause={() => setIsPlaying(false)}
      />

      {/* Speed Indicator */}
      {showSpeedIndicator && (
        <div className="absolute top-4 left-1/2 transform -translate-x-1/2 bg-black bg-opacity-70 px-6 py-3 rounded-lg pointer-events-none z-50">
          <div className="flex items-center space-x-2">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="w-5 h-5 text-white"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M3.75 13.5l10.5-11.25L12 10.5h8.25L9.75 21.75 12 13.5H3.75z"
              />
            </svg>
            <span className="text-white text-lg font-semibold">
              {playbackSpeed}x Speed
            </span>
          </div>
        </div>
      )}

      {/* Overlay Controls - Always rendered, visibility controlled */}
      <div className={`absolute inset-0 flex flex-col justify-between pointer-events-none transition-opacity ${showControls ? 'opacity-100' : 'opacity-0'}`}>
        {/* Center Controls */}
        <div 
          className="flex-1 flex items-center justify-center pointer-events-auto"
          onMouseEnter={handleControlsHover}
          onMouseLeave={handleControlsLeave}
        >
            <div className="flex items-center space-x-6">
              {/* Skip Backward Button */}
              <button
                onClick={skipBackward}
                className="w-14 h-14 rounded-full bg-black bg-opacity-30 hover:bg-opacity-50 flex items-center justify-center text-white transition-all"
                title={`Skip -${(3 * playbackSpeed).toFixed(1)} seconds`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                  className="w-6 h-6"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21 16.811c0 .864-.933 1.405-1.683.977l-7.108-4.062a1.125 1.125 0 010-1.953l7.108-4.062A1.125 1.125 0 0121 8.688v8.123zM11.25 16.811c0 .864-.933 1.405-1.683.977l-7.108-4.062a1.125 1.125 0 010-1.953l7.108-4.062a1.125 1.125 0 011.683.977v8.123z"
                  />
                </svg>
              </button>

              {/* Play/Pause Button */}
              <button
                onClick={togglePlayPause}
                className="w-20 h-20 rounded-full bg-black bg-opacity-30 hover:bg-opacity-50 flex items-center justify-center text-white transition-all"
              >
                {isPlaying ? (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                    className="w-10 h-10"
                  >
                    <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                  </svg>
                ) : (
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    fill="currentColor"
                    viewBox="0 0 24 24"
                    className="w-10 h-10 ml-1"
                  >
                    <path d="M8 5v14l11-7z" />
                  </svg>
                )}
              </button>

              {/* Skip Forward Button */}
              <button
                onClick={skipForward}
                className="w-14 h-14 rounded-full bg-black bg-opacity-30 hover:bg-opacity-50 flex items-center justify-center text-white transition-all"
                title={`Skip +${(3 * playbackSpeed).toFixed(1)} seconds`}
              >
                <svg
                  xmlns="http://www.w3.org/2000/svg"
                  fill="none"
                  viewBox="0 0 24 24"
                  strokeWidth={2}
                  stroke="currentColor"
                  className="w-6 h-6"
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M3 8.688c0-.864.933-1.405 1.683-.977l7.108 4.062a1.125 1.125 0 010 1.953l-7.108 4.062A1.125 1.125 0 013 16.81V8.688zM12.75 8.688c0-.864.933-1.405 1.683-.977l7.108 4.062a1.125 1.125 0 010 1.953l-7.108 4.062a1.125 1.125 0 01-1.683-.977V8.688z"
                  />
                </svg>
              </button>
            </div>
          </div>

        {/* Bottom Controls Bar - Timeline */}
        <div 
          className="bg-gradient-to-t from-black via-black to-transparent pb-[5px] pt-1 pointer-events-auto"
          onMouseEnter={handleControlsHover}
          onMouseLeave={handleControlsLeave}
        >
            {/* Progress Bar */}
            <div className="px-4 mb-0.5">
              <input
                type="range"
                min="0"
                max={duration || 0}
                value={currentTime}
                onChange={handleSeek}
                className="w-full h-px bg-gray-700 rounded cursor-pointer accent-white"
                style={{
                  background: `linear-gradient(to right, white 0%, white ${(currentTime / duration) * 100}%, #374151 ${(currentTime / duration) * 100}%, #374151 100%)`,
                }}
              />
            </div>

            {/* Time and Volume */}
            <div className="flex items-center justify-between px-4 py-0.5">
              <div className="flex items-center space-x-4">
                <span className="text-xs text-white">
                  {formatTime(currentTime)} / {formatTime(duration)}
                </span>
                <div className="relative" ref={speedMenuRef}>
                  <button
                    onClick={() => {
                      setShowSpeedMenu(!showSpeedMenu);
                      setShowControls(true);
                    }}
                    className="text-sm text-gray-400 hover:text-white transition-colors cursor-pointer px-2 py-1 rounded hover:bg-white hover:bg-opacity-10"
                    title="Change playback speed"
                  >
                    {playbackSpeed}x
                  </button>
                  {showSpeedMenu && (
                    <div className="absolute bottom-full mb-2 left-0 bg-black bg-opacity-90 rounded-lg shadow-lg py-2 min-w-[80px] z-50">
                      {speedOptions.map((speed) => (
                        <button
                          key={speed}
                          onClick={() => handleSpeedChange(speed)}
                          className={`w-full text-left px-4 py-2 text-sm hover:bg-white hover:bg-opacity-20 transition-colors ${
                            playbackSpeed === speed
                              ? 'text-white font-semibold bg-white bg-opacity-10'
                              : 'text-gray-300'
                          }`}
                        >
                          {speed}x
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="flex items-center space-x-2">
                <button
                  onClick={toggleMute}
                  className="cursor-pointer hover:opacity-80 transition-opacity"
                  title={isMuted ? 'Unmute' : 'Mute'}
                >
                  {isMuted || volume === 0 ? (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={1.5}
                      stroke="currentColor"
                      className="w-4 h-4 text-white"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M17.25 9.75L19.5 12m0 0l2.25 2.25M19.5 12l2.25-2.25M19.5 12l-2.25 2.25m-7.5-6l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
                      />
                    </svg>
                  ) : (
                    <svg
                      xmlns="http://www.w3.org/2000/svg"
                      fill="none"
                      viewBox="0 0 24 24"
                      strokeWidth={1.5}
                      stroke="currentColor"
                      className="w-4 h-4 text-white"
                    >
                      <path
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        d="M19.114 5.636a9 9 0 010 12.728M16.463 8.288a5.25 5.25 0 010 7.424M6.75 8.25l4.72-4.72a.75.75 0 011.28.53v15.88a.75.75 0 01-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.01 9.01 0 012.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75z"
                      />
                    </svg>
                  )}
                </button>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={volume}
                  onChange={handleVolumeChange}
                  className="w-24 h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer accent-white"
                />
                <span className="text-xs text-white w-12">
                  {Math.round(volume * 100)}%
                </span>
              </div>
            </div>
          </div>
      </div>
    </div>
  );
};

export default VideoPlayer;


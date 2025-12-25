# Ionia Video Player - Features

This document tracks current features, planned features, and features under consideration.

## ✅ Implemented Features

### Phase 1: Basic Setup & Player
- [x] Electron project setup with React + TypeScript
- [x] Basic HTML5 video player
- [x] Play/pause controls
- [x] Volume control with mute toggle
- [x] Seek/scrub functionality
- [x] File browser to load videos
- [x] Basic UI layout with hover controls

### Timeline Component
- [x] Canvas-based timeline rendering
- [x] Time markers (current time / total duration)
- [x] Playback position indicator
- [x] Click-to-seek functionality
- [x] Thin timeline design

### Playback Controls
- [x] Play/pause button (centered, icon-based)
- [x] Skip backward/forward buttons (-5/+5 seconds, speed-dependent)
- [x] Volume control with mute toggle
- [x] Playback speed control (0.2x, 0.5x, 1.0x, 1.5x, 2.0x, 5.0x)
- [x] Speed selector dropdown menu
- [x] Hover-based controls (show on hover, hide after inactivity)

### Keyboard Shortcuts
- [x] **Space** or **P** - Play/Pause
- [x] **M** - Mute/Unmute
- [x] **F** - Toggle Fullscreen
- [x] **Left Arrow** - Skip backward (3 seconds × playback speed)
- [x] **Right Arrow** - Skip forward (3 seconds × playback speed)
- [x] **Delete** - Go back 15 seconds
- [x] **Ctrl+Delete** - Go back 30 seconds
- [x] **1-6** - Change playback speed (0.2x, 0.5x, 1.0x, 1.5x, 2.0x, 5.0x)

### UI/UX
- [x] Dark theme
- [x] Hover controls overlay
- [x] Speed indicator (shows when speed changes)
- [x] Responsive layout
- [x] Smooth transitions and animations

### Recording Features
- [x] Screen recording with audio (desktop + microphone)
- [x] Video + Audio synchronized recording
- [x] libx264 codec support (works in Electron STA mode)
- [x] COM threading mode detection (STA/MTA)
- [x] Automatic codec selection (rejects h264_mf in STA mode)

## 🚧 Next Steps (Priority)

### Recording Enhancements
- [ ] **Livestream option** - Add a stream button in the Electron app
  - Stream to RTMP server (Twitch, YouTube, etc.)
  - Configure stream URL and key
  - Stream quality settings
  
- [ ] **Window recording** - Record video only from a specific window
  - Window selection UI
  - Capture specific application window instead of full screen
  - Window border detection and cropping

- [ ] **Build & Distribution** - Compile to installable .exe
  - Electron Builder configuration
  - Auto-updater setup
  - Installer generation (NSIS/Inno Setup)
  - Code signing for Windows
  - Package native modules correctly

## 🚧 Planned Features (From PlayerPlan.md)

### Phase 5: Library View
- [ ] List of all videos
- [ ] Thumbnail generation
- [ ] Metadata display (game, date, duration)
- [ ] Grid/list view toggle
- [ ] Sort by date/name/duration
- [ ] Open video from library

### Phase 6: Search & Filter
- [ ] Search by name
- [ ] Filter by date range
- [ ] Filter by game type
- [ ] Quick filters (Today, This Week, etc.)

### Phase 7: Polish & UX
- [ ] Loading states
- [ ] Error handling improvements
- [ ] Settings panel
- [ ] Dark/light theme toggle
- [ ] Performance optimization

### Phase 8 (Advanced): Frame-by-frame
- [ ] Frame-by-frame navigation
- [ ] Previous/next frame buttons
- [ ] Keyboard shortcuts for frame navigation

## 💡 Future Considerations / TBD

### Minimap Detection
- [ ] Automatic minimap detection in game videos
- [ ] Manual minimap region selection
- [ ] Minimap overlay/zoom feature
- [ ] Minimap interaction (click to seek to location)

**Status:** TBD - Automatic detection is complex due to varying minimap positions across different players/recordings. May implement manual selection feature instead.

### Additional Features
- [ ] Picture-in-picture mode
- [ ] Subtitle/caption support
- [ ] Video quality selection
- [ ] Playlist support
- [ ] Recent files list
- [ ] Video information display
- [ ] Screenshot capture
- [ ] Bookmark system (excluded from original plan, but could be added)
- [ ] Clipping/trimming (excluded from original plan, but could be added)

## 🔧 Optimizations Needed

### Audio Streaming to FFmpeg
**Problem:** FFmpeg receives audio data in large chunks (8KB threshold), causing processing delays. For long recordings (25+ minutes), FFmpeg takes a very long time to finalize the file after recording stops.

**Solution:** Optimize audio data flow to FFmpeg for real-time processing:

1. **Reduce buffer threshold** in `electron/main.ts` and `native-audio/debug_record_ffmpeg.js`:
   - Change `AUDIO_BUFFER_THRESHOLD` from `8192` (8KB) to `3840` bytes (~480 frames = 10ms @ 48kHz)
   - This ensures more frequent, smaller chunks are sent to FFmpeg

2. **Add timer-based sending** (alternative approach):
   - Use `setInterval` to call `mixAndSendAudio()` every 10ms
   - Ensures continuous, regular data flow regardless of buffer size
   - Prevents FFmpeg from waiting for large chunks

3. **Files to modify:**
   - `electron/main.ts`: Update `AUDIO_BUFFER_THRESHOLD` and add interval-based sending
   - `native-audio/debug_record_ffmpeg.js`: Same optimizations for testing

**Expected result:** FFmpeg processes audio in real-time, reducing finalization time from minutes to seconds even for long recordings.

## 📝 Notes

- Timeline height has been optimized to be as thin as possible while remaining usable
- Speed-dependent skip amounts provide better navigation at different playback speeds
- All keyboard shortcuts work when the video player window is focused
- Controls automatically hide after 2 seconds of mouse inactivity while hovering






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

## 📝 Notes

- Timeline height has been optimized to be as thin as possible while remaining usable
- Speed-dependent skip amounts provide better navigation at different playback speeds
- All keyboard shortcuts work when the video player window is focused
- Controls automatically hide after 2 seconds of mouse inactivity while hovering






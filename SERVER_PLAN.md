# PLAN.md — Private Streaming & VOD Platform

## Goal

Build a **private YouTube-like system** for ~10 users that supports:

- 🔴 Live streaming via link
- ⏪ Join late + DVR seek during live
- ▶️ Replay (VOD) after stream ends
- 🧑‍💻 Works in Electron **and** Chrome / Firefox
- 🔒 Private access (light auth)
- 💸 Low cost, low ops
- 🧠 Clean upgrade path later

This system is **not** meant to compete with YouTube.  
It is optimized for **scrims, reviews, and coaching workflows**.

---

## Non-Goals (for now)

- No CDN
- No DRM
- No transcoding ladder (single quality)
- No WebRTC ultra-low latency
- No Kubernetes / microservices
- No massive scale

---

## High-Level Architecture

```
[ Capture App ]
     RTMP
      ↓
[ Ingest Server ]
 (nginx + rtmp)
      ↓
HLS (live + DVR)   +   Recording (MP4/MKV)
      ↓
HTTP Server
      ↓
[ Player ]
(Electron / Browser)
```

---

## Core Decisions

### Ingest
- **RTMP** for ingest (stable, simple, industry standard)
- One stream = one `stream_key`

### Live Playback
- **HLS** for delivery (HTTP-based)
- Enables:
  - Join anytime
  - DVR seek
  - Browser compatibility

### VOD
- Record full stream to **MP4**
- Serve VOD over HTTP
- Same link logic as YouTube:
  - If live → play HLS
  - Else → play MP4

### Player
- One **web-based player**
- Runs in:
  - Electron (Chromium)
  - Chrome / Firefox / Edge
- Electron acts as a **wrapper**, not a special case

---

## Server Setup (Phase 1)

### OS
- Ubuntu 22.04 LTS

### Software
- nginx (custom build)
- nginx-rtmp-module
- ffmpeg (optional tooling)

### Open Ports
- `1935` → RTMP ingest
- `80 / 443` → HTTP playback

---

## Directory Layout

```
/srv
 ├── hls/           # Live HLS segments (.m3u8 + .ts)
 ├── recordings/    # Full recordings (MP4/MKV)
 └── vod/           # Optional VOD HLS later
```

---

## nginx Responsibilities

### RTMP
- Accept ingest stream
- Segment to HLS
- Record full stream
- Cleanup on disconnect

### HTTP
- Serve HLS playlists & segments
- Serve MP4 recordings
- Add CORS headers for browser playback

---

## Playback URLs

### Live (while streaming)
```
http://server/hls/<stream_key>.m3u8
```

- Join anytime
- Seek back within DVR window

### VOD (after stream ends)
```
http://server/vod/recordings/<file>.mp4
```

- Instant seek
- Stable replay

---

## Player Logic (YouTube-like)

Pseudo-logic:

```js
if (HLS playlist exists) {
  play HLS (live)
} else {
  play MP4 (VOD)
}
```

This allows **one stable link** for:
- Live
- Replay
- Sharing

---

## Player Requirements

### Must Support
- HLS (`.m3u8`) via:
  - hls.js
  - or custom demux via MSE
- MP4 playback
- HTTP URLs (not local files)

### Must NOT
- Depend on Node APIs for core playback
- Read video directly from disk
- Be Electron-only

---

## Electron Strategy

- Electron loads the **same web player** as browsers
- Example:
  ```js
  mainWindow.loadURL("https://vod.domain.com/player?id=match123");
  ```
- No duplicated logic
- No special casing

---

## Authentication (Phase 1)

Simple, sufficient for ~10 users:

Options (pick one):
- HTTP Basic Auth
- Token in URL
- IP allowlist

Do **not** over-engineer.

---

## Storage Strategy

### Phase 1 (Now)
- Local disk on server
- Monitor disk usage
- Manual cleanup if needed

### Phase 2 (Later)
- Upload finalized recordings to object storage
- Serve VOD from object storage
- Keep ingest server stateless

---

## Performance Expectations

- Latency: ~6–8 seconds (RTMP → HLS)
- Concurrent viewers: 1–5
- Disk usage: ~2 GB/hour @ 1080p30

Well within limits.

---

## Upgrade Path (Planned, Not Now)

- HTTPS
- Better auth
- Object storage
- VOD → HLS conversion
- Metadata sidecars (`.json`)
- Timeline markers (kills, events)
- Clip extraction

No architectural changes required.

---

## Key Principles (Do Not Break)

- RTMP is for ingest, **never** playback
- Playback is HTTP-based
- Audio/video timing handled **before** server
- Ingest server should be disposable
- URLs should remain stable over time

---

## Success Criteria

- Stream appears live via link
- Join late works
- Seek during live works
- Replay works after stream ends
- Same player works in Electron + browser
- No YouTube involved

---

## Status Checklist

- [ ] Server provisioned
- [ ] nginx + RTMP installed
- [ ] HLS live playback verified
- [ ] Recording verified
- [ ] Player loads HLS
- [ ] Player loads MP4
- [ ] One-link live → VOD logic implemented

---

## Notes

This setup intentionally mirrors the **behavior** of YouTube, not its complexity.

The hardest parts (capture, sync, RTMP correctness) are already solved upstream.

This plan focuses on **shipping**, not scaling prematurely.

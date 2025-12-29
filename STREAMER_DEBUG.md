# Ionia Streamer / Native Engine — Debugging & Fixes (Canonical)

This document consolidates the practical debugging notes for the native Windows capture/encode/mux/RTMP pipeline.

It is also the “single place” for historical issue tracking notes (including real-time pacing investigations) that used to live in separate debugging markdown files.

## Quick start

- Primary debug entrypoint: [run_streamer_debug.cmd](run_streamer_debug.cmd)
	- Usage: `run_streamer_debug.cmd <youtubeStreamKey>`
	- Optional rebuild: `set REBUILD_NATIVE=1` then run the command
	- The command writes a timestamped `.txt` log (ignored by git) and prints to the console.

- Useful native tests (run from [native-audio](native-audio)):
	- Stream to RTMP (YouTube): [native-audio/test_stream_youtube_end_to_end.js](native-audio/test_stream_youtube_end_to_end.js)
	- Record locally (MP4): [native-audio/test_record.js](native-audio/test_record.js)
	- Stream + record in one run: [native-audio/test_stream_and_record.js](native-audio/test_stream_and_record.js)

## Where the “real” errors are

Many Electron/Node exceptions are wrappers. The actionable root cause is usually printed by C++ to stderr/stdout.

- If you run via Electron: read the Electron main-process console output (the terminal running Electron).
- If you run via tests/cmd: read the console output and the generated log file.

## High-signal debugging checklist

### A) “Failed to initialize Video Encoder”

Common causes and what to do:

1) DLL load / PATH issues
- Ensure FFmpeg/native dependencies are discoverable from the running process.
- If a test works in plain Node but fails in Electron, it’s often environment/PATH differences.

2) Encoder selection mismatch
- If the encoder picked depends on Windows Media Foundation (e.g., `h264_mf`), COM apartment mode can matter (see COM section below).

3) Confirm outside Electron
- Run a minimal native test from [native-audio](native-audio) to isolate Electron-specific issues.

### B) YouTube ingest issues (no preview / no processing)

When YouTube doesn’t “accept” the stream, the usual culprits are muxing/timestamps/extradata.

Validate these invariants in the muxer:
- Use `av_interleaved_write_frame()` (not manual FLV tag injection).
- Provide codec extradata (AAC AudioSpecificConfig; H.264 SPS/PPS) so the FLV/RTMP stream is self-describing.
- Respect `AVStream::time_base` after header writing (FFmpeg may adjust it).
- Ensure monotonic DTS and a stable A/V ordering key (avoid timestamp ties).
- Pace sending based on packet DTS vs wall clock (avoid draining too fast).

Key implementation: [native-audio/src/stream_muxer.cpp](native-audio/src/stream_muxer.cpp)

### C) Audio artifacts (clicks/pops/crackle, “accelerated” feeling)

#### What to look for in logs

1) WASAPI capture irregularity
- Frame counts should be broadly stable per callback.

2) Buffer health
- Underrun: not enough audio buffered → silence/clicks.
- Overrun: too much buffered → latency and eventual drops.

3) AAC framing consistency
- AAC-LC expects 1024-sample frames (except flush).
- Variable-sized chunks force the encoder to buffer internally, which can desync PTS from “real” audio.

#### Root cause that mattered most

The key issue was feeding irregular PCM block sizes into the AAC encoder, which causes internal buffering and makes packet timing drift (and under backpressure can lead to audible gaps).

#### Canonical fix (current behavior)

- Drive audio output in fixed 1024-sample cadence at 48kHz.
- If source buffers are short, pad with silence to keep cadence stable.
- Use monotonic scheduling (`steady_clock` + `sleep_until`) with bounded catch-up to reduce Windows scheduling jitter.

Key implementation:
- Audio mixing/cadence: [native-audio/src/audio_engine.cpp](native-audio/src/audio_engine.cpp)
- Addon audio scheduling: [native-audio/src/wasapi_video_audio_streamer.cpp](native-audio/src/wasapi_video_audio_streamer.cpp)

#### Deep-dive diagnostics (when you still hear artifacts)

What “good” looks like:
- Encoded AAC packets: 1024 samples per packet
- Packet-to-packet audio delta: ~21–22ms (1024/48000 = 21.333…ms)

What to search for (typical log patterns):
- WASAPI variability: “Frame count changed”, “DATA_DISCONTINUITY”
- Buffer issues: “UNDERRUN”, “OVERRUN”, “RISK”
- Ordering issues: “MONOTONIC DTS VIOLATION”
- Timing issues: “GAP DETECTED”, “BURST DETECTED”

If you have a big log file, these PowerShell searches are the fastest way to triage:

```powershell
# Replace with your actual log path
$log = "./audio_debug_full.txt"

Select-String -Path $log -Pattern "Frame count changed|DATA_DISCONTINUITY"
Select-String -Path $log -Pattern "UNDERRUN|OVERRUN|RISK"
Select-String -Path $log -Pattern "GAP DETECTED|BURST DETECTED"
Select-String -Path $log -Pattern "MONOTONIC DTS"
Select-String -Path $log -Pattern "IRREGULAR SAMPLE|numSamples"

@{
	Underruns = (Select-String -Path $log -Pattern "UNDERRUN").Count
	Overruns  = (Select-String -Path $log -Pattern "OVERRUN").Count
	Gaps      = (Select-String -Path $log -Pattern "GAP DETECTED").Count
	Bursts    = (Select-String -Path $log -Pattern "BURST DETECTED").Count
	DTS       = (Select-String -Path $log -Pattern "MONOTONIC DTS").Count
}
```

Mapping “artifact at time T” to likely packet index (rough heuristic):
- AAC packet duration is ~21.33ms → packets per second ≈ 46.875
- So at 15 seconds, packet index is roughly $15 * 46.875 \approx 703$.

Local playback sanity checks (is it YouTube/network vs our mux/encode?):

```powershell
# If you can output to a file FLV instead of RTMP, sanity-check it locally.
ffplay -i C:\temp\test_output.flv -autoexit

# Or inspect stream structure
ffprobe -v warning -show_streams -show_packets C:\temp\test_output.flv
```

Notes:
- If local playback is clean but YouTube playback is not, suspect network/ingest re-encode constraints (bitrate, keyframe interval, packet loss) rather than local audio mixing.

### D) Video freezes / timeline deadlock

Symptom: capture stalls and the video timeline stops advancing.

Fix strategy:
- Timeline advancement must be unconditional (CFR clock is independent of capture availability).
- If capture provides no new frame, duplicate last frame; if none exists, fall back to black frame.

### E) Frame injection (debug-only)

If you are testing injected frames:
- First verify the capture/tick threads are still alive after calling `injectFrame()`.
- If the process exits or the JS event loop stops running after injection, treat it as a threading/deadlock/crash investigation rather than “injection didn’t work”.

Start point: [native-audio/src/wasapi_video_audio_streamer.cpp](native-audio/src/wasapi_video_audio_streamer.cpp)

## COM threading (Electron vs plain Node)

On Windows, Electron (as a GUI app) commonly runs with COM initialized in STA mode. Some encoders that rely on Media Foundation can require MTA.

If you see errors like “COM must not be in STA mode”:
- Don’t assume your own `CoInitializeEx(... COINIT_MULTITHREADED)` can change the mode (it can’t once initialized).
- Prefer an encoder that doesn’t depend on that COM mode (for example, request a software encoder like `libx264` explicitly, if available in your FFmpeg build).

## Key files to inspect first

- Addon orchestration + threads: [native-audio/src/wasapi_video_audio_streamer.cpp](native-audio/src/wasapi_video_audio_streamer.cpp)
- Audio capture conversion/resample: [native-audio/src/audio_capture.cpp](native-audio/src/audio_capture.cpp)
- Audio mixing + 1024 cadence + silence padding: [native-audio/src/audio_engine.cpp](native-audio/src/audio_engine.cpp)
- AAC encoding: [native-audio/src/audio_encoder.cpp](native-audio/src/audio_encoder.cpp)
- H.264 encoding: [native-audio/src/video_encoder.cpp](native-audio/src/video_encoder.cpp)
- FLV/RTMP muxing + timestamping + pacing: [native-audio/src/stream_muxer.cpp](native-audio/src/stream_muxer.cpp)
- Backpressure buffering: [native-audio/src/stream_buffer.cpp](native-audio/src/stream_buffer.cpp)

## Related docs

- Architecture overview (canonical): [ARCHITECTURE_OVERVIEW.md](ARCHITECTURE_OVERVIEW.md)
- Streaming engine logic: [STREAMER_LOGIC.md](STREAMER_LOGIC.md)
- H.264 B-frames DTS/PTS TODO: [BFRAMES_DTS_TODO.md](BFRAMES_DTS_TODO.md)

---

## Historical debug timeline (what we hit while building the debug tooling)

This section consolidates the issue-tracker notes that were previously written as separate “debug report” markdown files.

### Issue: stream_buffer header guard mismatch (build failure)

Symptom:
- Compilation error complaining `StreamBuffer` is undefined from `stream_muxer.cpp`.

Root cause pattern:
- Wrong header guard in `stream_buffer.h` prevents the right content from being included.

Fix:
- Ensure the header guard matches the file and the file actually defines `StreamBuffer`.

### Issue: Node event loop appears “blocked” after start()

Symptom:
- JS `setTimeout` never fires after calling `start()`.

Important interpretation:
- This is often a native crash (access violation) in a background thread, not an actual JS deadlock.
- Treat it as “crash after Start” and focus on background thread safety / pointer lifetime.

Strategy that worked well:
- Temporarily disable thread spawning to isolate which thread causes the crash.
- Add defensive null checks and lifetime guards.

### Issue: Video shows 0 frames / 0 packets while audio works

Symptom:
- Audio packets increment normally but video stays at 0.

Most common root cause:
- DXGI Desktop Duplication returns `DXGI_ERROR_WAIT_TIMEOUT` repeatedly (no “new frame”).
- In headless/virtual environments (or if the desktop never updates), this can be continuous.

How to confirm:
- Add periodic logging in the capture thread for capture attempts vs success.
- Add periodic logging inside `DesktopDuplication::CaptureFrame` for timeout counts.

Mitigation options (pick one):
- Treat timeout as “duplicate last frame” to maintain CFR output.
- If repeated timeouts exceed a threshold, fall back to a generated test pattern frame.

### Pacing investigations (important for “accelerated” playback)

There are two distinct pacing problems to keep separated:

1) **Audio production cadence** (AAC framing)
- If you feed variable frame sizes into AAC, the encoder buffers internally → timing drift.
- Fix: enforce 1024-sample cadence, pad with silence, schedule ticks with `sleep_until`.

2) **Network/mux send pacing**
- If the sender drains buffered packets as fast as possible, it can outrun the DTS timeline.
- Fix: pace based on packet DTS vs wall clock in the send loop.

Implementation references:
- Sender pacing logic: [native-audio/src/stream_muxer.cpp](native-audio/src/stream_muxer.cpp)
- Higher-level pacing design notes: [STREAMER_LOGIC.md](STREAMER_LOGIC.md)

# BRANCH_DEBUG — C++ + Electron diffs

Compared branches:
- `phase-1-basic-setup`
- `phase-1-basic-setup-streaming`

This doc focuses only on:
- Electron integration: [electron/main.ts](electron/main.ts), [electron/preload.js](electron/preload.js)
- Native code: [native-audio/src](native-audio/src)

## High-level summary

`phase-1-basic-setup-streaming` adds a full RTMP streaming path (new native streamer addon + buffer/muxer + a CFR video engine) and wires it into Electron IPC. It also changes parts of the shared audio/video pipeline (audio frame sizing/PTS strategy, encoder packet metadata, recorder threading model), which can affect recording behavior even if you only intended to “add streaming”.

## Recording regression (root cause)

Observed behavior:
- On `phase-1-basic-setup`: recording works.
- On `phase-1-basic-setup-streaming`: streaming works, but Electron reports recording failure ("Recording file was not created").

Most likely root cause (path/contract mismatch):
- Electron generates a timestamped `recordingOutputPath` and calls `VideoAudioRecorder.initialize(recordingOutputPath, ...)`.
- On the streaming branch, the recorder native addon ignores that argument and hardcodes the muxer output to `"output.mp4"`.
- Electron then checks for the file at `recordingOutputPath` and fails, even if `output.mp4` was created somewhere else (often relative to the app working directory).

Minimal fix direction:
- Restore argument parsing in `VideoAudioRecorder::Initialize()` on the streaming branch and pass the JS `outputPath` through to `VideoMuxer::Initialize(...)`.
- Keep the streaming-specific additions (streamer/muxer/buffer/video engine) unchanged.

## Changed files (Electron)

### Modified
- [electron/main.ts](electron/main.ts)
  - Loads `VideoAudioStreamer` from the native module in addition to `VideoAudioRecorder`.
  - Adds IPC handlers:
    - `stream:start` (creates/initializes/starts streamer)
    - `stream:stop` (stops streamer)
  - Enforces mutual exclusion (won’t stream while recording, and vice versa).
  - Adds richer error handling around initialization/start/stop.

- [electron/preload.js](electron/preload.js)
  - Exposes new renderer API methods:
    - `startStream(rtmpUrl)` → `ipcRenderer.invoke('stream:start', rtmpUrl)`
    - `stopStream()` → `ipcRenderer.invoke('stream:stop')`

## Changed files (C++ / native-audio)

### New files (streaming + pacing)
- [native-audio/src/wasapi_video_audio_streamer.cpp](native-audio/src/wasapi_video_audio_streamer.cpp)
  - New N-API addon `VideoAudioStreamer`.
  - Threaded pipeline (as implemented in this branch) includes:
    - Capture thread (desktop or injected frames)
    - Video tick thread (CFR pacing + encoding + enqueueing packets)
    - Audio tick thread (drives AAC cadence and pushes audio packets)
    - Network send thread (drains buffered packets and sends to RTMP)
  - Supports “injected frames” (JS can push raw BGRA frames into the pipeline) for testing.
  - Exposes connection/backpressure state and basic stats to JS.

- [native-audio/src/stream_muxer.h](native-audio/src/stream_muxer.h), [native-audio/src/stream_muxer.cpp](native-audio/src/stream_muxer.cpp)
  - RTMP muxer built on FFmpeg output contexts.
  - Handles:
    - H.264 video packets + AAC audio packets
    - Sequence headers (AAC/AVC extradata) and stream initialization
    - Connection checks/reconnect logic
    - Real-time pacing for buffered network send (tracks wall-clock vs DTS timeline)
  - Designed to work with a buffer and backpressure.

- [native-audio/src/stream_buffer.h](native-audio/src/stream_buffer.h), [native-audio/src/stream_buffer.cpp](native-audio/src/stream_buffer.cpp)
  - Packet queue with backpressure detection.
  - Limits are based on:
    - max queue size (`m_maxSize`)
    - max DTS latency (`m_maxLatencyMs`)
  - Computes ordering/latency using per-stream indices and FFmpeg `time_base`.

- [native-audio/src/wasapi_video_engine.h](native-audio/src/wasapi_video_engine.h), [native-audio/src/wasapi_video_engine.cpp](native-audio/src/wasapi_video_engine.cpp)
  - A “CFR pacing” helper for video.
  - Maintains a monotonic `frameNumber` and computes `expectedFrameNumber` from time.
  - Uses a small ring buffer for captured frames.
  - Implements frame duplication (or black frame fallback) when capture lags behind the desired CFR.

- [native-audio/src/test_pattern_generator.h](native-audio/src/test_pattern_generator.h), [native-audio/src/test_pattern_generator.cpp](native-audio/src/test_pattern_generator.cpp)
  - Test pattern / synthetic frame generation used for streaming/debugging.

### Modified files (shared pipeline / recorder / glue)

- [native-audio/src/wasapi_video_audio_recorder.cpp](native-audio/src/wasapi_video_audio_recorder.cpp)
  - Major refactor to align the recorder architecture with streaming:
    - Introduces `VideoEngine` usage.
    - Removes the dedicated timer-based `AudioTickThread`.
    - Adds `VideoTickThread`.
    - Simplifies the exposed JS API surface (removes some methods compared to base branch).
  - Behavior-impacting changes visible in the diff:
    - COM initialization / COM-mode handling was removed.
    - Several configuration parameters that were previously parsed may be hard-coded or simplified in this branch.
    - Recorder timing model changes from “wall-clock CFR loop in CaptureThread” to “capture pushes frames → tick thread encodes at CFR”.

- [native-audio/src/audio_engine.cpp](native-audio/src/audio_engine.cpp), [native-audio/src/audio_engine.h](native-audio/src/audio_engine.h)
  - Adds additional state and logic around mixing/cadence:
    - Adds `m_desktopGain` (desktop volume scaling).
    - Adds debug logging of WASAPI callback sizes.
    - Adds buffer overflow/drop strategy in `MixAudio()`.
    - Replaces the older “clock-master” tick logic with a block-based 1024-sample cadence (AAC frame sized), including optional silence padding.
  - This is one of the most behavior-sensitive diffs: it affects both recording and streaming audio.

- [native-audio/src/audio_encoder.cpp](native-audio/src/audio_encoder.cpp)
  - Changes encoding strategy:
    - Previously: accumulate PCM until you have full `frame_size`, then encode.
    - Now: encode immediately per call (expects the caller to provide exactly `frame_size` frames).
    - Emits warnings if `numFrames != frame_size`.
  - Changes packet metadata:
    - Creates `EncodedAudioPacket(packetData, frameSize)` so downstream muxers can compute PTS from sample counts.
  - `Flush()` is simplified to only drain FFmpeg internal buffers.

- [native-audio/src/encoded_audio_packet.h](native-audio/src/encoded_audio_packet.h)
  - `EncodedAudioPacket` now includes `numSamples` (used for PTS progression in muxers).

- [native-audio/src/audio_capture.cpp](native-audio/src/audio_capture.cpp)
  - Changes multi-channel downmix behavior:
    - For `inChannels > 2`, it explicitly uses Front Left (ch0) and Front Right (ch1).

- [native-audio/src/video_encoder.h](native-audio/src/video_encoder.h)
  - Adds `GetCodecContext()` accessor (used by stream muxer for extradata / SPS-PPS / codec config).

- [native-audio/src/desktop_duplication.cpp](native-audio/src/desktop_duplication.cpp), [native-audio/src/desktop_duplication.h](native-audio/src/desktop_duplication.h)
  - Minor changes (generally robustness/logging/compat improvements).

- [native-audio/src/audio_engine_encoder.cpp](native-audio/src/audio_engine_encoder.cpp)
- [native-audio/src/audio_muxer.cpp](native-audio/src/audio_muxer.cpp)
- [native-audio/src/wasapi_capture.cpp](native-audio/src/wasapi_capture.cpp)
  - Glue-level changes to integrate streamer exports and/or new packet metadata.

## Practical “what this means”

If you only care about recording:
- The streaming branch still modifies shared audio/video timing components.
- The most likely places that change recording quality/behavior are:
  - [native-audio/src/audio_engine.cpp](native-audio/src/audio_engine.cpp)
  - [native-audio/src/audio_encoder.cpp](native-audio/src/audio_encoder.cpp)
  - [native-audio/src/wasapi_video_audio_recorder.cpp](native-audio/src/wasapi_video_audio_recorder.cpp)

If you only care about streaming:
- The core streaming path relies on:
  - [native-audio/src/wasapi_video_audio_streamer.cpp](native-audio/src/wasapi_video_audio_streamer.cpp)
  - [native-audio/src/stream_muxer.h](native-audio/src/stream_muxer.h)
  - [native-audio/src/stream_buffer.h](native-audio/src/stream_buffer.h)
  - [native-audio/src/wasapi_video_engine.h](native-audio/src/wasapi_video_engine.h)
- It also implicitly depends on the shared audio cadence decisions in `AudioEngine`/`AudioEncoder`.

## Checklist (quick debugging)

- If Electron can’t start streaming:
  - Confirm `VideoAudioStreamer` export exists (main process logs in [electron/main.ts](electron/main.ts)).
  - Confirm `stream:start` IPC is wired (renderer calls [electron/preload.js](electron/preload.js)).

- If audio sounds wrong or crashes occur:
  - Focus on the contract between [native-audio/src/audio_engine.cpp](native-audio/src/audio_engine.cpp) and [native-audio/src/audio_encoder.cpp](native-audio/src/audio_encoder.cpp):
    - Whether `Tick()` produces exactly `codecContext->frame_size` frames each call.
    - Whether muxers advance PTS using sample counts (`EncodedAudioPacket.numSamples`).

- If video pacing differs between branches:
  - Review [native-audio/src/wasapi_video_engine.h](native-audio/src/wasapi_video_engine.h) and how the tick thread advances frame numbers vs capture availability.

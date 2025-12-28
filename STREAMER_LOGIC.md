# STREAMER_LOGIC.md

This document explains how the streamer works end-to-end: engines, threads, CFR scheduling, audio sample timing, timestamp domains, muxing/buffering, and pacing.

## 1) High-level pipeline

**Capture → Encode → Mux/Buffer → Send (RTMP/FLV)**

- Video capture produces raw frames (Desktop Duplication / D3D11 path).
- Audio capture produces PCM frames (WASAPI).
- Video encoder produces H.264 packets.
- Audio encoder produces AAC packets.
- Stream muxer packages them into FLV over RTMP, with correct timestamps.
- Stream buffer interleaves packets by timeline order.
- Network send thread drains the buffer with real-time pacing.

Key implementation files:
- [native-audio/src/wasapi_video_audio_streamer.cpp](native-audio/src/wasapi_video_audio_streamer.cpp)
- [native-audio/src/wasapi_video_engine.cpp](native-audio/src/wasapi_video_engine.cpp)
- [native-audio/src/audio_engine.cpp](native-audio/src/audio_engine.cpp)
- [native-audio/src/video_encoder.h](native-audio/src/video_encoder.h)
- [native-audio/src/audio_encoder.cpp](native-audio/src/audio_encoder.cpp)
- [native-audio/src/stream_muxer.cpp](native-audio/src/stream_muxer.cpp)
- [native-audio/src/stream_buffer.h](native-audio/src/stream_buffer.h)

## 2) Threads and responsibilities

The addon runs multiple threads to keep real-time work separated:

### Video capture / tick path

- **Capture thread**: pushes frames into a small ring buffer in `VideoEngine`.
- **Video tick thread**: implements CFR pacing and decides *when a frame should be encoded*.

The CFR logic is based on comparing:
- `currentFrame = VideoEngine::GetFrameNumber()` (how many frames have been produced/encoded)
- `expectedFrame = VideoEngine::GetExpectedFrameNumber()` (how many frames *should* exist based on elapsed wall time and target FPS)

If `currentFrame < expectedFrame`, the tick thread encodes (or duplicates) a frame, then calls `AdvanceFrameNumber()`.

Relevant code:
- `VideoEngine::GetExpectedFrameNumber()` and its time math: [native-audio/src/wasapi_video_engine.cpp](native-audio/src/wasapi_video_engine.cpp)
- Video tick loop: [native-audio/src/wasapi_video_audio_streamer.cpp](native-audio/src/wasapi_video_audio_streamer.cpp)

### Audio tick path

- WASAPI capture pushes PCM into the `AudioEngine` buffers.
- An **audio tick thread** calls `AudioEngine::Tick()` at the AAC cadence.

Important: `AudioEngine::Tick()` advances the audio timeline by a fixed amount every call (AAC frame size), so the tick cadence must match real time (see section 3).

Relevant code:
- Audio tick loop: [native-audio/src/wasapi_video_audio_streamer.cpp](native-audio/src/wasapi_video_audio_streamer.cpp)
- Audio mixing and 1024-frame emission: [native-audio/src/audio_engine.cpp](native-audio/src/audio_engine.cpp)

### Network send path

- A **network send thread** repeatedly calls `StreamMuxer::SendNextBufferedPacket()` to write the next interleaved packet.
- The muxer enforces real-time pacing against packet DTS so the sender cannot outrun the timeline.

Relevant code:
- Network send loop: [native-audio/src/wasapi_video_audio_streamer.cpp](native-audio/src/wasapi_video_audio_streamer.cpp)
- Pacing in `SendNextBufferedPacket()`: [native-audio/src/stream_muxer.cpp](native-audio/src/stream_muxer.cpp)

## 3) Audio clock: sample-accurate time

### The invariant

Audio time is defined by sample count, not wall-clock reads.

- A single AAC-LC frame represents **1024 audio frames**.
- If sample rate is $48000\,Hz$, then the ideal duration of one AAC frame is:

$$\Delta t = \frac{1024}{48000} \approx 0.021333\,s$$

### How the engine advances time

- `AudioEngine::Tick()` always emits exactly 1024 frames.
- It increments its internal counter by 1024 every tick.
- If PCM buffers are short, the engine **pads with silence** to keep cadence continuous.

Why silence padding matters:
- Dropping or emitting variable-sized frames causes audible artifacts and mux timeline jitter.

Relevant code:
- 1024-frame emission + silence padding behavior: [native-audio/src/audio_engine.cpp](native-audio/src/audio_engine.cpp)
- AAC encoder expects 1024 frames: [native-audio/src/audio_encoder.cpp](native-audio/src/audio_encoder.cpp)

### Why scheduling matters (Windows)

On Windows, `sleep_for()` precision can be coarse depending on timer resolution.
If the audio tick thread calls `Tick()` too slowly, the audio timeline will lag and the result can sound “time-compressed / accelerated” downstream.

The current approach is:
- Use `std::chrono::steady_clock` scheduling (`sleep_until`).
- Allow limited catch-up ticks (bounded burst) to avoid permanent drift.

Relevant code:
- Audio tick scheduling: [native-audio/src/wasapi_video_audio_streamer.cpp](native-audio/src/wasapi_video_audio_streamer.cpp)

## 4) Video clock: CFR frame index time

Video time is defined by frame index at a target FPS.

- If FPS is $30$, each frame represents $\frac{1}{30}$ seconds.
- `VideoEngine` uses `m_startTime` and elapsed wall time to compute the expected frame number.

CFR decision rule:
- If we are behind (expectedFrame advanced), encode/duplicate a frame.
- If we are on time or ahead, sleep briefly.

Relevant code:
- CFR math: [native-audio/src/wasapi_video_engine.cpp](native-audio/src/wasapi_video_engine.cpp)

## 5) Timestamp domains and conversion (critical)

There are three “time domains” to keep straight:

1) **Audio domain**: samples in time base $\{1/\text{sampleRate}\}$
2) **Video domain**: frames in time base $\{1/\text{fps}\}$
3) **Muxer/stream domain**: `AVStream::time_base` chosen by the muxer (often milliseconds for FLV video, and sample units for audio)

### Rule: stamp in the stream’s final time_base

After `avformat_write_header()`, FFmpeg may adjust `AVStream::time_base`.
All packet timestamps must match those final stream time bases.

Implementation strategy:
- Compute audio PTS from cumulative samples.
- Compute video PTS from frame index.
- Convert using **rounded rescale** to avoid drift.

Relevant code:
- `RescaleRounded(...)` and timestamp assignment: [native-audio/src/stream_muxer.cpp](native-audio/src/stream_muxer.cpp)

## 6) Muxing, codec headers, and why “manual FLV tags” are wrong

For FLV/RTMP via libavformat:

- You do **not** manually build FLV AAC/AVC sequence-header tag payloads and pass them through `av_write_frame()`.
- Instead:
  - provide correct codec extradata (AAC AudioSpecificConfig, H.264 avcC/SPS/PPS),
  - then send raw AAC/H.264 packets.

The muxer will generate the correct FLV headers.

Relevant code:
- AAC AudioSpecificConfig extradata setup: [native-audio/src/stream_muxer.cpp](native-audio/src/stream_muxer.cpp)

## 7) Buffering and interleaving

### Why a buffer exists

Capture/encode threads can produce packets in bursts.
The network thread must send in timeline order, in real time.

So packets are queued into `StreamBuffer`, and the network thread pops the next packet.

### Ordering

Ordering is based on timestamps converted to a common high-resolution (microseconds) ordering key to avoid audio/video ties.
This improves interleaving stability.

Relevant code:
- Buffering implementation: [native-audio/src/stream_buffer.h](native-audio/src/stream_buffer.h)

## 8) Real-time pacing (sender must not outrun DTS)

Even with correct timestamps, if the sender drains a queue too fast, the stream timeline can effectively “run ahead”.

The pacing rule:
- Convert packet DTS to microseconds.
- Establish baseline `(firstPacketDtsUs, streamStartWallUs)`.
- For each packet, compute target wall time and sleep if packet is early.

This is implemented inside:
- `StreamMuxer::SendNextBufferedPacket()` in [native-audio/src/stream_muxer.cpp](native-audio/src/stream_muxer.cpp)

## 9) Notes on B-frames and DTS vs PTS

Current video timestamping assumes no reordering:
- `dts = pts`

If the encoder ever outputs B-frames, DTS and PTS will differ and DTS must remain monotonic.

Tracking note:
- [BFRAMES_DTS_TODO.md](BFRAMES_DTS_TODO.md)

## 10) Practical mental model

If you want a simple “how do I reason about sync?” model:

- **Audio clock**: sample counter is truth (1024 frames per AAC packet).
- **Video clock**: frame counter is truth (1 frame per CFR step).
- **Muxer clock**: is just a representation; rescale into it carefully.
- **Buffer**: orders A/V packets by timeline.
- **Pacing**: enforces that the network writes follow timeline speed.

If any one of these is wrong, you’ll see one of these symptoms:
- Wrong extradata / FLV headers → YouTube ingest fails.
- Wrong time_base / rescaling → jitter, non-monotonic DTS, or “accelerated” feel.
- Bad interleaving/order ties → unstable playback and ingest issues.
- Missing real-time pacing → sender outruns timeline.
- Audio tick cadence wrong → time-compressed audio even if pitch is correct.

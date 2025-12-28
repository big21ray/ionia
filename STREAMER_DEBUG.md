# STREAMER_DEBUG.md

This document summarizes the issues encountered and the strategies/fixes applied while stabilizing the Windows (WASAPI + Desktop Duplication) → FFmpeg (H.264/AAC) → FLV/RTMP streaming pipeline.

## Goals

- Make YouTube RTMP ingest reliably accept/process the stream (preview + processing).
- Reduce audio artifacts (crackle/pop), and keep pitch correct.
- Remove “accelerated” / time-compressed feel (timeline must match wall-clock).
- Move behavior toward OBS-style streaming: sample-accurate audio clock, robust muxing/interleaving, correct timestamp domains.

## Timeline: Issues → Diagnosis → Fix

### 1) High-level code risks found during initial C++ review

**Symptoms / Risks**
- Potential crash points (null usage, unchecked error codes).
- Timing inconsistencies (hard-coded sizes, mixed clock domains).
- Performance hotspots in real-time paths.

**Strategy**
- Focus fixes on root-cause timing correctness first (timestamps, muxer time_base, ordering, pacing), then iterate on audio quality.

---

### 2) YouTube ingest problems (“no preview / not processing”)

**Observed**
- Stream connects but YouTube doesn’t reliably start preview/processing.

**Diagnosis**
- Timestamp / container correctness issues:
  - Packets were being timestamped in one time_base but muxed in another.
  - Ordering ties between audio/video (ms-level collisions) caused bad interleaving.
  - Invalid manual FLV “sequence header” style packet injection corrupted the stream.

**Fixes / Strategies applied**
- **Time-base aware buffering and ordering**
  - Stream buffering was updated to be time_base-aware.
  - Ordering key switched to **microseconds** (higher resolution) to avoid A/V ties.
- **Interleaved muxing**
  - Use `av_interleaved_write_frame()` for correct interleave behavior.
- **Stop manual FLV sequence header injection**
  - Removed the approach of manually constructing FLV tag payloads and pushing them via FFmpeg.
  - FFmpeg’s FLV muxer expects **codec extradata** and raw codec packets, not hand-built FLV tags.
- **Provide proper AAC extradata (AudioSpecificConfig)**
  - Build and set AAC **AudioSpecificConfig** in `AVStream::codecpar->extradata` so the FLV muxer can emit the correct AAC sequence header.
- **Rescale timestamps to post-header stream time_base**
  - After `avformat_write_header()`, FFmpeg may adjust `AVStream::time_base`.
  - Packets are now stamped/rescaled using the **final stream time_base**.

Where this lives:
- [native-audio/src/stream_muxer.cpp](native-audio/src/stream_muxer.cpp)

---

### 3) Pitch correct, but audio felt “accelerated” (both mic + desktop)

**Observed**
- Pitch is right (sample rate not obviously wrong), but the stream feels sped up / time-compressed.

**Key insight**
- “Accelerated” can happen even with correct sample rate if **the produced timestamp timeline** advances faster than real time, or if the sender drains data faster than timestamps and the receiver behaves oddly.

**Fixes / Strategies applied**
- **Drift prevention via rounded rescale + duration from nextPts**
  - Avoid systematic truncation drift by using rounded rescaling (`av_rescale_q_rnd`).
  - Compute `duration = nextPts - pts` for both audio and video.
  - This removes long-run bias (small per-packet rounding errors accumulating into noticeable drift).
- **Real-time pacing in network send path**
  - Added DTS-based pacing in `StreamMuxer::SendNextBufferedPacket()`:
    - Convert packet DTS to microseconds.
    - Establish baseline at first packet.
    - Sleep if the packet is ahead of wall clock (tolerance + max cap).
  - Prevents the network thread from draining buffered packets faster than real time.
- **Root-cause follow-up: audio tick cadence on Windows**
  - Audio timeline was being advanced by fixed 1024-frame steps each `AudioEngine::Tick()`.
  - If the thread calling `Tick()` runs at the wrong cadence (Windows sleep granularity), you can get time-compression.
  - Updated the audio tick loop to schedule using `std::chrono::steady_clock` + `sleep_until` + limited catch-up ticks.

Where this lives:
- [native-audio/src/stream_muxer.cpp](native-audio/src/stream_muxer.cpp)
- [native-audio/src/stream_muxer.h](native-audio/src/stream_muxer.h)
- [native-audio/src/wasapi_video_audio_streamer.cpp](native-audio/src/wasapi_video_audio_streamer.cpp)

---

### 4) Crackle / clipping artifacts (especially after raising desktop gain)

**Observed**
- Audible crackle/pop and clipping.

**Diagnosis**
- Mix path was hard-clamping to [-1, 1], which will clip if summed audio exceeds range.
- Timing gaps / irregular audio emission also produce crackles (buffer underruns / discontinuities).

**Fixes / Strategies applied**
- **Silence padding strategy (AAC frame continuity)**
  - Ensure 1024-frame AAC cadence by padding missing samples with silence instead of skipping emission.
  - This reduces “gap clicks” that come from emitting irregular packet sizes/timing.
- **Desktop gain control**
  - Added a desktop gain multiplier in the mixer to address low desktop level.
  - Note: boosting gain increases clipping risk unless combined with limiting.

Where this lives:
- [native-audio/src/audio_engine.cpp](native-audio/src/audio_engine.cpp)
- [native-audio/src/audio_engine.h](native-audio/src/audio_engine.h)

---

### 5) Potential H.264 B-frames (DTS vs PTS correctness)

**Observed risk**
- Current video timestamps use `pkt->dts = pkt->pts` and assume no B-frames.
- If encoder outputs B-frames (reordered frames), DTS must be monotonic decode order and PTS may differ.

**Strategy (documented TODO)**
- If we ever enable/observe B-frames, we must:
  - use encoder-provided PTS/DTS (or derive proper DTS ordering), and
  - ensure FLV/RTMP expectations are met.

Where this lives:
- [BFRAMES_DTS_TODO.md](BFRAMES_DTS_TODO.md)

---

### 6) Test harness adjustments

**Change**
- Extended test run duration from 30s to 60s for better stability validation.

Where this lives:
- [native-audio/test_framedup_fix.js](native-audio/test_framedup_fix.js)

---

## Key Strategies (Quick Index)

- **Never inject raw FLV tags into FFmpeg**: provide codec extradata + raw packets.
- **Always respect muxer-chosen post-header `AVStream::time_base`**.
- **Order buffered packets in high resolution (microseconds)** to prevent A/V ties.
- **Avoid timestamp drift**: rounded rescale + duration derived from next PTS.
- **Enforce real-time pacing**: sender must not outrun DTS timeline.
- **Audio continuity**: 1024-frame AAC cadence, pad with silence rather than skipping.
- **Watch for B-frames**: if present, PTS != DTS and monotonic DTS is mandatory.

## Notes / Known tradeoffs

- Increasing desktop gain improves audibility but increases clipping risk unless a limiter is added.
- Windows scheduler granularity can break “perfect” sleep-based cadence; scheduling via `sleep_until` + catch-up is more robust than fixed `sleep_for`.

## Files touched most during debugging

- [native-audio/src/stream_muxer.cpp](native-audio/src/stream_muxer.cpp)
- [native-audio/src/stream_muxer.h](native-audio/src/stream_muxer.h)
- [native-audio/src/wasapi_video_audio_streamer.cpp](native-audio/src/wasapi_video_audio_streamer.cpp)
- [native-audio/src/audio_engine.cpp](native-audio/src/audio_engine.cpp)
- [native-audio/test_framedup_fix.js](native-audio/test_framedup_fix.js)
- [BFRAMES_DTS_TODO.md](BFRAMES_DTS_TODO.md)

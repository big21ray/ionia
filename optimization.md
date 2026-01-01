**Optimization & Architecture Recommendations**

This document collects concrete optimization and architecture suggestions to improve performance, reliability, and extensibility of the native-audio codebase.

- **Audio buffering (high impact)**: Replace `FloatRingBuffer` (mutex-protected) with an SPSC lock-free ring buffer (atomic head/tail indices, contiguous storage). This eliminates mutex contention on the high-frequency capture path and reduces latency.

- **Batching & block sizes**: Produce and process audio in encoder-friendly block sizes (e.g., AAC: 1024 frames). Accumulate until a full encoder frame is available to avoid padding, extra allocations, and jitter.

- **Avoid extra copies**: Reuse buffers and move ownership instead of copying per-packet. Use buffer pools or AVPacket/AVFrame reuse (av_packet_unref/av_frame_unref) and custom free callbacks where appropriate.

- **Float→PCM conversion**: Use `libswresample` (`SwrContext` + `swr_convert`) to handle interleaved→planar, format, and channel-layout conversion robustly. If the pipeline is fixed (48 kHz stereo float → encoder FLTP), consider an SIMD-optimized conversion only after profiling.

- **Resampling**: Rely on `libswresample` for sample-rate and channel-layout conversion. Initialize a reusable `SwrContext` once and reuse it for the stream. Compute delay with `swr_get_delay`, rescale output capacity with `av_rescale_rnd`, and avoid per-frame allocations by reusing `dst` buffers (use `av_samples_alloc_array_and_samples` once).

- **Encoder path & threading**: Use a dedicated worker thread per encoder (or a bounded thread-pool) with a bounded queue and backpressure. Feed frames via `avcodec_send_frame` / `avcodec_receive_packet` and reuse AVFrames/AVPackets. Implement queue depth limits and drop or downscale frames when overloaded.

- **Zero-copy GPU path for video**: For desktop/game capture, prefer GPU texture capture (DXGI desktop duplication or platform capture) and hardware encoder interop (NVENC/QSV/AMF) using shared textures/handles to avoid GPU→CPU readback. If readback is necessary, minimize regions and use async staging textures.

- **Audio DSP pipeline**: Implement a modular filter chain interface (e.g., processBlock(in,out,frames)). Run light DSP synchronously in the audio thread; offload heavy processing (RNNoise, VST) to worker threads with buffering and latency compensation.

- **Profiling & telemetry**: Add high-resolution profiling markers around capture → mix → encode → mux. Log queue depths, dropped frames/packets, processing times per stage to guide optimization.

- **Memory & allocations**: Preallocate and reuse vectors/buffers. Prefer `vector::reserve` and custom alloc arenas for frequently used buffers. Avoid per-frame heap allocations in hot paths.

- **Latency control & PTS handling**: Keep a consistent timebase (frames for audio). Advance PTS atomically; compute packet timestamps in frames. When using `swr`, account for its delay (use `swr_get_delay`) when computing output PTS.

- **Backpressure & quality tradeoffs**: On encoder/muxer backpressure, prefer dropping non-key video frames or lowering bitrate/resolution instead of blocking capture threads. For audio, prefer controlled dropping or silence insertion rather than blocking capture.

- **Use FFmpeg primitives correctly**: Link and use `libswresample` for conversions and resampling; use `avcodec_send_frame`/`avcodec_receive_packet` and proper reuse of `AVPacket`/`AVFrame` objects to avoid allocations and leaks.

- **SIMD micro-optimizations (when justified)**: If profiling shows conversion is a hotspot and the input format is fixed (e.g., 48 kHz stereo float → s16), implement an SSE/AVX conversion path for float→s16 and interleaved→planar operations.

- **Implementation priorities (recommended order)**:
  1. Replace mutexed ring buffer with SPSC lock-free ring buffer.
 2. Add encoder worker thread with bounded queue and AVFrame/AVPacket reuse.
 3. Integrate `libswresample` wrapper for robust format/rate/layout conversion and use it when inputs differ from encoder expectations.
 4. Introduce buffer pools (AVPacket/AVFrame reuse) and avoid per-frame allocations.
 5. Add profiling markers and queue-depth logging; iterate on hotspots.
 6. Implement modular audio filter chain and offload heavy DSP to workers.
 7. If needed, implement SIMD conversion paths for fixed-format, high-frequency conversions.

- **Quick code tasks to start with (low-effort, high-impact)**:
  - Implement `SpscRingBuffer` in `native-audio/src/` and switch `AudioEngine` to use it.
  - Add `SwrWrapper` (`native-audio/src/swr_wrapper.*`) that manages a `SwrContext` and reusable dst buffers.
  - Create `EncoderWorker` that receives frames via a bounded queue, calls `avcodec_send_frame`/`avcodec_receive_packet`, and returns encoded packets to the muxer.
  - Add simple profiling helpers (`profiler.h/cpp`) and instrument capture→encode→mux paths.

Notes
- If your capture path guarantees fixed format (48 kHz stereo float) and the encoder accepts FLTP 48k, the current manual copy into planar float is acceptable and cheapest. Add `libswresample` only if you need broader format support, resampling, or channel-layout conversion.
- Always measure before optimizing: add profiling around the suspected hotspots and prioritize fixes using data.

If you want, I can implement the `SpscRingBuffer` + `SwrWrapper` and wire them into `AudioEngine`/`AudioEncoder` next.

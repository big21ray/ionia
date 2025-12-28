# TODO: H.264 B-frames and DTS/PTS correctness

## Why this matters
In RTMP/FLV ingest, packet timestamps must be monotonic and correct. For H.264 streams that use **B-frames**, the encoded output is typically in **decode order** (DTS order), while presentation order (PTS) differs.

If we set `pkt->dts = pkt->pts` for video packets unconditionally, and the encoder outputs B-frames, timestamps can become invalid/non-monotonic from the muxer/ingest point of view.

## Current situation
In `native-audio/src/stream_muxer.cpp`, video timestamps are currently derived from `frameIndex` and set as `pts==dts`.

## Fix (when needed)
- Detect whether the encoder can output B-frames (x264/NVENC settings).
- Prefer propagating encoder-provided timestamps (or compute DTS/PTS using encoder output ordering) instead of forcing `dts==pts`.
- Ensure `pkt->duration` matches the correct time base.

## How to validate
- Inspect the H.264 encoder settings (B-frames enabled/disabled).
- Add debug logs for first N packets: `pts`, `dts`, `flags`, and verify monotonic DTS.
- Test YouTube ingest preview and ffprobe the outgoing stream if possible.

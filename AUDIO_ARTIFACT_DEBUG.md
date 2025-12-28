# Audio Artifact Debugging Guide

## Enhanced Diagnostics Added

We've added comprehensive logging to track audio artifacts across the entire pipeline. Rebuild and stream again to generate detailed diagnostics.

### What We're Tracking

#### 1. **WASAPI Capture Level** (audio_engine.cpp)
```
[WASAPI] desktop: 960 frames (20.00 ms of audio)
⚠️ WASAPI DESKTOP: Frame count changed 960 → 512
```
- **What it means**: Each WASAPI callback delivers a certain number of frames
- **Artifact indicator**: Frame counts should be consistent. If they vary wildly, WASAPI capture is unstable
- **Fix**: Usually means audio driver issue or system overload

#### 2. **Buffer Health** (AudioEngine::Tick)
```
[AudioEngine::Tick] BEFORE MIX: desktop=4800 frames, mic=2400 frames, requesting=2304 frames
❌ AUDIO UNDERRUN RISK: desktop buffer has only 1152 frames (need ~2304)
❌ AUDIO OVERRUN RISK: desktop buffer has 57600 frames (latency building!)
```
- **Underrun**: Not enough audio buffered → produces silence or clicks
- **Overrun**: Too much audio buffered → causes latency buildup and eventual sync loss
- **Normal range**: Buffer should have 1.5-3x the requested frames

#### 3. **Encoding Consistency** (stream_muxer.cpp)
```
[Audio AUDIT] Pkt 0: size=601 bytes, numSamples=1024, pts=0 ms, duration=21 ms
[Audio AUDIT] Pkt 1: size=599 bytes, numSamples=1024, pts=21 ms, duration=21 ms
⚠️ IRREGULAR SAMPLE COUNT: last=1024, current=512 (expected 1024)
```
- **Normal**: All packets should have 1024 samples (except final flush)
- **Artifact indicator**: If sample counts vary (512, 1280, etc.), encoding is choppy
- **Fix**: Usually means audio source is providing inconsistent frame counts

#### 4. **Timestamp Jitter** (stream_muxer.cpp)
```
Audio delta ms = 21 (expected ~21)
Audio delta ms = 22 (expected ~21)
❌ AUDIO GAP DETECTED [1 total]: delta=19 ms (EARLY PACKET, gap_count=1)
❌ AUDIO BURST DETECTED [2 total]: delta=24 ms (LATE PACKET, burst_count=2)
```
- **Expected**: 21-22ms consistently (1024 samples @ 48kHz = 21.33ms → 21ms in milliseconds)
- **Gap** (delta < 19): Packet arrived early → discontinuity
- **Burst** (delta > 24): Packet arrived late → buffer drop likely happened
- **Artifact**: Gaps cause pitch artifacts, bursts cause crackling

#### 5. **Monotonic DTS Check** (stream_muxer.cpp)
```
❌ MONOTONIC DTS VIOLATION: current_dts=150 <= last_dts=150 (packet dropped)
```
- **Means**: Packet arrived out of order
- **Result**: Packet is dropped, audio skip/pop
- **Fix**: Usually caused by timing jitter or buffer mismanagement

---

## Debugging Strategy by Artifact Type

### **Crackling/Popping Sounds**

**Most likely causes (in order):**

1. **WASAPI frame count instability**
   - Look for: `⚠️ WASAPI DESKTOP: Frame count changed`
   - Fix: Could be audio driver bug. Try:
     - Update audio drivers
     - Change audio sample rate in Windows settings (48kHz → 44.1kHz → back to 48kHz)
     - Disable audio enhancements in Sound Settings

2. **Audio buffer underruns**
   - Look for: `❌ AUDIO UNDERRUN RISK`
   - Fix:
     - Reduce CPU load (close other apps)
     - Increase buffer size in AudioEngine (currently 100ms chunks)
     - Check if WASAPI is delivering frames consistently

3. **DTS violations (packets out of order)**
   - Look for: `❌ MONOTONIC DTS VIOLATION`
   - Fix: This shouldn't happen with current code. If it does, indicates timing chaos upstream

4. **Irregular sample counts**
   - Look for: `⚠️ IRREGULAR SAMPLE COUNT`
   - Fix: Audio encoder is producing variable-sized packets. Check audio_encoder.cpp

### **Audio Bursts Every 1 Second**

**Indicator:**
```
❌ AUDIO BURST DETECTED [1 total]: delta=24 ms
❌ AUDIO BURST DETECTED [2 total]: delta=24 ms  ← Every 1-2 seconds
```

**Causes:**
1. **Buffer overrun with drops**
   - Look for: `❌ AUDIO OVERRUN RISK` followed by burst deltas
   - Fix: Audio is arriving faster than we're encoding/sending
   - Solution: Reduce frame rate or bitrate

2. **Microphone + Desktop mixing lag**
   - Mic and desktop buffers getting out of sync
   - Look for: One buffer underrunning while other overruns
   - Fix: Adjust mic gain or mute desktop temporarily to isolate

3. **Encoding falling behind**
   - Look for: Gaps in AAC encoding rate
   - Fix: Check AudioPacketManager, may need parallel encoding threads

### **Pitch Distortion**

**Indicator:**
- Audio plays at wrong speed (too fast or too slow)
- Combined with timing logs showing:
  ```
  ❌ AUDIO GAP DETECTED: delta=19 ms (multiple times)
  OR
  ❌ AUDIO BURST DETECTED: delta=24 ms (multiple times)
  ```

**Causes:**
1. **Sample rate mismatch**
   - Expected: 48000 Hz throughout
   - Check: WASAPI capture rate vs AudioEngine::SAMPLE_RATE vs FFmpeg codec context
   - Fix: Add logging in audio_engine.cpp CaptureCallback to print actual WASAPI sample rate

2. **Time base inconsistency** (should be fixed now)
   - Look for: Time bases other than {1, 1000}
   - Would show in: stream_muxer.cpp Initialize() log
   - Fix: Verify both streams output {1, 1000}

3. **Resampling issues**
   - If WASAPI delivers different sample rate than 48kHz
   - Fix: Add resampler in audio_engine.cpp::CaptureCallback

---

## Step-by-Step Debugging Procedure

### 1. **Generate Full Diagnostic Log**

```powershell
cd "c:\Users\Karmine Corp\Documents\Ionia\native-audio"
Remove-Item build -Recurse -Force
.\build_all.bat
node test_framedup_fix.js 2>&1 | Tee-Object audio_debug_full.txt
```

### 2. **Capture the Artifact Moment**

Stream to YouTube and listen carefully. When you hear the artifact:
- Note the time (e.g., "artifact at 00:15 seconds")
- Don't stop the stream, let it continue to completion

### 3. **Analyze the Logs**

```powershell
# Find WASAPI frame irregularities
Select-String "Frame count changed" audio_debug_full.txt

# Find buffer problems
Select-String "RISK" audio_debug_full.txt

# Find audio gaps/bursts
Select-String "GAP DETECTED|BURST DETECTED" audio_debug_full.txt

# Find monotonic violations
Select-String "MONOTONIC DTS" audio_debug_full.txt

# Find irregular samples
Select-String "IRREGULAR SAMPLE" audio_debug_full.txt

# Count total occurrences
@{
    "Underruns" = (Select-String "UNDERRUN RISK" audio_debug_full.txt).Count
    "Overruns" = (Select-String "OVERRUN RISK" audio_debug_full.txt).Count
    "Gaps" = (Select-String "GAP DETECTED" audio_debug_full.txt).Count
    "Bursts" = (Select-String "BURST DETECTED" audio_debug_full.txt).Count
}
```

### 4. **Match Artifact Time to Log**

If artifact at 15 seconds:
- Audio packets: ~15000ms / 21ms ≈ 714 packets
- Look for packet 700-730 in logs for patterns

### 5. **Identify Root Cause**

Based on patterns in logs:

| Pattern | Root Cause |
|---------|-----------|
| Frequent `UNDERRUN RISK` | Audio source too slow |
| Frequent `OVERRUN RISK` → `BURST` | Audio source too fast or encoder slow |
| `Frame count changed` regularly | WASAPI is unstable |
| `GAP DETECTED` clusters | Timing jitter in capture |
| `BURST DETECTED` clusters | Buffer drop or encoder stall |
| `IRREGULAR SAMPLE COUNT` | Encoder producing wrong sizes |

---

## What If Diagnostics Look Perfect?

If the diagnostics show:
- ✅ No WASAPI frame changes
- ✅ Buffer in healthy range (1.5-3x requested)
- ✅ All deltas 21-22ms
- ✅ No DTS violations
- ✅ All samples 1024

**But you still hear artifacts in YouTube:**

This means:
1. **YouTube streaming path issue** (not our encoding)
   - Check: YouTube dashboard for bitrate/resolution issues
   - Check: Network latency/packet loss
   - Solution: Lower bitrate to 2Mbps, try different resolution

2. **YouTube FLV parser issue**
   - Check: Is stream actually FLV format? (should be, we set it)
   - Check: Try streaming to Twitch instead to isolate
   - Solution: YouTube may need sequence headers sent differently

3. **Playback/buffer issue on viewer side**
   - Artifacts may be YouTube's encoding/transmission, not our source
   - Solution: Test stream locally with ffplay first

---

## Local FLV Playback Testing

Before streaming to YouTube, test the FLV file locally:

```powershell
# Save stream to file instead
# Modify connection URL to: "file:C:/temp/test_output.flv"
# Run stream test
# Then play with ffplay

ffplay -i C:\temp\test_output.flv -autoexit

# Or inspect FLV structure
ffprobe -v debug C:\temp\test_output.flv 2>&1 | Tee-Object flv_structure.txt
```

Look for:
- Any codec errors
- PTS/DTS warnings
- Audio/video sync problems

---

## Next Actions

1. **Rebuild with new diagnostics:**
   ```powershell
   cd c:\Users\Karmine Corp\Documents\Ionia\native-audio
   Remove-Item build -Recurse -Force
   .\build_all.bat
   ```

2. **Stream and capture full log:**
   ```powershell
   node test_framedup_fix.js 2>&1 | Tee-Object audio_artifact_trace.txt
   ```

3. **Analyze patterns and reply with:**
   - Which pattern matches (UNDERRUN/OVERRUN/JITTER/etc)
   - Frequency of the artifacts
   - When they occur (randomly, periodically, start, end, etc)

4. **Share diagnostic output** - attach `audio_artifact_trace.txt` for detailed analysis

---

## Reference: Expected Healthy Output

```
[WASAPI] desktop: 960 frames (20.00 ms of audio)
[WASAPI] desktop: 960 frames (20.00 ms of audio)  ← Consistent
[WASAPI] desktop: 960 frames (20.00 ms of audio)
[AudioEngine::Tick] BEFORE MIX: desktop=4800 frames, mic=2400 frames, requesting=2304 frames
[Audio AUDIT] Pkt 0: size=601 bytes, numSamples=1024, pts=0 ms, duration=21 ms
Audio delta ms = 21 (expected ~21)
[Audio AUDIT] Pkt 1: size=599 bytes, numSamples=1024, pts=21 ms, duration=21 ms
Audio delta ms = 21 (expected ~21)  ← All 21-22
Audio delta ms = 22 (expected ~21)
[Audio AUDIT] Pkt 2: size=601 bytes, numSamples=1024, pts=42 ms, duration=21 ms
Audio delta ms = 21 (expected ~21)
```

**No error messages, consistent frame counts, consistent sample counts, perfect deltas.**

# GPU Pipeline Notes (OBS-style) — for future CPU reduction

Date: 2025-12-29

This doc summarizes:
1) What an “OBS-style GPU pipeline” means technically (and why it reduces CPU)
2) What the current Ionia native pipeline is doing today (NVENC vs CPU encoding)
3) What state-of-the-art capture/record apps likely do (Outplayed / Medal)

---

## 1) Why the GPU pipeline matters (it’s an optimization *and* architecture)

The CPU cost in screen recording typically comes from two places:
- **Color conversion / scaling**: e.g. RGBA → YUV (NV12/YUV420) and resize. In FFmpeg this is often `sws_scale` (CPU).
- **Encoding**: H.264/H.265 on CPU (e.g. x264/x265) is expensive.

An OBS-like pipeline reduces CPU by:
- Keeping frames on the **GPU** as textures (no GPU→CPU download)
- Doing format conversion on the **GPU** (shader or video processing)
- Feeding **hardware encoder input surfaces** directly (NVENC/AMF/QSV), avoiding CPU encode

It’s not purely “micro-optimization”: it changes how buffers, timing, and interop work (more complexity, but often the only way to get big CPU reductions).

---

## 2) Where Ionia is today (as implemented)

### 2.1 Current high-level path (today)

- Capture: **Desktop Duplication (D3D11)** → frame readback to a CPU RGBA buffer (or an equivalent CPU-accessible buffer)
- Convert: **CPU conversion via libswscale** (`sws_scale`) from RGBA → **YUV420P**
- Encode:
  - If requested, try **`h264_nvenc`** (NVENC) via FFmpeg
  - Else / if not available, fall back to **libx264/x264** via FFmpeg
  - Avoid `h264_mf` in COM STA mode (Electron tends to force STA; MFT encoder needs MTA)

Practical implication:
- Even if NVENC is selected, the current code still does CPU color conversion (`sws_scale`) to YUV420P.
- If NVENC is not available (FFmpeg build / drivers / env), it falls back to **CPU encode (x264)** which can keep CPU high.

### 2.2 Concrete details (from the current encoder code)

- Encoder selection tries `avcodec_find_encoder_by_name("h264_nvenc")` first, then `libx264`/`x264`.
- The codec context is configured with `pix_fmt = AV_PIX_FMT_YUV420P`.
- Conversion uses a persistent swscale context: RGBA → YUV420P (`SWS_BILINEAR`).

This combination is a common “works everywhere” approach, but it leaves a lot of CPU on the table.

### 2.3 “State-of-the-art” compared to today

Today (typical):
- GPU capture → **CPU RGBA** → **CPU swscale** → encoder (NVENC or x264)

State-of-the-art low CPU:
- GPU capture texture → **GPU RGBA texture** → **GPU convert to NV12/P010** → NVENC/AMF/QSV consumes **GPU surfaces**

The biggest CPU win is usually: **remove CPU conversion + remove CPU encode**.

---

## 3) What the OBS-style GPU pipeline looks like (Windows + D3D11)

### 3.1 Target pipeline (best case)

1) Capture gives an `ID3D11Texture2D` (BGRA/RGBA)
2) Convert on GPU:
   - Option A: HLSL compute shader BGRA/RGBA → **NV12** (or P010 for HDR)
   - Option B: D3D11 video processing (where suitable) to NV12
3) Encode with hardware:
   - NVENC (NVIDIA) / AMF (AMD) / QSV (Intel)
   - **Input is a GPU surface** (NV12/P010 texture) registered with the encoder
4) Mux to MP4/TS (CPU is fine here; muxing is cheap relative to encode/convert)

### 3.2 Why NV12/P010 matters

Hardware encoders typically prefer:
- SDR: **NV12** (8-bit 4:2:0, 2-plane)
- HDR: **P010** (10-bit 4:2:0)

If you feed YUV420P in CPU memory, you’ve already paid a lot of CPU cost.
If you feed NV12 as a GPU texture, you unlock the low-CPU path.

### 3.3 Minimum viable GPU conversion shader (conceptual)

- Compute shader reads RGBA/BGRA texture
- Writes:
  - Y plane: full resolution
  - UV plane: half resolution (4:2:0), interleaved UV
- Use a correct matrix for BT.709 (typical for desktop capture) and decide full vs limited range

This is “moderate” engineering if you keep scope small (one format, one matrix, fixed resolution), but production correctness + compatibility adds work.

### 3.4 The real hard parts (interop & correctness)

Interop hard parts:
- Ensuring the capture texture, conversion output texture, and encoder are on the **same D3D11 device/adapter**
- Managing a **surface pool** (avoid per-frame allocation)
- Avoiding GPU/CPU sync stalls (don’t block on the GPU each frame)
- Backpressure (if encoder can’t keep up, decide whether to drop frames or reduce FPS)

Correctness hard parts:
- BT.709 vs BT.601, limited vs full range
- Chroma downsampling quality (avoid ugly chroma artifacts)
- Handling resizing (if needed) without extra stalls

---

## 4) Implementation options (in increasing effort)

### Option 1 — “Fast improvement” without full GPU surfaces (still some CPU)
Goal: reduce CPU *encode*, keep conversion CPU.
- Make sure NVENC is reliably available in your FFmpeg build and runtime environment.
- Still converts via swscale on CPU, but encoding offloads to GPU.

Impact:
- Often helps, but **CPU can remain high** because `sws_scale` + readback can dominate.

### Option 2 — FFmpeg hardware frames path (GPU surfaces) (moderate/high effort)
Goal: keep frame on GPU into the encoder.
- Create a D3D11 hardware device context (`AV_HWDEVICE_TYPE_D3D11VA`).
- Use `hw_frames_ctx` and pass frames as `AV_PIX_FMT_D3D11` backed by `ID3D11Texture2D`.
- Use FFmpeg filters or HW upload/format conversion so the encoder receives NV12/P010 surfaces.

Pros:
- Avoids NVENC SDK directly; stays in FFmpeg ecosystem.

Cons:
- FFmpeg HW pipeline correctness/interop can be fiddly; debugging can be non-trivial.

### Option 3 — NVENC SDK directly (highest control) (high effort)
Goal: maximum performance + control.
- Register D3D11 textures with NVENC
- Manage encode sessions, surface queues, async completion

Pros:
- Best performance and control; less “FFmpeg black box”

Cons:
- More code, more edge cases, more maintenance.

---

## 5) What Outplayed / Medal likely do (practical inference)

These apps are proprietary, so we can’t state their internals as fact. But to achieve “low impact recording”, the industry-standard approach on Windows is:

- Prefer **hardware encoding** (NVENC/AMF/QSV) whenever available
- Keep frames **GPU-resident** as long as possible
- Use **game capture / hook** paths when available (DXGI/DX11/DX12/Vulkan), otherwise fall back to compositor/desktop capture
- Use a **circular buffer** (“instant replay”) so they can save the last N seconds without writing constantly
- Manage backpressure aggressively (drop frames or dynamically scale) to keep latency and overhead predictable

If you see low CPU while recording high resolution/FPS, it strongly suggests:
- Not using x264 for the main encode path
- Minimal CPU readback/convert in the steady state

---

## 6) CPU reduction checklist (what to do later)

### 6.1 Must-have checklist for big CPU wins
- Confirm NVENC is actually selected at runtime and that the FFmpeg build includes it
- Eliminate or reduce **GPU→CPU readback** in the video path
- Eliminate **CPU swscale** by converting on GPU to NV12/P010
- Feed the encoder **GPU surfaces**, not CPU YUV planes

### 6.2 “Good next diagnostics” (before big refactors)
- Verify Task Manager GPU “Video Encode” engine activity while recording
- Log which encoder is used (`h264_nvenc` vs `libx264` vs `h264_mf`)
- Measure time spent in:
  - capture
  - readback
  - swscale
  - encode

---

## 7) Roadmap — add true GPU encode (NVENC) step-by-step

This roadmap is written to reduce risk: each milestone is independently useful and has a clear “how to verify”.

### Milestone 0 — Make sure your app loads the right FFmpeg

Goal: guarantee the process is using an FFmpeg build that actually contains `h264_nvenc`.

What to do:
- Ensure the `avcodec-*` / `avutil-*` DLLs that your `.node` loads are the NVENC-enabled ones.
- Prefer bundling the FFmpeg DLLs next to the native module (or in a known app folder) and controlling DLL search order.

Verify:
- In-app logs: codec name resolves and codec opens successfully.
- Task Manager: GPU “Video Encode” increases while recording.

### Milestone 1 — NVENC works (even with CPU swscale)

Goal: move encode off CPU first.

What to do:
- Keep the current RGBA → YUV (CPU swscale) path.
- Ensure `h264_nvenc` is selected and `avcodec_open2` succeeds.

Verify:
- CPU drops compared to x264 at the same resolution/FPS.
- GPU “Video Encode” shows sustained activity.

### Milestone 2 — Switch pixel format to NV12 (reduce conversion cost and match HW encoders)

Goal: stop producing YUV420P and move toward encoder-native formats.

What to do:
- Reconfigure the pipeline to produce **NV12** (SDR) or **P010** (HDR) instead of YUV420P.
- If you keep conversion on CPU initially, use conversion that outputs NV12.

Verify:
- Encoder accepts the new format (no silent format fallback).
- Visual correctness: blacks/levels look right; no weird color shifts.

### Milestone 3 — Eliminate GPU→CPU readback (keep frames GPU-resident)

Goal: remove the largest source of stalls and CPU cost.

What to do:
- Avoid staging `Map()` readback for the steady-state encode path.
- Keep frames as `ID3D11Texture2D` and do conversion on GPU.

Verify:
- Big reduction in stutter/spikes; CPU drops further.
- Frametime becomes smoother, especially under GPU load.

### Milestone 4 — GPU conversion RGBA/BGRA → NV12/P010

Goal: replace CPU swscale with GPU work.

Implementation options:
- HLSL compute shader (most control)
- D3D11 video processor path (if it fits your constraints)

Verify:
- CPU time previously spent in swscale goes near-zero.
- Output stays visually correct across monitors/scenes.

### Milestone 5 — Feed NVENC GPU surfaces directly (true “OBS-style” path)

Goal: encoder consumes GPU textures without CPU copies.

Implementation options:
- FFmpeg HW frames (`AV_HWDEVICE_TYPE_D3D11VA`, `AV_PIX_FMT_D3D11` + `hw_frames_ctx`)
- NVENC SDK directly (register D3D11 textures, manage surface pool)

Verify:
- CPU is low even at high resolution/FPS.
- GPU “Video Encode” rises; GPU 3D usage stays reasonable.
- No unbounded buffering: steady memory usage under stress.

### Milestone 6 — Production hardening

Goal: make it robust like OBS.

What to do:
- Surface pool + backpressure strategy (drop frames vs reduce FPS)
- Multi-adapter/hybrid GPU handling (ensure capture + encode on same device)
- Fallbacks: if NVENC unavailable, choose x264 or an alternate HW encoder

Verify:
- Long runs without RAM growth.
- Works across different GPUs/drivers and multiple monitors.

---

## 8) Key takeaway

Your current pipeline is already structured to *choose* NVENC, but the biggest CPU cost often remains unless you also move conversion + frame transport to a GPU-surface workflow.

If the goal is “OBS-like CPU usage,” the technical endgame is:
- D3D11 texture in → GPU convert to NV12/P010 → hardware encode surfaces out.

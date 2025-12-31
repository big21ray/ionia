#include "audio_engine.h"
#include "audio_packet_manager.h"
#include <algorithm>
#include <cmath>
#include <cstring>

#include "ionia_logging.h"

AudioEngine::AudioEngine()
    : m_isRunning(false)
    , m_startTimeMs(0)
    , m_framesSent(0)
    , m_micGain(1.2f)  // Increased mic gain for better voice level
    , m_desktopGain(1.8f)  // Increased desktop gain (user reported desktop too low)
    , m_perfFreqInitialized(false)
{
    // Initialize performance counter frequency for monotonic clock
    if (QueryPerformanceFrequency(&m_perfFreq)) {
        m_perfFreqInitialized = true;
    }
}

AudioEngine::~AudioEngine() {
    Stop();
}

UINT64 AudioEngine::GetMonotonicTimeMs() const {
    if (!m_perfFreqInitialized) {
        // Fallback to GetTickCount64 (still monotonic, but less precise)
        return GetTickCount64();
    }

    LARGE_INTEGER counter;
    if (QueryPerformanceCounter(&counter)) {
        // Convert to milliseconds
        return (counter.QuadPart * 1000) / m_perfFreq.QuadPart;
    }

    // Fallback
    return GetTickCount64();
}

bool AudioEngine::Initialize(AudioPacketCallback callback) {
    if (!callback) {
        return false;
    }

    // Initialize packet manager
    if (!m_packetManager.Initialize(SAMPLE_RATE, CHANNELS)) {
        return false;
    }

    m_callback = callback;
    // Keep buffers small and bounded: enough to smooth jitter but not grow unbounded.
    // 10 AAC frames (~213ms @ 48kHz) per source is typically plenty.
    constexpr UINT32 kMaxBufferedFramesPerSource = 1024 * 10;
    const size_t capacitySamples = static_cast<size_t>(kMaxBufferedFramesPerSource) * CHANNELS;
    m_desktopBuffer.Reset(capacitySamples);
    m_micBuffer.Reset(capacitySamples);
    m_framesSent = 0;

    return true;
}

bool AudioEngine::Start() {
    if (m_isRunning) {
        return false;
    }

    if (!m_callback) {
        return false;
    }

    m_isRunning = true;
    m_startTimeMs = GetMonotonicTimeMs();
    m_framesSent = 0;

    return true;
}

void AudioEngine::Stop() {
    if (!m_isRunning) {
        return;
    }

    m_isRunning = false;

    // Clear buffers
    std::lock_guard<std::mutex> lock(m_bufferMutex);
    m_desktopBuffer.Reset(m_desktopBuffer.CapacitySamples());
    m_micBuffer.Reset(m_micBuffer.CapacitySamples());
}

void AudioEngine::FeedAudioData(const float* data, UINT32 numFrames, const char* source) {
    if (!data || numFrames == 0 || !source) {
        return;
    }

    if (!m_isRunning) {
        return;
    }

    const UINT32 numSamples = numFrames * CHANNELS;  // Stereo = 2 samples per frame

    std::lock_guard<std::mutex> lock(m_bufferMutex);

    // ARTIFACT DEBUG: Track WASAPI buffer health
    static int capture_callback_count = 0;
    if (capture_callback_count < 20 || capture_callback_count % 100 == 0) {
        Ionia::LogDebugf(
            "[WASAPI] %s: %u frames (%.2f ms of audio)\n",
            source,
            numFrames,
            (numFrames * 1000.0f) / SAMPLE_RATE);
    }
    capture_callback_count++;

    if (strcmp(source, "desktop") == 0) {
        m_desktopBuffer.PushSamples(data, numSamples);
        
        // ARTIFACT DEBUG: Check for gap between captures
        static UINT32 last_desktop_frames = 0;
        if (last_desktop_frames > 0 && numFrames != last_desktop_frames) {
            Ionia::LogInfof(
                "WASAPI DESKTOP: Frame count changed %u -> %u\n",
                last_desktop_frames,
                numFrames);
        }
        last_desktop_frames = numFrames;
    } else if (strcmp(source, "mic") == 0) {
        m_micBuffer.PushSamples(data, numSamples);
        
        // ARTIFACT DEBUG: Check for gap between captures
        static UINT32 last_mic_frames = 0;
        if (last_mic_frames > 0 && numFrames != last_mic_frames) {
            Ionia::LogInfof(
                "WASAPI MIC: Frame count changed %u -> %u\n",
                last_mic_frames,
                numFrames);
        }
        last_mic_frames = numFrames;
    }
}

void AudioEngine::MixAudio(UINT32 numFrames, std::vector<float>& output) {
    const UINT32 numSamples = numFrames * CHANNELS;
    output.resize(numSamples, 0.0f);

    std::lock_guard<std::mutex> lock(m_bufferMutex);

    const UINT32 desktopFramesAvailable = static_cast<UINT32>(m_desktopBuffer.SizeSamples() / CHANNELS);
    const UINT32 micFramesAvailable = static_cast<UINT32>(m_micBuffer.SizeSamples() / CHANNELS);

    for (UINT32 frame = 0; frame < numFrames; frame++) {
        for (UINT32 ch = 0; ch < CHANNELS; ch++) {
            const UINT32 sampleIdx = frame * CHANNELS + ch;
            float desktopSample = 0.0f;
            float micSample = 0.0f;

            // Get desktop sample if available, otherwise use silence (0)
            if (frame < desktopFramesAvailable) {
                desktopSample = m_desktopBuffer.GetSampleAt(sampleIdx) * m_desktopGain;
            }

            // Get mic sample if available, otherwise use silence (0)
            if (frame < micFramesAvailable) {
                micSample = m_micBuffer.GetSampleAt(sampleIdx) * m_micGain;
            }

            // Mix and clamp
            float mixed = desktopSample + micSample;
            if (mixed > 1.0f) mixed = 1.0f;
            if (mixed < -1.0f) mixed = -1.0f;

            output[sampleIdx] = mixed;
        }
    }

    // Consume exactly the samples we mixed (or what's available if a source underruns).
    const size_t numSamplesSizeT = static_cast<size_t>(numSamples);
    const size_t desktopAvailable = m_desktopBuffer.SizeSamples();
    const size_t micAvailable = m_micBuffer.SizeSamples();
    const size_t desktopSamplesToRemove = (desktopAvailable < numSamplesSizeT) ? desktopAvailable : numSamplesSizeT;
    const size_t micSamplesToRemove = (micAvailable < numSamplesSizeT) ? micAvailable : numSamplesSizeT;
    m_desktopBuffer.PopSamples(desktopSamplesToRemove);
    m_micBuffer.PopSamples(micSamplesToRemove);
}

void AudioEngine::MixAudioWithMode(UINT32 numFrames, const char* mode, std::vector<float>& output) {
    MixAudio(numFrames, output);

    if (mode && std::strcmp(mode, "both") == 0) {
        // When both sources are enabled, summing can clip (especially with gains).
        // A simple -6 dB mix attenuation reduces crackly distortion from hard clipping.
        for (float& sample : output) {
            sample *= 0.5f;
        }
    }
}

void AudioEngine::Tick() {
    if (!m_isRunning) {
        return;
    }

    // ============ BLOCK-BASED AUDIO PULLING (WITH SILENCE PADDING) ============
    // CRITICAL FIX FOR CRACKLES: Always emit 1024-sample frames, even if buffer incomplete
    // 
    // Previous Problem:
    // - Tick() returned early if buffer < 1024 samples
    // - AudioCapture delivers 480-frame chunks (10ms @48kHz)
    // - First Tick: 480 frames available → return early → NO AUDIO EMITTED
    // - Second Tick: 960 frames available → return early → NO AUDIO EMITTED  
    // - Third Tick: 1440 frames available → emit 1024, leaving 416 → AUDIO GAP
    // - Result: User hears crackles/pops at emission boundaries
    //
    // New Solution:
    // - ALWAYS emit 1024 samples per Tick (AAC requirement)
    // - If buffer has <1024 samples, pad remainder with SILENCE (0.0)
    // - This ensures perfectly smooth audio with no gaps
    // - OBS does this: it uses silence padding to maintain sync
    //
    // Why this works:
    // - Encoder expects 1024 samples, gets exactly 1024 every time
    // - No buffer underrun clicks
    // - No PTS jitter
    // - Silence padding is inaudible (much better than crackling)

    const UINT32 AAC_FRAME_SIZE = 1024;  // AAC frame size (non-negotiable)
    
    // Check available frames (don't block if <1024, just use what we have + silence)
    UINT32 availableFrames = 0;
    {
        std::lock_guard<std::mutex> lock(m_bufferMutex);
        const UINT32 desktopFrames = static_cast<UINT32>(m_desktopBuffer.SizeSamples() / CHANNELS);
        const UINT32 micFrames = static_cast<UINT32>(m_micBuffer.SizeSamples() / CHANNELS);
        availableFrames = desktopFrames + micFrames;
        
        // Log buffer state
        static int tick_count = 0;
        if (tick_count < 30 || tick_count % 50 == 0) {
            Ionia::LogDebugf(
                "[AudioEngine::Tick] BLOCK MODE: desktop=%u, mic=%u, total=%u (need %u) - %s\n",
                desktopFrames,
                micFrames,
                availableFrames,
                AAC_FRAME_SIZE,
                availableFrames >= AAC_FRAME_SIZE ? "READY" : "PADDING WITH SILENCE");
        }
        
        // Warn if buffer is building (WASAPI faster than pull)
        if (availableFrames > AAC_FRAME_SIZE * 10 && tick_count % 20 == 0) {
            Ionia::LogInfof(
                "AUDIO BUFFER BUILDING: %u frames (WASAPI delivering faster than we pull)\n",
                availableFrames);
        }
        
        tick_count++;
    }

    // ALWAYS mix exactly 1024 samples
    // If buffer has <1024, MixAudio will use what's available + silence padding
    std::vector<float> mixedAudio;
    MixAudio(AAC_FRAME_SIZE, mixedAudio);

    // Create packet with explicit frame count = 1024
    // This ensures PTS is always at perfect 1024-sample boundaries
    int64_t ptsFrames = static_cast<int64_t>(m_framesSent);

    AudioPacket packet = m_packetManager.CreatePacket(
        mixedAudio.data(),
        AAC_FRAME_SIZE,  // ← ALWAYS exactly 1024 samples (NO EXCEPTIONS)
        ptsFrames
    );

    // Call callback with AudioPacket
    if (m_callback && packet.isValid()) {
        m_callback(packet);
    }

    // Advance by exactly 1024 samples
    m_framesSent += AAC_FRAME_SIZE;
}

bool AudioEngine::TryPopMixedAudioPacket(UINT32 numFrames, const char* mode, AudioPacket& outPacket) {
    if (!m_isRunning || !mode || numFrames == 0) {
        return false;
    }

    bool ready = false;
    {
        std::lock_guard<std::mutex> lock(m_bufferMutex);

        const UINT32 desktopFramesAvailable = static_cast<UINT32>(m_desktopBuffer.SizeSamples() / CHANNELS);
        const UINT32 micFramesAvailable = static_cast<UINT32>(m_micBuffer.SizeSamples() / CHANNELS);

        if (std::strcmp(mode, "desktop") == 0) {
            ready = (desktopFramesAvailable >= numFrames);
        } else if (std::strcmp(mode, "mic") == 0) {
            ready = (micFramesAvailable >= numFrames);
        } else if (std::strcmp(mode, "both") == 0) {
            // Recorder-friendly: avoid padding one source with silence mid-stream.
            // Wait until BOTH sources have a full AAC block.
            ready = (desktopFramesAvailable >= numFrames) && (micFramesAvailable >= numFrames);
        } else {
            // Defensive default: behave like "both".
            ready = (desktopFramesAvailable >= numFrames) && (micFramesAvailable >= numFrames);
        }

        if (!ready) {
            return false;
        }
    }

    // Mix and consume exactly numFrames.
    std::vector<float> mixedAudio;
    MixAudioWithMode(numFrames, mode, mixedAudio);

    const int64_t ptsFrames = static_cast<int64_t>(m_framesSent);
    outPacket = m_packetManager.CreatePacket(mixedAudio.data(), numFrames, ptsFrames);
    if (!outPacket.isValid()) {
        return false;
    }

    m_framesSent += numFrames;
    return true;
}


#include "audio_engine.h"
#include "audio_packet_manager.h"
#include <algorithm>
#include <cmath>
#include <cstring>

AudioEngine::AudioEngine()
    : m_desktopFramesAvailable(0)
    , m_micFramesAvailable(0)
    , m_isRunning(false)
    , m_startTimeMs(0)
    , m_framesSent(0)
    , m_micGain(1.2f)  // Increased mic gain for better voice level
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
    m_desktopBuffer.clear();
    m_micBuffer.clear();
    m_desktopFramesAvailable = 0;
    m_micFramesAvailable = 0;
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
    m_desktopBuffer.clear();
    m_micBuffer.clear();
    m_desktopFramesAvailable = 0;
    m_micFramesAvailable = 0;
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
        fprintf(stderr, "[WASAPI] %s: %u frames (%.2f ms of audio)\n",
            source, numFrames, (numFrames * 1000.0f) / SAMPLE_RATE);
        fflush(stderr);
    }
    capture_callback_count++;

    if (strcmp(source, "desktop") == 0) {
        // Append desktop audio
        m_desktopBuffer.insert(m_desktopBuffer.end(), data, data + numSamples);
        m_desktopFramesAvailable += numFrames;
        
        // ARTIFACT DEBUG: Check for gap between captures
        static UINT32 last_desktop_frames = 0;
        if (last_desktop_frames > 0 && numFrames != last_desktop_frames) {
            fprintf(stderr, "⚠️ WASAPI DESKTOP: Frame count changed %u → %u\n",
                last_desktop_frames, numFrames);
            fflush(stderr);
        }
        last_desktop_frames = numFrames;
    } else if (strcmp(source, "mic") == 0) {
        // Append mic audio
        m_micBuffer.insert(m_micBuffer.end(), data, data + numSamples);
        m_micFramesAvailable += numFrames;
        
        // ARTIFACT DEBUG: Check for gap between captures
        static UINT32 last_mic_frames = 0;
        if (last_mic_frames > 0 && numFrames != last_mic_frames) {
            fprintf(stderr, "⚠️ WASAPI MIC: Frame count changed %u → %u\n",
                last_mic_frames, numFrames);
            fflush(stderr);
        }
        last_mic_frames = numFrames;
    }
}

void AudioEngine::MixAudio(UINT32 numFrames, std::vector<float>& output) {
    const UINT32 numSamples = numFrames * CHANNELS;
    output.resize(numSamples, 0.0f);

    std::lock_guard<std::mutex> lock(m_bufferMutex);

    // OBS-like: Mix each source independently
    // If a source is missing, use silence (0.0)
    // Never block on synchronization

    const float* desktopData = m_desktopBuffer.data();
    const float* micData = m_micBuffer.data();

    for (UINT32 frame = 0; frame < numFrames; frame++) {
        for (UINT32 ch = 0; ch < CHANNELS; ch++) {
            const UINT32 sampleIdx = frame * CHANNELS + ch;
            float desktopSample = 0.0f;
            float micSample = 0.0f;

            // OBS-like: Get desktop sample if available, otherwise use silence (0)
            if (frame < m_desktopFramesAvailable) {
                desktopSample = desktopData[sampleIdx];
            }

            // OBS-like: Get mic sample if available, otherwise use silence (0)
            if (frame < m_micFramesAvailable) {
                micSample = micData[sampleIdx] * m_micGain;
            }

            // Mix and clamp
            float mixed = desktopSample + micSample;
            if (mixed > 1.0f) mixed = 1.0f;
            if (mixed < -1.0f) mixed = -1.0f;

            output[sampleIdx] = mixed;
        }
    }

    // Remove consumed frames from buffers
    const UINT32 desktopSamplesToRemove = (std::min)(numSamples, static_cast<UINT32>(m_desktopBuffer.size()));
    const UINT32 micSamplesToRemove = (std::min)(numSamples, static_cast<UINT32>(m_micBuffer.size()));

    if (desktopSamplesToRemove > 0) {
        m_desktopBuffer.erase(m_desktopBuffer.begin(), m_desktopBuffer.begin() + desktopSamplesToRemove);
        m_desktopFramesAvailable -= (desktopSamplesToRemove / CHANNELS);
    }

    if (micSamplesToRemove > 0) {
        m_micBuffer.erase(m_micBuffer.begin(), m_micBuffer.begin() + micSamplesToRemove);
        m_micFramesAvailable -= (micSamplesToRemove / CHANNELS);
    }
}

void AudioEngine::Tick() {
    if (!m_isRunning) {
        return;
    }

    // ============ BLOCK-BASED AUDIO PULLING ============
    // FIXED ARCHITECTURE: Pull exactly 1024 samples per tick (AAC frame size)
    // This eliminates encoder buffering lag and PTS desync issues
    // 
    // Why this works:
    // - AAC encoder always expects 1024-sample blocks
    // - Previous: time-based pulling created irregular chunks (576, 768, 672...)
    // - Encoder had to buffer internally, causing PTS desync
    // - Result: dropped packets and audio artifacts
    // 
    // Now: Pull exactly when 1024 samples available
    // Result: Encoder releases 1 packet per Tick, perfect PTS alignment

    const UINT32 AAC_FRAME_SIZE = 1024;  // AAC frame size (non-negotiable)
    
    // Check if we have enough audio buffered for one AAC frame
    UINT32 availableFrames = 0;
    {
        std::lock_guard<std::mutex> lock(m_bufferMutex);
        availableFrames = m_desktopFramesAvailable + m_micFramesAvailable;
        
        // Log buffer state
        static int tick_count = 0;
        if (tick_count < 20 || tick_count % 50 == 0) {
            fprintf(stderr, "[AudioEngine::Tick] BLOCK MODE: desktop=%u frames, mic=%u frames, total=%u (need %u for AAC)\n",
                m_desktopFramesAvailable, m_micFramesAvailable, availableFrames, AAC_FRAME_SIZE);
            fflush(stderr);
        }
        
        // Warn if buffer is building (means WASAPI is faster than we're pulling)
        if (availableFrames > AAC_FRAME_SIZE * 10 && tick_count % 20 == 0) {
            fprintf(stderr, "⚠️ AUDIO BUFFER BUILDING: %u frames queued (WASAPI faster than pull rate)\n", availableFrames);
            fflush(stderr);
        }
        
        tick_count++;
    }

    // Only process if we have at least one full AAC frame
    if (availableFrames < AAC_FRAME_SIZE) {
        return;  // Wait for more audio to accumulate
    }

    // Mix EXACTLY 1024 samples (AAC frame size)
    // This ensures encoder gets perfectly aligned blocks
    std::vector<float> mixedAudio;
    MixAudio(AAC_FRAME_SIZE, mixedAudio);

    // Create packet with explicit frame count = 1024
    // This ensures PTS is always at perfect 1024-sample boundaries
    int64_t ptsFrames = static_cast<int64_t>(m_framesSent);

    AudioPacket packet = m_packetManager.CreatePacket(
        mixedAudio.data(),
        AAC_FRAME_SIZE,  // ← ALWAYS exactly 1024 samples
        ptsFrames
    );

    // Call callback with AudioPacket
    if (m_callback && packet.isValid()) {
        m_callback(packet);
    }

    // Advance by exactly 1024 samples
    m_framesSent += AAC_FRAME_SIZE;
}


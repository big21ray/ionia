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

    if (strcmp(source, "desktop") == 0) {
        // Append desktop audio
        m_desktopBuffer.insert(m_desktopBuffer.end(), data, data + numSamples);
        m_desktopFramesAvailable += numFrames;
    } else if (strcmp(source, "mic") == 0) {
        // Append mic audio
        m_micBuffer.insert(m_micBuffer.end(), data, data + numSamples);
        m_micFramesAvailable += numFrames;
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

    // OBS-like clock master logic:
    // Calculate how many frames we should have sent by now based on elapsed time
    const UINT64 currentTimeMs = GetMonotonicTimeMs();
    const UINT64 elapsedMs = currentTimeMs - m_startTimeMs;
    const UINT64 expectedFrames = (elapsedMs * SAMPLE_RATE) / 1000;
    const UINT64 framesToSend = expectedFrames - m_framesSent;

    if (framesToSend <= 0) {
        return;  // Not time to send yet
    }

    // Limit to reasonable chunks (max 100ms = 4800 frames at 48kHz)
    const UINT32 maxFramesPerTick = (SAMPLE_RATE / 10);  // 100ms
    const UINT32 outputFrames = static_cast<UINT32>((std::min)(static_cast<UINT64>(framesToSend), static_cast<UINT64>(maxFramesPerTick)));

    if (outputFrames == 0) {
        return;
    }

    // OBS-like: Always send the required number of frames
    // If no audio is available, send silence (OBS never blocks)
    std::vector<float> mixedAudio;
    MixAudio(outputFrames, mixedAudio);

    // Get current PTS in frames (OBS-like: explicit PTS control)
    int64_t ptsFrames = static_cast<int64_t>(m_framesSent);

    // Create AudioPacket with explicit PTS using AudioPacketManager
    // This ensures proper PTS control and synchronization
    AudioPacket packet = m_packetManager.CreatePacket(
        mixedAudio.data(),
        outputFrames,
        ptsFrames
    );

    // Call callback with AudioPacket (contains PTS for synchronization)
    if (m_callback && packet.isValid()) {
        m_callback(packet);
    }

    // Update frames sent counter
    m_framesSent += outputFrames;
}


#include "audio_packet_manager.h"
#include <cstring>

AudioPacketManager::AudioPacketManager()
    : m_initialized(false)
    , m_sampleRate(48000)
    , m_channels(2)
    , m_packetCount(0)
    , m_totalBytes(0)
{
    m_timeBase.num = 1;
    m_timeBase.den = 48000;
}

AudioPacketManager::~AudioPacketManager() {
}

bool AudioPacketManager::Initialize(UINT32 sampleRate, UINT16 channels) {
    if (m_initialized) {
        return false;  // Already initialized
    }

    if (sampleRate != 48000) {
        return false;  // Only 48kHz supported (matches audio engine)
    }

    if (channels != 2) {
        return false;  // Only stereo supported (matches audio engine)
    }

    m_sampleRate = sampleRate;
    m_channels = channels;
    m_timeBase.num = 1;
    m_timeBase.den = sampleRate;
    m_packetCount = 0;
    m_totalBytes = 0;

    m_initialized = true;
    return true;
}

AudioPacket AudioPacketManager::CreatePacket(const float* pcmData, UINT32 numFrames, int64_t ptsFrames) {
    AudioPacket packet;

    if (!m_initialized || !pcmData || numFrames == 0) {
        return packet;  // Return invalid packet
    }

    // Convert float32 PCM to byte vector
    const size_t numSamples = numFrames * m_channels;
    const size_t dataSize = numSamples * sizeof(float);
    
    std::vector<uint8_t> packetData(dataSize);
    std::memcpy(packetData.data(), pcmData, dataSize);

    // Create AVPacket with explicit PTS (OBS-like)
    // PTS is explicitly controlled from AudioEngine
    const int64_t pts = ptsFrames;  // PTS in frames (time_base = 1/48000)
    const int64_t dts = pts;        // For audio: DTS = PTS (no B-frames)
    const int64_t duration = numFrames;  // Duration in frames

    packet = AudioPacket(packetData, pts, dts, duration, 0);

    // Update statistics
    m_packetCount++;
    m_totalBytes += dataSize;

    return packet;
}


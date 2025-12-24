#ifndef AUDIO_PACKET_MANAGER_H
#define AUDIO_PACKET_MANAGER_H

#include <windows.h>
#include "av_packet.h"
#include <vector>
#include <cstdint>
#include <functional>

// Audio Packet Manager (OBS-like)
// Creates AVPackets with explicit PTS control from AudioEngine
// No encoding - just packages PCM data with PTS
class AudioPacketManager {
public:
    AudioPacketManager();
    ~AudioPacketManager();

    // Initialize packet manager
    // sampleRate: 48000 (must match audio engine)
    // channels: 2 (stereo)
    bool Initialize(UINT32 sampleRate, UINT16 channels);

    // Create AVPacket from PCM data with explicit PTS
    // pcmData: float32 interleaved stereo samples [L0, R0, L1, R1, ...]
    // numFrames: number of frames to package
    // ptsFrames: PTS in frames (from AudioEngine.GetCurrentPTSFrames())
    // Returns: AVPacket with explicit PTS
    AudioPacket CreatePacket(const float* pcmData, UINT32 numFrames, int64_t ptsFrames);

    // Get time base (1/sampleRate, so PTS is in frames)
    struct TimeBase {
        int num;
        int den;
    };
    TimeBase GetTimeBase() const { return m_timeBase; }

    // Get sample rate
    UINT32 GetSampleRate() const { return m_sampleRate; }

    // Get channels
    UINT16 GetChannels() const { return m_channels; }

    // Get total packets created
    size_t GetPacketCount() const { return m_packetCount; }

    // Get total bytes packaged
    size_t GetTotalBytes() const { return m_totalBytes; }

    // Check if initialized
    bool IsInitialized() const { return m_initialized; }

private:
    bool m_initialized;
    UINT32 m_sampleRate;
    UINT16 m_channels;
    TimeBase m_timeBase;

    // Statistics
    size_t m_packetCount;
    size_t m_totalBytes;
};

#endif // AUDIO_PACKET_MANAGER_H


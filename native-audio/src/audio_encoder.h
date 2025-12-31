#ifndef AUDIO_ENCODER_H
#define AUDIO_ENCODER_H

#include <windows.h>
#include "encoded_audio_packet.h"
#include <vector>
#include <cstdint>

// Forward declarations for FFmpeg
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libavutil/channel_layout.h>
}

// Audio Encoder (OBS-like)
// Encodes PCM audio to AAC using libavcodec
// Creates AVPackets with explicit PTS from AudioEngine
class AudioEncoder {
public:
    AudioEncoder();
    ~AudioEncoder();

    // Initialize encoder
    // sampleRate: 48000 (must match audio engine)
    // channels: 2 (stereo)
    // bitrate: bitrate in bits per second (e.g., 192000 for 192kbps)
    bool Initialize(UINT32 sampleRate, UINT16 channels, UINT32 bitrate);

    // Encode PCM frames to AAC
    // pcmData: float32 interleaved stereo samples [L0, R0, L1, R1, ...]
    // numFrames: number of frames to encode
    // Returns: vector of EncodedAudioPackets (BYTES ONLY, no timestamps)
    // The muxer assigns all timestamps
    std::vector<EncodedAudioPacket> EncodeFrames(const float* pcmData, UINT32 numFrames);

    // Flush encoder (get remaining encoded packets)
    // Returns: vector of EncodedAudioPackets (BYTES ONLY)
    std::vector<EncodedAudioPacket> Flush();

    // Get codec context
    AVCodecContext* GetCodecContext() const { return m_codecContext; }

    // Get sample rate
    UINT32 GetSampleRate() const { return m_sampleRate; }

    // Get channels
    UINT16 GetChannels() const { return m_channels; }

    // Get bitrate
    UINT32 GetBitrate() const { return m_bitrate; }

    // Check if initialized
    bool IsInitialized() const { return m_initialized; }

    // Get total packets encoded
    size_t GetPacketCount() const { return m_packetCount; }

    // Get total bytes encoded
    size_t GetTotalBytes() const { return m_totalBytes; }

private:
    bool m_initialized;
    UINT32 m_sampleRate;
    UINT16 m_channels;
    UINT32 m_bitrate;

    // FFmpeg codec context
    AVCodecContext* m_codecContext;
    const AVCodec* m_codec;
    AVFrame* m_frame;

    // Statistics
    size_t m_packetCount;
    size_t m_totalBytes;

    // Frame accumulation buffer (to avoid padding with silence)
    // Accumulates frames until we have enough for a complete encoder frame
    std::vector<float> m_accumulatedFrames;

    // Convert float32 PCM to int16 PCM (required for AAC encoder)
    void ConvertFloat32ToInt16(const float* floatData, int16_t* int16Data, UINT32 numSamples);
};

#endif // AUDIO_ENCODER_H


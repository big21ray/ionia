#ifndef AUDIO_MUXER_H
#define AUDIO_MUXER_H

#include <windows.h>
#include "av_packet.h"
#include <string>
#include <vector>
#include <cstdint>

// Forward declarations for FFmpeg
extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
}

// Audio Muxer (OBS-like)
// Muxes encoded audio packets to MP4 using libavformat
// Handles PTS synchronization explicitly
class AudioMuxer {
public:
    AudioMuxer();
    ~AudioMuxer();

    // Initialize muxer
    // outputPath: path to output MP4 file
    // sampleRate: 48000 (must match encoder)
    // channels: 2 (stereo)
    // bitrate: bitrate in bits per second
    bool Initialize(const std::string& outputPath, UINT32 sampleRate, UINT16 channels, UINT32 bitrate);

    // Write audio packet to muxer
    // packet: AudioPacket with encoded audio data and PTS
    // Returns: true if successful
    bool WritePacket(const AudioPacket& packet);

    // Finalize muxer (write trailer, close file)
    bool Finalize();

    // Get output path
    std::string GetOutputPath() const { return m_outputPath; }

    // Check if initialized
    bool IsInitialized() const { return m_initialized; }

    // Get total packets written
    size_t GetPacketCount() const { return m_packetCount; }

    // Get total bytes written
    size_t GetTotalBytes() const { return m_totalBytes; }

private:
    bool m_initialized;
    std::string m_outputPath;
    UINT32 m_sampleRate;
    UINT16 m_channels;
    UINT32 m_bitrate;

    // FFmpeg format context
    AVFormatContext* m_formatContext;
    AVStream* m_audioStream;
    AVCodecContext* m_codecContext;

    // Statistics
    size_t m_packetCount;
    size_t m_totalBytes;
};

#endif // AUDIO_MUXER_H


#ifndef VIDEO_MUXER_H
#define VIDEO_MUXER_H

#include <windows.h>
#include <string>
#include <cstdint>

// Forward declarations
class VideoEncoder;
struct AudioPacket;

// Forward declaration for VideoEncoder::EncodedPacket
namespace VideoEncoderNamespace {
    struct EncodedPacket;
}

// Forward declarations for FFmpeg
extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
}

// Video Muxer
// Muxes video and audio streams into MP4
// Synchronizes video and audio using audio PTS as reference
class VideoMuxer {
public:
    VideoMuxer();
    ~VideoMuxer();

    // Initialize muxer
    // outputPath: path to output MP4 file
    // videoEncoder: initialized video encoder (for codec parameters)
    // audioSampleRate: audio sample rate (e.g., 48000)
    // audioChannels: audio channels (e.g., 2)
    // audioBitrate: audio bitrate (e.g., 192000)
    // Returns: true if successful
    bool Initialize(const std::string& outputPath,
                    VideoEncoder* videoEncoder,
                    uint32_t audioSampleRate,
                    uint16_t audioChannels,
                    uint32_t audioBitrate);

    // Write video packet
    // packet: encoded video packet from VideoEncoder (passed as void* to avoid include dependency)
    // frameIndex: frame index (0, 1, 2, ...) - all packets from same frame use same index
    // audioPTS: current audio PTS (in frames) for synchronization
    // Returns: true if successful
    bool WriteVideoPacket(const void* packet, int64_t frameIndex, int64_t audioPTS);

    // Write audio packet
    // packet: encoded audio packet from AudioMuxer
    // Returns: true if successful
    bool WriteAudioPacket(const struct AudioPacket& packet);

    // Finalize muxer (write trailer, close file)
    bool Finalize();

    // Check if initialized
    bool IsInitialized() const { return m_initialized; }

    // Get output path
    std::string GetOutputPath() const { return m_outputPath; }

    // Statistics
    uint64_t GetVideoPackets() const { return m_videoPacketCount; }
    uint64_t GetAudioPackets() const { return m_audioPacketCount; }
    uint64_t GetTotalBytes() const { return m_totalBytes; }

private:
    bool m_initialized;
    std::string m_outputPath;

    // FFmpeg
    AVFormatContext* m_formatContext;
    AVStream* m_videoStream;
    AVStream* m_audioStream;
    AVCodecContext* m_audioCodecContext;  // Keep for rescaling timestamps
    AVRational m_originalVideoTimeBase;  // Store original time_base (FFmpeg may modify it)

    // Synchronization
    int64_t m_audioPTSOffset;  // Offset to align video with audio
    int64_t m_lastVideoPTS;
    int64_t m_lastVideoDTS;    // Track last DTS to ensure monotonically increasing
    int64_t m_lastAudioPTS;
    int64_t m_videoFrameCount;  // Track video frame count for PTS calculation

    // Statistics
    uint64_t m_videoPacketCount;
    uint64_t m_audioPacketCount;
    uint64_t m_totalBytes;

    // Helper methods
    bool SetupVideoStream(VideoEncoder* videoEncoder);
    bool SetupAudioStream(uint32_t audioSampleRate, uint16_t audioChannels, uint32_t audioBitrate);
    int64_t SyncVideoPTS(int64_t videoPTS, int64_t audioPTS);
};

#endif // VIDEO_MUXER_H


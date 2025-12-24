#ifndef VIDEO_MUXER_H
#define VIDEO_MUXER_H

#include <windows.h>
#include <string>
#include <cstdint>

// Forward declarations
class VideoEncoder;
struct EncodedAudioPacket;

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
    // Returns: true if successful
    // The muxer assigns PTS/DTS based on frameIndex (time_base = {1, fps})
    bool WriteVideoPacket(const void* packet, int64_t frameIndex);

    // Write audio packet
    // packet: encoded audio packet from AudioEncoder (BYTES ONLY, no timestamps)
    // Returns: true if successful
    // The muxer assigns PTS/DTS based on sample count (time_base = {1, sample_rate})
    bool WriteAudioPacket(const struct EncodedAudioPacket& packet);

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

    // Timestamp tracking
    int64_t m_lastVideoPTS;
    int64_t m_lastVideoDTS;    // Track last DTS to ensure monotonically increasing
    int64_t m_lastAudioPTS;
    int64_t m_videoFrameCount;  // Track video frame count for duration calculation
    int64_t m_audioSampleCount;  // Track audio sample count for timestamps

    // Statistics
    uint64_t m_videoPacketCount;
    uint64_t m_audioPacketCount;
    uint64_t m_totalBytes;

    // Helper methods
    bool SetupVideoStream(VideoEncoder* videoEncoder);
    bool SetupAudioStream(uint32_t audioSampleRate, uint16_t audioChannels, uint32_t audioBitrate);
};

#endif // VIDEO_MUXER_H


#ifndef VIDEO_ENCODER_H
#define VIDEO_ENCODER_H

#include <windows.h>
#include <cstdint>
#include <string>
#include <vector>

// Forward declarations for FFmpeg
extern "C" {
#include <libavcodec/avcodec.h>
#include <libavutil/opt.h>
#include <libavutil/imgutils.h>
}

// Video Encoder (NVENC or x264)
// Encodes raw RGBA frames to H.264
class VideoEncoder {
public:
    // Encoded packet structure (OBS-style: BYTES ONLY, no timestamps)
    // The muxer is the ONLY source of truth for timestamps
    struct EncodedPacket {
        std::vector<uint8_t> data;
        bool isKeyframe;

        EncodedPacket() : isKeyframe(false) {}
    };

    VideoEncoder();
    ~VideoEncoder();

    // Initialize encoder
    // width, height: frame dimensions
    // fps: frames per second (e.g., 30)
    // bitrate: bitrate in bits per second (e.g., 5000000 for 5 Mbps)
    // useNvenc: true to use NVENC (if available), false for x264
    // Returns: true if successful
    bool Initialize(uint32_t width, uint32_t height, uint32_t fps, uint32_t bitrate, bool useNvenc = true);

    // Encode a frame
    // frameData: RGBA32 frame data (width * height * 4 bytes)
    // Returns: vector of encoded packets (BYTES ONLY, no timestamps)
    // The muxer assigns all timestamps
    std::vector<EncodedPacket> EncodeFrame(const uint8_t* frameData);

    // Flush encoder (get remaining packets)
    std::vector<EncodedPacket> Flush();

    // Get codec name
    std::string GetCodecName() const;

    // Check if initialized
    bool IsInitialized() const { return m_initialized; }

    // Get frame dimensions
    void GetDimensions(uint32_t* width, uint32_t* height) const;

    // Get FPS
    uint32_t GetFPS() const { return m_fps; }

    // Cleanup
    void Cleanup();

private:
    bool m_initialized;
    bool m_useNvenc;
    uint32_t m_width;
    uint32_t m_height;
    uint32_t m_fps;
    uint32_t m_bitrate;
    
    // FFmpeg
    const AVCodec* m_codec;
    AVCodecContext* m_codecContext;
    AVFrame* m_frame;
    AVPacket* m_packet;
    
    // Statistics
    uint64_t m_frameCount;
    uint64_t m_packetCount;
    uint64_t m_totalBytes;
    
    // Helper methods
    bool InitializeCodec(bool useNvenc);
    bool AllocateFrame();
    void ConvertRGBAtoYUV(const uint8_t* rgbaData, AVFrame* frame);
};

#endif // VIDEO_ENCODER_H


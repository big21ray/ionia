#ifndef STREAM_MUXER_H
#define STREAM_MUXER_H

#include <string>
#include <cstdint>

extern "C" {
#include <libavformat/avformat.h>
#include <libavcodec/avcodec.h>
}

class VideoEncoder;
struct EncodedAudioPacket;
class StreamBuffer;

class StreamMuxer {
public:
    StreamMuxer();
    ~StreamMuxer();

    bool Initialize(
        const std::string& rtmpUrl,
        VideoEncoder* videoEncoder,
        uint32_t audioSampleRate,
        uint16_t audioChannels,
        uint32_t audioBitrate);

    bool WriteVideoPacket(const void* packet, int64_t frameIndex);
    bool WriteAudioPacket(const EncodedAudioPacket& packet);

    bool SendNextBufferedPacket();
    bool Flush();

    bool IsInitialized() const { return m_initialized; }
    bool IsConnected() const { return m_isConnected; }
    bool IsBackpressure() const;

    void SetDropVideoPackets(bool drop) { m_dropVideoPackets = drop; }
    void SetStreamBuffer(StreamBuffer* buffer) { m_buffer = buffer; }

    uint64_t GetVideoPackets() const { return m_videoPacketCount; }
    uint64_t GetAudioPackets() const { return m_audioPacketCount; }
    uint64_t GetTotalBytes() const { return m_totalBytes; }
    uint64_t GetVideoPacketsDropped() const { return m_videoPacketsDropped; }
    uint64_t GetAudioPacketsDropped() const { return m_audioPacketsDropped; }

    AVStream* GetAudioStream() const { return m_audioStream; }

    bool CheckRtmpConnection();
    bool ReconnectRtmp();

private:
    bool SetupVideoStream(VideoEncoder* encoder);
    bool SetupAudioStream(uint32_t sampleRate, uint16_t channels, uint32_t bitrate);
    void SendAACSequenceHeader();
    void SendAVCSequenceHeader();
    void Cleanup();

private:
    bool m_initialized = false;
    bool m_isConnected = false;
    bool m_dropVideoPackets = false;
    bool m_dropAllPackets = false;

    std::string m_rtmpUrl;

    AVFormatContext* m_formatContext = nullptr;
    AVStream* m_videoStream = nullptr;
    AVStream* m_audioStream = nullptr;
    AVCodecContext* m_audioCodecContext = nullptr;
    VideoEncoder* m_videoEncoder = nullptr;

    AVRational m_originalVideoTimeBase{0, 1};

    int64_t m_lastVideoPTS = 0;
    int64_t m_lastVideoDTS = 0;
    int64_t m_lastAudioPTS = 0;
    int64_t m_videoFrameCount = 0;
    int64_t m_audioSampleCount = 0;
    int64_t m_audioSamplesWritten;
    // Real-time pacing state for buffered network send.
    // m_streamStartUs: wall clock (us) when first packet was sent.
    // m_firstPacketDtsUs: timeline dts (us) of first packet sent.
    int64_t m_streamStartUs = -1;
    int64_t m_firstPacketDtsUs = -1;

    bool m_sentFirstVideoKeyframe = false;
    bool m_sentAACSequenceHeader = false;
    bool m_sentAVCSequenceHeader = false;

    int64_t m_lastWrittenVideoDTS = -1;
    int64_t m_lastWrittenAudioDTS = -1;

    uint64_t m_videoPacketCount = 0;
    uint64_t m_audioPacketCount = 0;
    uint64_t m_totalBytes = 0;
    uint64_t m_videoPacketsDropped = 0;
    uint64_t m_audioPacketsDropped = 0;

    StreamBuffer* m_buffer = nullptr;
};

#endif // STREAM_MUXER_H

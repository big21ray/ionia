#include "audio_muxer.h"
#include <libavutil/mem.h>
#include <libavutil/buffer.h>
#include <cstring>

AudioMuxer::AudioMuxer()
    : m_initialized(false)
    , m_sampleRate(48000)
    , m_channels(2)
    , m_bitrate(192000)
    , m_formatContext(nullptr)
    , m_audioStream(nullptr)
    , m_codecContext(nullptr)
    , m_packetCount(0)
    , m_totalBytes(0)
{
}

AudioMuxer::~AudioMuxer() {
    if (m_initialized) {
        Finalize();
    }
}

bool AudioMuxer::Initialize(const std::string& outputPath, UINT32 sampleRate, UINT16 channels, UINT32 bitrate) {
    if (m_initialized) {
        return false;  // Already initialized
    }

    m_outputPath = outputPath;
    m_sampleRate = sampleRate;
    m_channels = channels;
    m_bitrate = bitrate;

    // Allocate output format context
    int ret = avformat_alloc_output_context2(&m_formatContext, nullptr, nullptr, outputPath.c_str());
    if (ret < 0 || !m_formatContext) {
        return false;
    }

    // Find AAC encoder (for stream)
    const AVCodec* codec = avcodec_find_encoder(AV_CODEC_ID_AAC);
    if (!codec) {
        avformat_free_context(m_formatContext);
        m_formatContext = nullptr;
        return false;
    }

    // Create audio stream
    m_audioStream = avformat_new_stream(m_formatContext, codec);
    if (!m_audioStream) {
        avformat_free_context(m_formatContext);
        m_formatContext = nullptr;
        return false;
    }

    // Allocate codec context for stream
    m_codecContext = avcodec_alloc_context3(codec);
    if (!m_codecContext) {
        avformat_free_context(m_formatContext);
        m_formatContext = nullptr;
        return false;
    }

    // Configure codec context
    m_codecContext->bit_rate = m_bitrate;
    m_codecContext->sample_rate = m_sampleRate;
    m_codecContext->ch_layout.nb_channels = static_cast<int>(m_channels);
    av_channel_layout_default(&m_codecContext->ch_layout, static_cast<int>(m_channels));
    m_codecContext->sample_fmt = AV_SAMPLE_FMT_FLTP;
    m_codecContext->time_base = { 1, static_cast<int>(m_sampleRate) };  // Time base: 1/48000 (frames)

    // Open codec
    ret = avcodec_open2(m_codecContext, codec, nullptr);
    if (ret < 0) {
        avcodec_free_context(&m_codecContext);
        avformat_free_context(m_formatContext);
        m_codecContext = nullptr;
        m_formatContext = nullptr;
        return false;
    }

    // Copy codec parameters to stream
    ret = avcodec_parameters_from_context(m_audioStream->codecpar, m_codecContext);
    if (ret < 0) {
        avcodec_free_context(&m_codecContext);
        avformat_free_context(m_formatContext);
        m_codecContext = nullptr;
        m_formatContext = nullptr;
        return false;
    }

    // Set stream time base
    m_audioStream->time_base = m_codecContext->time_base;

    // Open output file
    if (!(m_formatContext->oformat->flags & AVFMT_NOFILE)) {
        ret = avio_open(&m_formatContext->pb, outputPath.c_str(), AVIO_FLAG_WRITE);
        if (ret < 0) {
            avcodec_free_context(&m_codecContext);
            avformat_free_context(m_formatContext);
            m_codecContext = nullptr;
            m_formatContext = nullptr;
            return false;
        }
    }

    // Write header
    ret = avformat_write_header(m_formatContext, nullptr);
    if (ret < 0) {
        if (!(m_formatContext->oformat->flags & AVFMT_NOFILE)) {
            avio_closep(&m_formatContext->pb);
        }
        avcodec_free_context(&m_codecContext);
        avformat_free_context(m_formatContext);
        m_codecContext = nullptr;
        m_formatContext = nullptr;
        return false;
    }

    m_packetCount = 0;
    m_totalBytes = 0;
    m_initialized = true;

    return true;
}

bool AudioMuxer::WritePacket(const AudioPacket& packet) {
    if (!m_initialized || !packet.isValid()) {
        return false;
    }

    // Create FFmpeg AVPacket
    AVPacket* avPacket = av_packet_alloc();
    if (!avPacket) {
        return false;
    }

    // Allocate and grow packet to fit data
    int ret = av_grow_packet(avPacket, packet.data.size());
    if (ret < 0) {
        av_packet_free(&avPacket);
        return false;
    }
    
    // Copy packet data
    std::memcpy(avPacket->data, packet.data.data(), packet.data.size());
    avPacket->size = packet.data.size();

    // Set PTS/DTS (explicit control from AudioEngine)
    avPacket->pts = packet.pts;
    avPacket->dts = packet.dts;
    avPacket->duration = packet.duration;
    avPacket->stream_index = m_audioStream->index;

    // NO rescale needed: codec time_base and stream time_base are the same (1/sampleRate)
    // av_packet_rescale_ts would be a no-op and might introduce floating point errors

    // Write packet
    ret = av_interleaved_write_frame(m_formatContext, avPacket);
    
    av_packet_free(&avPacket);

    if (ret < 0) {
        return false;
    }

    m_packetCount++;
    m_totalBytes += packet.data.size();

    return true;
}

bool AudioMuxer::Finalize() {
    if (!m_initialized) {
        return false;
    }

    // Write trailer
    int ret = av_write_trailer(m_formatContext);
    if (ret < 0) {
        // Continue with cleanup even if trailer write fails
    }

    // Close output file
    if (!(m_formatContext->oformat->flags & AVFMT_NOFILE)) {
        avio_closep(&m_formatContext->pb);
    }

    // Free resources
    if (m_codecContext) {
        avcodec_free_context(&m_codecContext);
        m_codecContext = nullptr;
    }

    if (m_formatContext) {
        avformat_free_context(m_formatContext);
        m_formatContext = nullptr;
    }

    m_audioStream = nullptr;
    m_initialized = false;

    return true;
}


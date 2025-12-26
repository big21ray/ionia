#include "stream_muxer.h"
#include "stream_buffer.h"   // 🔥 THIS IS REQUIRED
#include "video_encoder.h"
#include "encoded_audio_packet.h"


extern "C" {
#include <libavutil/time.h>
}

#include <cstring>
#include <cstdio>

/* ============================== */

StreamMuxer::StreamMuxer()
    : m_initialized(false),
      m_formatContext(nullptr),
      m_videoStream(nullptr),
      m_audioStream(nullptr),
      m_audioCodecContext(nullptr),
      m_originalVideoTimeBase({0,1}),
      m_streamStartUs(-1),
      m_sentFirstVideoKeyframe(false),
      m_videoPacketCount(0),
      m_audioPacketCount(0),
      m_totalBytes(0),
      m_videoPacketsDropped(0),
      m_audioPacketsDropped(0),
      m_dropVideoPackets(false),
      m_isConnected(false),
      m_dropAllPackets(false),
      m_buffer(nullptr)
{
    avformat_network_init();
}

StreamMuxer::~StreamMuxer() {
    if (m_initialized) {
        Flush();
        Cleanup();
    }
    avformat_network_deinit();
}

/* ============================== */

bool StreamMuxer::Initialize(const std::string& rtmpUrl,
                             VideoEncoder* videoEncoder,
                             uint32_t audioSampleRate,
                             uint16_t audioChannels,
                             uint32_t audioBitrate)
{
    if (m_initialized || !videoEncoder) return false;

    m_rtmpUrl = rtmpUrl;

    if (avformat_alloc_output_context2(&m_formatContext, nullptr, "flv",
                                       rtmpUrl.c_str()) < 0)
        return false;

    if (!SetupVideoStream(videoEncoder)) return false;
    if (!SetupAudioStream(audioSampleRate, audioChannels, audioBitrate)) return false;

    if (!(m_formatContext->oformat->flags & AVFMT_NOFILE)) {
        if (avio_open2(&m_formatContext->pb, rtmpUrl.c_str(),
                       AVIO_FLAG_WRITE, nullptr, nullptr) < 0)
            return false;
    }

    if (avformat_write_header(m_formatContext, nullptr) < 0)
        return false;

    m_initialized = true;
    m_isConnected = true;
    return true;
}

/* ============================== */

bool StreamMuxer::SetupVideoStream(VideoEncoder* encoder) {
    const AVCodec* codec = avcodec_find_encoder(AV_CODEC_ID_H264);
    if (!codec) return false;

    m_videoStream = avformat_new_stream(m_formatContext, codec);
    if (!m_videoStream) return false;

    AVCodecContext* ctx = avcodec_alloc_context3(codec);
    if (!ctx) return false;

    uint32_t w,h;
    encoder->GetDimensions(&w,&h);
    uint32_t fps = encoder->GetFPS();

    ctx->width = w;
    ctx->height = h;
    ctx->time_base = {1,(int)fps};
    ctx->framerate = {(int)fps,1};
    ctx->pix_fmt = AV_PIX_FMT_YUV420P;
    ctx->codec_type = AVMEDIA_TYPE_VIDEO;

    avcodec_parameters_from_context(m_videoStream->codecpar, ctx);

    m_videoStream->time_base = ctx->time_base;
    m_videoStream->avg_frame_rate = ctx->framerate;
    m_videoStream->r_frame_rate = ctx->framerate;

    m_originalVideoTimeBase = ctx->time_base;

    avcodec_free_context(&ctx);
    return true;
}

bool StreamMuxer::SetupAudioStream(uint32_t rate, uint16_t ch, uint32_t br) {
    const AVCodec* codec = avcodec_find_encoder(AV_CODEC_ID_AAC);
    if (!codec) return false;

    m_audioStream = avformat_new_stream(m_formatContext, codec);
    if (!m_audioStream) return false;

    m_audioCodecContext = avcodec_alloc_context3(codec);
    m_audioCodecContext->sample_rate = rate;
    m_audioCodecContext->ch_layout.nb_channels = ch;
    av_channel_layout_default(&m_audioCodecContext->ch_layout, ch);
    m_audioCodecContext->sample_fmt = AV_SAMPLE_FMT_FLTP;
    m_audioCodecContext->bit_rate = br;
    m_audioCodecContext->time_base = {1,(int)rate};

    avcodec_parameters_from_context(
        m_audioStream->codecpar, m_audioCodecContext);

    m_audioStream->time_base = m_audioCodecContext->time_base;
    return true;
}

/* ============================== */

bool StreamMuxer::WriteVideoPacket(const void* p, int64_t) {
    if (!m_initialized || !m_isConnected || m_dropAllPackets) return false;

    const auto* pktIn =
        static_cast<const VideoEncoder::EncodedPacket*>(p);
    if (pktIn->data.empty()) return false;

    AVPacket* pkt = av_packet_alloc();
    av_new_packet(pkt, pktIn->data.size());
    memcpy(pkt->data, pktIn->data.data(), pktIn->data.size());

    int64_t nowUs = av_gettime_relative();
    if (m_streamStartUs < 0) m_streamStartUs = nowUs;
    int64_t relUs = nowUs - m_streamStartUs;

    AVRational usTimeBase = {1, 1000000};
    pkt->pts = pkt->dts = av_rescale_q(relUs, usTimeBase, m_videoStream->time_base);
    pkt->duration = av_rescale_q(1000000 / 30, usTimeBase, m_videoStream->time_base);

    pkt->stream_index = m_videoStream->index;

    if (pktIn->isKeyframe) {
        pkt->flags |= AV_PKT_FLAG_KEY;
        m_sentFirstVideoKeyframe = true;
    }

    if (m_buffer) m_buffer->AddPacket(pkt);
    else av_interleaved_write_frame(m_formatContext, pkt);

    m_videoPacketCount++;
    m_totalBytes += pktIn->data.size();
    return true;
}

bool StreamMuxer::WriteAudioPacket(const EncodedAudioPacket& p) {
    if (!m_initialized || !m_isConnected || !m_sentFirstVideoKeyframe)
        return false;

    AVPacket* pkt = av_packet_alloc();
    av_new_packet(pkt, p.data.size());
    memcpy(pkt->data, p.data.data(), p.data.size());

    int64_t nowUs = av_gettime_relative();
    int64_t relUs = nowUs - m_streamStartUs;

    AVRational usTimeBase = {1, 1000000};
    AVRational sampleTimeBase = {1, (int)m_audioCodecContext->sample_rate};
    pkt->pts = pkt->dts = av_rescale_q(relUs, usTimeBase, m_audioStream->time_base);
    pkt->duration = av_rescale_q(1024, sampleTimeBase, m_audioStream->time_base);
    pkt->stream_index = m_audioStream->index;

    if (m_buffer) m_buffer->AddPacket(pkt);
    else av_interleaved_write_frame(m_formatContext, pkt);

    m_audioPacketCount++;
    m_totalBytes += p.data.size();
    return true;
}

/* ============================== */

bool StreamMuxer::SendNextBufferedPacket() {
    if (!m_buffer || !m_isConnected) return false;

    AVPacket* pkt = m_buffer->GetNextPacket();
    if (!pkt) return false;

    int ret = av_interleaved_write_frame(m_formatContext, pkt);
    av_packet_free(&pkt);

    if (ret < 0) {
        m_isConnected = false;
        return false;
    }
    return true;
}

bool StreamMuxer::Flush() {
    if (!m_initialized) return false;
    av_write_frame(m_formatContext, nullptr);
    return true;
}

void StreamMuxer::Cleanup() {
    if (m_formatContext) {
        if (!(m_formatContext->oformat->flags & AVFMT_NOFILE))
            avio_closep(&m_formatContext->pb);
        avformat_free_context(m_formatContext);
        m_formatContext = nullptr;
    }
    avcodec_free_context(&m_audioCodecContext);
    m_initialized = false;
}

bool StreamMuxer::IsBackpressure() const {
    return m_buffer && m_buffer->IsBackpressure();
}

bool StreamMuxer::CheckRtmpConnection() {
    return m_isConnected;
}

bool StreamMuxer::ReconnectRtmp() {
    return false;
}

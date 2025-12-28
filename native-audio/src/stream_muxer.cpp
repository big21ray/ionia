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
      m_isConnected(false),
      m_dropVideoPackets(false),
      m_dropAllPackets(false),
      m_formatContext(nullptr),
      m_videoStream(nullptr),
      m_audioStream(nullptr),
      m_audioCodecContext(nullptr),
      m_originalVideoTimeBase({0,1}),
      m_lastVideoPTS(0),
      m_lastVideoDTS(0),
      m_lastAudioPTS(0),
      m_videoFrameCount(0),
      m_audioSampleCount(0),
      m_audioSamplesWritten(0),
      m_streamStartUs(-1),
      m_sentFirstVideoKeyframe(false),
      m_videoPacketCount(0),
      m_audioPacketCount(0),
      m_totalBytes(0),
      m_videoPacketsDropped(0),
      m_audioPacketsDropped(0),
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

    // CRITICAL: Keep audio time_base as {1, 1000} to match video
    // avformat_write_header might change it, so force it back
    fprintf(stderr, "[Initialize] Before fix: audio time_base = {%d, %d}\n", 
            m_audioStream->time_base.num, m_audioStream->time_base.den);
    fflush(stderr);
    
    m_audioStream->time_base = {1, 1000};  // MUST be {1, 1000} to match video!
    
    fprintf(stderr, "[Initialize] After fix: audio time_base = {%d, %d}\n", 
            m_audioStream->time_base.num, m_audioStream->time_base.den);
    fflush(stderr);

    // Send sequence headers BEFORE any audio/video frames
    SendAACSequenceHeader();
    SendAVCSequenceHeader();

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

    m_videoEncoder = encoder;  // Store pointer for later use

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

    // Copy extradata (SPS/PPS) from encoder's codec context if available
    AVCodecContext* encoderCtx = encoder->GetCodecContext();
    if (encoderCtx && encoderCtx->extradata && encoderCtx->extradata_size > 0) {
        m_videoStream->codecpar->extradata = (uint8_t*)av_malloc(encoderCtx->extradata_size + AV_INPUT_BUFFER_PADDING_SIZE);
        if (m_videoStream->codecpar->extradata) {
            memcpy(m_videoStream->codecpar->extradata, encoderCtx->extradata, encoderCtx->extradata_size);
            m_videoStream->codecpar->extradata_size = encoderCtx->extradata_size;
        }
    }

    m_videoStream->time_base = {1, 1000};  // OBS-style: millisecond time_base
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

    fprintf(stderr, "[SetupAudioStream] Setting time_base to {1, %d} for sample rate %d\n", rate, rate);
    fflush(stderr);

    avcodec_parameters_from_context(
        m_audioStream->codecpar, m_audioCodecContext);

    // CRITICAL FIX: Both streams MUST use same time_base for av_write_frame!
    // Audio in milliseconds {1, 1000} to match video
    m_audioStream->time_base = {1, 1000};  // Milliseconds (MUST match video!)
    
    fprintf(stderr, "[SetupAudioStream] Audio time_base FIXED to {1, 1000} to match video\n");
    fflush(stderr);
    
    return true;
}

/* ============================== */

bool StreamMuxer::WriteVideoPacket(const void* p, int64_t frameIndex) {
    if (!m_initialized || !m_isConnected || m_dropAllPackets) return false;

    const auto* pktIn =
        static_cast<const VideoEncoder::EncodedPacket*>(p);
    if (pktIn->data.empty()) return false;

    AVPacket* pkt = av_packet_alloc();
    av_new_packet(pkt, pktIn->data.size());
    memcpy(pkt->data, pktIn->data.data(), pktIn->data.size());

    // GUARD: Don't send non-keyframe video before first keyframe
    if (!m_sentFirstVideoKeyframe && !pktIn->isKeyframe) {
        av_packet_free(&pkt);
        return false;
    }

    // RESCALE: Convert frame index to milliseconds (OBS style)
    // OBS uses millisecond timestamps for FLV streaming
    uint32_t fps = m_videoEncoder ? m_videoEncoder->GetFPS() : 30;
    int64_t pts_ms = av_rescale_q(
        frameIndex,
        AVRational{1, (int)fps},
        AVRational{1, 1000}
    );

    pkt->pts = pts_ms;
    pkt->dts = pts_ms;
    pkt->duration = av_rescale_q(
        1,
        AVRational{1, (int)fps},
        AVRational{1, 1000}
    );
    pkt->stream_index = m_videoStream->index;

    if (pktIn->isKeyframe) {
        pkt->flags |= AV_PKT_FLAG_KEY;
        m_sentFirstVideoKeyframe = true;
    }

    // MONOTONIC DTS CHECK
    if (pkt->dts <= m_lastWrittenVideoDTS) {
        av_packet_free(&pkt);
        return false;
    }
    m_lastWrittenVideoDTS = pkt->dts;

    if (m_buffer) m_buffer->AddPacket(pkt);
    else av_write_frame(m_formatContext, pkt);

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

    // CRITICAL FIX: Convert audio samples to milliseconds (same time_base as video)
    // Both streams use {1, 1000}, so PTS/duration must be in milliseconds
    int64_t audio_pts_ms = av_rescale_q(
        m_audioSamplesWritten,
        AVRational{1, m_audioCodecContext->sample_rate},
        AVRational{1, 1000}
    );

    pkt->pts = audio_pts_ms;
    pkt->dts = audio_pts_ms;
    pkt->duration = av_rescale_q(
        p.numSamples,
        AVRational{1, m_audioCodecContext->sample_rate},
        AVRational{1, 1000}
    );
    pkt->stream_index = m_audioStream->index;

    // COMPREHENSIVE AUDIO DIAGNOSTICS
    static int64_t last_audio_pts = -1;
    static int64_t last_numSamples = -1;
    static int audio_pkt_count = 0;
    static int burst_count = 0;
    static int gap_count = 0;
    
    if (last_audio_pts != -1) {
        int64_t delta = audio_pts_ms - last_audio_pts;
        int64_t expected_delta_ms = (p.numSamples * 1000) / m_audioCodecContext->sample_rate;
        
        fprintf(stderr, "Audio delta ms = %lld (expected ~21)\n", delta);
        fflush(stderr);
        
        // ARTIFACT DETECTION: Check for irregular patterns
        if (delta < 19) {
            gap_count++;
            fprintf(stderr,
                "❌ AUDIO GAP DETECTED [%d total]: delta=%lld ms (EARLY PACKET, gap_count=%d)\n",
                gap_count, delta, gap_count);
            fflush(stderr);
        } else if (delta > 24) {
            burst_count++;
            fprintf(stderr,
                "❌ AUDIO BURST DETECTED [%d total]: delta=%lld ms (LATE PACKET, burst_count=%d)\n",
                burst_count, delta, burst_count);
            fflush(stderr);
        }
        
        // Check for sample count consistency
        if (last_numSamples != -1 && p.numSamples != last_numSamples && p.numSamples != 1024) {
            fprintf(stderr,
                "⚠️ IRREGULAR SAMPLE COUNT: last=%lld, current=%lld (expected 1024)\n",
                last_numSamples, p.numSamples);
            fflush(stderr);
        }
    }
    last_audio_pts = audio_pts_ms;
    last_numSamples = p.numSamples;

    // Log every packet for full audit trail
    static int log_interval = 0;
    if (log_interval < 20 || log_interval % 50 == 0) {
        fprintf(stderr,
            "[Audio AUDIT] Pkt %d: size=%zu bytes, numSamples=%lld, pts=%lld ms, duration=%lld ms\n",
            audio_pkt_count, p.data.size(), p.numSamples, pkt->pts, pkt->duration);
        fflush(stderr);
    }
    log_interval++;
    audio_pkt_count++;

    m_audioSamplesWritten += p.numSamples;

    // MONOTONIC DTS CHECK
    if (pkt->dts <= m_lastWrittenAudioDTS) {
        fprintf(stderr,
            "❌ MONOTONIC DTS VIOLATION: current_dts=%lld <= last_dts=%lld (packet dropped)\n",
            pkt->dts, m_lastWrittenAudioDTS);
        fflush(stderr);
        av_packet_free(&pkt);
        return false;
    }
    m_lastWrittenAudioDTS = pkt->dts;

    if (m_buffer) m_buffer->AddPacket(pkt);
    else av_write_frame(m_formatContext, pkt);

    m_audioPacketCount++;
    m_totalBytes += p.data.size();
    return true;
}

/* ============================== */

void StreamMuxer::SendAACSequenceHeader() {
    if (!m_audioStream || !m_audioCodecContext || m_sentAACSequenceHeader)
        return;

    // Build FLV AAC sequence header
    // Format: [AACPacketType=0] [AudioSpecificConfig]
    
    // Get AudioSpecificConfig from encoder
    // For AAC LC, this is typically 2 bytes
    uint8_t audioSpecificConfig[2] = {0};
    
    // Simplified: construct from sample rate and channels
    // Real implementation would read from AVCodecContext
    int sample_rate_idx = 4; // 48kHz
    switch (m_audioCodecContext->sample_rate) {
        case 44100: sample_rate_idx = 4; break;
        case 48000: sample_rate_idx = 3; break;
        case 96000: sample_rate_idx = 1; break;
        default: return;
    }
    
    int channels = m_audioCodecContext->ch_layout.nb_channels;
    
    // AudioSpecificConfig format (MPEG-4 Audio):
    // [5 bits: object type] [4 bits: sample rate idx] [4 bits: channel config] [3 bits: frame length flag + depends on object type]
    // Object type 2 = AAC LC
    audioSpecificConfig[0] = ((2 << 3) | (sample_rate_idx >> 1)) & 0xFF;
    audioSpecificConfig[1] = ((sample_rate_idx << 7) | (channels << 3)) & 0xFF;

    AVPacket* pkt = av_packet_alloc();
    av_new_packet(pkt, 1 + sizeof(audioSpecificConfig));
    
    pkt->data[0] = 0; // AACPacketType = 0 (sequence header)
    memcpy(pkt->data + 1, audioSpecificConfig, sizeof(audioSpecificConfig));

    pkt->pts = 0;
    pkt->dts = 0;
    pkt->duration = 0;
    pkt->stream_index = m_audioStream->index;

    av_write_frame(m_formatContext, pkt);
    av_packet_free(&pkt);
    
    m_sentAACSequenceHeader = true;
}

void StreamMuxer::SendAVCSequenceHeader() {
    if (!m_videoStream || m_sentAVCSequenceHeader)
        return;

    // Get SPS/PPS from stream codecpar (we copied them in SetupVideoStream)
    if (!m_videoStream->codecpar->extradata || m_videoStream->codecpar->extradata_size == 0)
        return;

    // FLV AVC sequence header:
    // [AVC packet type = 0] [composition time offset] [AVCDecoderConfigurationRecord]
    
    int extradata_size = m_videoStream->codecpar->extradata_size;
    AVPacket* pkt = av_packet_alloc();
    av_new_packet(pkt, 4 + extradata_size); // 1 byte type + 3 bytes CTO + extradata
    
    pkt->data[0] = 0; // AVC packet type = 0 (sequence header)
    pkt->data[1] = 0; // Composition time offset (3 bytes) = 0
    pkt->data[2] = 0;
    pkt->data[3] = 0;
    
    memcpy(pkt->data + 4, m_videoStream->codecpar->extradata, extradata_size);

    pkt->pts = 0;
    pkt->dts = 0;
    pkt->duration = 0;
    pkt->stream_index = m_videoStream->index;

    av_write_frame(m_formatContext, pkt);
    av_packet_free(&pkt);
    
    m_sentAVCSequenceHeader = true;
}

/* ============================== */

bool StreamMuxer::SendNextBufferedPacket() {
    if (!m_buffer || !m_isConnected) return false;

    AVPacket* pkt = m_buffer->GetNextPacket();
    if (!pkt) return false;

    int ret = av_write_frame(m_formatContext, pkt);
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

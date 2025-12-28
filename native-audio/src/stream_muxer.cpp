#include "stream_muxer.h"
#include "stream_buffer.h"   // 🔥 THIS IS REQUIRED
#include "video_encoder.h"
#include "encoded_audio_packet.h"


extern "C" {
#include <libavutil/avutil.h>
#include <libavutil/mathematics.h>
#include <libavutil/time.h>
}

#include <cstring>
#include <cstdio>

/* ============================== */

static inline int64_t RescaleRounded(int64_t value, AVRational src, AVRational dst) {
    return av_rescale_q_rnd(
        value,
        src,
        dst,
        (AVRounding)(AV_ROUND_NEAR_INF | AV_ROUND_PASS_MINMAX));
}

static int AacSampleRateIndex(int sampleRate) {
    // MPEG-4 Audio samplingFrequencyIndex
    switch (sampleRate) {
        case 96000: return 0;
        case 88200: return 1;
        case 64000: return 2;
        case 48000: return 3;
        case 44100: return 4;
        case 32000: return 5;
        case 24000: return 6;
        case 22050: return 7;
        case 16000: return 8;
        case 12000: return 9;
        case 11025: return 10;
        case 8000:  return 11;
        case 7350:  return 12;
        default:    return -1;
    }
}

static bool SetAacAudioSpecificConfigExtradata(AVStream* stream, int sampleRate, int channels) {
    if (!stream || !stream->codecpar) return false;
    const int srIndex = AacSampleRateIndex(sampleRate);
    if (srIndex < 0) return false;

    // AudioSpecificConfig for AAC-LC (objectType=2), 2 bytes for common cases.
    // See ISO/IEC 14496-3.
    const uint8_t objectType = 2; // AAC LC
    const uint8_t channelConfig = (channels >= 0 && channels <= 7) ? (uint8_t)channels : 2;

    uint8_t asc[2];
    asc[0] = (uint8_t)((objectType << 3) | ((srIndex & 0x0F) >> 1));
    asc[1] = (uint8_t)(((srIndex & 0x01) << 7) | ((channelConfig & 0x0F) << 3));

    if (stream->codecpar->extradata) {
        av_freep(&stream->codecpar->extradata);
        stream->codecpar->extradata_size = 0;
    }

    stream->codecpar->extradata = (uint8_t*)av_malloc(sizeof(asc) + AV_INPUT_BUFFER_PADDING_SIZE);
    if (!stream->codecpar->extradata) return false;
    memcpy(stream->codecpar->extradata, asc, sizeof(asc));
    memset(stream->codecpar->extradata + sizeof(asc), 0, AV_INPUT_BUFFER_PADDING_SIZE);
    stream->codecpar->extradata_size = (int)sizeof(asc);
    return true;
}

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

    // Important: the muxer may adjust stream time_bases during header writing.
    // Log the final values so we can correlate with packet timestamp behavior.
    if (m_videoStream && m_audioStream) {
        fprintf(stderr,
                "[StreamMuxer] Post-header time_base: video={%d/%d} audio={%d/%d}\n",
                m_videoStream->time_base.num, m_videoStream->time_base.den,
                m_audioStream->time_base.num, m_audioStream->time_base.den);
        fflush(stderr);
    }

    // Provide time_base info to the StreamBuffer so it can compute ordering/latency in milliseconds
    // while leaving each packet's timestamps in the stream's native time_base.
    if (m_buffer && m_videoStream && m_audioStream) {
        m_buffer->SetStreamInfo(
            m_videoStream->index, m_videoStream->time_base,
            m_audioStream->index, m_audioStream->time_base);
    }

    // Note: do NOT manually write FLV AAC/AVC "sequence header" packets here.
    // When using libavformat's FLV muxer, you must provide codec extradata
    // (AAC AudioSpecificConfig, H264 avcC) and then write raw AAC/H264 packets.
    // Manually injecting FLV-tag payloads via av_write_frame() corrupts the stream.

    // Reset pacing state (used by buffered network send)
    m_streamStartUs = -1;
    m_firstPacketDtsUs = -1;

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

    // Provide AAC AudioSpecificConfig as codec extradata so the FLV muxer can emit
    // the proper AAC sequence header (AudioSpecificConfig) automatically.
    if (!SetAacAudioSpecificConfigExtradata(m_audioStream, (int)rate, (int)ch)) {
        fprintf(stderr, "[SetupAudioStream] Failed to set AAC AudioSpecificConfig extradata\n");
        fflush(stderr);
        return false;
    }

    // Keep audio timestamps in sample units (1/sample_rate). This avoids millisecond rounding jitter.
    // FFmpeg will rescale as needed for the FLV/RTMP muxer.
    m_audioStream->time_base = m_audioCodecContext->time_base;
    
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

    // Video clock: frameIndex in {1/fps}. Convert directly into the muxer's chosen
    // stream time_base using rounded rescaling to avoid systematic drift.
    const uint32_t fps = m_videoEncoder ? m_videoEncoder->GetFPS() : 30;
    const AVRational vSrcTb{1, (int)fps};
    const AVRational vDstTb = m_videoStream->time_base;

    const int64_t pts = RescaleRounded(frameIndex, vSrcTb, vDstTb);
    int64_t nextPts = RescaleRounded(frameIndex + 1, vSrcTb, vDstTb);
    if (nextPts <= pts) nextPts = pts + 1;

    pkt->pts = pts;
    pkt->dts = pts;  // NOTE: only correct if encoder outputs no B-frames
    pkt->duration = nextPts - pts;
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

    if (m_buffer) {
        if (!m_buffer->AddPacket(pkt)) {
            m_videoPacketsDropped++;
            return false;
        }
    } else {
        int ret = av_interleaved_write_frame(m_formatContext, pkt);
        av_packet_free(&pkt);
        if (ret < 0) {
            char errbuf[256];
            av_strerror(ret, errbuf, sizeof(errbuf));
            fprintf(stderr, "[StreamMuxer] WriteVideoPacket av_interleaved_write_frame failed: %s\n", errbuf);
            fflush(stderr);
            m_isConnected = false;
            return false;
        }
    }

    m_videoPacketCount++;
    m_totalBytes += pktIn->data.size();
    return true;
}

bool StreamMuxer::WriteAudioPacket(const EncodedAudioPacket& p) {
    if (!m_initialized || !m_isConnected)
        return false;
    
    // Note: We DON'T require m_sentFirstVideoKeyframe for audio
    // Audio can be buffered until video starts
    // This prevents audio drop when video is still initializing

    AVPacket* pkt = av_packet_alloc();
    av_new_packet(pkt, p.data.size());
    memcpy(pkt->data, p.data.data(), p.data.size());

    // Audio clock: cumulative samples in {1/sample_rate}. Convert into the muxer's chosen
    // stream time_base using rounded rescaling, and derive duration from nextPts-pts
    // to avoid drift (which can present as "accelerated" playback).
    const int sr = (m_audioCodecContext && m_audioCodecContext->sample_rate) ? m_audioCodecContext->sample_rate : 48000;
    const AVRational audioSrcTb{1, sr};
    const AVRational audioDstTb = m_audioStream->time_base;

    const int64_t curSamples = m_audioSamplesWritten;
    const int64_t nextSamples = curSamples + p.numSamples;

    const int64_t pts = RescaleRounded(curSamples, audioSrcTb, audioDstTb);
    int64_t nextPts = RescaleRounded(nextSamples, audioSrcTb, audioDstTb);
    if (nextPts <= pts) nextPts = pts + 1;

    pkt->pts = pts;
    pkt->dts = pts;
    pkt->duration = nextPts - pts;
    pkt->stream_index = m_audioStream->index;

    // Advance sample counter
    m_audioSamplesWritten = nextSamples;

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

    if (m_buffer) {
        if (!m_buffer->AddPacket(pkt)) {
            m_audioPacketsDropped++;
            return false;
        }
    } else {
        int ret = av_interleaved_write_frame(m_formatContext, pkt);
        av_packet_free(&pkt);
        if (ret < 0) {
            char errbuf[256];
            av_strerror(ret, errbuf, sizeof(errbuf));
            fprintf(stderr, "[StreamMuxer] WriteAudioPacket av_interleaved_write_frame failed: %s\n", errbuf);
            fflush(stderr);
            m_isConnected = false;
            return false;
        }
    }

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

    // ================== REAL-TIME PACING ==================
    // The network thread can drain the buffer faster than real time.
    // Sleep until this packet's DTS is due (relative to the first packet sent).
    // This prevents "accelerated" playback where timeline advances faster than wall time.
    if (m_formatContext && pkt->stream_index >= 0 && pkt->stream_index < (int)m_formatContext->nb_streams) {
        const AVRational tb = m_formatContext->streams[pkt->stream_index]->time_base;
        const int64_t pktDtsUs = av_rescale_q(pkt->dts, tb, AVRational{1, 1000000});

        if (m_streamStartUs < 0 || m_firstPacketDtsUs < 0) {
            m_streamStartUs = av_gettime_relative();
            m_firstPacketDtsUs = pktDtsUs;
        } else {
            const int64_t nowUs = av_gettime_relative();
            const int64_t elapsedUs = nowUs - m_streamStartUs;
            const int64_t targetUs = pktDtsUs - m_firstPacketDtsUs;

            // Small tolerance to avoid micro-sleeps (and give the muxer a tiny lead).
            const int64_t toleranceUs = 2000;
            if (targetUs > elapsedUs + toleranceUs) {
                int64_t sleepUs = targetUs - elapsedUs;
                if (sleepUs > 250000) sleepUs = 250000; // cap at 250ms per packet
                if (sleepUs > 0) {
                    av_usleep((unsigned int)sleepUs);
                }
            }
        }
    }

    int ret = av_interleaved_write_frame(m_formatContext, pkt);
    av_packet_free(&pkt);

    if (ret < 0) {
        char errbuf[256];
        av_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "[StreamMuxer] SendNextBufferedPacket av_interleaved_write_frame failed: %s\n", errbuf);
        fflush(stderr);
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

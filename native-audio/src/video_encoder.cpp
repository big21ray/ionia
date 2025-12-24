#include "video_encoder.h"

extern "C" {
#include <libswscale/swscale.h>
#include <libavutil/imgutils.h>
}

#include <cstring>
#include <cstdio>

VideoEncoder::VideoEncoder()
    : m_initialized(false)
    , m_useNvenc(false)
    , m_width(0)
    , m_height(0)
    , m_fps(30)
    , m_bitrate(5000000)
    , m_codec(nullptr)
    , m_codecContext(nullptr)
    , m_frame(nullptr)
    , m_packet(nullptr)
    , m_frameCount(0)
    , m_packetCount(0)
    , m_totalBytes(0)
{
}

VideoEncoder::~VideoEncoder() {
    Cleanup();
}

bool VideoEncoder::Initialize(uint32_t width, uint32_t height, uint32_t fps, uint32_t bitrate, bool useNvenc) {
    if (m_initialized) {
        return false;
    }

    m_width = width;
    m_height = height;
    m_fps = fps;
    m_bitrate = bitrate;
    m_useNvenc = useNvenc;

    // Initialize codec
    if (!InitializeCodec(useNvenc)) {
        fprintf(stderr, "[VideoEncoder] Failed to initialize codec\n");
        return false;
    }

    // Allocate frame
    if (!AllocateFrame()) {
        fprintf(stderr, "[VideoEncoder] Failed to allocate frame\n");
        Cleanup();
        return false;
    }

    m_initialized = true;
    fprintf(stderr, "[VideoEncoder] Initialized: %ux%u @ %u fps, %u bps, codec=%s\n",
            m_width, m_height, m_fps, m_bitrate, GetCodecName().c_str());
    return true;
}

bool VideoEncoder::InitializeCodec(bool useNvenc) {
    // Try NVENC first if requested
    if (useNvenc) {
        m_codec = avcodec_find_encoder_by_name("h264_nvenc");
        if (m_codec) {
            fprintf(stderr, "[VideoEncoder] Using NVENC encoder\n");
        } else {
            fprintf(stderr, "[VideoEncoder] NVENC not available, falling back to x264\n");
            useNvenc = false;
        }
    }

    // Fallback to x264
    if (!m_codec) {
        m_codec = avcodec_find_encoder(AV_CODEC_ID_H264);
        if (!m_codec) {
            fprintf(stderr, "[VideoEncoder] H.264 encoder not found\n");
            return false;
        }
        fprintf(stderr, "[VideoEncoder] Using x264 encoder\n");
    }

    // Allocate codec context
    m_codecContext = avcodec_alloc_context3(m_codec);
    if (!m_codecContext) {
        fprintf(stderr, "[VideoEncoder] Failed to allocate codec context\n");
        return false;
    }

    // Configure codec context
    m_codecContext->width = m_width;
    m_codecContext->height = m_height;
    m_codecContext->time_base = { 1, static_cast<int>(m_fps) };  // 1/fps
    m_codecContext->framerate = { static_cast<int>(m_fps), 1 };
    m_codecContext->pix_fmt = AV_PIX_FMT_YUV420P;
    m_codecContext->bit_rate = m_bitrate;
    m_codecContext->gop_size = m_fps * 2;  // Keyframe every 2 seconds
    m_codecContext->max_b_frames = 0;
    av_opt_set(m_codecContext->priv_data, "bf", "0", 0);
    // Set codec-specific options
    if (useNvenc) {
        // NVENC options
        av_opt_set(m_codecContext->priv_data, "preset", "fast", 0);
        av_opt_set(m_codecContext->priv_data, "tune", "ll", 0);  // Low latency
        av_opt_set(m_codecContext->priv_data, "rc", "cbr", 0);  // Constant bitrate
    } else {
        // x264 options
        av_opt_set(m_codecContext->priv_data, "preset", "veryfast", 0);
        av_opt_set(m_codecContext->priv_data, "tune", "zerolatency", 0);
        av_opt_set(m_codecContext->priv_data, "profile", "baseline", 0);
    }

    // Open codec
    int ret = avcodec_open2(m_codecContext, m_codec, nullptr);
    if (ret < 0) {
        char errbuf[256];
        av_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "[VideoEncoder] Failed to open codec: %s\n", errbuf);
        avcodec_free_context(&m_codecContext);
        return false;
    }

    return true;
}

bool VideoEncoder::AllocateFrame() {
    m_frame = av_frame_alloc();
    if (!m_frame) {
        return false;
    }

    m_frame->format = m_codecContext->pix_fmt;
    m_frame->width = m_codecContext->width;
    m_frame->height = m_codecContext->height;

    int ret = av_frame_get_buffer(m_frame, 32);  // 32-byte alignment
    if (ret < 0) {
        av_frame_free(&m_frame);
        return false;
    }

    m_packet = av_packet_alloc();
    if (!m_packet) {
        av_frame_free(&m_frame);
        return false;
    }

    return true;
}

void VideoEncoder::ConvertRGBAtoYUV(const uint8_t* rgbaData, AVFrame* frame) {
    // Use swscale to convert RGBA to YUV420P
    static struct SwsContext* swsContext = nullptr;
    
    if (!swsContext) {
        swsContext = sws_getContext(
            m_width, m_height, AV_PIX_FMT_RGBA,
            m_width, m_height, AV_PIX_FMT_YUV420P,
            SWS_BILINEAR, nullptr, nullptr, nullptr
        );
        if (!swsContext) {
            fprintf(stderr, "[VideoEncoder] Failed to create swscale context\n");
            return;
        }
    }

    const uint8_t* srcData[4] = { rgbaData, nullptr, nullptr, nullptr };
    int srcLinesize[4] = { static_cast<int>(m_width * 4), 0, 0, 0 };

    sws_scale(swsContext, srcData, srcLinesize, 0, m_height,
              frame->data, frame->linesize);
}

std::vector<VideoEncoder::EncodedPacket> VideoEncoder::EncodeFrame(const uint8_t* frameData, int64_t pts) {
    std::vector<VideoEncoder::EncodedPacket> packets;

    if (!m_initialized || !frameData) {
        return packets;
    }

    // Make frame writable
    int ret = av_frame_make_writable(m_frame);
    if (ret < 0) {
        fprintf(stderr, "[VideoEncoder] Failed to make frame writable\n");
        return packets;
    }

    // Convert RGBA to YUV420P
    ConvertRGBAtoYUV(frameData, m_frame);

    // Set frame PTS (encoder needs it for internal buffering, but we ignore it in packets)
    // The pts parameter is kept for encoder internal use, but we don't propagate it
    m_frame->pts = pts;
    m_frame->pict_type = AV_PICTURE_TYPE_NONE;  // Let encoder decide

    // Send frame to encoder
    ret = avcodec_send_frame(m_codecContext, m_frame);
    if (ret < 0) {
        char errbuf[256];
        av_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "[VideoEncoder] avcodec_send_frame failed: %s\n", errbuf);
        return packets;
    }

    m_frameCount++;

    // Receive encoded packets
    while (true) {
        ret = avcodec_receive_packet(m_codecContext, m_packet);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
            break;
        }
        if (ret < 0) {
            char errbuf[256];
            av_strerror(ret, errbuf, sizeof(errbuf));
            fprintf(stderr, "[VideoEncoder] avcodec_receive_packet failed: %s\n", errbuf);
            break;
        }

        // Create encoded packet (OBS-style: BYTES ONLY)
        // Encoder does NOT manage timestamps - muxer is the only source of truth
        EncodedPacket packet;
        packet.data.assign(m_packet->data, m_packet->data + m_packet->size);
        packet.isKeyframe = (m_packet->flags & AV_PKT_FLAG_KEY) != 0;

        packets.push_back(packet);

        m_packetCount++;
        m_totalBytes += m_packet->size;

        av_packet_unref(m_packet);
    }

    return packets;
}

std::vector<VideoEncoder::EncodedPacket> VideoEncoder::Flush() {
    std::vector<EncodedPacket> packets;

    if (!m_initialized) {
        return packets;
    }

    // Send NULL frame to flush encoder
    // CRITICAL: After this, NEVER call avcodec_send_frame again
    int ret = avcodec_send_frame(m_codecContext, nullptr);
    if (ret < 0) {
        char errbuf[256];
        av_strerror(ret, errbuf, sizeof(errbuf));
        fprintf(stderr, "[VideoEncoder] Flush: avcodec_send_frame failed: %s\n", errbuf);
        return packets;
    }

    // Receive remaining packets
    // CRITICAL: Use encoder's timestamps directly (don't recalculate PTS)
    // These packets come AFTER all regular frames, so their DTS must be monotonic
    while (true) {
        ret = avcodec_receive_packet(m_codecContext, m_packet);
        if (ret == AVERROR(EAGAIN) || ret == AVERROR_EOF) {
            break;
        }
        if (ret < 0) {
            char errbuf[256];
            av_strerror(ret, errbuf, sizeof(errbuf));
            fprintf(stderr, "[VideoEncoder] Flush: avcodec_receive_packet failed: %s\n", errbuf);
            break;
        }

        // Create encoded packet (OBS-style: BYTES ONLY)
        // Encoder does NOT manage timestamps - muxer is the only source of truth
        EncodedPacket packet;
        packet.data.assign(m_packet->data, m_packet->data + m_packet->size);
        packet.isKeyframe = (m_packet->flags & AV_PKT_FLAG_KEY) != 0;

        packets.push_back(packet);

        m_packetCount++;
        m_totalBytes += m_packet->size;

        av_packet_unref(m_packet);
    }

    fprintf(stderr, "[VideoEncoder] Flush: returned %zu packets\n", packets.size());
    return packets;
}

std::string VideoEncoder::GetCodecName() const {
    if (!m_codec) {
        return "unknown";
    }
    return m_codec->name;
}

void VideoEncoder::GetDimensions(uint32_t* width, uint32_t* height) const {
    if (width) *width = m_width;
    if (height) *height = m_height;
}

void VideoEncoder::Cleanup() {
    if (m_packet) {
        av_packet_free(&m_packet);
        m_packet = nullptr;
    }
    if (m_frame) {
        av_frame_free(&m_frame);
        m_frame = nullptr;
    }
    if (m_codecContext) {
        avcodec_free_context(&m_codecContext);
        m_codecContext = nullptr;
    }
    m_codec = nullptr;
    m_initialized = false;
}


#include "video_encoder.h"

extern "C" {
#include <libswscale/swscale.h>
#include <libavutil/imgutils.h>
}

#include <windows.h>
#include <comdef.h>
#include <cstring>
#include <cstdio>

#include "ionia_logging.h"

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

bool VideoEncoder::Initialize(uint32_t width, uint32_t height, uint32_t fps, uint32_t bitrate, bool useNvenc, bool comInSTAMode) {
    if (m_initialized) {
        return false;
    }

    m_width = width;
    m_height = height;
    m_fps = fps;
    m_bitrate = bitrate;
    m_useNvenc = useNvenc;

    // Initialize codec (pass COM mode information)
    if (!InitializeCodec(useNvenc, comInSTAMode)) {
        Ionia::LogErrorf("[VideoEncoder] Failed to initialize codec\n");
        return false;
    }

    // Allocate frame
    if (!AllocateFrame()) {
        Ionia::LogErrorf("[VideoEncoder] Failed to allocate frame\n");
        Cleanup();
        return false;
    }

    m_initialized = true;
    Ionia::LogInfof("[VideoEncoder] Initialized: %ux%u @ %u fps, %u bps, codec=%s\n",
                    m_width, m_height, m_fps, m_bitrate, GetCodecName().c_str());
    return true;
}

// Helper function to check if COM is in STA mode
// Returns true if COM is in STA mode (or can't be changed to MTA), false otherwise
// This function checks if we can initialize COM in MTA mode without getting RPC_E_CHANGED_MODE
static bool IsCOMInSTAMode() {
    // Try to initialize COM in MTA mode
    // If COM is already initialized in STA mode, this will return RPC_E_CHANGED_MODE
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    
    if (hr == RPC_E_CHANGED_MODE) {
        // COM is already initialized in STA mode - we can't change it
        Ionia::LogDebugf("[VideoEncoder] COM mode check: STA mode detected (RPC_E_CHANGED_MODE)\n");
        return true;
    }
    
    // If we successfully initialized COM (S_OK), uninitialize it
    // If COM was already initialized in MTA mode (S_FALSE), we don't need to uninitialize
    if (hr == S_OK) {
        CoUninitialize();
        Ionia::LogDebugf("[VideoEncoder] COM mode check: MTA mode (initialized successfully)\n");
    } else if (hr == S_FALSE) {
        Ionia::LogDebugf("[VideoEncoder] COM mode check: MTA mode (already initialized)\n");
    }
    
    // COM is in MTA mode (or can be initialized in MTA mode)
    return false;
}

bool VideoEncoder::InitializeCodec(bool useNvenc, bool comInSTAMode) {
    // Use the provided COM mode information (checked before AudioCapture could change it)
    if (comInSTAMode) {
        Ionia::LogInfof("[VideoEncoder] COM is in STA mode (passed from VideoAudioRecorder) - will avoid h264_mf codec\n");
    } else {
        // Double-check COM mode in case it wasn't passed correctly
        Ionia::LogDebugf("[VideoEncoder] Checking COM mode (fallback check)...\n");
        bool detectedSTAMode = IsCOMInSTAMode();
        if (detectedSTAMode) {
            Ionia::LogInfof("[VideoEncoder] WARNING: COM detected as STA mode (but was passed as MTA) - using STA mode\n");
            comInSTAMode = true;
        } else {
            Ionia::LogDebugf("[VideoEncoder] COM is in MTA mode - h264_mf can be used\n");
        }
    }
    
    // Try NVENC first if requested
    // NVENC = NVIDIA hardware encoder (requires NVIDIA GPU with NVENC support)
    if (useNvenc) {
        m_codec = avcodec_find_encoder_by_name("h264_nvenc");
        if (m_codec) {
            Ionia::LogInfof("[VideoEncoder] Using NVENC encoder (NVIDIA hardware acceleration)\n");
        } else {
            Ionia::LogInfof("[VideoEncoder] NVENC not available (no NVIDIA GPU or drivers), falling back to x264\n");
            useNvenc = false;
        }
    }

    // Fallback to libx264 (explicitly request libx264 to avoid h264_mf COM threading issues)
    if (!m_codec) {
        // Try multiple x264 codec names (different FFmpeg builds use different names)
        const char* x264_names[] = {
            "libx264",      // Standard name
            "x264",         // Alternative name
            "libx264rgb",   // RGB variant
            nullptr
        };
        
        for (int i = 0; x264_names[i] != nullptr; i++) {
            m_codec = avcodec_find_encoder_by_name(x264_names[i]);
            if (m_codec) {
                Ionia::LogInfof("[VideoEncoder] Using %s encoder\n", x264_names[i]);
                break;
            }
        }
        
        // If x264 not found, try generic H.264 but check for h264_mf
        if (!m_codec) {
            Ionia::LogInfof("[VideoEncoder] x264 encoders not found, trying generic H.264...\n");
            m_codec = avcodec_find_encoder(AV_CODEC_ID_H264);
            if (!m_codec) {
                Ionia::LogErrorf("[VideoEncoder] H.264 encoder not found\n");
                return false;
            }
            
            // Check if we got h264_mf (which will fail in Electron STA mode)
            if (m_codec && strstr(m_codec->name, "mf") != nullptr) {
                if (comInSTAMode) {
                    // COM is in STA mode and we got h264_mf - this will fail, so reject it
                    Ionia::LogErrorf("[VideoEncoder] ERROR: Found h264_mf but COM is in STA mode!\n");
                    Ionia::LogErrorf("[VideoEncoder] h264_mf requires MTA mode and cannot be used in Electron.\n");
                    Ionia::LogErrorf("[VideoEncoder] SOLUTION: Install FFmpeg with libx264 support\n");
                    Ionia::LogErrorf("[VideoEncoder] Option 1 - Using vcpkg (recommended):\n");
                    Ionia::LogErrorf("[VideoEncoder]   cd C:\\vcpkg\n");
                    Ionia::LogErrorf("[VideoEncoder]   .\\vcpkg install ffmpeg[nonfree]:x64-windows\n");
                    Ionia::LogErrorf("[VideoEncoder]   (libx264 is included in nonfree variant)\n");
                    Ionia::LogErrorf("[VideoEncoder] Option 2 - Download pre-built FFmpeg:\n");
                    Ionia::LogErrorf("[VideoEncoder]   Download from https://www.gyan.dev/ffmpeg/builds/\n");
                    Ionia::LogErrorf("[VideoEncoder]   Make sure it includes libx264 (check with: ffmpeg -encoders | findstr x264)\n");
                    Ionia::LogErrorf("[VideoEncoder]   Copy the DLLs to native-audio/build/Release/\n");
                    Ionia::LogErrorf("[VideoEncoder] After installing, rebuild the native module:\n");
                    Ionia::LogErrorf("[VideoEncoder]   cd native-audio\n");
                    Ionia::LogErrorf("[VideoEncoder]   npm run build\n");
                    m_codec = nullptr;
                    return false;
                } else {
                    // COM is in MTA mode, h264_mf should work
                    Ionia::LogInfof("[VideoEncoder] Using h264_mf encoder (COM is in MTA mode)\n");
                }
            } else {
                Ionia::LogInfof("[VideoEncoder] Using generic H.264 encoder: %s\n", m_codec ? m_codec->name : "unknown");
            }
        }
    }

    // Allocate codec context
    m_codecContext = avcodec_alloc_context3(m_codec);
    if (!m_codecContext) {
        Ionia::LogErrorf("[VideoEncoder] Failed to allocate codec context\n");
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
        Ionia::LogErrorf("[VideoEncoder] Failed to open codec: %s\n", errbuf);
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
            Ionia::LogErrorf("[VideoEncoder] Failed to create swscale context\n");
            return;
        }
    }

    const uint8_t* srcData[4] = { rgbaData, nullptr, nullptr, nullptr };
    int srcLinesize[4] = { static_cast<int>(m_width * 4), 0, 0, 0 };

    sws_scale(swsContext, srcData, srcLinesize, 0, m_height,
              frame->data, frame->linesize);
}

std::vector<VideoEncoder::EncodedPacket> VideoEncoder::EncodeFrame(const uint8_t* frameData) {
    std::vector<VideoEncoder::EncodedPacket> packets;

    if (!m_initialized || !frameData) {
        return packets;
    }

    // Make frame writable
    int ret = av_frame_make_writable(m_frame);
    if (ret < 0) {
        Ionia::LogErrorf("[VideoEncoder] Failed to make frame writable\n");
        return packets;
    }

    // Convert RGBA to YUV420P
    ConvertRGBAtoYUV(frameData, m_frame);

    // Set frame PTS (encoder needs it for internal buffering, but we use frame counter)
    // The muxer will assign the real PTS based on frame index
    m_frame->pts = m_frameCount;
    m_frame->pict_type = AV_PICTURE_TYPE_NONE;  // Let encoder decide

    // Send frame to encoder
    ret = avcodec_send_frame(m_codecContext, m_frame);
    if (ret < 0) {
        char errbuf[256];
        av_strerror(ret, errbuf, sizeof(errbuf));
        Ionia::LogErrorf("[VideoEncoder] avcodec_send_frame failed: %s\n", errbuf);
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
            Ionia::LogErrorf("[VideoEncoder] avcodec_receive_packet failed: %s\n", errbuf);
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
        Ionia::LogErrorf("[VideoEncoder] Flush: avcodec_send_frame failed: %s\n", errbuf);
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
            Ionia::LogErrorf("[VideoEncoder] Flush: avcodec_receive_packet failed: %s\n", errbuf);
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

    Ionia::LogDebugf("[VideoEncoder] Flush: returned %zu packets\n", packets.size());
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


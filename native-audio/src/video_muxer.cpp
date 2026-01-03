#include "video_muxer.h"
#include "video_encoder.h"
#include "encoded_audio_packet.h"
#include "ionia_logging.h"
#include <libavutil/mem.h>
#include <cstring>
#include <cstdio>

VideoMuxer::VideoMuxer()
    : m_initialized(false)
    , m_formatContext(nullptr)
    , m_videoStream(nullptr)
    , m_audioStream(nullptr)
    , m_audioCodecContext(nullptr)
    , m_lastVideoPTS(0)
    , m_lastVideoDTS(-1)  // Start at -1 so first DTS can be 0
    , m_lastAudioPTS(0)
    , m_videoFrameCount(0)
    , m_audioSampleCount(0)
    , m_videoPacketCount(0)
    , m_audioPacketCount(0)
    , m_totalBytes(0)
{
}

VideoMuxer::~VideoMuxer() {
    if (m_initialized) {
        Finalize();
    }
}

bool VideoMuxer::Initialize(const std::string& outputPath,
                             VideoEncoder* videoEncoder,
                             uint32_t audioSampleRate,
                             uint16_t audioChannels,
                             uint32_t audioBitrate) {
    if (m_initialized || !videoEncoder || !videoEncoder->IsInitialized()) {
        return false;
    }

    m_outputPath = outputPath;

    // Allocate output format context
    int ret = avformat_alloc_output_context2(&m_formatContext, nullptr, nullptr, outputPath.c_str());
    if (ret < 0 || !m_formatContext) {
        Ionia::LogErrorf("[VideoMuxer] Failed to allocate output context\n");
        return false;
    }

    // Setup video stream
    if (!SetupVideoStream(videoEncoder)) {
        Ionia::LogErrorf("[VideoMuxer] Failed to setup video stream\n");
        avformat_free_context(m_formatContext);
        m_formatContext = nullptr;
        return false;
    }

    // Setup audio stream
    if (!SetupAudioStream(audioSampleRate, audioChannels, audioBitrate)) {
        Ionia::LogErrorf("[VideoMuxer] Failed to setup audio stream\n");
        avformat_free_context(m_formatContext);
        m_formatContext = nullptr;
        return false;
    }

    // Open output file
    if (!(m_formatContext->oformat->flags & AVFMT_NOFILE)) {
        ret = avio_open(&m_formatContext->pb, outputPath.c_str(), AVIO_FLAG_WRITE);
        if (ret < 0) {
            char errbuf[256];
            av_strerror(ret, errbuf, sizeof(errbuf));
            Ionia::LogErrorf("[VideoMuxer] Failed to open output file: %s\n", errbuf);
            avformat_free_context(m_formatContext);
            m_formatContext = nullptr;
            return false;
        }
    }

    // Set options to prevent FFmpeg from modifying time_base
    // This helps ensure timestamps are correctly interpreted
    AVDictionary* opts = nullptr;
    av_dict_set(&opts, "movflags", "faststart", 0);  // Enable faststart for MP4
    // Note: We can't prevent time_base modification, but we'll handle it in Finalize()
    
    // Write header
    ret = avformat_write_header(m_formatContext, &opts);
    if (opts) {
        av_dict_free(&opts);
    }
    if (ret < 0) {
        char errbuf[256];
        av_strerror(ret, errbuf, sizeof(errbuf));
        Ionia::LogErrorf("[VideoMuxer] Failed to write header: %s\n", errbuf);
        if (!(m_formatContext->oformat->flags & AVFMT_NOFILE)) {
            avio_closep(&m_formatContext->pb);
        }
        avformat_free_context(m_formatContext);
        m_formatContext = nullptr;
        return false;
    }
    

    // Reset tracking variables for new recording
    m_lastVideoPTS = 0;
    m_lastVideoDTS = -1;  // Start at -1 so first DTS can be 0
    m_lastAudioPTS = 0;
    m_videoFrameCount = 0;
    m_audioSampleCount = 0;
    m_videoPacketCount = 0;
    m_audioPacketCount = 0;
    m_totalBytes = 0;

    m_initialized = true;
    Ionia::LogInfof("[VideoMuxer] Initialized: %s\n", outputPath.c_str());
    return true;
}

bool VideoMuxer::SetupVideoStream(VideoEncoder* videoEncoder) {
    // Find H.264 encoder (for stream parameters)
    const AVCodec* codec = avcodec_find_encoder(AV_CODEC_ID_H264);
    if (!codec) {
        return false;
    }

    // Create video stream
    m_videoStream = avformat_new_stream(m_formatContext, codec);
    if (!m_videoStream) {
        return false;
    }

    // Create codec context for parameters
    AVCodecContext* codecContext = avcodec_alloc_context3(codec);
    if (!codecContext) {
        return false;
    }

    uint32_t width, height;
    videoEncoder->GetDimensions(&width, &height);
    uint32_t fps = videoEncoder->GetFPS();

    codecContext->width = width;
    codecContext->height = height;
    codecContext->time_base = { 1, static_cast<int>(fps) };
    codecContext->framerate = { static_cast<int>(fps), 1 };
    codecContext->pix_fmt = AV_PIX_FMT_YUV420P;
    codecContext->codec_id = AV_CODEC_ID_H264;
    codecContext->codec_type = AVMEDIA_TYPE_VIDEO;

    // Copy codec parameters to stream
    int ret = avcodec_parameters_from_context(m_videoStream->codecpar, codecContext);
    if (ret < 0) {
        avcodec_free_context(&codecContext);
        return false;
    }

    // Set stream time base
    m_videoStream->time_base = codecContext->time_base;
    
    // Store original time_base (FFmpeg may modify it after writing packets)
    m_originalVideoTimeBase = codecContext->time_base;
    
    // Set frame rate on stream (helps with duration calculation)
    m_videoStream->avg_frame_rate = codecContext->framerate;
    m_videoStream->r_frame_rate = codecContext->framerate;

    // Free codec context (we don't need it for encoding, just for parameters)
    avcodec_free_context(&codecContext);

        Ionia::LogDebugf("[VideoMuxer] Video stream setup: %ux%u @ %u fps, time_base=%d/%d\n",
            width, height, fps, m_videoStream->time_base.num, m_videoStream->time_base.den);

    return true;
}

bool VideoMuxer::SetupAudioStream(uint32_t audioSampleRate, uint16_t audioChannels, uint32_t audioBitrate) {
    // Find AAC encoder (for stream parameters)
    const AVCodec* codec = avcodec_find_encoder(AV_CODEC_ID_AAC);
    if (!codec) {
        return false;
    }

    // Create audio stream
    m_audioStream = avformat_new_stream(m_formatContext, codec);
    if (!m_audioStream) {
        return false;
    }

    // Create codec context for parameters
    AVCodecContext* codecContext = avcodec_alloc_context3(codec);
    if (!codecContext) {
        return false;
    }

    // Configure codec context
    codecContext->bit_rate = audioBitrate;
    codecContext->sample_rate = audioSampleRate;
    codecContext->ch_layout.nb_channels = static_cast<int>(audioChannels);
    av_channel_layout_default(&codecContext->ch_layout, static_cast<int>(audioChannels));
    codecContext->sample_fmt = AV_SAMPLE_FMT_FLTP;
    codecContext->time_base = { 1, static_cast<int>(audioSampleRate) };

    // Copy codec parameters to stream
    int ret = avcodec_parameters_from_context(m_audioStream->codecpar, codecContext);
    if (ret < 0) {
        avcodec_free_context(&codecContext);
        return false;
    }

    // Set stream time base
    m_audioStream->time_base = codecContext->time_base;

    // Store codec context for rescaling timestamps
    m_audioCodecContext = codecContext;

    // Free codec context (we don't need it for encoding, just for parameters)
    // Actually, we need it for rescaling, so keep it

    return true;
}


bool VideoMuxer::WriteVideoPacket(const void* packetPtr, int64_t frameIndex) {
    if (!m_initialized || !packetPtr) {
        return false;
    }

    // Cast to VideoEncoder::EncodedPacket
    const VideoEncoder::EncodedPacket* packet = static_cast<const VideoEncoder::EncodedPacket*>(packetPtr);
    
    if (packet->data.empty()) {
        return false;
    }

    // Validate frame index
    if (frameIndex < 0) {
        Ionia::LogErrorf("[VideoMuxer] ERROR: Invalid frame index %lld\n", frameIndex);
        return false;
    }

    // Create FFmpeg AVPacket
    AVPacket* avPacket = av_packet_alloc();
    if (!avPacket) {
        return false;
    }

    // Allocate and copy packet data
    int ret = av_grow_packet(avPacket, packet->data.size());
    if (ret < 0) {
        av_packet_free(&avPacket);
        return false;
    }

    std::memcpy(avPacket->data, packet->data.data(), packet->data.size());
    avPacket->size = packet->data.size();

    // OBS-STYLE: Muxer is the ONLY source of truth for timestamps
    // Frame-based timestamps: PTS = DTS = frame_index (in time_base {1, fps})
    // No synchronization needed - av_interleaved_write_frame handles it
    avPacket->pts = frameIndex;
    avPacket->dts = frameIndex;  // DTS = PTS (no B-frames)
    avPacket->duration = 1;  // 1 frame duration
    
    // CRITICAL: Verify timestamps are set correctly before writing
    if (avPacket->pts == AV_NOPTS_VALUE || avPacket->dts == AV_NOPTS_VALUE || avPacket->pts < 0 || avPacket->dts < 0) {
        Ionia::LogErrorf("[VideoMuxer] FATAL: Invalid timestamps after setting! frameIndex=%lld avPacket->pts=%lld avPacket->dts=%lld\n",
            frameIndex, avPacket->pts, avPacket->dts);
        av_packet_free(&avPacket);
        return false;
    }
    
    avPacket->stream_index = m_videoStream->index;
    
    if (packet->isKeyframe) {
        avPacket->flags |= AV_PKT_FLAG_KEY;
    }

    // CRITICAL: Timestamps are already in original time_base (frameIndex = 0, 1, 2, ...)
    // We need to rescale them to the stream's time_base
    // However, FFmpeg may modify the stream time_base after writing, so we'll force it back in Finalize()
    av_packet_rescale_ts(avPacket, m_originalVideoTimeBase, m_videoStream->time_base);
    
    // Verify timestamps are still valid after rescale
    if (avPacket->pts == AV_NOPTS_VALUE || avPacket->dts == AV_NOPTS_VALUE || avPacket->pts < 0 || avPacket->dts < 0) {
        Ionia::LogErrorf("[VideoMuxer] FATAL: Timestamps became invalid after rescale! frameIndex=%lld avPacket->pts=%lld avPacket->dts=%lld\n",
            frameIndex, avPacket->pts, avPacket->dts);
        av_packet_free(&avPacket);
        return false;
    }
    
    // Write packet using av_interleaved_write_frame (ALWAYS, even without audio)
    // av_interleaved_write_frame accepts non-decreasing DTS (equal DTS is valid)
    // It builds proper MP4 structure: duration, index, seeking
    ret = av_interleaved_write_frame(m_formatContext, avPacket);
    
    av_packet_free(&avPacket);

    if (ret < 0) {
        char errbuf[256];
        av_strerror(ret, errbuf, sizeof(errbuf));
        Ionia::LogErrorf("[VideoMuxer] WriteVideoPacket failed: %s\n", errbuf);
        return false;
    }

    m_videoPacketCount++;
    m_totalBytes += packet->data.size();
    
    // Update last PTS and DTS (for duration calculation)
    // Track maximum PTS/DTS seen (using frame-based timestamps)
    // Use >= instead of > to ensure we update even if same frame index is used multiple times
    if (frameIndex >= m_lastVideoPTS) {
        m_lastVideoPTS = frameIndex;
    }
    
    // Track frame count using ORIGINAL frame index
    // This ensures duration calculation is correct
    if (frameIndex >= 0) {
        // frameIndex is 0-indexed, so total frames = frameIndex + 1
        if (frameIndex + 1 > m_videoFrameCount) {
            m_videoFrameCount = frameIndex + 1;
        }
    }
    
    if (frameIndex >= m_lastVideoDTS) {
        m_lastVideoDTS = frameIndex;
    }

    return true;
}

bool VideoMuxer::WriteAudioPacket(const EncodedAudioPacket& packet) {
    if (!m_initialized || !packet.isValid()) {
        return false;
    }

    // Create FFmpeg AVPacket
    AVPacket* avPacket = av_packet_alloc();
    if (!avPacket) {
        return false;
    }

    // Allocate and copy packet data
    int ret = av_grow_packet(avPacket, packet.data.size());
    if (ret < 0) {
        av_packet_free(&avPacket);
        return false;
    }

    std::memcpy(avPacket->data, packet.data.data(), packet.data.size());
    avPacket->size = packet.data.size();

    // OBS-STYLE: Muxer is the ONLY source of truth for timestamps
    // Audio timestamps: PTS = DTS = sample_count (in time_base {1, sample_rate})
    // Calculate duration based on AAC frame size (typically 1024 samples at 48kHz)
    // For AAC, each packet typically contains 1024 samples
    static const int64_t aacFrameSize = 1024;  // Typical AAC frame size
    
    avPacket->pts = m_audioSampleCount;
    avPacket->dts = m_audioSampleCount;  // DTS = PTS (no B-frames in audio)
    avPacket->duration = aacFrameSize;  // Duration in samples
    avPacket->stream_index = m_audioStream->index;

    // Rescale timestamps to stream time base
    // Audio time_base is {1, sample_rate}, so no rescale needed if stream time_base matches
    // But we rescale to be safe
    av_packet_rescale_ts(avPacket, m_audioCodecContext->time_base, m_audioStream->time_base);

    // Write packet using av_interleaved_write_frame (handles A/V sync automatically)
    ret = av_interleaved_write_frame(m_formatContext, avPacket);
    
    av_packet_free(&avPacket);

    if (ret < 0) {
        char errbuf[256];
        av_strerror(ret, errbuf, sizeof(errbuf));
        Ionia::LogErrorf("[VideoMuxer] WriteAudioPacket failed: %s\n", errbuf);
        return false;
    }

    m_audioPacketCount++;
    m_totalBytes += packet.data.size();
    m_audioSampleCount += aacFrameSize;  // Update sample count for next packet
    m_lastAudioPTS = m_audioSampleCount;  // Track for duration calculation

    return true;
}

bool VideoMuxer::Finalize() {
    if (!m_initialized) {
        return false;
    }

        Ionia::LogInfof("[VideoMuxer] Finalize: video=%llu packets, audio=%llu packets, bytes=%llu\n",
            m_videoPacketCount, m_audioPacketCount, m_totalBytes);
        Ionia::LogDebugf("[VideoMuxer] Last video PTS: %lld, Last video DTS: %lld, Frame count: %lld\n",
            m_lastVideoPTS, m_lastVideoDTS, m_videoFrameCount);

    // CRITICAL: FFmpeg may have modified the stream's time_base after writing packets
    // We need to recalculate duration in the CURRENT time_base (after modification)
    // FFmpeg calculates duration based on packet timestamps in the current time_base
    if (m_videoStream && m_lastVideoPTS >= 0) {
        // Last PTS represents the last frame's presentation time (0-indexed in original time_base)
        // For example: if last PTS is 299, that's frame 300 (frames 0-299)
        // Duration = (last PTS + 1) frames = total number of frames
        // At 30 fps: 300 frames = 10 seconds
        int64_t durationInOriginalTimeBase = m_lastVideoPTS + 1;  // +1 because PTS is 0-indexed
        
        AVRational originalTimeBase = m_originalVideoTimeBase;
        AVRational currentStreamTimeBase = m_videoStream->time_base;
        
        // Calculate duration in seconds (for display)
        double durationSeconds = (double)durationInOriginalTimeBase * av_q2d(originalTimeBase);
        
        // CRITICAL: Convert the last PTS from original time_base to CURRENT stream time_base
        // This is what FFmpeg will use to calculate duration from packet timestamps
        int64_t lastPTSInCurrentTimeBase = av_rescale_q(m_lastVideoPTS, originalTimeBase, currentStreamTimeBase);
        
        // Calculate duration in current time_base: last PTS + duration of last frame
        // The last frame has duration = 1 in original time_base, convert it to current time_base
        int64_t lastFrameDurationInCurrentTimeBase = av_rescale_q(1, originalTimeBase, currentStreamTimeBase);
        int64_t durationInCurrentTimeBase = lastPTSInCurrentTimeBase + lastFrameDurationInCurrentTimeBase;
        
        // Set stream duration in CURRENT time_base (this is what FFmpeg will use)
        m_videoStream->duration = durationInCurrentTimeBase;
        
        // Also set nb_frames to help FFmpeg calculate duration correctly
        // nb_frames is the number of frames (not in time_base units)
        m_videoStream->nb_frames = durationInOriginalTimeBase;
        
        // Force the time_base to remain constant (prevent further modification)
        // This ensures timestamps are correctly interpreted
        m_videoStream->time_base = originalTimeBase;
        
        // Also set the format context duration
        if (m_formatContext) {
            // Convert to format context time base (AV_TIME_BASE = 1,000,000)
            int64_t formatDuration = av_rescale_q(durationInOriginalTimeBase, originalTimeBase, {1, AV_TIME_BASE});
            m_formatContext->duration = formatDuration;
        }
        
        Ionia::LogDebugf("[VideoMuxer] Video stream duration: %lld frames (%.6f seconds)\n",
            durationInOriginalTimeBase, durationSeconds);
        
        // Debug: verify calculation
        if (durationSeconds < 1.0) {
            Ionia::LogDebugf("[VideoMuxer] WARNING: Duration is very short (%.6f seconds). Check if all frames were written.\n",
                    durationSeconds);
        }
    } else {
        Ionia::LogDebugf("[VideoMuxer] WARNING: Cannot calculate duration - m_lastVideoPTS=%lld\n", m_lastVideoPTS);
    }

    // Write trailer (this will finalize the file and write duration metadata)
    int ret = av_write_trailer(m_formatContext);
    if (ret < 0) {
        char errbuf[256];
        av_strerror(ret, errbuf, sizeof(errbuf));
        Ionia::LogErrorf("[VideoMuxer] Failed to write trailer: %s\n", errbuf);
    }

    // Close output file
    if (!(m_formatContext->oformat->flags & AVFMT_NOFILE)) {
        avio_closep(&m_formatContext->pb);
    }

    // Free resources
    if (m_audioCodecContext) {
        avcodec_free_context(&m_audioCodecContext);
        m_audioCodecContext = nullptr;
    }
    
    if (m_formatContext) {
        avformat_free_context(m_formatContext);
        m_formatContext = nullptr;
    }

    m_videoStream = nullptr;
    m_audioStream = nullptr;
    m_initialized = false;

    return true;
}


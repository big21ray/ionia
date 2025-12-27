#include "audio_encoder.h"
#include "encoded_audio_packet.h"
#include <algorithm>
#include <cmath>
#include <cstring>

AudioEncoder::AudioEncoder()
    : m_initialized(false)
    , m_sampleRate(48000)
    , m_channels(2)
    , m_bitrate(192000)  // 192 kbps default
    , m_codecContext(nullptr)
    , m_codec(nullptr)
    , m_frame(nullptr)
    , m_packetCount(0)
    , m_totalBytes(0)
{
}

AudioEncoder::~AudioEncoder() {
    if (m_frame) {
        av_frame_free(&m_frame);
        m_frame = nullptr;
    }

    if (m_codecContext) {
        avcodec_free_context(&m_codecContext);
        m_codecContext = nullptr;
    }

    m_codec = nullptr;
}

bool AudioEncoder::Initialize(UINT32 sampleRate, UINT16 channels, UINT32 bitrate) {
    if (m_initialized) {
        return false;  // Already initialized
    }

    if (sampleRate != 48000) {
        return false;  // Only 48kHz supported (matches audio engine)
    }

    if (channels != 2) {
        return false;  // Only stereo supported (matches audio engine)
    }

    m_sampleRate = sampleRate;
    m_channels = channels;
    m_bitrate = bitrate;

    // Find AAC encoder
    m_codec = avcodec_find_encoder(AV_CODEC_ID_AAC);
    if (!m_codec) {
        return false;
    }

    // Allocate codec context
    m_codecContext = avcodec_alloc_context3(m_codec);
    if (!m_codecContext) {
        return false;
    }

    // Configure codec context
    m_codecContext->bit_rate = m_bitrate;
    m_codecContext->sample_rate = m_sampleRate;
    m_codecContext->ch_layout.nb_channels = static_cast<int>(m_channels);
    av_channel_layout_default(&m_codecContext->ch_layout, m_channels);
    m_codecContext->sample_fmt = AV_SAMPLE_FMT_FLTP;  // AAC requires float planar
    m_codecContext->time_base = { 1, static_cast<int>(m_sampleRate) };  // Time base: 1/48000 (frames)
    m_codecContext->strict_std_compliance = FF_COMPLIANCE_EXPERIMENTAL;

    // Open codec
    int ret = avcodec_open2(m_codecContext, m_codec, nullptr);
    if (ret < 0) {
        avcodec_free_context(&m_codecContext);
        m_codecContext = nullptr;
        return false;
    }

    // Allocate frame
    m_frame = av_frame_alloc();
    if (!m_frame) {
        avcodec_free_context(&m_codecContext);
        m_codecContext = nullptr;
        return false;
    }

    m_frame->nb_samples = m_codecContext->frame_size;  // Frame size from codec
    m_frame->format = m_codecContext->sample_fmt;
    av_channel_layout_copy(&m_frame->ch_layout, &m_codecContext->ch_layout);
    m_frame->sample_rate = m_codecContext->sample_rate;

    ret = av_frame_get_buffer(m_frame, 0);
    if (ret < 0) {
        av_frame_free(&m_frame);
        avcodec_free_context(&m_codecContext);
        m_codecContext = nullptr;
        return false;
    }

    m_packetCount = 0;
    m_totalBytes = 0;
    m_accumulatedFrames.clear();
    m_initialized = true;

    return true;
}

void AudioEncoder::ConvertFloat32ToInt16(const float* floatData, int16_t* int16Data, UINT32 numSamples) {
    for (UINT32 i = 0; i < numSamples; i++) {
        float sample = floatData[i];
        // Clamp to [-1.0, 1.0] and convert to int16
        if (sample > 1.0f) sample = 1.0f;
        if (sample < -1.0f) sample = -1.0f;
        int16Data[i] = static_cast<int16_t>(sample * 32767.0f);
    }
}

std::vector<EncodedAudioPacket> AudioEncoder::EncodeFrames(const float* pcmData, UINT32 numFrames) {
    std::vector<EncodedAudioPacket> packets;

    if (!m_initialized || !pcmData || numFrames == 0) {
        return packets;
    }

    // Accumulate frames instead of padding with silence
    // Add new frames to accumulation buffer
    const UINT32 numSamples = numFrames * m_channels;
    
    // Append new frames to accumulation buffer
    m_accumulatedFrames.insert(m_accumulatedFrames.end(), pcmData, pcmData + numSamples);

    // Convert interleaved float32 to planar float32 (AAC requirement)
    const UINT32 frameSize = m_codecContext->frame_size;

    // Process complete frames (frames that are multiples of frameSize)
    // Recalculate accumulatedFrames in each iteration since we modify m_accumulatedFrames
    while (static_cast<UINT32>(m_accumulatedFrames.size() / m_channels) >= frameSize) {
        UINT32 accumulatedFrames = static_cast<UINT32>(m_accumulatedFrames.size() / m_channels);
        // Make frame writable
        int ret = av_frame_make_writable(m_frame);
        if (ret < 0) {
            break;
        }

        // Convert interleaved float32 to planar float32
        float* leftChannel = (float*)m_frame->data[0];
        float* rightChannel = (float*)m_frame->data[1];

        // Extract frameSize frames from accumulation buffer
        for (UINT32 i = 0; i < frameSize; i++) {
            UINT32 srcIdx = i * m_channels;
            leftChannel[i] = m_accumulatedFrames[srcIdx];
            rightChannel[i] = m_accumulatedFrames[srcIdx + 1];
        }

        // Set frame PTS (encoder needs it for internal buffering, but we use frame counter)
        // The muxer will assign the real PTS based on sample count
        static int64_t internalFrameCounter = 0;
        m_frame->pts = internalFrameCounter++;

        // Send frame to encoder
        ret = avcodec_send_frame(m_codecContext, m_frame);
        if (ret < 0) {
            // Log error but continue (don't break - try to recover)
            break;
        }

        // Receive encoded packets
        AVPacket* avPacket = av_packet_alloc();
        while (avcodec_receive_packet(m_codecContext, avPacket) == 0) {
            // Create EncodedAudioPacket (BYTES + SAMPLE COUNT)
            // numSamples is CRITICAL for StreamMuxer to compute correct PTS
            // AAC encoder always outputs exactly frameSize samples per packet
            std::vector<uint8_t> packetData(avPacket->data, avPacket->data + avPacket->size);
            
            EncodedAudioPacket packet(packetData, static_cast<int64_t>(frameSize));
            packets.push_back(packet);

            m_packetCount++;
            m_totalBytes += avPacket->size;

            av_packet_unref(avPacket);
        }
        if (avPacket) {
            av_packet_free(&avPacket);
        }

        // Remove processed frames from accumulation buffer
        const UINT32 samplesToRemove = frameSize * m_channels;
        m_accumulatedFrames.erase(m_accumulatedFrames.begin(), m_accumulatedFrames.begin() + samplesToRemove);
    }

    return packets;
}

std::vector<EncodedAudioPacket> AudioEncoder::Flush() {
    std::vector<EncodedAudioPacket> packets;

    if (!m_initialized) {
        return packets;
    }

    // FIX #1: OBS-like behavior - Only encode if we have EXACTLY frameSize frames
    // Never pad with silence, even on flush
    // If we don't have enough frames, we simply don't encode them (they're lost)
    const UINT32 frameSize = m_codecContext->frame_size;
    const UINT32 accumulatedFrames = static_cast<UINT32>(m_accumulatedFrames.size() / m_channels);
    
    // Only encode if we have exactly frameSize frames (OBS rule)
    if (accumulatedFrames >= frameSize) {
        // Make frame writable
        int ret = av_frame_make_writable(m_frame);
        if (ret >= 0) {
            // Convert interleaved float32 to planar float32
            float* leftChannel = (float*)m_frame->data[0];
            float* rightChannel = (float*)m_frame->data[1];

            // Copy frameSize frames from accumulation buffer
            for (UINT32 i = 0; i < frameSize; i++) {
                UINT32 srcIdx = i * m_channels;
                leftChannel[i] = m_accumulatedFrames[srcIdx];
                rightChannel[i] = m_accumulatedFrames[srcIdx + 1];
            }

            // Set frame PTS (encoder needs it for internal buffering)
            // The muxer will assign the real PTS
            static int64_t internalFrameCounter = 0;
            m_frame->pts = internalFrameCounter++;

            // Send frame to encoder
            ret = avcodec_send_frame(m_codecContext, m_frame);
            if (ret >= 0) {
                // Receive encoded packets
                AVPacket* avPacket = av_packet_alloc();
                while (avcodec_receive_packet(m_codecContext, avPacket) == 0) {
                    std::vector<uint8_t> packetData(avPacket->data, avPacket->data + avPacket->size);
                    
                    // Create EncodedAudioPacket (BYTES ONLY, no timestamps)
                    EncodedAudioPacket packet(packetData);
                    packets.push_back(packet);

                    m_packetCount++;
                    m_totalBytes += avPacket->size;

                    av_packet_unref(avPacket);
                }
                if (avPacket) {
                    av_packet_free(&avPacket);
                }
            }
            
            // Remove processed frames from accumulation buffer
            const UINT32 samplesToRemove = frameSize * m_channels;
            m_accumulatedFrames.erase(m_accumulatedFrames.begin(), m_accumulatedFrames.begin() + samplesToRemove);
        }
    }
    
    // OBS-like: Clear any remaining incomplete frames (don't encode them, don't pad with silence)
    // These frames are simply lost (acceptable for real-time encoding)
    m_accumulatedFrames.clear();

    // Send NULL frame to flush encoder (get any remaining packets)
    int ret = avcodec_send_frame(m_codecContext, nullptr);
    if (ret < 0) {
        return packets;
    }

    // Receive remaining encoded packets
    AVPacket* avPacket = av_packet_alloc();
    while (avcodec_receive_packet(m_codecContext, avPacket) == 0) {
        std::vector<uint8_t> packetData(avPacket->data, avPacket->data + avPacket->size);
        
        // Create EncodedAudioPacket (BYTES ONLY, no timestamps)
        EncodedAudioPacket packet(packetData);
        packets.push_back(packet);

        m_packetCount++;
        m_totalBytes += avPacket->size;

        av_packet_unref(avPacket);
    }
    if (avPacket) {
        av_packet_free(&avPacket);
    }

    return packets;
}


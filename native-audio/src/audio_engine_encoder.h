#ifndef AUDIO_ENGINE_ENCODER_H
#define AUDIO_ENGINE_ENCODER_H

#include "audio_engine.h"
#include "audio_encoder.h"
#include "audio_muxer.h"
#include <string>
#include <memory>
#include <fstream>

// Audio Engine with Encoder and Muxer (OBS-like)
// Extends AudioEngine to add AAC encoding and MP4 muxing
class AudioEngineWithEncoder {
public:
    AudioEngineWithEncoder();
    ~AudioEngineWithEncoder();

    // Initialize with encoder and muxer
    // outputPath: path to output MP4 file (or .aac for raw AAC)
    // bitrate: AAC bitrate in bits per second (default: 192000 = 192kbps)
    // useRawAac: if true, write raw AAC packets to .aac file (no MP4 container)
    bool Initialize(const std::string& outputPath, UINT32 bitrate = 192000, bool useRawAac = false);

    // Start encoding and muxing
    bool Start();

    // Stop encoding and muxing
    void Stop();

    // Feed audio data (same as AudioEngine)
    void FeedAudioData(const float* data, UINT32 numFrames, const char* source);

    // Tick (same as AudioEngine, but also encodes and muxes)
    void Tick();

    // Get current PTS
    UINT64 GetCurrentPTSFrames() const;
    double GetCurrentPTSSeconds() const;

    // Get statistics
    size_t GetEncodedPackets() const;
    size_t GetEncodedBytes() const;
    size_t GetMuxedPackets() const;
    size_t GetMuxedBytes() const;

    // Check if running
    bool IsRunning() const;

private:
    std::unique_ptr<AudioEngine> m_engine;
    std::unique_ptr<AudioEncoder> m_encoder;
    std::unique_ptr<AudioMuxer> m_muxer;
    
    std::string m_outputPath;
    UINT32 m_bitrate;
    bool m_initialized;
    bool m_useRawAac;  // If true, write raw AAC packets instead of MP4
    std::ofstream m_aacFile;  // File stream for raw AAC output
    
    // Generate ADTS header for AAC packet (7 bytes)
    // ADTS (Audio Data Transport Stream) header is required for VLC/players to read raw AAC
    void WriteAdtsHeader(uint8_t* buffer, size_t aacFrameLength, UINT32 sampleRate, UINT16 channels);
};

#endif // AUDIO_ENGINE_ENCODER_H


#ifndef AV_PACKET_H
#define AV_PACKET_H

#include <vector>
#include <cstdint>

// AudioPacket structure (OBS-like)
// Represents an audio packet with timing information (PCM data, not encoded)
// The PTS is explicitly controlled from AudioEngine
// Note: Renamed from AVPacket to avoid conflict with FFmpeg's AVPacket
class AudioPacket {
public:
    AudioPacket();
    AudioPacket(const std::vector<uint8_t>& data, int64_t pts, int64_t dts, int64_t duration, int streamIndex);
    ~AudioPacket();

    // Copy constructor and assignment operator
    AudioPacket(const AudioPacket& other);
    AudioPacket& operator=(const AudioPacket& other);

    // Move constructor and assignment operator
    AudioPacket(AudioPacket&& other) noexcept;
    AudioPacket& operator=(AudioPacket&& other) noexcept;

    // Packet data (PCM audio: float32, 48kHz, stereo)
    std::vector<uint8_t> data;

    // Presentation Time Stamp (in time_base units, typically frames)
    // This is explicitly set from AudioEngine.GetCurrentPTSFrames()
    int64_t pts;

    // Decode Time Stamp (in time_base units)
    // For audio: DTS = PTS (no B-frames in audio)
    int64_t dts;

    // Duration (in time_base units, typically frames)
    int64_t duration;

    // Stream index
    int streamIndex;

    // Size of packet data
    size_t size() const { return data.size(); }

    // Check if packet is valid
    bool isValid() const { return !data.empty() && size() > 0 && pts >= 0; }

    // Get PTS in seconds (assuming time_base = 1/48000)
    double GetPTSSeconds() const {
        return static_cast<double>(pts) / 48000.0;
    }

    // Get DTS in seconds
    double GetDTSSeconds() const {
        return static_cast<double>(dts) / 48000.0;
    }

    // Get duration in seconds
    double GetDurationSeconds() const {
        return static_cast<double>(duration) / 48000.0;
    }
};

#endif // AV_PACKET_H

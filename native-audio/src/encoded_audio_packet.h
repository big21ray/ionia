#ifndef ENCODED_AUDIO_PACKET_H
#define ENCODED_AUDIO_PACKET_H

#include <vector>
#include <cstdint>

// Encoded Audio Packet (OBS-style: BYTES + SAMPLE COUNT for PTS)
// The muxer is the ONLY source of truth for timestamps
// PTS MUST be computed from sample index, never from wall-clock time
struct EncodedAudioPacket {
    std::vector<uint8_t> data;      // Encoded AAC data
    int64_t numSamples = 0;          // Number of audio samples in this packet (required for PTS calculation)
    
    EncodedAudioPacket() {}
    EncodedAudioPacket(const std::vector<uint8_t>& d, int64_t ns = 0) : data(d), numSamples(ns) {}
    
    bool isValid() const { return !data.empty(); }
    size_t size() const { return data.size(); }
};

#endif // ENCODED_AUDIO_PACKET_H





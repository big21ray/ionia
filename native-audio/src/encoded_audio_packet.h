#ifndef ENCODED_AUDIO_PACKET_H
#define ENCODED_AUDIO_PACKET_H

#include <vector>
#include <cstdint>

// Encoded Audio Packet (OBS-style: BYTES ONLY, no timestamps)
// The muxer is the ONLY source of truth for timestamps
struct EncodedAudioPacket {
    std::vector<uint8_t> data;  // Encoded AAC data
    
    EncodedAudioPacket() {}
    EncodedAudioPacket(const std::vector<uint8_t>& d) : data(d) {}
    
    bool isValid() const { return !data.empty(); }
    size_t size() const { return data.size(); }
};

#endif // ENCODED_AUDIO_PACKET_H





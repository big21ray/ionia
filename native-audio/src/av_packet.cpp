#include "av_packet.h"

AudioPacket::AudioPacket()
    : pts(0)
    , dts(0)
    , duration(0)
    , streamIndex(0)
{
}

AudioPacket::AudioPacket(const std::vector<uint8_t>& data, int64_t pts, int64_t dts, int64_t duration, int streamIndex)
    : data(data)
    , pts(pts)
    , dts(dts)
    , duration(duration)
    , streamIndex(streamIndex)
{
}

AudioPacket::~AudioPacket() {
}

AudioPacket::AudioPacket(const AudioPacket& other)
    : data(other.data)
    , pts(other.pts)
    , dts(other.dts)
    , duration(other.duration)
    , streamIndex(other.streamIndex)
{
}

AudioPacket& AudioPacket::operator=(const AudioPacket& other) {
    if (this != &other) {
        data = other.data;
        pts = other.pts;
        dts = other.dts;
        duration = other.duration;
        streamIndex = other.streamIndex;
    }
    return *this;
}

AudioPacket::AudioPacket(AudioPacket&& other) noexcept
    : data(std::move(other.data))
    , pts(other.pts)
    , dts(other.dts)
    , duration(other.duration)
    , streamIndex(other.streamIndex)
{
}

AudioPacket& AudioPacket::operator=(AudioPacket&& other) noexcept {
    if (this != &other) {
        data = std::move(other.data);
        pts = other.pts;
        dts = other.dts;
        duration = other.duration;
        streamIndex = other.streamIndex;
    }
    return *this;
}

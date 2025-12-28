#ifndef STREAM_BUFFER_H
#define STREAM_BUFFER_H

#include <deque>
#include <mutex>
#include <cstdint>
#include <algorithm>

extern "C" {
#include <libavcodec/avcodec.h>
}

// Packet wrapper with DTS for latency calculation
struct QueuedPacket {
    AVPacket* pkt;
    int64_t dts;
};

// Stream buffer for RTMP streaming with backpressure detection
// Queues packets to handle network latency and buffer overflow
class StreamBuffer {
public:
    // Initialize buffer
    // maxSize: max packets in queue (e.g., 100)
    // maxLatencyMs: max time since first packet (e.g., 2000ms)
    StreamBuffer(size_t maxSize = 100, int64_t maxLatencyMs = 2000);
    ~StreamBuffer();

    // Check if buffer can accept another packet
    // Returns false if buffer full or latency too high
    bool CanAcceptPacket();

    // Add packet to queue
    // Returns false if packet was dropped due to backpressure
    bool AddPacket(AVPacket* packet);

    // Get next packet from queue (sorted by DTS)
    // Returns nullptr if queue is empty
    AVPacket* GetNextPacket();

    // Check if backpressure is detected
    // True if buffer full OR DTS latency too high
    bool IsBackpressure() const;

    // Get current queue size
    size_t GetSize() const;

    // Get statistics
    uint64_t GetPacketsDropped() const { return m_packetsDropped; }
    uint64_t GetPacketsAdded() const { return m_packetsAdded; }

    // Clear all packets from queue
    void Clear();

private:
    // DTS-based latency check
    int64_t GetDtsLatencyMs() const;

    std::deque<QueuedPacket> m_packets;
    mutable std::mutex m_mutex;
    size_t m_maxSize;
    int64_t m_maxLatencyMs;
    
    uint64_t m_packetsDropped;
    uint64_t m_packetsAdded;
    int64_t m_videoStreamIndex = -1;
};

#endif // STREAM_BUFFER_H


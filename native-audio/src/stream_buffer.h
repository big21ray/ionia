#ifndef STREAM_BUFFER_H
#define STREAM_BUFFER_H

#include <queue>
#include <mutex>
#include <chrono>
#include <cstdint>

extern "C" {
#include <libavcodec/avcodec.h>
}

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

    // Get next packet from queue (FIFO)
    // Returns nullptr if queue is empty
    AVPacket* GetNextPacket();

    // Get current latency in milliseconds (time since first packet)
    int64_t GetCurrentLatencyMs() const;

    // Check if backpressure is detected
    // True if buffer full OR latency too high
    bool IsBackpressure() const;

    // Get current queue size
    size_t GetSize() const;

    // Get statistics
    uint64_t GetPacketsDropped() const { return m_packetsDropped; }
    uint64_t GetPacketsAdded() const { return m_packetsAdded; }

    // Clear all packets from queue
    void Clear();

private:
    std::queue<AVPacket*> m_packets;
    mutable std::mutex m_mutex;
    size_t m_maxSize;
    int64_t m_maxLatencyMs;
    std::chrono::high_resolution_clock::time_point m_firstPacketTime;
    
    uint64_t m_packetsDropped;
    uint64_t m_packetsAdded;
};

#endif // STREAM_BUFFER_H


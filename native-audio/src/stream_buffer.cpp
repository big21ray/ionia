#include "stream_buffer.h"
#include <libavutil/mem.h>
#include <algorithm>

StreamBuffer::StreamBuffer(size_t maxSize, int64_t maxLatencyMs)
    : m_maxSize(maxSize)
    , m_maxLatencyMs(maxLatencyMs)
    , m_packetsDropped(0)
    , m_packetsAdded(0)
{
}

StreamBuffer::~StreamBuffer() {
    Clear();
}

bool StreamBuffer::CanAcceptPacket() {
    std::lock_guard<std::mutex> lock(m_mutex);
    
    // Check if buffer is full
    if (m_packets.size() >= m_maxSize) {
        return false;
    }
    
    // Check latency if we have packets
    if (!m_packets.empty()) {
        int64_t latency = GetCurrentLatencyMs();
        if (latency > m_maxLatencyMs) {
            return false;
        }
    }
    
    return true;
}

bool StreamBuffer::AddPacket(AVPacket* packet) {
    if (!packet) {
        return false;
    }
    
    std::lock_guard<std::mutex> lock(m_mutex);
    
    // Check if we can accept the packet
    if (m_packets.size() >= m_maxSize) {
        // Buffer full - drop packet
        av_packet_free(&packet);
        m_packetsDropped++;
        return false;
    }
    
    // Check latency
    if (!m_packets.empty()) {
        int64_t latency = GetCurrentLatencyMs();
        if (latency > m_maxLatencyMs) {
            // Latency too high - drop packet
            av_packet_free(&packet);
            m_packetsDropped++;
            return false;
        }
    }
    
    // Add packet to queue
    if (m_packets.empty()) {
        // First packet - record time
        m_firstPacketTime = std::chrono::high_resolution_clock::now();
    }
    
    m_packets.push(packet);
    m_packetsAdded++;
    
    return true;
}

AVPacket* StreamBuffer::GetNextPacket() {
    std::lock_guard<std::mutex> lock(m_mutex);
    
    if (m_packets.empty()) {
        return nullptr;
    }
    
    AVPacket* packet = m_packets.front();
    m_packets.pop();
    
    // Update first packet time if queue is now empty
    if (m_packets.empty()) {
        m_firstPacketTime = std::chrono::high_resolution_clock::now();
    }
    
    return packet;
}

int64_t StreamBuffer::GetCurrentLatencyMs() const {
    std::lock_guard<std::mutex> lock(m_mutex);
    
    if (m_packets.empty()) {
        return 0;
    }
    
    auto now = std::chrono::high_resolution_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(now - m_firstPacketTime).count();
    
    return elapsed;
}

size_t StreamBuffer::GetSize() const {
    std::lock_guard<std::mutex> lock(m_mutex);
    return m_packets.size();
}

bool StreamBuffer::IsBackpressure() const {
    std::lock_guard<std::mutex> lock(m_mutex);
    
    // Check if buffer is full
    if (m_packets.size() >= m_maxSize) {
        return true;
    }
    
    // Check latency
    if (!m_packets.empty()) {
        int64_t latency = GetCurrentLatencyMs();
        if (latency > m_maxLatencyMs) {
            return true;
        }
    }
    
    return false;
}

void StreamBuffer::Clear() {
    std::lock_guard<std::mutex> lock(m_mutex);
    
    while (!m_packets.empty()) {
        AVPacket* packet = m_packets.front();
        m_packets.pop();
        av_packet_free(&packet);
    }
    
    m_packetsDropped = 0;
    m_packetsAdded = 0;
}




#include "stream_buffer.h"
#include <libavutil/mem.h>
#include <algorithm>

StreamBuffer::StreamBuffer(size_t maxSize, int64_t maxLatencyMs)
    : m_maxSize(maxSize)
    , m_maxLatencyMs(maxLatencyMs)
    , m_packetsDropped(0)
    , m_packetsAdded(0)
    , m_videoStreamIndex(-1)
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
    
    // Check DTS-based latency
    if (!m_packets.empty()) {
        int64_t latency = GetDtsLatencyMs();
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
        // Buffer full - apply smart drop policy
        // Try to drop a video P-frame instead of this packet
        for (auto it = m_packets.begin(); it != m_packets.end(); ++it) {
            // Drop video non-keyframe packets first
            if (it->pkt->stream_index == m_videoStreamIndex &&
                !(it->pkt->flags & AV_PKT_FLAG_KEY)) {
                av_packet_free(&it->pkt);
                m_packets.erase(it);
                m_packetsDropped++;
                break; // Dropped one, now try to add the new packet
            }
        }
        
        // If still full, refuse to add (don't drop audio or keyframes)
        if (m_packets.size() >= m_maxSize) {
            av_packet_free(&packet);
            m_packetsDropped++;
            return false;
        }
    }
    
    // Check DTS-based latency
    if (!m_packets.empty()) {
        int64_t latency = GetDtsLatencyMs();
        
        static int check_count = 0;
        if (check_count < 10 || check_count % 100 == 0) {
            fprintf(stderr, "[StreamBuffer] AddPacket: size=%zu, latency=%lld ms (max=%lld), front_dts=%lld, back_dts=%lld\n",
                    m_packets.size(), latency, m_maxLatencyMs, 
                    m_packets.front().dts, m_packets.back().dts);
            fflush(stderr);
        }
        check_count++;
        
        if (latency > m_maxLatencyMs) {
            fprintf(stderr, "[StreamBuffer] ⚠️ LATENCY TOO HIGH: %lld > %lld, trying to drop video P-frame\n",
                    latency, m_maxLatencyMs);
            fflush(stderr);
            
            // Latency too high - drop video P-frame instead if possible
            for (auto it = m_packets.begin(); it != m_packets.end(); ++it) {
                if (it->pkt->stream_index == m_videoStreamIndex &&
                    !(it->pkt->flags & AV_PKT_FLAG_KEY)) {
                    av_packet_free(&it->pkt);
                    m_packets.erase(it);
                    m_packetsDropped++;
                    break; // Dropped one, now try to add the new packet
                }
            }
            
            // If still over latency, refuse to add
            if (!m_packets.empty()) {
                latency = GetDtsLatencyMs();
                if (latency > m_maxLatencyMs) {
                    fprintf(stderr, "[StreamBuffer] ⚠️ STILL TOO LATE after drop, refusing packet\n");
                    fflush(stderr);
                    av_packet_free(&packet);
                    m_packetsDropped++;
                    return false;
                }
            }
        }
    }
    
    // Insert packet SORTED BY DTS (maintain monotonic order)
    auto it = std::upper_bound(
        m_packets.begin(),
        m_packets.end(),
        packet->dts,
        [](int64_t dts, const QueuedPacket& qp) {
            return dts < qp.dts;
        }
    );
    
    m_packets.insert(it, { packet, packet->dts });
    m_packetsAdded++;
    
    return true;
}

AVPacket* StreamBuffer::GetNextPacket() {
    std::lock_guard<std::mutex> lock(m_mutex);
    
    if (m_packets.empty()) {
        return nullptr;
    }
    
    // Get first packet (lowest DTS due to sorting)
    QueuedPacket qp = m_packets.front();
    m_packets.pop_front();
    
    // Log buffer state
    static int send_count = 0;
    if (send_count < 10 || send_count % 100 == 0) {
        fprintf(stderr, "[StreamBuffer] GetNextPacket: sent_dts=%lld, remaining=%zu\n",
                qp.dts, m_packets.size());
        fflush(stderr);
    }
    send_count++;
    
    return qp.pkt;
}

int64_t StreamBuffer::GetDtsLatencyMs() const {
    // DTS-based latency calculation (no wall-clock time)
    if (m_packets.empty()) {
        return 0;
    }
    
    int64_t earliest_dts = m_packets.front().dts;
    int64_t latest_dts = m_packets.back().dts;
    
    int64_t dts_span = latest_dts - earliest_dts;
    
    // Convert from time_base units to milliseconds
    // Assuming reasonable time_base (typically 1/1000 for audio or 1/fps for video)
    // For safety, assume this is already in reasonable units
    // Return as-is (caller should rescale if needed)
    return dts_span;
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
    
    // Check DTS-based latency
    if (!m_packets.empty()) {
        int64_t latency = GetDtsLatencyMs();
        if (latency > m_maxLatencyMs) {
            return true;
        }
    }
    
    return false;
}

void StreamBuffer::Clear() {
    std::lock_guard<std::mutex> lock(m_mutex);
    
    while (!m_packets.empty()) {
        AVPacket* packet = m_packets.front().pkt;
        m_packets.pop_front();
        av_packet_free(&packet);
    }
    
    m_packetsDropped = 0;
    m_packetsAdded = 0;
}

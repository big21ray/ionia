#pragma once

#include <cstdint>
#include <vector>
#include <memory>
#include <chrono>
#include <mutex>

class VideoEncoder;

/**
 * VideoEngine: CLOCK MASTER for video timing
 * 
 * Responsibilities:
 * - Maintains monotonic frame count (PTS)
 * - Handles Constant Frame Rate (CFR) pacing
 * - Duplicates last frame on lag (instead of slowing down capture)
 * - Calls encoder on demand
 * 
 * Design:
 * - Capture thread pushes frames to a ring buffer (best effort)
 * - VideoEngine Tick() checks if new frame is needed at current time
 * - If frame available in buffer → encode it
 * - If no frame but time says we need one → duplicate last frame
 * - Never waits, never blocks capture
 */
class VideoEngine {
public:
    VideoEngine();
    ~VideoEngine();

    /**
     * Initialize VideoEngine
     * @param fps Target frames per second
     * @param videoEncoder Encoder to use for EncodeFrame calls
     * @return true if successful
     */
    bool Initialize(uint32_t fps, VideoEncoder* videoEncoder);

    /**
     * Start the video engine (reset clock, enable ticking)
     */
    void Start();

    /**
     * Stop the video engine
     */
    void Stop();

    /**
     * Push a captured frame to the internal buffer
     * Called from CaptureThread (best effort, non-blocking)
     * 
     * @param frameData BGRA frame data (1920×1080×4 bytes)
     * @return true if frame was buffered, false if buffer full
     */
    bool PushFrame(const uint8_t* frameData);

    /**
     * GetPTSSeconds: Get current presentation time in seconds
     * Useful for synchronization
     */
    double GetPTSSeconds() const;

    /**
     * Flush: Finalize any remaining frames
     * Called during shutdown
     */
    void Flush();

    /**
     * Get current frame number (PTS)
     * Can be used as timestamp for muxing
     */
    uint64_t GetFrameNumber() const { return m_frameNumber; }

    /**
     * Get expected frame number at current time (CFR calculation)
     */
    uint64_t GetExpectedFrameNumber() const;

    /**
     * Advance frame number to next frame (call after encoding)
     */
    void AdvanceFrameNumber() { m_frameNumber++; }

    /**
     * Pop a frame from the ring buffer (for recorder to encode)
     * Returns true if frame was available
     */
    bool PopFrameFromBuffer(std::vector<uint8_t>& outFrame);

    /**
     * Get last captured frame (for frame duplication on lag)
     * Returns true if a last frame exists
     */
    bool GetLastFrame(std::vector<uint8_t>& outFrame) const;

    /**
     * Get statistics
     */
    uint64_t GetFramesEncoded() const { return m_framesEncoded; }
    uint64_t GetFramesDuplicated() const { return m_framesDuplicated; }

private:
    mutable std::mutex m_mutex;

    // Ring buffer for captured frames
    // Capture thread pushes here (best effort)
    // Tick thread pops from here
    static constexpr size_t BUFFER_SIZE = 4;  // Small ring: ~133ms at 30fps
    std::vector<std::vector<uint8_t>> m_frameBuffer;
    size_t m_bufferReadPos = 0;
    size_t m_bufferWritePos = 0;
    bool m_bufferHasFrames = false;

    uint32_t m_width = 0;
    uint32_t m_height = 0;
    size_t m_frameSize = 0;

    // Index of the most recently written frame slot (for duplication on lag)
    size_t m_lastFrameIndex = 0;
    bool m_hasLastFrame = false;

    // Clock master state
    std::chrono::high_resolution_clock::time_point m_startTime;
    uint64_t m_frameNumber = 0;
    uint32_t m_fps = 30;

    // Encoder reference (not owned)
    VideoEncoder* m_videoEncoder = nullptr;

    // Statistics
    uint64_t m_framesEncoded = 0;
    uint64_t m_framesDuplicated = 0;
    bool m_isRunning = false;

    // Helper: get next expected frame number
    uint64_t GetExpectedFrameNumberInternal() const;

    // Helper: pop frame from ring buffer (internal)
    bool PopFrameFromBufferInternal(std::vector<uint8_t>& outFrame);
};

#include "wasapi_video_engine.h"
#include "video_encoder.h"
#include <cstdio>
#include <algorithm>

VideoEngine::VideoEngine()
    : m_frameBuffer(BUFFER_SIZE)
{
    // Initialize all frames in buffer
    for (auto& frame : m_frameBuffer) {
        frame.resize(1920 * 1080 * 4);  // Will be resized correctly in Initialize
    }
}

VideoEngine::~VideoEngine() {
    // Nothing to clean up (VideoEncoder is not owned)
}

bool VideoEngine::Initialize(uint32_t fps, VideoEncoder* videoEncoder) {
    if (!videoEncoder || fps == 0) {
        fprintf(stderr, "[VideoEngine] Invalid params: encoder=%p, fps=%u\n", videoEncoder, fps);
        return false;
    }

    m_fps = fps;
    m_videoEncoder = videoEncoder;
    m_frameNumber = 0;
    m_framesEncoded = 0;
    m_framesDuplicated = 0;
    m_bufferReadPos = 0;
    m_bufferWritePos = 0;
    m_bufferHasFrames = false;
    m_hasLastFrame = false;

    fprintf(stderr, "[VideoEngine] Initialized: %u fps, encoder=%p\n", m_fps, m_videoEncoder);
    return true;
}

void VideoEngine::Start() {
    m_isRunning = true;
    m_startTime = std::chrono::high_resolution_clock::now();
    m_frameNumber = 0;
    m_framesEncoded = 0;
    m_framesDuplicated = 0;
    fprintf(stderr, "[VideoEngine] Started\n");
}

void VideoEngine::Stop() {
    m_isRunning = false;
    fprintf(stderr, "[VideoEngine] Stopped (encoded=%llu, duplicated=%llu)\n", 
            m_framesEncoded, m_framesDuplicated);
}

bool VideoEngine::PushFrame(const uint8_t* frameData) {
    if (!m_isRunning || !frameData) {
        return false;
    }

    // Get frame size from encoder
    // Assume 1920x1080 BGRA (hardcoded for now, could come from encoder)
    const size_t frameSize = 1920 * 1080 * 4;

    // Try to write to buffer (non-blocking)
    size_t nextWritePos = (m_bufferWritePos + 1) % BUFFER_SIZE;
    
    // Check if buffer is full
    if (nextWritePos == m_bufferReadPos && m_bufferHasFrames) {
        // Buffer full, drop oldest frame (or drop new frame)
        // For now: drop new frame (push back to capture - it will retry)
        return false;
    }

    // Copy frame to buffer
    std::copy(frameData, frameData + frameSize, m_frameBuffer[m_bufferWritePos].begin());
    m_bufferWritePos = nextWritePos;
    m_bufferHasFrames = true;

    return true;
}

bool VideoEngine::PopFrameFromBufferInternal(std::vector<uint8_t>& outFrame) {
    if (!m_bufferHasFrames || m_bufferReadPos == m_bufferWritePos) {
        return false;
    }

    outFrame = m_frameBuffer[m_bufferReadPos];
    m_bufferReadPos = (m_bufferReadPos + 1) % BUFFER_SIZE;

    // Check if buffer is now empty
    if (m_bufferReadPos == m_bufferWritePos) {
        m_bufferHasFrames = false;
    }

    return true;
}

uint64_t VideoEngine::GetExpectedFrameNumberInternal() const {
    if (!m_isRunning) {
        return m_frameNumber;
    }

    auto currentTime = std::chrono::high_resolution_clock::now();
    auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(
        currentTime - m_startTime).count();

    // Calculate expected frame based on CFR
    const int64_t frameIntervalNs = static_cast<int64_t>(1e9 / m_fps);
    uint64_t expectedFrame = elapsed / frameIntervalNs;

    return expectedFrame;
}

double VideoEngine::GetPTSSeconds() const {
    if (m_fps == 0) return 0.0;
    return static_cast<double>(m_frameNumber) / static_cast<double>(m_fps);
}

void VideoEngine::Flush() {
    // VideoEngine doesn't do encoding anymore, so nothing to flush internally
    // The recorder handles flushing the encoder
    fprintf(stderr, "[VideoEngine] Flush called\n");
}

uint64_t VideoEngine::GetExpectedFrameNumber() const {
    return GetExpectedFrameNumberInternal();
}

bool VideoEngine::PopFrameFromBuffer(std::vector<uint8_t>& outFrame) {
    return PopFrameFromBufferInternal(outFrame);
}

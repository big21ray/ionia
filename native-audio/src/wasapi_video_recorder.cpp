#include <napi.h>
#include "desktop_duplication.h"
#include "video_encoder.h"
#include "video_muxer.h"
#include <memory>
#include <thread>
#include <atomic>
#include <mutex>
#include <chrono>
#include <vector>
#include <cstdint>

// Video Recorder Addon (Video Only)
// Integrates DesktopDuplication + VideoEncoder + VideoMuxer
class VideoRecorderAddon : public Napi::ObjectWrap<VideoRecorderAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    VideoRecorderAddon(const Napi::CallbackInfo& info);
    ~VideoRecorderAddon();

private:
    static Napi::FunctionReference constructor;

    // Methods
    Napi::Value Initialize(const Napi::CallbackInfo& info);
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    Napi::Value IsRunning(const Napi::CallbackInfo& info);
    Napi::Value GetCurrentPTSSeconds(const Napi::CallbackInfo& info);
    Napi::Value GetStatistics(const Napi::CallbackInfo& info);

    // Internal
    void CaptureThread();
    void Cleanup();

    // Components
    std::unique_ptr<DesktopDuplication> m_desktopDupl;
    std::unique_ptr<VideoEncoder> m_videoEncoder;
    std::unique_ptr<VideoMuxer> m_videoMuxer;

    // State
    std::atomic<bool> m_isRunning;
    std::atomic<bool> m_shouldStop;
    std::thread m_captureThread;
    std::mutex m_mutex;

    // Configuration
    std::string m_outputPath;
    uint32_t m_width;
    uint32_t m_height;
    uint32_t m_fps;
    uint32_t m_videoBitrate;
    bool m_useNvenc;

    // Timing
    std::chrono::high_resolution_clock::time_point m_startTime;
    int64_t m_frameNumber;

    // Statistics
    uint64_t m_videoFramesCaptured;
    uint64_t m_videoPacketsEncoded;
};

Napi::FunctionReference VideoRecorderAddon::constructor;

Napi::Object VideoRecorderAddon::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "VideoRecorder", {
        InstanceMethod("initialize", &VideoRecorderAddon::Initialize),
        InstanceMethod("start", &VideoRecorderAddon::Start),
        InstanceMethod("stop", &VideoRecorderAddon::Stop),
        InstanceMethod("isRunning", &VideoRecorderAddon::IsRunning),
        InstanceMethod("getCurrentPTSSeconds", &VideoRecorderAddon::GetCurrentPTSSeconds),
        InstanceMethod("getStatistics", &VideoRecorderAddon::GetStatistics)
    });

    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();

    exports.Set("VideoRecorder", func);
    return exports;
}

VideoRecorderAddon::VideoRecorderAddon(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<VideoRecorderAddon>(info)
    , m_isRunning(false)
    , m_shouldStop(false)
    , m_width(0)
    , m_height(0)
    , m_fps(30)
    , m_videoBitrate(5000000)
    , m_useNvenc(true)
    , m_frameNumber(0)
    , m_videoFramesCaptured(0)
    , m_videoPacketsEncoded(0)
{
}

VideoRecorderAddon::~VideoRecorderAddon() {
    Cleanup();
}

Napi::Value VideoRecorderAddon::Initialize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected output path string").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    m_outputPath = info[0].As<Napi::String>().Utf8Value();

    // Optional parameters
    if (info.Length() >= 2 && info[1].IsNumber()) {
        m_fps = info[1].As<Napi::Number>().Uint32Value();
    }
    if (info.Length() >= 3 && info[2].IsNumber()) {
        m_videoBitrate = info[2].As<Napi::Number>().Uint32Value();
    }
    if (info.Length() >= 4 && info[3].IsBoolean()) {
        m_useNvenc = info[3].As<Napi::Boolean>().Value();
    }

    // Initialize Desktop Duplication
    m_desktopDupl = std::make_unique<DesktopDuplication>();
    if (!m_desktopDupl->Initialize()) {
        Napi::Error::New(env, "Failed to initialize Desktop Duplication").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    m_desktopDupl->GetDesktopDimensions(&m_width, &m_height);

    // Initialize Video Encoder
    m_videoEncoder = std::make_unique<VideoEncoder>();
    if (!m_videoEncoder->Initialize(m_width, m_height, m_fps, m_videoBitrate, m_useNvenc)) {
        Napi::Error::New(env, "Failed to initialize Video Encoder").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Initialize Video Muxer (with dummy audio params - we won't write audio packets)
    m_videoMuxer = std::make_unique<VideoMuxer>();
    if (!m_videoMuxer->Initialize(m_outputPath, m_videoEncoder.get(), 48000, 2, 192000)) {
        Napi::Error::New(env, "Failed to initialize Video Muxer").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value VideoRecorderAddon::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (m_isRunning) {
        return Napi::Boolean::New(env, false);
    }

    m_isRunning = true;
    m_shouldStop = false;
    m_frameNumber = 0;
    m_videoFramesCaptured = 0;
    m_videoPacketsEncoded = 0;
    m_startTime = std::chrono::high_resolution_clock::now();

    // Start capture thread
    m_captureThread = std::thread(&VideoRecorderAddon::CaptureThread, this);

    return Napi::Boolean::New(env, true);
}

Napi::Value VideoRecorderAddon::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!m_isRunning) {
        return Napi::Boolean::New(env, false);
    }

    // CRITICAL: Stop encoding FIRST, then flush
    // Rule 1: Never encode after flush
    m_shouldStop = true;

    // Wait for capture thread to finish (ensures no more EncodeFrame calls)
    if (m_captureThread.joinable()) {
        m_captureThread.join();
    }

    // NOW flush encoder (all encoding is done, flush is last)
    // Pipeline: [EncodeFrame] → [EncodeFrame] → ... → STOP → [Flush] → END
    if (m_videoEncoder) {
        auto packets = m_videoEncoder->Flush();
        // Use 0 for audioPTS since we don't have audio
        // Flush packets continue from the last frame
        // m_frameNumber is already incremented past the last captured frame
        // Each flush packet needs a unique, monotonically increasing DTS
        // Start from m_frameNumber and increment for each packet
        int64_t flushFrameIndex = m_frameNumber;
        for (const auto& packet : packets) {
            m_videoMuxer->WriteVideoPacket(&packet, flushFrameIndex, 0);
            m_videoPacketsEncoded++;
            flushFrameIndex++;  // Each flush packet gets a unique frame index
        }
    }

    // Finalize muxer
    if (m_videoMuxer) {
        m_videoMuxer->Finalize();
    }

    m_isRunning = false;

    return Napi::Boolean::New(env, true);
}

Napi::Value VideoRecorderAddon::IsRunning(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Boolean::New(env, m_isRunning);
}

Napi::Value VideoRecorderAddon::GetCurrentPTSSeconds(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (m_isRunning) {
        auto currentTime = std::chrono::high_resolution_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(currentTime - m_startTime).count();
        return Napi::Number::New(env, elapsed / 1000.0);
    }
    return Napi::Number::New(env, 0.0);
}

Napi::Value VideoRecorderAddon::GetStatistics(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object stats = Napi::Object::New(env);

    stats.Set("videoFramesCaptured", Napi::Number::New(env, static_cast<double>(m_videoFramesCaptured)));
    stats.Set("videoPacketsEncoded", Napi::Number::New(env, static_cast<double>(m_videoPacketsEncoded)));
    
    if (m_videoMuxer) {
        stats.Set("videoPacketsMuxed", Napi::Number::New(env, static_cast<double>(m_videoMuxer->GetVideoPackets())));
        stats.Set("totalBytes", Napi::Number::New(env, static_cast<double>(m_videoMuxer->GetTotalBytes())));
    }

    return stats;
}

void VideoRecorderAddon::CaptureThread() {
    const uint32_t frameSize = m_width * m_height * 4; // RGBA
    std::vector<uint8_t> frameBuffer(frameSize);

    // Calculate frame interval (nanoseconds)
    const int64_t frameIntervalNs = (1000000000LL / m_fps);

    while (!m_shouldStop) {
        auto currentTime = std::chrono::high_resolution_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(currentTime - m_startTime).count();
        int64_t expectedFrame = elapsed / frameIntervalNs;

        if (m_frameNumber < expectedFrame) {
            // Try to capture frame
            uint32_t width, height;
            int64_t timestamp;
            
            if (m_desktopDupl->CaptureFrame(frameBuffer.data(), &width, &height, &timestamp)) {
                // Encode frame (PTS is frame number in codec time_base: 1/fps)
                // So frame 0 = PTS 0, frame 1 = PTS 1, etc.
                auto packets = m_videoEncoder->EncodeFrame(frameBuffer.data(), m_frameNumber);
                
                // Write packets to muxer (use 0 for audioPTS since no audio)
                // Frame-based timestamps: PTS = DTS = frame_index (in time_base {1, fps})
                // All packets from the same frame have the same PTS and DTS
                // CRITICAL: m_frameNumber must be valid (>= 0, never AV_NOPTS_VALUE)
                if (m_frameNumber < 0) {
                    fprintf(stderr, "[VideoRecorder] ERROR: Invalid frame number %lld, skipping\n", m_frameNumber);
                    continue;
                }
                
                // OBS-STYLE: Encoder returns BYTES ONLY, muxer manages timestamps
                // All packets from the same frame share the same frame index
                int64_t currentFrameIndex = m_frameNumber;
                for (const auto& packet : packets) {
                    // Pass packet directly to muxer with frame index
                    // All packets from same frame use same frameIndex for timestamps
                    m_videoMuxer->WriteVideoPacket(&packet, currentFrameIndex, 0);
                    m_videoPacketsEncoded++;
                }
                
                m_videoFramesCaptured++;
                m_frameNumber++;
            }
        } else {
            // Wait a bit to avoid busy waiting
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
}

void VideoRecorderAddon::Cleanup() {
    if (m_isRunning) {
        Stop(Napi::CallbackInfo(nullptr, 0));
    }

    m_desktopDupl.reset();
    m_videoEncoder.reset();
    m_videoMuxer.reset();
}

// Module initialization (exported for wasapi_capture.cpp)
Napi::Object VideoRecorderInit(Napi::Env env, Napi::Object exports) {
    VideoRecorderAddon::Init(env, exports);
    return exports;
}


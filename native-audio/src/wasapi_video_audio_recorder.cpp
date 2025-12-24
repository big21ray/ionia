#include <napi.h>
#include "desktop_duplication.h"
#include "video_encoder.h"
#include "video_muxer.h"
#include "audio_capture.h"
#include "audio_engine.h"
#include "audio_encoder.h"
#include "encoded_audio_packet.h"
#include <memory>
#include <thread>
#include <atomic>
#include <mutex>
#include <chrono>
#include <vector>
#include <cstdint>

// Combined Video + Audio Recorder Addon
// Integrates DesktopDuplication + VideoEncoder + VideoMuxer + AudioCapture + AudioEngine + AudioEncoder
class VideoAudioRecorderAddon : public Napi::ObjectWrap<VideoAudioRecorderAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    VideoAudioRecorderAddon(const Napi::CallbackInfo& info);
    ~VideoAudioRecorderAddon();

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
    void AudioTickThread();
    void OnAudioData(const BYTE* data, UINT32 numFrames, const char* source, WAVEFORMATEX* format);
    void Cleanup();

    // Components
    std::unique_ptr<DesktopDuplication> m_desktopDupl;
    std::unique_ptr<VideoEncoder> m_videoEncoder;
    std::unique_ptr<VideoMuxer> m_videoMuxer;
    std::unique_ptr<AudioCapture> m_audioCapture;
    std::unique_ptr<AudioEngine> m_audioEngine;
    std::unique_ptr<AudioEncoder> m_audioEncoder;

    // State
    std::atomic<bool> m_isRunning;
    std::atomic<bool> m_shouldStop;
    std::thread m_captureThread;
    std::thread m_audioTickThread;
    std::mutex m_mutex;

    // Configuration
    std::string m_outputPath;
    uint32_t m_width;
    uint32_t m_height;
    uint32_t m_fps;
    uint32_t m_videoBitrate;
    uint32_t m_audioBitrate;
    bool m_useNvenc;
    std::string m_audioMode;  // "mic", "desktop", "both"

    // Timing
    std::chrono::high_resolution_clock::time_point m_startTime;
    int64_t m_frameNumber;

    // Statistics
    uint64_t m_videoFramesCaptured;
    uint64_t m_videoPacketsEncoded;
    uint64_t m_audioPacketsEncoded;
};

Napi::FunctionReference VideoAudioRecorderAddon::constructor;

Napi::Object VideoAudioRecorderAddon::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "VideoAudioRecorder", {
        InstanceMethod("initialize", &VideoAudioRecorderAddon::Initialize),
        InstanceMethod("start", &VideoAudioRecorderAddon::Start),
        InstanceMethod("stop", &VideoAudioRecorderAddon::Stop),
        InstanceMethod("isRunning", &VideoAudioRecorderAddon::IsRunning),
        InstanceMethod("getCurrentPTSSeconds", &VideoAudioRecorderAddon::GetCurrentPTSSeconds),
        InstanceMethod("getStatistics", &VideoAudioRecorderAddon::GetStatistics)
    });

    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();

    exports.Set("VideoAudioRecorder", func);
    return exports;
}

VideoAudioRecorderAddon::VideoAudioRecorderAddon(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<VideoAudioRecorderAddon>(info)
    , m_isRunning(false)
    , m_shouldStop(false)
    , m_width(0)
    , m_height(0)
    , m_fps(30)
    , m_videoBitrate(5000000)
    , m_audioBitrate(192000)
    , m_useNvenc(true)
    , m_audioMode("both")
    , m_frameNumber(0)
    , m_videoFramesCaptured(0)
    , m_videoPacketsEncoded(0)
    , m_audioPacketsEncoded(0)
{
}

VideoAudioRecorderAddon::~VideoAudioRecorderAddon() {
    Cleanup();
}

Napi::Value VideoAudioRecorderAddon::Initialize(const Napi::CallbackInfo& info) {
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
    if (info.Length() >= 5 && info[4].IsNumber()) {
        m_audioBitrate = info[4].As<Napi::Number>().Uint32Value();
    }
    if (info.Length() >= 6 && info[5].IsString()) {
        std::string mode = info[5].As<Napi::String>().Utf8Value();
        if (mode == "mic" || mode == "desktop" || mode == "both") {
            m_audioMode = mode;
        }
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

    // Initialize Audio Capture
    m_audioCapture = std::make_unique<AudioCapture>();
    auto audioCallback = [this](const BYTE* data, UINT32 numFrames, const char* source, WAVEFORMATEX* format) {
        this->OnAudioData(data, numFrames, source, format);
    };
    if (!m_audioCapture->Initialize(audioCallback, m_audioMode.c_str())) {
        Napi::Error::New(env, "Failed to initialize Audio Capture").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Initialize Audio Engine (clock master - provides PTS)
    m_audioEngine = std::make_unique<AudioEngine>();
    auto engineCallback = [this](const AudioPacket& packet) {
        // This callback receives PCM AudioPackets from AudioEngine
        // Encode PCM to AAC (encoder returns BYTES ONLY, no timestamps)
        const float* pcmData = reinterpret_cast<const float*>(packet.data.data());
        UINT32 numFrames = static_cast<UINT32>(packet.duration);

        // Encode frames (encoder doesn't need PTS - muxer assigns it)
        std::vector<EncodedAudioPacket> encodedPackets = m_audioEncoder->EncodeFrames(pcmData, numFrames);

        // Write encoded audio packets to muxer (muxer assigns timestamps)
        for (const EncodedAudioPacket& encodedPacket : encodedPackets) {
            if (encodedPacket.isValid()) {
                m_videoMuxer->WriteAudioPacket(encodedPacket);
                m_audioPacketsEncoded++;
            }
        }
    };
    if (!m_audioEngine->Initialize(engineCallback)) {
        Napi::Error::New(env, "Failed to initialize Audio Engine").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Initialize Audio Encoder
    m_audioEncoder = std::make_unique<AudioEncoder>();
    if (!m_audioEncoder->Initialize(AudioEngine::SAMPLE_RATE, AudioEngine::CHANNELS, m_audioBitrate)) {
        Napi::Error::New(env, "Failed to initialize Audio Encoder").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Initialize Video Muxer (with real audio params)
    m_videoMuxer = std::make_unique<VideoMuxer>();
    if (!m_videoMuxer->Initialize(m_outputPath, m_videoEncoder.get(), 
                                   AudioEngine::SAMPLE_RATE, AudioEngine::CHANNELS, m_audioBitrate)) {
        Napi::Error::New(env, "Failed to initialize Video Muxer").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value VideoAudioRecorderAddon::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (m_isRunning) {
        return Napi::Boolean::New(env, false);
    }

    m_isRunning = true;
    m_shouldStop = false;
    m_frameNumber = 0;
    m_videoFramesCaptured = 0;
    m_videoPacketsEncoded = 0;
    m_audioPacketsEncoded = 0;
    m_startTime = std::chrono::high_resolution_clock::now();

    // Start audio capture
    if (!m_audioCapture->Start()) {
        m_isRunning = false;
        Napi::Error::New(env, "Failed to start audio capture").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Start audio engine (clock master)
    if (!m_audioEngine->Start()) {
        m_audioCapture->Stop();
        m_isRunning = false;
        Napi::Error::New(env, "Failed to start audio engine").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    // Start capture thread (video)
    m_captureThread = std::thread(&VideoAudioRecorderAddon::CaptureThread, this);

    // Start audio tick thread (processes audio engine ticks)
    m_audioTickThread = std::thread(&VideoAudioRecorderAddon::AudioTickThread, this);

    return Napi::Boolean::New(env, true);
}

Napi::Value VideoAudioRecorderAddon::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (!m_isRunning) {
        return Napi::Boolean::New(env, false);
    }

    // CRITICAL: Stop encoding FIRST, then flush
    m_shouldStop = true;

    // Stop audio engine first (stops generating new audio packets)
    if (m_audioEngine && m_audioEngine->IsRunning()) {
        m_audioEngine->Stop();
    }

    // Stop audio capture
    if (m_audioCapture && m_audioCapture->IsCapturing()) {
        m_audioCapture->Stop();
    }

    // Wait for audio tick thread to finish
    if (m_audioTickThread.joinable()) {
        m_audioTickThread.join();
    }

    // Flush audio encoder
    if (m_audioEncoder && m_audioEncoder->IsInitialized()) {
        std::vector<EncodedAudioPacket> flushedPackets = m_audioEncoder->Flush();
        for (const EncodedAudioPacket& packet : flushedPackets) {
            if (packet.isValid()) {
                m_videoMuxer->WriteAudioPacket(packet);
                m_audioPacketsEncoded++;
            }
        }
    }

    // Wait for capture thread to finish (ensures no more EncodeFrame calls)
    if (m_captureThread.joinable()) {
        m_captureThread.join();
    }

    // NOW flush video encoder (all encoding is done, flush is last)
    if (m_videoEncoder) {
        auto packets = m_videoEncoder->Flush();
        int64_t flushFrameIndex = m_frameNumber;
        for (const auto& packet : packets) {
            // Muxer assigns timestamps based on frame index
            m_videoMuxer->WriteVideoPacket(&packet, flushFrameIndex);
            m_videoPacketsEncoded++;
            flushFrameIndex++;
        }
    }

    // Finalize muxer
    if (m_videoMuxer) {
        m_videoMuxer->Finalize();
    }

    m_isRunning = false;

    return Napi::Boolean::New(env, true);
}

Napi::Value VideoAudioRecorderAddon::IsRunning(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    return Napi::Boolean::New(env, m_isRunning);
}

Napi::Value VideoAudioRecorderAddon::GetCurrentPTSSeconds(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (m_isRunning && m_audioEngine) {
        return Napi::Number::New(env, m_audioEngine->GetCurrentPTSSeconds());
    }
    return Napi::Number::New(env, 0.0);
}

Napi::Value VideoAudioRecorderAddon::GetStatistics(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object stats = Napi::Object::New(env);

    stats.Set("videoFramesCaptured", Napi::Number::New(env, static_cast<double>(m_videoFramesCaptured)));
    stats.Set("videoPacketsEncoded", Napi::Number::New(env, static_cast<double>(m_videoPacketsEncoded)));
    stats.Set("audioPacketsEncoded", Napi::Number::New(env, static_cast<double>(m_audioPacketsEncoded)));
    
    if (m_videoMuxer) {
        stats.Set("videoPacketsMuxed", Napi::Number::New(env, static_cast<double>(m_videoMuxer->GetVideoPackets())));
        stats.Set("audioPacketsMuxed", Napi::Number::New(env, static_cast<double>(m_videoMuxer->GetAudioPackets())));
        stats.Set("totalBytes", Napi::Number::New(env, static_cast<double>(m_videoMuxer->GetTotalBytes())));
    }

    return stats;
}

void VideoAudioRecorderAddon::CaptureThread() {
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
                // Encode frame (encoder returns BYTES ONLY, no timestamps)
                auto packets = m_videoEncoder->EncodeFrame(frameBuffer.data());
                
                // Write packets to muxer (muxer assigns timestamps based on frame index)
                int64_t currentFrameIndex = m_frameNumber;
                for (const auto& packet : packets) {
                    m_videoMuxer->WriteVideoPacket(&packet, currentFrameIndex);
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

void VideoAudioRecorderAddon::AudioTickThread() {
    // Audio engine tick thread - processes audio at regular intervals
    // AudioEngine is the clock master, so we tick it regularly
    const int tickIntervalMs = 10;  // 10ms intervals (100 Hz)
    
    while (!m_shouldStop && m_audioEngine && m_audioEngine->IsRunning()) {
        m_audioEngine->Tick();
        std::this_thread::sleep_for(std::chrono::milliseconds(tickIntervalMs));
    }
}

void VideoAudioRecorderAddon::OnAudioData(const BYTE* data, UINT32 numFrames, const char* source, WAVEFORMATEX* format) {
    // AudioCapture provides float32, 48kHz, stereo data
    // Feed it directly to AudioEngine
    if (m_audioEngine && m_audioEngine->IsRunning() && data && numFrames > 0) {
        // AudioCapture already provides float32 data, so we can cast it
        const float* floatData = reinterpret_cast<const float*>(data);
        m_audioEngine->FeedAudioData(floatData, numFrames, source);
    }
}

void VideoAudioRecorderAddon::Cleanup() {
    if (m_isRunning) {
        Stop(Napi::CallbackInfo(nullptr, 0));
    }

    m_desktopDupl.reset();
    m_videoEncoder.reset();
    m_videoMuxer.reset();
    m_audioCapture.reset();
    m_audioEngine.reset();
    m_audioEncoder.reset();
}

// Module initialization (exported for wasapi_capture.cpp)
Napi::Object VideoAudioRecorderInit(Napi::Env env, Napi::Object exports) {
    VideoAudioRecorderAddon::Init(env, exports);
    return exports;
}


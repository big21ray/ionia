// NOTE:
// This version removes the timer-based AudioTickThread.
// Audio is now emitted ONLY when data arrives from WASAPI.
// This prevents pitch drift, crackles, and long-term slowdown.

#include <napi.h>
#include "desktop_duplication.h"
#include "video_encoder.h"
#include "video_muxer.h"
#include "audio_capture.h"
#include "audio_engine.h"
#include "audio_encoder.h"
#include "encoded_audio_packet.h"
#include "wasapi_video_engine.h"

#include <windows.h>
#include <comdef.h>
#include <memory>
#include <thread>
#include <atomic>
#include <mutex>
#include <string>
#include <vector>
#include <cstdint>

class VideoAudioRecorderAddon : public Napi::ObjectWrap<VideoAudioRecorderAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    VideoAudioRecorderAddon(const Napi::CallbackInfo& info);
    ~VideoAudioRecorderAddon();

private:
    static Napi::FunctionReference constructor;

    Napi::Value Initialize(const Napi::CallbackInfo& info);
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    Napi::Value IsRunning(const Napi::CallbackInfo& info);
    Napi::Value GetCodecName(const Napi::CallbackInfo& info);
    Napi::Value GetCurrentPTSSeconds(const Napi::CallbackInfo& info);
    Napi::Value GetStatistics(const Napi::CallbackInfo& info);

    void CaptureThread();
    void VideoTickThread();
    void OnAudioData(const BYTE* data, UINT32 frames, const char* source, WAVEFORMATEX*);

    bool StopInternal();

    void Cleanup();

private:
    std::unique_ptr<DesktopDuplication> m_desktop;
    std::unique_ptr<VideoEncoder> m_videoEncoder;
    std::unique_ptr<VideoEngine> m_videoEngine;
    std::unique_ptr<VideoMuxer> m_videoMuxer;

    std::unique_ptr<AudioCapture> m_audioCapture;
    std::unique_ptr<AudioEngine> m_audioEngine;
    std::unique_ptr<AudioEncoder> m_audioEncoder;

    std::thread m_captureThread;
    std::thread m_videoTickThread;

    std::mutex m_muxerMutex;

    std::atomic<bool> m_running{false};
    std::atomic<bool> m_stop{false};

    uint32_t m_width = 0;
    uint32_t m_height = 0;
    uint32_t m_fps = 30;

    std::string m_outputPath;
    uint32_t m_videoBitrate = 5'000'000;
    bool m_useNvenc = true;
    uint32_t m_audioBitrate = 192'000;
    std::string m_audioMode = "both";

    bool m_comInitialized = false;
};

Napi::FunctionReference VideoAudioRecorderAddon::constructor;

Napi::Object VideoAudioRecorderAddon::Init(Napi::Env env, Napi::Object exports) {
    exports.Set(
        "VideoAudioRecorder",
        DefineClass(env, "VideoAudioRecorder", {
            InstanceMethod("initialize", &VideoAudioRecorderAddon::Initialize),
            InstanceMethod("start", &VideoAudioRecorderAddon::Start),
            InstanceMethod("stop", &VideoAudioRecorderAddon::Stop),
            InstanceMethod("isRunning", &VideoAudioRecorderAddon::IsRunning),
            InstanceMethod("getCodecName", &VideoAudioRecorderAddon::GetCodecName),
            InstanceMethod("getCurrentPTSSeconds", &VideoAudioRecorderAddon::GetCurrentPTSSeconds),
            InstanceMethod("getStatistics", &VideoAudioRecorderAddon::GetStatistics),
        })
    );
    return exports;
}

VideoAudioRecorderAddon::VideoAudioRecorderAddon(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<VideoAudioRecorderAddon>(info) {}

VideoAudioRecorderAddon::~VideoAudioRecorderAddon() {
    StopInternal();
    Cleanup();

    if (m_comInitialized) {
        CoUninitialize();
        m_comInitialized = false;
    }
}

Napi::Value VideoAudioRecorderAddon::Initialize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (m_running) {
        Napi::Error::New(env, "Cannot initialize while running").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected output path string").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    m_outputPath = info[0].As<Napi::String>().Utf8Value();

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

    // Detect COM mode (STA vs MTA). This impacts h264_mf usage.
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    bool comInSTAMode = false;
    if (hr == RPC_E_CHANGED_MODE) {
        comInSTAMode = true;
        fprintf(stderr, "[VideoAudioRecorder] COM is in STA mode (RPC_E_CHANGED_MODE)\n");
    } else if (hr == S_OK) {
        m_comInitialized = true;
    }

    m_desktop = std::make_unique<DesktopDuplication>();
    if (!m_desktop->Initialize()) {
        Napi::Error::New(env, "Failed to initialize Desktop Duplication").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    m_desktop->GetDesktopDimensions(&m_width, &m_height);

    m_videoEncoder = std::make_unique<VideoEncoder>();
    if (!m_videoEncoder->Initialize(m_width, m_height, m_fps, m_videoBitrate, m_useNvenc, comInSTAMode)) {
        Napi::Error::New(env, "Failed to initialize Video Encoder").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    m_videoEngine = std::make_unique<VideoEngine>();
    if (!m_videoEngine->Initialize(m_fps, m_videoEncoder.get())) {
        Napi::Error::New(env, "Failed to initialize Video Engine").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    m_audioEncoder = std::make_unique<AudioEncoder>();
    if (!m_audioEncoder->Initialize(AudioEngine::SAMPLE_RATE, AudioEngine::CHANNELS, m_audioBitrate)) {
        Napi::Error::New(env, "Failed to initialize Audio Encoder").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    m_videoMuxer = std::make_unique<VideoMuxer>();
    if (!m_videoMuxer->Initialize(m_outputPath, m_videoEncoder.get(),
                                  AudioEngine::SAMPLE_RATE,
                                  AudioEngine::CHANNELS,
                                  m_audioBitrate)) {
        Napi::Error::New(env, "Failed to initialize Video Muxer").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    m_audioEngine = std::make_unique<AudioEngine>();
    // We don't rely on Tick() for the recorder anymore (event-driven draining), but Start() requires a callback.
    if (!m_audioEngine->Initialize([](const AudioPacket&) {})) {
        Napi::Error::New(env, "Failed to initialize Audio Engine").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    m_audioCapture = std::make_unique<AudioCapture>();
    if (!m_audioCapture->Initialize(
            [this](const BYTE* d, UINT32 f, const char* s, WAVEFORMATEX* fmt) { OnAudioData(d, f, s, fmt); },
            m_audioMode.c_str())) {
        Napi::Error::New(env, "Failed to initialize Audio Capture").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    return Napi::Boolean::New(env, true);
}

Napi::Value VideoAudioRecorderAddon::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    if (m_running) {
        return Napi::Boolean::New(env, false);
    }

    if (!m_desktop || !m_videoEncoder || !m_videoEngine || !m_videoMuxer || !m_audioCapture || !m_audioEngine || !m_audioEncoder) {
        Napi::Error::New(env, "Recorder not initialized").ThrowAsJavaScriptException();
        return env.Undefined();
    }

    m_running = true;
    m_stop = false;

    m_audioEngine->Start();
    m_audioCapture->Start();
    m_videoEngine->Start();

    m_captureThread = std::thread(&VideoAudioRecorderAddon::CaptureThread, this);
    m_videoTickThread = std::thread(&VideoAudioRecorderAddon::VideoTickThread, this);

    return Napi::Boolean::New(env, true);
}

Napi::Value VideoAudioRecorderAddon::Stop(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), StopInternal());
}

bool VideoAudioRecorderAddon::StopInternal() {
    if (!m_running && m_stop) {
        return true;
    }

    m_stop = true;
    m_running = false;

    // Stop sources first to prevent callbacks/writes racing with finalization.
    if (m_audioCapture) m_audioCapture->Stop();
    if (m_audioEngine) m_audioEngine->Stop();
    if (m_videoEngine) m_videoEngine->Stop();

    if (m_captureThread.joinable()) m_captureThread.join();
    if (m_videoTickThread.joinable()) m_videoTickThread.join();

    bool ok = true;
    {
        std::lock_guard<std::mutex> lock(m_muxerMutex);
        if (m_videoMuxer) {
            ok = m_videoMuxer->Finalize();
        }
    }

    return ok;
}

void VideoAudioRecorderAddon::OnAudioData(
    const BYTE* data, UINT32 frames, const char* src, WAVEFORMATEX*) {

    if (!m_audioEngine || !m_audioEngine->IsRunning()) return;

    m_audioEngine->FeedAudioData(
        reinterpret_cast<const float*>(data),
        frames,
        src
    );

    // Event-driven AAC cadence: drain full 1024-frame blocks as they become available.
    // This avoids timer-driven padding gaps and keeps the encoder contract strict.
    constexpr UINT32 kAacFrameSize = 1024;
    AudioPacket pkt;
    while (!m_stop && m_audioEngine && m_audioEncoder && m_videoMuxer &&
           m_audioEngine->TryPopMixedAudioPacket(kAacFrameSize, m_audioMode.c_str(), pkt)) {
        auto encoded = m_audioEncoder->EncodeFrames(
            reinterpret_cast<const float*>(pkt.data.data()),
            static_cast<uint32_t>(pkt.duration)
        );

        std::lock_guard<std::mutex> lock(m_muxerMutex);
        for (auto& e : encoded) {
            m_videoMuxer->WriteAudioPacket(e);
        }
    }
}

void VideoAudioRecorderAddon::CaptureThread() {
    std::vector<uint8_t> frame(m_width * m_height * 4);

    while (!m_stop) {
        uint32_t w, h;
        int64_t ts;
        if (m_desktop->CaptureFrame(frame.data(), &w, &h, &ts)) {
            m_videoEngine->PushFrame(frame.data());
        } else {
            // Avoid 100% CPU when no new frame is available.
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
}

void VideoAudioRecorderAddon::VideoTickThread() {
    std::vector<uint8_t> frame(m_width * m_height * 4);

    while (!m_stop) {
        if (m_videoEngine->GetFrameNumber() <
            m_videoEngine->GetExpectedFrameNumber()) {
            bool hasFrame = m_videoEngine->PopFrameFromBuffer(frame);
            if (!hasFrame) {
                // Duplicate last frame if capture lags.
                hasFrame = m_videoEngine->GetLastFrame(frame);
            }

            if (hasFrame) {
                auto packets = m_videoEncoder->EncodeFrame(frame.data());
                std::lock_guard<std::mutex> lock(m_muxerMutex);
                for (auto& p : packets) {
                    m_videoMuxer->WriteVideoPacket(&p, m_videoEngine->GetFrameNumber());
                }
            }
            m_videoEngine->AdvanceFrameNumber();
        } else {
            // Sleep a little to avoid a tight spin when we're ahead of schedule.
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
}

Napi::Value VideoAudioRecorderAddon::IsRunning(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), m_running);
}

Napi::Value VideoAudioRecorderAddon::GetCodecName(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!m_videoEncoder) {
        return Napi::String::New(env, "none");
    }
    return Napi::String::New(env, m_videoEncoder->GetCodecName());
}

Napi::Value VideoAudioRecorderAddon::GetCurrentPTSSeconds(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    if (!m_videoEngine) {
        return Napi::Number::New(env, 0.0);
    }
    return Napi::Number::New(env, m_videoEngine->GetPTSSeconds());
}

Napi::Value VideoAudioRecorderAddon::GetStatistics(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    Napi::Object stats = Napi::Object::New(env);

    uint64_t videoFrames = 0;
    if (m_videoEngine) {
        videoFrames = m_videoEngine->GetFrameNumber();
    }

    uint64_t videoPackets = 0;
    uint64_t audioPackets = 0;
    uint64_t totalBytes = 0;
    if (m_videoMuxer) {
        videoPackets = m_videoMuxer->GetVideoPackets();
        audioPackets = m_videoMuxer->GetAudioPackets();
        totalBytes = m_videoMuxer->GetTotalBytes();
    }

    stats.Set("videoFramesCaptured", Napi::Number::New(env, static_cast<double>(videoFrames)));
    stats.Set("videoPacketsEncoded", Napi::Number::New(env, static_cast<double>(videoPackets)));
    stats.Set("audioPacketsEncoded", Napi::Number::New(env, static_cast<double>(audioPackets)));
    stats.Set("videoPacketsMuxed", Napi::Number::New(env, static_cast<double>(videoPackets)));
    stats.Set("audioPacketsMuxed", Napi::Number::New(env, static_cast<double>(audioPackets)));
    stats.Set("totalBytes", Napi::Number::New(env, static_cast<double>(totalBytes)));

    return stats;
}

void VideoAudioRecorderAddon::Cleanup() {
    m_audioCapture.reset();
    m_audioEngine.reset();
    m_audioEncoder.reset();
    m_videoEngine.reset();
    m_videoEncoder.reset();
    m_videoMuxer.reset();
    m_desktop.reset();
}

// Module initialization (exported for wasapi_capture.cpp)
Napi::Object VideoAudioRecorderInit(Napi::Env env, Napi::Object exports) {
    VideoAudioRecorderAddon::Init(env, exports);
    return exports;
}

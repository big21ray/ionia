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
    Napi::Value GetStatistics(const Napi::CallbackInfo& info);

    void CaptureThread();
    void VideoTickThread();
    void OnAudioData(const BYTE* data, UINT32 frames, const char* source, WAVEFORMATEX*);

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

    std::atomic<bool> m_running{false};
    std::atomic<bool> m_stop{false};

    uint32_t m_width = 0;
    uint32_t m_height = 0;
    uint32_t m_fps = 30;
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
            InstanceMethod("getStatistics", &VideoAudioRecorderAddon::GetStatistics),
        })
    );
    return exports;
}

VideoAudioRecorderAddon::VideoAudioRecorderAddon(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<VideoAudioRecorderAddon>(info) {}

VideoAudioRecorderAddon::~VideoAudioRecorderAddon() {
    Stop(Napi::CallbackInfo(nullptr, nullptr));
    Cleanup();
}

Napi::Value VideoAudioRecorderAddon::Initialize(const Napi::CallbackInfo& info) {
    m_desktop = std::make_unique<DesktopDuplication>();
    m_desktop->Initialize();
    m_desktop->GetDesktopDimensions(&m_width, &m_height);

    m_videoEncoder = std::make_unique<VideoEncoder>();
    m_videoEncoder->Initialize(m_width, m_height, m_fps, 5'000'000, true, false);

    m_videoEngine = std::make_unique<VideoEngine>();
    m_videoEngine->Initialize(m_fps, m_videoEncoder.get());

    m_audioEncoder = std::make_unique<AudioEncoder>();
    m_audioEncoder->Initialize(AudioEngine::SAMPLE_RATE, AudioEngine::CHANNELS, 192000);

    m_videoMuxer = std::make_unique<VideoMuxer>();
    m_videoMuxer->Initialize("output.mp4", m_videoEncoder.get(),
                             AudioEngine::SAMPLE_RATE,
                             AudioEngine::CHANNELS,
                             192000);

    m_audioEngine = std::make_unique<AudioEngine>();

    m_audioEngine->Initialize([this](const AudioPacket& pkt) {
        auto encoded = m_audioEncoder->EncodeFrames(
            reinterpret_cast<const float*>(pkt.data.data()),
            static_cast<uint32_t>(pkt.duration)
        );

        for (auto& e : encoded) {
            m_videoMuxer->WriteAudioPacket(e);
        }
    });

    m_audioCapture = std::make_unique<AudioCapture>();
    m_audioCapture->Initialize(
        [this](const BYTE* d, UINT32 f, const char* s, WAVEFORMATEX* fmt) {
            OnAudioData(d, f, s, fmt);
        },
        "both"
    );

    return Napi::Boolean::New(info.Env(), true);
}

Napi::Value VideoAudioRecorderAddon::Start(const Napi::CallbackInfo& info) {
    m_running = true;
    m_stop = false;

    m_audioEngine->Start();
    m_audioCapture->Start();
    m_videoEngine->Start();

    m_captureThread = std::thread(&VideoAudioRecorderAddon::CaptureThread, this);
    m_videoTickThread = std::thread(&VideoAudioRecorderAddon::VideoTickThread, this);

    return Napi::Boolean::New(info.Env(), true);
}

Napi::Value VideoAudioRecorderAddon::Stop(const Napi::CallbackInfo& info) {
    m_stop = true;
    m_running = false;

    if (m_captureThread.joinable()) m_captureThread.join();
    if (m_videoTickThread.joinable()) m_videoTickThread.join();

    if (m_audioCapture) m_audioCapture->Stop();
    if (m_audioEngine) m_audioEngine->Stop();
    if (m_videoMuxer) m_videoMuxer->Finalize();

    return Napi::Boolean::New(info.Env(), true);
}

void VideoAudioRecorderAddon::OnAudioData(
    const BYTE* data, UINT32 frames, const char* src, WAVEFORMATEX*) {

    if (!m_audioEngine || !m_audioEngine->IsRunning()) return;

    m_audioEngine->FeedAudioData(
        reinterpret_cast<const float*>(data),
        frames,
        src
    );
}

void VideoAudioRecorderAddon::CaptureThread() {
    std::vector<uint8_t> frame(m_width * m_height * 4);

    while (!m_stop) {
        uint32_t w, h;
        int64_t ts;
        if (m_desktop->CaptureFrame(frame.data(), &w, &h, &ts)) {
            m_videoEngine->PushFrame(frame.data());
        }
    }
}

void VideoAudioRecorderAddon::VideoTickThread() {
    while (!m_stop) {
        if (m_videoEngine->GetFrameNumber() <
            m_videoEngine->GetExpectedFrameNumber()) {

            std::vector<uint8_t> frame;
            if (m_videoEngine->PopFrameFromBuffer(frame)) {
                auto packets = m_videoEncoder->EncodeFrame(frame.data());
                for (auto& p : packets) {
                    m_videoMuxer->WriteVideoPacket(&p, m_videoEngine->GetFrameNumber());
                }
            }
            m_videoEngine->AdvanceFrameNumber();
        }
    }
}

Napi::Value VideoAudioRecorderAddon::IsRunning(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), m_running);
}

Napi::Value VideoAudioRecorderAddon::GetStatistics(const Napi::CallbackInfo& info) {
    return Napi::Object::New(info.Env());
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

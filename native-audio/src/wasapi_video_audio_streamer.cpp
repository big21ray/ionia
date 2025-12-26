#include <napi.h>

#include "desktop_duplication.h"
#include "video_encoder.h"
#include "stream_muxer.h"
#include "stream_buffer.h"
#include "audio_capture.h"
#include "audio_engine.h"
#include "audio_encoder.h"
#include "encoded_audio_packet.h"

#include <windows.h>
#include <comdef.h>

#include <memory>
#include <thread>
#include <atomic>
#include <mutex>
#include <chrono>
#include <vector>
#include <cstdint>
#include <cstdio>

/* =========================================================
   VideoAudioStreamerAddon
   ========================================================= */

class VideoAudioStreamerAddon : public Napi::ObjectWrap<VideoAudioStreamerAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    VideoAudioStreamerAddon(const Napi::CallbackInfo& info);
    ~VideoAudioStreamerAddon();

private:
    static Napi::FunctionReference constructor;

    // JS methods
    Napi::Value Initialize(const Napi::CallbackInfo& info);
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    Napi::Value IsRunning(const Napi::CallbackInfo& info);
    Napi::Value GetStatistics(const Napi::CallbackInfo& info);
    Napi::Value GetCodecName(const Napi::CallbackInfo& info);
    Napi::Value IsConnected(const Napi::CallbackInfo& info);
    Napi::Value IsBackpressure(const Napi::CallbackInfo& info);

    // Threads
    void CaptureThread();
    void AudioTickThread();
    void NetworkSendThread();

    void OnAudioData(const BYTE* data,
                     UINT32 frames,
                     const char* source,
                     WAVEFORMATEX* format);

    void Cleanup();

private:
    // Components
    std::unique_ptr<DesktopDuplication> m_desktop;
    std::unique_ptr<VideoEncoder>       m_videoEncoder;
    std::unique_ptr<StreamMuxer>        m_streamMuxer;
    std::unique_ptr<StreamBuffer>       m_buffer;
    std::unique_ptr<AudioCapture>       m_audioCapture;
    std::unique_ptr<AudioEngine>        m_audioEngine;
    std::unique_ptr<AudioEncoder>       m_audioEncoder;

    // Threads
    std::thread m_captureThread;
    std::thread m_audioTickThread;
    std::thread m_networkThread;

    std::atomic<bool> m_isRunning;
    std::atomic<bool> m_shouldStop;

    // Config
    std::string m_rtmpUrl;
    uint32_t m_width;
    uint32_t m_height;
    uint32_t m_fps;
    uint32_t m_videoBitrate;
    uint32_t m_audioBitrate;
    bool     m_useNvenc;
    std::string m_audioMode;

    // Stats (atomic to avoid mutex lock in getStatistics)
    std::atomic<uint64_t> m_videoFrames;
    std::atomic<uint64_t> m_videoPackets;
    std::atomic<uint64_t> m_audioPackets;

    bool m_comInitialized;
};

/* ========================================================= */

Napi::FunctionReference VideoAudioStreamerAddon::constructor;

Napi::Object VideoAudioStreamerAddon::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function fn = DefineClass(env, "VideoAudioStreamer", {
        InstanceMethod("initialize", &VideoAudioStreamerAddon::Initialize),
        InstanceMethod("start", &VideoAudioStreamerAddon::Start),
        InstanceMethod("stop", &VideoAudioStreamerAddon::Stop),
        InstanceMethod("isRunning", &VideoAudioStreamerAddon::IsRunning),
        InstanceMethod("getStatistics", &VideoAudioStreamerAddon::GetStatistics),
        InstanceMethod("getCodecName", &VideoAudioStreamerAddon::GetCodecName),
        InstanceMethod("isConnected", &VideoAudioStreamerAddon::IsConnected),
        InstanceMethod("isBackpressure", &VideoAudioStreamerAddon::IsBackpressure)
    });

    constructor = Napi::Persistent(fn);
    constructor.SuppressDestruct();
    exports.Set("VideoAudioStreamer", fn);
    return exports;
}

/* ========================================================= */

VideoAudioStreamerAddon::VideoAudioStreamerAddon(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<VideoAudioStreamerAddon>(info),
      m_isRunning(false),
      m_shouldStop(false),
      m_width(0),
      m_height(0),
      m_fps(30),
      m_videoBitrate(5'000'000),
      m_audioBitrate(192'000),
      m_useNvenc(true),
      m_audioMode("both"),
      m_videoFrames(0),
      m_videoPackets(0),
      m_audioPackets(0),
      m_comInitialized(false)
{
}

/* ========================================================= */

VideoAudioStreamerAddon::~VideoAudioStreamerAddon() {
    m_shouldStop = true;
    m_isRunning = false;

    if (m_audioEngine)  m_audioEngine->Stop();
    if (m_audioCapture) m_audioCapture->Stop();

    if (m_captureThread.joinable()) m_captureThread.join();
    if (m_audioTickThread.joinable()) m_audioTickThread.join();
    if (m_networkThread.joinable()) m_networkThread.join();

    if (m_streamMuxer) m_streamMuxer->Flush();

    Cleanup();

    if (m_comInitialized) {
        CoUninitialize();
        m_comInitialized = false;
    }
}

/* ========================================================= */

Napi::Value VideoAudioStreamerAddon::Initialize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();

    m_rtmpUrl = info[0].As<Napi::String>().Utf8Value();
    if (info.Length() > 1) m_fps          = info[1].As<Napi::Number>().Uint32Value();
    if (info.Length() > 2) m_videoBitrate = info[2].As<Napi::Number>().Uint32Value();
    if (info.Length() > 3) m_useNvenc     = info[3].As<Napi::Boolean>().Value();
    if (info.Length() > 4) m_audioBitrate = info[4].As<Napi::Number>().Uint32Value();
    if (info.Length() > 5) m_audioMode    = info[5].As<Napi::String>().Utf8Value();

    HRESULT hr = CoInitializeEx(nullptr, COINIT_MULTITHREADED);
    if (hr == RPC_E_CHANGED_MODE) {
        CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        m_comInitialized = true;
    }

    m_desktop = std::make_unique<DesktopDuplication>();
    if (!m_desktop->Initialize())
        Napi::Error::New(env, "DesktopDuplication failed").ThrowAsJavaScriptException();

    m_desktop->GetDesktopDimensions(&m_width, &m_height);

    m_videoEncoder = std::make_unique<VideoEncoder>();
    if (!m_videoEncoder->Initialize(m_width, m_height, m_fps,
                                    m_videoBitrate, m_useNvenc, true))
        Napi::Error::New(env, "VideoEncoder failed").ThrowAsJavaScriptException();

    m_streamMuxer = std::make_unique<StreamMuxer>();
    m_buffer = std::make_unique<StreamBuffer>(100, 2000);
    m_streamMuxer->SetStreamBuffer(m_buffer.get());

    if (!m_streamMuxer->Initialize(m_rtmpUrl, m_videoEncoder.get(),
                                   48000, 2, m_audioBitrate))
        Napi::Error::New(env, "StreamMuxer failed").ThrowAsJavaScriptException();

    m_audioCapture = std::make_unique<AudioCapture>();
    m_audioCapture->Initialize(
        [this](const BYTE* d, UINT32 f, const char* s, WAVEFORMATEX* fmt) {
            OnAudioData(d, f, s, fmt);
        },
        m_audioMode.c_str()
    );

    m_audioEngine = std::make_unique<AudioEngine>();
    m_audioEncoder = std::make_unique<AudioEncoder>();
    m_audioEncoder->Initialize(48000, 2, m_audioBitrate);

    m_audioEngine->Initialize([this](const AudioPacket& p) {
        auto encoded = m_audioEncoder->EncodeFrames(
            reinterpret_cast<const float*>(p.data.data()),
            static_cast<uint32_t>(p.duration)
        );
        for (auto& pkt : encoded) {
            if (m_streamMuxer->WriteAudioPacket(pkt))
                m_audioPackets.fetch_add(1);
        }
    });

    return Napi::Boolean::New(env, true);
}

/* ========================================================= */

Napi::Value VideoAudioStreamerAddon::Start(const Napi::CallbackInfo& info) {
    if (m_isRunning) return Napi::Boolean::New(info.Env(), false);

    m_shouldStop = false;
    m_isRunning = true;

    m_audioCapture->Start();
    m_audioEngine->Start();

    // DEBUG: Test CaptureThread only
    m_captureThread  = std::thread(&VideoAudioStreamerAddon::CaptureThread, this);
    // m_audioTickThread = std::thread(&VideoAudioStreamerAddon::AudioTickThread, this);
    // m_networkThread  = std::thread(&VideoAudioStreamerAddon::NetworkSendThread, this);

    return Napi::Boolean::New(info.Env(), true);
}

Napi::Value VideoAudioStreamerAddon::Stop(const Napi::CallbackInfo& info) {
    m_shouldStop = true;
    m_isRunning = false;
    return Napi::Boolean::New(info.Env(), true);
}

/* ========================================================= */

void VideoAudioStreamerAddon::CaptureThread() {
    if (!m_desktop || !m_videoEncoder || !m_streamMuxer) {
        fprintf(stderr, "[CaptureThread] NULL component\n");
        return;
    }
    
    std::vector<uint8_t> frame(m_width * m_height * 4);
    
    // Frame pacing: only capture when it's time for the next frame
    // This matches OBS and VideoAudioRecorder approach
    auto startTime = std::chrono::high_resolution_clock::now();
    uint64_t frameNumber = 0;
    const int64_t frameIntervalNs = static_cast<int64_t>(1000000000.0 / m_fps);  // ns per frame @ m_fps

    while (!m_shouldStop) {
        auto currentTime = std::chrono::high_resolution_clock::now();
        auto elapsed = std::chrono::duration_cast<std::chrono::nanoseconds>(currentTime - startTime).count();
        int64_t expectedFrame = elapsed / frameIntervalNs;

        if (frameNumber < expectedFrame) {
            // Try to capture frame
            uint32_t w, h;
            int64_t ts;
            if (m_desktop->CaptureFrame(frame.data(), &w, &h, &ts)) {
                auto packets = m_videoEncoder->EncodeFrame(frame.data());
                for (auto& p : packets) {
                    if (m_streamMuxer->WriteVideoPacket(&p, frameNumber))
                        m_videoPackets.fetch_add(1);
                }
                m_videoFrames.fetch_add(1);
                frameNumber++;
            }
        } else {
            // Wait a bit to avoid busy waiting
            std::this_thread::sleep_for(std::chrono::milliseconds(1));
        }
    }
}

void VideoAudioStreamerAddon::AudioTickThread() {
    if (!m_audioEngine) {
        fprintf(stderr, "[AudioTickThread] NULL audioEngine\n");
        return;
    }
    
    while (!m_shouldStop && m_audioEngine->IsRunning()) {
        m_audioEngine->Tick();
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    }
}

void VideoAudioStreamerAddon::NetworkSendThread() {
    if (!m_streamMuxer) {
        fprintf(stderr, "[NetworkSendThread] NULL streamMuxer\n");
        return;
    }
    
    while (!m_shouldStop) {
        bool sent;
        do {
            sent = m_streamMuxer->SendNextBufferedPacket();
        } while (sent);
        std::this_thread::sleep_for(std::chrono::milliseconds(1));
    }
}

/* ========================================================= */

void VideoAudioStreamerAddon::OnAudioData(const BYTE* data,
                                         UINT32 frames,
                                         const char* src,
                                         WAVEFORMATEX*) {
    if (!m_audioEngine || !m_audioEngine->IsRunning()) return;
    m_audioEngine->FeedAudioData(
        reinterpret_cast<const float*>(data), frames, src);
}

/* ========================================================= */

Napi::Value VideoAudioStreamerAddon::IsRunning(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(), m_isRunning);
}

Napi::Value VideoAudioStreamerAddon::IsConnected(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(),
        m_streamMuxer && m_streamMuxer->IsConnected());
}

Napi::Value VideoAudioStreamerAddon::IsBackpressure(const Napi::CallbackInfo& info) {
    return Napi::Boolean::New(info.Env(),
        m_streamMuxer && m_streamMuxer->IsBackpressure());
}

Napi::Value VideoAudioStreamerAddon::GetCodecName(const Napi::CallbackInfo& info) {
    return Napi::String::New(info.Env(),
        m_videoEncoder ? m_videoEncoder->GetCodecName() : "none");
}

Napi::Value VideoAudioStreamerAddon::GetStatistics(const Napi::CallbackInfo& info) {
    Napi::Object o = Napi::Object::New(info.Env());
    o.Set("videoFrames", static_cast<uint32_t>(m_videoFrames.load()));
    o.Set("videoPackets", static_cast<uint32_t>(m_videoPackets.load()));
    o.Set("audioPackets", static_cast<uint32_t>(m_audioPackets.load()));
    return o;
}

/* ========================================================= */

void VideoAudioStreamerAddon::Cleanup() {
    m_desktop.reset();
    m_videoEncoder.reset();
    m_streamMuxer.reset();
    m_buffer.reset();
    m_audioCapture.reset();
    m_audioEngine.reset();
    m_audioEncoder.reset();
}

/* ========================================================= */

Napi::Object VideoAudioStreamerInit(Napi::Env env, Napi::Object exports) {
    VideoAudioStreamerAddon::Init(env, exports);
    return exports;
}

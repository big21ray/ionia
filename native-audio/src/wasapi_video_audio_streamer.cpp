#include <napi.h>

#include "desktop_duplication.h"
#include "video_encoder.h"
#include "stream_muxer.h"
#include "stream_buffer.h"
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
#include <chrono>
#include <vector>
#include <cstdint>
#include <cstdio>
#include <fstream>

#include "ionia_logging.h"

// This file contains a lot of thread/loop diagnostics.
// Route those through the debug logger so default runs are quiet.
#define IONIA_STREAMER_LOGF(...) Ionia::LogDebugf(__VA_ARGS__)

// This file historically called fflush() after extremely verbose logs (even inside tight loops).
// Once logs are gated, those fflush() calls become pure overhead, so disable them here.
#define fflush(...) ((void)0)

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
    Napi::Value InjectFrame(const Napi::CallbackInfo& info);  // For headless testing
    Napi::Value SetThreadConfig(const Napi::CallbackInfo& info);  // For testing threads

    // Threads
    void CaptureThread();
    void VideoTickThread();
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
    std::unique_ptr<VideoEngine>        m_videoEngine;
    std::unique_ptr<StreamMuxer>        m_streamMuxer;
    std::unique_ptr<StreamBuffer>       m_buffer;
    std::unique_ptr<AudioCapture>       m_audioCapture;
    std::unique_ptr<AudioEngine>        m_audioEngine;
    std::unique_ptr<AudioEncoder>       m_audioEncoder;

    // Threads
    std::thread m_captureThread;
    std::thread m_videoTickThread;
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
    
    // Audio diagnostics
    std::atomic<uint64_t> m_audioFramesReceived;  // Total audio frames received from capture
    std::atomic<uint64_t> m_audioFramesEncoded;   // Total audio frames encoded
    uint64_t m_lastAudioPacketCount = 0;          // For detecting gaps
    
    // Frame injection for headless testing
    std::mutex m_injectedFrameMutex;
    std::vector<uint8_t> m_injectedFrameBuffer;
    bool m_hasInjectedFrame = false;
    bool m_useInjectedFrames = false;
    
    // === THREAD CONTROL FLAGS (for debugging) ===
    bool m_enableCaptureThread = true;
    bool m_enableVideoTickThread = true;
    bool m_enableAudioTickThread = true;
    bool m_enableNetworkSendThread = true;  // NOW ENABLED
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
        InstanceMethod("isBackpressure", &VideoAudioStreamerAddon::IsBackpressure),
        InstanceMethod("injectFrame", &VideoAudioStreamerAddon::InjectFrame),
        InstanceMethod("setThreadConfig", &VideoAudioStreamerAddon::SetThreadConfig)
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
      m_audioFramesReceived(0),
      m_audioFramesEncoded(0),
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
    if (m_videoTickThread.joinable()) m_videoTickThread.join();
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
    if (!m_desktop->Initialize()) {
        IONIA_STREAMER_LOGF("[Initialize] DesktopDuplication failed\n");
        return Napi::Boolean::New(env, false);
    }

    m_desktop->GetDesktopDimensions(&m_width, &m_height);

    m_videoEncoder = std::make_unique<VideoEncoder>();
    if (!m_videoEncoder->Initialize(m_width, m_height, m_fps,
                                    m_videoBitrate, m_useNvenc, true)) {
        IONIA_STREAMER_LOGF("[Initialize] VideoEncoder failed\n");
        return Napi::Boolean::New(env, false);
    }

    m_videoEngine = std::make_unique<VideoEngine>();
    if (!m_videoEngine->Initialize(m_fps, m_videoEncoder.get())) {
        IONIA_STREAMER_LOGF("[Initialize] VideoEngine failed\n");
        return Napi::Boolean::New(env, false);
    }

    m_streamMuxer = std::make_unique<StreamMuxer>();
    m_buffer = std::make_unique<StreamBuffer>(100, 2000);
    m_streamMuxer->SetStreamBuffer(m_buffer.get());

    if (!m_streamMuxer->Initialize(m_rtmpUrl, m_videoEncoder.get(),
                                   AudioEngine::SAMPLE_RATE, AudioEngine::CHANNELS, m_audioBitrate)) {
        IONIA_STREAMER_LOGF("[Initialize] StreamMuxer failed\n");
        return Napi::Boolean::New(env, false);
    }

    m_audioCapture = std::make_unique<AudioCapture>();
    m_audioCapture->Initialize(
        [this](const BYTE* d, UINT32 f, const char* s, WAVEFORMATEX* fmt) {
            OnAudioData(d, f, s, fmt);
        },
        m_audioMode.c_str()
    );

    m_audioEngine = std::make_unique<AudioEngine>();
    m_audioEncoder = std::make_unique<AudioEncoder>();
    m_audioEncoder->Initialize(AudioEngine::SAMPLE_RATE, AudioEngine::CHANNELS, m_audioBitrate);

    // DIAGNOSTIC: Log audio sample rate chain (AFTER all components initialized)
    {
        AVStream* audioStream = m_streamMuxer->GetAudioStream();
        IONIA_STREAMER_LOGF("\n=== AUDIO SAMPLE RATE CHAIN ===\n");
        IONIA_STREAMER_LOGF("AudioEngine::SAMPLE_RATE = %d\n", AudioEngine::SAMPLE_RATE);
        IONIA_STREAMER_LOGF("AudioEngine::CHANNELS = %d\n", AudioEngine::CHANNELS);
        IONIA_STREAMER_LOGF("Stream time_base.num = %d\n", audioStream ? audioStream->time_base.num : -1);
        IONIA_STREAMER_LOGF(
            "Stream time_base.den = %d (CRITICAL: should equal sample rate 48000)\n",
            audioStream ? audioStream->time_base.den : -1);
        IONIA_STREAMER_LOGF("AudioEncoder sample_rate = %d\n", m_audioEncoder ? m_audioEncoder->GetSampleRate() : -1);
        IONIA_STREAMER_LOGF("================================\n\n");
    }

    // Initialize AudioEngine with callback that encodes audio
    m_audioEngine->Initialize([this](const AudioPacket& p) {
        const bool debug = Ionia::IsDebugLoggingEnabled();
        if (!m_audioEncoder || !m_streamMuxer || p.data.empty()) {
            IONIA_STREAMER_LOGF(
                "[AudioCallback] Null check failed: encoder=%p, muxer=%p, dataSize=%zu\n",
                m_audioEncoder.get(),
                m_streamMuxer.get(),
                p.data.size());
            return;
        }
        
        // Track received audio frames
        m_audioFramesReceived.fetch_add(p.duration);
        
        try {
            if (debug) {
                IONIA_STREAMER_LOGF(
                    "[AudioCallback] Encoding %llu frames (total received: %llu)...\n",
                    static_cast<uint64_t>(p.duration),
                    m_audioFramesReceived.load());
            }
            
            // CRITICAL VALIDATION: AAC LC requires exactly 1024 samples per frame
            // Variable frame sizes cause crackles, pitch shift, and jitter
            if (p.duration != 1024) {
                static std::atomic<bool> s_loggedBadFrameSize{false};
                if (!s_loggedBadFrameSize.exchange(true)) {
                    Ionia::LogErrorf(
                        "[AudioCallback] AUDIO FRAME SIZE ERROR: got %llu samples, expected 1024\n",
                        static_cast<uint64_t>(p.duration));
                    Ionia::LogErrorf("[AudioCallback] AAC encoder assumes fixed 1024-sample frames\n");
                }
                // Continue anyway (don't drop), but this explains crackling
            }
            
            auto encoded = m_audioEncoder->EncodeFrames(
                reinterpret_cast<const float*>(p.data.data()),
                static_cast<uint32_t>(p.duration)
            );
            
            // Track encoded frames
            m_audioFramesEncoded.fetch_add(p.duration);
            
                if (debug) {
                IONIA_STREAMER_LOGF(
                    "[AudioCallback] Got %zu encoded packets (total frames encoded: %llu)\n",
                    encoded.size(),
                    m_audioFramesEncoded.load());
                }
            
            // ============ DIAGNOSTIC 1: Record raw AAC to file ============
            static std::ofstream aac_debug_file;
            static bool aac_file_opened = false;
            if (debug && !aac_file_opened) {
                aac_debug_file.open(
                    "C:\\Users\\Karmine Corp\\Documents\\Ionia\\native-audio\\debug_audio.aac",
                    std::ios::binary);
                if (aac_debug_file.is_open()) {
                    IONIA_STREAMER_LOGF("[AudioCallback] AAC debug file opened for recording\n");
                    aac_file_opened = true;
                } else {
                    Ionia::LogErrorf("[AudioCallback] Failed to open AAC debug file\n");
                }
            }
            
            for (size_t i = 0; i < encoded.size(); i++) {
                try {
                    auto& pkt = encoded[i];
                    
            // ============ DIAGNOSTIC 2: Encoder output quality (timing) ============
                    static int packet_count = 0;
                    static int64_t last_packet_time_ns = 0;  // nanoseconds for higher precision
                    int64_t now_ns = std::chrono::duration_cast<std::chrono::nanoseconds>(
                        std::chrono::high_resolution_clock::now().time_since_epoch()
                    ).count();
                    int64_t delta_ms = (last_packet_time_ns > 0) ? (now_ns - last_packet_time_ns) / 1000000 : 0;
                    last_packet_time_ns = now_ns;
                    
                    if (debug && packet_count % 10 == 0) {
                        IONIA_STREAMER_LOGF(
                            "[AudioCallback] PKT#%d: size=%zu bytes, delta=%lldms (expect ~21ms)\n",
                            packet_count,
                            pkt.size(),
                            delta_ms);
                    }
                    packet_count++;
                    
                    // Write to AAC file with ADTS header (for VLC playability)
                    if (debug && aac_debug_file.is_open()) {
                        // ADTS header for AAC-LC, 48kHz, stereo
                        // Sync word (0xFFF), profile (0=LC), sample rate (3=48kHz), channels (2=stereo)
                        uint16_t frame_size = static_cast<uint16_t>(pkt.data.size() + 7);  // +7 for ADTS header
                        
                        // ADTS header (7 bytes):
                        uint8_t adts[7];
                        adts[0] = 0xFF;                          // Sync word high
                        adts[1] = 0xF1;                          // Sync word low + MPEG-4 + profile
                        adts[2] = (3 << 6) | (2 << 2) | 0;      // Sample rate (3=48kHz) + channels (2) + orig
                        adts[3] = (frame_size >> 11) & 0x03;    // Frame size high
                        adts[4] = (frame_size >> 3) & 0xFF;     // Frame size mid
                        adts[5] = ((frame_size << 5) & 0xE0) | 0; // Frame size low + RDB 5 bits
                        adts[6] = 0;                             // RDB 11 bits (all zeros for no raw data block)
                        
                        aac_debug_file.write(reinterpret_cast<const char*>(adts), 7);
                        aac_debug_file.write(reinterpret_cast<const char*>(pkt.data.data()), pkt.data.size());
                        aac_debug_file.flush();
                    }

                    if (debug) {
                        IONIA_STREAMER_LOGF(
                            "[AudioCallback] Writing packet %zu/%zu\n",
                            i,
                            encoded.size());
                    }
                    
                    if (!m_streamMuxer) {
                        Ionia::LogErrorf("[AudioCallback] Packet %zu: muxer is NULL\n", i);
                        break;
                    }
                    
                    bool written = m_streamMuxer->WriteAudioPacket(pkt);
                    
                    // ============ DIAGNOSTIC 3: Packet write failures (network drops) ============
                    if (debug) {
                        if (!written) {
                            IONIA_STREAMER_LOGF("[AudioCallback] PACKET DROP: Packet %zu NOT written\n", i);
                        } else {
                            IONIA_STREAMER_LOGF("[AudioCallback] Packet %zu write success\n", i);
                        }
                    }
                    
                    if (written) {
                        uint64_t newCount = m_audioPackets.fetch_add(1) + 1;
                        if (debug) {
                            IONIA_STREAMER_LOGF("[AudioCallback] Audio packets now: %llu\n", newCount);
                        }
                        
                        // Detect gaps in audio packets (packets not being written)
                        if (newCount % 50 == 0) {
                            uint64_t expectedPackets = m_audioFramesEncoded.load() / 256;  // Rough estimate
                            if (newCount < expectedPackets / 2) {
                                IONIA_STREAMER_LOGF(
                                    "[AudioCallback] WARNING: Audio packet gap detected! Expected ~%llu, got %llu\n",
                                    expectedPackets,
                                    newCount);
                            }
                        }
                    } else {
                        if (debug) {
                            IONIA_STREAMER_LOGF("[AudioCallback] Packet %zu NOT written (buffer full?)\n", i);
                        }
                    }
                } catch (const std::exception& e) {
                    Ionia::LogErrorf("[AudioCallback] Packet %zu exception: %s\n", i, e.what());
                } catch (const _com_error& e) {
                    Ionia::LogErrorf(
                        "[AudioCallback] Packet %zu COM error: 0x%08lx - %s\n",
                        i,
                        e.Error(),
                        e.ErrorMessage());
                } catch (...) {
                    Ionia::LogErrorf("[AudioCallback] Packet %zu unknown exception\n", i);
                }
            }
        } catch (const std::exception& e) {
            Ionia::LogErrorf("[AudioCallback] Encode exception: %s\n", e.what());
        } catch (...) {
            Ionia::LogErrorf("[AudioCallback] Encode unknown exception\n");
        }
    });

    return Napi::Boolean::New(env, true);
}

/* ========================================================= */

Napi::Value VideoAudioStreamerAddon::Start(const Napi::CallbackInfo& info) {
    IONIA_STREAMER_LOGF("[Start] BEGIN\n");
    if (m_isRunning) {
        IONIA_STREAMER_LOGF("[Start] Already running, returning false\n");
        return Napi::Boolean::New(info.Env(), false);
    }

    IONIA_STREAMER_LOGF("[Start] Setting flags\n");
    m_shouldStop = false;
    m_isRunning = true;

    IONIA_STREAMER_LOGF("[Start] Starting audio capture\n");
    m_audioCapture->Start();
    
    IONIA_STREAMER_LOGF("[Start] Starting audio engine\n");
    m_audioEngine->Start();
    
    IONIA_STREAMER_LOGF("[Start] Starting video engine\n");
    m_videoEngine->Start();

    IONIA_STREAMER_LOGF("[Start] Spawning capture thread\n");
    if (m_enableCaptureThread) {
        m_captureThread = std::thread(&VideoAudioStreamerAddon::CaptureThread, this);
        IONIA_STREAMER_LOGF("[Start] CaptureThread spawned\n");
    } else {
        IONIA_STREAMER_LOGF("[Start] CaptureThread DISABLED\n");
    }
    
    IONIA_STREAMER_LOGF("[Start] Spawning video tick thread\n");
    if (m_enableVideoTickThread) {
        m_videoTickThread = std::thread(&VideoAudioStreamerAddon::VideoTickThread, this);
        IONIA_STREAMER_LOGF("[Start] VideoTickThread spawned\n");
    } else {
        IONIA_STREAMER_LOGF("[Start] VideoTickThread DISABLED\n");
    }
    
    IONIA_STREAMER_LOGF("[Start] Spawning audio tick thread\n");
    if (m_enableAudioTickThread) {
        m_audioTickThread = std::thread(&VideoAudioStreamerAddon::AudioTickThread, this);
        IONIA_STREAMER_LOGF("[Start] AudioTickThread spawned\n");
    } else {
        IONIA_STREAMER_LOGF("[Start] AudioTickThread DISABLED\n");
    }
    
    IONIA_STREAMER_LOGF("[Start] Spawning network send thread\n");
    if (m_enableNetworkSendThread) {
        m_networkThread = std::thread(&VideoAudioStreamerAddon::NetworkSendThread, this);
        IONIA_STREAMER_LOGF("[Start] NetworkSendThread spawned\n");
    } else {
        IONIA_STREAMER_LOGF("[Start] NetworkSendThread DISABLED\n");
    }
    
    IONIA_STREAMER_LOGF("[Start] ALL THREADS SPAWNED SUCCESSFULLY\n");
    return Napi::Boolean::New(info.Env(), true);
}

Napi::Value VideoAudioStreamerAddon::Stop(const Napi::CallbackInfo& info) {
    m_shouldStop = true;
    m_isRunning = false;
    
    if (m_videoEngine) m_videoEngine->Stop();
    
    if (m_captureThread.joinable()) m_captureThread.join();
    if (m_videoTickThread.joinable()) m_videoTickThread.join();
    if (m_audioTickThread.joinable()) m_audioTickThread.join();
    if (m_networkThread.joinable()) m_networkThread.join();
    
    return Napi::Boolean::New(info.Env(), true);
}

/* ========================================================= */

void VideoAudioStreamerAddon::CaptureThread() {
    IONIA_STREAMER_LOGF("[CaptureThread] === STARTED === (shouldStop=%d)\n", m_shouldStop.load());
    
    try {
        IONIA_STREAMER_LOGF("[CaptureThread] Checking components\n");
        if (!m_videoEncoder || !m_videoEngine) {
            Ionia::LogErrorf(
                "[CaptureThread] NULL component: encoder=%p, engine=%p\n",
                m_videoEncoder.get(),
                m_videoEngine.get());
            return;
        }
        
        bool useRealCapture = m_desktop && !m_useInjectedFrames;
        IONIA_STREAMER_LOGF(
            "[CaptureThread] useRealCapture=%d, desktop=%p, useInjected=%d\n",
            useRealCapture,
            m_desktop.get(),
            m_useInjectedFrames);
        
        if (useRealCapture && !m_desktop) {
            Ionia::LogErrorf("[CaptureThread] DesktopDuplication not initialized\n");
            return;
        }
        
        std::vector<uint8_t> frame(m_width * m_height * 4);
        IONIA_STREAMER_LOGF(
            "[CaptureThread] Allocated frame buffer: %ux%u = %zu bytes\n",
            m_width,
            m_height,
            frame.size());

        int loopCount = 0;
        while (!m_shouldStop) {
            loopCount++;
            try {
                IONIA_STREAMER_LOGF("[CaptureThread] Loop %d: START\n", loopCount);
                
                bool frameReady = false;
                
                if (m_useInjectedFrames) {
                    IONIA_STREAMER_LOGF(
                        "[CaptureThread] Loop %d: Trying injected frame mode\n",
                        loopCount);
                    try {
                        {
                            std::lock_guard<std::mutex> lock(m_injectedFrameMutex);
                            IONIA_STREAMER_LOGF(
                                "[CaptureThread] Loop %d: Acquired injected frame lock\n",
                                loopCount);
                            if (m_hasInjectedFrame) {
                                IONIA_STREAMER_LOGF(
                                    "[CaptureThread] Loop %d: Copying injected frame\n",
                                    loopCount);
                                std::copy(m_injectedFrameBuffer.begin(), m_injectedFrameBuffer.end(), frame.begin());
                                IONIA_STREAMER_LOGF(
                                    "[CaptureThread] Loop %d: Copy complete\n",
                                    loopCount);
                                m_hasInjectedFrame = false;
                                frameReady = true;
                            }
                        }
                        IONIA_STREAMER_LOGF(
                            "[CaptureThread] Loop %d: Released injected frame lock\n",
                            loopCount);
                    } catch (const std::exception& e) {
                        Ionia::LogErrorf(
                            "[CaptureThread] Loop %d: INJECTED FRAME EXCEPTION: %s\n",
                            loopCount,
                            e.what());
                        break;
                    } catch (...) {
                        Ionia::LogErrorf(
                            "[CaptureThread] Loop %d: INJECTED FRAME UNKNOWN EXCEPTION\n",
                            loopCount);
                        break;
                    }
                } else if (useRealCapture) {
                    IONIA_STREAMER_LOGF(
                        "[CaptureThread] Loop %d: Trying real desktop capture\n",
                        loopCount);
                    try {
                        IONIA_STREAMER_LOGF(
                            "[CaptureThread] Loop %d: Calling m_desktop->CaptureFrame()\n",
                            loopCount);
                        uint32_t w, h;
                        int64_t ts;
                        if (m_desktop->CaptureFrame(frame.data(), &w, &h, &ts)) {
                            IONIA_STREAMER_LOGF(
                                "[CaptureThread] Loop %d: CaptureFrame returned true\n",
                                loopCount);
                            frameReady = true;
                        } else {
                            IONIA_STREAMER_LOGF(
                                "[CaptureThread] Loop %d: CaptureFrame returned false\n",
                                loopCount);
                        }
                    } catch (const std::exception& e) {
                        Ionia::LogErrorf(
                            "[CaptureThread] Loop %d: DESKTOP CAPTURE EXCEPTION: %s\n",
                            loopCount,
                            e.what());
                        break;
                    } catch (...) {
                        Ionia::LogErrorf(
                            "[CaptureThread] Loop %d: DESKTOP CAPTURE UNKNOWN EXCEPTION\n",
                            loopCount);
                        break;
                    }
                }
                
                IONIA_STREAMER_LOGF(
                    "[CaptureThread] Loop %d: frameReady=%d\n",
                    loopCount,
                    frameReady ? 1 : 0);
                
                if (frameReady) {
                    IONIA_STREAMER_LOGF(
                        "[CaptureThread] Loop %d: Calling m_videoEngine->PushFrame()\n",
                        loopCount);
                    try {
                        m_videoEngine->PushFrame(frame.data());
                        IONIA_STREAMER_LOGF(
                            "[CaptureThread] Loop %d: PushFrame() succeeded\n",
                            loopCount);
                    } catch (const std::exception& e) {
                        Ionia::LogErrorf(
                            "[CaptureThread] Loop %d: PUSHFRAME EXCEPTION: %s\n",
                            loopCount,
                            e.what());
                        break;
                    } catch (...) {
                        Ionia::LogErrorf(
                            "[CaptureThread] Loop %d: PUSHFRAME UNKNOWN EXCEPTION\n",
                            loopCount);
                        break;
                    }
                    
                    IONIA_STREAMER_LOGF(
                        "[CaptureThread] Loop %d: Incrementing video frame count\n",
                        loopCount);
                    m_videoFrames.fetch_add(1);
                    IONIA_STREAMER_LOGF(
                        "[CaptureThread] Loop %d: Video frame count updated to %llu\n",
                        loopCount,
                        m_videoFrames.load());
                    
                    if (loopCount % 10 == 0) {
                        IONIA_STREAMER_LOGF(
                            "[CaptureThread] Loop %d: Pushed frame to engine (total=%llu)\n",
                            loopCount,
                            m_videoFrames.load());
                    }
                } else {
                    if (loopCount % 100 == 0) {
                        IONIA_STREAMER_LOGF(
                            "[CaptureThread] Loop %d: No frame ready, sleeping 1ms\n",
                            loopCount);
                    }
                    IONIA_STREAMER_LOGF("[CaptureThread] Loop %d: Sleeping\n", loopCount);
                    std::this_thread::sleep_for(std::chrono::milliseconds(1));
                    IONIA_STREAMER_LOGF(
                        "[CaptureThread] Loop %d: Wake from sleep\n",
                        loopCount);
                }
                IONIA_STREAMER_LOGF("[CaptureThread] Loop %d: END\n", loopCount);
            } catch (const std::exception& e) {
                Ionia::LogErrorf(
                    "[CaptureThread] Loop %d: INNER EXCEPTION: %s\n",
                    loopCount,
                    e.what());
                break;
            } catch (...) {
                Ionia::LogErrorf(
                    "[CaptureThread] Loop %d: INNER UNKNOWN EXCEPTION\n",
                    loopCount);
                break;
            }
        }
        IONIA_STREAMER_LOGF(
            "[CaptureThread] Exited loop after %d iterations (shouldStop=%d)\n",
            loopCount,
            m_shouldStop.load());
    } catch (const std::exception& e) {
        Ionia::LogErrorf("[CaptureThread] OUTER EXCEPTION: %s\n", e.what());
    } catch (...) {
        Ionia::LogErrorf("[CaptureThread] OUTER UNKNOWN EXCEPTION\n");
    }
    IONIA_STREAMER_LOGF(
        "[CaptureThread] === FINISHED === (shouldStop=%d, isRunning=%d)\n",
        m_shouldStop.load(),
        m_isRunning.load());
}

void VideoAudioStreamerAddon::VideoTickThread() {
    IONIA_STREAMER_LOGF("[VideoTickThread] === STARTED === (shouldStop=%d)\n", m_shouldStop.load());
    
    try {
        IONIA_STREAMER_LOGF("[VideoTickThread] Checking components\n");
        if (!m_videoEngine || !m_videoEncoder || !m_streamMuxer) {
            Ionia::LogErrorf(
                "[VideoTickThread] NULL component: engine=%p, encoder=%p, muxer=%p\n",
                m_videoEngine.get(),
                m_videoEncoder.get(),
                m_streamMuxer.get());
            return;
        }

        std::vector<uint8_t> frame(m_width * m_height * 4);
        IONIA_STREAMER_LOGF(
            "[VideoTickThread] Allocated frame buffer: %ux%u = %zu bytes\n",
            m_width,
            m_height,
            frame.size());
        
        int loopCount = 0;
        while (!m_shouldStop) {
            loopCount++;
            try {
                IONIA_STREAMER_LOGF("[VideoTickThread] Loop %d: START\n", loopCount);
                
                // Get the frame number that should be encoded at this time
                IONIA_STREAMER_LOGF(
                    "[VideoTickThread] Loop %d: Calling GetExpectedFrameNumber()\n",
                    loopCount);
                uint64_t expectedFrame = m_videoEngine->GetExpectedFrameNumber();
                IONIA_STREAMER_LOGF(
                    "[VideoTickThread] Loop %d: GetExpectedFrameNumber returned %llu\n",
                    loopCount,
                    expectedFrame);
                
                IONIA_STREAMER_LOGF(
                    "[VideoTickThread] Loop %d: Calling GetFrameNumber()\n",
                    loopCount);
                uint64_t currentFrame = m_videoEngine->GetFrameNumber();
                IONIA_STREAMER_LOGF(
                    "[VideoTickThread] Loop %d: GetFrameNumber returned %llu\n",
                    loopCount,
                    currentFrame);

                if (loopCount % 20 == 0) {
                    IONIA_STREAMER_LOGF(
                        "[VideoTickThread] Loop %d: expected=%llu, current=%llu\n",
                        loopCount,
                        expectedFrame,
                        currentFrame);
                }

                if (currentFrame < expectedFrame) {
                    // Time to encode another frame
                    IONIA_STREAMER_LOGF(
                        "[VideoTickThread] Loop %d: Time to encode, calling PopFrameFromBuffer()\n",
                        loopCount);
                    
                    bool hasFrame = false;
                    try {
                        hasFrame = m_videoEngine->PopFrameFromBuffer(frame);
                        IONIA_STREAMER_LOGF(
                            "[VideoTickThread] Loop %d: PopFrameFromBuffer returned %d\n",
                            loopCount,
                            hasFrame ? 1 : 0);
                    } catch (const std::exception& e) {
                        Ionia::LogErrorf(
                            "[VideoTickThread] Loop %d: POPFRAME EXCEPTION: %s\n",
                            loopCount,
                            e.what());
                        hasFrame = false;
                    } catch (...) {
                        Ionia::LogErrorf(
                            "[VideoTickThread] Loop %d: POPFRAME UNKNOWN EXCEPTION\n",
                            loopCount);
                        hasFrame = false;
                    }
                    
                    // ✅ OBS-LIKE FRAME DUPLICATION: If no frame in buffer, use last frame
                    if (!hasFrame) {
                        IONIA_STREAMER_LOGF(
                            "[VideoTickThread] Loop %d: No frame in buffer, trying to use last frame\n",
                            loopCount);
                        try {
                            if (m_videoEngine->GetLastFrame(frame)) {
                                IONIA_STREAMER_LOGF(
                                    "[VideoTickThread] Loop %d: Using duplicated last frame\n",
                                    loopCount);
                                hasFrame = true;
                            } else {
                                IONIA_STREAMER_LOGF(
                                    "[VideoTickThread] Loop %d: No last frame available, creating black frame\n",
                                    loopCount);
                                // Fill with black (0x00)
                                std::fill(frame.begin(), frame.end(), 0);
                                hasFrame = true;
                            }
                        } catch (const std::exception& e) {
                            Ionia::LogErrorf(
                                "[VideoTickThread] Loop %d: GETLASTFRAME EXCEPTION: %s\n",
                                loopCount,
                                e.what());
                            // Still try to encode black frame
                            std::fill(frame.begin(), frame.end(), 0);
                            hasFrame = true;
                        } catch (...) {
                            Ionia::LogErrorf(
                                "[VideoTickThread] Loop %d: GETLASTFRAME UNKNOWN EXCEPTION\n",
                                loopCount);
                            std::fill(frame.begin(), frame.end(), 0);
                            hasFrame = true;
                        }
                    }
                    
                    if (hasFrame) {
                        IONIA_STREAMER_LOGF(
                            "[VideoTickThread] Loop %d: Frame ready, calling EncodeFrame()\n",
                            loopCount);
                        
                        // Frame data available (real or duplicated), encode it
                        try {
                            auto packets = m_videoEncoder->EncodeFrame(frame.data());
                            IONIA_STREAMER_LOGF(
                                "[VideoTickThread] Loop %d: EncodeFrame returned %zu packets\n",
                                loopCount,
                                packets.size());
                            
                            for (size_t i = 0; i < packets.size(); i++) {
                                IONIA_STREAMER_LOGF(
                                    "[VideoTickThread] Loop %d: Writing packet %zu of %zu\n",
                                    loopCount,
                                    i,
                                    packets.size());
                                
                                try {
                                    // Check muxer validity before writing
                                    if (!m_streamMuxer) {
                                        Ionia::LogErrorf(
                                            "[VideoTickThread] Loop %d: muxer is NULL, skipping write\n",
                                            loopCount);
                                        break;
                                    }
                                    
                                    auto& p = packets[i];
                                    IONIA_STREAMER_LOGF(
                                        "[VideoTickThread] Loop %d: Packet size=%zu, keyframe=%d\n",
                                        loopCount,
                                        p.data.size(),
                                        p.isKeyframe ? 1 : 0);
                                    
                                    IONIA_STREAMER_LOGF(
                                        "[VideoTickThread] Loop %d: Muxer state: connected=%d, backpressure=%d\n",
                                        loopCount,
                                        m_streamMuxer->IsConnected(),
                                        m_streamMuxer->IsBackpressure());
                                    
                                    IONIA_STREAMER_LOGF(
                                        "[VideoTickThread] Loop %d: Calling WriteVideoPacket[%zu] with muxer=%p\n",
                                        loopCount,
                                        i,
                                        m_streamMuxer.get());
                                    
                                    bool written = m_streamMuxer->WriteVideoPacket(&p, currentFrame);
                                    IONIA_STREAMER_LOGF(
                                        "[VideoTickThread] Loop %d: WriteVideoPacket[%zu] returned=%s\n",
                                        loopCount,
                                        i,
                                        written ? "true" : "false");
                                    
                                    if (written) {
                                        IONIA_STREAMER_LOGF(
                                            "[VideoTickThread] Loop %d: Incrementing video packet count\n",
                                            loopCount);
                                        m_videoPackets.fetch_add(1);
                                        IONIA_STREAMER_LOGF(
                                            "[VideoTickThread] Loop %d: Video packet count now %llu\n",
                                            loopCount,
                                            m_videoPackets.load());
                                    } else {
                                        IONIA_STREAMER_LOGF(
                                            "[VideoTickThread] Loop %d: WriteVideoPacket returned false (backpressure or buffer full?)\n",
                                            loopCount);
                                    }
                                } catch (const std::exception& e) {
                                    Ionia::LogErrorf(
                                        "[VideoTickThread] Loop %d: WRITEPACKET[%zu] STD::EXCEPTION: %s\n",
                                        loopCount,
                                        i,
                                        e.what());
                                    // Don't break - try next packet
                                } catch (const _com_error& e) {
                                    Ionia::LogErrorf(
                                        "[VideoTickThread] Loop %d: WRITEPACKET[%zu] COM_ERROR: 0x%08lx - %s\n",
                                        loopCount,
                                        i,
                                        e.Error(),
                                        e.ErrorMessage());
                                    // Don't break - try next packet
                                } catch (...) {
                                    Ionia::LogErrorf(
                                        "[VideoTickThread] Loop %d: WRITEPACKET[%zu] UNKNOWN EXCEPTION (possibly COM)\n",
                                        loopCount,
                                        i);
                                    // Don't break - try next packet
                                }
                            }
                        } catch (const std::exception& e) {
                            Ionia::LogErrorf(
                                "[VideoTickThread] Loop %d: ENCODE EXCEPTION: %s\n",
                                loopCount,
                                e.what());
                            break;
                        } catch (...) {
                            Ionia::LogErrorf(
                                "[VideoTickThread] Loop %d: ENCODE UNKNOWN EXCEPTION\n",
                                loopCount);
                            break;
                        }
                    }
                    
                    // ✅ CRITICAL FIX: Always advance frame number, regardless of frame availability
                    IONIA_STREAMER_LOGF(
                        "[VideoTickThread] Loop %d: Calling AdvanceFrameNumber()\n",
                        loopCount);
                    try {
                        m_videoEngine->AdvanceFrameNumber();
                        IONIA_STREAMER_LOGF(
                            "[VideoTickThread] Loop %d: AdvanceFrameNumber() succeeded (now at %llu)\n",
                            loopCount,
                            m_videoEngine->GetFrameNumber());
                    } catch (const std::exception& e) {
                        Ionia::LogErrorf(
                            "[VideoTickThread] Loop %d: ADVANCEFRAME EXCEPTION: %s\n",
                            loopCount,
                            e.what());
                        break;
                    } catch (...) {
                        Ionia::LogErrorf(
                            "[VideoTickThread] Loop %d: ADVANCEFRAME UNKNOWN EXCEPTION\n",
                            loopCount);
                        break;
                    }
                } else {
                    // No frame time yet, wait a bit
                    if (loopCount % 50 == 0) {
                        IONIA_STREAMER_LOGF(
                            "[VideoTickThread] Loop %d: No frame time yet, sleeping 5ms\n",
                            loopCount);
                    }
                    IONIA_STREAMER_LOGF("[VideoTickThread] Loop %d: Sleeping\n", loopCount);
                    std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    IONIA_STREAMER_LOGF(
                        "[VideoTickThread] Loop %d: Wake from sleep\n",
                        loopCount);
                }
                IONIA_STREAMER_LOGF("[VideoTickThread] Loop %d: END\n", loopCount);
            } catch (const std::exception& e) {
                Ionia::LogErrorf(
                    "[VideoTickThread] Loop %d: EXCEPTION: %s\n",
                    loopCount,
                    e.what());
                break;
            } catch (...) {
                Ionia::LogErrorf(
                    "[VideoTickThread] Loop %d: UNKNOWN EXCEPTION\n",
                    loopCount);
                break;
            }
        }
        IONIA_STREAMER_LOGF(
            "[VideoTickThread] Exited loop after %d iterations (shouldStop=%d)\n",
            loopCount,
            m_shouldStop.load());
    } catch (const std::exception& e) {
        Ionia::LogErrorf("[VideoTickThread] OUTER EXCEPTION: %s\n", e.what());
    } catch (...) {
        Ionia::LogErrorf("[VideoTickThread] OUTER UNKNOWN EXCEPTION\n");
    }
    IONIA_STREAMER_LOGF(
        "[VideoTickThread] === FINISHED === (shouldStop=%d, videoPackets=%llu)\n",
        m_shouldStop.load(),
        m_videoPackets.load());
}

void VideoAudioStreamerAddon::AudioTickThread() {
    IONIA_STREAMER_LOGF("[AudioTickThread] === STARTED === (shouldStop=%d)\n", m_shouldStop.load());
    
    try {
        IONIA_STREAMER_LOGF("[AudioTickThread] Checking components\n");
        if (!m_audioEngine) {
            Ionia::LogErrorf(
                "[AudioTickThread] NULL component: audioEngine=%p\n",
                m_audioEngine.get());
            return;
        }

        int tickCount = 0;

        // Drive AAC frame cadence from a monotonic clock.
        // On Windows, sleep granularity can be ~15.6ms unless timer resolution is raised,
        // so a fixed sleep_for(21333us) can under-produce audio frames and cause
        // perceived "accelerated" playback (time-compression / skipped audio).
        using Clock = std::chrono::steady_clock;
        const int64_t sampleRate = static_cast<int64_t>(AudioEngine::SAMPLE_RATE);
        const int64_t aacFrameSize = 1024; // AAC-LC frame size
        const int64_t frameDurationUs = (aacFrameSize * 1000000LL + sampleRate / 2) / sampleRate; // rounded

        auto nextTickTime = Clock::now();
        while (!m_shouldStop) {
            tickCount++;
            try {
                IONIA_STREAMER_LOGF("[AudioTickThread] Loop %d: START\n", tickCount);
                
                IONIA_STREAMER_LOGF(
                    "[AudioTickThread] Loop %d: Checking m_audioEngine pointer\n",
                    tickCount);
                
                if (!m_audioEngine) {
                    Ionia::LogErrorf(
                        "[AudioTickThread] Loop %d: audioEngine became NULL mid-loop\n",
                        tickCount);
                    break;
                }
                IONIA_STREAMER_LOGF(
                    "[AudioTickThread] Loop %d: m_audioEngine pointer is valid (%p)\n",
                    tickCount,
                    m_audioEngine.get());
                
                IONIA_STREAMER_LOGF(
                    "[AudioTickThread] Loop %d: Calling IsRunning()\n",
                    tickCount);
                bool isRunning = false;
                try {
                    isRunning = m_audioEngine->IsRunning();
                    IONIA_STREAMER_LOGF(
                        "[AudioTickThread] Loop %d: IsRunning() returned %d\n",
                        tickCount,
                        isRunning ? 1 : 0);
                } catch (const std::exception& e) {
                    Ionia::LogErrorf(
                        "[AudioTickThread] Loop %d: ISRUNNING EXCEPTION: %s\n",
                        tickCount,
                        e.what());
                    break;
                } catch (...) {
                    Ionia::LogErrorf(
                        "[AudioTickThread] Loop %d: ISRUNNING UNKNOWN EXCEPTION\n",
                        tickCount);
                    break;
                }
                
                if (!isRunning) {
                    IONIA_STREAMER_LOGF(
                        "[AudioTickThread] Loop %d: AudioEngine not running, exiting loop\n",
                        tickCount);
                    break;
                }
                
                if (tickCount % 50 == 0) {
                    IONIA_STREAMER_LOGF(
                        "[AudioTickThread] Loop %d: Audio ticks=%d, packets=%llu\n",
                        tickCount,
                        tickCount,
                        m_audioPackets.load());
                }
                
                // Schedule next tick based on monotonic time (better than fixed sleeps).
                // If we're behind, catch up by emitting multiple frames (AudioEngine will
                // pad with silence as needed), rather than compressing time.
                const auto now = Clock::now();
                if (now < nextTickTime) {
                    std::this_thread::sleep_until(nextTickTime);
                }

                // Catch-up loop (caps burst work to keep CPU sane)
                int catchUps = 0;
                while (Clock::now() >= nextTickTime && catchUps < 5 && !m_shouldStop) {
                    try {
                        m_audioEngine->Tick();
                    } catch (const std::exception& e) {
                        Ionia::LogErrorf(
                            "[AudioTickThread] Loop %d: TICK EXCEPTION: %s\n",
                            tickCount,
                            e.what());
                        m_shouldStop = true;
                        break;
                    } catch (...) {
                        Ionia::LogErrorf(
                            "[AudioTickThread] Loop %d: TICK UNKNOWN EXCEPTION\n",
                            tickCount);
                        m_shouldStop = true;
                        break;
                    }
                    nextTickTime += std::chrono::microseconds(frameDurationUs);
                    catchUps++;
                }
                
                IONIA_STREAMER_LOGF("[AudioTickThread] Loop %d: END\n", tickCount);
            } catch (const std::exception& e) {
                Ionia::LogErrorf(
                    "[AudioTickThread] Loop %d: EXCEPTION: %s\n",
                    tickCount,
                    e.what());
                break;
            } catch (...) {
                Ionia::LogErrorf(
                    "[AudioTickThread] Loop %d: UNKNOWN EXCEPTION (likely COM/Windows exception)\n",
                    tickCount);
                Ionia::LogErrorf(
                    "[AudioTickThread] Loop %d: m_audioEngine ptr=%p, shouldStop=%d\n",
                    tickCount,
                    m_audioEngine.get(),
                    m_shouldStop.load());
                break;
            }
        }
        IONIA_STREAMER_LOGF(
            "[AudioTickThread] Exited loop after %d ticks (shouldStop=%d)\n",
            tickCount,
            m_shouldStop.load());
    } catch (const std::exception& e) {
        Ionia::LogErrorf("[AudioTickThread] OUTER EXCEPTION: %s\n", e.what());
    } catch (...) {
        Ionia::LogErrorf("[AudioTickThread] OUTER UNKNOWN EXCEPTION\n");
    }
    IONIA_STREAMER_LOGF(
        "[AudioTickThread] === FINISHED === (shouldStop=%d, audioPackets=%llu)\n",
        m_shouldStop.load(),
        m_audioPackets.load());
}

void VideoAudioStreamerAddon::NetworkSendThread() {
    IONIA_STREAMER_LOGF("[NetworkSendThread] === STARTED ===\n");
    
    if (!m_streamMuxer) {
        Ionia::LogErrorf("[NetworkSendThread] FATAL: NULL streamMuxer\n");
        return;
    }
    
    IONIA_STREAMER_LOGF("[NetworkSendThread] Checking muxer state...\n");
    IONIA_STREAMER_LOGF(
        "[NetworkSendThread] IsConnected=%d, IsBackpressure=%d\n",
        m_streamMuxer->IsConnected(),
        m_streamMuxer->IsBackpressure());
    
    int sendAttempts = 0;
    int successCount = 0;
    int failureCount = 0;
    int loopCount = 0;
    
    while (!m_shouldStop) {
        loopCount++;
        try {
            // Check muxer state periodically
            if (loopCount % 1000 == 0) {
                IONIA_STREAMER_LOGF(
                    "[NetworkSendThread] Loop %d: Connected=%d, Backpressure=%d, Attempts=%d, Success=%d, Failed=%d\n",
                    loopCount,
                    m_streamMuxer->IsConnected(),
                    m_streamMuxer->IsBackpressure(),
                    sendAttempts,
                    successCount,
                    failureCount);
            }
            
            // Try to send packet
            try {
                if (!m_streamMuxer) {
                    Ionia::LogErrorf(
                        "[NetworkSendThread] Loop %d: muxer became NULL\n",
                        loopCount);
                    break;
                }
                
                bool sent = m_streamMuxer->SendNextBufferedPacket();
                sendAttempts++;
                
                if (sent) {
                    successCount++;
                    if (successCount % 50 == 0) {
                        IONIA_STREAMER_LOGF(
                            "[NetworkSendThread] Sent %d packets successfully\n",
                            successCount);
                    }
                } else {
                    // No packet available, sleep briefly
                    std::this_thread::sleep_for(std::chrono::milliseconds(1));
                }
            } catch (const std::exception& e) {
                failureCount++;
                if (failureCount % 100 == 0) {
                    Ionia::LogErrorf(
                        "[NetworkSendThread] SendNextBufferedPacket exception (count=%d): %s\n",
                        failureCount,
                        e.what());
                }
            } catch (const _com_error& e) {
                failureCount++;
                if (failureCount % 100 == 0) {
                    Ionia::LogErrorf(
                        "[NetworkSendThread] SendNextBufferedPacket COM error (count=%d): 0x%08lx - %s\n",
                        failureCount,
                        e.Error(),
                        e.ErrorMessage());
                }
            } catch (...) {
                failureCount++;
                if (failureCount % 100 == 0) {
                    Ionia::LogErrorf(
                        "[NetworkSendThread] SendNextBufferedPacket unknown exception (count=%d)\n",
                        failureCount);
                }
            }
        } catch (const std::exception& e) {
            Ionia::LogErrorf(
                "[NetworkSendThread] Loop %d OUTER STD::EXCEPTION: %s\n",
                loopCount,
                e.what());
            // Continue on exception, don't break
        } catch (const _com_error& e) {
            Ionia::LogErrorf(
                "[NetworkSendThread] Loop %d OUTER COM_ERROR: 0x%08lx - %s\n",
                loopCount,
                e.Error(),
                e.ErrorMessage());
            // Continue on exception, don't break
        } catch (...) {
            // Silently continue on unknown exception - likely thread/COM cleanup
            if (loopCount % 1000 == 0) {
                IONIA_STREAMER_LOGF(
                    "[NetworkSendThread] Loop %d OUTER UNKNOWN EXCEPTION (continuing...)\n",
                    loopCount);
            }
        }
    }
    
    IONIA_STREAMER_LOGF(
        "[NetworkSendThread] === EXITING === (Loops=%d, Attempts=%d, Success=%d, Failed=%d)\n",
        loopCount,
        sendAttempts,
        successCount,
        failureCount);
}

/* ========================================================= */

void VideoAudioStreamerAddon::OnAudioData(const BYTE* data,
                                         UINT32 frames,
                                         const char* src,
                                         WAVEFORMATEX* format) {
    if (!m_audioEngine || !m_audioEngine->IsRunning()) return;
    
    // CRITICAL: Log the sample rate being received
    static bool logged_desktop = false, logged_mic = false;
    if (format) {
        if (strcmp(src, "desktop") == 0 && !logged_desktop) {
            IONIA_STREAMER_LOGF(
                "[OnAudioData] DESKTOP: format->nSamplesPerSec = %u Hz\n",
                format->nSamplesPerSec);
            logged_desktop = true;
        } else if (strcmp(src, "mic") == 0 && !logged_mic) {
            IONIA_STREAMER_LOGF(
                "[OnAudioData] MIC: format->nSamplesPerSec = %u Hz\n",
                format->nSamplesPerSec);
            logged_mic = true;
        }
    }
    
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

Napi::Value VideoAudioStreamerAddon::InjectFrame(const Napi::CallbackInfo& info) {
    if (info.Length() < 1 || !info[0].IsBuffer()) {
        Napi::Error::New(info.Env(), "Expected Buffer argument").ThrowAsJavaScriptException();
        return info.Env().Null();
    }

    Napi::Buffer<uint8_t> buffer = info[0].As<Napi::Buffer<uint8_t>>();
    
    {
        std::lock_guard<std::mutex> lock(m_injectedFrameMutex);
        // Copy frame data into buffer
        m_injectedFrameBuffer.resize(buffer.Length());
        std::copy(buffer.Data(), buffer.Data() + buffer.Length(), m_injectedFrameBuffer.begin());
        m_hasInjectedFrame = true;
        m_useInjectedFrames = true;  // Enable injected frame mode
    }

    return Napi::Boolean::New(info.Env(), true);
}

void VideoAudioStreamerAddon::Cleanup() {
    m_desktop.reset();
    m_videoEngine.reset();
    m_videoEncoder.reset();
    m_streamMuxer.reset();
    m_buffer.reset();
    m_audioCapture.reset();
    m_audioEngine.reset();
    m_audioEncoder.reset();
}

Napi::Value VideoAudioStreamerAddon::SetThreadConfig(const Napi::CallbackInfo& info) {
    if (info.Length() < 3) {
        Napi::Error::New(info.Env(), "Expected 3 arguments: capture, videoTick, audioTick").ThrowAsJavaScriptException();
        return info.Env().Null();
    }
    
    m_enableCaptureThread = info[0].As<Napi::Boolean>().Value();
    m_enableVideoTickThread = info[1].As<Napi::Boolean>().Value();
    m_enableAudioTickThread = info[2].As<Napi::Boolean>().Value();
    
    IONIA_STREAMER_LOGF(
        "[SetThreadConfig] Capture=%d, VideoTick=%d, AudioTick=%d\n",
        m_enableCaptureThread,
        m_enableVideoTickThread,
        m_enableAudioTickThread);
    
    return Napi::Boolean::New(info.Env(), true);
}

/* ========================================================= */

Napi::Object VideoAudioStreamerInit(Napi::Env env, Napi::Object exports) {
    VideoAudioStreamerAddon::Init(env, exports);
    return exports;
}

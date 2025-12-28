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
        fprintf(stderr, "[Initialize] DesktopDuplication failed\n");
        return Napi::Boolean::New(env, false);
    }

    m_desktop->GetDesktopDimensions(&m_width, &m_height);

    m_videoEncoder = std::make_unique<VideoEncoder>();
    if (!m_videoEncoder->Initialize(m_width, m_height, m_fps,
                                    m_videoBitrate, m_useNvenc, true)) {
        fprintf(stderr, "[Initialize] VideoEncoder failed\n");
        return Napi::Boolean::New(env, false);
    }

    m_videoEngine = std::make_unique<VideoEngine>();
    if (!m_videoEngine->Initialize(m_fps, m_videoEncoder.get())) {
        fprintf(stderr, "[Initialize] VideoEngine failed\n");
        return Napi::Boolean::New(env, false);
    }

    m_streamMuxer = std::make_unique<StreamMuxer>();
    m_buffer = std::make_unique<StreamBuffer>(100, 2000);
    m_streamMuxer->SetStreamBuffer(m_buffer.get());

    if (!m_streamMuxer->Initialize(m_rtmpUrl, m_videoEncoder.get(),
                                   AudioEngine::SAMPLE_RATE, AudioEngine::CHANNELS, m_audioBitrate)) {
        fprintf(stderr, "[Initialize] StreamMuxer failed\n");
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
    fprintf(stdout, "\n=== AUDIO SAMPLE RATE CHAIN ===\n");
    fprintf(stdout, "AudioEngine::SAMPLE_RATE = %d\n", AudioEngine::SAMPLE_RATE);
    fprintf(stdout, "AudioEngine::CHANNELS = %d\n", AudioEngine::CHANNELS);
    AVStream* audioStream = m_streamMuxer->GetAudioStream();
    fprintf(stdout, "Stream time_base.num = %d\n", audioStream ? audioStream->time_base.num : -1);
    fprintf(stdout, "Stream time_base.den = %d (CRITICAL: should equal sample rate 48000)\n", audioStream ? audioStream->time_base.den : -1);
    fprintf(stdout, "AudioEncoder sample_rate = %d\n", m_audioEncoder ? m_audioEncoder->GetSampleRate() : -1);
    fprintf(stdout, "================================\n\n");
    fflush(stdout);

    // Initialize AudioEngine with callback that encodes audio
    m_audioEngine->Initialize([this](const AudioPacket& p) {
        if (!m_audioEncoder || !m_streamMuxer || p.data.empty()) {
            fprintf(stderr, "[AudioCallback] Null check failed: encoder=%p, muxer=%p, dataSize=%zu\n", 
                    m_audioEncoder.get(), m_streamMuxer.get(), p.data.size());
            fflush(stderr);
            return;
        }
        
        // Track received audio frames
        m_audioFramesReceived.fetch_add(p.duration);
        
        try {
            fprintf(stderr, "[AudioCallback] Encoding %llu frames (total received: %llu)...\n", 
                    static_cast<uint64_t>(p.duration), m_audioFramesReceived.load());
            fflush(stderr);
            
            // CRITICAL VALIDATION: AAC LC requires exactly 1024 samples per frame
            // Variable frame sizes cause crackles, pitch shift, and jitter
            if (p.duration != 1024) {
                fprintf(stderr, "[AudioCallback] ❌ AUDIO FRAME SIZE ERROR: got %llu samples, expected 1024\n",
                        static_cast<uint64_t>(p.duration));
                fprintf(stderr, "[AudioCallback] ❌ This frame size mismatch WILL cause audible artifacts\n");
                fprintf(stderr, "[AudioCallback] ❌ AAC encoder assumes fixed 1024-sample frames\n");
                fflush(stderr);
                // Continue anyway (don't drop), but this explains crackling
            }
            
            auto encoded = m_audioEncoder->EncodeFrames(
                reinterpret_cast<const float*>(p.data.data()),
                static_cast<uint32_t>(p.duration)
            );
            
            // Track encoded frames
            m_audioFramesEncoded.fetch_add(p.duration);
            
            fprintf(stderr, "[AudioCallback] Got %zu encoded packets (total frames encoded: %llu)\n", 
                    encoded.size(), m_audioFramesEncoded.load());
            fflush(stderr);
            
            fprintf(stderr, "[AudioCallback] Got %zu encoded packets (total frames encoded: %llu)\n", 
                    encoded.size(), m_audioFramesEncoded.load());
            fflush(stderr);
            
            // ============ DIAGNOSTIC 1: Record raw AAC to file ============
            static std::ofstream aac_debug_file;
            static bool aac_file_opened = false;
            if (!aac_file_opened) {
                aac_debug_file.open("C:\\Users\\Karmine Corp\\Documents\\Ionia\\native-audio\\debug_audio.aac", std::ios::binary);
                if (aac_debug_file.is_open()) {
                    fprintf(stderr, "[AudioCallback] ✅ AAC debug file opened for recording\n");
                    fflush(stderr);
                    aac_file_opened = true;
                } else {
                    fprintf(stderr, "[AudioCallback] ❌ Failed to open AAC debug file\n");
                    fflush(stderr);
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
                    
                    if (packet_count % 10 == 0) {
                        fprintf(stderr, "[AudioCallback] PKT#%d: size=%zu bytes, delta=%lldms (expect ~21ms)\n", 
                                packet_count, pkt.size(), delta_ms);
                        fflush(stderr);
                    }
                    packet_count++;
                    
                    // Write to AAC file with ADTS header (for VLC playability)
                    if (aac_debug_file.is_open()) {
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
                    
                    fprintf(stderr, "[AudioCallback] Writing packet %zu/%zu\n", i, encoded.size());
                    fflush(stderr);
                    
                    if (!m_streamMuxer) {
                        fprintf(stderr, "[AudioCallback] Packet %zu: muxer is NULL\n", i);
                        fflush(stderr);
                        break;
                    }
                    
                    bool written = m_streamMuxer->WriteAudioPacket(pkt);
                    
                    // ============ DIAGNOSTIC 3: Packet write failures (network drops) ============
                    if (!written) {
                        fprintf(stderr, "[AudioCallback] ❌ PACKET DROP: Packet %zu NOT written\n", i);
                        fflush(stderr);
                    } else {
                        fprintf(stderr, "[AudioCallback] ✅ Packet %zu write success\n", i);
                        fflush(stderr);
                    }
                    
                    if (written) {
                        uint64_t newCount = m_audioPackets.fetch_add(1) + 1;
                        fprintf(stderr, "[AudioCallback] Audio packets now: %llu\n", newCount);
                        fflush(stderr);
                        
                        // Detect gaps in audio packets (packets not being written)
                        if (newCount % 50 == 0) {
                            uint64_t expectedPackets = m_audioFramesEncoded.load() / 256;  // Rough estimate
                            if (newCount < expectedPackets / 2) {
                                fprintf(stderr, "[AudioCallback] WARNING: Audio packet gap detected! Expected ~%llu, got %llu\n",
                                        expectedPackets, newCount);
                                fflush(stderr);
                            }
                        }
                    } else {
                        fprintf(stderr, "[AudioCallback] Packet %zu NOT written (buffer full?)\n", i);
                        fflush(stderr);
                    }
                } catch (const std::exception& e) {
                    fprintf(stderr, "[AudioCallback] Packet %zu exception: %s\n", i, e.what());
                    fflush(stderr);
                } catch (const _com_error& e) {
                    fprintf(stderr, "[AudioCallback] Packet %zu COM error: 0x%08lx - %s\n", i, e.Error(), e.ErrorMessage());
                    fflush(stderr);
                } catch (...) {
                    fprintf(stderr, "[AudioCallback] Packet %zu unknown exception\n", i);
                    fflush(stderr);
                }
            }
        } catch (const std::exception& e) {
            fprintf(stderr, "[AudioCallback] Encode exception: %s\n", e.what());
            fflush(stderr);
        } catch (...) {
            fprintf(stderr, "[AudioCallback] Encode unknown exception\n");
            fflush(stderr);
        }
    });

    return Napi::Boolean::New(env, true);
}

/* ========================================================= */

Napi::Value VideoAudioStreamerAddon::Start(const Napi::CallbackInfo& info) {
    fprintf(stderr, "[Start] BEGIN\n");
    if (m_isRunning) {
        fprintf(stderr, "[Start] Already running, returning false\n");
        return Napi::Boolean::New(info.Env(), false);
    }

    fprintf(stderr, "[Start] Setting flags\n");
    m_shouldStop = false;
    m_isRunning = true;

    fprintf(stderr, "[Start] Starting audio capture\n");
    m_audioCapture->Start();
    
    fprintf(stderr, "[Start] Starting audio engine\n");
    m_audioEngine->Start();
    
    fprintf(stderr, "[Start] Starting video engine\n");
    m_videoEngine->Start();

    fprintf(stderr, "[Start] Spawning capture thread\n");
    fflush(stderr);
    if (m_enableCaptureThread) {
        m_captureThread = std::thread(&VideoAudioStreamerAddon::CaptureThread, this);
        fprintf(stderr, "[Start] ✓ CaptureThread spawned\n");
    } else {
        fprintf(stderr, "[Start] ✗ CaptureThread DISABLED\n");
    }
    fflush(stderr);
    
    fprintf(stderr, "[Start] Spawning video tick thread\n");
    fflush(stderr);
    if (m_enableVideoTickThread) {
        m_videoTickThread = std::thread(&VideoAudioStreamerAddon::VideoTickThread, this);
        fprintf(stderr, "[Start] ✓ VideoTickThread spawned\n");
    } else {
        fprintf(stderr, "[Start] ✗ VideoTickThread DISABLED\n");
    }
    fflush(stderr);
    
    fprintf(stderr, "[Start] Spawning audio tick thread\n");
    fflush(stderr);
    if (m_enableAudioTickThread) {
        m_audioTickThread = std::thread(&VideoAudioStreamerAddon::AudioTickThread, this);
        fprintf(stderr, "[Start] ✓ AudioTickThread spawned\n");
    } else {
        fprintf(stderr, "[Start] ✗ AudioTickThread DISABLED\n");
    }
    fflush(stderr);
    
    fprintf(stderr, "[Start] Spawning network send thread\n");
    fflush(stderr);
    if (m_enableNetworkSendThread) {
        m_networkThread = std::thread(&VideoAudioStreamerAddon::NetworkSendThread, this);
        fprintf(stderr, "[Start] ✓ NetworkSendThread spawned\n");
    } else {
        fprintf(stderr, "[Start] ✗ NetworkSendThread DISABLED\n");
    }
    fflush(stderr);
    
    fprintf(stderr, "[Start] ALL THREADS SPAWNED SUCCESSFULLY\n");
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
    fprintf(stderr, "[CaptureThread] === STARTED === (shouldStop=%d)\n", m_shouldStop.load());
    fflush(stderr);
    
    try {
        fprintf(stderr, "[CaptureThread] Checking components\n");
        fflush(stderr);
        if (!m_videoEncoder || !m_videoEngine) {
            fprintf(stderr, "[CaptureThread] NULL component: encoder=%p, engine=%p\n", m_videoEncoder.get(), m_videoEngine.get());
            fflush(stderr);
            return;
        }
        
        bool useRealCapture = m_desktop && !m_useInjectedFrames;
        fprintf(stderr, "[CaptureThread] useRealCapture=%d, desktop=%p, useInjected=%d\n", useRealCapture, m_desktop.get(), m_useInjectedFrames);
        fflush(stderr);
        
        if (useRealCapture && !m_desktop) {
            fprintf(stderr, "[CaptureThread] DesktopDuplication not initialized\n");
            fflush(stderr);
            return;
        }
        
        std::vector<uint8_t> frame(m_width * m_height * 4);
        fprintf(stderr, "[CaptureThread] Allocated frame buffer: %ux%u = %zu bytes\n", m_width, m_height, frame.size());
        fflush(stderr);

        int loopCount = 0;
        while (!m_shouldStop) {
            loopCount++;
            try {
                fprintf(stderr, "[CaptureThread] Loop %d: START\n", loopCount);
                fflush(stderr);
                
                bool frameReady = false;
                
                if (m_useInjectedFrames) {
                    fprintf(stderr, "[CaptureThread] Loop %d: Trying injected frame mode\n", loopCount);
                    fflush(stderr);
                    try {
                        {
                            std::lock_guard<std::mutex> lock(m_injectedFrameMutex);
                            fprintf(stderr, "[CaptureThread] Loop %d: Acquired injected frame lock\n", loopCount);
                            fflush(stderr);
                            if (m_hasInjectedFrame) {
                                fprintf(stderr, "[CaptureThread] Loop %d: Copying injected frame\n", loopCount);
                                fflush(stderr);
                                std::copy(m_injectedFrameBuffer.begin(), m_injectedFrameBuffer.end(), frame.begin());
                                fprintf(stderr, "[CaptureThread] Loop %d: Copy complete\n", loopCount);
                                fflush(stderr);
                                m_hasInjectedFrame = false;
                                frameReady = true;
                            }
                        }
                        fprintf(stderr, "[CaptureThread] Loop %d: Released injected frame lock\n", loopCount);
                        fflush(stderr);
                    } catch (const std::exception& e) {
                        fprintf(stderr, "[CaptureThread] Loop %d: INJECTED FRAME EXCEPTION: %s\n", loopCount, e.what());
                        fflush(stderr);
                        break;
                    } catch (...) {
                        fprintf(stderr, "[CaptureThread] Loop %d: INJECTED FRAME UNKNOWN EXCEPTION\n", loopCount);
                        fflush(stderr);
                        break;
                    }
                } else if (useRealCapture) {
                    fprintf(stderr, "[CaptureThread] Loop %d: Trying real desktop capture\n", loopCount);
                    fflush(stderr);
                    try {
                        fprintf(stderr, "[CaptureThread] Loop %d: Calling m_desktop->CaptureFrame()\n", loopCount);
                        fflush(stderr);
                        uint32_t w, h;
                        int64_t ts;
                        if (m_desktop->CaptureFrame(frame.data(), &w, &h, &ts)) {
                            fprintf(stderr, "[CaptureThread] Loop %d: CaptureFrame returned true\n", loopCount);
                            fflush(stderr);
                            frameReady = true;
                        } else {
                            fprintf(stderr, "[CaptureThread] Loop %d: CaptureFrame returned false\n", loopCount);
                            fflush(stderr);
                        }
                    } catch (const std::exception& e) {
                        fprintf(stderr, "[CaptureThread] Loop %d: DESKTOP CAPTURE EXCEPTION: %s\n", loopCount, e.what());
                        fflush(stderr);
                        break;
                    } catch (...) {
                        fprintf(stderr, "[CaptureThread] Loop %d: DESKTOP CAPTURE UNKNOWN EXCEPTION\n", loopCount);
                        fflush(stderr);
                        break;
                    }
                }
                
                fprintf(stderr, "[CaptureThread] Loop %d: frameReady=%d\n", loopCount, frameReady ? 1 : 0);
                fflush(stderr);
                
                if (frameReady) {
                    fprintf(stderr, "[CaptureThread] Loop %d: Calling m_videoEngine->PushFrame()\n", loopCount);
                    fflush(stderr);
                    try {
                        m_videoEngine->PushFrame(frame.data());
                        fprintf(stderr, "[CaptureThread] Loop %d: PushFrame() succeeded\n", loopCount);
                        fflush(stderr);
                    } catch (const std::exception& e) {
                        fprintf(stderr, "[CaptureThread] Loop %d: PUSHFRAME EXCEPTION: %s\n", loopCount, e.what());
                        fflush(stderr);
                        break;
                    } catch (...) {
                        fprintf(stderr, "[CaptureThread] Loop %d: PUSHFRAME UNKNOWN EXCEPTION\n", loopCount);
                        fflush(stderr);
                        break;
                    }
                    
                    fprintf(stderr, "[CaptureThread] Loop %d: Incrementing video frame count\n", loopCount);
                    fflush(stderr);
                    m_videoFrames.fetch_add(1);
                    fprintf(stderr, "[CaptureThread] Loop %d: Video frame count updated to %llu\n", loopCount, m_videoFrames.load());
                    fflush(stderr);
                    
                    if (loopCount % 10 == 0) {
                        fprintf(stderr, "[CaptureThread] Loop %d: Pushed frame to engine (total=%llu)\n", loopCount, m_videoFrames.load());
                        fflush(stderr);
                    }
                } else {
                    if (loopCount % 100 == 0) {
                        fprintf(stderr, "[CaptureThread] Loop %d: No frame ready, sleeping 1ms\n", loopCount);
                        fflush(stderr);
                    }
                    fprintf(stderr, "[CaptureThread] Loop %d: Sleeping\n", loopCount);
                    fflush(stderr);
                    std::this_thread::sleep_for(std::chrono::milliseconds(1));
                    fprintf(stderr, "[CaptureThread] Loop %d: Wake from sleep\n", loopCount);
                    fflush(stderr);
                }
                fprintf(stderr, "[CaptureThread] Loop %d: END\n", loopCount);
                fflush(stderr);
            } catch (const std::exception& e) {
                fprintf(stderr, "[CaptureThread] Loop %d: INNER EXCEPTION: %s\n", loopCount, e.what());
                fflush(stderr);
                break;
            } catch (...) {
                fprintf(stderr, "[CaptureThread] Loop %d: INNER UNKNOWN EXCEPTION\n", loopCount);
                fflush(stderr);
                break;
            }
        }
        fprintf(stderr, "[CaptureThread] Exited loop after %d iterations (shouldStop=%d)\n", loopCount, m_shouldStop.load());
        fflush(stderr);
    } catch (const std::exception& e) {
        fprintf(stderr, "[CaptureThread] OUTER EXCEPTION: %s\n", e.what());
        fflush(stderr);
    } catch (...) {
        fprintf(stderr, "[CaptureThread] OUTER UNKNOWN EXCEPTION\n");
        fflush(stderr);
    }
    fprintf(stderr, "[CaptureThread] === FINISHED === (shouldStop=%d, isRunning=%d)\n", m_shouldStop.load(), m_isRunning.load());
    fflush(stderr);
}

void VideoAudioStreamerAddon::VideoTickThread() {
    fprintf(stderr, "[VideoTickThread] === STARTED === (shouldStop=%d)\n", m_shouldStop.load());
    fflush(stderr);
    
    try {
        fprintf(stderr, "[VideoTickThread] Checking components\n");
        fflush(stderr);
        if (!m_videoEngine || !m_videoEncoder || !m_streamMuxer) {
            fprintf(stderr, "[VideoTickThread] NULL component: engine=%p, encoder=%p, muxer=%p\n", 
                    m_videoEngine.get(), m_videoEncoder.get(), m_streamMuxer.get());
            fflush(stderr);
            return;
        }

        std::vector<uint8_t> frame(m_width * m_height * 4);
        fprintf(stderr, "[VideoTickThread] Allocated frame buffer: %ux%u = %zu bytes\n", m_width, m_height, frame.size());
        fflush(stderr);
        
        int loopCount = 0;
        while (!m_shouldStop) {
            loopCount++;
            try {
                fprintf(stderr, "[VideoTickThread] Loop %d: START\n", loopCount);
                fflush(stderr);
                
                // Get the frame number that should be encoded at this time
                fprintf(stderr, "[VideoTickThread] Loop %d: Calling GetExpectedFrameNumber()\n", loopCount);
                fflush(stderr);
                uint64_t expectedFrame = m_videoEngine->GetExpectedFrameNumber();
                fprintf(stderr, "[VideoTickThread] Loop %d: GetExpectedFrameNumber returned %llu\n", loopCount, expectedFrame);
                fflush(stderr);
                
                fprintf(stderr, "[VideoTickThread] Loop %d: Calling GetFrameNumber()\n", loopCount);
                fflush(stderr);
                uint64_t currentFrame = m_videoEngine->GetFrameNumber();
                fprintf(stderr, "[VideoTickThread] Loop %d: GetFrameNumber returned %llu\n", loopCount, currentFrame);
                fflush(stderr);

                if (loopCount % 20 == 0) {
                    fprintf(stderr, "[VideoTickThread] Loop %d: expected=%llu, current=%llu\n", loopCount, expectedFrame, currentFrame);
                    fflush(stderr);
                }

                if (currentFrame < expectedFrame) {
                    // Time to encode another frame
                    fprintf(stderr, "[VideoTickThread] Loop %d: Time to encode, calling PopFrameFromBuffer()\n", loopCount);
                    fflush(stderr);
                    
                    bool hasFrame = false;
                    try {
                        hasFrame = m_videoEngine->PopFrameFromBuffer(frame);
                        fprintf(stderr, "[VideoTickThread] Loop %d: PopFrameFromBuffer returned %d\n", loopCount, hasFrame ? 1 : 0);
                        fflush(stderr);
                    } catch (const std::exception& e) {
                        fprintf(stderr, "[VideoTickThread] Loop %d: POPFRAME EXCEPTION: %s\n", loopCount, e.what());
                        fflush(stderr);
                        hasFrame = false;
                    } catch (...) {
                        fprintf(stderr, "[VideoTickThread] Loop %d: POPFRAME UNKNOWN EXCEPTION\n", loopCount);
                        fflush(stderr);
                        hasFrame = false;
                    }
                    
                    // ✅ OBS-LIKE FRAME DUPLICATION: If no frame in buffer, use last frame
                    if (!hasFrame) {
                        fprintf(stderr, "[VideoTickThread] Loop %d: No frame in buffer, trying to use last frame\n", loopCount);
                        fflush(stderr);
                        try {
                            if (m_videoEngine->GetLastFrame(frame)) {
                                fprintf(stderr, "[VideoTickThread] Loop %d: Using duplicated last frame\n", loopCount);
                                fflush(stderr);
                                hasFrame = true;
                            } else {
                                fprintf(stderr, "[VideoTickThread] Loop %d: No last frame available, creating black frame\n", loopCount);
                                fflush(stderr);
                                // Fill with black (0x00)
                                std::fill(frame.begin(), frame.end(), 0);
                                hasFrame = true;
                            }
                        } catch (const std::exception& e) {
                            fprintf(stderr, "[VideoTickThread] Loop %d: GETLASTFRAME EXCEPTION: %s\n", loopCount, e.what());
                            fflush(stderr);
                            // Still try to encode black frame
                            std::fill(frame.begin(), frame.end(), 0);
                            hasFrame = true;
                        } catch (...) {
                            fprintf(stderr, "[VideoTickThread] Loop %d: GETLASTFRAME UNKNOWN EXCEPTION\n", loopCount);
                            fflush(stderr);
                            std::fill(frame.begin(), frame.end(), 0);
                            hasFrame = true;
                        }
                    }
                    
                    if (hasFrame) {
                        fprintf(stderr, "[VideoTickThread] Loop %d: Frame ready, calling EncodeFrame()\n", loopCount);
                        fflush(stderr);
                        
                        // Frame data available (real or duplicated), encode it
                        try {
                            auto packets = m_videoEncoder->EncodeFrame(frame.data());
                            fprintf(stderr, "[VideoTickThread] Loop %d: EncodeFrame returned %zu packets\n", loopCount, packets.size());
                            fflush(stderr);
                            
                            for (size_t i = 0; i < packets.size(); i++) {
                                fprintf(stderr, "[VideoTickThread] Loop %d: Writing packet %zu of %zu\n", loopCount, i, packets.size());
                                fflush(stderr);
                                
                                try {
                                    // Check muxer validity before writing
                                    if (!m_streamMuxer) {
                                        fprintf(stderr, "[VideoTickThread] Loop %d: muxer is NULL, skipping write\n", loopCount);
                                        fflush(stderr);
                                        break;
                                    }
                                    
                                    auto& p = packets[i];
                                    fprintf(stderr, "[VideoTickThread] Loop %d: Packet size=%zu, keyframe=%d\n", loopCount, p.data.size(), p.isKeyframe ? 1 : 0);
                                    fflush(stderr);
                                    
                                    fprintf(stderr, "[VideoTickThread] Loop %d: Muxer state: connected=%d, backpressure=%d\n", 
                                            loopCount, m_streamMuxer->IsConnected(), m_streamMuxer->IsBackpressure());
                                    fflush(stderr);
                                    
                                    fprintf(stderr, "[VideoTickThread] Loop %d: Calling WriteVideoPacket[%zu] with muxer=%p\n", loopCount, i, m_streamMuxer.get());
                                    fflush(stderr);
                                    
                                    bool written = m_streamMuxer->WriteVideoPacket(&p, currentFrame);
                                    fprintf(stderr, "[VideoTickThread] Loop %d: WriteVideoPacket[%zu] returned=%s\n", loopCount, i, written ? "true" : "false");
                                    fflush(stderr);
                                    
                                    if (written) {
                                        fprintf(stderr, "[VideoTickThread] Loop %d: Incrementing video packet count\n", loopCount);
                                        fflush(stderr);
                                        m_videoPackets.fetch_add(1);
                                        fprintf(stderr, "[VideoTickThread] Loop %d: Video packet count now %llu\n", loopCount, m_videoPackets.load());
                                        fflush(stderr);
                                    } else {
                                        fprintf(stderr, "[VideoTickThread] Loop %d: WriteVideoPacket returned false (backpressure or buffer full?)\n", loopCount);
                                        fflush(stderr);
                                    }
                                } catch (const std::exception& e) {
                                    fprintf(stderr, "[VideoTickThread] Loop %d: WRITEPACKET[%zu] STD::EXCEPTION: %s\n", loopCount, i, e.what());
                                    fflush(stderr);
                                    // Don't break - try next packet
                                } catch (const _com_error& e) {
                                    fprintf(stderr, "[VideoTickThread] Loop %d: WRITEPACKET[%zu] COM_ERROR: 0x%08lx - %s\n", loopCount, i, e.Error(), e.ErrorMessage());
                                    fflush(stderr);
                                    // Don't break - try next packet
                                } catch (...) {
                                    fprintf(stderr, "[VideoTickThread] Loop %d: WRITEPACKET[%zu] UNKNOWN EXCEPTION (possibly COM)\n", loopCount, i);
                                    fflush(stderr);
                                    // Don't break - try next packet
                                }
                            }
                        } catch (const std::exception& e) {
                            fprintf(stderr, "[VideoTickThread] Loop %d: ENCODE EXCEPTION: %s\n", loopCount, e.what());
                            fflush(stderr);
                            break;
                        } catch (...) {
                            fprintf(stderr, "[VideoTickThread] Loop %d: ENCODE UNKNOWN EXCEPTION\n", loopCount);
                            fflush(stderr);
                            break;
                        }
                    }
                    
                    // ✅ CRITICAL FIX: Always advance frame number, regardless of frame availability
                    fprintf(stderr, "[VideoTickThread] Loop %d: Calling AdvanceFrameNumber()\n", loopCount);
                    fflush(stderr);
                    try {
                        m_videoEngine->AdvanceFrameNumber();
                        fprintf(stderr, "[VideoTickThread] Loop %d: AdvanceFrameNumber() succeeded (now at %llu)\n", loopCount, m_videoEngine->GetFrameNumber());
                        fflush(stderr);
                    } catch (const std::exception& e) {
                        fprintf(stderr, "[VideoTickThread] Loop %d: ADVANCEFRAME EXCEPTION: %s\n", loopCount, e.what());
                        fflush(stderr);
                        break;
                    } catch (...) {
                        fprintf(stderr, "[VideoTickThread] Loop %d: ADVANCEFRAME UNKNOWN EXCEPTION\n", loopCount);
                        fflush(stderr);
                        break;
                    }
                } else {
                    // No frame time yet, wait a bit
                    if (loopCount % 50 == 0) {
                        fprintf(stderr, "[VideoTickThread] Loop %d: No frame time yet, sleeping 5ms\n", loopCount);
                        fflush(stderr);
                    }
                    fprintf(stderr, "[VideoTickThread] Loop %d: Sleeping\n", loopCount);
                    fflush(stderr);
                    std::this_thread::sleep_for(std::chrono::milliseconds(5));
                    fprintf(stderr, "[VideoTickThread] Loop %d: Wake from sleep\n", loopCount);
                    fflush(stderr);
                }
                fprintf(stderr, "[VideoTickThread] Loop %d: END\n", loopCount);
                fflush(stderr);
            } catch (const std::exception& e) {
                fprintf(stderr, "[VideoTickThread] Loop %d: EXCEPTION: %s\n", loopCount, e.what());
                fflush(stderr);
                break;
            } catch (...) {
                fprintf(stderr, "[VideoTickThread] Loop %d: UNKNOWN EXCEPTION\n", loopCount);
                fflush(stderr);
                break;
            }
        }
        fprintf(stderr, "[VideoTickThread] Exited loop after %d iterations (shouldStop=%d)\n", loopCount, m_shouldStop.load());
        fflush(stderr);
    } catch (const std::exception& e) {
        fprintf(stderr, "[VideoTickThread] OUTER EXCEPTION: %s\n", e.what());
        fflush(stderr);
    } catch (...) {
        fprintf(stderr, "[VideoTickThread] OUTER UNKNOWN EXCEPTION\n");
        fflush(stderr);
    }
    fprintf(stderr, "[VideoTickThread] === FINISHED === (shouldStop=%d, videoPackets=%llu)\n", m_shouldStop.load(), m_videoPackets.load());
    fflush(stderr);
}

void VideoAudioStreamerAddon::AudioTickThread() {
    fprintf(stderr, "[AudioTickThread] === STARTED === (shouldStop=%d)\n", m_shouldStop.load());
    fflush(stderr);
    
    try {
        fprintf(stderr, "[AudioTickThread] Checking components\n");
        fflush(stderr);
        if (!m_audioEngine) {
            fprintf(stderr, "[AudioTickThread] NULL component: audioEngine=%p\n", m_audioEngine.get());
            fflush(stderr);
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
                fprintf(stderr, "[AudioTickThread] Loop %d: START\n", tickCount);
                fflush(stderr);
                
                fprintf(stderr, "[AudioTickThread] Loop %d: Checking m_audioEngine pointer\n", tickCount);
                fflush(stderr);
                
                if (!m_audioEngine) {
                    fprintf(stderr, "[AudioTickThread] Loop %d: audioEngine became NULL mid-loop\n", tickCount);
                    fflush(stderr);
                    break;
                }
                fprintf(stderr, "[AudioTickThread] Loop %d: m_audioEngine pointer is valid (%p)\n", tickCount, m_audioEngine.get());
                fflush(stderr);
                
                fprintf(stderr, "[AudioTickThread] Loop %d: Calling IsRunning()\n", tickCount);
                fflush(stderr);
                bool isRunning = false;
                try {
                    isRunning = m_audioEngine->IsRunning();
                    fprintf(stderr, "[AudioTickThread] Loop %d: IsRunning() returned %d\n", tickCount, isRunning ? 1 : 0);
                    fflush(stderr);
                } catch (const std::exception& e) {
                    fprintf(stderr, "[AudioTickThread] Loop %d: ISRUNNING EXCEPTION: %s\n", tickCount, e.what());
                    fflush(stderr);
                    break;
                } catch (...) {
                    fprintf(stderr, "[AudioTickThread] Loop %d: ISRUNNING UNKNOWN EXCEPTION\n", tickCount);
                    fflush(stderr);
                    break;
                }
                
                if (!isRunning) {
                    fprintf(stderr, "[AudioTickThread] Loop %d: AudioEngine not running, exiting loop\n", tickCount);
                    fflush(stderr);
                    break;
                }
                
                if (tickCount % 50 == 0) {
                    fprintf(stderr, "[AudioTickThread] Loop %d: Audio ticks=%d, packets=%llu\n", tickCount, tickCount, m_audioPackets.load());
                    fflush(stderr);
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
                        fprintf(stderr, "[AudioTickThread] Loop %d: TICK EXCEPTION: %s\n", tickCount, e.what());
                        fflush(stderr);
                        m_shouldStop = true;
                        break;
                    } catch (...) {
                        fprintf(stderr, "[AudioTickThread] Loop %d: TICK UNKNOWN EXCEPTION\n", tickCount);
                        fflush(stderr);
                        m_shouldStop = true;
                        break;
                    }
                    nextTickTime += std::chrono::microseconds(frameDurationUs);
                    catchUps++;
                }
                
                fprintf(stderr, "[AudioTickThread] Loop %d: END\n", tickCount);
                fflush(stderr);
            } catch (const std::exception& e) {
                fprintf(stderr, "[AudioTickThread] Loop %d: EXCEPTION: %s\n", tickCount, e.what());
                fflush(stderr);
                break;
            } catch (...) {
                fprintf(stderr, "[AudioTickThread] Loop %d: UNKNOWN EXCEPTION (likely COM/Windows exception)\n", tickCount);
                fprintf(stderr, "[AudioTickThread] Loop %d: m_audioEngine ptr=%p, shouldStop=%d\n", 
                        tickCount, m_audioEngine.get(), m_shouldStop.load());
                fflush(stderr);
                break;
            }
        }
        fprintf(stderr, "[AudioTickThread] Exited loop after %d ticks (shouldStop=%d)\n", tickCount, m_shouldStop.load());
        fflush(stderr);
    } catch (const std::exception& e) {
        fprintf(stderr, "[AudioTickThread] OUTER EXCEPTION: %s\n", e.what());
        fflush(stderr);
    } catch (...) {
        fprintf(stderr, "[AudioTickThread] OUTER UNKNOWN EXCEPTION\n");
        fflush(stderr);
    }
    fprintf(stderr, "[AudioTickThread] === FINISHED === (shouldStop=%d, audioPackets=%llu)\n", m_shouldStop.load(), m_audioPackets.load());
    fflush(stderr);
}

void VideoAudioStreamerAddon::NetworkSendThread() {
    fprintf(stderr, "[NetworkSendThread] === STARTED ===\n");
    fflush(stderr);
    
    if (!m_streamMuxer) {
        fprintf(stderr, "[NetworkSendThread] FATAL: NULL streamMuxer\n");
        fflush(stderr);
        return;
    }
    
    fprintf(stderr, "[NetworkSendThread] Checking muxer state...\n");
    fflush(stderr);
    fprintf(stderr, "[NetworkSendThread] IsConnected=%d, IsBackpressure=%d\n", 
            m_streamMuxer->IsConnected(), m_streamMuxer->IsBackpressure());
    fflush(stderr);
    
    int sendAttempts = 0;
    int successCount = 0;
    int failureCount = 0;
    int loopCount = 0;
    
    while (!m_shouldStop) {
        loopCount++;
        try {
            // Check muxer state periodically
            if (loopCount % 1000 == 0) {
                fprintf(stderr, "[NetworkSendThread] Loop %d: Connected=%d, Backpressure=%d, Attempts=%d, Success=%d, Failed=%d\n",
                        loopCount, m_streamMuxer->IsConnected(), m_streamMuxer->IsBackpressure(),
                        sendAttempts, successCount, failureCount);
                fflush(stderr);
            }
            
            // Try to send packet
            try {
                if (!m_streamMuxer) {
                    fprintf(stderr, "[NetworkSendThread] Loop %d: muxer became NULL\n", loopCount);
                    fflush(stderr);
                    break;
                }
                
                bool sent = m_streamMuxer->SendNextBufferedPacket();
                sendAttempts++;
                
                if (sent) {
                    successCount++;
                    if (successCount % 50 == 0) {
                        fprintf(stderr, "[NetworkSendThread] Sent %d packets successfully\n", successCount);
                        fflush(stderr);
                    }
                } else {
                    // No packet available, sleep briefly
                    std::this_thread::sleep_for(std::chrono::milliseconds(1));
                }
            } catch (const std::exception& e) {
                failureCount++;
                if (failureCount % 100 == 0) {
                    fprintf(stderr, "[NetworkSendThread] SendNextBufferedPacket exception (count=%d): %s\n", 
                            failureCount, e.what());
                    fflush(stderr);
                }
            } catch (const _com_error& e) {
                failureCount++;
                if (failureCount % 100 == 0) {
                    fprintf(stderr, "[NetworkSendThread] SendNextBufferedPacket COM error (count=%d): 0x%08lx - %s\n",
                            failureCount, e.Error(), e.ErrorMessage());
                    fflush(stderr);
                }
            } catch (...) {
                failureCount++;
                if (failureCount % 100 == 0) {
                    fprintf(stderr, "[NetworkSendThread] SendNextBufferedPacket unknown exception (count=%d)\n", failureCount);
                    fflush(stderr);
                }
            }
        } catch (const std::exception& e) {
            fprintf(stderr, "[NetworkSendThread] Loop %d OUTER STD::EXCEPTION: %s\n", loopCount, e.what());
            fflush(stderr);
            // Continue on exception, don't break
        } catch (const _com_error& e) {
            fprintf(stderr, "[NetworkSendThread] Loop %d OUTER COM_ERROR: 0x%08lx - %s\n", loopCount, e.Error(), e.ErrorMessage());
            fflush(stderr);
            // Continue on exception, don't break
        } catch (...) {
            // Silently continue on unknown exception - likely thread/COM cleanup
            if (loopCount % 1000 == 0) {
                fprintf(stderr, "[NetworkSendThread] Loop %d OUTER UNKNOWN EXCEPTION (continuing...)\n", loopCount);
                fflush(stderr);
            }
        }
    }
    
    fprintf(stderr, "[NetworkSendThread] === EXITING === (Loops=%d, Attempts=%d, Success=%d, Failed=%d)\n", 
            loopCount, sendAttempts, successCount, failureCount);
    fflush(stderr);
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
            fprintf(stderr, "[OnAudioData] DESKTOP: format->nSamplesPerSec = %u Hz\n", format->nSamplesPerSec);
            fflush(stderr);
            logged_desktop = true;
        } else if (strcmp(src, "mic") == 0 && !logged_mic) {
            fprintf(stderr, "[OnAudioData] MIC: format->nSamplesPerSec = %u Hz\n", format->nSamplesPerSec);
            fflush(stderr);
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
    
    fprintf(stderr, "[SetThreadConfig] Capture=%d, VideoTick=%d, AudioTick=%d\n",
            m_enableCaptureThread, m_enableVideoTickThread, m_enableAudioTickThread);
    fflush(stderr);
    
    return Napi::Boolean::New(info.Env(), true);
}

/* ========================================================= */

Napi::Object VideoAudioStreamerInit(Napi::Env env, Napi::Object exports) {
    VideoAudioStreamerAddon::Init(env, exports);
    return exports;
}

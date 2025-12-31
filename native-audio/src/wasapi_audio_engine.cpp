#include <napi.h>
#include "audio_engine.h"
#include "av_packet.h"
#include <vector>
#include <memory>
#include <mutex>
#include <atomic>
#include <cstring>
#include <string>

class AudioEngineAddon : public Napi::ObjectWrap<AudioEngineAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    AudioEngineAddon(const Napi::CallbackInfo& info);
    ~AudioEngineAddon();

private:
    static Napi::FunctionReference constructor;
    
    Napi::Value Initialize(const Napi::CallbackInfo& info);
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    Napi::Value IsRunning(const Napi::CallbackInfo& info);
    Napi::Value FeedAudioData(const Napi::CallbackInfo& info);
    Napi::Value Tick(const Napi::CallbackInfo& info);
    Napi::Value GetCurrentPTSFrames(const Napi::CallbackInfo& info);
    Napi::Value GetCurrentPTSSeconds(const Napi::CallbackInfo& info);
    
    std::unique_ptr<AudioEngine> m_engine;
    Napi::ThreadSafeFunction m_tsfn;
    std::atomic<bool> m_tsfnValid;
    
    void OnAudioPacket(const AudioPacket& packet);
};

Napi::FunctionReference AudioEngineAddon::constructor;

Napi::Object AudioEngineAddon::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "AudioEngine", {
        InstanceMethod("initialize", &AudioEngineAddon::Initialize),
        InstanceMethod("start", &AudioEngineAddon::Start),
        InstanceMethod("stop", &AudioEngineAddon::Stop),
        InstanceMethod("isRunning", &AudioEngineAddon::IsRunning),
        InstanceMethod("feedAudioData", &AudioEngineAddon::FeedAudioData),
        InstanceMethod("tick", &AudioEngineAddon::Tick),
        InstanceMethod("getCurrentPTSFrames", &AudioEngineAddon::GetCurrentPTSFrames),
        InstanceMethod("getCurrentPTSSeconds", &AudioEngineAddon::GetCurrentPTSSeconds),
    });
    
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    
    exports.Set("AudioEngine", func);
    return exports;
}

AudioEngineAddon::AudioEngineAddon(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<AudioEngineAddon>(info)
    , m_tsfnValid(true) {
    Napi::Env env = info.Env();
    
    // Create audio engine instance
    m_engine = std::make_unique<AudioEngine>();
}

AudioEngineAddon::~AudioEngineAddon() {
    if (m_engine) {
        m_engine->Stop();
    }
    m_tsfnValid = false;
    if (m_tsfn) {
        m_tsfn.Release();
    }
}

void AudioEngineAddon::OnAudioPacket(const AudioPacket& packet) {
    if (!m_tsfnValid || !packet.isValid()) {
        return;
    }

    // Create a copy of the AudioPacket data for the callback
    // We need to copy the packet data and metadata
    struct PacketData {
        std::vector<uint8_t> data;
        int64_t pts;
        int64_t dts;
        int64_t duration;
        int streamIndex;
    };
    
    PacketData* packetData = new PacketData();
    packetData->data = packet.data;
    packetData->pts = packet.pts;
    packetData->dts = packet.dts;
    packetData->duration = packet.duration;
    packetData->streamIndex = packet.streamIndex;

    // Call JavaScript callback via thread-safe function
    if (!m_tsfnValid) {
        delete packetData;
        return;
    }

    // Non-blocking call: if JS is slow and the queue is full, drop this packet.
    auto status = m_tsfn.NonBlockingCall(
        packetData,
        [](Napi::Env env, Napi::Function jsCallback, PacketData* packetData) {
            // Create Buffer from packet data (PCM float32)
            Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(
                env,
                packetData->data.data(),
                packetData->data.size()
            );
            
            // Create JavaScript object with AudioPacket properties
            Napi::Object packetObj = Napi::Object::New(env);
            packetObj.Set("data", buffer);
            packetObj.Set("pts", Napi::Number::New(env, static_cast<double>(packetData->pts)));
            packetObj.Set("dts", Napi::Number::New(env, static_cast<double>(packetData->dts)));
            packetObj.Set("duration", Napi::Number::New(env, static_cast<double>(packetData->duration)));
            packetObj.Set("streamIndex", Napi::Number::New(env, packetData->streamIndex));
            packetObj.Set("ptsSeconds", Napi::Number::New(env, static_cast<double>(packetData->pts) / 48000.0));
            packetObj.Set("dtsSeconds", Napi::Number::New(env, static_cast<double>(packetData->dts) / 48000.0));
            packetObj.Set("durationSeconds", Napi::Number::New(env, static_cast<double>(packetData->duration) / 48000.0));
            
            jsCallback.Call({ packetObj });
            
            delete packetData;
        }
    );

    if (status != napi_ok) {
        delete packetData;
    }
}

Napi::Value AudioEngineAddon::Initialize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Expected callback function").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    
    Napi::Function callback = info[0].As<Napi::Function>();
    
    // Create thread-safe function for audio output callback
    m_tsfn = Napi::ThreadSafeFunction::New(
        env,
        callback,
        "Audio Engine Output",
        8,  // Bounded queue to avoid unbounded RAM growth
        1   // Initial thread count
    );
    
    // Set up audio packet callback (AudioPacket with PTS)
    auto audioCallback = [this](const AudioPacket& packet) {
        this->OnAudioPacket(packet);
    };
    
    bool success = m_engine->Initialize(audioCallback);
    return Napi::Boolean::New(env, success);
}

Napi::Value AudioEngineAddon::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_engine) {
        return Napi::Boolean::New(env, false);
    }
    
    bool success = m_engine->Start();
    return Napi::Boolean::New(env, success);
}

Napi::Value AudioEngineAddon::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (m_engine) {
        m_engine->Stop();
    }
    
    m_tsfnValid = false;
    if (m_tsfn) {
        m_tsfn.Release();
    }
    
    return env.Undefined();
}

Napi::Value AudioEngineAddon::IsRunning(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_engine) {
        return Napi::Boolean::New(env, false);
    }
    
    return Napi::Boolean::New(env, m_engine->IsRunning());
}

Napi::Value AudioEngineAddon::FeedAudioData(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 3) {
        Napi::TypeError::New(env, "Expected (buffer, numFrames, source)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    
    if (!info[0].IsBuffer() || !info[1].IsNumber() || !info[2].IsString()) {
        Napi::TypeError::New(env, "Expected (Buffer, number, string)").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    
    Napi::Buffer<uint8_t> buffer = info[0].As<Napi::Buffer<uint8_t>>();
    UINT32 numFrames = info[1].As<Napi::Number>().Uint32Value();
    std::string source = info[2].As<Napi::String>().Utf8Value();
    
    // Cast buffer data to float* (buffer contains float32 samples)
    const float* data = reinterpret_cast<const float*>(buffer.Data());
    
    if (!m_engine) {
        return env.Undefined();
    }
    
    m_engine->FeedAudioData(data, numFrames, source.c_str());
    
    return env.Undefined();
}

Napi::Value AudioEngineAddon::Tick(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_engine) {
        return env.Undefined();
    }
    
    m_engine->Tick();
    
    return env.Undefined();
}

Napi::Value AudioEngineAddon::GetCurrentPTSFrames(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_engine) {
        return Napi::Number::New(env, 0);
    }
    
    return Napi::Number::New(env, static_cast<double>(m_engine->GetCurrentPTSFrames()));
}

Napi::Value AudioEngineAddon::GetCurrentPTSSeconds(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_engine) {
        return Napi::Number::New(env, 0.0);
    }
    
    return Napi::Number::New(env, m_engine->GetCurrentPTSSeconds());
}

// Module initialization (exported function for wasapi_capture module)
Napi::Object AudioEngineAddon_Init(Napi::Env env, Napi::Object exports) {
    AudioEngineAddon::Init(env, exports);
    return exports;
}


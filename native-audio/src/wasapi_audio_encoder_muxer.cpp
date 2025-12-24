#include <napi.h>
#include "audio_engine_encoder.h"
#include <string>
#include <memory>

class AudioEngineEncoderAddon : public Napi::ObjectWrap<AudioEngineEncoderAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    AudioEngineEncoderAddon(const Napi::CallbackInfo& info);
    ~AudioEngineEncoderAddon();

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
    Napi::Value GetEncodedPackets(const Napi::CallbackInfo& info);
    Napi::Value GetEncodedBytes(const Napi::CallbackInfo& info);
    Napi::Value GetMuxedPackets(const Napi::CallbackInfo& info);
    Napi::Value GetMuxedBytes(const Napi::CallbackInfo& info);
    
    std::unique_ptr<AudioEngineWithEncoder> m_engine;
};

Napi::FunctionReference AudioEngineEncoderAddon::constructor;

Napi::Object AudioEngineEncoderAddon::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "AudioEngineEncoder", {
        InstanceMethod("initialize", &AudioEngineEncoderAddon::Initialize),
        InstanceMethod("start", &AudioEngineEncoderAddon::Start),
        InstanceMethod("stop", &AudioEngineEncoderAddon::Stop),
        InstanceMethod("isRunning", &AudioEngineEncoderAddon::IsRunning),
        InstanceMethod("feedAudioData", &AudioEngineEncoderAddon::FeedAudioData),
        InstanceMethod("tick", &AudioEngineEncoderAddon::Tick),
        InstanceMethod("getCurrentPTSFrames", &AudioEngineEncoderAddon::GetCurrentPTSFrames),
        InstanceMethod("getCurrentPTSSeconds", &AudioEngineEncoderAddon::GetCurrentPTSSeconds),
        InstanceMethod("getEncodedPackets", &AudioEngineEncoderAddon::GetEncodedPackets),
        InstanceMethod("getEncodedBytes", &AudioEngineEncoderAddon::GetEncodedBytes),
        InstanceMethod("getMuxedPackets", &AudioEngineEncoderAddon::GetMuxedPackets),
        InstanceMethod("getMuxedBytes", &AudioEngineEncoderAddon::GetMuxedBytes),
    });
    
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    
    exports.Set("AudioEngineEncoder", func);
    return exports;
}

AudioEngineEncoderAddon::AudioEngineEncoderAddon(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<AudioEngineEncoderAddon>(info) {
    m_engine = std::make_unique<AudioEngineWithEncoder>();
}

AudioEngineEncoderAddon::~AudioEngineEncoderAddon() {
    if (m_engine) {
        m_engine->Stop();
    }
}

Napi::Value AudioEngineEncoderAddon::Initialize(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (info.Length() < 1 || !info[0].IsString()) {
        Napi::TypeError::New(env, "Expected output path string").ThrowAsJavaScriptException();
        return env.Undefined();
    }
    
    std::string outputPath = info[0].As<Napi::String>().Utf8Value();
    UINT32 bitrate = 192000;  // Default 192kbps
    bool useRawAac = false;  // Default to MP4
    
    if (info.Length() >= 2 && info[1].IsNumber()) {
        bitrate = info[1].As<Napi::Number>().Uint32Value();
    }
    
    if (info.Length() >= 3 && info[2].IsBoolean()) {
        useRawAac = info[2].As<Napi::Boolean>().Value();
    }
    
    if (!m_engine) {
        return Napi::Boolean::New(env, false);
    }
    
    bool success = m_engine->Initialize(outputPath, bitrate, useRawAac);
    return Napi::Boolean::New(env, success);
}

Napi::Value AudioEngineEncoderAddon::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_engine) {
        return Napi::Boolean::New(env, false);
    }
    
    bool success = m_engine->Start();
    return Napi::Boolean::New(env, success);
}

Napi::Value AudioEngineEncoderAddon::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (m_engine) {
        m_engine->Stop();
    }
    
    return env.Undefined();
}

Napi::Value AudioEngineEncoderAddon::IsRunning(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_engine) {
        return Napi::Boolean::New(env, false);
    }
    
    return Napi::Boolean::New(env, m_engine->IsRunning());
}

Napi::Value AudioEngineEncoderAddon::FeedAudioData(const Napi::CallbackInfo& info) {
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
    
    const float* data = reinterpret_cast<const float*>(buffer.Data());
    
    if (!m_engine) {
        return env.Undefined();
    }
    
    m_engine->FeedAudioData(data, numFrames, source.c_str());
    
    return env.Undefined();
}

Napi::Value AudioEngineEncoderAddon::Tick(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_engine) {
        return env.Undefined();
    }
    
    m_engine->Tick();
    
    return env.Undefined();
}

Napi::Value AudioEngineEncoderAddon::GetCurrentPTSFrames(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_engine) {
        return Napi::Number::New(env, 0);
    }
    
    return Napi::Number::New(env, static_cast<double>(m_engine->GetCurrentPTSFrames()));
}

Napi::Value AudioEngineEncoderAddon::GetCurrentPTSSeconds(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_engine) {
        return Napi::Number::New(env, 0.0);
    }
    
    return Napi::Number::New(env, m_engine->GetCurrentPTSSeconds());
}

Napi::Value AudioEngineEncoderAddon::GetEncodedPackets(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_engine) {
        return Napi::Number::New(env, 0);
    }
    
    return Napi::Number::New(env, static_cast<double>(m_engine->GetEncodedPackets()));
}

Napi::Value AudioEngineEncoderAddon::GetEncodedBytes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_engine) {
        return Napi::Number::New(env, 0);
    }
    
    return Napi::Number::New(env, static_cast<double>(m_engine->GetEncodedBytes()));
}

Napi::Value AudioEngineEncoderAddon::GetMuxedPackets(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_engine) {
        return Napi::Number::New(env, 0);
    }
    
    return Napi::Number::New(env, static_cast<double>(m_engine->GetMuxedPackets()));
}

Napi::Value AudioEngineEncoderAddon::GetMuxedBytes(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_engine) {
        return Napi::Number::New(env, 0);
    }
    
    return Napi::Number::New(env, static_cast<double>(m_engine->GetMuxedBytes()));
}

// Module initialization
Napi::Object AudioEngineEncoderAddon_Init(Napi::Env env, Napi::Object exports) {
    AudioEngineEncoderAddon::Init(env, exports);
    return exports;
}


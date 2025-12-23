#include <napi.h>
#include "audio_capture.h"
#include <vector>
#include <memory>
#include <mutex>
#include <cstring>
#include <string>

// Structure to hold audio data and size for thread-safe callback
struct AudioData {
    std::vector<uint8_t> buffer;
    
    AudioData(const uint8_t* data, size_t size) : buffer(data, data + size) {}
};

class WASAPICaptureAddon : public Napi::ObjectWrap<WASAPICaptureAddon> {
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);
    WASAPICaptureAddon(const Napi::CallbackInfo& info);
    ~WASAPICaptureAddon();

private:
    static Napi::FunctionReference constructor;
    
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);
    Napi::Value GetFormat(const Napi::CallbackInfo& info);
    
    std::unique_ptr<AudioCapture> m_capture;
    Napi::ThreadSafeFunction m_tsfn;
    std::string m_mode; // keep capture mode alive ("mic", "desktop", "both")
    
    void OnAudioData(const BYTE* data, UINT32 numFrames, DWORD flags);
};

Napi::FunctionReference WASAPICaptureAddon::constructor;

Napi::Object WASAPICaptureAddon::Init(Napi::Env env, Napi::Object exports) {
    Napi::Function func = DefineClass(env, "WASAPICapture", {
        InstanceMethod("start", &WASAPICaptureAddon::Start),
        InstanceMethod("stop", &WASAPICaptureAddon::Stop),
        InstanceMethod("getFormat", &WASAPICaptureAddon::GetFormat),
    });
    
    constructor = Napi::Persistent(func);
    constructor.SuppressDestruct();
    
    exports.Set("WASAPICapture", func);
    return exports;
}

WASAPICaptureAddon::WASAPICaptureAddon(const Napi::CallbackInfo& info)
    : Napi::ObjectWrap<WASAPICaptureAddon>(info) {
    Napi::Env env = info.Env();
    
    // Create callback function from JavaScript
    if (info.Length() < 1 || !info[0].IsFunction()) {
        Napi::TypeError::New(env, "Expected callback function").ThrowAsJavaScriptException();
        return;
    }
    
    Napi::Function callback = info[0].As<Napi::Function>();
    
    // Get capture mode (optional second parameter)
    // "mic" = microphone only, "desktop" = desktop only, "both" = both (default)
    m_mode = "both";
    if (info.Length() >= 2 && info[1].IsString()) {
        std::string mode = info[1].As<Napi::String>().Utf8Value();
        if (mode == "mic" || mode == "desktop" || mode == "both") {
            m_mode = mode; // store in member to keep lifetime > Initialize()
        }
    }
    
    // Create thread-safe function for audio data callback
    m_tsfn = Napi::ThreadSafeFunction::New(
        env,
        callback,
        "WASAPI Audio Data",
        0,  // Unlimited queue
        1   // Initial thread count
    );
    
    // Create audio capture instance
    m_capture = std::make_unique<AudioCapture>();
    
    // Set up audio data callback
    auto audioCallback = [this](const BYTE* data, UINT32 numFrames, DWORD flags) {
        this->OnAudioData(data, numFrames, flags);
    };
    
    if (!m_capture->Initialize(audioCallback, m_mode.c_str())) {
        Napi::Error::New(env, "Failed to initialize WASAPI capture").ThrowAsJavaScriptException();
        return;
    }
}

WASAPICaptureAddon::~WASAPICaptureAddon() {
    if (m_capture) {
        m_capture->Stop();
    }
    if (m_tsfn) {
        m_tsfn.Release();
    }
}

void WASAPICaptureAddon::OnAudioData(const BYTE* data, UINT32 numFrames, DWORD flags) {
    if (!m_capture || !data || numFrames == 0) {
        return;
    }
    
    WAVEFORMATEX* format = m_capture->GetFormat();
    if (!format) {
        return;
    }
    
    size_t dataSize = numFrames * format->nBlockAlign;
    
    // Create audio data structure (will be deleted in callback)
    AudioData* audioData = new AudioData(data, dataSize);
    
    // Call JavaScript callback via thread-safe function
    auto status = m_tsfn.BlockingCall(
        audioData,
        [](Napi::Env env, Napi::Function jsCallback, AudioData* audioData) {
            // Create buffer from audio data
            Napi::Buffer<uint8_t> buffer = Napi::Buffer<uint8_t>::Copy(
                env, 
                audioData->buffer.data(), 
                audioData->buffer.size()
            );
            jsCallback.Call({ buffer });
            // Delete the audio data after callback
            delete audioData;
        }
    );
    
    if (status != napi_ok) {
        // If call failed, delete the audio data
        delete audioData;
    }
}

Napi::Value WASAPICaptureAddon::Start(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_capture) {
        return Napi::Boolean::New(env, false);
    }
    
    bool success = m_capture->Start();
    return Napi::Boolean::New(env, success);
}

Napi::Value WASAPICaptureAddon::Stop(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (m_capture) {
        m_capture->Stop();
    }
    
    return env.Undefined();
}

Napi::Value WASAPICaptureAddon::GetFormat(const Napi::CallbackInfo& info) {
    Napi::Env env = info.Env();
    
    if (!m_capture) {
        return env.Null();
    }
    
    WAVEFORMATEX* format = m_capture->GetFormat();
    if (!format) {
        return env.Null();
    }
    
    Napi::Object formatObj = Napi::Object::New(env);
    formatObj.Set("sampleRate", Napi::Number::New(env, format->nSamplesPerSec));
    formatObj.Set("channels", Napi::Number::New(env, format->nChannels));
    formatObj.Set("bitsPerSample", Napi::Number::New(env, format->wBitsPerSample));
    formatObj.Set("blockAlign", Napi::Number::New(env, format->nBlockAlign));
    formatObj.Set("bytesPerSecond", Napi::Number::New(env, format->nAvgBytesPerSec));
    
    return formatObj;
}

Napi::Object Init(Napi::Env env, Napi::Object exports) {
    return WASAPICaptureAddon::Init(env, exports);
}

NODE_API_MODULE(wasapi_capture, Init)



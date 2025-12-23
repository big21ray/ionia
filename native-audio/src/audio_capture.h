#ifndef AUDIO_CAPTURE_H
#define AUDIO_CAPTURE_H

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <functiondiscoverykeys_devpkey.h>
#include <thread>
#include <atomic>
#include <vector>
#include <functional>
#include <mutex>
#include <string>

// Forward declaration
class WASAPICapture;

// Callback function type for audio data (raw, no resampling)
// source: "desktop" or "mic"
// format: WAVEFORMATEX* of the source format (native format from WASAPI)
typedef std::function<void(const BYTE* data, UINT32 numFrames, const char* source, WAVEFORMATEX* format)> AudioDataCallback;

class AudioCapture {
public:
    AudioCapture();
    ~AudioCapture();

    // Initialize WASAPI capture
    // captureMode: "mic" = microphone only, "desktop" = desktop only, "both" = both (default)
    bool Initialize(AudioDataCallback callback, const char* captureMode = "both");
    
    // Start capturing audio
    bool Start();
    
    // Stop capturing audio
    void Stop();
    
    // Check if capturing
    bool IsCapturing() const { return m_isCapturing; }
    
    // Get audio format info
    // Always returns unified format: 48000 Hz, stereo, float32
    // This is the format after processing pipeline
    WAVEFORMATEX* GetFormat();
    
    // Get sample rate (always 48000 Hz)
    UINT32 GetSampleRate() const { 
        return TARGET_SAMPLE_RATE;
    }
    
    // Get channels (always 2 for stereo)
    UINT16 GetChannels() const { 
        return TARGET_CHANNELS;
    }
    
    // Get bits per sample (always 32 for float)
    UINT16 GetBitsPerSample() const { 
        return 32;
    }

private:
    // WASAPI COM objects
    IMMDeviceEnumerator* m_pEnumerator;
    
    // Desktop audio (loopback) objects
    IMMDevice* m_pDeviceDesktop;
    IAudioClient* m_pAudioClientDesktop;
    IAudioCaptureClient* m_pCaptureClientDesktop;
    WAVEFORMATEX* m_pwfxDesktop;
    HANDLE m_hEventDesktop;  // Event handle for event-driven capture
    
    // Microphone (capture) objects
    IMMDevice* m_pDeviceMic;
    IAudioClient* m_pAudioClientMic;
    IAudioCaptureClient* m_pCaptureClientMic;
    WAVEFORMATEX* m_pwfxMic;
    HANDLE m_hEventMic;  // Event handle for event-driven capture
    
    // Unified format (always 48000 Hz stereo float32)
    WAVEFORMATEX* m_pwfxUnified;
    
    // Capture threads
    std::thread m_captureThreadDesktop;
    std::thread m_captureThreadMic;
    std::thread m_mixThread;  // Dedicated thread for mixing and callbacks
    std::atomic<bool> m_isCapturing;
    std::atomic<bool> m_shouldStop;
    bool m_comInitialized;
    
    // Unified audio frame format: 48000 Hz, stereo, float32
    static constexpr UINT32 TARGET_SAMPLE_RATE = 48000;
    static constexpr UINT32 TARGET_CHANNELS = 2;
    
    // Unified audio frames (normalized to 48k float32 stereo)
    struct UnifiedAudioFrame {
        std::vector<float> samples;  // Interleaved stereo: [L0, R0, L1, R1, ...]
        UINT32 numFrames;             // Number of stereo frames
    };
    
    // Audio mixing
    std::vector<BYTE> m_mixBuffer;
    std::mutex m_mixMutex;
    UnifiedAudioFrame m_desktopFrame;  // Normalized desktop audio
    UnifiedAudioFrame m_micFrame;      // Normalized mic audio
    UINT32 m_desktopFramesReady;
    UINT32 m_micFramesReady;
    
    // Callback for audio data
    AudioDataCallback m_callback;

    // Remember which capture mode was requested ("mic", "desktop", "both")
    std::string m_captureMode;
    
    // Thread functions
    void CaptureThreadDesktop();
    void CaptureThreadMic();
    
    // Helper functions
    bool InitializeDesktopAudio();
    // targetFormat: optional format to force microphone into (e.g. desktop mix format)
    // If nullptr, uses microphone's own mix format.
    bool InitializeMicrophone(const WAVEFORMATEX* targetFormat = nullptr);
    void ConvertAndMixMicToDesktopFormat(const BYTE* micData, UINT32 micFrames);
    
    // Audio processing pipeline (WASAPI → Unified AudioFrame)
    // Step 1: Convert any WASAPI format to float32
    void ConvertToFloat32(
        const BYTE* inData, UINT32 inFrames, const WAVEFORMATEX* inFormat,
        std::vector<float>& outFloat
    );
    
    // Step 2: Resample to target sample rate (always 48000 Hz)
    void ResampleToTarget(
        const std::vector<float>& inFloat, UINT32 inFrames, UINT32 inChannels, UINT32 inRate,
        std::vector<float>& outFloat, UINT32& outFrames
    );
    
    // Step 3: Adapt channels (mono → stereo, multi → stereo)
    void AdaptChannels(
        const std::vector<float>& inFloat, UINT32 inFrames, UINT32 inChannels,
        std::vector<float>& outFloat, UINT32& outFrames
    );
    
    // Complete pipeline: WASAPI format → Unified AudioFrame (48k float32 stereo)
    void ProcessAudioFrame(
        const BYTE* inData, UINT32 inFrames, const WAVEFORMATEX* inFormat,
        UnifiedAudioFrame& outFrame
    );
    
    void Cleanup();
};

#endif // AUDIO_CAPTURE_H



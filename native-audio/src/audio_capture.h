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

// Forward declaration
class WASAPICapture;

// Callback function type for audio data
typedef std::function<void(const BYTE* data, UINT32 numFrames, DWORD flags)> AudioDataCallback;

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
    
    // Get audio format info (uses desktop audio format if available, otherwise microphone)
    WAVEFORMATEX* GetFormat() { return m_pwfxDesktop ? m_pwfxDesktop : m_pwfxMic; }
    
    // Get sample rate
    UINT32 GetSampleRate() const { 
        if (m_pwfxDesktop) return m_pwfxDesktop->nSamplesPerSec;
        if (m_pwfxMic) return m_pwfxMic->nSamplesPerSec;
        return 0;
    }
    
    // Get channels
    UINT16 GetChannels() const { 
        if (m_pwfxDesktop) return m_pwfxDesktop->nChannels;
        if (m_pwfxMic) return m_pwfxMic->nChannels;
        return 0;
    }
    
    // Get bits per sample
    UINT16 GetBitsPerSample() const { 
        if (m_pwfxDesktop) return m_pwfxDesktop->wBitsPerSample;
        if (m_pwfxMic) return m_pwfxMic->wBitsPerSample;
        return 0;
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
    
    // Capture threads
    std::thread m_captureThreadDesktop;
    std::thread m_captureThreadMic;
    std::atomic<bool> m_isCapturing;
    std::atomic<bool> m_shouldStop;
    bool m_comInitialized;
    
    // Audio mixing
    std::vector<BYTE> m_mixBuffer;
    std::mutex m_mixMutex;
    std::vector<BYTE> m_desktopBuffer;
    std::vector<BYTE> m_micBuffer;
    UINT32 m_desktopFramesReady;
    UINT32 m_micFramesReady;
    
    // Callback for audio data
    AudioDataCallback m_callback;
    
    // Thread functions
    void CaptureThreadDesktop();
    void CaptureThreadMic();
    
    // Helper functions
    bool InitializeDesktopAudio();
    bool InitializeMicrophone();
    void MixAndCallback();
    void ConvertAndMixMicToDesktopFormat(const BYTE* micData, UINT32 micFrames);
    void Cleanup();
};

#endif // AUDIO_CAPTURE_H



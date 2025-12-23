#include "audio_capture.h"
#include <iostream>
#include <comdef.h>
#include <propidl.h>
#include <propkey.h>
#include <stdio.h>
#include <algorithm>
#include <cmath>
#include <cstring>

AudioCapture::AudioCapture()
    : m_pEnumerator(nullptr)
    , m_pDeviceDesktop(nullptr)
    , m_pAudioClientDesktop(nullptr)
    , m_pCaptureClientDesktop(nullptr)
    , m_pwfxDesktop(nullptr)
    , m_hEventDesktop(nullptr)
    , m_pDeviceMic(nullptr)
    , m_pAudioClientMic(nullptr)
    , m_pCaptureClientMic(nullptr)
    , m_pwfxMic(nullptr)
    , m_hEventMic(nullptr)
    , m_isCapturing(false)
    , m_shouldStop(false)
    , m_comInitialized(false)
    , m_desktopFramesReady(0)
    , m_micFramesReady(0)
{
}

AudioCapture::~AudioCapture() {
    Stop();
    Cleanup();
    
    // Uninitialize COM if we initialized it
    if (m_comInitialized) {
        CoUninitialize();
        m_comInitialized = false;
    }
}

bool AudioCapture::Initialize(AudioDataCallback callback, const char* captureMode) {
    // Initialize COM (if not already initialized)
    HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
    if (FAILED(hr) && hr != RPC_E_CHANGED_MODE) {
        // RPC_E_CHANGED_MODE means COM was already initialized with a different mode
        // This is okay, we can still proceed
        if (hr != S_FALSE) {  // S_FALSE means already initialized, which is fine
            fprintf(stderr, "COM initialization failed: 0x%08X\n", hr);
            return false;
        }
    }
    m_comInitialized = (hr == S_OK);  // Only uninitialize if we initialized it
    
    m_callback = callback;
    
    // Create device enumerator
    hr = CoCreateInstance(
        __uuidof(MMDeviceEnumerator),
        NULL,
        CLSCTX_ALL,
        __uuidof(IMMDeviceEnumerator),
        (void**)&m_pEnumerator
    );
    
    if (FAILED(hr)) {
        fprintf(stderr, "CoCreateInstance failed: 0x%08X\n", hr);
        return false;
    }
    
    // Determine what to initialize based on captureMode
    bool wantDesktop = (strcmp(captureMode, "mic") != 0);
    bool wantMic = (strcmp(captureMode, "desktop") != 0);
    
    bool desktopOk = true;
    bool micOk = true;
    
    // Initialize desktop audio (loopback) if requested
    if (wantDesktop) {
        if (!InitializeDesktopAudio()) {
            fprintf(stderr, "Failed to initialize desktop audio\n");
            desktopOk = false;
        }
    }
    
    // Initialize microphone (capture) if requested
    if (wantMic) {
        if (!InitializeMicrophone()) {
            fprintf(stderr, "Failed to initialize microphone\n");
            micOk = false;
        }
    }
    
    // Must have at least one working source
    if (!desktopOk && !micOk) {
        fprintf(stderr, "Failed to initialize both desktop and microphone audio\n");
        return false;
    }
    
    if (!desktopOk && wantDesktop) {
        fprintf(stderr, "Warning: Desktop audio failed, continuing with microphone only\n");
    }
    if (!micOk && wantMic) {
        fprintf(stderr, "Warning: Microphone failed, continuing with desktop audio only\n");
    }
    
    return true;
}

bool AudioCapture::InitializeDesktopAudio() {
    HRESULT hr;
    
    // Get default audio renderer (loopback device)
    hr = m_pEnumerator->GetDefaultAudioEndpoint(
        eRender,
        eConsole,
        &m_pDeviceDesktop
    );
    
    if (FAILED(hr)) {
        fprintf(stderr, "GetDefaultAudioEndpoint (desktop) failed: 0x%08X\n", hr);
        return false;
    }
    
    // Activate audio client
    hr = m_pDeviceDesktop->Activate(
        __uuidof(IAudioClient),
        CLSCTX_ALL,
        NULL,
        (void**)&m_pAudioClientDesktop
    );
    
    if (FAILED(hr)) {
        fprintf(stderr, "Activate IAudioClient (desktop) failed: 0x%08X\n", hr);
        return false;
    }
    
    // Get mix format from device (system default) and use it as-is.
    // This ensures we capture exactly what the system is mixing for the endpoint
    // (e.g. 7.1 float 44100 Hz on your headset).
    hr = m_pAudioClientDesktop->GetMixFormat(&m_pwfxDesktop);
    if (FAILED(hr)) {
        fprintf(stderr, "GetMixFormat (desktop) failed: 0x%08X\n", hr);
        return false;
    }
    
    fprintf(stderr, "Desktop audio format: tag=%d, channels=%d, rate=%d, bits=%d, align=%d\n",
        m_pwfxDesktop->wFormatTag, m_pwfxDesktop->nChannels, m_pwfxDesktop->nSamplesPerSec,
        m_pwfxDesktop->wBitsPerSample, m_pwfxDesktop->nBlockAlign);
    
    // Initialize audio client for loopback
    // Use 100ms buffer duration for shared mode
    const REFERENCE_TIME REFTIMES_PER_SEC = 10000000;  // 10,000,000 = 1 second in 100-nanosecond units
    REFERENCE_TIME bufferDuration = REFTIMES_PER_SEC / 10;  // 100ms
    
    hr = m_pAudioClientDesktop->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        bufferDuration,  // Buffer duration (100ms)
        0,  // Periodicity (0 for shared mode)
        m_pwfxDesktop,
        NULL
    );
    
    if (FAILED(hr)) {
        fprintf(stderr, "IAudioClient::Initialize (desktop) failed: 0x%08X\n", hr);
        return false;
    }
    
    // Get capture client
    hr = m_pAudioClientDesktop->GetService(
        __uuidof(IAudioCaptureClient),
        (void**)&m_pCaptureClientDesktop
    );
    
    if (FAILED(hr)) {
        fprintf(stderr, "GetService IAudioCaptureClient (desktop) failed: 0x%08X\n", hr);
        return false;
    }
    
    // Create event for event-driven capture (OBS-style)
    m_hEventDesktop = CreateEvent(NULL, FALSE, FALSE, NULL);
    if (m_hEventDesktop == NULL) {
        fprintf(stderr, "CreateEvent (desktop) failed\n");
        return false;
    }
    
    // Set event handle for audio client (optional - fallback to polling if fails)
    hr = m_pAudioClientDesktop->SetEventHandle(m_hEventDesktop);
    if (FAILED(hr)) {
        fprintf(stderr, "Warning: SetEventHandle (desktop) failed: 0x%08X - will use polling fallback\n", hr);
        // Don't fail - we can still capture with polling
        CloseHandle(m_hEventDesktop);
        m_hEventDesktop = nullptr;
    }
    
    return true;
}

bool AudioCapture::InitializeMicrophone() {
    HRESULT hr;
    
    // Get default audio capture device (microphone)
    hr = m_pEnumerator->GetDefaultAudioEndpoint(
        eCapture,
        eConsole,
        &m_pDeviceMic
    );
    
    if (FAILED(hr)) {
        fprintf(stderr, "GetDefaultAudioEndpoint (mic) failed: 0x%08X\n", hr);
        return false;
    }
    
    // Activate audio client
    hr = m_pDeviceMic->Activate(
        __uuidof(IAudioClient),
        CLSCTX_ALL,
        NULL,
        (void**)&m_pAudioClientMic
    );
    
    if (FAILED(hr)) {
        fprintf(stderr, "Activate IAudioClient (mic) failed: 0x%08X\n", hr);
        return false;
    }
    
    // Get mix format for microphone
    hr = m_pAudioClientMic->GetMixFormat(&m_pwfxMic);
    if (FAILED(hr)) {
        fprintf(stderr, "GetMixFormat (mic) failed: 0x%08X\n", hr);
        return false;
    }
    
    fprintf(stderr, "Microphone format: tag=%d, channels=%d, rate=%d, bits=%d, align=%d\n",
        m_pwfxMic->wFormatTag, m_pwfxMic->nChannels, m_pwfxMic->nSamplesPerSec,
        m_pwfxMic->wBitsPerSample, m_pwfxMic->nBlockAlign);
    
    // Initialize audio client for capture (no loopback flag, but with EVENTCALLBACK)
    const REFERENCE_TIME REFTIMES_PER_SEC = 10000000;
    REFERENCE_TIME bufferDuration = REFTIMES_PER_SEC / 10;  // 100ms
    
    hr = m_pAudioClientMic->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK,  // Event-driven capture for microphone
        bufferDuration,
        0,
        m_pwfxMic,
        NULL
    );
    
    if (FAILED(hr)) {
        fprintf(stderr, "IAudioClient::Initialize (mic) failed: 0x%08X\n", hr);
        return false;
    }
    
    // Get capture client
    hr = m_pAudioClientMic->GetService(
        __uuidof(IAudioCaptureClient),
        (void**)&m_pCaptureClientMic
    );
    
    if (FAILED(hr)) {
        fprintf(stderr, "GetService IAudioCaptureClient (mic) failed: 0x%08X\n", hr);
        return false;
    }
    
    // Create event for event-driven capture (OBS-style)
    m_hEventMic = CreateEvent(NULL, FALSE, FALSE, NULL);
    if (m_hEventMic == NULL) {
        fprintf(stderr, "CreateEvent (mic) failed\n");
        return false;
    }
    
    // Set event handle for audio client (optional - fallback to polling if fails)
    hr = m_pAudioClientMic->SetEventHandle(m_hEventMic);
    if (FAILED(hr)) {
        fprintf(stderr, "Warning: SetEventHandle (mic) failed: 0x%08X - will use polling fallback\n", hr);
        // Don't fail - we can still capture with polling
        CloseHandle(m_hEventMic);
        m_hEventMic = nullptr;
    }
    
    return true;
}

bool AudioCapture::Start() {
    // Must have at least one audio client
    if (m_isCapturing || (!m_pAudioClientDesktop && !m_pAudioClientMic)) {
        fprintf(stderr, "Start failed: already capturing or no audio clients\n");
        return false;
    }
    
    fprintf(stderr, "Starting audio capture...\n");
    if (m_pAudioClientDesktop) {
        fprintf(stderr, "  Desktop audio: available\n");
    }
    if (m_pAudioClientMic) {
        fprintf(stderr, "  Microphone: available\n");
    }
    
    // Reset mixing state
    m_desktopFramesReady = 0;
    m_micFramesReady = 0;
    m_desktopBuffer.clear();
    m_micBuffer.clear();
    
    // Start desktop audio capture if available
    if (m_pAudioClientDesktop) {
        HRESULT hr = m_pAudioClientDesktop->Start();
        if (FAILED(hr)) {
            fprintf(stderr, "Failed to start desktop audio capture: 0x%08X\n", hr);
            // Continue if we have microphone
            if (!m_pAudioClientMic) {
                return false;
            }
        } else {
            fprintf(stderr, "Desktop audio capture started successfully\n");
        }
    }
    
    // Start microphone capture if available
    if (m_pAudioClientMic) {
        HRESULT hr = m_pAudioClientMic->Start();
        if (FAILED(hr)) {
            fprintf(stderr, "Failed to start microphone capture: 0x%08X\n", hr);
            // Continue if we have desktop
            if (!m_pAudioClientDesktop) {
                return false;
            }
        } else {
            fprintf(stderr, "Microphone capture started successfully\n");
        }
    }
    
    m_shouldStop = false;
    m_isCapturing = true;
    
    // Start capture threads with proper priority
    if (m_pAudioClientDesktop) {
        fprintf(stderr, "Starting desktop capture thread...\n");
        m_captureThreadDesktop = std::thread(&AudioCapture::CaptureThreadDesktop, this);
        // Set thread priority to TIME_CRITICAL (OBS-style)
        SetThreadPriority(m_captureThreadDesktop.native_handle(), THREAD_PRIORITY_TIME_CRITICAL);
        fprintf(stderr, "Desktop capture thread started\n");
    }
    if (m_pAudioClientMic) {
        fprintf(stderr, "Starting microphone capture thread...\n");
        m_captureThreadMic = std::thread(&AudioCapture::CaptureThreadMic, this);
        // Set thread priority to TIME_CRITICAL (OBS-style)
        SetThreadPriority(m_captureThreadMic.native_handle(), THREAD_PRIORITY_TIME_CRITICAL);
        fprintf(stderr, "Microphone capture thread started\n");
    }
    
    fprintf(stderr, "Audio capture started successfully\n");
    return true;
}

void AudioCapture::Stop() {
    if (!m_isCapturing) {
        return;
    }
    
    m_shouldStop = true;
    
    if (m_pAudioClientDesktop) {
        m_pAudioClientDesktop->Stop();
    }
    
    if (m_pAudioClientMic) {
        m_pAudioClientMic->Stop();
    }
    
    if (m_captureThreadDesktop.joinable()) {
        m_captureThreadDesktop.join();
    }
    
    if (m_captureThreadMic.joinable()) {
        m_captureThreadMic.join();
    }
    
    m_isCapturing = false;
}

void AudioCapture::CaptureThreadDesktop() {
    // Set thread priority to TIME_CRITICAL (OBS-style)
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    
    UINT32 packetLength = 0;
    BYTE* pData = nullptr;
    DWORD flags = 0;
    
    while (!m_shouldStop) {
        // Event-driven capture (OBS-style) - wait for audio event
        if (m_hEventDesktop) {
            DWORD waitResult = WaitForSingleObject(m_hEventDesktop, 100);  // 100ms timeout
            if (waitResult != WAIT_OBJECT_0) {
                // Timeout or error - continue loop to check m_shouldStop
                continue;
            }
        } else {
            // Fallback to polling if event handle not available
            Sleep(10);
        }
        
        // Drain ALL available packets (OBS-style)
        while (!m_shouldStop) {
            // Get next packet size (in FRAMES)
            HRESULT hr = m_pCaptureClientDesktop->GetNextPacketSize(&packetLength);
            
            if (FAILED(hr) || packetLength == 0) {
                break;  // No more packets available
            }
            
            // Get buffer
            hr = m_pCaptureClientDesktop->GetBuffer(
                &pData,
                &packetLength,  // FRAMES
                &flags,
                NULL,
                NULL
            );
            
            if (FAILED(hr)) {
                break;
            }
            
            // packetLength is a FRAME count, not a byte count
            UINT32 numFrames = packetLength;
            size_t dataSize = static_cast<size_t>(numFrames) * m_pwfxDesktop->nBlockAlign;
            
            {
                std::lock_guard<std::mutex> lock(m_mixMutex);
                
                m_desktopBuffer.resize(dataSize);
                
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                    // Silent buffer -> fill with zeros but KEEP timing (no time compression)
                    memset(m_desktopBuffer.data(), 0, dataSize);
                } else if (pData && dataSize > 0) {
                    memcpy(m_desktopBuffer.data(), pData, dataSize);
                }
                
                m_desktopFramesReady = numFrames;
            }
            
            if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) {
                // Data discontinuity - log but continue
                fprintf(stderr, "Warning: Data discontinuity detected in desktop audio\n");
            }
            
            // Try to mix and callback (outside the mutex)
            MixAndCallback();
            
            // Release buffer
            m_pCaptureClientDesktop->ReleaseBuffer(packetLength);
        }
    }
}

void AudioCapture::CaptureThreadMic() {
    if (!m_pCaptureClientMic) {
        return;
    }
    
    // Set thread priority to TIME_CRITICAL (OBS-style)
    SetThreadPriority(GetCurrentThread(), THREAD_PRIORITY_TIME_CRITICAL);
    
    UINT32 packetLength = 0;
    BYTE* pData = nullptr;
    DWORD flags = 0;
    
    while (!m_shouldStop) {
        // Event-driven capture (OBS-style) - wait for audio event
        if (m_hEventMic) {
            DWORD waitResult = WaitForSingleObject(m_hEventMic, 100);  // 100ms timeout
            if (waitResult != WAIT_OBJECT_0) {
                // Timeout or error - continue loop to check m_shouldStop
                continue;
            }
        } else {
            // Fallback to polling if event handle not available
            Sleep(10);
        }
        
        // Drain ALL available packets (OBS-style)
        while (!m_shouldStop) {
            // Get next packet size (in FRAMES)
            HRESULT hr = m_pCaptureClientMic->GetNextPacketSize(&packetLength);
            
            if (FAILED(hr) || packetLength == 0) {
                break;  // No more packets available
            }
            
            // Get buffer
            hr = m_pCaptureClientMic->GetBuffer(
                &pData,
                &packetLength,  // FRAMES
                &flags,
                NULL,
                NULL
            );
            
            if (FAILED(hr)) {
                break;
            }
            
            // packetLength is a FRAME count, not a byte count
            UINT32 numFrames = packetLength;
            size_t dataSize = static_cast<size_t>(numFrames) * m_pwfxMic->nBlockAlign;
            
            {
                std::lock_guard<std::mutex> lock(m_mixMutex);
                
                m_micBuffer.resize(dataSize);
                
                if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                    // Silent buffer -> fill with zeros but KEEP timing (no time compression)
                    memset(m_micBuffer.data(), 0, dataSize);
                } else if (pData && dataSize > 0) {
                    memcpy(m_micBuffer.data(), pData, dataSize);
                }
                
                m_micFramesReady = numFrames;
            }
            
            if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) {
                // Data discontinuity - log but continue
                fprintf(stderr, "Warning: Data discontinuity detected in microphone audio\n");
            }
            
            // Try to mix and callback (outside the mutex)
            MixAndCallback();
            
            // Release buffer
            m_pCaptureClientMic->ReleaseBuffer(packetLength);
        }
    }
}

void AudioCapture::MixAndCallback() {
    if (!m_callback) {
        return;
    }
    
    // Determine output format (prefer desktop, fallback to mic)
    WAVEFORMATEX* outputFormat = m_pwfxDesktop ? m_pwfxDesktop : m_pwfxMic;
    if (!outputFormat) {
        return;
    }
    
    // Handle microphone-only mode
    if (!m_pAudioClientDesktop && m_pAudioClientMic && m_micFramesReady > 0) {
        // Direct callback with microphone data
        size_t outputSize = m_micFramesReady * m_pwfxMic->nBlockAlign;
        if (outputSize > 0 && m_micBuffer.size() >= outputSize) {
            m_callback(m_micBuffer.data(), m_micFramesReady, 0);
            m_micFramesReady = 0;
        }
        return;
    }
    
    // Handle desktop-only mode
    if (m_pAudioClientDesktop && !m_pAudioClientMic && m_desktopFramesReady > 0) {
        // Direct callback with desktop data
        size_t outputSize = m_desktopFramesReady * m_pwfxDesktop->nBlockAlign;
        if (outputSize > 0 && m_desktopBuffer.size() >= outputSize) {
            m_callback(m_desktopBuffer.data(), m_desktopFramesReady, 0);
            m_desktopFramesReady = 0;
        }
        return;
    }
    
    // Handle mixed mode (both desktop and mic)
    if (m_desktopFramesReady == 0) {
        return;
    }
    
    // Use desktop audio format as the output format
    UINT32 outputFrames = m_desktopFramesReady;
    size_t outputSize = outputFrames * m_pwfxDesktop->nBlockAlign;
    
    // Ensure we have a valid size (at least one complete frame)
    if (outputSize < m_pwfxDesktop->nBlockAlign) {
        return;
    }
    
    m_mixBuffer.resize(outputSize);
    
    // Copy desktop audio to mix buffer
    memcpy(m_mixBuffer.data(), m_desktopBuffer.data(), outputSize);
    
    // Mix microphone audio if available
    if (m_pwfxMic && m_micFramesReady > 0 && !m_micBuffer.empty()) {
        ConvertAndMixMicToDesktopFormat(m_micBuffer.data(), m_micFramesReady);
    }
    
    // Only call callback if we have valid data
    if (outputSize > 0 && m_mixBuffer.size() >= outputSize) {
        m_callback(m_mixBuffer.data(), outputFrames, 0);
    }
    
    // Reset ready flags
    m_desktopFramesReady = 0;
    m_micFramesReady = 0;
}

void AudioCapture::ConvertAndMixMicToDesktopFormat(const BYTE* micData, UINT32 micFrames) {
    if (!m_pwfxDesktop || !m_pwfxMic || !micData) {
        return;
    }
    
    // For simplicity, we'll do basic mixing assuming:
    // - Both are 16-bit PCM (most common)
    // - Same sample rate (or we'll just mix what we have)
    // - We'll mix to match desktop format
    
    if (m_pwfxDesktop->wBitsPerSample != 16 || m_pwfxMic->wBitsPerSample != 16) {
        // Only support 16-bit for now
        return;
    }
    
    // Calculate how many frames we can mix
    UINT32 framesToMix = std::min(micFrames, m_desktopFramesReady);
    if (framesToMix == 0) {
        return;
    }
    
    // Get pointers to 16-bit samples
    int16_t* desktopSamples = reinterpret_cast<int16_t*>(m_mixBuffer.data());
    const int16_t* micSamples = reinterpret_cast<const int16_t*>(micData);
    
    // Calculate samples per frame for both
    UINT32 desktopSamplesPerFrame = m_pwfxDesktop->nChannels;
    UINT32 micSamplesPerFrame = m_pwfxMic->nChannels;
    
    // Mix samples (simple addition with clamping)
    for (UINT32 frame = 0; frame < framesToMix; frame++) {
        for (UINT32 ch = 0; ch < desktopSamplesPerFrame; ch++) {
            int32_t desktopSample = desktopSamples[frame * desktopSamplesPerFrame + ch];
            
            // Get corresponding mic sample (handle channel mismatch)
            int32_t micSample = 0;
            if (ch < micSamplesPerFrame) {
                micSample = micSamples[frame * micSamplesPerFrame + ch];
            } else if (micSamplesPerFrame == 1 && desktopSamplesPerFrame >= 2) {
                // Mono mic to stereo desktop - duplicate channel
                micSample = micSamples[frame];
            }
            
            // Mix with proper scaling to prevent clipping
            // Use average mixing (divide by 2) to prevent overflow
            // This prevents distortion when both sources are loud
            int32_t mixed = (desktopSample + micSample) / 2;
            
            // Clamp to prevent overflow (shouldn't happen with division, but safety check)
            if (mixed > 32767) mixed = 32767;
            if (mixed < -32768) mixed = -32768;
            
            desktopSamples[frame * desktopSamplesPerFrame + ch] = static_cast<int16_t>(mixed);
        }
    }
}

void AudioCapture::Cleanup() {
    // Cleanup desktop audio
    if (m_hEventDesktop) {
        CloseHandle(m_hEventDesktop);
        m_hEventDesktop = nullptr;
    }
    
    if (m_pCaptureClientDesktop) {
        m_pCaptureClientDesktop->Release();
        m_pCaptureClientDesktop = nullptr;
    }
    
    if (m_pAudioClientDesktop) {
        m_pAudioClientDesktop->Release();
        m_pAudioClientDesktop = nullptr;
    }
    
    if (m_pDeviceDesktop) {
        m_pDeviceDesktop->Release();
        m_pDeviceDesktop = nullptr;
    }
    
    if (m_pwfxDesktop) {
        CoTaskMemFree(m_pwfxDesktop);
        m_pwfxDesktop = nullptr;
    }
    
    // Cleanup microphone
    if (m_hEventMic) {
        CloseHandle(m_hEventMic);
        m_hEventMic = nullptr;
    }
    
    if (m_pCaptureClientMic) {
        m_pCaptureClientMic->Release();
        m_pCaptureClientMic = nullptr;
    }
    
    if (m_pAudioClientMic) {
        m_pAudioClientMic->Release();
        m_pAudioClientMic = nullptr;
    }
    
    if (m_pDeviceMic) {
        m_pDeviceMic->Release();
        m_pDeviceMic = nullptr;
    }
    
    if (m_pwfxMic) {
        CoTaskMemFree(m_pwfxMic);
        m_pwfxMic = nullptr;
    }
    
    if (m_pEnumerator) {
        m_pEnumerator->Release();
        m_pEnumerator = nullptr;
    }
}

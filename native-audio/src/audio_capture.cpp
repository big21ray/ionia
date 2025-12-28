#include "audio_capture.h"
#include <iostream>
#include <comdef.h>
#include <propidl.h>
#include <propkey.h>
#include <stdio.h>
#include <algorithm>
#include <cmath>
#include <cstring>
#include <mmreg.h>  // For WAVEFORMATEXTENSIBLE

// Helper function to check if format is IEEE float (handles both WAVE_FORMAT_IEEE_FLOAT and WAVE_FORMAT_EXTENSIBLE)
static bool IsFloatFormat(const WAVEFORMATEX* format) {
    if (!format) return false;
    
    if (format->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) {
        return true;
    }
    
    if (format->wFormatTag == WAVE_FORMAT_EXTENSIBLE && format->cbSize >= 22) {
        // Cast to WAVEFORMATEXTENSIBLE to check SubFormat
        const WAVEFORMATEXTENSIBLE* extensible = reinterpret_cast<const WAVEFORMATEXTENSIBLE*>(format);
        // KSDATAFORMAT_SUBTYPE_IEEE_FLOAT = {00000003-0000-0010-8000-00AA00389B71}
        const GUID KSDATAFORMAT_SUBTYPE_IEEE_FLOAT_GUID = 
            {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xAA, 0x00, 0x38, 0x9B, 0x71}};
        return IsEqualGUID(extensible->SubFormat, KSDATAFORMAT_SUBTYPE_IEEE_FLOAT_GUID);
    }
    
    return false;
}

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
    , m_pwfxUnified(nullptr)
    , m_isCapturing(false)
    , m_shouldStop(false)
    , m_comInitialized(false)
    , m_desktopFramesReady(0)
    , m_micFramesReady(0)
    , m_captureMode("both")
{
    // Initialize unified frames
    m_desktopFrame.numFrames = 0;
    m_micFrame.numFrames = 0;
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
    if (hr == RPC_E_CHANGED_MODE) {
        // COM is already initialized in STA mode - this is expected in Electron
        fprintf(stderr, "[AudioCapture] COM already in STA mode (RPC_E_CHANGED_MODE) - continuing\n");
    } else if (hr == S_FALSE) {
        // COM was already initialized in MTA mode
        fprintf(stderr, "[AudioCapture] COM already initialized in MTA mode\n");
    } else if (hr == S_OK) {
        // We successfully initialized COM in MTA mode
        fprintf(stderr, "[AudioCapture] COM initialized in MTA mode\n");
    } else if (FAILED(hr)) {
        fprintf(stderr, "[AudioCapture] COM initialization failed: 0x%08X\n", hr);
        return false;
    }
    m_comInitialized = (hr == S_OK);  // Only uninitialize if we initialized it
    
    m_callback = callback;
    m_captureMode = captureMode ? std::string(captureMode) : std::string("both");
    
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
        // In "both" mode, if desktop format is available, try to use the SAME format
        // for the microphone so both streams share the same sample rate.
        if (m_captureMode == "both" && m_pwfxDesktop) {
            if (!InitializeMicrophone(m_pwfxDesktop)) {
                fprintf(stderr, "Failed to initialize microphone with desktop format in BOTH mode\n");
                micOk = false;
            }
        } else {
            // In "mic" mode or when desktop is not available, use mic's native mix format
            if (!InitializeMicrophone()) {
                fprintf(stderr, "Failed to initialize microphone\n");
                micOk = false;
            }
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
    
    // Initialize unified format: 48000 Hz, stereo, float32
    m_pwfxUnified = (WAVEFORMATEX*)CoTaskMemAlloc(sizeof(WAVEFORMATEX));
    if (!m_pwfxUnified) {
        fprintf(stderr, "Failed to allocate memory for unified format\n");
        return false;
    }
    m_pwfxUnified->wFormatTag = WAVE_FORMAT_IEEE_FLOAT;
    m_pwfxUnified->nChannels = TARGET_CHANNELS;
    m_pwfxUnified->nSamplesPerSec = TARGET_SAMPLE_RATE;
    m_pwfxUnified->wBitsPerSample = 32;
    m_pwfxUnified->nBlockAlign = TARGET_CHANNELS * sizeof(float);  // 8 bytes per frame
    m_pwfxUnified->nAvgBytesPerSec = TARGET_SAMPLE_RATE * m_pwfxUnified->nBlockAlign;
    m_pwfxUnified->cbSize = 0;
    
    fprintf(stderr, "Unified audio format: %u Hz, %u channels, float32\n",
            TARGET_SAMPLE_RATE, TARGET_CHANNELS);
    
    return true;
}

WAVEFORMATEX* AudioCapture::GetFormat() {
    return m_pwfxUnified;
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
    
    // Get mix format from device (system default)
    // (e.g. 7.1 float 44100 Hz on your headset).
    hr = m_pAudioClientDesktop->GetMixFormat(&m_pwfxDesktop);
    if (FAILED(hr)) {
        fprintf(stderr, "GetMixFormat (desktop) failed: 0x%08X\n", hr);
        return false;
    }
    
    fprintf(stderr, "Desktop audio format (native): tag=%d, channels=%d, rate=%d, bits=%d, align=%d\n",
        m_pwfxDesktop->wFormatTag, m_pwfxDesktop->nChannels, m_pwfxDesktop->nSamplesPerSec,
        m_pwfxDesktop->wBitsPerSample, m_pwfxDesktop->nBlockAlign);
    
    // ADVANCED MODE (OBS-style): try to force desktop mix to a stable 48000 Hz
    // float stereo format. This makes it much easier to mix with a 48000 Hz mic.
    //
    // We build a simple WAVEFORMATEX for 2ch, 48000 Hz, 32‑bit float and ask
    // WASAPI if it's supported in shared mode. If yes, we use it for Initialize.
    //
    // This does NOT change the user-visible device properties; it's only for
    // this audio client.
    WAVEFORMATEX desiredFormat = {};
    desiredFormat.wFormatTag = WAVE_FORMAT_IEEE_FLOAT; // 32‑bit float PCM
    desiredFormat.nChannels = 2;                       // stereo
    desiredFormat.nSamplesPerSec = 48000;              // 48 kHz
    desiredFormat.wBitsPerSample = 32;                 // 32‑bit float
    desiredFormat.nBlockAlign = desiredFormat.nChannels * (desiredFormat.wBitsPerSample / 8);
    desiredFormat.nAvgBytesPerSec = desiredFormat.nSamplesPerSec * desiredFormat.nBlockAlign;
    desiredFormat.cbSize = 0;

    const WAVEFORMATEX* formatToUse = m_pwfxDesktop;
    WAVEFORMATEX* closestDesktop = nullptr;

    hr = m_pAudioClientDesktop->IsFormatSupported(
        AUDCLNT_SHAREMODE_SHARED,
        &desiredFormat,
        &closestDesktop
    );

    if (hr == S_OK) {
        // Device can output directly in 48k stereo float
        formatToUse = &desiredFormat;
        fprintf(stderr,
            "Desktop will use FORCED 48000 Hz stereo float format: tag=%d, channels=%d, rate=%d, bits=%d, align=%d\n",
            formatToUse->wFormatTag, formatToUse->nChannels, formatToUse->nSamplesPerSec,
            formatToUse->wBitsPerSample, formatToUse->nBlockAlign);
    } else if (hr == S_FALSE && closestDesktop) {
        // Device suggests a closest supported format (may already be 48k / stereo)
        formatToUse = closestDesktop;
        fprintf(stderr,
            "Desktop will use CLOSEST supported format: tag=%d, channels=%d, rate=%d, bits=%d, align=%d\n",
            formatToUse->wFormatTag, formatToUse->nChannels, formatToUse->nSamplesPerSec,
            formatToUse->wBitsPerSample, formatToUse->nBlockAlign);
    } else {
        // Fallback: use native mix format
        fprintf(stderr,
            "Desktop: forced 48000 Hz stereo float format not supported, using native mix format.\n");
        formatToUse = m_pwfxDesktop;
    }
    
    // Initialize audio client for loopback
    // Use 100ms buffer duration for shared mode
    const REFERENCE_TIME REFTIMES_PER_SEC = 10000000;  // 10,000,000 = 1 second in 100-nanosecond units
    REFERENCE_TIME bufferDuration = REFTIMES_PER_SEC / 10;  // 100ms
    
    hr = m_pAudioClientDesktop->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_LOOPBACK | AUDCLNT_STREAMFLAGS_EVENTCALLBACK,
        bufferDuration,  // Buffer duration (100ms)
        0,  // Periodicity (0 for shared mode)
        formatToUse,
        NULL
    );
    
    if (FAILED(hr)) {
        fprintf(stderr, "IAudioClient::Initialize (desktop) failed: 0x%08X\n", hr);
        return false;
    }

    // If we used a different format than the native m_pwfxDesktop, make sure
    // m_pwfxDesktop reflects the ACTUAL format the client is using. This keeps
    // GetFormat()/GetSampleRate consistent with what we really capture.
    if (formatToUse != m_pwfxDesktop) {
        if (m_pwfxDesktop) {
            CoTaskMemFree(m_pwfxDesktop);
            m_pwfxDesktop = nullptr;
        }
        size_t allocSize = sizeof(WAVEFORMATEX);
        if (formatToUse->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
            allocSize += formatToUse->cbSize;
        }
        m_pwfxDesktop = (WAVEFORMATEX*)CoTaskMemAlloc(allocSize);
        if (!m_pwfxDesktop) {
            fprintf(stderr, "Failed to allocate memory for desktop format copy\n");
            return false;
        }
        memcpy(m_pwfxDesktop, formatToUse, allocSize);
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

bool AudioCapture::InitializeMicrophone(const WAVEFORMATEX* targetFormat) {
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
    
    // Get native mix format for microphone
    hr = m_pAudioClientMic->GetMixFormat(&m_pwfxMic);
    if (FAILED(hr)) {
        fprintf(stderr, "GetMixFormat (mic) failed: 0x%08X\n", hr);
        return false;
    }
    
    fprintf(stderr, "Microphone native format: tag=%d, channels=%d, rate=%d, bits=%d, align=%d\n",
        m_pwfxMic->wFormatTag, m_pwfxMic->nChannels, m_pwfxMic->nSamplesPerSec,
        m_pwfxMic->wBitsPerSample, m_pwfxMic->nBlockAlign);
    
    // Decide which format to actually use for the microphone stream.
    // - If targetFormat is provided (e.g. desktop mix format in BOTH mode),
    //   try to use it so both streams share the SAME sample rate.
    // - Otherwise, fall back to the mic's own mix format.
    const WAVEFORMATEX* formatToUse = m_pwfxMic;
    WAVEFORMATEX* closest = nullptr;
    
    if (targetFormat) {
        HRESULT hrTest = m_pAudioClientMic->IsFormatSupported(
            AUDCLNT_SHAREMODE_SHARED,
            targetFormat,
            &closest
        );
        
        if (hrTest == S_OK) {
            // Desktop format is directly supported for the mic
            formatToUse = targetFormat;
            fprintf(stderr, "Microphone will use DESKTOP format: tag=%d, channels=%d, rate=%d, bits=%d, align=%d\n",
                formatToUse->wFormatTag, formatToUse->nChannels, formatToUse->nSamplesPerSec,
                formatToUse->wBitsPerSample, formatToUse->nBlockAlign);
        } else if (hrTest == S_FALSE && closest) {
            // A closest match is provided; use it
            formatToUse = closest;
            fprintf(stderr, "Microphone will use CLOSEST format to desktop: tag=%d, channels=%d, rate=%d, bits=%d, align=%d\n",
                formatToUse->wFormatTag, formatToUse->nChannels, formatToUse->nSamplesPerSec,
                formatToUse->wBitsPerSample, formatToUse->nBlockAlign);
        } else {
            fprintf(stderr, "Microphone: desktop format not supported, using native mic format instead.\n");
        }
    }
    
    // Initialize audio client for capture (no loopback flag, but with EVENTCALLBACK)
    const REFERENCE_TIME REFTIMES_PER_SEC = 10000000;
    REFERENCE_TIME bufferDuration = REFTIMES_PER_SEC / 10;  // 100ms
    
    hr = m_pAudioClientMic->Initialize(
        AUDCLNT_SHAREMODE_SHARED,
        AUDCLNT_STREAMFLAGS_EVENTCALLBACK,  // Event-driven capture for microphone
        bufferDuration,
        0,
        formatToUse,
        NULL
    );
    
    if (FAILED(hr)) {
        fprintf(stderr, "IAudioClient::Initialize (mic) failed: 0x%08X\n", hr);
        return false;
    }
    
    // If we used a different format than the native m_pwfxMic, make sure m_pwfxMic
    // reflects the ACTUAL format we asked WASAPI to use. This keeps GetFormat()
    // and friends consistent with the mixed stream.
    if (formatToUse != m_pwfxMic) {
        if (m_pwfxMic) {
            CoTaskMemFree(m_pwfxMic);
            m_pwfxMic = nullptr;
        }
        // Allocate and copy formatToUse into m_pwfxMic
        size_t allocSize = sizeof(WAVEFORMATEX);
        if (formatToUse->wFormatTag == WAVE_FORMAT_EXTENSIBLE) {
            // WAVEFORMATEXTENSIBLE has extra bytes described by cbSize
            allocSize += formatToUse->cbSize;
        }
        m_pwfxMic = (WAVEFORMATEX*)CoTaskMemAlloc(allocSize);
        if (!m_pwfxMic) {
            fprintf(stderr, "Failed to allocate memory for microphone format copy\n");
            return false;
        }
        memcpy(m_pwfxMic, formatToUse, allocSize);
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
    m_desktopFrame.numFrames = 0;
    m_desktopFrame.samples.clear();
    m_micFrame.numFrames = 0;
    m_micFrame.samples.clear();
    
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
            
            // Process audio through pipeline: WASAPI → Unified AudioFrame (48k float32 stereo)
            UnifiedAudioFrame processedFrame;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                // Silent buffer: create zero-filled frame with correct timing
                std::vector<BYTE> silentData(dataSize, 0);
                ProcessAudioFrame(silentData.data(), numFrames, m_pwfxDesktop, processedFrame);
            } else if (pData && dataSize > 0) {
                ProcessAudioFrame(pData, numFrames, m_pwfxDesktop, processedFrame);
            }
            
            // Send processed audio (resampled to 48k, stereo) to callback
            if (processedFrame.numFrames > 0 && !processedFrame.samples.empty() && m_callback) {
                // Convert float samples to byte buffer
                size_t bufferSize = processedFrame.samples.size() * sizeof(float);
                const BYTE* buffer = reinterpret_cast<const BYTE*>(processedFrame.samples.data());
                // Pass unified format (always 48000 Hz, stereo, float32)
                m_callback(buffer, processedFrame.numFrames, "desktop", m_pwfxUnified);
            }
            
            if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) {
                // Data discontinuity - log but continue
                fprintf(stderr, "Warning: Data discontinuity detected in desktop audio\n");
            }
            
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
            
            // Process audio through pipeline: WASAPI → Unified AudioFrame (48k float32 stereo)
            UnifiedAudioFrame processedFrame;
            if (flags & AUDCLNT_BUFFERFLAGS_SILENT) {
                // Silent buffer: create zero-filled frame with correct timing
                std::vector<BYTE> silentData(dataSize, 0);
                ProcessAudioFrame(silentData.data(), numFrames, m_pwfxMic, processedFrame);
            } else if (pData && dataSize > 0) {
                ProcessAudioFrame(pData, numFrames, m_pwfxMic, processedFrame);
            }
            
            // Send processed audio (resampled to 48k, stereo) to callback
            if (processedFrame.numFrames > 0 && !processedFrame.samples.empty() && m_callback) {
                // Convert float samples to byte buffer
                size_t bufferSize = processedFrame.samples.size() * sizeof(float);
                const BYTE* buffer = reinterpret_cast<const BYTE*>(processedFrame.samples.data());
                // Pass unified format (always 48000 Hz, stereo, float32)
                m_callback(buffer, processedFrame.numFrames, "mic", m_pwfxUnified);
            }
            
            if (flags & AUDCLNT_BUFFERFLAGS_DATA_DISCONTINUITY) {
                // Data discontinuity - log but continue
                fprintf(stderr, "Warning: Data discontinuity detected in microphone audio\n");
            }
            
            // Release buffer
            m_pCaptureClientMic->ReleaseBuffer(packetLength);
        }
    }
}

// ============================================================================
// Audio Processing Pipeline: WASAPI → Unified AudioFrame (48k float32 stereo)
// ============================================================================

void AudioCapture::ConvertToFloat32(
    const BYTE* inData, UINT32 inFrames, const WAVEFORMATEX* inFormat,
    std::vector<float>& outFloat
) {
    if (!inData || !inFormat || inFrames == 0) {
        outFloat.clear();
        return;
    }
    
    const UINT32 channels = inFormat->nChannels;
    const UINT32 totalSamples = inFrames * channels;
    outFloat.resize(totalSamples);
    
    if (inFormat->wBitsPerSample == 32 && IsFloatFormat(inFormat)) {
        // Already float32, just copy
        memcpy(outFloat.data(), inData, totalSamples * sizeof(float));
    } else if (inFormat->wBitsPerSample == 16) {
        // Convert 16-bit int to float32
        const int16_t* samples = reinterpret_cast<const int16_t*>(inData);
        for (UINT32 i = 0; i < totalSamples; i++) {
            outFloat[i] = static_cast<float>(samples[i]) / 32768.0f;
        }
    } else {
        // Unsupported format
        fprintf(stderr, "ConvertToFloat32: unsupported format - tag=%d, bits=%d\n",
                inFormat->wFormatTag, inFormat->wBitsPerSample);
        outFloat.clear();
    }
}

void AudioCapture::ResampleToTarget(
    const std::vector<float>& inFloat, UINT32 inFrames, UINT32 inChannels, UINT32 inRate,
    std::vector<float>& outFloat, UINT32& outFrames
) {
    if (inFloat.empty() || inFrames == 0 || inChannels == 0) {
        outFrames = 0;
        outFloat.clear();
        return;
    }
    
    // If already at target rate, just copy
    if (inRate == TARGET_SAMPLE_RATE) {
        outFloat = inFloat;
        outFrames = inFrames;
        return;
    }
    
    // Linear interpolation resampling
    // Ratio: how many input frames per output frame
    // For upsampling (44100 -> 48000): ratio = 44100/48000 = 0.91875
    // For downsampling (96000 -> 48000): ratio = 96000/48000 = 2.0
    double ratio = static_cast<double>(inRate) / static_cast<double>(TARGET_SAMPLE_RATE);
    
    // Calculate output frames: inFrames * (TARGET / inRate)
    // Example: 441 frames @ 44100 Hz -> 441 * (48000/44100) = 480 frames @ 48000 Hz
    outFrames = static_cast<UINT32>(std::ceil(static_cast<double>(inFrames) * TARGET_SAMPLE_RATE / static_cast<double>(inRate)));
    if (outFrames == 0) {
        outFrames = 1;  // At least one frame
    }
    
    const UINT32 outSamples = outFrames * inChannels;
    outFloat.resize(outSamples);
    
    // Resample: for each output frame, find corresponding input position
    for (UINT32 outFrame = 0; outFrame < outFrames; ++outFrame) {
        // Calculate input position: outFrame * (inRate / TARGET)
        // This gives us the position in input frames
        double inPos = static_cast<double>(outFrame) * ratio;
        UINT32 i0 = static_cast<UINT32>(inPos);
        UINT32 i1 = std::min(i0 + 1, inFrames - 1);
        float t = static_cast<float>(inPos - static_cast<double>(i0));
        
        // Clamp i0 to valid range
        if (i0 >= inFrames) {
            i0 = inFrames - 1;
            i1 = inFrames - 1;
            t = 0.0f;
        }
        
        // Linear interpolation for each channel
        for (UINT32 ch = 0; ch < inChannels; ++ch) {
            float s0 = inFloat[i0 * inChannels + ch];
            float s1 = inFloat[i1 * inChannels + ch];
            outFloat[outFrame * inChannels + ch] = s0 + (s1 - s0) * t;
        }
    }
    
    // Debug log (first few times only)
    static int resampleLogCount = 0;
    if (resampleLogCount < 3) {
        fprintf(stderr, "ResampleToTarget: %u frames @ %u Hz -> %u frames @ %u Hz (ratio=%.6f)\n",
                inFrames, inRate, outFrames, TARGET_SAMPLE_RATE, ratio);
        resampleLogCount++;
    }
}

void AudioCapture::AdaptChannels(
    const std::vector<float>& inFloat, UINT32 inFrames, UINT32 inChannels,
    std::vector<float>& outFloat, UINT32& outFrames
) {
    if (inFloat.empty() || inFrames == 0) {
        outFrames = 0;
        outFloat.clear();
        return;
    }
    
    outFrames = inFrames;
    
    // If already stereo, just copy
    if (inChannels == TARGET_CHANNELS) {
        outFloat = inFloat;
        return;
    }
    
    // Convert to stereo
    outFloat.resize(outFrames * TARGET_CHANNELS);
    
    if (inChannels == 1) {
        // Mono → Stereo: duplicate channel
        for (UINT32 frame = 0; frame < outFrames; frame++) {
            float mono = inFloat[frame];
            outFloat[frame * 2 + 0] = mono;  // Left
            outFloat[frame * 2 + 1] = mono;  // Right
        }
    } else if (inChannels > TARGET_CHANNELS) {
        // Multi-channel → Stereo: use ONLY front-left (ch0) and front-right (ch1)
        // This works for 5.1, 7.1 surround formats where FL/FR are first two channels
        for (UINT32 frame = 0; frame < outFrames; frame++) {
            outFloat[frame * 2 + 0] = inFloat[frame * inChannels + 0];  // Front Left
            outFloat[frame * 2 + 1] = inFloat[frame * inChannels + 1];  // Front Right
        }
    } else {
        // Should not happen (inChannels < 2 but != 1)
        outFloat.clear();
        outFrames = 0;
    }
}

void AudioCapture::ProcessAudioFrame(
    const BYTE* inData, UINT32 inFrames, const WAVEFORMATEX* inFormat,
    UnifiedAudioFrame& outFrame
) {
    if (!inData || !inFormat || inFrames == 0) {
        outFrame.numFrames = 0;
        outFrame.samples.clear();
        return;
    }
    
    // Step 1: Convert to float32
    std::vector<float> float32;
    ConvertToFloat32(inData, inFrames, inFormat, float32);
    if (float32.empty()) {
        outFrame.numFrames = 0;
        outFrame.samples.clear();
        return;
    }
    
    // Step 2: Resample to target (48000 Hz)
    std::vector<float> resampled;
    UINT32 resampledFrames = 0;
    ResampleToTarget(float32, inFrames, inFormat->nChannels, inFormat->nSamplesPerSec,
                     resampled, resampledFrames);
    if (resampled.empty()) {
        outFrame.numFrames = 0;
        outFrame.samples.clear();
        return;
    }
    
    // Step 3: Adapt channels to stereo
    // Note: resampled still has inFormat->nChannels (resampling doesn't change channel count)
    AdaptChannels(resampled, resampledFrames, inFormat->nChannels,
                  outFrame.samples, outFrame.numFrames);
    
    // CRITICAL VERIFICATION: outFrame.numFrames MUST equal resampledFrames
    // If not, we're using wrong frame count somewhere
    if (outFrame.numFrames != resampledFrames) {
        fprintf(stderr, "ERROR: ProcessAudioFrame frame mismatch! resampledFrames=%u, outFrame.numFrames=%u\n",
                resampledFrames, outFrame.numFrames);
    }
    
    // Debug log (first few times only)
    static int processLogCount = 0;
    if (processLogCount < 3) {
        fprintf(stderr, "ProcessAudioFrame: %u frames @ %u Hz, %u ch -> %u frames @ %u Hz, %u ch\n",
                inFrames, inFormat->nSamplesPerSec, inFormat->nChannels,
                outFrame.numFrames, TARGET_SAMPLE_RATE, TARGET_CHANNELS);
        fprintf(stderr, "  VERIFY: inFrames=%u, resampledFrames=%u, outFrame.numFrames=%u (should be equal)\n",
                inFrames, resampledFrames, outFrame.numFrames);
        processLogCount++;
    }
}

// MixAndCallback and MixThread removed - we now send raw audio directly from capture threads

void AudioCapture::ConvertAndMixMicToDesktopFormat(const BYTE* micData, UINT32 micFrames) {
    if (!m_pwfxDesktop || !m_pwfxMic || !micData) {
        return;
    }
    
    // We support mixing for:
    // - 16‑bit signed PCM
    // - 32‑bit float PCM (WASAPI mix format on your headset/mic)
    //
    // We assume both streams use the same sample rate (or close enough)
    // and we always mix into the desktop format.
    
    // Calculate how many frames we can mix
    UINT32 framesToMix = std::min(micFrames, m_desktopFramesReady);
    if (framesToMix == 0) {
        return;
    }
    
    UINT32 desktopSamplesPerFrame = m_pwfxDesktop->nChannels;
    UINT32 micSamplesPerFrame = m_pwfxMic->nChannels;
    
    // 32‑bit float mixing path (most common with WASAPI mix format)
    if (m_pwfxDesktop->wBitsPerSample == 32 && m_pwfxMic->wBitsPerSample == 32) {
        float* desktopSamples = reinterpret_cast<float*>(m_mixBuffer.data());
        const float* micSamples = reinterpret_cast<const float*>(micData);
        const float micGain = 0.9f; // Higher mic gain for louder voice in mix

        const UINT32 desktopRate = m_pwfxDesktop->nSamplesPerSec;
        const UINT32 micRate = m_pwfxMic->nSamplesPerSec;

        // Optional resampling buffer if rates differ
        std::vector<float> micResampled;
        const float* micSource = micSamples;

        if (desktopRate != 0 && micRate != 0 && desktopRate != micRate) {
            micResampled.resize(framesToMix * micSamplesPerFrame);
            const double ratio = static_cast<double>(micRate) / static_cast<double>(desktopRate);

            for (UINT32 frame = 0; frame < framesToMix; frame++) {
                double inPos = frame * ratio; // position in mic frames
                UINT32 i0 = static_cast<UINT32>(inPos);
                if (i0 >= micFrames) {
                    i0 = micFrames - 1;
                }
                UINT32 i1 = (i0 + 1 < micFrames) ? (i0 + 1) : i0;
                float t = static_cast<float>(inPos - static_cast<double>(i0));

                for (UINT32 ch = 0; ch < micSamplesPerFrame; ch++) {
                    float s0 = micSamples[i0 * micSamplesPerFrame + ch];
                    float s1 = micSamples[i1 * micSamplesPerFrame + ch];
                    micResampled[frame * micSamplesPerFrame + ch] = s0 + (s1 - s0) * t;
                }
            }

            micSource = micResampled.data();
        }

        for (UINT32 frame = 0; frame < framesToMix; frame++) {
            for (UINT32 ch = 0; ch < desktopSamplesPerFrame; ch++) {
                float desktopSample = desktopSamples[frame * desktopSamplesPerFrame + ch];

                // Get corresponding mic sample (handle channel mismatch)
                float micSample = 0.0f;
                if (ch < micSamplesPerFrame) {
                    micSample = micSource[frame * micSamplesPerFrame + ch];
                } else if (micSamplesPerFrame == 1 && desktopSamplesPerFrame >= 2) {
                    // Mono mic to stereo desktop - duplicate channel
                    micSample = micSource[frame];
                }

                // Apply mic gain before mixing
                float scaledMic = micSample * micGain;
                float mixed = desktopSample + scaledMic;

                // Clamp to [-1.0, 1.0] safety
                if (mixed > 1.0f) mixed = 1.0f;
                if (mixed < -1.0f) mixed = -1.0f;

                desktopSamples[frame * desktopSamplesPerFrame + ch] = mixed;
            }
        }
        return;
    }

    // 16‑bit integer mixing path (fallback)
    if (m_pwfxDesktop->wBitsPerSample == 16 && m_pwfxMic->wBitsPerSample == 16) {
        int16_t* desktopSamples = reinterpret_cast<int16_t*>(m_mixBuffer.data());
        const int16_t* micSamples = reinterpret_cast<const int16_t*>(micData);
        const float micGain = 0.9f; // Higher mic gain for louder voice in mix

        const UINT32 desktopRate = m_pwfxDesktop->nSamplesPerSec;
        const UINT32 micRate = m_pwfxMic->nSamplesPerSec;

        std::vector<int16_t> micResampled;
        const int16_t* micSource = micSamples;

        if (desktopRate != 0 && micRate != 0 && desktopRate != micRate) {
            micResampled.resize(framesToMix * micSamplesPerFrame);
            const double ratio = static_cast<double>(micRate) / static_cast<double>(desktopRate);

            for (UINT32 frame = 0; frame < framesToMix; frame++) {
                double inPos = frame * ratio;
                UINT32 i0 = static_cast<UINT32>(inPos);
                if (i0 >= micFrames) {
                    i0 = micFrames - 1;
                }
                UINT32 i1 = (i0 + 1 < micFrames) ? (i0 + 1) : i0;
                float t = static_cast<float>(inPos - static_cast<double>(i0));

                for (UINT32 ch = 0; ch < micSamplesPerFrame; ch++) {
                    int16_t s0 = micSamples[i0 * micSamplesPerFrame + ch];
                    int16_t s1 = micSamples[i1 * micSamplesPerFrame + ch];
                    float f0 = static_cast<float>(s0);
                    float f1 = static_cast<float>(s1);
                    float f = f0 + (f1 - f0) * t;
                    int32_t v = static_cast<int32_t>(f);
                    if (v > 32767) v = 32767;
                    if (v < -32768) v = -32768;
                    micResampled[frame * micSamplesPerFrame + ch] = static_cast<int16_t>(v);
                }
            }

            micSource = micResampled.data();
        }

        for (UINT32 frame = 0; frame < framesToMix; frame++) {
            for (UINT32 ch = 0; ch < desktopSamplesPerFrame; ch++) {
                int32_t desktopSample = desktopSamples[frame * desktopSamplesPerFrame + ch];

                // Get corresponding mic sample (handle channel mismatch)
                int32_t micSample = 0;
                if (ch < micSamplesPerFrame) {
                    micSample = micSource[frame * micSamplesPerFrame + ch];
                } else if (micSamplesPerFrame == 1 && desktopSamplesPerFrame >= 2) {
                    micSample = micSource[frame];
                }

                int32_t scaledMic = static_cast<int32_t>(static_cast<float>(micSample) * micGain);
                int32_t mixed = desktopSample + scaledMic;

                // Clamp
                if (mixed > 32767) mixed = 32767;
                if (mixed < -32768) mixed = -32768;

                desktopSamples[frame * desktopSamplesPerFrame + ch] = static_cast<int16_t>(mixed);
            }
        }

        return;
    }
    
    // Unsupported combination (e.g. 24‑bit) – skip mixing for now
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
    
    if (m_pwfxUnified) {
        CoTaskMemFree(m_pwfxUnified);
        m_pwfxUnified = nullptr;
    }
    
    if (m_pEnumerator) {
        m_pEnumerator->Release();
        m_pEnumerator = nullptr;
    }
}

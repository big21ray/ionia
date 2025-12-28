#ifndef AUDIO_ENGINE_H
#define AUDIO_ENGINE_H

#include <windows.h>
#include <vector>
#include <mutex>
#include <atomic>
#include <functional>
#include <cstdint>
#include "av_packet.h"
#include "audio_packet_manager.h"

// Callback function type for AudioPackets with PTS
// packet: AudioPacket containing PCM data with PTS/DTS
typedef std::function<void(const AudioPacket& packet)> AudioPacketCallback;

class AudioEngine {
public:
    AudioEngine();
    ~AudioEngine();

    // Initialize audio engine
    // callback: called when mixed audio is ready to be sent as AVPacket with PTS
    bool Initialize(AudioPacketCallback callback);

    // Start audio engine (clock master)
    bool Start();

    // Stop audio engine
    void Stop();

    // Check if engine is running
    bool IsRunning() const { return m_isRunning; }

    // Feed audio data from WASAPI (called from capture threads)
    // data: audio buffer (must be float32, 48kHz, stereo - already processed by AudioCapture)
    // numFrames: number of frames in the buffer
    // source: "desktop" or "mic"
    void FeedAudioData(const float* data, UINT32 numFrames, const char* source);

    // Process audio engine tick (should be called periodically, e.g., every 10ms)
    // This is the clock master - calculates how many frames should be sent based on elapsed time
    void Tick();

    // Get current PTS in frames (for encoding)
    UINT64 GetCurrentPTSFrames() const { return m_framesSent; }

    // Get current PTS in seconds
    double GetCurrentPTSSeconds() const {
        return static_cast<double>(m_framesSent) / static_cast<double>(SAMPLE_RATE);
    }

    // Get sample rate (always 48000)
    static constexpr UINT32 SAMPLE_RATE = 48000;

    // Get channels (always 2 for stereo)
    static constexpr UINT16 CHANNELS = 2;

    // Get bytes per sample (always 4 for float32)
    static constexpr UINT16 BYTES_PER_SAMPLE = 4;

private:
    // Monotonic clock (OBS-like) - returns milliseconds since an arbitrary point
    // Uses QueryPerformanceCounter for high-resolution, monotonic timing
    UINT64 GetMonotonicTimeMs() const;

    // Mix desktop and mic audio (OBS-like: non-blocking)
    // If a source is missing, uses silence (0.0)
    void MixAudio(UINT32 numFrames, std::vector<float>& output);

    // Audio buffers (thread-safe)
    std::mutex m_bufferMutex;
    std::vector<float> m_desktopBuffer;  // Interleaved stereo: [L0, R0, L1, R1, ...]
    std::vector<float> m_micBuffer;       // Interleaved stereo: [L0, R0, L1, R1, ...]
    UINT32 m_desktopFramesAvailable;
    UINT32 m_micFramesAvailable;

    // Audio Engine state
    std::atomic<bool> m_isRunning;
    UINT64 m_startTimeMs;        // Monotonic start time (ms)
    UINT64 m_framesSent;         // Total frames sent (OBS-like: count in frames, not samples)
    
    // Mic gain (for mixing)
    float m_micGain;

    // Desktop gain (for mixing)
    float m_desktopGain;

    // Callback for AVPackets with PTS
    AudioPacketCallback m_callback;

    // Packet manager for creating AVPackets with explicit PTS
    AudioPacketManager m_packetManager;

    // Performance counter frequency (for monotonic clock)
    LARGE_INTEGER m_perfFreq;
    bool m_perfFreqInitialized;
};

#endif // AUDIO_ENGINE_H


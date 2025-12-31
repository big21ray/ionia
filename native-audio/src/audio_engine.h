#ifndef AUDIO_ENGINE_H
#define AUDIO_ENGINE_H

#include <windows.h>
#include <vector>
#include <mutex>
#include <atomic>
#include <functional>
#include <cstdint>
#include <algorithm>
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

    // Event-driven (recorder-friendly) audio pull:
    // Attempts to produce exactly numFrames of mixed PCM as an AudioPacket.
    // Returns false if there isn't enough buffered audio to produce a meaningful block.
    //
    // mode: "desktop", "mic", or "both". For "both", it will emit when at least one source
    // has >= numFrames available (the other source will be padded with silence as needed).
    bool TryPopMixedAudioPacket(UINT32 numFrames, const char* mode, AudioPacket& outPacket);

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
    class FloatRingBuffer {
    public:
        void Reset(size_t capacitySamples) {
            m_data.assign(capacitySamples, 0.0f);
            m_capacity = capacitySamples;
            m_read = 0;
            m_write = 0;
            m_size = 0;
        }

        size_t SizeSamples() const { return m_size; }
        size_t CapacitySamples() const { return m_capacity; }

        void PushSamples(const float* samples, size_t count) {
            if (!samples || count == 0 || m_capacity == 0) return;

            // If pushing more than capacity, keep only the tail.
            if (count >= m_capacity) {
                samples += (count - m_capacity);
                count = m_capacity;
                m_read = 0;
                m_write = 0;
                m_size = 0;
            }

            // If not enough space, drop oldest samples.
            const size_t freeSpace = m_capacity - m_size;
            if (count > freeSpace) {
                const size_t drop = count - freeSpace;
                PopSamples(drop);
            }

            size_t remaining = count;
            while (remaining > 0) {
                const size_t chunk = (std::min)(remaining, m_capacity - m_write);
                std::copy(samples, samples + chunk, m_data.begin() + m_write);
                m_write = (m_write + chunk) % m_capacity;
                m_size += chunk;
                samples += chunk;
                remaining -= chunk;
            }
        }

        float GetSampleAt(size_t offsetFromRead) const {
            if (offsetFromRead >= m_size || m_capacity == 0) return 0.0f;
            const size_t idx = (m_read + offsetFromRead) % m_capacity;
            return m_data[idx];
        }

        void PopSamples(size_t count) {
            if (count == 0 || m_size == 0 || m_capacity == 0) return;
            if (count >= m_size) {
                m_read = 0;
                m_write = 0;
                m_size = 0;
                return;
            }
            m_read = (m_read + count) % m_capacity;
            m_size -= count;
        }

    private:
        std::vector<float> m_data;
        size_t m_capacity = 0;
        size_t m_read = 0;
        size_t m_write = 0;
        size_t m_size = 0;
    };

    // Monotonic clock (OBS-like) - returns milliseconds since an arbitrary point
    // Uses QueryPerformanceCounter for high-resolution, monotonic timing
    UINT64 GetMonotonicTimeMs() const;

    // Mix desktop and mic audio (OBS-like: non-blocking)
    // If a source is missing, uses silence (0.0)
    void MixAudio(UINT32 numFrames, std::vector<float>& output);

    // Mode-aware mixing tweaks.
    // For "both", applies a small attenuation to reduce clipping when summing sources.
    void MixAudioWithMode(UINT32 numFrames, const char* mode, std::vector<float>& output);

    // Audio buffers (thread-safe)
    std::mutex m_bufferMutex;
    FloatRingBuffer m_desktopBuffer;  // Interleaved stereo samples
    FloatRingBuffer m_micBuffer;      // Interleaved stereo samples

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


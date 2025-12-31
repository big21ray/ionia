#include "audio_engine_encoder.h"
#include "av_packet.h"
#include "encoded_audio_packet.h"
#include <vector>
#include <fstream>
#include <cstring>

AudioEngineWithEncoder::AudioEngineWithEncoder()
    : m_bitrate(192000)
    , m_initialized(false)
    , m_useRawAac(false)
{
    m_engine = std::make_unique<AudioEngine>();
    m_encoder = std::make_unique<AudioEncoder>();
    m_muxer = std::make_unique<AudioMuxer>();
}

AudioEngineWithEncoder::~AudioEngineWithEncoder() {
    Stop();
    if (m_aacFile.is_open()) {
        m_aacFile.close();
    }
}

bool AudioEngineWithEncoder::Initialize(const std::string& outputPath, UINT32 bitrate, bool useRawAac) {
    if (m_initialized) {
        return false;
    }

    m_outputPath = outputPath;
    m_bitrate = bitrate;
    m_useRawAac = useRawAac;

    // Initialize encoder
    if (!m_encoder->Initialize(AudioEngine::SAMPLE_RATE, AudioEngine::CHANNELS, m_bitrate)) {
        return false;
    }

    if (m_useRawAac) {
        // Open raw AAC file for writing
        m_aacFile.open(m_outputPath, std::ios::binary);
        if (!m_aacFile.is_open()) {
            return false;
        }
    } else {
        // Initialize muxer for MP4
        if (!m_muxer->Initialize(m_outputPath, AudioEngine::SAMPLE_RATE, AudioEngine::CHANNELS, m_bitrate)) {
            return false;
        }
    }

    // Initialize audio engine with callback that encodes and writes
    auto callback = [this](const AudioPacket& packet) {
        // This callback receives PCM AudioPackets from AudioEngine
        // Encode PCM to AAC
        const float* pcmData = reinterpret_cast<const float*>(packet.data.data());
        UINT32 numFrames = static_cast<UINT32>(packet.duration);
        int64_t ptsFrames = packet.pts;

        // Encode frames (encoder returns BYTES ONLY, no timestamps)
        std::vector<EncodedAudioPacket> encodedPackets = m_encoder->EncodeFrames(pcmData, numFrames);

        if (m_useRawAac) {
            // Write raw AAC packets with ADTS headers directly to file
            for (const EncodedAudioPacket& encodedPacket : encodedPackets) {
                if (m_aacFile.is_open() && encodedPacket.data.size() > 0) {
                    // Generate ADTS header (7 bytes)
                    uint8_t adtsHeader[7];
                    WriteAdtsHeader(adtsHeader, encodedPacket.data.size(), AudioEngine::SAMPLE_RATE, AudioEngine::CHANNELS);
                    
                    // Write ADTS header
                    m_aacFile.write(reinterpret_cast<const char*>(adtsHeader), 7);
                    
                    // Write AAC packet data
                    m_aacFile.write(reinterpret_cast<const char*>(encodedPacket.data.data()), encodedPacket.data.size());
                }
            }
        } else {
            // Mux encoded packets into MP4
            // AudioMuxer still uses AudioPacket, so we need to create one with timestamps
            // For audio_engine_encoder, we use AudioEngine PTS
            // AAC typically has 1024 samples per frame
            const int64_t aacSamplesPerFrame = 1024;
            int64_t currentPts = ptsFrames;
            
            for (const EncodedAudioPacket& encodedPacket : encodedPackets) {
                // Create AudioPacket with PTS from AudioEngine
                // Each encoded packet represents aacSamplesPerFrame samples
                AudioPacket audioPacket(encodedPacket.data, currentPts, currentPts, aacSamplesPerFrame, 0);
                m_muxer->WritePacket(audioPacket);
                currentPts += aacSamplesPerFrame;
            }
        }
    };

    if (!m_engine->Initialize(callback)) {
        return false;
    }

    m_initialized = true;
    return true;
}

bool AudioEngineWithEncoder::Start() {
    if (!m_initialized) {
        return false;
    }

    return m_engine->Start();
}

void AudioEngineWithEncoder::Stop() {
    if (!m_initialized) {
        return;
    }

    if (m_engine && m_engine->IsRunning()) {
        m_engine->Stop();

        // Flush encoder
        if (m_encoder && m_encoder->IsInitialized()) {
            std::vector<EncodedAudioPacket> flushedPackets = m_encoder->Flush();
            
            // Get current PTS from engine for flushed packets
            int64_t flushPTS = m_engine ? static_cast<int64_t>(m_engine->GetCurrentPTSFrames()) : 0;
            
            if (m_useRawAac) {
                // Write flushed packets to raw AAC file with ADTS headers
                for (const EncodedAudioPacket& packet : flushedPackets) {
                    if (m_aacFile.is_open() && packet.data.size() > 0) {
                        // Generate ADTS header (7 bytes)
                        uint8_t adtsHeader[7];
                        WriteAdtsHeader(adtsHeader, packet.data.size(), AudioEngine::SAMPLE_RATE, AudioEngine::CHANNELS);
                        
                        // Write ADTS header
                        m_aacFile.write(reinterpret_cast<const char*>(adtsHeader), 7);
                        
                        // Write AAC packet data
                        m_aacFile.write(reinterpret_cast<const char*>(packet.data.data()), packet.data.size());
                    }
                }
                // Close AAC file
                if (m_aacFile.is_open()) {
                    m_aacFile.close();
                }
            } else {
                // Mux flushed packets into MP4
                // AudioMuxer still uses AudioPacket, so we need to create one with timestamps
                for (const EncodedAudioPacket& packet : flushedPackets) {
                    // Create AudioPacket with PTS (AudioMuxer will handle it)
                    AudioPacket audioPacket(packet.data, flushPTS, flushPTS, 1024, 0);  // 1024 = typical AAC frame size
                    m_muxer->WritePacket(audioPacket);
                    flushPTS += 1024;
                }
                // Finalize muxer
                if (m_muxer && m_muxer->IsInitialized()) {
                    m_muxer->Finalize();
                }
            }
        }
    }
}

void AudioEngineWithEncoder::FeedAudioData(const float* data, UINT32 numFrames, const char* source) {
    if (m_engine) {
        m_engine->FeedAudioData(data, numFrames, source);
    }
}

void AudioEngineWithEncoder::Tick() {
    if (m_engine) {
        m_engine->Tick();
    }
}

UINT64 AudioEngineWithEncoder::GetCurrentPTSFrames() const {
    if (m_engine) {
        return m_engine->GetCurrentPTSFrames();
    }
    return 0;
}

double AudioEngineWithEncoder::GetCurrentPTSSeconds() const {
    if (m_engine) {
        return m_engine->GetCurrentPTSSeconds();
    }
    return 0.0;
}

size_t AudioEngineWithEncoder::GetEncodedPackets() const {
    if (m_encoder) {
        return m_encoder->GetPacketCount();
    }
    return 0;
}

size_t AudioEngineWithEncoder::GetEncodedBytes() const {
    if (m_encoder) {
        return m_encoder->GetTotalBytes();
    }
    return 0;
}

size_t AudioEngineWithEncoder::GetMuxedPackets() const {
    if (m_muxer) {
        return m_muxer->GetPacketCount();
    }
    return 0;
}

size_t AudioEngineWithEncoder::GetMuxedBytes() const {
    if (m_muxer) {
        return m_muxer->GetTotalBytes();
    }
    return 0;
}

bool AudioEngineWithEncoder::IsRunning() const {
    if (m_engine) {
        return m_engine->IsRunning();
    }
    return false;
}

void AudioEngineWithEncoder::WriteAdtsHeader(uint8_t* buffer, size_t aacFrameLength, UINT32 sampleRate, UINT16 channels) {
    // ADTS header structure (7 bytes):
    // - Sync word (12 bits): 0xFFF
    // - MPEG version (1 bit): 0 = MPEG-4, 1 = MPEG-2
    // - Layer (2 bits): Always 00
    // - Protection absent (1 bit): 1 = no CRC
    // - Profile (2 bits): AAC-LC = 1
    // - Sample rate index (4 bits): 48000 Hz = 3
    // - Private bit (1 bit): 0
    // - Channel configuration (3 bits): Stereo = 2
    // - Original/copy (1 bit): 0
    // - Home (1 bit): 0
    // - Copyright ID bit (1 bit): 0
    // - Copyright ID start (1 bit): 0
    // - Frame length (13 bits): ADTS header (7) + AAC frame length
    // - Buffer fullness (11 bits): 0x7FF = variable bitrate
    // - Number of AAC frames (2 bits): 1 frame per ADTS frame = 0
    
    // Map sample rate to index
    UINT8 sampleRateIndex = 0;
    switch (sampleRate) {
        case 96000: sampleRateIndex = 0; break;
        case 88200: sampleRateIndex = 1; break;
        case 64000: sampleRateIndex = 2; break;
        case 48000: sampleRateIndex = 3; break;
        case 44100: sampleRateIndex = 4; break;
        case 32000: sampleRateIndex = 5; break;
        case 24000: sampleRateIndex = 6; break;
        case 22050: sampleRateIndex = 7; break;
        case 16000: sampleRateIndex = 8; break;
        case 12000: sampleRateIndex = 9; break;
        case 11025: sampleRateIndex = 10; break;
        case 8000: sampleRateIndex = 11; break;
        default: sampleRateIndex = 3; break; // Default to 48000 Hz
    }
    
    // Calculate frame length (ADTS header 7 bytes + AAC frame length)
    size_t frameLength = 7 + aacFrameLength;
    
    // Build ADTS header
    buffer[0] = 0xFF;  // Sync word (8 bits)
    buffer[1] = 0xF1;  // Sync word (4 bits) + MPEG-4 (0) + Layer (00) + Protection absent (1)
    buffer[2] = 0x40 | (sampleRateIndex << 2) | ((channels & 0x04) >> 2);  // Profile (AAC-LC = 01) + Sample rate index (4 bits) + Channel config (1 bit)
    buffer[3] = ((channels & 0x03) << 6) | ((frameLength >> 11) & 0x03);  // Channel config (2 bits) + Frame length (2 bits)
    buffer[4] = (frameLength >> 3) & 0xFF;  // Frame length (8 bits)
    buffer[5] = ((frameLength & 0x07) << 5) | 0x1F;  // Frame length (3 bits) + Buffer fullness (5 bits)
    buffer[6] = 0xFC;  // Buffer fullness (6 bits) + Number of AAC frames (2 bits = 0)
}


// Standalone test program for audio resampling
// Reads two WAV files (desktop and mic), resamples them to 48000 Hz,
// adapts channels to stereo, mixes them, and writes the result.

#ifndef NOMINMAX
#define NOMINMAX
#endif
#include <windows.h>
#include <mmreg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <vector>
#include <algorithm>
#include <cmath>

// WAV file structures
#pragma pack(push, 1)
struct WAVHeader {
    char riff[4];           // "RIFF"
    uint32_t fileSize;       // File size - 8
    char wave[4];            // "WAVE"
    char fmt[4];             // "fmt "
    uint32_t fmtSize;        // Format chunk size (usually 16 or 18)
    uint16_t audioFormat;    // 1 = PCM, 3 = IEEE float
    uint16_t numChannels;
    uint32_t sampleRate;
    uint32_t byteRate;
    uint16_t blockAlign;
    uint16_t bitsPerSample;
};

struct WAVDataChunk {
    char data[4];           // "data"
    uint32_t dataSize;      // Data chunk size
};
#pragma pack(pop)

// Read WAV file
bool ReadWAVFile(const char* filename, std::vector<float>& samples, 
                 uint32_t& sampleRate, uint16_t& channels, uint16_t& bitsPerSample) {
    FILE* f = fopen(filename, "rb");
    if (!f) {
        fprintf(stderr, "Error: Cannot open file %s\n", filename);
        return false;
    }

    WAVHeader header;
    if (fread(&header, sizeof(WAVHeader), 1, f) != 1) {
        fprintf(stderr, "Error: Cannot read WAV header from %s\n", filename);
        fclose(f);
        return false;
    }

    // Verify RIFF/WAVE
    if (memcmp(header.riff, "RIFF", 4) != 0 || memcmp(header.wave, "WAVE", 4) != 0) {
        fprintf(stderr, "Error: %s is not a valid WAV file\n", filename);
        fclose(f);
        return false;
    }

    // Skip any extra format data
    if (header.fmtSize > 16) {
        fseek(f, header.fmtSize - 16, SEEK_CUR);
    }

    // Find data chunk
    WAVDataChunk dataChunk;
    while (fread(&dataChunk, 8, 1, f) == 1) {
        if (memcmp(dataChunk.data, "data", 4) == 0) {
            break;
        }
        // Skip this chunk
        fseek(f, dataChunk.dataSize, SEEK_CUR);
    }

    if (memcmp(dataChunk.data, "data", 4) != 0) {
        fprintf(stderr, "Error: Cannot find data chunk in %s\n", filename);
        fclose(f);
        return false;
    }

    sampleRate = header.sampleRate;
    channels = header.numChannels;
    bitsPerSample = header.bitsPerSample;

    fprintf(stderr, "Reading %s: %u Hz, %u ch, %u-bit %s\n",
            filename, sampleRate, channels, bitsPerSample,
            (header.audioFormat == 3) ? "float" : "PCM");

    // Read audio data
    size_t dataSize = dataChunk.dataSize;
    std::vector<uint8_t> rawData(dataSize);
    if (fread(rawData.data(), 1, dataSize, f) != dataSize) {
        fprintf(stderr, "Error: Cannot read audio data from %s\n", filename);
        fclose(f);
        return false;
    }
    fclose(f);

    // Convert to float32
    size_t numSamples = dataSize / (bitsPerSample / 8);
    samples.resize(numSamples);

    if (header.audioFormat == 3) {
        // IEEE float
        memcpy(samples.data(), rawData.data(), dataSize);
    } else if (header.audioFormat == 1 && bitsPerSample == 16) {
        // 16-bit PCM
        int16_t* pcm = reinterpret_cast<int16_t*>(rawData.data());
        for (size_t i = 0; i < numSamples; i++) {
            samples[i] = pcm[i] / 32768.0f;
        }
    } else {
        fprintf(stderr, "Error: Unsupported audio format in %s\n", filename);
        return false;
    }

    fprintf(stderr, "  Read %zu samples (%zu frames)\n", numSamples, numSamples / channels);
    return true;
}

// Resample audio using linear interpolation
void ResampleAudio(const std::vector<float>& input, uint32_t inputFrames, uint32_t inputChannels,
                   uint32_t inputRate, uint32_t outputRate,
                   std::vector<float>& output, uint32_t& outputFrames) {
    if (inputRate == outputRate) {
        output = input;
        outputFrames = inputFrames;
        return;
    }

    double ratio = static_cast<double>(inputRate) / static_cast<double>(outputRate);
    outputFrames = static_cast<uint32_t>(std::ceil(static_cast<double>(inputFrames) * outputRate / inputRate));
    if (outputFrames == 0 && inputFrames > 0) {
        outputFrames = 1;
    }

    size_t outputSamples = outputFrames * inputChannels;
    output.resize(outputSamples);

    for (uint32_t outFrame = 0; outFrame < outputFrames; outFrame++) {
        double inPos = static_cast<double>(outFrame) * ratio;
        uint32_t i0 = static_cast<uint32_t>(inPos);
        uint32_t i1 = std::min(i0 + 1, inputFrames - 1);
        float t = static_cast<float>(inPos - static_cast<double>(i0));

        if (i0 >= inputFrames) {
            i0 = inputFrames - 1;
            i1 = inputFrames - 1;
            t = 0.0f;
        }

        for (uint32_t ch = 0; ch < inputChannels; ch++) {
            float s0 = input[i0 * inputChannels + ch];
            float s1 = input[i1 * inputChannels + ch];
            output[outFrame * inputChannels + ch] = s0 + (s1 - s0) * t;
        }
    }

    fprintf(stderr, "Resampled: %u frames @ %u Hz -> %u frames @ %u Hz (ratio=%.6f)\n",
            inputFrames, inputRate, outputFrames, outputRate, ratio);
}

// Adapt channels to stereo
void AdaptChannelsToStereo(const std::vector<float>& input, uint32_t frames, uint32_t inputChannels,
                           std::vector<float>& output) {
    output.resize(frames * 2);

    if (inputChannels == 2) {
        // Already stereo, just copy
        output = input;
    } else if (inputChannels == 1) {
        // Mono -> Stereo: duplicate
        for (uint32_t frame = 0; frame < frames; frame++) {
            float mono = input[frame];
            output[frame * 2 + 0] = mono;  // Left
            output[frame * 2 + 1] = mono;  // Right
        }
    } else {
        // Multi-channel -> Stereo: use front L/R
        for (uint32_t frame = 0; frame < frames; frame++) {
            output[frame * 2 + 0] = input[frame * inputChannels + 0];  // Left
            if (inputChannels > 1) {
                output[frame * 2 + 1] = input[frame * inputChannels + 1];  // Right
            } else {
                output[frame * 2 + 1] = input[frame * inputChannels + 0];  // Duplicate
            }
        }
    }

    fprintf(stderr, "Adapted channels: %u ch -> 2 ch (stereo)\n", inputChannels);
}

// Mix two stereo streams
void MixAudio(const std::vector<float>& desktop, uint32_t desktopFrames,
              const std::vector<float>& mic, uint32_t micFrames,
              std::vector<float>& output) {
    uint32_t outputFrames = std::max(desktopFrames, micFrames);
    output.resize(outputFrames * 2);

    const float micGain = 0.9f;

    for (uint32_t frame = 0; frame < outputFrames; frame++) {
        float desktopL = 0.0f, desktopR = 0.0f;
        float micL = 0.0f, micR = 0.0f;

        if (frame < desktopFrames) {
            desktopL = desktop[frame * 2 + 0];
            desktopR = desktop[frame * 2 + 1];
        }

        if (frame < micFrames) {
            micL = mic[frame * 2 + 0] * micGain;
            micR = mic[frame * 2 + 1] * micGain;
        }

        float mixedL = desktopL + micL;
        float mixedR = desktopR + micR;

        // Clamp to [-1.0, 1.0]
        if (mixedL > 1.0f) mixedL = 1.0f;
        if (mixedL < -1.0f) mixedL = -1.0f;
        if (mixedR > 1.0f) mixedR = 1.0f;
        if (mixedR < -1.0f) mixedR = -1.0f;

        output[frame * 2 + 0] = mixedL;
        output[frame * 2 + 1] = mixedR;
    }

    fprintf(stderr, "Mixed: desktop=%u frames, mic=%u frames -> output=%u frames\n",
            desktopFrames, micFrames, outputFrames);
}

// Write WAV file
bool WriteWAVFile(const char* filename, const std::vector<float>& samples,
                  uint32_t sampleRate, uint16_t channels) {
    FILE* f = fopen(filename, "wb");
    if (!f) {
        fprintf(stderr, "Error: Cannot create file %s\n", filename);
        return false;
    }

    size_t dataSize = samples.size() * sizeof(float);
    uint32_t fileSize = 36 + static_cast<uint32_t>(dataSize);

    WAVHeader header = {};
    memcpy(header.riff, "RIFF", 4);
    header.fileSize = fileSize;
    memcpy(header.wave, "WAVE", 4);
    memcpy(header.fmt, "fmt ", 4);
    header.fmtSize = 16;
    header.audioFormat = 3;  // IEEE float
    header.numChannels = channels;
    header.sampleRate = sampleRate;
    header.byteRate = sampleRate * channels * sizeof(float);
    header.blockAlign = channels * sizeof(float);
    header.bitsPerSample = 32;

    if (fwrite(&header, sizeof(WAVHeader), 1, f) != 1) {
        fprintf(stderr, "Error: Cannot write WAV header\n");
        fclose(f);
        return false;
    }

    WAVDataChunk dataChunk = {};
    memcpy(dataChunk.data, "data", 4);
    dataChunk.dataSize = static_cast<uint32_t>(dataSize);

    if (fwrite(&dataChunk, sizeof(WAVDataChunk), 1, f) != 1) {
        fprintf(stderr, "Error: Cannot write data chunk header\n");
        fclose(f);
        return false;
    }

    if (fwrite(samples.data(), sizeof(float), samples.size(), f) != samples.size()) {
        fprintf(stderr, "Error: Cannot write audio data\n");
        fclose(f);
        return false;
    }

    fclose(f);
    fprintf(stderr, "Written %s: %u Hz, %u ch, %zu samples\n",
            filename, sampleRate, channels, samples.size());
    return true;
}

int main(int argc, char* argv[]) {
    if (argc < 4) {
        fprintf(stderr, "Usage: %s <desktop.wav> <mic.wav> <desktop_output.wav> <mic_output.wav>\n", argv[0]);
        fprintf(stderr, "Example: %s debug_desktop_raw.wav debug_mic_raw.wav desktop_processed.wav mic_processed.wav\n", argv[0]);
        return 1;
    }

    const char* desktopFile = argv[1];
    const char* micFile = argv[2];
    const char* desktopOutputFile = argv[3];
    const char* micOutputFile = argv[4];

    fprintf(stderr, "=== Audio Resampling Test ===\n\n");

    // Read desktop WAV
    std::vector<float> desktopSamples;
    uint32_t desktopRate;
    uint16_t desktopChannels;
    uint16_t desktopBits;
    if (!ReadWAVFile(desktopFile, desktopSamples, desktopRate, desktopChannels, desktopBits)) {
        return 1;
    }

    // Read mic WAV
    std::vector<float> micSamples;
    uint32_t micRate;
    uint16_t micChannels;
    uint16_t micBits;
    if (!ReadWAVFile(micFile, micSamples, micRate, micChannels, micBits)) {
        return 1;
    }

    fprintf(stderr, "\n=== Processing ===\n\n");

    const uint32_t TARGET_RATE = 48000;
    const uint16_t TARGET_CHANNELS = 2;

    // Process desktop: resample + adapt channels
    std::vector<float> desktopResampled;
    uint32_t desktopResampledFrames = 0;
    uint32_t desktopInputFrames = static_cast<uint32_t>(desktopSamples.size() / desktopChannels);
    ResampleAudio(desktopSamples, desktopInputFrames, desktopChannels,
                  desktopRate, TARGET_RATE,
                  desktopResampled, desktopResampledFrames);

    std::vector<float> desktopStereo;
    AdaptChannelsToStereo(desktopResampled, desktopResampledFrames, desktopChannels, desktopStereo);

    // Process mic: resample + adapt channels
    std::vector<float> micResampled;
    uint32_t micResampledFrames = 0;
    uint32_t micInputFrames = static_cast<uint32_t>(micSamples.size() / micChannels);
    ResampleAudio(micSamples, micInputFrames, micChannels,
                  micRate, TARGET_RATE,
                  micResampled, micResampledFrames);

    std::vector<float> micStereo;
    AdaptChannelsToStereo(micResampled, micResampledFrames, micChannels, micStereo);

    // Write desktop output (resampled and adapted)
    fprintf(stderr, "\n=== Writing Desktop Output ===\n\n");
    if (!WriteWAVFile(desktopOutputFile, desktopStereo, TARGET_RATE, TARGET_CHANNELS)) {
        return 1;
    }

    // Write mic output (resampled and adapted)
    fprintf(stderr, "\n=== Writing Mic Output ===\n\n");
    if (!WriteWAVFile(micOutputFile, micStereo, TARGET_RATE, TARGET_CHANNELS)) {
        return 1;
    }

    fprintf(stderr, "\n✅ Success! Output files written:\n");
    fprintf(stderr, "  - Desktop: %s (%u frames @ %u Hz, stereo)\n", 
            desktopOutputFile, desktopResampledFrames, TARGET_RATE);
    fprintf(stderr, "  - Mic: %s (%u frames @ %u Hz, stereo)\n", 
            micOutputFile, micResampledFrames, TARGET_RATE);
    return 0;
}


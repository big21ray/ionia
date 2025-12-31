// ============================================================================
// test_pattern_generator.h
// ============================================================================
// Simple test pattern generator for headless video testing
// Generates solid colors, gradients, or moving patterns
// ============================================================================

#pragma once

#include <cstdint>
#include <cstring>

class TestPatternGenerator {
public:
    enum PatternType {
        SOLID_RED,
        SOLID_GREEN,
        SOLID_BLUE,
        COLOR_BARS,
        GRADIENT,
        MOVING_SQUARE
    };

    TestPatternGenerator(uint32_t width, uint32_t height, PatternType pattern = COLOR_BARS);
    ~TestPatternGenerator() = default;

    // Generate a frame and return pointer to frame data (BGR format, bottom-up like DesktopDuplication)
    uint8_t* GenerateFrame();

    // Get frame data pointer
    uint8_t* GetFrameData() { return m_frameData; }

    // Get frame size in bytes
    size_t GetFrameSize() const { return m_frameSize; }

    // Update frame (for animated patterns)
    void Tick() { m_frameNumber++; }

private:
    uint32_t m_width;
    uint32_t m_height;
    uint32_t m_frameNumber = 0;
    PatternType m_pattern;
    uint8_t* m_frameData = nullptr;
    size_t m_frameSize = 0;

    void GenerateColorBars();
    void GenerateGradient();
    void GenerateMovingSquare();
    void GenerateSolidColor(uint8_t r, uint8_t g, uint8_t b);
};

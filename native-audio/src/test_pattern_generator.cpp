// ============================================================================
// test_pattern_generator.cpp
// ============================================================================
// Implementation of test pattern generator for headless video testing
// ============================================================================

#include "test_pattern_generator.h"
#include <cmath>

TestPatternGenerator::TestPatternGenerator(uint32_t width, uint32_t height, PatternType pattern)
    : m_width(width), m_height(height), m_pattern(pattern) {
    m_frameSize = width * height * 4;  // BGRA format, 4 bytes per pixel
    m_frameData = new uint8_t[m_frameSize];
    memset(m_frameData, 0, m_frameSize);
}

uint8_t* TestPatternGenerator::GenerateFrame() {
    switch (m_pattern) {
        case SOLID_RED:
            GenerateSolidColor(0, 0, 255);  // BGR order
            break;
        case SOLID_GREEN:
            GenerateSolidColor(0, 255, 0);
            break;
        case SOLID_BLUE:
            GenerateSolidColor(255, 0, 0);
            break;
        case COLOR_BARS:
            GenerateColorBars();
            break;
        case GRADIENT:
            GenerateGradient();
            break;
        case MOVING_SQUARE:
            GenerateMovingSquare();
            break;
    }
    return m_frameData;
}

void TestPatternGenerator::GenerateSolidColor(uint8_t b, uint8_t g, uint8_t r) {
    for (size_t i = 0; i < m_frameSize; i += 4) {
        m_frameData[i]     = b;  // B
        m_frameData[i + 1] = g;  // G
        m_frameData[i + 2] = r;  // R
        m_frameData[i + 3] = 255;  // A
    }
}

void TestPatternGenerator::GenerateColorBars() {
    // 8 vertical color bars (like standard test pattern)
    uint32_t barWidth = m_width / 8;
    
    struct Color {
        uint8_t b, g, r;
    } colors[] = {
        {255, 255, 255},  // White
        {255, 255, 0},    // Yellow
        {0, 255, 255},    // Cyan
        {0, 255, 0},      // Green
        {255, 0, 255},    // Magenta
        {255, 0, 0},      // Red
        {0, 0, 255},      // Blue
        {0, 0, 0}         // Black
    };

    for (uint32_t y = 0; y < m_height; y++) {
        for (uint32_t x = 0; x < m_width; x++) {
            uint32_t barIndex = x / barWidth;
            if (barIndex >= 8) barIndex = 7;
            
            size_t offset = (y * m_width + x) * 4;
            m_frameData[offset]     = colors[barIndex].b;
            m_frameData[offset + 1] = colors[barIndex].g;
            m_frameData[offset + 2] = colors[barIndex].r;
            m_frameData[offset + 3] = 255;
        }
    }
}

void TestPatternGenerator::GenerateGradient() {
    // Animated gradient that changes with frame number
    uint8_t colorShift = (m_frameNumber * 2) & 0xFF;
    
    for (uint32_t y = 0; y < m_height; y++) {
        for (uint32_t x = 0; x < m_width; x++) {
            uint8_t intensity = ((x * 255) / m_width + colorShift) & 0xFF;
            
            size_t offset = (y * m_width + x) * 4;
            m_frameData[offset]     = intensity;  // B
            m_frameData[offset + 1] = intensity / 2;  // G
            m_frameData[offset + 2] = 255 - intensity;  // R
            m_frameData[offset + 3] = 255;  // A
        }
    }
}

void TestPatternGenerator::GenerateMovingSquare() {
    // Clear frame (black)
    memset(m_frameData, 0, m_frameSize);
    
    // Draw moving square
    uint32_t squareSize = 100;
    uint32_t x = (m_frameNumber * 5) % (m_width - squareSize);
    uint32_t y = 50;
    
    uint8_t r = ((m_frameNumber * 3) % 256);
    uint8_t g = ((m_frameNumber * 5) % 256);
    uint8_t b = ((m_frameNumber * 7) % 256);
    
    for (uint32_t py = y; py < y + squareSize && py < m_height; py++) {
        for (uint32_t px = x; px < x + squareSize && px < m_width; px++) {
            size_t offset = (py * m_width + px) * 4;
            m_frameData[offset]     = b;
            m_frameData[offset + 1] = g;
            m_frameData[offset + 2] = r;
            m_frameData[offset + 3] = 255;
        }
    }
}

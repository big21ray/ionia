#ifndef DESKTOP_DUPLICATION_H
#define DESKTOP_DUPLICATION_H

#include <windows.h>
#include <dxgi1_2.h>
#include <d3d11.h>
#include <wrl/client.h>
#include <cstdint>
#include <string>

using Microsoft::WRL::ComPtr;

// Desktop Duplication API for screen capture
// Captures frames directly from GPU (DXGI Desktop Duplication)
class DesktopDuplication {
public:
    DesktopDuplication();
    ~DesktopDuplication();

    // Initialize desktop duplication
    // Returns: true if successful
    bool Initialize();

    // Capture a frame from desktop
    // Returns: true if frame captured, false if no new frame available
    // frameData: output buffer (RGBA32, width * height * 4 bytes)
    // width: output width
    // height: output height
    // timestamp: output timestamp in 100-nanosecond units
    bool CaptureFrame(uint8_t* frameData, uint32_t* width, uint32_t* height, int64_t* timestamp);

    // Get current desktop dimensions
    void GetDesktopDimensions(uint32_t* width, uint32_t* height);

    // Check if initialized
    bool IsInitialized() const { return m_initialized; }

    // Cleanup
    void Cleanup();

private:
    bool m_initialized;
    
    // DXGI
    ComPtr<IDXGIOutputDuplication> m_deskDupl;
    ComPtr<IDXGIOutput1> m_output1;
    ComPtr<IDXGIAdapter1> m_adapter;
    ComPtr<IDXGIOutput> m_output;
    
    // D3D11
    ComPtr<ID3D11Device> m_device;
    ComPtr<ID3D11DeviceContext> m_context;
    ComPtr<ID3D11Texture2D> m_desktopImage;
    
    // Desktop info
    uint32_t m_desktopWidth;
    uint32_t m_desktopHeight;
    DXGI_OUTPUT_DESC m_outputDesc;
    
    // Frame info
    int64_t m_lastFrameTimestamp;
    uint32_t m_frameNumber;
    
    // Helper methods
    bool InitializeD3D();
    bool InitializeDuplication();
    bool AcquireFrame();
    void ReleaseFrame();
};

#endif // DESKTOP_DUPLICATION_H



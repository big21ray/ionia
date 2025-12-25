#include "desktop_duplication.h"
#include <cstring>
#include <cstdio>

DesktopDuplication::DesktopDuplication()
    : m_initialized(false)
    , m_desktopWidth(0)
    , m_desktopHeight(0)
    , m_lastFrameTimestamp(0)
    , m_frameNumber(0)
{
    ZeroMemory(&m_outputDesc, sizeof(m_outputDesc));
}

DesktopDuplication::~DesktopDuplication() {
    Cleanup();
}

bool DesktopDuplication::Initialize() {
    if (m_initialized) {
        return true;
    }

    // Initialize D3D11
    if (!InitializeD3D()) {
        fprintf(stderr, "[DesktopDuplication] Failed to initialize D3D11\n");
        return false;
    }

    // Initialize Desktop Duplication
    if (!InitializeDuplication()) {
        fprintf(stderr, "[DesktopDuplication] Failed to initialize duplication\n");
        Cleanup();
        return false;
    }

    m_initialized = true;
    fprintf(stderr, "[DesktopDuplication] Initialized: %ux%u\n", m_desktopWidth, m_desktopHeight);
    return true;
}

bool DesktopDuplication::InitializeD3D() {
    HRESULT hr;

    // Create DXGI Factory
    ComPtr<IDXGIFactory1> factory;
    hr = CreateDXGIFactory1(__uuidof(IDXGIFactory1), (void**)&factory);
    if (FAILED(hr)) {
        fprintf(stderr, "[DesktopDuplication] CreateDXGIFactory1 failed: 0x%08X\n", hr);
        return false;
    }

    // Get adapter (GPU)
    hr = factory->EnumAdapters1(0, &m_adapter);
    if (FAILED(hr)) {
        fprintf(stderr, "[DesktopDuplication] EnumAdapters1 failed: 0x%08X\n", hr);
        return false;
    }

    // Get output (monitor)
    hr = m_adapter->EnumOutputs(0, &m_output);
    if (FAILED(hr)) {
        fprintf(stderr, "[DesktopDuplication] EnumOutputs failed: 0x%08X\n", hr);
        return false;
    }

    // Query IDXGIOutput1
    hr = m_output.As(&m_output1);
    if (FAILED(hr)) {
        fprintf(stderr, "[DesktopDuplication] QueryInterface IDXGIOutput1 failed: 0x%08X\n", hr);
        return false;
    }

    // Get output description
    hr = m_output1->GetDesc(&m_outputDesc);
    if (FAILED(hr)) {
        fprintf(stderr, "[DesktopDuplication] GetDesc failed: 0x%08X\n", hr);
        return false;
    }

    m_desktopWidth = m_outputDesc.DesktopCoordinates.right - m_outputDesc.DesktopCoordinates.left;
    m_desktopHeight = m_outputDesc.DesktopCoordinates.bottom - m_outputDesc.DesktopCoordinates.top;

    // Create D3D11 device
    D3D_FEATURE_LEVEL featureLevels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0
    };

    D3D_FEATURE_LEVEL featureLevel;
    hr = D3D11CreateDevice(
        m_adapter.Get(),
        D3D_DRIVER_TYPE_UNKNOWN,
        nullptr,
        0,
        featureLevels,
        ARRAYSIZE(featureLevels),
        D3D11_SDK_VERSION,
        &m_device,
        &featureLevel,
        &m_context
    );

    if (FAILED(hr)) {
        fprintf(stderr, "[DesktopDuplication] D3D11CreateDevice failed: 0x%08X\n", hr);
        return false;
    }

    return true;
}

bool DesktopDuplication::InitializeDuplication() {
    HRESULT hr;

    // Create Desktop Duplication
    hr = m_output1->DuplicateOutput(m_device.Get(), &m_deskDupl);
    if (FAILED(hr)) {
        fprintf(stderr, "[DesktopDuplication] DuplicateOutput failed: 0x%08X\n", hr);
        return false;
    }

    return true;
}

bool DesktopDuplication::AcquireFrame() {
    if (!m_deskDupl) {
        return false;
    }

    HRESULT hr;
    ComPtr<IDXGIResource> desktopResource;
    DXGI_OUTDUPL_FRAME_INFO frameInfo;

    // Release previous frame if any
    ReleaseFrame();

    // Acquire next frame
    hr = m_deskDupl->AcquireNextFrame(0, &frameInfo, &desktopResource);
    
    if (hr == DXGI_ERROR_WAIT_TIMEOUT) {
        // No new frame available
        return false;
    }

    if (FAILED(hr)) {
        if (hr == DXGI_ERROR_ACCESS_LOST) {
            fprintf(stderr, "[DesktopDuplication] Access lost, reinitializing...\n");
            // Try to reinitialize
            m_deskDupl.Reset();
            if (!InitializeDuplication()) {
                return false;
            }
        } else {
            fprintf(stderr, "[DesktopDuplication] AcquireNextFrame failed: 0x%08X\n", hr);
        }
        return false;
    }

    // Query texture interface
    hr = desktopResource.As(&m_desktopImage);
    if (FAILED(hr)) {
        fprintf(stderr, "[DesktopDuplication] QueryInterface ID3D11Texture2D failed: 0x%08X\n", hr);
        m_deskDupl->ReleaseFrame();
        return false;
    }

    m_lastFrameTimestamp = frameInfo.LastPresentTime.QuadPart;
    m_frameNumber++;

    return true;
}

void DesktopDuplication::ReleaseFrame() {
    if (m_deskDupl) {
        m_deskDupl->ReleaseFrame();
    }
    m_desktopImage.Reset();
}

bool DesktopDuplication::CaptureFrame(uint8_t* frameData, uint32_t* width, uint32_t* height, int64_t* timestamp) {
    if (!m_initialized || !frameData || !width || !height || !timestamp) {
        return false;
    }

    // Try to acquire frame
    if (!AcquireFrame()) {
        return false;
    }

    // Get texture description
    D3D11_TEXTURE2D_DESC desc;
    m_desktopImage->GetDesc(&desc);

    *width = desc.Width;
    *height = desc.Height;
    *timestamp = m_lastFrameTimestamp;

    // Create staging texture to read from GPU
    ComPtr<ID3D11Texture2D> stagingTexture;
    desc.Usage = D3D11_USAGE_STAGING;
    desc.CPUAccessFlags = D3D11_CPU_ACCESS_READ;
    desc.BindFlags = 0;
    desc.MiscFlags = 0;

    HRESULT hr = m_device->CreateTexture2D(&desc, nullptr, &stagingTexture);
    if (FAILED(hr)) {
        fprintf(stderr, "[DesktopDuplication] CreateTexture2D (staging) failed: 0x%08X\n", hr);
        ReleaseFrame();
        return false;
    }

    // Copy from GPU to staging
    m_context->CopyResource(stagingTexture.Get(), m_desktopImage.Get());

    // Map and read pixels
    D3D11_MAPPED_SUBRESOURCE mapped;
    hr = m_context->Map(stagingTexture.Get(), 0, D3D11_MAP_READ, 0, &mapped);
    if (FAILED(hr)) {
        fprintf(stderr, "[DesktopDuplication] Map failed: 0x%08X\n", hr);
        ReleaseFrame();
        return false;
    }

    // Copy pixels (convert BGRA to RGBA)
    uint8_t* src = (uint8_t*)mapped.pData;
    uint32_t rowPitch = mapped.RowPitch;
    uint32_t bytesPerPixel = 4; // BGRA

    for (uint32_t y = 0; y < desc.Height; y++) {
        uint8_t* srcRow = src + (y * rowPitch);
        uint8_t* dstRow = frameData + (y * desc.Width * bytesPerPixel);
        
        for (uint32_t x = 0; x < desc.Width; x++) {
            // BGRA -> RGBA
            dstRow[x * 4 + 0] = srcRow[x * 4 + 2]; // R
            dstRow[x * 4 + 1] = srcRow[x * 4 + 1]; // G
            dstRow[x * 4 + 2] = srcRow[x * 4 + 0]; // B
            dstRow[x * 4 + 3] = srcRow[x * 4 + 3]; // A
        }
    }

    m_context->Unmap(stagingTexture.Get(), 0);
    ReleaseFrame();

    return true;
}

void DesktopDuplication::GetDesktopDimensions(uint32_t* width, uint32_t* height) {
    if (width) *width = m_desktopWidth;
    if (height) *height = m_desktopHeight;
}

void DesktopDuplication::Cleanup() {
    ReleaseFrame();
    m_deskDupl.Reset();
    m_output1.Reset();
    m_output.Reset();
    m_adapter.Reset();
    m_desktopImage.Reset();
    m_context.Reset();
    m_device.Reset();
    m_initialized = false;
}




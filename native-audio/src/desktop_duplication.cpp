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

    // Initialize D3D11 + Desktop Duplication (select a valid adapter/output)
    if (!InitializeD3D()) {
        fprintf(stderr, "[DesktopDuplication] Failed to initialize D3D11/Desktop Duplication\n");
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

    D3D_FEATURE_LEVEL featureLevels[] = {
        D3D_FEATURE_LEVEL_11_1,
        D3D_FEATURE_LEVEL_11_0,
        D3D_FEATURE_LEVEL_10_1,
        D3D_FEATURE_LEVEL_10_0
    };

    // Enumerate adapters/outputs and pick the first output that is AttachedToDesktop
    // and for which DuplicateOutput succeeds. This avoids hardcoding adapter0/output0
    // which can fail on hybrid GPU systems or when output0 isn't attached.
    for (UINT adapterIndex = 0;; adapterIndex++) {
        ComPtr<IDXGIAdapter1> adapter;
        hr = factory->EnumAdapters1(adapterIndex, &adapter);
        if (hr == DXGI_ERROR_NOT_FOUND) {
            break;
        }
        if (FAILED(hr) || !adapter) {
            continue;
        }

        for (UINT outputIndex = 0;; outputIndex++) {
            ComPtr<IDXGIOutput> output;
            hr = adapter->EnumOutputs(outputIndex, &output);
            if (hr == DXGI_ERROR_NOT_FOUND) {
                break;
            }
            if (FAILED(hr) || !output) {
                continue;
            }

            DXGI_OUTPUT_DESC desc;
            ZeroMemory(&desc, sizeof(desc));
            hr = output->GetDesc(&desc);
            if (FAILED(hr)) {
                continue;
            }

            if (!desc.AttachedToDesktop) {
                continue;
            }

            ComPtr<IDXGIOutput1> output1;
            hr = output.As(&output1);
            if (FAILED(hr) || !output1) {
                continue;
            }

            // Create D3D11 device for this adapter
            ComPtr<ID3D11Device> device;
            ComPtr<ID3D11DeviceContext> context;
            D3D_FEATURE_LEVEL featureLevel;

            const UINT createFlags = D3D11_CREATE_DEVICE_BGRA_SUPPORT;
            hr = D3D11CreateDevice(
                adapter.Get(),
                D3D_DRIVER_TYPE_HARDWARE,
                nullptr,
                createFlags,
                featureLevels,
                ARRAYSIZE(featureLevels),
                D3D11_SDK_VERSION,
                &device,
                &featureLevel,
                &context
            );

            if (FAILED(hr)) {
                fprintf(stderr, "[DesktopDuplication] D3D11CreateDevice(HARDWARE) failed on adapter %u: 0x%08X, trying UNKNOWN\n", adapterIndex, hr);
                hr = D3D11CreateDevice(
                    adapter.Get(),
                    D3D_DRIVER_TYPE_UNKNOWN,
                    nullptr,
                    createFlags,
                    featureLevels,
                    ARRAYSIZE(featureLevels),
                    D3D11_SDK_VERSION,
                    &device,
                    &featureLevel,
                    &context
                );
            }

            if (FAILED(hr) || !device || !context) {
                continue;
            }

            // Try Desktop Duplication for this output
            ComPtr<IDXGIOutputDuplication> deskDupl;
            hr = output1->DuplicateOutput(device.Get(), &deskDupl);
            if (FAILED(hr) || !deskDupl) {
                fprintf(stderr, "[DesktopDuplication] DuplicateOutput failed on adapter %u output %u: 0x%08X\n", adapterIndex, outputIndex, hr);
                continue;
            }

            // Success: store chosen adapter/output/device/duplication
            m_adapter = adapter;
            m_output = output;
            m_output1 = output1;
            m_device = device;
            m_context = context;
            m_deskDupl = deskDupl;
            m_outputDesc = desc;

            m_desktopWidth = m_outputDesc.DesktopCoordinates.right - m_outputDesc.DesktopCoordinates.left;
            m_desktopHeight = m_outputDesc.DesktopCoordinates.bottom - m_outputDesc.DesktopCoordinates.top;

            fprintf(stderr, "[DesktopDuplication] Selected adapter %u output %u (%ux%u)\n",
                adapterIndex, outputIndex, m_desktopWidth, m_desktopHeight);
            fprintf(stderr, "[DesktopDuplication] D3D device created successfully\n");

            return true;
        }
    }

    fprintf(stderr, "[DesktopDuplication] No usable AttachedToDesktop output found for Desktop Duplication\n");
    return false;
}

bool DesktopDuplication::InitializeDuplication() {
    HRESULT hr;

    // Create Desktop Duplication
    if (!m_output1 || !m_device) {
        return false;
    }

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






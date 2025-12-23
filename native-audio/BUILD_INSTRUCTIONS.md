# Building the WASAPI Native Module

## Prerequisites

1. **Visual Studio Build Tools** (required for Windows)
   - Download: https://visualstudio.microsoft.com/downloads/
   - Install "Desktop development with C++" workload
   - Or install Visual Studio Community with C++ support

2. **Python** (for node-gyp)
   - Usually comes with Node.js
   - Or download from python.org

3. **Node.js** (v18+)

## Build Steps

### 1. Install Dependencies

```bash
npm install
```

This will install `node-addon-api` and `node-gyp`.

### 2. Build the Native Module

```bash
npm run build:native
```

This will:
- Compile the C++ code
- Link with Windows libraries (ole32, oleaut32, winmm, ksuser)
- Create `build/Release/wasapi_capture.node`

### 3. For Electron (Important!)

If building for Electron, you need to rebuild with Electron's headers:

```bash
# Install electron-rebuild
npm install --save-dev electron-rebuild

# Rebuild for Electron
npx electron-rebuild -f -w wasapi_capture
```

Or manually specify Electron version:

```bash
cd native-audio
node-gyp rebuild --target=<electron-version> --arch=x64 --disturl=https://electronjs.org/headers
```

Replace `<electron-version>` with your Electron version (e.g., `28.0.0`).

## Troubleshooting

### "node-gyp not found"
```bash
npm install -g node-gyp
```

### "MSBuild not found"
- Install Visual Studio Build Tools
- Or run from "Developer Command Prompt for VS"

### "Cannot find module"
- Make sure you ran `npm run build:native`
- Check that `build/Release/wasapi_capture.node` exists
- For Electron, make sure you rebuilt with Electron headers

### Build Errors
- Make sure you have Windows SDK installed
- Check that Visual Studio C++ tools are installed
- Try running `npm run rebuild:native` to clean and rebuild





@echo off
echo ========================================
echo Building WASAPI Capture Native Module
echo Building for BOTH Node.js and Electron
echo ========================================
echo.

REM Set Python path (if available)
if exist "C:\KarmineDev\anaconda3\python.exe" (
    set PYTHON=C:\KarmineDev\anaconda3\python.exe
    echo Python found: %PYTHON%
) else (
    echo WARNING: Python not found at C:\KarmineDev\anaconda3\python.exe
    echo node-gyp may fail if Python is required
)

REM Set node-gyp variables
set GYP_MSVS_VERSION=2022
set GYP_MSVS_OVERRIDE_PATH=C:\Program Files\Microsoft Visual Studio\18\Community

REM Change to script directory
cd /d "%~dp0"
echo Current directory: %CD%
echo.

REM Check if FFmpeg is available
echo Checking FFmpeg dependencies...
set FFMPEG_INCLUDE=C:\vcpkg\installed\x64-windows\include
set FFMPEG_LIB=C:\vcpkg\installed\x64-windows\lib
set FFMPEG_BIN=C:\vcpkg\installed\x64-windows\bin

if not exist "%FFMPEG_INCLUDE%\libavcodec\avcodec.h" (
    echo WARNING: FFmpeg headers not found at %FFMPEG_INCLUDE%
    echo Please install FFmpeg via vcpkg or update FFMPEG_INCLUDE path
    echo.
) else (
    echo FFmpeg headers found: %FFMPEG_INCLUDE%
)

if not exist "%FFMPEG_LIB%\avcodec.lib" (
    echo WARNING: FFmpeg libraries not found at %FFMPEG_LIB%
    echo Please install FFmpeg via vcpkg or update FFMPEG_LIB path
    echo.
) else (
    echo FFMPEG libraries found: %FFMPEG_LIB%
)
echo.

REM ========================================
REM BUILD 1: Node.js Build
REM ========================================
echo ========================================
echo [BUILD 1/2] Building for Node.js
echo ========================================
echo.

REM Note: We skip calling vcvarsall.bat to avoid "command line too long" errors
REM node-gyp will automatically find and use Visual Studio 2022
echo [1/3] Using node-gyp auto-detection for Visual Studio...
echo       (Skipping vcvarsall.bat to avoid PATH length issues)

REM Build with node-gyp for Node.js
echo [2/3] Building native module with node-gyp (Node.js)...
if exist "%~dp0\..\node_modules\.bin\node-gyp.cmd" (
    call "%~dp0\..\node_modules\.bin\node-gyp.cmd" rebuild --msvs_version=2022
) else if exist "%~dp0node_modules\.bin\node-gyp.cmd" (
    call "%~dp0node_modules\.bin\node-gyp.cmd" rebuild --msvs_version=2022
) else (
    REM Try global node-gyp
    node-gyp rebuild --msvs_version=2022
)
if errorlevel 1 (
    echo.
    echo ERROR: Node.js build failed!
    echo.
    echo Possible solutions:
    echo 1. Install Python 3.x and add to PATH
    echo 2. Set PYTHON environment variable: set PYTHON=C:\Path\To\python.exe
    echo 3. Install FFmpeg via vcpkg: vcpkg install ffmpeg:x64-windows
    echo 4. Update FFMPEG_INCLUDE and FFMPEG_LIB paths
    echo.
    pause
    exit /b 1
)

REM Copy FFmpeg DLLs to output directory (Node.js build)
echo [3/3] Copying FFmpeg DLLs to build output (Node.js)...
set BUILD_OUTPUT=build\Release
if exist "%BUILD_OUTPUT%\wasapi_capture.node" (
    echo Module compiled successfully: %BUILD_OUTPUT%\wasapi_capture.node
    
    REM Try standard vcpkg bin directory first
    if exist "%FFMPEG_BIN%\avcodec.dll" (
        echo Copying FFmpeg DLLs from %FFMPEG_BIN%...
        copy /Y "%FFMPEG_BIN%\avcodec.dll" "%BUILD_OUTPUT%\" >nul 2>&1
        copy /Y "%FFMPEG_BIN%\avformat.dll" "%BUILD_OUTPUT%\" >nul 2>&1
        copy /Y "%FFMPEG_BIN%\avutil.dll" "%BUILD_OUTPUT%\" >nul 2>&1
        copy /Y "%FFMPEG_BIN%\swresample.dll" "%BUILD_OUTPUT%\" >nul 2>&1
        
        REM Copy libx264 DLL (dependency of avcodec.dll)
        if exist "%FFMPEG_BIN%\libx264-164.dll" (
            copy /Y "%FFMPEG_BIN%\libx264-164.dll" "%BUILD_OUTPUT%\" >nul 2>&1
        )
        
        if exist "%BUILD_OUTPUT%\avcodec.dll" (
            echo FFmpeg DLLs copied successfully
        ) else (
            goto :try_buildtrees_node
        )
    ) else (
        :try_buildtrees_node
        REM If not found, try buildtrees (debug build)
        if exist "C:\vcpkg\buildtrees\ffmpeg\x64-windows-dbg\libavcodec\avcodec.dll" (
            echo Copying FFmpeg DLLs from buildtrees...
            set FFMPEG_BUILDTREE=C:\vcpkg\buildtrees\ffmpeg\x64-windows-dbg
            
            REM Copy main DLLs
            copy /Y "%FFMPEG_BUILDTREE%\libavcodec\avcodec.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            copy /Y "%FFMPEG_BUILDTREE%\libavformat\avformat.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            copy /Y "%FFMPEG_BUILDTREE%\libavutil\avutil.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            copy /Y "%FFMPEG_BUILDTREE%\libswresample\swresample.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            
            REM Copy libx264 DLL (dependency of avcodec.dll)
            if exist "C:\vcpkg\installed\x64-windows\bin\libx264-164.dll" (
                copy /Y "C:\vcpkg\installed\x64-windows\bin\libx264-164.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            ) else if exist "C:\vcpkg\buildtrees\x264\x64-windows-dbg\libx264-164.dll" (
                copy /Y "C:\vcpkg\buildtrees\x264\x64-windows-dbg\libx264-164.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            )
            
            REM Copy all other DLLs from buildtree (dependencies)
            for /r "%FFMPEG_BUILDTREE%" %%f in (*.dll) do (
                copy /Y "%%f" "%BUILD_OUTPUT%\" >nul 2>&1
            )
            
            if exist "%BUILD_OUTPUT%\avcodec.dll" (
                echo FFmpeg DLLs copied successfully from buildtrees
            ) else (
                echo WARNING: Failed to copy FFmpeg DLLs from buildtrees
                echo The module may fail to load at runtime
                echo Please run fix_dlls.bat manually
            )
        ) else (
            echo WARNING: FFmpeg DLLs not found in standard locations
            echo The module may fail to load at runtime
            echo Please run fix_dlls.bat manually or install FFmpeg via vcpkg
        )
    )
) else (
    echo ERROR: Compiled module not found at %BUILD_OUTPUT%\wasapi_capture.node
    pause
    exit /b 1
)

echo.
echo ========================================
echo Node.js build completed successfully!
echo ========================================
echo.
echo Output: %BUILD_OUTPUT%\wasapi_capture.node
echo.

REM Save Node.js build before Electron build overwrites it
if exist "%BUILD_OUTPUT%\wasapi_capture.node" (
    echo Saving Node.js build...
    if not exist "build\Release-NodeJS" mkdir "build\Release-NodeJS"
    copy /Y "%BUILD_OUTPUT%\wasapi_capture.node" "build\Release-NodeJS\wasapi_capture.node" >nul 2>&1
    if exist "%BUILD_OUTPUT%\*.dll" (
        copy /Y "%BUILD_OUTPUT%\*.dll" "build\Release-NodeJS\" >nul 2>&1
    )
    echo Node.js build saved to: build\Release-NodeJS\
    echo.
    echo To use Node.js build later, copy from build\Release-NodeJS\ to build\Release\
    echo.
)
pause

REM ========================================
REM BUILD 2: Electron Build
REM ========================================
echo.
echo ========================================
echo [BUILD 2/2] Building for Electron
echo ========================================
echo.

REM Setup Visual Studio environment for Electron build
echo [1/3] Setting up Visual Studio environment...
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat" x64
if errorlevel 1 (
    echo ERROR: Failed to setup Visual Studio environment
    echo Continuing anyway (node-gyp may still work)...
)

REM Build with node-gyp for Electron
echo [2/3] Building native module with node-gyp for Electron...
echo Target: Electron 28.0.0
if exist "%~dp0\..\node_modules\.bin\node-gyp.cmd" (
    call "%~dp0\..\node_modules\.bin\node-gyp.cmd" rebuild --target=28.0.0 --arch=x64 --disturl=https://electronjs.org/headers --msvs_version=2022
) else if exist "%~dp0node_modules\.bin\node-gyp.cmd" (
    call "%~dp0node_modules\.bin\node-gyp.cmd" rebuild --target=28.0.0 --arch=x64 --disturl=https://electronjs.org/headers --msvs_version=2022
) else (
    REM Try global node-gyp
    node-gyp rebuild --target=28.0.0 --arch=x64 --disturl=https://electronjs.org/headers --msvs_version=2022
)
if errorlevel 1 (
    echo.
    echo ERROR: Electron build failed!
    echo.
    echo Possible solutions:
    echo 1. Install Python 3.x and add to PATH
    echo 2. Set PYTHON environment variable: set PYTHON=C:\Path\To\python.exe
    echo 3. Install FFmpeg via vcpkg: vcpkg install ffmpeg:x64-windows
    echo 4. Update FFMPEG_INCLUDE and FFMPEG_LIB paths
    echo.
    pause
    exit /b 1
)

REM Copy FFmpeg DLLs to output directory (Electron build)
echo [3/3] Copying FFmpeg DLLs to build output (Electron)...
if exist "%BUILD_OUTPUT%\wasapi_capture.node" (
    echo Module compiled successfully: %BUILD_OUTPUT%\wasapi_capture.node
    
    REM Try standard vcpkg bin directory first
    if exist "%FFMPEG_BIN%\avcodec.dll" (
        echo Copying FFmpeg DLLs from %FFMPEG_BIN%...
        copy /Y "%FFMPEG_BIN%\avcodec.dll" "%BUILD_OUTPUT%\" >nul 2>&1
        copy /Y "%FFMPEG_BIN%\avformat.dll" "%BUILD_OUTPUT%\" >nul 2>&1
        copy /Y "%FFMPEG_BIN%\avutil.dll" "%BUILD_OUTPUT%\" >nul 2>&1
        copy /Y "%FFMPEG_BIN%\swresample.dll" "%BUILD_OUTPUT%\" >nul 2>&1
        
        REM Copy libx264 DLL (dependency of avcodec.dll)
        if exist "%FFMPEG_BIN%\libx264-164.dll" (
            copy /Y "%FFMPEG_BIN%\libx264-164.dll" "%BUILD_OUTPUT%\" >nul 2>&1
        )
        
        if exist "%BUILD_OUTPUT%\avcodec.dll" (
            echo FFmpeg DLLs copied successfully
        ) else (
            goto :try_buildtrees_electron
        )
    ) else (
        :try_buildtrees_electron
        REM If not found, try buildtrees (debug build)
        if exist "C:\vcpkg\buildtrees\ffmpeg\x64-windows-dbg\libavcodec\avcodec.dll" (
            echo Copying FFmpeg DLLs from buildtrees...
            set FFMPEG_BUILDTREE=C:\vcpkg\buildtrees\ffmpeg\x64-windows-dbg
            
            REM Copy main DLLs
            copy /Y "%FFMPEG_BUILDTREE%\libavcodec\avcodec.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            copy /Y "%FFMPEG_BUILDTREE%\libavformat\avformat.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            copy /Y "%FFMPEG_BUILDTREE%\libavutil\avutil.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            copy /Y "%FFMPEG_BUILDTREE%\libswresample\swresample.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            
            REM Copy libx264 DLL (dependency of avcodec.dll)
            if exist "C:\vcpkg\installed\x64-windows\bin\libx264-164.dll" (
                copy /Y "C:\vcpkg\installed\x64-windows\bin\libx264-164.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            ) else if exist "C:\vcpkg\buildtrees\x264\x64-windows-dbg\libx264-164.dll" (
                copy /Y "C:\vcpkg\buildtrees\x264\x64-windows-dbg\libx264-164.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            )
            
            REM Copy all other DLLs from buildtree (dependencies)
            for /r "%FFMPEG_BUILDTREE%" %%f in (*.dll) do (
                copy /Y "%%f" "%BUILD_OUTPUT%\" >nul 2>&1
            )
            
            if exist "%BUILD_OUTPUT%\avcodec.dll" (
                echo FFmpeg DLLs copied successfully from buildtrees
            ) else (
                echo WARNING: Failed to copy FFmpeg DLLs from buildtrees
                echo The module may fail to load at runtime
                echo Please run fix_dlls.bat manually
            )
        ) else (
            echo WARNING: FFmpeg DLLs not found in standard locations
            echo The module may fail to load at runtime
            echo Please run fix_dlls.bat manually or install FFmpeg via vcpkg
        )
    )
) else (
    echo ERROR: Compiled module not found at %BUILD_OUTPUT%\wasapi_capture.node
    pause
    exit /b 1
)

echo.
echo ========================================
echo Electron build completed successfully!
echo ========================================
echo.
echo Output: %BUILD_OUTPUT%\wasapi_capture.node
echo Compiled for Electron 28.0.0
echo.

REM Run fix_dlls.bat to ensure all DLLs are copied
if exist "%~dp0fix_dlls.bat" (
    echo Running fix_dlls.bat to copy FFmpeg DLLs...
    call "%~dp0fix_dlls.bat"
) else (
    echo WARNING: fix_dlls.bat not found, DLLs may be missing
)

echo.
echo ========================================
echo ALL BUILDS COMPLETED SUCCESSFULLY!
echo ========================================
echo.
echo Both Node.js and Electron builds are ready.
echo.
pause


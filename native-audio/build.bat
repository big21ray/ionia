@echo off
echo ========================================
echo Building WASAPI Capture Native Module
echo ========================================
echo.

REM Setup Visual Studio environment
echo [1/4] Setting up Visual Studio environment...
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat" x64
if errorlevel 1 (
    echo ERROR: Failed to setup Visual Studio environment
    pause
    exit /b 1
)

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
echo [2/4] Checking FFmpeg dependencies...
set FFMPEG_INCLUDE=C:\vcpkg\installed\x64-windows\include
set FFMPEG_LIB=C:\vcpkg\installed\x64-windows\lib
set FFMPEG_BIN=C:\vcpkg\installed\x64-windows\bin

if not exist "%FFMPEG_INCLUDE%\libavcodec\avcodec.h" (
    echo WARNING: FFmpeg headers not found at %FFMPEG_INCLUDE%
    echo Please install FFmpeg via vcpkg or update FFMPEG_INCLUDE path in build.bat
    echo.
) else (
    echo FFmpeg headers found: %FFMPEG_INCLUDE%
)

if not exist "%FFMPEG_LIB%\avcodec.lib" (
    echo WARNING: FFmpeg libraries not found at %FFMPEG_LIB%
    echo Please install FFmpeg via vcpkg or update FFMPEG_LIB path in build.bat
    echo.
) else (
    echo FFmpeg libraries found: %FFMPEG_LIB%
)
echo.

REM Build with node-gyp
echo [3/4] Building native module with node-gyp...
call "%~dp0\..\node_modules\.bin\node-gyp.cmd" rebuild --msvs_version=2022
if errorlevel 1 (
    echo.
    echo ERROR: Build failed!
    echo.
    echo Possible solutions:
    echo 1. Install Python 3.x and add to PATH
    echo 2. Set PYTHON environment variable: set PYTHON=C:\Path\To\python.exe
    echo 3. Install FFmpeg via vcpkg: vcpkg install ffmpeg:x64-windows
    echo 4. Update FFMPEG_INCLUDE and FFMPEG_LIB paths in build.bat
    echo.
    pause
    exit /b 1
)
echo.

REM Copy FFmpeg DLLs to output directory
echo [4/4] Copying FFmpeg DLLs to build output...
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
        
        if exist "%BUILD_OUTPUT%\avcodec.dll" (
            echo FFmpeg DLLs copied successfully
        ) else (
            goto :try_buildtrees
        )
    ) else (
        :try_buildtrees
        REM If not found, try buildtrees (debug build)
        if exist "C:\vcpkg\buildtrees\ffmpeg\x64-windows-dbg\libavcodec\avcodec.dll" (
            echo Copying FFmpeg DLLs from buildtrees...
            set FFMPEG_BUILDTREE=C:\vcpkg\buildtrees\ffmpeg\x64-windows-dbg
            
            REM Copy main DLLs
            copy /Y "%FFMPEG_BUILDTREE%\libavcodec\avcodec.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            copy /Y "%FFMPEG_BUILDTREE%\libavformat\avformat.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            copy /Y "%FFMPEG_BUILDTREE%\libavutil\avutil.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            copy /Y "%FFMPEG_BUILDTREE%\libswresample\swresample.dll" "%BUILD_OUTPUT%\" >nul 2>&1
            
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
echo Build completed successfully!
echo ========================================
echo.
echo Output: %BUILD_OUTPUT%\wasapi_capture.node
echo.

REM Run fix_dlls.bat to ensure all DLLs are copied
if exist "%~dp0fix_dlls.bat" (
    echo Running fix_dlls.bat to copy FFmpeg DLLs...
    call "%~dp0fix_dlls.bat"
) else (
    echo WARNING: fix_dlls.bat not found, DLLs may be missing
)

echo.
pause


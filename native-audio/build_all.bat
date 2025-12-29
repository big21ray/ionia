@echo off
setlocal

REM Non-interactive by default. Use:
REM   build_all.bat --interactive
set "BUILD_INTERACTIVE=0"
if /I "%~1"=="--interactive" set "BUILD_INTERACTIVE=1"

echo ========================================
echo Building WASAPI Capture Native Module
echo Building for BOTH Node.js and Electron
echo ========================================
echo.

REM Locate Python for node-gyp (required)
set "PYTHON="
if exist "C:\KarmineDev\anaconda3\python.exe" (
    set "PYTHON=C:\KarmineDev\anaconda3\python.exe"
    goto :python_found
)
for /f "delims=" %%i in ('where python.exe 2^>nul') do (
    set "PYTHON=%%i"
    goto :python_found
)
:python_found
if defined PYTHON (
    echo Python found: %PYTHON%
) else (
    echo WARNING: Python not found on PATH.
    echo node-gyp will fail until Python 3 is installed.
    echo Suggested: install Python 3 from python.org or: winget install Python.Python.3.12
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
    call :maybe_pause
    exit /b 1
)

REM Copy FFmpeg DLLs to output directory (Node.js build)
echo [3/3] Copying FFmpeg DLLs to build output (Node.js)...
set BUILD_OUTPUT=build\Release
call :copy_ffmpeg_dlls

if not exist "%BUILD_OUTPUT%\wasapi_video_audio.node" (
    echo ERROR: Compiled module not found at %BUILD_OUTPUT%\wasapi_video_audio.node
    call :maybe_pause
    exit /b 1
)

echo.
echo ========================================
echo Node.js build completed successfully!
echo ========================================
echo.
echo Output: %BUILD_OUTPUT%\wasapi_video_audio.node
echo.

REM Save Node.js build before Electron build overwrites it
if exist "%BUILD_OUTPUT%\wasapi_video_audio.node" (
    echo Saving Node.js build...
    if not exist "build\Release-NodeJS" mkdir "build\Release-NodeJS"
    copy /Y "%BUILD_OUTPUT%\wasapi_video_audio.node" "build\Release-NodeJS\wasapi_video_audio.node" >nul 2>&1
    if exist "%BUILD_OUTPUT%\*.dll" (
        copy /Y "%BUILD_OUTPUT%\*.dll" "build\Release-NodeJS\" >nul 2>&1
    )
    echo Node.js build saved to: build\Release-NodeJS\
    echo.
    echo To use Node.js build later, copy from build\Release-NodeJS\ to build\Release\
    echo.
)
    call :maybe_pause

REM ========================================
REM BUILD 2: Electron Build
REM ========================================
echo.
echo ========================================
echo [BUILD 2/2] Building for Electron
echo ========================================
echo.

REM Build for Electron using the dedicated script (keeps Electron version in sync)
echo [1/3] Building native module for Electron...
call "%~dp0build_electron.bat"
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
    call :maybe_pause
    exit /b 1
)

REM Copy FFmpeg DLLs to output directory (Electron build)
echo [3/3] Copying FFmpeg DLLs to build output (Electron)...
call :copy_ffmpeg_dlls

if not exist "%BUILD_OUTPUT%\wasapi_video_audio.node" (
    echo ERROR: Compiled module not found at %BUILD_OUTPUT%\wasapi_video_audio.node
    call :maybe_pause
    exit /b 1
)

echo.
echo ========================================
echo Electron build completed successfully!
echo ========================================
echo.
echo Output: %BUILD_OUTPUT%\wasapi_video_audio.node
echo Compiled for Electron
echo.

REM Verify DLLs are present
call :verify_dlls

echo.
echo ========================================
echo ALL BUILDS COMPLETED SUCCESSFULLY!
echo ========================================
echo.
echo Both Node.js and Electron builds are ready.
echo.
call :maybe_pause
exit /b 0

:maybe_pause
if "%BUILD_INTERACTIVE%"=="1" pause
goto :eof

REM ========================================
REM Function: Copy FFmpeg DLLs
REM ========================================
:copy_ffmpeg_dlls
set FOUND=0

REM Check vcpkg installed (preferred)
if exist "%FFMPEG_BIN%\avcodec.dll" (
    set FFMPEG_SOURCE=%FFMPEG_BIN%
    set FOUND=1
    goto :copy_from_source
)

REM vcpkg may only ship versioned DLLs (e.g. avcodec-61.dll)
for %%G in ("%FFMPEG_BIN%\avcodec-*.dll") do (
    if exist "%%~fG" (
        set FFMPEG_SOURCE=%FFMPEG_BIN%
        set FOUND=1
        goto :copy_from_source
    )
)

REM Check vcpkg buildtrees (debug build) - DLLs are in separate subdirectories
if exist "C:\vcpkg\buildtrees\ffmpeg\x64-windows-dbg\libavcodec\avcodec.dll" (
    echo WARNING: Found debug DLLs in buildtrees (not recommended for production)
    echo Location: C:\vcpkg\buildtrees\ffmpeg\x64-windows-dbg\
    echo.
    set FFMPEG_BUILDTREE=C:\vcpkg\buildtrees\ffmpeg\x64-windows-dbg
    set FOUND=1
    goto :copy_from_buildtree
)

REM Check if FFmpeg is in PATH
where avcodec.dll >nul 2>&1
if %errorlevel% == 0 (
    for /f "delims=" %%i in ('where avcodec.dll') do (
        set FFMPEG_SOURCE=%%~dpi
        set FOUND=1
        goto :copy_from_source
    )
)

REM Check common FFmpeg installation locations
if exist "C:\ffmpeg\bin\avcodec.dll" (
    set FFMPEG_SOURCE=C:\ffmpeg\bin
    set FOUND=1
    goto :copy_from_source
)

if exist "C:\ffmpeg-dev\bin\avcodec.dll" (
    set FFMPEG_SOURCE=C:\ffmpeg-dev\bin
    set FOUND=1
    goto :copy_from_source
)

REM If not found, show error
if %FOUND% == 0 (
    echo ERROR: FFmpeg DLLs not found!
    echo.
    echo Please install FFmpeg via vcpkg:
    echo   1. cd C:\vcpkg
    echo   2. .\vcpkg install ffmpeg[nonfree,x264]:x64-windows --recurse
    echo   3. Run this script again
    echo.
    exit /b 1
)

:copy_from_source
echo Found FFmpeg DLLs at: %FFMPEG_SOURCE%
echo Copying DLLs to %BUILD_OUTPUT%...
if not exist "%BUILD_OUTPUT%" mkdir "%BUILD_OUTPUT%"

REM Copy both unversioned and versioned FFmpeg DLLs.
REM Note: `if exist` does NOT reliably match wildcards with full paths, so we
REM iterate resolved filenames via `for`.
for %%P in (avcodec avformat avutil swresample swscale avfilter avdevice) do (
    for %%G in ("%FFMPEG_SOURCE%\%%P*.dll") do (
        if exist "%%~fG" (
            copy /Y "%%~fG" "%BUILD_OUTPUT%\" >nul 2>&1
            if not errorlevel 1 (
                echo [OK] %%~nxG
            ) else (
                echo WARNING: Failed to copy %%~nxG
            )
        )
    )
)

REM Copy libx264 DLL (dependency of avcodec.dll)
for %%X in ("%FFMPEG_SOURCE%\libx264-*.dll" "C:\vcpkg\installed\x64-windows\bin\libx264-*.dll") do (
    for %%f in (%%X) do (
        if exist "%%~ff" (
            copy /Y "%%~ff" "%BUILD_OUTPUT%\" >nul 2>&1
            if not errorlevel 1 (
                echo [OK] %%~nxf
            )
        )
    )
)
goto :eof

:copy_from_buildtree
echo Found FFmpeg DLLs in buildtree: %FFMPEG_BUILDTREE%
echo Copying DLLs from separate subdirectories...
copy /Y "%FFMPEG_BUILDTREE%\libavcodec\avcodec.dll" "%BUILD_OUTPUT%\" >nul 2>&1
if errorlevel 1 (
    echo ERROR: Failed to copy avcodec.dll
) else (
    echo [OK] avcodec.dll
)

copy /Y "%FFMPEG_BUILDTREE%\libavformat\avformat.dll" "%BUILD_OUTPUT%\" >nul 2>&1
if errorlevel 1 (
    echo ERROR: Failed to copy avformat.dll
) else (
    echo [OK] avformat.dll
)

copy /Y "%FFMPEG_BUILDTREE%\libavutil\avutil.dll" "%BUILD_OUTPUT%\" >nul 2>&1
if errorlevel 1 (
    echo ERROR: Failed to copy avutil.dll
) else (
    echo [OK] avutil.dll
)

copy /Y "%FFMPEG_BUILDTREE%\libswresample\swresample.dll" "%BUILD_OUTPUT%\" >nul 2>&1
if errorlevel 1 (
    echo ERROR: Failed to copy swresample.dll
) else (
    echo [OK] swresample.dll
)

REM Copy libx264 DLL (dependency of avcodec.dll)
if exist "C:\vcpkg\installed\x64-windows\bin\libx264-164.dll" (
    copy /Y "C:\vcpkg\installed\x64-windows\bin\libx264-164.dll" "%BUILD_OUTPUT%\" >nul 2>&1
    if not errorlevel 1 (
        echo [OK] libx264-164.dll (from vcpkg installed)
    )
) else (
    REM Try to find in buildtrees
    if exist "C:\vcpkg\buildtrees\x264\x64-windows-dbg\libx264-164.dll" (
        copy /Y "C:\vcpkg\buildtrees\x264\x64-windows-dbg\libx264-164.dll" "%BUILD_OUTPUT%\" >nul 2>&1
        if not errorlevel 1 (
            echo [OK] libx264-164.dll (from buildtrees)
        )
    )
)

REM Copy all other DLLs from buildtree (dependencies)
echo.
echo Copying additional dependencies...
for /r "%FFMPEG_BUILDTREE%" %%f in (*.dll) do (
    copy /Y "%%f" "%BUILD_OUTPUT%\" >nul 2>&1
    if not errorlevel 1 (
        echo [OK] %%~nxf
    )
)
goto :eof

REM ========================================
REM Function: Verify DLLs
REM ========================================
:verify_dlls
echo.
echo Verifying copied DLLs...
set "OK_AVCODEC=0"
for %%G in ("%BUILD_OUTPUT%\avcodec*.dll") do if exist "%%~fG" set "OK_AVCODEC=1"

set "OK_AVFORMAT=0"
for %%G in ("%BUILD_OUTPUT%\avformat*.dll") do if exist "%%~fG" set "OK_AVFORMAT=1"

set "OK_AVUTIL=0"
for %%G in ("%BUILD_OUTPUT%\avutil*.dll") do if exist "%%~fG" set "OK_AVUTIL=1"

set "OK_SWRESAMPLE=0"
for %%G in ("%BUILD_OUTPUT%\swresample*.dll") do if exist "%%~fG" set "OK_SWRESAMPLE=1"

set "OK_SWSCALE=0"
for %%G in ("%BUILD_OUTPUT%\swscale*.dll") do if exist "%%~fG" set "OK_SWSCALE=1"

if "%OK_AVCODEC%"=="0" (
    echo ERROR: avcodec DLL missing
    goto :eof
)
if "%OK_AVFORMAT%"=="0" (
    echo ERROR: avformat DLL missing
    goto :eof
)
if "%OK_AVUTIL%"=="0" (
    echo ERROR: avutil DLL missing
    goto :eof
)
if "%OK_SWRESAMPLE%"=="0" (
    echo ERROR: swresample DLL missing
    goto :eof
)

echo.
echo ========================================
echo ✅ Core FFmpeg DLLs present
echo ========================================
if "%OK_SWSCALE%"=="0" echo WARNING: swscale DLL missing (conversion may fail)
echo.
echo DLLs in %BUILD_OUTPUT%:
dir /B "%BUILD_OUTPUT%\*.dll"
echo.
goto :eof

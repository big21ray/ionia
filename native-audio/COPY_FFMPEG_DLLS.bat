@echo off
echo ========================================
echo Copying FFmpeg DLLs to build output
echo ========================================
echo.

set BUILD_OUTPUT=build\Release
set VCPKG_BIN=C:\vcpkg\installed\x64-windows\bin

if not exist "%BUILD_OUTPUT%" (
    echo ERROR: Build output directory not found: %BUILD_OUTPUT%
    echo Please compile the module first with build.bat
    pause
    exit /b 1
)

if not exist "%VCPKG_BIN%\avcodec.dll" (
    echo ERROR: FFmpeg DLLs not found at %VCPKG_BIN%
    echo.
    echo Please install FFmpeg via vcpkg:
    echo   cd C:\vcpkg
    echo   .\vcpkg install ffmpeg:x64-windows
    echo.
    echo Or update VCPKG_BIN path in this script if FFmpeg is installed elsewhere.
    pause
    exit /b 1
)

echo Copying DLLs from %VCPKG_BIN% to %BUILD_OUTPUT%...
echo.

copy /Y "%VCPKG_BIN%\avcodec.dll" "%BUILD_OUTPUT%\" && echo [OK] avcodec.dll
copy /Y "%VCPKG_BIN%\avformat.dll" "%BUILD_OUTPUT%\" && echo [OK] avformat.dll
copy /Y "%VCPKG_BIN%\avutil.dll" "%BUILD_OUTPUT%\" && echo [OK] avutil.dll
copy /Y "%VCPKG_BIN%\swresample.dll" "%BUILD_OUTPUT%\" && echo [OK] swresample.dll

echo.
echo Checking copied DLLs...
if exist "%BUILD_OUTPUT%\avcodec.dll" (
    echo ✅ All FFmpeg DLLs copied successfully!
    echo.
    echo DLLs in %BUILD_OUTPUT%:
    dir /B "%BUILD_OUTPUT%\*.dll"
) else (
    echo ❌ Failed to copy DLLs
    pause
    exit /b 1
)

echo.
echo ========================================
echo Done! You can now test the module.
echo ========================================
pause


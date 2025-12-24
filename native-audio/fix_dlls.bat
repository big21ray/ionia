@echo off
echo ========================================
echo Fixing FFmpeg DLLs for wasapi_capture
echo ========================================
echo.

set BUILD_OUTPUT=build\Release
set MODULE_FILE=%BUILD_OUTPUT%\wasapi_capture.node

REM Check if module exists
if not exist "%MODULE_FILE%" (
    echo ERROR: Module not found: %MODULE_FILE%
    echo Please compile first with build.bat
    pause
    exit /b 1
)

echo Module found: %MODULE_FILE%
echo.

REM Try multiple possible locations for FFmpeg DLLs
echo Searching for FFmpeg DLLs...
echo.

set FOUND=0

REM Check vcpkg installed
if exist "C:\vcpkg\installed\x64-windows\bin\avcodec.dll" (
    set FFMPEG_SOURCE=C:\vcpkg\installed\x64-windows\bin
    set FOUND=1
    goto :copy_dlls
)

REM Check vcpkg buildtrees (debug build) - DLLs are in separate subdirectories
if exist "C:\vcpkg\buildtrees\ffmpeg\x64-windows-dbg\libavcodec\avcodec.dll" (
    echo WARNING: Found debug DLLs in buildtrees (not recommended for production)
    echo Location: C:\vcpkg\buildtrees\ffmpeg\x64-windows-dbg\
    echo.
    echo You should install FFmpeg properly:
    echo   cd C:\vcpkg
    echo   .\vcpkg install ffmpeg:x64-windows
    echo.
    set FFMPEG_BUILDTREE=C:\vcpkg\buildtrees\ffmpeg\x64-windows-dbg
    set FOUND=1
    goto :copy_dlls_from_buildtree
)

REM Check if FFmpeg is in PATH
where avcodec.dll >nul 2>&1
if %errorlevel% == 0 (
    for /f "delims=" %%i in ('where avcodec.dll') do (
        set FFMPEG_SOURCE=%%~dpi
        set FOUND=1
        goto :copy_dlls
    )
)

REM Check common FFmpeg installation locations
if exist "C:\ffmpeg\bin\avcodec.dll" (
    set FFMPEG_SOURCE=C:\ffmpeg\bin
    set FOUND=1
    goto :copy_dlls
)

if exist "C:\ffmpeg-dev\bin\avcodec.dll" (
    set FFMPEG_SOURCE=C:\ffmpeg-dev\bin
    set FOUND=1
    goto :copy_dlls
)

REM If not found, show error
echo ERROR: FFmpeg DLLs not found!
echo.
echo Please install FFmpeg via vcpkg:
echo   1. cd C:\vcpkg
echo   2. .\vcpkg install ffmpeg:x64-windows
echo   3. Run this script again
echo.
echo Or manually copy the following DLLs to %BUILD_OUTPUT%:
echo   - avcodec.dll
echo   - avformat.dll
echo   - avutil.dll
echo   - swresample.dll
echo.
pause
exit /b 1

:copy_dlls
echo Found FFmpeg DLLs at: %FFMPEG_SOURCE%
echo.
echo Copying DLLs to %BUILD_OUTPUT%...
echo.

copy /Y "%FFMPEG_SOURCE%\avcodec.dll" "%BUILD_OUTPUT%\" >nul 2>&1
if errorlevel 1 (
    echo ERROR: Failed to copy avcodec.dll
) else (
    echo [OK] avcodec.dll
)

copy /Y "%FFMPEG_SOURCE%\avformat.dll" "%BUILD_OUTPUT%\" >nul 2>&1
if errorlevel 1 (
    echo ERROR: Failed to copy avformat.dll
) else (
    echo [OK] avformat.dll
)

copy /Y "%FFMPEG_SOURCE%\avutil.dll" "%BUILD_OUTPUT%\" >nul 2>&1
if errorlevel 1 (
    echo ERROR: Failed to copy avutil.dll
) else (
    echo [OK] avutil.dll
)

copy /Y "%FFMPEG_SOURCE%\swresample.dll" "%BUILD_OUTPUT%\" >nul 2>&1
if errorlevel 1 (
    echo ERROR: Failed to copy swresample.dll
) else (
    echo [OK] swresample.dll
)
goto :verify

:copy_dlls_from_buildtree
echo Found FFmpeg DLLs in buildtree: %FFMPEG_BUILDTREE%
echo.
echo Copying DLLs from separate subdirectories...
echo.

REM Copy main FFmpeg DLLs
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

REM Copy all other DLLs from buildtree (dependencies)
echo.
echo Copying additional dependencies...
for /r "%FFMPEG_BUILDTREE%" %%f in (*.dll) do (
    copy /Y "%%f" "%BUILD_OUTPUT%\" >nul 2>&1
    if not errorlevel 1 (
        echo [OK] %%~nxf
    )
)

:verify

echo.
echo Verifying copied DLLs...
if exist "%BUILD_OUTPUT%\avcodec.dll" (
    if exist "%BUILD_OUTPUT%\avformat.dll" (
        if exist "%BUILD_OUTPUT%\avutil.dll" (
            if exist "%BUILD_OUTPUT%\swresample.dll" (
                echo.
                echo ========================================
                echo ✅ All DLLs copied successfully!
                echo ========================================
                echo.
                echo DLLs in %BUILD_OUTPUT%:
                dir /B "%BUILD_OUTPUT%\*.dll"
                echo.
                echo You can now test the module:
                echo   node debug_three_aac.js
                echo.
            ) else (
                echo ERROR: swresample.dll missing
            )
        ) else (
            echo ERROR: avutil.dll missing
        )
    ) else (
        echo ERROR: avformat.dll missing
    )
) else (
    echo ERROR: avcodec.dll missing
)

pause


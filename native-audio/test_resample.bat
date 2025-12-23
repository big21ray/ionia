@echo off
echo Building test_resample.exe...
cd /d "%~dp0"
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat" >nul 2>&1
npx node-gyp configure --msvs_version=2022 --python="C:\KarmineDev\anaconda3\python.exe"
npx node-gyp build --msvs_version=2022 --python="C:\KarmineDev\anaconda3\python.exe"

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Running test_resample...
    echo.
    if exist "debug_desktop_raw.wav" if exist "debug_mic_raw.wav" (
        build\Release\test_resample.exe debug_desktop_raw.wav debug_mic_raw.wav test_output_mixed.wav
    ) else (
        echo Error: debug_desktop_raw.wav or debug_mic_raw.wav not found!
        echo Please run debug_record_wav.js first to generate the WAV files.
        exit /b 1
    )
) else (
    echo Build failed!
    exit /b 1
)


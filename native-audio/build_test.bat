@echo off
echo Building test_resample.exe...
cd /d "%~dp0"

call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvars64.bat"

if not exist build\Release mkdir build\Release

echo Compiling test_resample.cpp...
cl /EHsc /O2 /MD test_resample.cpp /Fe:"build\Release\test_resample.exe"
if %ERRORLEVEL% NEQ 0 exit /b 1

if %ERRORLEVEL% EQU 0 (
    echo.
    echo Build successful!
    echo.
    if exist "debug_desktop_raw.wav" if exist "debug_mic_raw.wav" (
        echo Running test_resample...
        echo.
        build\Release\test_resample.exe debug_desktop_raw.wav debug_mic_raw.wav desktop_processed.wav mic_processed.wav
    ) else (
        echo Note: debug_desktop_raw.wav or debug_mic_raw.wav not found.
        echo Run: build\Release\test_resample.exe ^<desktop.wav^> ^<mic.wav^> ^<desktop_output.wav^> ^<mic_output.wav^>
    )
) else (
    echo Build failed!
    exit /b 1
)


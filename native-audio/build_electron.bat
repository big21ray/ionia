@echo off
setlocal enabledelayedexpansion

echo ========================================
echo Building WASAPI Native Module for Electron
echo ========================================
echo.

REM Change to script directory
cd /d "%~dp0"

REM Prefer known-good Python if available
if exist "C:\KarmineDev\anaconda3\python.exe" (
  set "PYTHON=C:\KarmineDev\anaconda3\python.exe"
  echo Python found: %PYTHON%
) else (
  echo WARNING: Python not found at C:\KarmineDev\anaconda3\python.exe
  echo node-gyp will use whatever Python it can find.
)

REM Visual Studio hints
set "GYP_MSVS_VERSION=2022"
set "GYP_MSVS_OVERRIDE_PATH=C:\Program Files\Microsoft Visual Studio\18\Community"

REM Electron version used by this repo
set "ELECTRON_VERSION=28.3.3"

REM Pick node-gyp from repo root when available
set "NODE_GYP=..\node_modules\.bin\node-gyp.cmd"

echo Target: Electron %ELECTRON_VERSION%

if exist "%NODE_GYP%" (
  call "%NODE_GYP%" rebuild --target=%ELECTRON_VERSION% --arch=x64 --disturl=https://electronjs.org/headers --msvs_version=2022
) else (
  echo WARNING: %NODE_GYP% not found; falling back to npx
  call npx node-gyp rebuild --target=%ELECTRON_VERSION% --arch=x64 --disturl=https://electronjs.org/headers --msvs_version=2022
)

if errorlevel 1 (
  echo.
  echo ERROR: Electron build failed.
  exit /b 1
)

REM Copy FFmpeg DLLs (best-effort)
set "FFMPEG_BIN=C:\vcpkg\installed\x64-windows\bin"
set "OUTDIR=build\Release"

if not exist "%OUTDIR%" (
  echo ERROR: build output folder not found: %OUTDIR%
  exit /b 1
)

if exist "%FFMPEG_BIN%\avcodec.dll" (
  echo Copying FFmpeg DLLs from: %FFMPEG_BIN%
  copy /Y "%FFMPEG_BIN%\avcodec.dll" "%OUTDIR%\" >nul 2>&1
  copy /Y "%FFMPEG_BIN%\avformat.dll" "%OUTDIR%\" >nul 2>&1
  copy /Y "%FFMPEG_BIN%\avutil.dll" "%OUTDIR%\" >nul 2>&1
  copy /Y "%FFMPEG_BIN%\swresample.dll" "%OUTDIR%\" >nul 2>&1
  copy /Y "%FFMPEG_BIN%\swscale.dll" "%OUTDIR%\" >nul 2>&1
) else (
  echo WARNING: FFmpeg DLLs not found at %FFMPEG_BIN% (skipping copy)
)

echo.
echo ✅ Electron native module built.
echo Output: %OUTDIR%\*.node
echo.

exit /b 0

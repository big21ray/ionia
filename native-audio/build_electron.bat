@echo off
setlocal enabledelayedexpansion

echo ========================================
echo Building WASAPI Native Module for Electron
echo ========================================
echo.

REM Change to script directory
cd /d "%~dp0"

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

if exist "%FFMPEG_BIN%" (
  echo Copying FFmpeg DLLs from: %FFMPEG_BIN%
  REM Copy both unversioned and versioned FFmpeg DLLs.
  REM Note: `if exist` does NOT reliably match wildcards with full paths, so we
  REM iterate resolved filenames via `for`.
  for %%P in (avcodec avformat avutil swresample swscale avfilter avdevice libx264) do (
    for %%G in ("%FFMPEG_BIN%\%%P*.dll") do (
      if exist "%%~fG" copy /Y "%%~fG" "%OUTDIR%\" >nul 2>&1
    )
  )
) else (
  echo WARNING: FFmpeg bin folder not found at %FFMPEG_BIN% (skipping copy)
)

echo.
echo ✅ Electron native module built.
echo Output: %OUTDIR%\*.node
echo.

exit /b 0

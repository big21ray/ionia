@echo off
setlocal EnableExtensions

REM run_streamer_debug.cmd
REM Single entrypoint for streamer_debug + audio_artifact debugging.
REM Usage:
REM   run_streamer_debug.cmd <youtubeStreamKey>
REM   run_streamer_debug.cmd <rtmpUrl>
REM   run_streamer_debug.cmd              (requires RTMP_URL or YOUTUBE_STREAM_KEY env var)
REM Optional:
REM   set REBUILD_NATIVE=1   to run native-audio\build_all.bat before the test

set "ROOT=%~dp0"
set "NATIVE=%ROOT%native-audio"

if not exist "%NATIVE%\package.json" (
  echo [run_streamer_debug] ERROR: cannot find native-audio\package.json
  exit /b 1
)

REM Resolve RTMP input (arg > RTMP_URL env > YOUTUBE_STREAM_KEY env)
set "INPUT=%~1"

if not "%INPUT%"=="" (
  if /i "%INPUT:~0,7%"=="rtmp://" (
    set "RTMP_URL=%INPUT%"
  ) else (
    set "YOUTUBE_STREAM_KEY=%INPUT%"
  )
)

REM Timestamped log file in repo root (easy to find)
for /f "tokens=1-4 delims=/ " %%a in ("%date%") do set "DATESTAMP=%%d-%%b-%%c"
for /f "tokens=1-3 delims=:., " %%a in ("%time%") do set "TIMESTAMP=%%a%%b%%c"
set "LOGFILE=%ROOT%streamer_debug_%DATESTAMP%_%TIMESTAMP%.txt"

pushd "%NATIVE%" >nul

if "%REBUILD_NATIVE%"=="1" (
  echo [run_streamer_debug] Rebuilding native addon...
  call "%NATIVE%\build_all.bat" || (popd >nul & exit /b 1)
)

echo [run_streamer_debug] Logging to: %LOGFILE%

REM Use PowerShell Tee-Object to capture full output.
powershell -NoProfile -ExecutionPolicy Bypass -Command "node .\test_stream_youtube_end_to_end.js 2>&1 | Tee-Object -FilePath '%LOGFILE%'" 
set "EC=%ERRORLEVEL%"

popd >nul

exit /b %EC%

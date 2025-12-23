@echo off
call "C:\Program Files\Microsoft Visual Studio\18\Community\VC\Auxiliary\Build\vcvarsall.bat" x64
set PYTHON=C:\KarmineDev\anaconda3\python.exe
set GYP_MSVS_VERSION=2022
set GYP_MSVS_OVERRIDE_PATH=C:\Program Files\Microsoft Visual Studio\18\Community
cd /d "%~dp0"
call "%~dp0\..\node_modules\.bin\node-gyp.cmd" rebuild --msvs_version=2022


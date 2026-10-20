@echo off
rem Compile le capteur (Visual Studio Build Tools + FFmpeg shared). Usage : build.cmd dossier_ffmpeg
call "C:\Program Files (x86)\Microsoft Visual Studio\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" >nul
if errorlevel 1 exit /b 1
cmake -S "%~dp0." -B "%~dp0build" -G Ninja -DCMAKE_BUILD_TYPE=Release -DFFMPEG_DIR="%~1"
if errorlevel 1 exit /b 1
cmake --build "%~dp0build"

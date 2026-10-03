@echo off
cd /d "%~dp0"
if exist "dist\win-unpacked\ScreenExtended Host.exe" (
  start "" "dist\win-unpacked\ScreenExtended Host.exe"
  exit /b 0
)
echo Built exe not found. Starting via npm instead...
call "Start Host.bat"

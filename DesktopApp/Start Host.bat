@echo off
setlocal
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
  echo Node.js is required. Install from https://nodejs.org then run this again.
  pause
  exit /b 1
)

if not exist "node_modules\electron\cli.js" (
  echo Installing DesktopApp dependencies...
  call npm install
  if errorlevel 1 (
    echo npm install failed.
    pause
    exit /b 1
  )
)

echo Starting ScreenExtended Host desktop app...
call npm start
if errorlevel 1 (
  echo.
  echo Host exited with an error.
  pause
)

@echo off
net session >nul 2>&1
if %errorlevel% NEQ 0 (
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

mkdir "C:\VirtualDisplayDriver" >nul 2>&1
copy /Y "C:\MohamedAboaliFiles\Work\Part-Time\ScreenExtended\DesktopApp\vendor\vdd\driver\VirtualDisplayDriver\vdd_settings.xml" "C:\VirtualDisplayDriver\vdd_settings.xml" >nul

cd /d "C:\MohamedAboaliFiles\Work\Part-Time\ScreenExtended\DesktopApp\vendor\vdd\driver\VirtualDisplayDriver"
echo Installing Virtual Display Driver (MttVDD)...
pnputil /add-driver "C:\MohamedAboaliFiles\Work\Part-Time\ScreenExtended\DesktopApp\vendor\vdd\driver\VirtualDisplayDriver\MttVDD.inf" /install
if exist "C:\MohamedAboaliFiles\Work\Part-Time\ScreenExtended\DesktopApp\vendor\vdd\control\Dependencies\devcon.exe" (
  echo Creating Root\MttVDD device...
  "C:\MohamedAboaliFiles\Work\Part-Time\ScreenExtended\DesktopApp\vendor\vdd\control\Dependencies\devcon.exe" install "C:\MohamedAboaliFiles\Work\Part-Time\ScreenExtended\DesktopApp\vendor\vdd\driver\VirtualDisplayDriver\MttVDD.inf" Root\MttVDD
)

echo.
echo Done. Close this window and click Add remote screen in ScreenExtended.
timeout /t 4 >nul

@echo off
:: Elevate and open TCP 4789 + allow ScreenExtended Host.exe (needed for other laptops)
net session >nul 2>&1
if %errorlevel% NEQ 0 (
  echo Requesting Administrator permission for Windows Firewall...
  powershell -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  exit /b
)

set EXE=%~dp0..\dist\win-unpacked\ScreenExtended Host.exe

netsh advfirewall firewall delete rule name="ScreenExtended" >nul 2>&1
netsh advfirewall firewall delete rule name="ScreenExtended App" >nul 2>&1
netsh advfirewall firewall delete rule name="ScreenExtended UDP" >nul 2>&1

netsh advfirewall firewall add rule name="ScreenExtended" dir=in action=allow protocol=TCP localport=4789 profile=private,domain
if exist "%EXE%" (
  netsh advfirewall firewall add rule name="ScreenExtended App" dir=in action=allow program="%EXE%" enable=yes profile=private,domain
)

echo.
echo Firewall rules added for ScreenExtended.
echo Other laptops on the same Wi-Fi can now open:
echo   http://YOUR-PC-IP:4789/viewer/
echo.
pause

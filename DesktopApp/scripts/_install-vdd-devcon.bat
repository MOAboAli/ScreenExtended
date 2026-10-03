@echo off
cd /d "C:\MohamedAboaliFiles\Work\Part-Time\ScreenExtended\DesktopApp\vendor\vdd\driver\VirtualDisplayDriver"
echo Installing with pnputil...
pnputil /add-driver MttVDD.inf /install
echo Creating device with devcon...
"C:\MohamedAboaliFiles\Work\Part-Time\ScreenExtended\DesktopApp\vendor\vdd\control\Dependencies\devcon.exe" install MttVDD.inf Root\MttVDD
echo EXIT:%ERRORLEVEL%
timeout /t 3 >nul

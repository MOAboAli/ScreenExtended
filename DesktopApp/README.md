# ScreenExtended Desktop Host

Windows **desktop application** that creates a **new virtual secondary screen** (like SpaceDesk) and streams that screen to another laptop/Mac.

## Important

This does **not** mirror an existing monitor. Flow:

1. **Add remote screen** → installs/uses virtual display driver → Windows gets a new Extend monitor
2. Other laptop opens `http://<pc-ip>:4789/viewer/`
3. **Start streaming** (or auto-start) → only the new virtual screen is sent

## Run

- `Open ScreenExtended Host.bat`
- or `dist\win-unpacked\ScreenExtended Host.exe`
- or `Start Host.bat` / `npm start`

## First-time driver

Click **Add remote screen** (or **Install virtual display driver**) and approve the Administrator prompt.  
Bundled driver: MikeTheTech Virtual Display Driver (MttVDD).

## Firewall

If the other laptop cannot connect: run `scripts\Fix-Firewall.bat` as Administrator.

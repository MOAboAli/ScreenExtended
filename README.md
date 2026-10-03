# ScreenExtended

**SpaceDesk-style extended display for Windows** — turn another laptop, Mac, or tablet into a real secondary Windows screen over your local network, with duplicated system audio and remote mouse/keyboard.

This is not a simple screen mirror. The Windows host can create a **new virtual monitor**, extend the desktop onto it, and stream **only that screen** to the viewer browser.

---

## Features

- **Virtual secondary screen** — creates a new Windows Extend monitor via the bundled MikeTheTech Virtual Display Driver (MttVDD)
- **One screen per client** — virtual display is created when a viewer connects, removed on disconnect, and recreated fresh on reconnect (max one viewer at a time)
- **WebRTC streaming** — low-latency video of the remote virtual screen
- **Duplicated audio** — WASAPI loopback so Windows speakers keep playing while the viewer hears a copy
- **Remote input** — mouse and keyboard from the viewer control the virtual screen
- **Desktop host app** — Electron app with LAN URL, driver install helper, and optional auto-start
- **Browser viewer** — open a URL on the other device (Chrome / Edge / Safari); no app install required on the viewer

---

## Project layout

```
ScreenExtended/
├── DesktopApp/          ← Primary product (use this)
│   ├── main.js          Electron host + HTTP/WebSocket signaling
│   ├── virtualDisplay.js  MttVDD named-pipe control (create/remove screens)
│   ├── input.js         Win32 remote mouse/keyboard
│   ├── ui/              Host control UI
│   ├── viewer/          Browser viewer page
│   ├── vendor/vdd/      Bundled virtual display driver files
│   ├── scripts/         Firewall helper, install helpers, tests
│   ├── Start Host.bat
│   └── Open ScreenExtended Host.bat
├── host/                Legacy Electron host (earlier prototype)
├── viewer/              Legacy viewer page
└── scripts/             Legacy smoke / e2e helpers
```

> **Recommended path:** develop and run from `DesktopApp/`. The root `host/` + `viewer/` folders are an older mirror-style prototype kept for reference.

---

## Requirements

| Role | Requirements |
|------|----------------|
| **Host** | Windows 10/11, Node.js 18+, Administrator once for driver + firewall |
| **Viewer** | Any modern browser on the same LAN (Mac, Windows laptop, tablet, etc.) |
| **Network** | Same Wi‑Fi / LAN; TCP port **4789** open between devices |

---

## Quick start (DesktopApp)

### 1. Install dependencies

```bat
cd DesktopApp
npm install
```

### 2. Start the host

```bat
npm start
```

Or double-click:

- `DesktopApp\Start Host.bat`
- `DesktopApp\Open ScreenExtended Host.bat`

### 3. Install the virtual display driver (first time only)

In the host UI, click **Install virtual display driver** (or the equivalent first-run action) and approve the UAC prompt.

This installs the bundled **MttVDD** driver so Windows can expose a new Extend monitor.

### 4. Open the viewer on another device

On the other laptop/Mac (same network), open one of the LAN URLs shown in the host, for example:

```
http://192.168.x.x:4789/viewer/
```

When the viewer connects:

1. Host creates **one** virtual secondary screen
2. Streaming starts for that screen
3. On disconnect, the virtual screen is removed
4. On reconnect, the old screen is cleared and a new one is created

### 5. Firewall (if the viewer cannot connect)

Run as Administrator:

```bat
DesktopApp\scripts\Fix-Firewall.bat
```

Or manually:

```powershell
New-NetFirewallRule -DisplayName "ScreenExtended" -Direction Inbound -Protocol TCP -LocalPort 4789 -Action Allow -Profile Private
```

---

## How it works

```
┌─────────────────────┐         WebRTC + WS          ┌──────────────────┐
│  Windows Host       │  ←── signaling (port 4789) ─→ │  Viewer browser  │
│  Electron app       │  ──── video + audio ────────→ │  /viewer/        │
│                     │  ←── mouse / keyboard ─────── │                  │
│  + Virtual monitor  │                               └──────────────────┘
│    (MttVDD)         │
└─────────────────────┘
```

1. **Signaling** — Express HTTP + WebSocket on port `4789`
2. **Virtual display** — host talks to `\\.\pipe\MTTVirtualDisplayPipe` (`SETDISPLAYCOUNT`) to add/remove the monitor
3. **Capture** — Electron `desktopCapturer` grabs the new display; audio via loopback
4. **Input** — viewer sends normalized coordinates; host injects Win32 input into the virtual screen bounds

### Session lifecycle (one client max)

| Event | Behavior |
|-------|----------|
| Viewer connects | Remove any previous virtual screen → create exactly **one** |
| Viewer disconnects | Remove the virtual screen |
| Same client reconnects | Remove → create a fresh screen |
| Second viewer tries to join | Rejected while the first is still connected |

---

## Build a portable Windows app

From `DesktopApp/`:

```bat
npm run dist
```

Output:

```
DesktopApp\dist\win-unpacked\ScreenExtended Host.exe
```

Driver files are unpacked beside the asar (`asarUnpack`) so install scripts can write them under `C:\VirtualDisplayDriver\`.

---

## Configuration

| Variable / setting | Default | Meaning |
|--------------------|---------|---------|
| `SCREENEXTENDED_PORT` | `4789` | HTTP + WebSocket listen port |
| `SCREENEXTENDED_ALLOW_MULTI` | unset | Set to `1` to allow multiple Electron instances (tests) |
| Host UI **Open at login** | off | Optional Windows startup entry |

Settings file (when running the packaged/dev Electron app):

```
%APPDATA%\ScreenExtended Host\settings.json
```

---

## Scripts (DesktopApp)

| Command / script | Purpose |
|------------------|---------|
| `npm start` | Run Electron host |
| `npm test` | Full UI / API smoke test |
| `npm run dist` | Build unpacked Windows app |
| `scripts\Fix-Firewall.bat` | Allow TCP 4789 (Admin) |
| `scripts\Install-VirtualDisplayDriver.bat` | Install MttVDD (Admin) |
| `scripts\test-lifecycle.js` | Connect / disconnect / reconnect screen lifecycle |

---

## Legacy root app

The repository root still contains an earlier Electron host (`host/`) and viewer (`viewer/`) that stream a **selected existing display** rather than auto-managing a virtual screen.

```bat
cd ScreenExtended
npm install
npm start
```

Prefer **`DesktopApp/`** for the SpaceDesk-like virtual-screen workflow.

---

## Troubleshooting

| Problem | What to try |
|---------|-------------|
| Viewer page never loads | Same Wi‑Fi? Correct PC IP? Run `Fix-Firewall.bat` as Admin |
| “Virtual Display Driver is not running” | Install driver once via host UI; reboot if the named pipe never appears |
| Black / empty remote screen | Confirm Windows Display settings show an extended virtual monitor; reconnect the viewer |
| PC feels slow / many ghost monitors | Disconnect viewers; set virtual count to 0; in Device Manager remove extra **Virtual Display Driver** devices if leftovers remain |
| Host won’t start after reboot | Auto-start is off by default; launch via `Start Host.bat` or enable Open at login in the UI |
| Second laptop rejected | Only one viewer is allowed — disconnect the first client first |

### Emergency cleanup of leftover virtual screens

If testing left extra virtual monitors behind:

1. Stop ScreenExtended / Electron
2. Run (Admin): `C:\VirtualDisplayDriver\ScreenExtended\Remove-All-VirtualScreens.bat` if present  
   or disable/remove **Virtual Display Driver** devices in Device Manager
3. Confirm Windows Display settings show only your real monitors

---

## Tech stack

- **Electron** — host desktop shell + display capture
- **Express + ws** — viewer static files + signaling
- **WebRTC** — media transport
- **koffi** — Win32 input injection
- **MttVDD** — virtual display driver (named pipe control)
- **electron-builder** — Windows packaging

---

## License

MIT

---

## Credits

- Virtual display support via [MikeTheTech / Virtual Display Driver (MttVDD)](https://github.com/VirtualDrivers/Virtual-Display-Driver) style tooling bundled under `DesktopApp/vendor/vdd/`
- Inspired by products like SpaceDesk for wireless extended desktops

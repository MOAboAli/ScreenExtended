'use strict';

/**
 * Virtual secondary display via MikeTheTech Virtual Display Driver (MttVDD).
 * Creates a NEW Windows monitor (Extend desktop), which we then stream.
 */

const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const PIPE_PATH = '\\\\.\\pipe\\MTTVirtualDisplayPipe';
const SETTINGS_DIR = 'C:\\VirtualDisplayDriver';
const SETTINGS_FILE = path.join(SETTINGS_DIR, 'vdd_settings.xml');
const WORK_DIR = path.join(SETTINGS_DIR, 'ScreenExtended');

function packageRoot() {
  if (__dirname.includes(path.sep + 'app.asar' + path.sep) || __dirname.endsWith(path.sep + 'app.asar')) {
    return __dirname.replace(path.sep + 'app.asar', path.sep + 'app.asar.unpacked');
  }
  return __dirname;
}

function resolveExisting(...parts) {
  const candidates = [];
  const root = packageRoot();
  candidates.push(path.join(root, ...parts));
  candidates.push(path.join(__dirname, ...parts));
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'app.asar.unpacked', ...parts));
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return candidates[0];
}

function driverInfPath() {
  return resolveExisting('vendor', 'vdd', 'driver', 'VirtualDisplayDriver', 'MttVDD.inf');
}

function bundledSettingsPath() {
  return resolveExisting('vendor', 'vdd', 'driver', 'VirtualDisplayDriver', 'vdd_settings.xml');
}

function devconPath() {
  return resolveExisting('vendor', 'vdd', 'control', 'Dependencies', 'devcon.exe');
}

function pipeExists() {
  return new Promise((resolve) => {
    const socket = net.connect(PIPE_PATH);
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      try { socket.destroy(); } catch { /* */ }
      resolve(ok);
    };
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
    setTimeout(() => finish(false), 800);
  });
}

function sendPipeCommand(command, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(PIPE_PATH);
    let buf = Buffer.alloc(0);
    let settled = false;

    const done = (err, text) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* */ }
      if (err) reject(err);
      else resolve(text);
    };

    const timer = setTimeout(() => done(null, buf.toString('utf8')), timeoutMs);

    socket.on('connect', () => {
      socket.write(Buffer.from(String(command), 'utf16le'));
      // Driver is one-shot; don't wait forever if it never closes
      setTimeout(() => done(null, buf.toString('utf8')), Math.min(1200, timeoutMs));
    });
    socket.on('data', (chunk) => { buf = Buffer.concat([buf, chunk]); });
    socket.on('end', () => done(null, buf.toString('utf8')));
    socket.on('close', () => done(null, buf.toString('utf8')));
    socket.on('error', (err) => done(err));
  });
}

async function isDriverReady() {
  return pipeExists();
}

function ensureSettingsFile() {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  const bundled = bundledSettingsPath();
  if (fs.existsSync(bundled)) {
    fs.copyFileSync(bundled, SETTINGS_FILE);
  } else if (!fs.existsSync(SETTINGS_FILE)) {
    fs.writeFileSync(SETTINGS_FILE, "<?xml version='1.0' encoding='utf-8'?>\n<vdd_settings>\n  <monitors><count>1</count></monitors>\n  <gpu><friendlyname>default</friendlyname></gpu>\n  <global><g_refresh_rate>60</g_refresh_rate></global>\n  <resolutions>\n    <resolution><width>1920</width><height>1080</height><refresh_rate>60</refresh_rate></resolution>\n  </resolutions>\n  <options><HardwareCursor>true</HardwareCursor></options>\n</vdd_settings>\n", 'utf8');
  }
}

function setDesiredCountInXml(count) {
  ensureSettingsFile();
  let xml = fs.readFileSync(SETTINGS_FILE, 'utf8');
  if (/<count>\s*\d+\s*<\/count>/.test(xml)) {
    xml = xml.replace(/<count>\s*\d+\s*<\/count>/, '<count>' + count + '</count>');
  }
  fs.writeFileSync(SETTINGS_FILE, xml, 'utf8');
}

function runElevatedBat(scriptPath) {
  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
      "Start-Process -FilePath '" + scriptPath.replace(/'/g, "''") + "' -Verb RunAs -Wait",
    ], { windowsHide: true });
    ps.on('exit', (code) => resolve(code ?? 1));
    ps.on('error', reject);
  });
}

function materializeDriverFiles() {
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const srcDir = path.dirname(driverInfPath());
  const destDir = path.join(WORK_DIR, 'driver');
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of ['MttVDD.inf', 'MttVDD.dll', 'mttvdd.cat', 'vdd_settings.xml']) {
    const from = path.join(srcDir, name);
    const to = path.join(destDir, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, to);
  }
  const devconSrc = devconPath();
  const devconDest = path.join(WORK_DIR, 'devcon.exe');
  if (fs.existsSync(devconSrc)) fs.copyFileSync(devconSrc, devconDest);
  return {
    inf: path.join(destDir, 'MttVDD.inf'),
    settings: path.join(destDir, 'vdd_settings.xml'),
    devcon: fs.existsSync(devconDest) ? devconDest : '',
  };
}

function writeInstallScript() {
  const files = materializeDriverFiles();
  if (!fs.existsSync(files.inf)) {
    throw new Error('Virtual display driver files missing in package. Rebuild the app or run npm start from DesktopApp.');
  }
  fs.mkdirSync(WORK_DIR, { recursive: true });
  const script = path.join(WORK_DIR, 'Install-VirtualDisplayDriver.bat');
  const content = [
    '@echo off',
    'net session >nul 2>&1',
    'if %errorlevel% NEQ 0 (',
    "  powershell -Command \"Start-Process -FilePath '%~f0' -Verb RunAs\"",
    '  exit /b',
    ')',
    'mkdir "C:\\VirtualDisplayDriver" >nul 2>&1',
    'copy /Y "' + files.settings + '" "C:\\VirtualDisplayDriver\\vdd_settings.xml" >nul',
    'cd /d "' + path.dirname(files.inf) + '"',
    'echo Installing Virtual Display Driver (MttVDD)...',
    'pnputil /add-driver "' + files.inf + '" /install',
    'if exist "' + files.devcon + '" (',
    '  echo Creating Root\\MttVDD device...',
    '  "' + files.devcon + '" install "' + files.inf + '" Root\\MttVDD',
    ')',
    'echo.',
    'echo Done. Close this window and click Add remote screen in ScreenExtended.',
    'timeout /t 4 >nul',
    '',
  ].join('\r\n');
  fs.writeFileSync(script, content, 'utf8');
  return script;
}

async function installDriverElevated() {
  ensureSettingsFile();
  const script = writeInstallScript();
  await runElevatedBat(script);
  for (let i = 0; i < 30; i++) {
    if (await isDriverReady()) return true;
    await new Promise((r) => setTimeout(r, 500));
  }
  return isDriverReady();
}

async function waitForPipe(tries = 40) {
  for (let i = 0; i < tries; i++) {
    if (await isDriverReady()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return isDriverReady();
}

async function setDisplayCount(count) {
  setDesiredCountInXml(count);
  if (!(await isDriverReady())) {
    // Pipe may be temporarily down after a prior reload
    const back = await waitForPipe(20);
    if (!back) {
      throw new Error(
        'Virtual Display Driver is not running. Click “Install virtual display driver” once (Administrator), then reconnect the viewer.',
      );
    }
  }
  const response = await sendPipeCommand(`SETDISPLAYCOUNT ${count}`);
  // Driver reloads after SETDISPLAYCOUNT and the named pipe drops briefly
  await waitForPipe(40);
  return response;
}

async function pingDriver() {
  if (!(await isDriverReady())) return false;
  try {
    await sendPipeCommand('PING');
    return true;
  } catch {
    return false;
  }
}

module.exports = {
  PIPE_PATH,
  isDriverReady,
  installDriverElevated,
  setDisplayCount,
  pingDriver,
  ensureSettingsFile,
  packageRoot,
};

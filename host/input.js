'use strict';

/**
 * Win32 input injection for remote mouse/keyboard from the Mac viewer.
 * Uses SendInput so focus stays with whatever Windows app is under the cursor.
 */

const koffi = require('koffi');

const user32 = koffi.load('user32.dll');
const kernel32 = koffi.load('kernel32.dll');

const INPUT_MOUSE = 0;
const INPUT_KEYBOARD = 1;

const MOUSEEVENTF_MOVE = 0x0001;
const MOUSEEVENTF_LEFTDOWN = 0x0002;
const MOUSEEVENTF_LEFTUP = 0x0004;
const MOUSEEVENTF_RIGHTDOWN = 0x0008;
const MOUSEEVENTF_RIGHTUP = 0x0010;
const MOUSEEVENTF_MIDDLEDOWN = 0x0020;
const MOUSEEVENTF_MIDDLEUP = 0x0040;
const MOUSEEVENTF_WHEEL = 0x0800;
const MOUSEEVENTF_ABSOLUTE = 0x8000;
const MOUSEEVENTF_VIRTUALDESK = 0x4000;

const KEYEVENTF_KEYUP = 0x0002;
const KEYEVENTF_EXTENDEDKEY = 0x0001;
const MAPVK_VK_TO_VSC = 0;

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'int32',
  dy: 'int32',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr',
});

const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr',
});

const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
  uMsg: 'uint32',
  wParamL: 'uint16',
  wParamH: 'uint16',
});

const INPUT = koffi.struct('INPUT', {
  type: 'uint32',
  u: koffi.union('INPUT_UNION', {
    mi: MOUSEINPUT,
    ki: KEYBDINPUT,
    hi: HARDWAREINPUT,
  }),
});

const SendInput = user32.func('uint SendInput(uint nInputs, INPUT *pInputs, int cbSize)');
const MapVirtualKeyW = user32.func('uint MapVirtualKeyW(uint uCode, uint uMapType)');
const GetSystemMetrics = user32.func('int GetSystemMetrics(int nIndex)');

const SM_XVIRTUALSCREEN = 76;
const SM_YVIRTUALSCREEN = 77;
const SM_CXVIRTUALSCREEN = 78;
const SM_CYVIRTUALSCREEN = 79;

const KEY_MAP = {
  Backspace: 0x08,
  Tab: 0x09,
  Enter: 0x0d,
  Shift: 0x10,
  Control: 0x11,
  Alt: 0x12,
  Pause: 0x13,
  CapsLock: 0x14,
  Escape: 0x1b,
  ' ': 0x20,
  Space: 0x20,
  PageUp: 0x21,
  PageDown: 0x22,
  End: 0x23,
  Home: 0x24,
  ArrowLeft: 0x25,
  ArrowUp: 0x26,
  ArrowRight: 0x27,
  ArrowDown: 0x28,
  Insert: 0x2d,
  Delete: 0x2e,
  Meta: 0x5b,
  ContextMenu: 0x5d,
  F1: 0x70,
  F2: 0x71,
  F3: 0x72,
  F4: 0x73,
  F5: 0x74,
  F6: 0x75,
  F7: 0x76,
  F8: 0x77,
  F9: 0x78,
  F10: 0x79,
  F11: 0x7a,
  F12: 0x7b,
};

const EXTENDED = new Set([
  'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown',
  'Home', 'End', 'PageUp', 'PageDown', 'Insert', 'Delete',
  'Meta', 'ContextMenu',
]);

function virtualDesk() {
  return {
    x: GetSystemMetrics(SM_XVIRTUALSCREEN),
    y: GetSystemMetrics(SM_YVIRTUALSCREEN),
    w: GetSystemMetrics(SM_CXVIRTUALSCREEN),
    h: GetSystemMetrics(SM_CYVIRTUALSCREEN),
  };
}

function toAbsolute(x, y) {
  const desk = virtualDesk();
  const absX = Math.round(((x - desk.x) * 65535) / Math.max(desk.w - 1, 1));
  const absY = Math.round(((y - desk.y) * 65535) / Math.max(desk.h - 1, 1));
  return { absX, absY };
}

function sendMouse(flags, x, y, data = 0) {
  const { absX, absY } = toAbsolute(x, y);
  const input = {
    type: INPUT_MOUSE,
    u: {
      mi: {
        dx: absX,
        dy: absY,
        mouseData: data >>> 0,
        dwFlags: flags | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK | MOUSEEVENTF_MOVE,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  };
  SendInput(1, [input], koffi.sizeof(INPUT));
}

function sendWheel(deltaY, x, y) {
  // Windows expects multiples of 120
  const notches = Math.max(-20, Math.min(20, Math.round(-deltaY / 40))) * 120;
  if (!notches) return;
  sendMouse(MOUSEEVENTF_WHEEL, x, y, notches);
}

function resolveVk(key, code) {
  if (KEY_MAP[key] != null) return KEY_MAP[key];
  if (key && key.length === 1) {
    const ch = key.toUpperCase();
    if (ch >= 'A' && ch <= 'Z') return ch.charCodeAt(0);
    if (ch >= '0' && ch <= '9') return ch.charCodeAt(0);
  }
  if (code && /^Digit\d$/.test(code)) return 0x30 + Number(code.slice(5));
  if (code && /^Key[A-Z]$/.test(code)) return code.charCodeAt(3);
  return 0;
}

function sendKey(key, code, down) {
  const vk = resolveVk(key, code);
  if (!vk) return;
  const scan = MapVirtualKeyW(vk, MAPVK_VK_TO_VSC);
  let flags = down ? 0 : KEYEVENTF_KEYUP;
  if (EXTENDED.has(key)) flags |= KEYEVENTF_EXTENDEDKEY;
  const input = {
    type: INPUT_KEYBOARD,
    u: {
      ki: {
        wVk: vk,
        wScan: scan,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: 0,
      },
    },
  };
  SendInput(1, [input], koffi.sizeof(INPUT));
}

function handleRemoteInput(msg, screenBounds) {
  if (!msg || !screenBounds) return;

  const mapX = (nx) => screenBounds.x + nx * screenBounds.width;
  const mapY = (ny) => screenBounds.y + ny * screenBounds.height;

  switch (msg.type) {
    case 'mousemove': {
      sendMouse(0, mapX(msg.nx), mapY(msg.ny));
      break;
    }
    case 'mousedown': {
      const x = mapX(msg.nx);
      const y = mapY(msg.ny);
      const flag =
        msg.button === 2 ? MOUSEEVENTF_RIGHTDOWN :
        msg.button === 1 ? MOUSEEVENTF_MIDDLEDOWN :
        MOUSEEVENTF_LEFTDOWN;
      sendMouse(flag, x, y);
      break;
    }
    case 'mouseup': {
      const x = mapX(msg.nx);
      const y = mapY(msg.ny);
      const flag =
        msg.button === 2 ? MOUSEEVENTF_RIGHTUP :
        msg.button === 1 ? MOUSEEVENTF_MIDDLEUP :
        MOUSEEVENTF_LEFTUP;
      sendMouse(flag, x, y);
      break;
    }
    case 'wheel': {
      sendWheel(msg.deltaY || 0, mapX(msg.nx), mapY(msg.ny));
      break;
    }
    case 'keydown': {
      sendKey(msg.key, msg.code, true);
      break;
    }
    case 'keyup': {
      sendKey(msg.key, msg.code, false);
      break;
    }
    default:
      break;
  }
}

module.exports = {
  handleRemoteInput,
  virtualDesk,
};

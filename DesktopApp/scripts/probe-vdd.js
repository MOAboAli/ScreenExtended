'use strict';

const vd = require('../virtualDisplay');
const { execFileSync } = require('child_process');

function listScreens() {
  const ps = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {
  $_.DeviceName + ' ' + $_.Bounds.Width + 'x' + $_.Bounds.Height + '+' + $_.Bounds.X + ',' + $_.Bounds.Y + ' Primary=' + $_.Primary
}
`;
  return execFileSync('powershell.exe', ['-NoProfile', '-Command', ps], { encoding: 'utf8' });
}

(async () => {
  for (const n of [0, 1, 2]) {
    console.log('--- SETDISPLAYCOUNT', n);
    try {
      const r = await vd.setDisplayCount(n);
      console.log('response', JSON.stringify(r));
    } catch (e) {
      console.error('error', e.message);
    }
    await new Promise((r) => setTimeout(r, 3000));
    console.log(listScreens());
  }
})();

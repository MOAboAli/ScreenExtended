'use strict';

const { app, screen } = require('electron');
const virtualDisplay = require('../virtualDisplay');
const fs = require('fs');

app.whenReady().then(async () => {
  try {
    virtualDisplay.ensureSettingsFile();
    console.log('settings', fs.readFileSync('C:\\VirtualDisplayDriver\\vdd_settings.xml', 'utf8').slice(0, 400));
    for (const n of [0, 1, 2, 3]) {
      console.log('--- count', n);
      await virtualDisplay.setDisplayCount(n);
      await new Promise((r) => setTimeout(r, 2500));
      console.log(
        screen.getAllDisplays().map((d) => `${d.id}:${d.bounds.width}x${d.bounds.height}@${d.bounds.x},${d.bounds.y}${d.id === screen.getPrimaryDisplay().id ? '*' : ''}`).join(' | '),
      );
    }
  } catch (e) {
    console.error(e);
  } finally {
    app.quit();
  }
});

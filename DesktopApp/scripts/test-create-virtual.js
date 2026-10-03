'use strict';

const { app, screen } = require('electron');
const virtualDisplay = require('../virtualDisplay');

app.whenReady().then(async () => {
  try {
    virtualDisplay.ensureSettingsFile();
    const before = screen.getAllDisplays().map((d) => `${d.id}:${d.bounds.width}x${d.bounds.height}`);
    console.log('BEFORE', before.join(' | '));
    await virtualDisplay.setDisplayCount(0);
    await new Promise((r) => setTimeout(r, 1500));
    await virtualDisplay.setDisplayCount(1);
    await new Promise((r) => setTimeout(r, 2000));
    const after = screen.getAllDisplays().map((d) => ({
      id: d.id,
      size: `${d.bounds.width}x${d.bounds.height}`,
      pos: `${d.bounds.x},${d.bounds.y}`,
      primary: d.id === screen.getPrimaryDisplay().id,
    }));
    console.log('AFTER', JSON.stringify(after, null, 2));
    const virt = after.find((d) => !d.primary && (d.size === '1920x1080' || d.size === '800x600' || d.size === '1024x768'));
    console.log('VIRTUAL_CANDIDATE', virt);
    console.log(virt ? 'CREATE_OK' : 'CREATE_FAIL');
  } catch (e) {
    console.error('FAIL', e);
  } finally {
    app.quit();
  }
});

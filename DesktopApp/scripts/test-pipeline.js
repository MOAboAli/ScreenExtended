'use strict';

const { app, screen, desktopCapturer } = require('electron');
const path = require('path');

// Load create logic similarly to main by duplicating the selection heuristic
const virtualDisplay = require('../virtualDisplay');

app.whenReady().then(async () => {
  try {
    virtualDisplay.ensureSettingsFile();
    await virtualDisplay.setDisplayCount(0);
    await new Promise((r) => setTimeout(r, 1500));
    const baselineIds = new Set(screen.getAllDisplays().map((d) => String(d.id)));
    console.log('baseline', screen.getAllDisplays().map((d) => `${d.id}:${d.bounds.width}x${d.bounds.height}@${d.bounds.x}`).join(' | '));
    await virtualDisplay.setDisplayCount(1);
    await new Promise((r) => setTimeout(r, 2000));
    const after = screen.getAllDisplays();
    console.log('after', after.map((d) => `${d.id}:${d.bounds.width}x${d.bounds.height}@${d.bounds.x}`).join(' | '));
    const primaryId = screen.getPrimaryDisplay().id;
    const added = after.filter((d) => !baselineIds.has(String(d.id)) && d.id !== primaryId);
    let display = added[0] || after.filter((d) => d.id !== primaryId).sort((a, b) => b.bounds.x - a.bounds.x)[0];
    console.log('chosen', display && `${display.id}:${display.bounds.width}x${display.bounds.height}@${display.bounds.x}`);
    const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 120, height: 70 } });
    const match = sources.find((s) => String(s.display_id) === String(display.id)) || sources[sources.length - 1];
    console.log('sources', sources.map((s) => `${s.name}/${s.display_id}`).join(' | '));
    console.log('match', match && `${match.name}/${match.display_id}/${match.id}`);
    if (display && match && display.bounds.x >= 3000) console.log('PIPELINE_OK_VIRTUAL_RIGHT');
    else if (display && match) console.log('PIPELINE_OK_FALLBACK', display.bounds.x);
    else console.log('PIPELINE_FAIL');
    await virtualDisplay.setDisplayCount(0);
  } catch (e) {
    console.error(e);
  } finally {
    app.quit();
  }
});

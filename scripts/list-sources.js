'use strict';

const { app, desktopCapturer, screen } = require('electron');

app.whenReady().then(async () => {
  console.log('displays', screen.getAllDisplays().map((d) => d.bounds));
  try {
    const sources = await desktopCapturer.getSources({
      types: ['screen'],
      thumbnailSize: { width: 100, height: 60 },
    });
    console.log('sources_count', sources.length);
    for (const s of sources) {
      console.log('-', s.id, s.name, 'display_id=', s.display_id, 'thumbEmpty=', s.thumbnail.isEmpty());
    }
  } catch (e) {
    console.error('getSources error', e);
  }
  app.quit();
});

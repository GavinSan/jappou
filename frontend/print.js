/* Renders one instrument's score for PDF export.
   Used by the backend (headless browser -> page.pdf) and openable by hand:
   print.html?id=<job>&chip=drums&lyrics=line&bars=4&stave=auto */
'use strict';
(async function () {
  const q = new URLSearchParams(location.search);
  const id = q.get('id');
  const chip = q.get('chip') || 'drums';
  const lyricsMode = q.get('lyrics') || 'line';
  const bars = Number(q.get('bars') || 4);
  const stave = q.get('stave') || 'auto';
  const getJson = p => fetch(p, { cache: 'no-store' }).then(r => { if (!r.ok) throw new Error(p + ' ' + r.status); return r.json(); });
  try {
    const [meta, timing, lyrics] = await Promise.all([
      getJson(`/api/jobs/${id}`),
      getJson(`/api/jobs/${id}/file/timing.json`),
      getJson(`/api/jobs/${id}/file/lyrics.json`).catch(() => ({ lines: [] })),
    ]);
    const chordData = q.get('chords') === '0' ? { chords: [] } : await getJson(`/api/jobs/${id}/chords`).catch(() => ({ chords: [] }));
    const label = (JP.CHIPS.find(c => c.key === chip) || {}).label || chip;
    document.title = `${meta.title || '執譜機'} - ${label}`;
    document.getElementById('note').textContent = `${label} · ${Math.round(timing.bpm)} BPM${meta.key ? ' · 調：' + meta.key : ''} · 執譜機自動生成，僅供參考`;
    await window.alphaTabReady;
    const buf = await fetch(`/api/jobs/${id}/file/score.gp5`, { cache: 'no-store' }).then(r => r.arrayBuffer());

    const at = new alphaTab.AlphaTabApi(document.getElementById('sheet'), {
      core: { fontDirectory: window.ALPHATAB_BASE + 'font/', engine: 'svg', enableLazyLoading: false, useWorkers: false, logLevel: 'warning' },
      display: {
        layoutMode: alphaTab.LayoutMode.Page,
        staveProfile: JP.staveProfileFor(chip, stave),
        barsPerRow: bars > 0 ? bars : -1,
        scale: 0.9,
        resources: { secondaryGlyphColor: '#000000' },
      },
      notation: { elements: { effectDynamics: false } },
      importer: { encoding: 'utf-8' },
      player: { playerMode: alphaTab.PlayerMode.Disabled, enableCursor: false },
    });
    if ('gp3To5encoding' in at.settings.importer) at.settings.importer.gp3To5encoding = 'utf-8';
    at.error.on(e => { window.__printError = String((e && e.message) || e); });

    const metaTracks = meta.tracks || [];
    const keys = (JP.CHIPS.find(c => c.key === chip) || {}).tracks || [];
    const indexes = metaTracks.filter(t => keys.includes(t.key)).map(t => t.index);
    if (!indexes.length) throw new Error('no tracks for ' + chip);
    // scoreLoaded fires before the first render, so lyrics/title are in place for it
    at.scoreLoaded.on(score => {
      JP.prepareScore(score, meta);
      const tracks = JP.tracksForChip(score, metaTracks, chip);
      JP.applyLyricsToScore(score, timing, lyrics, tracks[0], lyricsMode);
      JP.applyChordsToScore(score, timing, chordData.chords || [], tracks, { diagrams: chip === 'guitar' });
    });
    const done = new Promise(res => at.postRenderFinished.on(res));
    at.load(new Uint8Array(buf), indexes);
    await done;
    if (document.fonts && document.fonts.ready) await document.fonts.ready;
    await new Promise(r => setTimeout(r, 300));
    window.__printReady = true;
  } catch (err) {
    console.error(err);
    window.__printError = String(err && err.message || err);
  }
})();

/* Score helpers shared by the app (app.js) and the PDF page (print.js). */
'use strict';
(function () {
  // score "chips" -> GP track keys written by backend/score.py
  const CHIPS = [
    { key: 'drums', label: '鼓', tracks: ['drums'] },
    { key: 'vocals', label: '人聲旋律', tracks: ['vocals'] },
    { key: 'guitar', label: '結他 Chord', tracks: ['guitar_rhythm'] },
    { key: 'lead', label: '結他 Solo', tracks: ['guitar_lead'] },
    { key: 'bass', label: 'Bass', tracks: ['bass'] },
    { key: 'piano', label: '琴', tracks: ['piano_rh', 'piano_lh'] },
    { key: 'other', label: '其他', tracks: ['other'] },
  ];

  function chipAvailable(metaTracks, chip) {
    const keys = (metaTracks || []).map(t => t.key);
    const c = typeof chip === 'string' ? CHIPS.find(x => x.key === chip) : chip;
    return !!c && c.tracks.some(t => keys.includes(t));
  }

  function tracksForChip(score, metaTracks, chip) {
    if (!score) return [];
    const c = CHIPS.find(x => x.key === chip) || CHIPS[0];
    return (metaTracks || []).filter(t => c.tracks.includes(t.key)).map(t => score.tracks[t.index]).filter(Boolean);
  }

  function staveProfileFor(chip, stave) {
    const P = alphaTab.StaveProfile;
    if (chip === 'guitar') return P.ScoreTab;   // chord part: slashes (+ optional TAB), see setRhythmStaff
    const fretted = chip === 'lead' || chip === 'bass';
    if (stave === 'score') return P.Score;
    if (stave === 'tab') return fretted ? P.Tab : P.Score;
    return fretted ? P.ScoreTab : P.Score;
  }

  /** time (s) -> position in beats from the start of bar 0 */
  function timeToBeatPos(timing, t) {
    const b = timing.beats;
    if (!b.length) return 0;
    if (t <= b[0].time) return 0;
    let lo = 0, hi = b.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (b[mid].time <= t) lo = mid; else hi = mid - 1; }
    const next = lo + 1 < b.length ? b[lo + 1].time : timing.endTime;
    const frac = next > b[lo].time ? (t - b[lo].time) / (next - b[lo].time) : 0;
    return lo + Math.min(1, Math.max(0, frac));
  }
  function beatPosToTime(timing, p) {
    const b = timing.beats;
    const k = Math.max(0, Math.min(b.length - 1, Math.floor(p)));
    const next = k + 1 < b.length ? b[k + 1].time : timing.endTime;
    return b[k].time + (p - k) * (next - b[k].time);
  }

  /** chord part: rhythm slashes (like a band chart), optionally with the TAB of each shape */
  function setRhythmStaff(score, metaTracks, withTab) {
    const t = (metaTracks || []).find(x => x.key === 'guitar_rhythm');
    const tr = t && score.tracks[t.index];
    if (!tr) return;
    for (const st of tr.staves) {
      st.showSlash = true;
      st.showStandardNotation = false;
      st.showTablature = !!withTab;
    }
  }

  /** basic fixes after loading one of our GP5 files */
  function prepareScore(score, meta) {
    score.title = (meta && meta.title) || score.title;
    score.artist = (meta && meta.artist) || '';
    // GP5 page-setup templates from our writer don't match alphaTab's; use alphaTab's defaults
    try { score.style = undefined; } catch (e) { /* ignore */ }
  }

  /** beat times with obvious detection outliers evened out, so the cursor speed
   *  doesn't lurch on a single misplaced beat (real tempo changes are kept) */
  function steadyBeats(beats) {
    const t = beats.map(b => b.time);
    for (let i = 1; i < t.length - 1; i++) {
      const mid = (t[i - 1] + t[i + 1]) / 2;
      const ibi = (t[i + 1] - t[i - 1]) / 2;
      if (Math.abs(t[i] - mid) > 0.18 * ibi) t[i] = mid;
    }
    return beats.map((b, i) => ({ ...b, time: t[i] }));
  }

  /** equal-width bars: the cursor then moves at a steady speed across the page */
  function evenBars(score, barsPerRow) {
    score.defaultSystemsLayout = barsPerRow;
    score.systemsLayout = [];
    for (const mb of score.masterBars) { mb.displayScale = 1; mb.displayWidth = -1; }
    for (const tr of score.tracks) {
      tr.defaultSystemsLayout = barsPerRow;
      tr.systemsLayout = [];
      for (const st of tr.staves) for (const bar of st.bars) { bar.displayScale = 1; bar.displayWidth = -1; }
    }
  }

  function applySyncPoints(score, timing) {
    if (!timing) return;
    timing = { ...timing, beats: steadyBeats(timing.beats) };
    const M = alphaTab.model;
    for (const mb of score.masterBars) mb.syncPoints = undefined;
    for (const b of timing.beats) {
      const mb = score.masterBars[b.bar];
      if (!mb) continue;
      const a = new M.Automation();
      a.type = M.AutomationType.SyncPoint;
      a.ratioPosition = b.beat / timing.beatsPerBar;
      a.syncPointValue = new M.SyncPointData();
      a.syncPointValue.barOccurence = 0;
      a.syncPointValue.millisecondOffset = b.time * 1000;
      mb.addSyncPoint(a);
    }
  }

  /** put lyrics into the score model: mode 'line' (text above the staff),
   *  'word' (lyrics under the notes) or 'off'. */
  function applyLyricsToScore(score, timing, lyrics, track, mode) {
    if (!score || !timing) return;
    const N = timing.beatsPerBar;
    for (const tr of score.tracks) for (const st of tr.staves) for (const bar of st.bars) for (const v of bar.voices) for (const bt of v.beats) {
      if (bt._ly) { bt.text = null; bt.lyrics = null; bt._ly = false; }
    }
    try { snapWordsToNotes(score, timing, lyrics); } catch (e) { console.warn('lyrics snap', e); }
    if (mode === 'off' || !track) return;
    const staff = track.staves[0];
    const findBeat = t => {
      const p = timeToBeatPos(timing, t);
      const barIdx = Math.floor(p / N);
      const bar = staff.bars[barIdx];
      if (!bar) return null;
      const tick = Math.round((p - barIdx * N) * 960);
      const beats = bar.voices[0].beats;
      let best = beats[0];
      for (const bt of beats) { if (bt.playbackStart <= tick + 30) best = bt; }
      return best;
    };
    for (const line of (lyrics && lyrics.lines) || []) {
      if (mode === 'line' || !(line.words && line.words.length)) {
        const bt = findBeat(line.start);
        if (!bt) continue;
        bt.text = bt._ly && bt.text ? bt.text + ' / ' + line.text : line.text;
        bt._ly = true;
      } else {
        for (const w of line.words) {
          const bt = findBeat(w.start);
          if (!bt) continue;
          const word = w.word.trim();
          bt.lyrics = bt._ly && bt.lyrics ? [bt.lyrics[0] + word] : [word];
          bt._ly = true;
        }
      }
    }
  }


  /** Online lyrics only have a time per line; the words were spread evenly over the
   *  line, so under the notes they looked stretched out and missed the notes.
   *  Put each word on the next note the singer actually sings (vocal melody track).
   *  Only in memory, and only for lines whose word times were estimated. */
  function snapWordsToNotes(score, timing, lyrics) {
    const lines = (lyrics && lyrics.lines) || [];
    if (!lines.some(l => l.approx && l.words && l.words.length)) return;
    const vt = score.tracks.find(t => /vocal|人聲/i.test(t.name || ''));
    if (!vt) return;
    if (lyrics._snapFor === score) return;
    const onsets = [];
    for (const bar of vt.staves[0].bars) for (const v of bar.voices) for (const bt of v.beats) {
      if (bt.isRest || bt.isEmpty || !bt.notes.length || bt.notes.every(n => n.isTieDestination)) continue;
      onsets.push(beatPosToTime(timing, (bar.masterBar.start + bt.playbackStart) / 960));
    }
    onsets.sort((a, b) => a - b);
    let k = 0;
    lines.forEach((line, i) => {
      if (!line.approx || !line.words || !line.words.length) return;
      if (!line._orig) line._orig = line.words.map(w => ({ ...w }));
      const words = line._orig;
      const t0 = line.start - 0.25;
      const t1 = (lines[i + 1] ? lines[i + 1].start : line.start + 12) - 0.05;
      while (k < onsets.length && onsets[k] < t0) k++;
      const mine = [];
      for (let j = k; j < onsets.length && onsets[j] < t1; j++) mine.push(onsets[j]);
      if (mine.length < Math.ceil(words.length * 0.6)) { line.words = words.map(w => ({ ...w })); return; }  // melody too sparse: keep the estimate
      line.words = words.map((w, j) => {
        const st = mine[Math.min(j, mine.length - 1)];
        const en = j + 1 < words.length ? mine[Math.min(j + 1, mine.length - 1)] : Math.min(t1, st + 0.6);
        return { ...w, start: st, end: Math.max(st + 0.05, en) };
      });
      line.end = line.words[line.words.length - 1].end;
    });
    lyrics._snapFor = score;
  }

  /* ------------------------------------------------------------ drum notation style */
  // SMuFL code points
  const SYM = { x: 0xE0A9, circlex: 0xE0B3, heavyx: 0xE0F8, diamond: 0xE0DD, ornate: 0xE0AA, open: 0xE5E7 };
  const DRUM_STYLE_DEFAULT = { hho: 'circlex', crash: 'heavyx', ride: 'x', hh: 'x' };
  let drumStyle = { ...DRUM_STYLE_DEFAULT };
  /** which notehead each drum uses: {hho: circlex|xo|circle, crash: heavyx|x|circlex|ornate,
   *  ride: x|diamond|circlex, hh: x|circlex}. Takes effect in applyDrumStyle(score). */
  function setDrumStyle(style) { drumStyle = { ...DRUM_STYLE_DEFAULT, ...(style || {}) }; }

  /** Write the chosen noteheads into the score itself (each drum track gets its own
   *  articulation list), so it also works when the engine draws in a worker. */
  function applyDrumStyle(score) {
    const M = window.__jpPercussion;
    if (!M || !score) return;
    const KIND = { 46: 'hho', 49: 'crash', 57: 'crash', 52: 'crash', 55: 'crash', 51: 'ride', 59: 'ride', 42: 'hh' };
    for (const track of score.tracks) {
      const staff = track.staves[0];
      if (!staff || !staff.isPercussion) continue;
      if (track._jpOwnArts === undefined) track._jpOwnArts = track.percussionArticulations.length;   // from the file
      if (track._jpOwnArts > 0) continue;            // file brought its own list: leave it
      const arts = [], index = new Map();
      for (const bar of staff.bars) for (const v of bar.voices) for (const bt of v.beats) for (const n of bt.notes) {
        if (n._jpId === undefined) n._jpId = n.percussionArticulation;
        const id = n._jpId;
        if (id < 0) continue;
        if (!index.has(id)) {
          const base = M.getArticulationById(id);
          if (!base) { index.set(id, -1); continue; }
          const a = Object.assign(Object.create(Object.getPrototypeOf(base)), base);
          styleArticulation(a, KIND[id], M);
          index.set(id, arts.length);
          arts.push(a);
        }
        const k = index.get(id);
        n.percussionArticulation = k >= 0 ? k : id;
      }
      track.percussionArticulations = arts;
    }
  }
  function styleArticulation(a, kind, M) {
    if (!kind) return;
    const v = drumStyle[kind];
    const head = sym => { a.noteHeadDefault = a.noteHeadHalf = a.noteHeadWhole = sym; };
    if (kind === 'hho') {
      if (v === 'xo') head(SYM.x);          // the little "o" above is drawn by drawCounts()
      else if (v === 'circle') { const c = M.getArticulationById(92); head(c ? c.noteHeadDefault : SYM.circlex); }
      else head(SYM.circlex);
    } else if (kind === 'crash') head({ x: SYM.x, circlex: SYM.circlex, ornate: SYM.ornate }[v] || SYM.heavyx);
    else if (kind === 'ride') head({ diamond: SYM.diamond, circlex: SYM.circlex }[v] || SYM.x);
    else if (kind === 'hh') head(v === 'circlex' ? SYM.circlex : SYM.x);
  }

  /** Counting under the drum notes: 1 e & a 2 e & a … (triplets: 1 trip let). */
  function applyCounts(score, tracks, on) {
    for (const track of tracks || []) {
      const staff = track.staves[0];
      if (!staff || !staff.isPercussion) continue;
      for (const bar of staff.bars) {
        const voices = bar.voices;
        const hasLyrics = voices.some(v => v.beats.some(b => b.lyrics && b.lyrics.some(x => x && !String(x).startsWith('\u200b'))));
        // every count goes on the first voice (one line of text); where only the
        // feet play, the hands voice has a rest there - the count goes on that rest
        const played = new Set();
        voices.forEach(v => v.beats.forEach(bt => {
          if (!bt.isRest && !bt.isEmpty && !bt.graceType && bt.notes.length) played.add(bt.playbackStart);
        }));
        const done = new Set();
        voices.forEach((v, vi) => v.beats.forEach(bt => {
          // remove counts we put there before
          if (bt.lyrics) {
            bt.lyrics = bt.lyrics.filter(x => !String(x).startsWith('\u200b'));
            if (!bt.lyrics.length || bt.lyrics.every(x => !x)) bt.lyrics = null;
          }
          if (!on || vi > 0 || bt.isEmpty || bt.graceType) return;
          const tick = bt.playbackStart;
          if (!played.has(tick) || done.has(tick)) return;
          done.add(tick);
          const den = bar.masterBar.timeSignatureDenominator || 4;
          const unit = 3840 / den;              // ticks per counted beat
          const k = Math.floor(tick / unit + 1e-6);
          const f = (tick - k * unit) / unit;
          const near = x => Math.abs(f - x) < 0.02;
          let label = '';
          if (near(0)) label = String(k + 1);
          else if (near(0.25)) label = 'e';
          else if (near(0.5)) label = '&';
          else if (near(0.75)) label = 'a';
          else if (near(1 / 3)) label = 'trip';
          else if (near(2 / 3)) label = 'let';
          if (!label) return;
          const mark = '\u200b' + label;      // zero-width prefix = "our" text
          if (hasLyrics) bt.lyrics = [(bt.lyrics && bt.lyrics[0]) || '', mark];
          else bt.lyrics = [mark];
        }));
      }
    }
  }

  /** Counting under the drum notes, drawn as one tidy row under each drum staff
   *  (from the engine's note positions, so hands and feet share the same row). */
  function countLabel(tick, den) {
    const unit = 3840 / (den || 4);
    const k = Math.floor(tick / unit + 1e-6);
    const f = (tick - k * unit) / unit;
    const near = x => Math.abs(f - x) < 0.02;
    if (near(0)) return String(k + 1);
    if (near(0.25)) return 'e';
    if (near(0.5)) return '&';
    if (near(0.75)) return 'a';
    if (near(1 / 3)) return 'trip';
    if (near(2 / 3)) return 'let';
    return '';
  }
  function drawCounts(at, el, on) {
    if (!el) return;
    for (const old of el.querySelectorAll(':scope > .jp-counts')) old.remove();
    const bl = at && at.boundsLookup;
    const openO = drumStyle.hho === 'xo';
    if ((!on && !openO) || !bl || !at.score) return;
    let h = '';
    for (let i = 0; i < at.score.masterBars.length; i++) {
      const mb = bl.findMasterBarByIndex(i);
      if (!mb) continue;
      for (const bb of mb.bars) {
        const bar = bb.bar || (bb.beats[0] && bb.beats[0].beat.voice.bar);
        if (!bar || !bar.staff || !bar.staff.isPercussion) continue;
        const xs = new Map();
        for (const b of bb.beats) {
          const bt = b.beat;
          if (bt.isRest || bt.isEmpty || bt.graceType || !bt.notes.length) continue;
          const tk = bt.playbackStart;
          if (!xs.has(tk) || b.onNotesX < xs.get(tk)) xs.set(tk, b.onNotesX);
          if (openO && bt.notes.some(n => (n._jpId !== undefined ? n._jpId : n.percussionArticulation) === 46)) {
            const r0 = bb.realBounds;
            h += `<span class="o" style="left:${b.onNotesX.toFixed(1)}px;top:${(r0.y - r0.h * 1.5).toFixed(1)}px">o</span>`;
          }
        }
        if (!on) continue;
        // the bounds only cover the 5 lines: go below the feet's down stems (~3 line gaps)
        const rb = bb.realBounds, y = rb.y + rb.h + rb.h * 0.8;
        const den = bar.masterBar.timeSignatureDenominator;
        for (const [tk, x] of xs) {
          const t = countLabel(tk, den);
          if (t) h += `<span class="${/^\d/.test(t) ? 'n' : ''}" style="left:${x.toFixed(1)}px;top:${y.toFixed(1)}px">${t}</span>`;
        }
      }
    }
    const layer = document.createElement('div');
    layer.className = 'jp-counts';
    layer.innerHTML = h;
    el.appendChild(layer);
  }

  /* ------------------------------------------------------------ chords */
  const PC = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };
  const CHORD_IV = {
    '': [0, 4, 7], m: [0, 3, 7], 7: [0, 4, 7, 10], maj7: [0, 4, 7, 11], m7: [0, 3, 7, 10],
    sus4: [0, 5, 7], sus2: [0, 2, 7], dim: [0, 3, 6], dim7: [0, 3, 6, 9], m7b5: [0, 3, 6, 10],
    aug: [0, 4, 8], 6: [0, 4, 7, 9], m6: [0, 3, 7, 9], 9: [0, 4, 7, 10, 2], add9: [0, 4, 7, 2],
    m9: [0, 3, 7, 10, 2], '7sus4': [0, 5, 7, 10], mmaj7: [0, 3, 7, 11],
  };
  const ALIASES = { M7: 'maj7', Maj7: 'maj7', 'Δ': 'maj7', min: 'm', '-': 'm', min7: 'm7', '-7': 'm7', 'ø': 'm7b5', '+': 'aug', '°': 'dim', o: 'dim', M: '' };
  function parseChord(name) {
    const m = /^\s*([A-G])([#b♯♭]?)([^/\s]*)(?:\/([A-G])([#b♯♭]?))?\s*$/.exec(name || '');
    if (!m) return null;
    const acc = a => (a === '#' || a === '♯' ? 1 : a === 'b' || a === '♭' ? -1 : 0);
    const root = (PC[m[1]] + acc(m[2]) + 12) % 12;
    let q = ALIASES[m[3]] !== undefined ? ALIASES[m[3]] : m[3];
    if (!(q in CHORD_IV)) q = /^m(?!aj)/.test(q) ? 'm' : '';   // unknown extension -> basic triad
    const bass = m[4] ? (PC[m[4]] + acc(m[5]) + 12) % 12 : root;
    const tones = CHORD_IV[q].map(i => (root + i) % 12);
    return { name, root, quality: q, bass, tones };
  }
  // guitar voicings, strings low E -> high e, -1 = muted
  const OPEN = {
    'C': [-1, 3, 2, 0, 1, 0], 'A': [-1, 0, 2, 2, 2, 0], 'G': [3, 2, 0, 0, 0, 3], 'E': [0, 2, 2, 1, 0, 0], 'D': [-1, -1, 0, 2, 3, 2],
    'Am': [-1, 0, 2, 2, 1, 0], 'Em': [0, 2, 2, 0, 0, 0], 'Dm': [-1, -1, 0, 2, 3, 1],
    'A7': [-1, 0, 2, 0, 2, 0], 'E7': [0, 2, 0, 1, 0, 0], 'D7': [-1, -1, 0, 2, 1, 2], 'G7': [3, 2, 0, 0, 0, 1], 'C7': [-1, 3, 2, 3, 1, 0], 'B7': [-1, 2, 1, 2, 0, 2],
    'Am7': [-1, 0, 2, 0, 1, 0], 'Em7': [0, 2, 0, 0, 0, 0], 'Dm7': [-1, -1, 0, 2, 1, 1],
    'Cmaj7': [-1, 3, 2, 0, 0, 0], 'Fmaj7': [-1, -1, 3, 2, 1, 0], 'Amaj7': [-1, 0, 2, 1, 2, 0], 'Dmaj7': [-1, -1, 0, 2, 2, 2], 'Gmaj7': [3, -1, 0, 0, 0, 2], 'Emaj7': [0, 2, 1, 1, 0, 0],
    'Asus4': [-1, 0, 2, 2, 3, 0], 'Dsus4': [-1, -1, 0, 2, 3, 3], 'Esus4': [0, 2, 2, 2, 0, 0], 'Asus2': [-1, 0, 2, 2, 0, 0], 'Dsus2': [-1, -1, 0, 2, 3, 0],
  };
  // movable shapes relative to the root fret: [E-shape (root on 6th string), A-shape (root on 5th string)]
  const SHAPES = {
    '': [[0, 2, 2, 1, 0, 0], [-1, 0, 2, 2, 2, 0]], m: [[0, 2, 2, 0, 0, 0], [-1, 0, 2, 2, 1, 0]],
    7: [[0, 2, 0, 1, 0, 0], [-1, 0, 2, 0, 2, 0]], maj7: [[0, -1, 1, 1, 0, -1], [-1, 0, 2, 1, 2, 0]],
    m7: [[0, 2, 0, 0, 0, 0], [-1, 0, 2, 0, 1, 0]], sus4: [[0, 2, 2, 2, 0, 0], [-1, 0, 2, 2, 3, 0]],
    sus2: [[0, 2, 4, 4, 0, 0], [-1, 0, 2, 2, 0, 0]], dim: [[0, 1, 2, 0, -1, -1], [-1, 0, 1, 2, 1, -1]],
    m7b5: [[0, -1, 0, 0, -1, -1], [-1, 0, 1, 0, 1, -1]], '7sus4': [[0, 2, 0, 2, 0, 0], [-1, 0, 2, 0, 3, 0]],
    6: [[0, -1, -1, 1, 2, 0], [-1, 0, 2, 2, 2, 2]], m6: [[0, -1, -1, 0, 2, 0], [-1, 0, 2, 2, 1, 2]],
    9: [[0, -1, 0, 1, 0, 2], [-1, 0, -1, 0, 0, 0]], aug: [[0, 3, 2, 1, 1, 0], [-1, 0, 3, 2, 2, 1]],
  };
  const NAMES_SHARP = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const NAMES_FLAT = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  function shapeCandidates(c) {
    const out = [];
    const q = c.quality in SHAPES ? c.quality : (c.quality.startsWith('m') ? 'm' : '');
    for (const n of [NAMES_SHARP[c.root], NAMES_FLAT[c.root]]) {
      const key = n + c.quality;
      if (OPEN[key]) out.push(OPEN[key].slice());
    }
    const fE = (c.root - 4 + 12) % 12 || 12, fA = (c.root - 9 + 12) % 12 || 12;
    const [eS, aS] = SHAPES[q];
    const e = eS.map(v => (v < 0 ? -1 : v + fE)), a = aS.map(v => (v < 0 ? -1 : v + fA));
    if (fE <= fA) out.push(e, a); else out.push(a, e);
    return out;
  }
  const span = v => { const f = v.filter(x => x > 0); return f.length ? Math.max(...f) - Math.min(...f) : 0; };
  const TUNING_STD = [40, 45, 50, 55, 59, 64];
  function guitarVoicing(c) {
    if (!c) return null;
    const cands = shapeCandidates(c);
    if (c.bass === c.root) return cands[0];
    // slash chord: put the bass note on one of the low strings, mute what's below it,
    // and pick the version with the smallest stretch
    let best = null, bestCost = 1e9;
    cands.forEach((shape, ci) => {
      for (let s = 0; s < 3; s++) {
        for (let f = 0; f <= 14; f++) {
          if ((TUNING_STD[s] + f) % 12 !== c.bass) continue;
          const v = shape.slice();
          for (let k = 0; k < s; k++) v[k] = -1;
          v[s] = f;
          if (v.filter(x => x >= 0).length < 3) continue;
          const cost = span(v) * 3 + ci + s * 0.5 + Math.min(...v.filter(x => x > 0).concat([0])) * 0.1;
          if (span(v) <= 4 && cost < bestCost) { best = v; bestCost = cost; }
        }
      }
    });
    return best || cands[0];
  }

  /** chords: [{start,end,name}]. Puts chord names (and guitar diagrams) on the score. */
  function applyChordsToScore(score, timing, chords, tracks, opts = {}) {
    if (!score || !timing) return;
    const N = timing.beatsPerBar;
    for (const tr of score.tracks) for (const st of tr.staves) {
      for (const bar of st.bars) for (const v of bar.voices) for (const bt of v.beats) if (bt._ch) { bt.chordId = null; bt._ch = false; }
    }
    if (!chords || !chords.length || !tracks || !tracks.length) return;
    const track = tracks[0];
    const staff = track.staves[0];
    if (staff.isPercussion) return;
    let id = 0;
    for (const c of chords) {
      const p = timeToBeatPos(timing, c.start + 0.001);
      const barIdx = Math.floor(p / N);
      const bar = staff.bars[barIdx];
      if (!bar) continue;
      const tick = Math.round((p - barIdx * N) * 960);
      let best = null;
      for (const bt of bar.voices[0].beats) if (bt.playbackStart <= tick + 40) best = bt;
      if (!best || best._ch) continue;
      const ch = new alphaTab.model.Chord();
      ch.name = c.name;
      const parsed = parseChord(c.name);
      const voicing = opts.diagrams && parsed ? guitarVoicing(parsed) : null;
      if (voicing && staff.tuning && staff.tuning.length === 6) {
        // alphaTab: strings[0] = highest string
        ch.strings = voicing.slice().reverse();
        const fretted = voicing.filter(f => f > 0);
        ch.firstFret = fretted.length ? Math.max(1, Math.min(...fretted)) : 1;
        if (Math.max(...voicing) <= 4) ch.firstFret = 1;
        ch.showDiagram = true;
      } else {
        ch.showDiagram = false;
      }
      ch.showName = true;
      const key = 'jp' + (id++);
      staff.addChord(key, ch);
      best.chordId = key;
      best._ch = true;
    }
  }

  window.JP = { CHIPS, chipAvailable, tracksForChip, staveProfileFor, timeToBeatPos, beatPosToTime,
    prepareScore, applySyncPoints, steadyBeats, setDrumStyle, applyDrumStyle, applyCounts, drawCounts, applyLyricsToScore, setRhythmStaff, evenBars,
    parseChord, guitarVoicing, applyChordsToScore, NAMES_SHARP, NAMES_FLAT };
})();

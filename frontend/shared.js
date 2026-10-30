/* Score helpers shared by the app (app.js) and the PDF page (print.js). */
'use strict';
(function () {
  // score "chips" -> GP track keys written by backend/score.py
  const CHIPS = [
    { key: 'drums', label: '鼓', tracks: ['drums'] },
    { key: 'vocals', label: '人聲旋律', tracks: ['vocals'] },
    { key: 'guitar', label: '結他', tracks: ['guitar'] },
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
    const fretted = chip === 'guitar' || chip === 'bass';
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

  /** basic fixes after loading one of our GP5 files */
  function prepareScore(score, meta) {
    score.title = (meta && meta.title) || score.title;
    score.artist = (meta && meta.artist) || '';
    // GP5 page-setup templates from our writer don't match alphaTab's; use alphaTab's defaults
    try { score.style = undefined; } catch (e) { /* ignore */ }
  }

  function applySyncPoints(score, timing) {
    if (!timing) return;
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
    prepareScore, applySyncPoints, applyLyricsToScore,
    parseChord, guitarVoicing, applyChordsToScore, NAMES_SHARP, NAMES_FLAT };
})();

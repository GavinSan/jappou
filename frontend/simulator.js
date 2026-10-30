/* 執譜機 simulator: shows what to play right now on a drum kit, a fretboard or a
   keyboard, plus the current chord. It reads the same alphaTab score that is shown
   as notation, so it always matches the chart (including edits / re-scoring). */
'use strict';
(function () {
  const NS = 'http://www.w3.org/2000/svg';
  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    if (parent) parent.appendChild(n);
    return n;
  };
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = p => NOTE_NAMES[((p % 12) + 12) % 12] + (Math.floor(p / 12) - 1);
  const isBlack = p => [1, 3, 6, 8, 10].includes(((p % 12) + 12) % 12);
  const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // ------------------------------------------------------------------ drum kit
  // drummer's-seat view: cymbals up high, toms in a row, snare and kick in front
  const PIECES = {
    crash: { type: 'cym', x: 190, y: 148, rx: 104, ry: 74, label: 'CRASH' },
    ride: { type: 'cym', x: 708, y: 150, rx: 112, ry: 80, label: 'RIDE' },
    hihat: { type: 'hh', x: 108, y: 302, rx: 80, ry: 56, label: 'HH' },
    tom1: { type: 'drum', x: 338, y: 196, rx: 72, ry: 30, h: 44, label: 'TOM 1' },
    tom2: { type: 'drum', x: 494, y: 186, rx: 76, ry: 32, h: 48, label: 'TOM 2' },
    snare: { type: 'drum', x: 298, y: 336, rx: 84, ry: 35, h: 30, label: 'SNARE' },
    floor: { type: 'drum', x: 700, y: 344, rx: 90, ry: 37, h: 66, label: 'FLOOR TOM' },
    kick: { type: 'kick', x: 486, y: 392, r: 98, label: 'KICK' },
  };
  const GM_TO_PIECE = {
    35: 'kick', 36: 'kick', 37: 'snare', 38: 'snare', 39: 'snare', 40: 'snare',
    42: 'hihat', 44: 'hihat', 46: 'hihat',
    49: 'crash', 52: 'crash', 55: 'crash', 57: 'crash',
    51: 'ride', 53: 'ride', 59: 'ride',
    48: 'tom1', 50: 'tom1', 45: 'tom2', 47: 'tom2', 41: 'floor', 43: 'floor',
  };
  const DRAW_ORDER = ['kick', 'tom1', 'tom2', 'floor', 'snare', 'hihat', 'crash', 'ride'];

  class Simulator {
    constructor(root) {
      this.root = root;
      this.kind = null;
      this.events = [];
      this.chords = [];
      this.keyName = '';
      this.lookahead = 1.0;   // seconds of song time to preview
      this.svg = null;
      this.parts = {};
      this.lastKey = '';
      this.lastChordKey = '';
    }

    /** tracks: alphaTab Track objects for the selected chip; chip: drums|guitar|bass|piano|vocals|other */
    setTracks(tracks, chip, timing) {
      this.timing = timing;
      this.kind = chip === 'drums' ? 'drums' : (chip === 'guitar' || chip === 'bass') ? 'fret' : 'keys';
      this.chip = chip;
      this.events = this._collect(tracks || [], this.kind);
      this.lastKey = '';
      this.lastChordKey = '';
      this._build(tracks || []);
    }

    setChords(chords, keyName) {
      this.chords = (chords || []).map(c => ({ ...c, parsed: JP.parseChord(c.name) })).sort((a, b) => a.start - b.start);
      this.keyName = keyName || '';
      this.lastChordKey = '';
    }

    // ---------------------------------------------------------------- events
    _time(tick) {
      return JP.beatPosToTime(this.timing, tick / 960);
    }

    _collect(tracks, kind) {
      const ev = [];
      tracks.forEach((track, ti) => {
        const staff = track.staves[0];
        if (!staff) return;
        for (const bar of staff.bars) {
          for (const voice of bar.voices) {
            for (const beat of voice.beats) {
              if (beat.isRest || beat.isEmpty || !beat.notes || !beat.notes.length) continue;
              const t0Tick = bar.masterBar.start + beat.playbackStart;
              const t0 = this._time(t0Tick);
              const t1 = this._time(t0Tick + Math.max(60, beat.playbackDuration));
              const notes = [];
              for (const n of beat.notes) {
                if (kind === 'drums') {
                  const gm = n.percussionArticulation >= 0 ? n.percussionArticulation : n.realValue;
                  const piece = GM_TO_PIECE[gm];
                  if (piece) notes.push({ piece, open: gm === 46 });
                } else if (kind === 'fret') {
                  if (n.string >= 1) notes.push({ string: n.string, fret: n.fret, pitch: n.realValue, tie: n.isTieDestination });
                } else {
                  notes.push({ pitch: n.realValue, tie: n.isTieDestination, hand: ti === 1 ? 'L' : 'R' });
                }
              }
              if (notes.length) ev.push({ t0, t1, notes });
            }
          }
        }
      });
      ev.sort((a, b) => a.t0 - b.t0);
      this.maxDur = ev.reduce((m, e) => Math.max(m, e.t1 - e.t0), 0.5);
      return ev;
    }

    _window(t) {
      const ev = this.events;
      let lo = 0, hi = ev.length;
      const from = t - Math.min(this.maxDur, 12);
      while (lo < hi) { const m = (lo + hi) >> 1; if (ev[m].t0 < from) lo = m + 1; else hi = m; }
      const out = [];
      for (let i = lo; i < ev.length && ev[i].t0 <= t + this.lookahead; i++) out.push(ev[i]);
      return out;
    }

    _chordAt(t) {
      const cs = this.chords;
      let lo = 0, hi = cs.length - 1, idx = -1;
      while (lo <= hi) { const m = (lo + hi) >> 1; if (cs[m].start <= t + 0.03) { idx = m; lo = m + 1; } else hi = m - 1; }
      const cur = idx >= 0 && t < cs[idx].end + 0.05 ? cs[idx] : null;
      const next = cs[idx + 1] || null;
      return { cur, next };
    }

    // ---------------------------------------------------------------- build
    _build(tracks) {
      this.root.innerHTML = '';
      this.parts = {};
      this.header = null;
      if (!this.events.length) {
        this.root.innerHTML = '<div class="sim-empty">呢件樂器冇音符可以模擬</div>';
        this.svg = null;
        return;
      }
      const wrap = document.createElement('div');
      wrap.className = 'sim-inner';
      this.root.appendChild(wrap);
      if (this.kind !== 'drums') {
        this.header = document.createElement('div');
        this.header.className = 'sim-chords';
        wrap.appendChild(this.header);
      }
      this.stage = wrap;
      if (this.kind === 'drums') this._buildDrums();
      else if (this.kind === 'fret') this._buildFret(tracks[0]);
      else this._buildKeys();
    }

    _defs(svg) {
      const defs = el('defs', {}, svg);
      const grad = (id, stops, attrs = {}, tag = 'linearGradient') => {
        const g = el(tag, { id, ...attrs }, defs);
        for (const [o, c] of stops) el('stop', { offset: o, 'stop-color': c }, g);
      };
      grad('jpCym', [['0', '#fff1c4'], ['0.18', '#f0cd78'], ['0.55', '#d6a64a'], ['0.85', '#b07f2a'], ['1', '#7c5618']], { cx: '0.45', cy: '0.4', r: '0.65' }, 'radialGradient');
      grad('jpCymHit', [['0', '#ffffff'], ['0.4', '#ffe7a0'], ['1', '#ffb340']], { cx: '0.45', cy: '0.4', r: '0.7' }, 'radialGradient');
      grad('jpShell', [['0', '#a9adb3'], ['0.18', '#f1f2f0'], ['0.42', '#d4d7db'], ['0.6', '#fafaf8'], ['0.82', '#c3c7cc'], ['1', '#8f949a']], { x1: '0', x2: '1', y1: '0', y2: '0' });
      grad('jpHead', [['0', '#57463a'], ['0.75', '#33281f'], ['1', '#1f1813']], { cx: '0.5', cy: '0.45', r: '0.6' }, 'radialGradient');
      grad('jpHeadHit', [['0', '#ffe3ad'], ['0.6', '#ffb340'], ['1', '#d47b12']], { cx: '0.5', cy: '0.45', r: '0.6' }, 'radialGradient');
      grad('jpWall', [['0', '#4b3020'], ['0.5', '#3c2617'], ['1', '#2d1c11']], { x1: '0', x2: '0', y1: '0', y2: '1' });
      grad('jpFloor', [['0', '#24262c'], ['1', '#141519']], { x1: '0', x2: '0', y1: '0', y2: '1' });
      grad('jpChrome', [['0', '#f4f4f4'], ['0.5', '#9b9ea3'], ['1', '#e2e2e2']], { x1: '0', x2: '1', y1: '0', y2: '0' });
      const f = el('filter', { id: 'jpGlow', x: '-40%', y: '-40%', width: '180%', height: '180%' }, defs);
      el('feGaussianBlur', { stdDeviation: '7', result: 'b' }, f);
      const m = el('feMerge', {}, f);
      el('feMergeNode', { in: 'b' }, m);
      el('feMergeNode', { in: 'SourceGraphic' }, m);
    }

    _buildDrums() {
      const svg = el('svg', { viewBox: '0 0 900 430', class: 'sim-svg sim-drums', role: 'img', 'aria-label': '鼓模擬器' }, this.stage);
      this.svg = svg;
      this._defs(svg);
      // room: wooden back wall + floor
      el('rect', { x: 0, y: 0, width: 900, height: 262, fill: 'url(#jpWall)' }, svg);
      for (let y = 26; y < 262; y += 34) el('line', { x1: 0, x2: 900, y1: y, y2: y, class: 'plank' }, svg);
      for (let i = 0; i < 9; i++) {
        const y = 26 + 34 * (i % 7);
        el('line', { x1: 60 + i * 97, x2: 60 + i * 97, y1: y - 34, y2: y, class: 'plank' }, svg);
      }
      el('rect', { x: 0, y: 262, width: 900, height: 168, fill: 'url(#jpFloor)' }, svg);
      const used = new Set(this.events.flatMap(e => e.notes.map(n => n.piece)));
      // stands behind everything
      for (const key of ['crash', 'ride', 'hihat']) {
        const p = PIECES[key];
        el('line', { x1: p.x, x2: p.x, y1: p.y, y2: 428, class: 'stand' }, svg);
        el('line', { x1: p.x, x2: p.x - 34, y1: 410, y2: 428, class: 'stand' }, svg);
        el('line', { x1: p.x, x2: p.x + 34, y1: 410, y2: 428, class: 'stand' }, svg);
      }
      for (const key of DRAW_ORDER) {
        const p = PIECES[key];
        const g = el('g', { class: `pc ${p.type} ${used.has(key) ? '' : 'unused'}` }, svg);
        const part = { g, p };
        if (p.type === 'kick') {
          el('circle', { cx: p.x, cy: p.y, r: p.r + 9, fill: 'url(#jpShell)', class: 'hoop' }, g);
          el('circle', { cx: p.x, cy: p.y, r: p.r, fill: 'url(#jpHead)', class: 'head' }, g);
          part.flash = el('circle', { cx: p.x, cy: p.y, r: p.r, fill: 'url(#jpHeadHit)', class: 'flash', filter: 'url(#jpGlow)' }, g);
          el('circle', { cx: p.x, cy: p.y, r: p.r * 0.42, class: 'logo-ring' }, g);
          el('circle', { cx: p.x + p.r * 0.45, cy: p.y + p.r * 0.32, r: p.r * 0.13, class: 'port' }, g);
          const t = el('text', { x: p.x, y: p.y - p.r * 0.55, class: 'lbl drumlbl' }, g);
          t.textContent = p.label;
          part.ring = el('circle', { cx: p.x, cy: p.y, r: p.r, class: 'ring' }, g);
          part.ring2 = el('circle', { cx: p.x, cy: p.y, r: p.r, class: 'ring' }, g);
        } else if (p.type === 'drum') {
          const { x, y, rx, ry, h } = p;
          // shell: side of a cylinder seen slightly from above
          el('path', { d: `M${x - rx},${y} L${x - rx},${y + h} A${rx},${ry} 0 0 0 ${x + rx},${y + h} L${x + rx},${y} Z`, fill: 'url(#jpShell)', class: 'shell' }, g);
          for (let i = -2; i <= 2; i++) {
            const lx = x + i * rx * 0.42;
            el('rect', { x: lx - 3, y: y + h * 0.28, width: 6, height: h * 0.44, rx: 2, fill: 'url(#jpChrome)', class: 'lug' }, g);
          }
          el('ellipse', { cx: x, cy: y + h, rx, ry, class: 'bottom-rim' }, g);
          el('ellipse', { cx: x, cy: y, rx, ry, fill: 'url(#jpHead)', class: 'head' }, g);
          part.flash = el('ellipse', { cx: x, cy: y, rx, ry, fill: 'url(#jpHeadHit)', class: 'flash', filter: 'url(#jpGlow)' }, g);
          el('ellipse', { cx: x, cy: y, rx: rx - 3, ry: ry - 2, class: 'rim' }, g);
          const t = el('text', { x, y: y + 5, class: 'lbl drumlbl' }, g);
          t.textContent = p.label;
          part.ring = el('ellipse', { cx: x, cy: y, rx, ry, class: 'ring' }, g);
          part.ring2 = el('ellipse', { cx: x, cy: y, rx, ry, class: 'ring' }, g);
        } else {
          const { x, y, rx, ry } = p;
          const top = el('g', { class: 'plate' }, g);
          if (p.type === 'hh') el('ellipse', { cx: x, cy: y + 7, rx, ry, fill: 'url(#jpCym)', class: 'cymbody lower' }, g);
          g.appendChild(top);
          el('ellipse', { cx: x, cy: y, rx, ry, fill: 'url(#jpCym)', class: 'cymbody' }, top);
          part.flash = el('ellipse', { cx: x, cy: y, rx, ry, fill: 'url(#jpCymHit)', class: 'flash', filter: 'url(#jpGlow)' }, top);
          for (let k = 0.86; k > 0.25; k -= 0.09) el('ellipse', { cx: x, cy: y, rx: rx * k, ry: ry * k, class: 'groove' }, top);
          el('ellipse', { cx: x, cy: y, rx: rx * 0.2, ry: ry * 0.2, class: 'bell' }, top);
          el('ellipse', { cx: x, cy: y, rx: rx * 0.06, ry: ry * 0.06, class: 'nut' }, top);
          const t = el('text', { x, y: y + ry * 0.62, class: 'lbl cymlbl' }, top);
          t.textContent = p.label;
          if (p.type === 'hh') {
            part.openMark = el('text', { x, y: y - ry * 0.42, class: 'lbl cymlbl open-mark' }, top);
            part.openMark.textContent = 'OPEN';
            part.plate = top;
          }
          part.ring = el('ellipse', { cx: x, cy: y, rx, ry, class: 'ring' }, g);
          part.ring2 = el('ellipse', { cx: x, cy: y, rx, ry, class: 'ring' }, g);
        }
        this.parts[key] = part;
      }
      const legend = el('text', { x: 890, y: 22, class: 'legend', 'text-anchor': 'end' }, svg);
      legend.textContent = '光圈收到埋就要打 · KICK 用右腳';
    }

    _buildFret(track) {
      const tuning = (track.staves[0].tuning || []).slice(); // alphaTab: index 0 = highest string
      const nStr = Math.max(4, Math.min(8, tuning.length || (this.chip === 'bass' ? 4 : 6)));
      this.nStr = nStr;
      this.tuningLowToHigh = tuning.slice().reverse();
      const maxFret = Math.max(5, ...this.events.flatMap(e => e.notes.map(n => n.fret)));
      const frets = Math.min(24, Math.max(12, maxFret + 1));
      this.frets = frets;
      const W = 900, left = 46, right = 14, top = 22, gap = this.chip === 'bass' ? 26 : 20;
      const H = top + gap * (nStr - 1) + 40;
      const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sim-svg sim-fret', role: 'img', 'aria-label': '指板模擬器' }, this.stage);
      this.svg = svg;
      const scale = 1 - Math.pow(2, -frets / 12);
      const fx = f => left + (W - left - right) * (1 - Math.pow(2, -f / 12)) / scale;
      this.fx = fx;
      const y = s => top + (nStr - s) * gap;   // string 1 (lowest) at the bottom, like TAB
      this.sy = y;
      el('rect', { x: left, y: top - 8, width: W - left - right, height: gap * (nStr - 1) + 16, class: 'board' }, svg);
      for (const m of [3, 5, 7, 9, 15, 17, 19, 21]) {
        if (m > frets) continue;
        el('circle', { cx: (fx(m - 1) + fx(m)) / 2, cy: top + gap * (nStr - 1) / 2, r: 5, class: 'inlay' }, svg);
      }
      if (frets >= 12) {
        const cx = (fx(11) + fx(12)) / 2;
        el('circle', { cx, cy: top + gap * (nStr - 1) * 0.25, r: 5, class: 'inlay' }, svg);
        el('circle', { cx, cy: top + gap * (nStr - 1) * 0.75, r: 5, class: 'inlay' }, svg);
      }
      for (let f = 0; f <= frets; f++) {
        el('line', { x1: fx(f), x2: fx(f), y1: top - 8, y2: top + gap * (nStr - 1) + 8, class: f === 0 ? 'nut' : 'fretwire' }, svg);
        if (f > 0 && (f <= 12 || f % 2 === 1 || f === frets)) {
          const t = el('text', { x: (fx(f - 1) + fx(f)) / 2, y: H - 6, class: 'fretnum' }, svg);
          t.textContent = f;
        }
      }
      for (let s = 1; s <= nStr; s++) {
        el('line', { x1: left, x2: W - right, y1: y(s), y2: y(s), class: 'string', 'stroke-width': 0.8 + (s - 1) * (this.chip === 'bass' ? 0.6 : 0.35) }, svg);
        const tn = tuning[nStr - s];
        const lab = el('text', { x: 18, y: y(s) + 4, class: 'strname' }, svg);
        lab.textContent = tn != null ? NOTE_NAMES[tn % 12] : s;
      }
      this.ghostLayer = el('g', {}, svg);
      this.dotLayer = el('g', {}, svg);
    }

    _buildKeys() {
      const pitches = this.events.flatMap(e => e.notes.map(n => n.pitch));
      let lo = Math.min(...pitches, 48), hi = Math.max(...pitches, 71);
      lo = Math.max(21, Math.floor(lo / 12) * 12);
      hi = Math.min(108, Math.ceil((hi + 1) / 12) * 12 - 1);
      while (hi - lo < 35) { if (lo > 21) lo -= 12; else hi += 12; }
      lo = Math.max(21, lo); hi = Math.min(108, hi);
      const whites = [];
      for (let p = lo; p <= hi; p++) if (!isBlack(p)) whites.push(p);
      const W = 900, H = 130, ww = W / whites.length, bw = ww * 0.62, bh = H * 0.6;
      const svg = el('svg', { viewBox: `0 0 ${W} ${H + 18}`, class: 'sim-svg sim-keys', role: 'img', 'aria-label': '琴鍵模擬器' }, this.stage);
      this.svg = svg;
      this.keys = new Map();
      this.keyX = new Map();
      const xOfWhite = new Map();
      whites.forEach((p, i) => {
        xOfWhite.set(p, i * ww);
        const r = el('rect', { x: i * ww + 0.5, y: 0, width: ww - 1, height: H, rx: 3, class: 'wk' }, svg);
        this.keys.set(p, r);
        this.keyX.set(p, { x: i * ww + ww / 2, y: H - 22, black: false });
        if (p % 12 === 0) {
          const t = el('text', { x: i * ww + ww / 2, y: H - 6, class: 'cname' }, svg);
          t.textContent = noteName(p);
        }
      });
      for (let p = lo; p <= hi; p++) {
        if (!isBlack(p)) continue;
        const xl = xOfWhite.get(p - 1);
        if (xl == null) continue;
        const r = el('rect', { x: xl + ww - bw / 2, y: 0, width: bw, height: bh, rx: 2, class: 'bk' }, svg);
        this.keys.set(p, r);
        this.keyX.set(p, { x: xl + ww, y: bh - 12, black: true });
      }
      this.toneLayer = el('g', {}, svg);
      const leg = el('text', { x: W, y: H + 15, class: 'legend', 'text-anchor': 'end' }, svg);
      leg.textContent = this.chip === 'piano' ? '橙色 = 右手　藍色 = 左手　淺色 = 下一下　圓點 = 和弦音' : '亮咗 = 而家嘅音　淺色 = 下一下　圓點 = 和弦音';
    }

    // ---------------------------------------------------------------- render
    render(t, rate = 1) {
      if (!this.svg || !this.events.length) return;
      const win = this._window(t);
      if (this.kind === 'drums') this._renderDrums(t, win, rate);
      else {
        this._renderChords(t);
        if (this.kind === 'fret') this._renderFret(t, win);
        else this._renderKeys(t, win);
      }
    }

    _renderChords(t) {
      if (!this.header) return;
      const { cur, next } = this._chordAt(t);
      const key = (cur ? cur.name + cur.start : '-') + '|' + (next ? next.name + next.start : '-');
      if (key === this.lastChordKey) return;
      this.lastChordKey = key;
      this.curChord = cur;
      if (!this.chords.length) {
        this.header.innerHTML = '<span class="muted">（未有和弦資料）</span>';
      } else {
        this.header.innerHTML =
          `<span class="lab">和弦</span><span class="cur">${cur ? esc(cur.name) : '—'}</span>` +
          (next ? `<span class="next">→ ${esc(next.name)}</span>` : '') +
          (this.keyName ? `<span class="key">調：${esc(this.keyName)}</span>` : '');
      }
      this._drawChordShape(cur && cur.parsed);
    }

    _drawChordShape(c) {
      if (this.kind === 'fret') {
        this.ghostLayer.innerHTML = '';
        if (!c) return;
        if (this.chip === 'guitar' && this.nStr === 6) {
          const v = JP.guitarVoicing(c);
          if (!v) return;
          v.forEach((f, i) => {
            const s = i + 1; // v[0] = lowest string = alphaTab string 1
            const y = this.sy(s);
            if (f < 0) {
              const t = el('text', { x: this.fx(0) - 16, y: y + 4, class: 'ghost-x' }, this.ghostLayer);
              t.textContent = '×';
            } else if (f <= this.frets) {
              const x = f === 0 ? this.fx(0) - 16 : (this.fx(f - 1) + this.fx(f)) / 2;
              el('circle', { cx: x, cy: y, r: f === 0 ? 7 : 9, class: 'ghost' + ((this.tuningLowToHigh[i] + f) % 12 === c.root ? ' root' : '') }, this.ghostLayer);
            }
          });
        } else {
          // bass: where the bass note of the chord is on the lowest two strings
          for (let s = 1; s <= Math.min(2, this.nStr); s++) {
            const open = this.tuningLowToHigh[s - 1];
            if (open == null) continue;
            for (let f = 0; f <= Math.min(12, this.frets); f++) {
              if ((open + f) % 12 !== c.bass) continue;
              const x = f === 0 ? this.fx(0) - 16 : (this.fx(f - 1) + this.fx(f)) / 2;
              el('circle', { cx: x, cy: this.sy(s), r: 9, class: 'ghost root' }, this.ghostLayer);
            }
          }
        }
      } else if (this.kind === 'keys') {
        this.toneLayer.innerHTML = '';
        if (!c) return;
        for (const [p, pos] of this.keyX) {
          const inChordOctave = p >= 60 && p <= 71 && c.tones.includes(p % 12);
          const inBassOctave = p >= 36 && p <= 47 && p % 12 === c.bass;
          if (!inChordOctave && !inBassOctave) continue;
          el('circle', { cx: pos.x, cy: pos.y, r: 4.5, class: 'tone' + (p % 12 === c.root ? ' root' : '') + (pos.black ? ' onblack' : '') }, this.toneLayer);
        }
      }
    }

    _renderDrums(t, win, rate) {
      const flash = 0.13 * rate;
      const L = this.lookahead;
      const state = {};
      for (const key of Object.keys(this.parts)) state[key] = { hit: false, open: false, next: [] };
      for (const e of win) {
        for (const n of e.notes) {
          const s = state[n.piece];
          if (!s) continue;
          const dt = e.t0 - t;
          if (dt <= 0 && dt > -flash) { s.hit = true; if (n.open) s.open = true; }
          else if (dt > 0 && dt <= L && s.next.length < 2 && !s.next.includes(e.t0)) s.next.push(e.t0);
        }
      }
      for (const [key, part] of Object.entries(this.parts)) {
        const s = state[key];
        part.g.classList.toggle('hit', s.hit);
        if (part.openMark) part.openMark.classList.toggle('show', s.open);
        if (part.plate) part.plate.setAttribute('transform', s.open ? 'translate(0 -9)' : '');
        const p = part.p;
        [part.ring, part.ring2].forEach((ring, i) => {
          const tn = s.next[i];
          if (tn == null) { ring.setAttribute('opacity', 0); return; }
          const k = (tn - t) / L; // 1 -> far, 0 -> now
          const sc = 1 + 0.9 * k;
          if (p.type === 'kick') ring.setAttribute('r', (p.r * sc).toFixed(1));
          else { ring.setAttribute('rx', (p.rx * sc).toFixed(1)); ring.setAttribute('ry', (p.ry * sc).toFixed(1)); }
          ring.setAttribute('opacity', (0.95 - 0.75 * k).toFixed(2));
        });
      }
    }

    _renderFret(t, win) {
      const want = new Map();
      let nextT = null;
      for (const e of win) {
        const sounding = e.t0 <= t && t < e.t1;
        if (sounding) {
          for (const n of e.notes) want.set(`${n.string}:${n.fret}`, { ...n, cls: n.tie ? 'on hold' : 'on' });
        } else if (e.t0 > t) {
          if (nextT == null) nextT = e.t0;
          if (e.t0 === nextT) {
            for (const n of e.notes) {
              const k = `${n.string}:${n.fret}`;
              if (!want.has(k)) want.set(k, { ...n, cls: 'next' });
            }
          }
        }
      }
      const key = [...want].map(([k, v]) => k + v.cls).join('|');
      if (key === this.lastKey) return;
      this.lastKey = key;
      this.dotLayer.innerHTML = '';
      for (const n of want.values()) {
        const x = n.fret === 0 ? this.fx(0) - 16 : (this.fx(n.fret - 1) + this.fx(n.fret)) / 2;
        const g = el('g', { class: `dot ${n.cls}`, transform: `translate(${x.toFixed(1)} ${this.sy(n.string)})` }, this.dotLayer);
        el('circle', { r: n.fret === 0 ? 8 : 9.5 }, g);
        const tx = el('text', { y: 4 }, g);
        tx.textContent = n.fret === 0 ? 'O' : n.fret;
      }
    }

    _renderKeys(t, win) {
      const want = new Map();
      let nextT = null;
      for (const e of win) {
        if (e.t0 <= t && t < e.t1) {
          for (const n of e.notes) want.set(n.pitch, n.hand === 'L' ? 'on lh' : 'on rh');
        } else if (e.t0 > t) {
          if (nextT == null) nextT = e.t0;
          if (e.t0 - nextT < 0.02) for (const n of e.notes) if (!want.has(n.pitch)) want.set(n.pitch, n.hand === 'L' ? 'next lh' : 'next rh');
        }
      }
      const key = [...want].join('|');
      if (key === this.lastKey) return;
      this.lastKey = key;
      for (const [p, rect] of this.keys) {
        const cls = want.get(p);
        rect.setAttribute('class', (isBlack(p) ? 'bk' : 'wk') + (cls ? ' ' + cls : ''));
      }
    }
  }

  window.JPSimulator = Simulator;
})();

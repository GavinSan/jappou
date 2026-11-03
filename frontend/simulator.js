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
  // drummer's-seat view (viewBox 900 x 440): cymbals up high, toms on the kick,
  // snare and floor tom in front
  const PIECES = {
    crash: { type: 'cym', x: 205, y: 150, rx: 110, ry: 60, label: 'CRASH', stand: [205, 432] },
    ride: { type: 'cym', x: 712, y: 150, rx: 122, ry: 66, label: 'RIDE', stand: [712, 432] },
    hihat: { type: 'hh', x: 96, y: 292, rx: 82, ry: 28, label: 'HI-HAT', stand: [96, 432] },
    tom1: { type: 'drum', x: 348, y: 204, rx: 70, ry: 25, h: 58, label: 'TOM 1' },
    tom2: { type: 'drum', x: 506, y: 198, rx: 74, ry: 27, h: 62, label: 'TOM 2' },
    snare: { type: 'drum', x: 258, y: 330, rx: 86, ry: 30, h: 36, label: 'SNARE' },
    floor: { type: 'drum', x: 692, y: 322, rx: 94, ry: 33, h: 72, label: 'FLOOR TOM' },
    kick: { type: 'kick', x: 452, y: 330, r: 92, label: 'KICK' },
  };
  const GM_TO_PIECE = {
    35: 'kick', 36: 'kick', 37: 'snare', 38: 'snare', 39: 'snare', 40: 'snare',
    42: 'hihat', 44: 'hihat', 46: 'hihat',
    49: 'crash', 52: 'crash', 55: 'crash', 57: 'crash',
    51: 'ride', 53: 'ride', 59: 'ride',
    48: 'tom1', 50: 'tom1', 45: 'tom2', 47: 'tom2', 41: 'floor', 43: 'floor',
  };
  const DRAW_ORDER = ['kick', 'tom1', 'tom2', 'floor', 'snare', 'hihat', 'crash', 'ride'];
  const HIT_MS = 420;   // length of the hit animation

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
      this.kind = chip === 'drums' ? 'drums' : (chip === 'guitar' || chip === 'lead' || chip === 'bass') ? 'fret' : 'keys';
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
        for (const [o, c, op] of stops) el('stop', { offset: o, 'stop-color': c, ...(op != null ? { 'stop-opacity': op } : {}) }, g);
      };
      grad('jpStage', [['0', '#4a3424'], ['0.45', '#24180f'], ['1', '#0b0806']], { cx: '450', cy: '140', r: '620', gradientUnits: 'userSpaceOnUse' }, 'radialGradient');
      grad('jpBeam', [['0', '#ffe9c4', 0.13], ['1', '#ffe9c4', 0]], { x1: '0', x2: '0', y1: '0', y2: '1' });
      grad('jpRug', [['0', '#3a2320'], ['0.7', '#21140f'], ['1', '#120b08', 0]], { cx: '0.5', cy: '0.5', r: '0.5' }, 'radialGradient');
      grad('jpCym', [['0', '#fff3c9'], ['0.12', '#f6d784'], ['0.45', '#dcae4e'], ['0.8', '#b88a2e'], ['1', '#8a6219']], { cx: '0.42', cy: '0.38', r: '0.7' }, 'radialGradient');
      grad('jpBell', [['0', '#fff8dc'], ['0.6', '#f0c96b'], ['1', '#b68a33']], { cx: '0.4', cy: '0.35', r: '0.7' }, 'radialGradient');
      grad('jpCymHit', [['0', '#ffffff', 0.95], ['0.5', '#fff1b8', 0.7], ['1', '#ffb340', 0]], { cx: '0.5', cy: '0.5', r: '0.55' }, 'radialGradient');
      grad('jpSheen', [['0', '#ffffff', 0], ['0.5', '#ffffff', 0.55], ['1', '#ffffff', 0]], { x1: '0', x2: '1', y1: '0', y2: '0' });
      // wine-red lacquer wrap with a bright reflection stripe
      grad('jpShell', [['0', '#2a0508'], ['0.1', '#5e0c14'], ['0.24', '#a3202b'], ['0.3', '#ec6670'], ['0.34', '#b8262f'], ['0.6', '#8a1520'], ['0.82', '#5a0b12'], ['1', '#220407']], { x1: '0', x2: '1', y1: '0', y2: '0' });
      grad('jpKickWrap', [['0.82', '#2a0508'], ['0.9', '#9e1e28'], ['0.95', '#d9545e'], ['1', '#4a0910']], { cx: '0.5', cy: '0.5', r: '0.5' }, 'radialGradient');
      grad('jpHead', [['0', '#fdfbf6'], ['0.7', '#ece6da'], ['1', '#cfc6b6']], { cx: '0.45', cy: '0.4', r: '0.62' }, 'radialGradient');
      grad('jpHeadHit', [['0', '#fff6dd', 0.95], ['0.6', '#ffc35a', 0.75], ['1', '#ff9a1f', 0]], { cx: '0.5', cy: '0.5', r: '0.55' }, 'radialGradient');
      grad('jpReso', [['0', '#3a3a40'], ['0.6', '#18181c'], ['1', '#060607']], { cx: '0.4', cy: '0.35', r: '0.75' }, 'radialGradient');
      grad('jpChrome', [['0', '#fdfdfd'], ['0.35', '#a7abb1'], ['0.55', '#eef0f2'], ['1', '#7b8087']], { x1: '0', x2: '1', y1: '0', y2: '1' });
      grad('jpChromeV', [['0', '#f5f6f7'], ['0.5', '#8d9198'], ['1', '#d9dbde']], { x1: '0', x2: '1', y1: '0', y2: '0' });
      const blur = (id, sd) => { const f = el('filter', { id, x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs); el('feGaussianBlur', { stdDeviation: sd }, f); };
      blur('jpBlur6', 6);
      blur('jpBlur3', 3);
      const f = el('filter', { id: 'jpGlow', x: '-50%', y: '-50%', width: '200%', height: '200%' }, defs);
      el('feGaussianBlur', { stdDeviation: '9', result: 'b' }, f);
      const m = el('feMerge', {}, f);
      el('feMergeNode', { in: 'b' }, m);
      el('feMergeNode', { in: 'SourceGraphic' }, m);
    }

    _chromeTube(svg, x1, y1, x2, y2, w = 5) {
      el('line', { x1, y1, x2, y2, stroke: '#3c3f44', 'stroke-width': w + 1.5, 'stroke-linecap': 'round' }, svg);
      el('line', { x1, y1, x2, y2, stroke: 'url(#jpChromeV)', 'stroke-width': w, 'stroke-linecap': 'round' }, svg);
    }

    _stand(svg, x, yTop, yFloor) {
      this._chromeTube(svg, x, yTop, x, yFloor - 14, 5);
      for (const dx of [-38, 38, 0]) this._chromeTube(svg, x, yFloor - 16, x + dx, yFloor + (dx ? 4 : 8), 3.5);
    }

    _drum(g, p) {
      const { x, y, rx, ry, h } = p;
      // shell: the front of a cylinder seen from slightly above
      el('path', { d: `M${x - rx},${y} L${x - rx},${y + h} A${rx},${ry} 0 0 0 ${x + rx},${y + h} L${x + rx},${y} Z`, fill: 'url(#jpShell)', class: 'shell' }, g);
      // lugs placed around the front half of the cylinder (perspective spacing)
      for (const deg of [12, 40, 68, 90, 112, 140, 168]) {
        const c = Math.cos(deg * Math.PI / 180), sn = Math.sin(deg * Math.PI / 180);
        const lx = x - rx * c, w = 4 + 5 * sn;
        el('rect', { x: lx - w / 2, y: y + h * 0.22 + ry * sn * 0.6, width: w, height: Math.max(8, h * 0.42), rx: w / 2, fill: 'url(#jpChrome)', class: 'lug', opacity: 0.55 + 0.45 * sn }, g);
      }
      // bottom hoop (front half), head, top hoop + tension rods
      el('path', { d: `M${x - rx},${y + h} A${rx},${ry} 0 0 0 ${x + rx},${y + h}`, class: 'hoop-b' }, g);
      el('ellipse', { cx: x, cy: y, rx, ry, fill: 'url(#jpHead)', class: 'head' }, g);
      el('ellipse', { cx: x, cy: y, rx: rx * 0.9, ry: ry * 0.9, class: 'head-edge' }, g);
      const fl = el('ellipse', { cx: x, cy: y, rx, ry, fill: 'url(#jpHeadHit)', class: 'flash', filter: 'url(#jpGlow)' }, g);
      const rip = el('ellipse', { cx: x, cy: y, rx: rx * 0.8, ry: ry * 0.8, class: 'ripple' }, g);
      el('ellipse', { cx: x, cy: y, rx, ry, class: 'hoop-t' }, g);
      for (let deg = 0; deg < 360; deg += 360 / 10) {
        const a = deg * Math.PI / 180;
        el('circle', { cx: x + rx * Math.cos(a), cy: y + ry * Math.sin(a), r: Math.sin(a) > 0 ? 2.6 : 1.8, class: 'rod' }, g);
      }
      const t = el('text', { x, y: y + 4, class: 'lbl shell-lbl' }, g);
      t.textContent = p.label;
      return { flash: fl, ripple: rip };
    }

    _kick(g, p) {
      const { x, y, r } = p;
      el('line', { x1: x - r * 0.7, y1: y + r * 0.55, x2: x - r * 1.05, y2: y + r * 0.98, class: 'spur' }, g);
      el('line', { x1: x + r * 0.7, y1: y + r * 0.55, x2: x + r * 1.05, y2: y + r * 0.98, class: 'spur' }, g);
      el('circle', { cx: x, cy: y, r: r + 13, fill: 'url(#jpKickWrap)', class: 'k-hoop' }, g);
      for (let deg = 0; deg < 360; deg += 30) {
        const a = deg * Math.PI / 180;
        el('rect', { x: x + (r + 10) * Math.cos(a) - 3, y: y + (r + 10) * Math.sin(a) - 7, width: 6, height: 14, rx: 2, fill: 'url(#jpChrome)',
          transform: `rotate(${deg + 90} ${x + (r + 10) * Math.cos(a)} ${y + (r + 10) * Math.sin(a)})`, class: 'claw' }, g);
      }
      el('circle', { cx: x, cy: y, r, fill: 'url(#jpReso)', class: 'reso' }, g);
      el('path', { d: `M${x - r * 0.72},${y - r * 0.42} A${r * 0.85},${r * 0.85} 0 0 1 ${x + r * 0.2},${y - r * 0.82}`, class: 'gloss' }, g);
      el('circle', { cx: x, cy: y, r: r * 0.46, class: 'k-ring' }, g);
      el('circle', { cx: x + r * 0.5, cy: y + r * 0.36, r: r * 0.12, class: 'port' }, g);
      const fl = el('circle', { cx: x, cy: y, r, fill: 'url(#jpHeadHit)', class: 'flash', filter: 'url(#jpGlow)' }, g);
      const rip = el('circle', { cx: x, cy: y, r: r * 0.8, class: 'ripple' }, g);
      const t = el('text', { x, y: y + 6, class: 'lbl kick-lbl' }, g);
      t.textContent = p.label;
      return { flash: fl, ripple: rip };
    }

    _cymbal(g, p, extraClass = '') {
      const { x, y, rx, ry } = p;
      const w = el('g', { class: 'wob ' + extraClass }, g);
      el('ellipse', { cx: x, cy: y, rx, ry, fill: 'url(#jpCym)', class: 'cymbody' }, w);
      for (let k = 0.97; k > 0.24; k -= 0.035) el('ellipse', { cx: x, cy: y, rx: rx * k, ry: ry * k, class: 'groove' }, w);
      // two soft light streaks across the metal
      for (const ang of [-28, 152]) {
        el('path', { d: `M${x},${y} L${x + rx * Math.cos((ang - 9) * Math.PI / 180)},${y + ry * Math.sin((ang - 9) * Math.PI / 180)} ` +
          `A${rx},${ry} 0 0 1 ${x + rx * Math.cos((ang + 9) * Math.PI / 180)},${y + ry * Math.sin((ang + 9) * Math.PI / 180)} Z`, class: 'sheen' }, w);
      }
      el('ellipse', { cx: x, cy: y, rx: rx * 0.23, ry: ry * 0.23, fill: 'url(#jpBell)', class: 'bell' }, w);
      el('ellipse', { cx: x - rx * 0.05, cy: y - ry * 0.07, rx: rx * 0.08, ry: ry * 0.06, class: 'bell-hi' }, w);
      el('ellipse', { cx: x, cy: y, rx: rx * 0.045, ry: ry * 0.06, class: 'nut' }, w);
      const fl = el('ellipse', { cx: x, cy: y, rx, ry, fill: 'url(#jpCymHit)', class: 'flash', filter: 'url(#jpGlow)' }, w);
      const t = el('text', { x, y: y + ry * 0.68, class: 'lbl cym-lbl' }, w);
      t.textContent = p.label;
      return { flash: fl, wob: w };
    }

    _buildDrums() {
      const W = 900, H = 440;
      const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'sim-svg sim-drums', role: 'img', 'aria-label': '鼓模擬器' }, this.stage);
      this.svg = svg;
      this._defs(svg);
      // stage: warm spotlight, soft beam, rug
      el('rect', { x: -900, y: 0, width: W + 1800, height: H, fill: 'url(#jpStage)' }, svg);  // wider than the view: no dark bars on wide screens
      el('path', { d: `M${W * 0.36},0 L${W * 0.64},0 L${W * 0.86},${H} L${W * 0.14},${H} Z`, fill: 'url(#jpBeam)' }, svg);
      el('ellipse', { cx: W / 2, cy: H - 26, rx: 440, ry: 74, fill: 'url(#jpRug)' }, svg);
      const used = new Set(this.events.flatMap(e => e.notes.map(n => n.piece)));
      // floor shadows
      for (const key of DRAW_ORDER) {
        const p = PIECES[key];
        const sx = p.x, sy = p.type === 'kick' ? p.y + p.r + 6 : (p.stand ? p.stand[1] : p.y + (p.h || 0) + 70);
        const srx = p.type === 'kick' ? p.r * 1.05 : (p.rx || 60) * 0.8;
        el('ellipse', { cx: sx, cy: Math.min(H - 6, sy), rx: srx, ry: 10, class: 'shadow', filter: 'url(#jpBlur6)' }, svg);
      }
      // stands, tom mounts
      for (const key of ['crash', 'ride', 'hihat']) {
        const p = PIECES[key];
        this._stand(svg, p.stand[0], p.y + (key === 'hihat' ? 8 : 0), p.stand[1]);
      }
      this._chromeTube(svg, PIECES.floor.x - 70, PIECES.floor.y + 70, PIECES.floor.x - 84, H - 4, 3.5);
      this._chromeTube(svg, PIECES.floor.x + 70, PIECES.floor.y + 70, PIECES.floor.x + 84, H - 4, 3.5);
      this._chromeTube(svg, PIECES.snare.x, PIECES.snare.y + 40, PIECES.snare.x, H - 12, 4);
      for (const dx of [-34, 34]) this._chromeTube(svg, PIECES.snare.x, H - 16, PIECES.snare.x + dx, H - 2, 3);
      for (const key of DRAW_ORDER) {
        const p = PIECES[key];
        const g = el('g', { class: `pc ${p.type} ${used.has(key) ? '' : 'unused'}` }, svg);
        let part;
        if (p.type === 'kick') {
          part = this._kick(g, p);
          // tom mount on top of the kick
          this._chromeTube(g, p.x, p.y - p.r - 10, PIECES.tom1.x + 30, PIECES.tom1.y + PIECES.tom1.h, 4);
          this._chromeTube(g, p.x, p.y - p.r - 10, PIECES.tom2.x - 30, PIECES.tom2.y + PIECES.tom2.h, 4);
        } else if (p.type === 'drum') {
          part = this._drum(g, p);
        } else if (p.type === 'hh') {
          this._chromeTube(g, p.x, p.y - 16, p.x, p.y + 12, 2.5);  // clutch rod
          el('ellipse', { cx: p.x, cy: p.y + 9, rx: p.rx, ry: p.ry, fill: 'url(#jpCym)', class: 'cymbody lower' }, g);
          const top = el('g', { class: 'hh-top' }, g);
          part = this._cymbal(top, p);
          part.top = top;
          part.openMark = el('text', { x: p.x, y: p.y - p.ry - 10, class: 'lbl open-mark' }, g);
          part.openMark.textContent = 'OPEN';
        } else {
          part = this._cymbal(g, p);
        }
        this.parts[key] = { g, p, lastHit: -1, ...part };
      }
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
        if ((this.chip === 'guitar' || this.chip === 'lead') && this.nStr === 6) {
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
      // restart the hit animation each time a piece is struck
      const latest = {};
      for (const e of win) {
        const dt = t - e.t0;
        if (dt < 0 || dt > 0.35 * rate) continue;
        for (const n of e.notes) {
          const cur = latest[n.piece];
          if (!cur || e.t0 > cur.t0) latest[n.piece] = { t0: e.t0, open: n.open };
        }
      }
      for (const [key, part] of Object.entries(this.parts)) {
        const hit = latest[key];
        if (hit && hit.t0 !== part.lastHit) {
          part.lastHit = hit.t0;
          part.g.classList.remove('hit');
          void part.g.getBoundingClientRect();   // restart CSS animation
          part.g.classList.add('hit');
          clearTimeout(part.timer);
          part.timer = setTimeout(() => part.g.classList.remove('hit'), HIT_MS);
          if (part.top) {
            part.open = !!hit.open;
            part.top.setAttribute('transform', hit.open ? 'translate(0 -12)' : '');
            if (part.openMark) part.openMark.classList.toggle('show', !!hit.open);
          }
        } else if (part.top && part.open && (!hit || t - part.lastHit > 0.45 * rate)) {
          part.open = false;
          part.top.setAttribute('transform', '');
          if (part.openMark) part.openMark.classList.remove('show');
        }
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

/* 執譜機 drum practice: rudiments, fills and grooves with notation, sticking,
   a drum kit that shows which hand plays what, a synth drum sound, metronome
   (click or spoken counts) and an automatic speed trainer. Runs fully in the
   browser; the server is only used for the spoken count samples. */
'use strict';
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const { LIB, CATS } = window.JPPracticeLib;

  const PIECE = {
    SN: { gm: 38, sim: 'snare', pan: -0.15 }, HH: { gm: 42, sim: 'hihat', pan: -0.45 },
    HO: { gm: 46, sim: 'hihat', open: true, pan: -0.45 }, HF: { gm: 44, sim: 'hihat', pan: -0.45 },
    RD: { gm: 51, sim: 'ride', pan: 0.45 }, CR: { gm: 49, sim: 'crash', pan: -0.35 },
    C2: { gm: 57, sim: 'crash2', pan: 0.25 }, T1: { gm: 50, sim: 'tom1', pan: -0.1 },
    T2: { gm: 47, sim: 'tom2', pan: 0.1 }, FT: { gm: 43, sim: 'floor', pan: 0.35 },
    K: { gm: 36, sim: 'kick', pan: 0 },
  };
  const FEET = new Set(['K', 'HF']);
  const PER = { 16: 4, 8: 2, t8: 3 };
  const prefs = {
    get(k, d) { try { const v = localStorage.getItem('jpPractice.' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
    set(k, v) { try { localStorage.setItem('jpPractice.' + k, JSON.stringify(v)); } catch { /* private mode */ } },
  };

  // ------------------------------------------------------------------ parsing
  function parseToken(tok, swap) {
    if (tok === '-' || !tok) return [];
    return tok.split('+').map(part => {
      const m = /^(R|L|K|HF)([>gfd]*)(?:@([A-Z0-9]+))?$/.exec(part);
      if (!m) throw new Error('bad slot ' + part);
      let [, who, arts, piece] = m;
      if (who === 'K' || who === 'HF') return { hand: who === 'K' ? 'K' : 'F', piece: who, art: '' };
      if (swap) who = who === 'R' ? 'L' : 'R';
      const art = arts.includes('f') ? 'flam' : arts.includes('d') ? 'drag' : arts.includes('>') ? 'accent' : arts.includes('g') ? 'ghost' : '';
      return { hand: who, piece: piece || 'SN', art };
    });
  }
  function parsePattern(p, swap) {
    const per = PER[p.grid];
    const bars = p.slots.split('|').map(b => b.trim().split(/\s+/).map(t => parseToken(t, swap)));
    for (const b of bars) if (b.length !== per * 4) console.warn('[practice]', p.id, 'bar has', b.length, 'slots, expected', per * 4);
    return { per, bars };
  }

  // ------------------------------------------------------------------ alphaTex
  const DUR16 = { 1: [':16', ''], 2: [':8', ''], 3: [':8', 'd'], 4: [':4', ''] };
  const DUR8 = { 1: [':8', ''], 2: [':4', ''] };
  function noteTex(n) {
    const fx = n.art === 'accent' ? '{ac}' : n.art === 'ghost' ? '{g}' : '';
    return PIECE[n.piece].gm + fx;
  }
  /** one voice of one bar -> alphaTex; sticking letters collected in order */
  function voiceTex(slots, per, feet, sticking) {
    const out = [];
    let curDur = null;
    const emit = (dur, body, beatFx) => {
      if (dur !== curDur) { out.push(dur); curDur = dur; }
      out.push(beatFx.length ? `${body}{${beatFx.join(' ')}}` : body);
    };
    for (let b = 0; b < 4; b++) {
      const beat = slots.slice(b * per, b * per + per).map(s => s.filter(n => FEET.has(n.piece) === feet));
      if (beat.every(s => !s.length)) { emit(':4', 'r', []); continue; }
      if (per === 3 && beat[0].length && !beat[1].length) {
        // "x - -" = a plain quarter note; "x - x" = triplet quarter + triplet 8th
        graces(beat[0], emit);
        if (!beat[2].length) emit(':4', chord(beat[0]), []);
        else emit(':4', chord(beat[0]), ['tu 3']);
        if (!feet) sticking.push(stickText(beat[0]));
        if (beat[2].length) {
          graces(beat[2], emit);
          emit(':8', chord(beat[2]), ['tu 3']);
          if (!feet) sticking.push(stickText(beat[2]));
        }
        continue;
      }
      if (per === 3) {
        for (const s of beat) {
          if (!s.length) { emit(':8', 'r', ['tu 3']); continue; }
          graces(s, emit);
          emit(':8', chord(s), ['tu 3']);
          if (!feet) sticking.push(stickText(s));
        }
        continue;
      }
      const table = per === 4 ? DUR16 : DUR8;
      let j = 0;
      while (j < per) {
        const s = beat[j];
        let len = 1;
        while (j + len < per && !beat[j + len].length) len++;
        if (!s.length) {
          // leading rest inside the beat (split 3 into 2 + 1 so it reads normally)
          if (len === 3) { emit(':8', 'r', []); emit(':16', 'r', []); } else { const [d] = table[len]; emit(d, 'r', []); }
        } else {
          const [d, dot] = table[len];
          graces(s, emit);
          emit(d, chord(s), dot ? [dot] : []);
          if (!feet) sticking.push(stickText(s));
        }
        j += len;
      }
    }
    return out.join(' ');
  }
  function chord(s) { return s.length === 1 ? `(${noteTex(s[0])})` : `(${s.map(noteTex).join(' ')})`; }
  function graces(s, emit) {
    const g = s.find(n => n.art === 'flam' || n.art === 'drag');
    if (!g) return;
    const k = g.art === 'drag' ? 2 : 1;
    for (let i = 0; i < k; i++) emit(':32', String(PIECE[g.piece].gm), ['gr']);
  }
  function stickText(s) {
    const hands = s.filter(n => n.hand === 'R' || n.hand === 'L');
    if (!hands.length) return s.some(n => n.piece === 'K') ? 'K' : '';
    const n = hands[0];
    const other = n.hand === 'R' ? 'l' : 'r';
    const pre = n.art === 'flam' ? other : n.art === 'drag' ? other + other : '';
    return hands.length > 1 ? hands.map(h => h.hand).join('') : pre + n.hand;
  }
  function toTex(p, parsed) {
    const sticking = [];
    const hands = parsed.bars.map(b => voiceTex(b, parsed.per, false, sticking)).join(' | ');
    const hasFeet = parsed.bars.some(b => b.some(s => s.some(n => FEET.has(n.piece))));
    const feet = hasFeet ? parsed.bars.map(b => voiceTex(b, parsed.per, true, [])).join(' | ') : null;
    const tex = `\\tempo 60\n\\track "Drums"\n\\instrument percussion\n\\clef neutral\n\\ts (4 4)\n` +
      (feet ? `\\voice\n${hands}\n\\voice\n${feet}` : hands);
    return { tex, sticking };
  }

  // ------------------------------------------------------------------ events
  /** pattern -> hits with beat positions (one loop) */
  function patternHits(parsed) {
    const hits = [];
    parsed.bars.forEach((bar, bi) => bar.forEach((slot, si) => {
      const beat = bi * 4 + si / parsed.per;
      for (const n of slot) hits.push({ beat, ...n });
    }));
    return hits;
  }

  // ------------------------------------------------------------------ sound
  class DrumSynth {
    constructor() {
      this.ctx = null;
    }
    ensure() {
      if (this.ctx) return this.ctx;
      const Ctx = window.AudioContext || window.webkitAudioContext;
      this.ctx = new Ctx();
      this.out = this.ctx.createGain();
      this.out.gain.value = 0.8;
      const comp = this.ctx.createDynamicsCompressor();
      comp.threshold.value = -12; comp.ratio.value = 3;
      this.out.connect(comp).connect(this.ctx.destination);
      this.metroOut = this.ctx.createGain();
      this.metroOut.connect(this.ctx.destination);
      const len = this.ctx.sampleRate * 2;
      this.noise = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noise.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
      return this.ctx;
    }
    _env(t, peak, decay, node) {
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.linearRampToValueAtTime(peak, t + 0.002);
      g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
      node.connect(g);
      return g;
    }
    _noise(t, dur) {
      const s = this.ctx.createBufferSource();
      s.buffer = this.noise;
      s.start(t, Math.random() * 1.5, dur + 0.05);
      return s;
    }
    _filter(type, f, q = 0.7) {
      const b = this.ctx.createBiquadFilter();
      b.type = type; b.frequency.value = f; b.Q.value = q;
      return b;
    }
    _pan(node, p) {
      if (!this.ctx.createStereoPanner) { node.connect(this.out); return; }
      const pn = this.ctx.createStereoPanner();
      pn.pan.value = p;
      node.connect(pn).connect(this.out);
    }
    hit(piece, t, v = 0.8) {
      const ctx = this.ensure();
      const P = PIECE[piece];
      const pan = P ? P.pan : 0;
      if (piece === 'K') {
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(45, t + 0.12);
        o.start(t); o.stop(t + 0.4);
        this._pan(this._env(t, 1.1 * v, 0.35, o), 0);
        const c = this._noise(t, 0.02);
        this._pan(this._env(t, 0.25 * v, 0.02, c.connect(this._filter('highpass', 2500))), 0);
      } else if (piece === 'SN') {
        const n = this._noise(t, 0.22);
        this._pan(this._env(t, 0.7 * v, 0.18, n.connect(this._filter('highpass', 1200))), pan);
        const o = ctx.createOscillator(); o.type = 'triangle';
        o.frequency.setValueAtTime(220, t); o.frequency.exponentialRampToValueAtTime(170, t + 0.08);
        o.start(t); o.stop(t + 0.15);
        this._pan(this._env(t, 0.55 * v, 0.09, o), pan);
      } else if (piece === 'HH' || piece === 'HO' || piece === 'HF') {
        const dec = piece === 'HO' ? 0.4 : piece === 'HF' ? 0.05 : 0.06;
        const n = this._noise(t, dec);
        const f = n.connect(this._filter('highpass', 7000)).connect(this._filter('peaking', 10000, 1));
        this._pan(this._env(t, (piece === 'HF' ? 0.25 : 0.4) * v, dec, f), pan);
      } else if (piece === 'CR' || piece === 'C2') {
        const dec = piece === 'CR' ? 1.6 : 1.2;
        const n = this._noise(t, dec);
        this._pan(this._env(t, 0.42 * v, dec, n.connect(this._filter('highpass', piece === 'CR' ? 3500 : 4500))), pan);
      } else if (piece === 'RD') {
        const n = this._noise(t, 0.6);
        this._pan(this._env(t, 0.16 * v, 0.6, n.connect(this._filter('bandpass', 7000, 0.8))), pan);
        const o = ctx.createOscillator(); o.type = 'sine'; o.frequency.value = 3600;
        o.start(t); o.stop(t + 0.35);
        this._pan(this._env(t, 0.12 * v, 0.3, o), pan);
      } else {   // toms
        const f0 = { T1: 230, T2: 170, FT: 110 }[piece] || 160;
        const o = ctx.createOscillator();
        o.frequency.setValueAtTime(f0 * 1.5, t); o.frequency.exponentialRampToValueAtTime(f0, t + 0.04);
        o.frequency.exponentialRampToValueAtTime(f0 * 0.8, t + 0.4);
        o.start(t); o.stop(t + 0.5);
        this._pan(this._env(t, 0.9 * v, 0.45, o), pan);
        const n = this._noise(t, 0.05);
        this._pan(this._env(t, 0.2 * v, 0.05, n.connect(this._filter('bandpass', f0 * 4, 1))), pan);
      }
    }
    click(t, accent, v = 1) {
      const ctx = this.ensure();
      const o = ctx.createOscillator();
      o.frequency.value = accent ? 1760 : 1175;
      o.start(t); o.stop(t + 0.05);
      const g = this._env(t, (accent ? 0.5 : 0.32) * v, 0.04, o);
      g.connect(this.metroOut);
    }
    sample(buf, t, gain = 0.9) {
      const ctx = this.ensure();
      const s = ctx.createBufferSource();
      s.buffer = buf;
      const g = ctx.createGain(); g.gain.value = gain;
      s.connect(g).connect(this.metroOut);
      s.start(t);
    }
  }

  // ------------------------------------------------------------------ spoken counts
  const VOICE_WORDS = ['one', 'two', 'three', 'four', 'and', 'e', 'a'];
  const voices = { state: 'idle', buf: {} };
  async function loadVoices(synth) {
    if (voices.state !== 'idle') return;
    voices.state = 'loading';
    try {
      const ctx = synth.ensure();
      await Promise.all(VOICE_WORDS.map(async w => {
        const r = await fetch(`/api/voice/${w}.wav`);
        if (!r.ok) throw new Error(w);
        voices.buf[w] = await ctx.decodeAudioData(await r.arrayBuffer());
      }));
      voices.state = 'ready';
    } catch (e) {
      voices.state = 'failed';
      toast('部電腦整唔到讀拍嘅聲，用返滴答聲');
    }
  }

  // ------------------------------------------------------------------ state
  const P = {
    pat: null, parsed: null, hits: [], loopBeats: 4, swap: prefs.get('swap', false),
    bpm: 80, playing: false, metro: prefs.get('metro', 'click'), countIn: prefs.get('countIn', true),
    trainer: prefs.get('trainer', false), trStep: prefs.get('trStep', 5), trEvery: prefs.get('trEvery', 4), trMax: prefs.get('trMax', 160),
    sound: prefs.get('sound', true), at: null, sticking: [],
    // clock: beat position = anchorBeat + (ctxTime - anchorTime) * bpm / 60
    anchorTime: 0, anchorBeat: 0, schedStep: 0, byStep: new Map(), timer: null, loopsDone: 0,
  };
  const synth = new DrumSynth();
  const sim = new window.JPSimulator($('#pSim'));

  function toast(msg, ms = 3000) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => { t.hidden = true; }, ms);
  }

  // ------------------------------------------------------------------ library UI
  function buildList() {
    const nav = $('#pList');
    const sel = $('#pSelect');
    let h = '', o = '';
    for (const c of CATS) {
      h += `<div class="p-cat">${c.name}</div>`;
      o += `<optgroup label="${c.name}">`;
      for (const p of LIB.filter(x => x.cat === c.id)) {
        h += `<button type="button" class="p-item" data-id="${p.id}">${p.name}</button>`;
        o += `<option value="${p.id}">${p.name}</option>`;
      }
      o += '</optgroup>';
    }
    nav.innerHTML = h;
    sel.innerHTML = o;
    nav.addEventListener('click', e => { const b = e.target.closest('.p-item'); if (b) choose(b.dataset.id); });
    sel.addEventListener('change', () => choose(sel.value));
  }

  function choose(id) {
    const p = LIB.find(x => x.id === id) || LIB[0];
    const wasPlaying = P.playing;
    if (wasPlaying) stop();
    P.pat = p;
    prefs.set('last', p.id);
    location.hash = '#' + p.id;
    for (const b of document.querySelectorAll('.p-item')) b.setAttribute('aria-current', b.dataset.id === p.id ? 'true' : 'false');
    $('#pSelect').value = p.id;
    $('#pName').textContent = p.name;
    $('#pTip').textContent = p.tip || '';
    $('#pGrid').textContent = { 16: '16 分音符', 8: '8 分音符', t8: '三連音' }[p.grid];
    const saved = prefs.get('bpm:' + p.id, null);
    setBpm(saved || p.bpm, false);
    $('#pSwapBox').hidden = !p.sticking;
    build();
    if (wasPlaying) start();
  }

  function build() {
    const p = P.pat;
    P.parsed = parsePattern(p, P.swap && p.sticking);
    P.hits = patternHits(P.parsed);
    P.loopBeats = P.parsed.bars.length * 4;
    const { tex, sticking } = toTex(p, P.parsed);
    P.sticking = p.sticking ? sticking : [];
    renderScore(tex);
    sim.twoCrash = P.hits.some(h => h.piece === 'C2');
    sim.setDrumEvents(simEvents(0, 1));
    sim.render(-1, 1);
  }

  /** simulator events for loops [from, from + count) */
  function simEvents(fromLoop, count) {
    const ev = [];
    for (let L = fromLoop; L < fromLoop + count; L++) {
      const groups = new Map();
      for (const h of P.hits) {
        const t = L * P.loopBeats + h.beat;
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t).push({ piece: PIECE[h.piece].sim, open: !!PIECE[h.piece].open, hand: h.hand === 'R' || h.hand === 'L' ? h.hand : null });
      }
      for (const [t, notes] of groups) ev.push({ t0: t, t1: t + 0.25, notes });
    }
    return ev;
  }

  // ------------------------------------------------------------------ notation
  async function renderScore(tex) {
    await window.alphaTabReady;
    const el = $('#pScore');
    if (!P.at) {
      P.at = new alphaTab.AlphaTabApi(el, {
        core: { fontDirectory: window.ALPHATAB_BASE + 'font/', engine: 'svg', useWorkers: false, logLevel: 'warning' },
        display: { scale: 1.1, layoutMode: alphaTab.LayoutMode.Page, barsPerRow: 2,
          resources: { secondaryGlyphColor: '#000000' } },
        notation: { elements: { effectDynamics: false, scoreTitle: false, scoreWordsAndMusic: false, effectTempo: false, trackNames: false } },
      });
      P.at.error.on(e => { console.error(e); $('#pScoreErr').hidden = false; $('#pScoreErr').textContent = '譜畫唔到：' + (e && e.message || e); });
      P.at.scoreLoaded.on(score => {
        // sticking (R / L) under the notes
        let i = 0;
        const st = score.tracks[0].staves[0];
        for (const bar of st.bars) {
          const v = bar.voices[0];
          for (const bt of v.beats) {
            if (bt.isRest || bt.graceType) continue;
            const s = P.sticking[i++];
            bt.lyrics = s ? [s] : null;
          }
        }
        // the feet voice only shows its hits (no rests above / below the staff)
        for (const bar of st.bars) {
          const v = bar.voices[1];
          if (v) for (const bt of v.beats) if (bt.isRest) bt.isEmpty = true;
        }
        $('#pScoreErr').hidden = true;
      });
      P.at.postRenderFinished.on(buildPlayheadMap);
    }
    P.at.tex(tex);
  }

  /* playhead: anchored at every beat, gliding at an even speed in between */
  const ph = { el: null, map: null, lastX: -1, lastY: -1 };
  function buildPlayheadMap() {
    const bl = P.at && P.at.boundsLookup;
    const score = P.at && P.at.score;
    ph.map = null;
    if (!bl || !score) return;
    const map = [];
    for (let i = 0; i < score.masterBars.length; i++) {
      const mb = bl.findMasterBarByIndex(i);
      if (!mb) { map.push(null); continue; }
      const pts = new Map();
      for (const bar of mb.bars) for (const b of bar.beats) {
        if (b.beat.graceType) continue;
        const tk = b.beat.playbackStart;
        if (!pts.has(tk) || b.onNotesX < pts.get(tk)) pts.set(tk, b.onNotesX);
      }
      const arr = [...pts].sort((a, b) => a[0] - b[0]);
      const vb = mb.visualBounds;
      arr.push([3840, vb.x + vb.w - 3]);
      if (arr[0][0] > 0) arr.unshift([0, arr[0][1]]);
      const xAt = tk => {
        let k = 0;
        while (k < arr.length - 2 && arr[k + 1][0] <= tk) k++;
        const [t0, x0] = arr[k], [t1, x1] = arr[k + 1];
        return t1 > t0 ? x0 + (x1 - x0) * Math.min(1, Math.max(0, (tk - t0) / (t1 - t0))) : x0;
      };
      const xs = [];
      for (let k = 0; k <= 4; k++) xs.push(xAt(k * 960));
      map.push({ xs, y: vb.y, h: vb.h });
    }
    ph.map = map;
    ph.lastX = -1;
  }
  function placePlayhead(beatPos) {
    if (!ph.map) return;
    if (!ph.el || !ph.el.isConnected) {
      ph.el = document.createElement('div');
      ph.el.className = 'jp-playhead';
      $('#pScore').appendChild(ph.el);
    }
    if (beatPos < 0 || !P.playing) { ph.el.style.opacity = 0; ph.lastX = -1; return; }
    const pos = beatPos % P.loopBeats;
    const bar = Math.floor(pos / 4), k = Math.floor(pos - bar * 4), frac = pos - bar * 4 - k;
    const row = ph.map[bar];
    if (!row) return;
    const x = row.xs[k] + (row.xs[k + 1] - row.xs[k]) * frac;
    if (Math.abs(x - ph.lastX) < 0.2 && row.y === ph.lastY) return;
    ph.lastX = x; ph.lastY = row.y;
    ph.el.style.opacity = 1;
    ph.el.style.height = row.h + 'px';
    ph.el.style.transform = `translate(${x - 1.5}px, ${row.y}px)`;
  }

  // ------------------------------------------------------------------ transport
  function beatNow() {
    if (!P.playing) return -1;
    return P.anchorBeat + (synth.ctx.currentTime - P.anchorTime) * P.bpm / 60;
  }
  function timeOfBeat(b) { return P.anchorTime + (b - P.anchorBeat) * 60 / P.bpm; }

  function setBpm(v, save = true) {
    v = Math.round(Math.max(30, Math.min(260, v)));
    if (P.playing) {           // keep the beat position continuous
      const b = beatNow();
      P.anchorBeat = b; P.anchorTime = synth.ctx.currentTime;
    }
    P.bpm = v;
    $('#pBpm').textContent = v;
    $('#pBpmRange').value = v;
    if (save && P.pat) prefs.set('bpm:' + P.pat.id, v);
  }

  function start() {
    const ctx = synth.ensure();
    if (ctx.state === 'suspended') ctx.resume();
    if (P.metro !== 'click' && P.metro !== 'off') loadVoices(synth);
    P.playing = true;
    const lead = P.countIn ? 4 : 0;
    P.anchorTime = ctx.currentTime + 0.12;
    P.anchorBeat = -lead;
    P.schedStep = -lead * res();
    P.byStep = hitsByStep();
    P.loopsDone = 0;
    P.simFrom = 0;
    $('#pLoops').textContent = '第 1 次';
    sim.setDrumEvents(simEvents(0, 64));
    $('#pPlay').textContent = '⏸ 停';
    $('#pPlay').classList.add('playing');
    tick();
    P.timer = setInterval(tick, 25);
  }
  function stop() {
    P.playing = false;
    clearInterval(P.timer);
    $('#pPlay').textContent = '▶ 開始';
    $('#pPlay').classList.remove('playing');
    $('#pCount').textContent = '';
    $('#pLoops').textContent = '';
  }

  const VEL = { accent: 1, ghost: 0.22, '': 0.72, flam: 0.85, drag: 0.8 };
  // the scheduler walks a grid of 16ths (or triplets for triplet patterns)
  const res = () => (P.parsed.per === 3 ? 3 : 4);
  function hitsByStep() {
    const r = res(), m = new Map();
    for (const h of P.hits) {
      const k = Math.round(h.beat * r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(h);
    }
    return m;
  }
  function tick() {
    if (!P.playing) return;
    const ctx = synth.ctx;
    const r = res();
    const horizon = beatNow() + 0.15 * P.bpm / 60;
    const loopSteps = P.loopBeats * r;
    while (P.schedStep / r < horizon) {
      const st = P.schedStep;
      const b = st / r;
      scheduleMetro(b, st, r);
      if (st >= 0) {
        const L = Math.floor(st / loopSteps);
        if (L > P.loopsDone) loopDone(L);
        const t = timeOfBeat(b);
        const hs = P.sound ? P.byStep.get(st - L * loopSteps) : null;
        if (hs && t >= ctx.currentTime - 0.01) {
          for (const h of hs) {
            const v = VEL[h.art] ?? 0.72;
            if (h.art === 'flam' || h.art === 'drag') {
              const n = h.art === 'drag' ? 2 : 1;
              for (let i = n; i >= 1; i--) synth.hit(h.piece, t - (n === 2 ? 0.024 : 0.032) * i, 0.28);
            }
            synth.hit(h.piece, t, v);
          }
        }
      }
      P.schedStep++;
    }
  }

  function scheduleMetro(b, st, r) {
    if (P.metro === 'off') return;
    const t = timeOfBeat(b);
    if (t < synth.ctx.currentTime - 0.01) return;
    const inBar = ((st % (4 * r)) + 4 * r) % (4 * r);
    const beatIdx = Math.floor(inBar / r);
    const sub = inBar % r;
    const counting = b < 0;
    const word = wordFor(beatIdx, sub, r, counting);
    const wantVoice = P.metro !== 'click' && voices.state === 'ready';
    if (word && wantVoice) synth.sample(voices.buf[word], t, sub === 0 ? 1 : 0.75);
    else if (sub === 0) synth.click(t, beatIdx === 0);
    if (sub === 0 || (word && wantVoice)) {
      const label = word && wantVoice ? ({ one: '1', two: '2', three: '3', four: '4', and: '&', e: 'e', a: 'a' }[word]) : String(beatIdx + 1);
      const delay = Math.max(0, (t - synth.ctx.currentTime) * 1000);
      setTimeout(() => {
        if (!P.playing) return;
        $('#pCount').textContent = (counting ? '預備 ' : '') + label;
        $('#pCount').classList.toggle('pre', counting);
      }, delay);
    }
  }
  function wordFor(beatIdx, sub, r, countIn) {
    if (P.metro === 'click' || P.metro === 'off') return null;
    if (sub === 0) return ['one', 'two', 'three', 'four'][beatIdx];
    if (countIn || r !== 4) return null;
    if (P.metro === 'eighths') return sub === 2 ? 'and' : null;
    if (P.metro === 'sixteen') return ['', 'e', 'and', 'a'][sub];
    return null;
  }

  function loopDone(L) {
    P.loopsDone = L;
    $('#pLoops').textContent = `第 ${L + 1} 次`;
    if (L + 8 > P.simFrom + 64) { P.simFrom = L; sim.setDrumEvents(simEvents(L, 64)); }
    if (P.trainer && L > 0 && L % P.trEvery === 0 && P.bpm < P.trMax) {
      setBpm(Math.min(P.trMax, P.bpm + P.trStep), false);
      toast(`加速：${P.bpm} BPM`, 1500);
    }
  }

  // ------------------------------------------------------------------ frame loop
  (function frame() {
    const b = beatNow();
    placePlayhead(b);
    if (!$('#pSim').hidden) sim.render(P.playing ? b : -1000, P.bpm / 60);
    requestAnimationFrame(frame);
  })();

  // ------------------------------------------------------------------ controls
  function wire() {
    $('#pPlay').onclick = () => (P.playing ? stop() : start());
    document.addEventListener('keydown', e => {
      if (e.target.closest('input, select, textarea')) return;
      if (e.code === 'Space') { e.preventDefault(); P.playing ? stop() : start(); }
      if (e.key === '[') setBpm(P.bpm - 1);
      if (e.key === ']') setBpm(P.bpm + 1);
    });
    for (const b of document.querySelectorAll('[data-bpm]')) b.onclick = () => setBpm(P.bpm + Number(b.dataset.bpm));
    $('#pBpmRange').oninput = e => setBpm(Number(e.target.value));
    const metro = $('#pMetro');
    metro.value = P.metro;
    metro.onchange = () => { P.metro = metro.value; prefs.set('metro', P.metro); if (P.metro !== 'click' && P.metro !== 'off') loadVoices(synth); };
    const ci = $('#pCountIn');
    ci.checked = P.countIn;
    ci.onchange = () => { P.countIn = ci.checked; prefs.set('countIn', P.countIn); };
    const snd = $('#pSound');
    snd.checked = P.sound;
    snd.onchange = () => { P.sound = snd.checked; prefs.set('sound', P.sound); };
    const sw = $('#pSwap');
    sw.checked = P.swap;
    sw.onchange = () => { P.swap = sw.checked; prefs.set('swap', P.swap); const pl = P.playing; if (pl) stop(); build(); if (pl) start(); };
    const tr = $('#pTrainer');
    tr.checked = P.trainer;
    $('#pTrainerOpts').hidden = !P.trainer;
    tr.onchange = () => { P.trainer = tr.checked; prefs.set('trainer', P.trainer); $('#pTrainerOpts').hidden = !P.trainer; };
    $('#pTrStep').value = P.trStep;
    $('#pTrEvery').value = P.trEvery;
    $('#pTrMax').value = P.trMax;
    $('#pTrStep').onchange = e => { P.trStep = Number(e.target.value); prefs.set('trStep', P.trStep); };
    $('#pTrEvery').onchange = e => { P.trEvery = Number(e.target.value); prefs.set('trEvery', P.trEvery); };
    $('#pTrMax').onchange = e => { P.trMax = Number(e.target.value) || 160; prefs.set('trMax', P.trMax); };
    const simOn = $('#pSimOn');
    simOn.checked = prefs.get('sim', true);
    $('#pSim').hidden = !simOn.checked;
    simOn.onchange = () => { $('#pSim').hidden = !simOn.checked; prefs.set('sim', simOn.checked); };
  }

  buildList();
  wire();
  const first = (location.hash || '').slice(1) || prefs.get('last', LIB[0].id);
  choose(LIB.some(p => p.id === first) ? first : LIB[0].id);

  window.addEventListener('hashchange', () => {
    const id = location.hash.slice(1);
    if (id && (!P.pat || P.pat.id !== id) && LIB.some(p => p.id === id)) choose(id);
  });

  window.JPPractice = { P, parsePattern, toTex, LIB };
})();

/* 執譜機 bar editor: fix what the transcription got wrong, one bar at a time.
   Drums: step grid (rows = kit pieces). Other instruments: piano roll.
   Chords: one box per beat. Edits are saved to the event lists on the server,
   which rebuilds the score - so notation, simulator and PDF all stay in sync. */
'use strict';
(function () {
  const $ = (s, el = document) => el.querySelector(s);
  const DRUM_ROWS_ALL = [
    { note: 49, label: 'Crash', key: 'CR' }, { note: 57, label: 'Crash 2', key: 'C2' }, { note: 51, label: 'Ride', key: 'RD' },
    { note: 46, label: 'HH 開', key: 'HO' },
    { note: 42, label: 'Hi-hat', key: 'HH' }, { note: 50, label: 'Tom 1', key: 'T1' }, { note: 47, label: 'Tom 2', key: 'T2' },
    { note: 43, label: 'Floor', key: 'FT' }, { note: 38, label: 'Snare', key: 'SN' }, { note: 36, label: 'Kick', key: 'K' },
  ];
  const crashMode = () => ((S.meta && S.meta.scoreOptions) || {}).crashes || 'auto';
  const DRUM_ROWS_FN = () => DRUM_ROWS_ALL.filter(r => r.note !== 57 || crashMode() !== '1');
  const ROW_BY_KEY = Object.fromEntries(DRUM_ROWS_ALL.map(r => [r.key, r.note]));
  // how a hit is played: shown in the cell, written into the score
  const ARTS = [
    { id: '', label: '普通', mark: '' },
    { id: 'ghost', label: 'Ghost（細聲）', mark: '( )' },
    { id: 'accent', label: '重音 >', mark: '>' },
    { id: 'flam', label: 'Flam（兩支棍差少少）', mark: 'fl' },
    { id: 'drag', label: 'Drag（前面兩下細聲）', mark: 'dr' },
  ];
  const ART_MARK = Object.fromEntries(ARTS.map(a => [a.id, a.mark]));
  const PAT_ART = { x: '', o: '', g: 'ghost', '>': 'accent', f: 'flam', d: 'drag' };

  /* Common patterns. Each row is one bar of 4 beats: 4 characters per beat
     (16ths) or 3 (triplets). x = hit, o = open hi-hat, g = ghost, > = accent,
     f = flam, d = drag, - = nothing. Fills replace the last `span` beats. */
  const PATTERNS = [
    { group: '節奏', id: 'rock8', label: 'Rock 8 分', rows: { HH: 'x-x-x-x-x-x-x-x-', SN: '----x-------x---', K: 'x-------x-x-----' } },
    { group: '節奏', id: 'rock16', label: 'Rock 16 分 hi-hat', rows: { HH: 'xxxxxxxxxxxxxxxx', SN: '----x-------x---', K: 'x-----x-x-------' } },
    { group: '節奏', id: 'ballad', label: '慢歌（4 分 hi-hat）', rows: { HH: 'x---x---x---x---', SN: '----x-------x---', K: 'x-------x-------' } },
    { group: '節奏', id: 'half', label: 'Half-time（第 3 拍 snare）', rows: { HH: 'x-x-x-x-x-x-x-x-', SN: '--------x-------', K: 'x-----x-----x---' } },
    { group: '節奏', id: 'disco', label: 'Disco（開 hi-hat 喺 &）', rows: { HH: 'x---x---x---x---', HO: '--x---x---x---x-', SN: '----x-------x---', K: 'x---x---x---x---' } },
    { group: '節奏', id: 'four', label: 'Four on the floor', rows: { HH: '--x---x---x---x-', SN: '----x-------x---', K: 'x---x---x---x---' } },
    { group: '節奏', id: 'funk', label: 'Funk（有 ghost note）', rows: { HH: 'x-x-x-x-x-x-x-x-', SN: '-g--x--g-g--x--g', K: 'x-x----x--x-----' } },
    { group: '節奏', id: 'ride', label: 'Ride 8 分', rows: { RD: 'x-x-x-x-x-x-x-x-', SN: '----x-------x---', K: 'x-------x-x-----' } },
    { group: '節奏', id: 'shuffle', label: 'Shuffle（要 3 格）', sub: 3, rows: { HH: 'x-xx-xx-xx-x', SN: '---x-----x--', K: 'x-----x-----' } },
    { group: '過門', id: 'sn1', label: '16 分 snare（最後一拍）', span: 1, rows: { SN: 'xxxx' } },
    { group: '過門', id: 'sn2', label: '16 分 snare（最後兩拍）', span: 2, rows: { SN: 'xxxxxxxx' } },
    { group: '過門', id: 'down2', label: '落 tom 16 分（最後兩拍）', span: 2, rows: { SN: 'xx------', T1: '--xx----', T2: '----xx--', FT: '------xx' } },
    { group: '過門', id: 'down4', label: '落 tom 16 分（成小節）', span: 4, rows: { SN: 'xxxx------------', T1: '----xxxx--------', T2: '--------xxxx----', FT: '------------xxxx', K: 'x---x---x---x---' } },
    { group: '過門', id: 'tom8', label: '8 分 tom（最後兩拍）', span: 2, rows: { SN: 'x-x-----', T1: '----x---', FT: '------x-' } },
    { group: '過門', id: 'flam2', label: 'Flam 落 tom（最後兩拍）', span: 2, rows: { SN: 'f-------', T1: '--f-----', T2: '----f---', FT: '------f-' } },
    { group: '過門', id: 'accent2', label: '重音 snare（最後兩拍）', span: 2, rows: { SN: '>xx>xx>x' } },
    { group: '過門', id: 'trip2', label: '三連音落 tom（最後兩拍，要 3 格）', span: 2, sub: 3, rows: { SN: 'xxx---', T1: '---x--', FT: '----xx' } },
    { group: '過門', id: 'trip4', label: '三連音 snare（最後一拍，要 3 格）', span: 1, sub: 3, rows: { SN: 'xxx' } },
    { group: '加', id: 'crash1', label: '第 1 拍加 Crash + Kick', crash: true },
  ];
  const DRUM_ROWS = DRUM_ROWS_ALL;   // (all rows, for lookups)
  const STRUM_ROWS = [{ note: 0, label: '掃弦 / 撥弦' }];
  // strums weaker than this are not on the chart (same thresholds as backend/guitar.py)
  const STRUM_MIN = { low: 0.42, mid: 0.28, high: 0.16 };
  const isGrid = () => E.target === 'drums' || E.target === 'strums';
  const gridRows = () => (E.target === 'drums' ? DRUM_ROWS_FN() : STRUM_ROWS);
  const gridEvents = () => (E.target === 'drums'
    ? E.data.drums
    : (E.data.strums || []).filter(d => d.s >= (STRUM_MIN[(S.meta?.scoreOptions || {}).guitarSens || 'mid'] ?? 0.28)).map(d => ({ time: d.time, note: 0, vel: 100 })));
  const TARGET_LABEL = { strums: '結他 Chord（掃弦）', guitar_lead: '結他 Solo', piano: '琴', drums: '鼓', vocals: '人聲旋律', bass: 'Bass', other: '其他' };
  const DRUM_ALIAS = { 35: 36, 37: 38, 40: 38, 44: 42, 52: 49, 55: 49, 53: 51, 59: 51, 48: 50, 45: 47, 41: 43 };
  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const FLAT_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'Gb', 'G', 'Ab', 'A', 'Bb', 'B'];
  const FLAT_KEYS = ['F', 'Bb', 'Eb', 'Ab', 'Db', 'Gb'];
  const noteName = p => (FLAT_KEYS.includes(S.key) ? FLAT_NAMES : NOTE_NAMES)[p % 12] + (Math.floor(p / 12) - 1);
  const isBlack = p => [1, 3, 6, 8, 10].includes(p % 12);
  const SUB_LABELS = { 4: ['', 'e', '&', 'a'], 3: ['', 'trip', 'let'] };

  const E = {
    bar: 0, sub: 4, target: 'drums', data: null, cells: null, notes: [], chordsIn: [],
    lenSlots: 2, lo: 48, hi: 72, dirty: false, chordDirty: false, art: '',
  };

  // ------------------------------------------------------------------ geometry
  function N() { return S.timing.beatsPerBar; }
  function nBars() { return S.timing.nBars; }
  function beatTime(k) {
    const b = S.timing.beats;
    if (k < b.length) return b[k].time;
    const last = b[b.length - 1];
    return k === b.length ? S.timing.endTime : last.time + (k - b.length + 1) * (60 / S.timing.bpm);
  }
  function slotTime(bar, slot, sub = E.sub) {
    const k = bar * N() + Math.floor(slot / sub);
    const j = slot % sub;
    const a = beatTime(k), b = beatTime(k + 1);
    return a + (j / sub) * (b - a);
  }
  function barRange(bar, sub = E.sub) {
    const firstHalf = (beatTime(bar * N() + 1) - beatTime(bar * N())) / (2 * sub);
    const lastHalf = (beatTime((bar + 1) * N()) - beatTime((bar + 1) * N() - 1)) / (2 * sub);
    return [beatTime(bar * N()) - firstHalf, beatTime((bar + 1) * N()) - lastHalf];
  }
  /** time -> slot index inside the bar (may be <0 or >= N*sub if outside) */
  function toSlot(bar, t, sub = E.sub) {
    const k0 = bar * N();
    let k = k0;
    while (k < k0 + N() && beatTime(k + 1) <= t) k++;
    if (t < beatTime(k0)) k = k0;
    const a = beatTime(k), b = beatTime(k + 1);
    const frac = (t - a) / (b - a);
    return (k - k0) * sub + Math.round(frac * sub);
  }
  function guessSub(bar, times) {
    let trip = 0, straight = 0;
    for (const t of times) {
      const k = Math.floor(JP.timeToBeatPos(S.timing, t));
      const frac = JP.timeToBeatPos(S.timing, t) - k;
      const e3 = Math.abs(frac * 3 - Math.round(frac * 3)), e4 = Math.abs(frac * 4 - Math.round(frac * 4));
      if (e3 < 0.12 && e4 > 0.2) trip++; else straight++;
    }
    return trip > straight * 0.6 && trip >= 2 ? 3 : 4;
  }

  // ------------------------------------------------------------------ data
  async function loadData() {
    const [drums, notes, strums] = await Promise.all([
      api(`/api/jobs/${S.jobId}/file/drums.json`).catch(() => []),
      api(`/api/jobs/${S.jobId}/file/notes.json`).catch(() => ({})),
      api(`/api/jobs/${S.jobId}/file/strums.json`).catch(() => []),
    ]);
    E.data = { drums, notes, strums };
  }
  function pitchedFor(target) {
    const n = E.data.notes || {};
    return target === 'piano' ? [...(n.piano_rh || []), ...(n.piano_lh || [])] : (n[target] || []);
  }

  function buildModel(keepSub) {
    const [t0, t1] = barRange(E.bar, 4);
    const slots = N() * E.sub;
    if (isGrid()) {
      const all = gridEvents();
      const evs = all.filter(d => d.time >= t0 - 0.05 && d.time < t1 + 0.05);
      if (!keepSub) E.sub = guessSub(E.bar, evs.map(d => d.time));
      const [a, b] = barRange(E.bar);
      E.cells = new Map();
      for (const d of all) {
        if (d.time < a || d.time >= b) continue;
        const s = Math.min(slots - 1, Math.max(0, toSlot(E.bar, d.time)));
        let note = DRUM_ALIAS[d.note] || d.note;
        // crash 2: shown as crash 1 unless the kit has two (see 譜設定)
        if (note === 57 && (crashMode() === '1' || (crashMode() === 'auto' && d.how === 'hand'))) note = 49;
        E.cells.set(`${note}:${s}`, { vel: d.vel || 100, art: d.art || '' });
      }
    } else {
      const all = pitchedFor(E.target);
      const evs = all.filter(n => n.start >= t0 - 0.05 && n.start < t1 + 0.05);
      if (!keepSub) E.sub = guessSub(E.bar, evs.map(n => n.start));
      const [a, b] = barRange(E.bar);
      const slotDur = (beatTime((E.bar + 1) * N()) - beatTime(E.bar * N())) / slots;
      E.notes = all.filter(n => n.start >= a && n.start < b).map(n => {
        const s = Math.min(slots - 1, Math.max(0, toSlot(E.bar, n.start)));
        const len = Math.max(1, Math.round((n.end - n.start) / slotDur));
        return { pitch: n.pitch, s, len: Math.min(len, slots - s), origEnd: n.end, origLen: len, vel: n.vel || 90 };
      });
      const ps = E.notes.map(n => n.pitch);
      const centre = ps.length ? Math.round((Math.min(...ps) + Math.max(...ps)) / 2) : ({ bass: 40, guitar: 59, guitar_lead: 67, piano: 60, vocals: 64, other: 64 }[E.target] || 60);
      let lo = ps.length ? Math.min(...ps) - 3 : centre - 7, hi = ps.length ? Math.max(...ps) + 3 : centre + 7;
      while (hi - lo < 14) { lo--; hi++; }
      E.lo = Math.max(21, lo); E.hi = Math.min(108, hi);
    }
    // chords: what is sounding at the start of each beat; show the name where it changes
    E.chordsIn = [];
    let prev = null;
    for (let i = 0; i < N(); i++) {
      const t = beatTime(E.bar * N() + i) + 0.01;
      const c = (S.chords || []).find(c => c.start <= t && t < c.end);
      const name = c ? c.name : '';
      E.chordsIn.push(i === 0 || name !== prev ? name : '');
      prev = name;
    }
    E.dirty = false;
    E.chordDirty = false;
  }

  // ------------------------------------------------------------------ render
  function headerCells(slots) {
    let h = '<div class="eg-corner"></div>';
    for (let s = 0; s < slots; s++) {
      const beat = Math.floor(s / E.sub), j = s % E.sub;
      h += `<div class="eg-head ${j === 0 ? 'beat' : ''}">${j === 0 ? beat + 1 : SUB_LABELS[E.sub][j]}</div>`;
    }
    return h;
  }

  function render() {
    const slots = N() * E.sub;
    $('#edTitle').textContent = `第 ${E.bar + 1} 小節（共 ${nBars()}）`;
    $('#edTarget').textContent = TARGET_LABEL[E.target] || E.target;
    $('#edSub4').setAttribute('aria-pressed', E.sub === 4);
    $('#edSub3').setAttribute('aria-pressed', E.sub === 3);
    $('#edLenBox').hidden = isGrid();
    $('#edDrumTools').hidden = E.target !== 'drums';
    if (E.target === 'drums') {
      $('#edArts').innerHTML = ARTS.map(a => `<button type="button" class="btn ghost xs toggle" data-art="${a.id}" aria-pressed="${a.id === E.art}" title="揀咗之後撳格仔就會用呢個落法；撳返已有嘅格仔就會改佢嘅落法">${a.label}</button>`).join('');
    }
    $('#edPitchBtns').hidden = isGrid();
    const lens = E.sub === 4 ? [[1, '16分'], [2, '8分'], [4, '4分'], [8, '2分'], [16, '全音']] : [[1, '三連'], [3, '4分'], [6, '2分'], [12, '全音']];
    if (!lens.some(([v]) => v === E.lenSlots)) E.lenSlots = E.sub === 4 ? 2 : 1;
    $('#edLen').innerHTML = lens.map(([v, l]) => `<button type="button" class="btn ghost xs toggle" data-len="${v}" aria-pressed="${v === E.lenSlots}">${l}</button>`).join('');
    const grid = $('#edGrid');
    grid.style.gridTemplateColumns = `76px repeat(${slots}, minmax(22px, 1fr))`;
    let h = headerCells(slots);
    if (isGrid()) {
      for (const row of gridRows()) {
        h += `<div class="eg-label">${row.label}</div>`;
        for (let s = 0; s < slots; s++) {
          const c = E.cells.get(`${row.note}:${s}`);
          const art = c && c.art ? c.art : '';
          h += `<button type="button" class="eg-cell ${s % E.sub === 0 ? 'beat' : ''} ${c ? 'on' : ''} ${art ? 'art-' + art : ''}" data-note="${row.note}" data-slot="${s}" aria-label="${row.label} ${s + 1}${art ? ' ' + art : ''}">${art ? `<span class="mk">${ART_MARK[art]}</span>` : ''}</button>`;
        }
      }
    } else {
      const occ = new Map();
      E.notes.forEach((n, i) => { for (let s = n.s; s < n.s + n.len && s < slots; s++) occ.set(`${n.pitch}:${s}`, { i, start: s === n.s }); });
      for (let p = E.hi; p >= E.lo; p--) {
        h += `<div class="eg-label ${isBlack(p) ? 'blk' : ''}">${noteName(p)}</div>`;
        for (let s = 0; s < slots; s++) {
          const o = occ.get(`${p}:${s}`);
          const cls = o ? (o.start ? 'on start' : 'on cont') : '';
          h += `<button type="button" class="eg-cell ${s % E.sub === 0 ? 'beat' : ''} ${isBlack(p) ? 'blk' : ''} ${cls}" data-pitch="${p}" data-slot="${s}"${o ? ` data-i="${o.i}"` : ''}></button>`;
        }
      }
    }
    grid.innerHTML = h;
    // chord row
    const cr = $('#edChords');
    cr.innerHTML = '<span class="small muted">和弦（每拍）：</span>' + E.chordsIn.map((c, i) =>
      `<input type="text" class="ed-chord" data-i="${i}" value="${esc(c)}" placeholder="${i === 0 ? '—' : '·'}" title="第 ${i + 1} 拍：打新和弦名；留空 = 延續上一個；- = 冇和弦" spellcheck="false">`).join('');
    updateSaveState();
  }

  function updateSaveState() {
    $('#edSave').disabled = !(E.dirty || E.chordDirty);
    $('#edSave').textContent = E.dirty || E.chordDirty ? '儲存呢小節' : '已儲存';
  }

  // ------------------------------------------------------------------ actions
  async function open(bar, target) {
    if (!S.timing || !S.jobId) return;
    E.target = target || ({ piano: 'piano', guitar: 'strums', lead: 'guitar_lead' }[S.chip] || S.chip);
    E.bar = Math.max(0, Math.min(nBars() - 1, bar));
    if (!E.data) {
      $('#edGrid').innerHTML = '<div class="small muted">載入緊…</div>';
      $('#dlgEdit').showModal();
      await loadData();
    }
    buildModel(false);
    render();
    if (!$('#dlgEdit').open) $('#dlgEdit').showModal();
    updateUndo();
  }

  async function goto(bar) {
    if ((E.dirty || E.chordDirty) && !confirm('呢小節改咗未儲存，唔要？')) return;
    E.bar = Math.max(0, Math.min(nBars() - 1, bar));
    buildModel(false);
    render();
  }

  function chordEvents() {
    const evs = [];
    let cur = null, curStart = null;
    for (let i = 0; i < N(); i++) {
      const raw = $(`.ed-chord[data-i="${i}"]`).value.trim();
      if (raw === '' && i > 0) continue;
      const t = beatTime(E.bar * N() + i);
      if (cur !== null && cur !== '-' && cur !== '') evs.push({ start: curStart, end: t, name: cur });
      cur = raw; curStart = t;
    }
    const tEnd = beatTime((E.bar + 1) * N());
    if (cur && cur !== '-') evs.push({ start: curStart, end: tEnd, name: cur });
    return evs;
  }

  async function save() {
    const btn = $('#edSave');
    btn.disabled = true;
    btn.textContent = '儲存緊…';
    try {
      if (E.dirty) {
        const [t0, t1] = barRange(E.bar);
        let events;
        if (isGrid()) {
          events = [...E.cells].map(([k, c]) => {
            const [note, s] = k.split(':').map(Number);
            if (E.target === 'strums') return { time: slotTime(E.bar, s) };
            const art = c.art || '';
            const vel = art === 'ghost' ? Math.min(c.vel || 100, 55) : art === 'accent' ? Math.max(c.vel || 100, 115) : (c.vel || 100);
            return { time: slotTime(E.bar, s), note, vel, ...(art ? { art } : {}) };
          });
        } else {
          events = E.notes.map(n => ({
            start: slotTime(E.bar, n.s),
            end: n.origEnd && n.len === Math.min(n.origLen, N() * E.sub - n.s) ? n.origEnd : slotTime(E.bar, n.s + n.len),
            pitch: n.pitch, vel: n.vel,
          }));
        }
        S.meta = await api(`/api/jobs/${S.jobId}/edit`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: E.target, t0, t1, events }) });
      }
      if (E.chordDirty) {
        const t0 = beatTime(E.bar * N()), t1 = beatTime((E.bar + 1) * N());
        S.meta = await api(`/api/jobs/${S.jobId}/edit`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ target: 'chords', t0, t1, events: chordEvents() }) });
      }
      await afterChange();
      toast(`第 ${E.bar + 1} 小節已儲存 ✓`);
    } catch (err) {
      toast('儲存失敗：' + err.message, 5000);
    }
    updateSaveState();
  }

  async function afterChange() {
    await loadData();
    await window.jpReloadScore();
    buildModel(true);
    render();
    updateUndo();
  }

  async function undoLast() {
    try {
      const m = await api(`/api/jobs/${S.jobId}/undo`, { method: 'POST' });
      S.meta = m;
      E.data = null;
      if ($('#dlgEdit').open) await afterChange(); else await window.jpReloadScore();
      toast(`已還原上一個改動${m.undoLeft ? `（仲可以還原 ${m.undoLeft} 次）` : ''}`);
    } catch (err) { toast(err.message); }
    updateUndo();
  }
  function updateUndo() {
    const n = Number(S.meta?.editCount || 0);
    $('#btnUndo').hidden = n <= 0;
    $('#edUndo').disabled = n <= 0;
  }

  // ------------------------------------------------------------------ events
  function wire() {
    $('#edGrid').addEventListener('click', e => {
      const c = e.target.closest('.eg-cell');
      if (!c) return;
      const s = Number(c.dataset.slot);
      if (isGrid()) {
        const key = `${c.dataset.note}:${s}`;
        const art = E.target === 'drums' ? E.art : '';
        const cur = E.cells.get(key);
        if (cur && (cur.art || '') === art) E.cells.delete(key);
        else if (cur) cur.art = art;      // same cell, other way of playing it
        else {
          E.cells.set(key, { vel: art === 'ghost' ? 50 : 100, art });
          // only one hi-hat state per slot
          if (c.dataset.note === '42') E.cells.delete(`46:${s}`);
          if (c.dataset.note === '46') E.cells.delete(`42:${s}`);
        }
      } else if (c.dataset.i !== undefined) {
        E.notes.splice(Number(c.dataset.i), 1);
      } else {
        const p = Number(c.dataset.pitch);
        const slots = N() * E.sub;
        let len = Math.min(E.lenSlots, slots - s);
        // don't run into the next note on the same pitch
        for (const n of E.notes) if (n.pitch === p && n.s > s) len = Math.min(len, n.s - s);
        E.notes.push({ pitch: p, s, len, vel: 90 });
        if (E.target === 'bass' || E.target === 'vocals' || E.target === 'guitar_lead') {
          // single-line parts: starting a note cuts the previous one short
          for (const n of E.notes) if (n !== E.notes[E.notes.length - 1] && n.s < s && n.s + n.len > s) n.len = s - n.s;
        }
      }
      E.dirty = true;
      render();
    });
    $('#edArts').addEventListener('click', e => {
      const b = e.target.closest('[data-art]');
      if (b) { E.art = b.dataset.art; render(); }
    });
    const sel = $('#edPattern');
    let lastGroup = null, og = null;
    for (const p of PATTERNS) {
      if (p.group !== lastGroup) { og = document.createElement('optgroup'); og.label = p.group; sel.appendChild(og); lastGroup = p.group; }
      const o = document.createElement('option');
      o.value = p.id; o.textContent = p.label;
      og.appendChild(o);
    }
    sel.addEventListener('change', () => {
      const p = PATTERNS.find(x => x.id === sel.value);
      sel.value = '';
      if (p) applyPattern(p);
    });
    $('#edChords').addEventListener('input', () => { E.chordDirty = true; updateSaveState(); });
    $('#edPrev').onclick = () => goto(E.bar - 1);
    $('#edNext').onclick = () => goto(E.bar + 1);
    $('#edSave').onclick = save;
    $('#edUndo').onclick = undoLast;
    $('#btnUndo').onclick = undoLast;
    $('#edSub4').onclick = () => { if (E.sub !== 4) { E.sub = 4; buildModel(true); E.dirty = true; render(); } };
    $('#edSub3').onclick = () => { if (E.sub !== 3) { E.sub = 3; buildModel(true); E.dirty = true; render(); } };
    $('#edLen').addEventListener('click', e => { const b = e.target.closest('[data-len]'); if (b) { E.lenSlots = Number(b.dataset.len); render(); } });
    $('#edUp').onclick = () => { E.hi = Math.min(108, E.hi + 6); E.lo = Math.min(E.lo + 6, E.hi - 14); render(); };
    $('#edDown').onclick = () => { E.lo = Math.max(21, E.lo - 6); E.hi = Math.max(E.hi - 6, E.lo + 14); render(); };
    $('#edClear').onclick = () => {
      if (isGrid()) E.cells = new Map(); else E.notes = [];
      E.dirty = true; render();
    };
    $('#edCopyPrev').onclick = () => {
      if (E.bar === 0) return;
      const keepBar = E.bar;
      E.bar = keepBar - 1; buildModel(true);
      const cells = E.cells, notes = E.notes;
      E.bar = keepBar; buildModel(true);
      if (isGrid()) E.cells = new Map([...cells].map(([k, v]) => [k, { ...v }])); else E.notes = notes.map(n => ({ ...n, origEnd: null }));
      E.dirty = true; render();
    };
    $('#edListen').onclick = () => {
      S.loopA = beatTime(E.bar * N());
      S.loopB = beatTime((E.bar + 1) * N());
      updateLoopUi();
      seekTo(S.loopA);
      if (!mixer.playing) togglePlay();
    };
    $('#edStop').onclick = () => { pausePlayback(); };
    $('#dlgEdit').addEventListener('close', () => { E.data = null; });
    $('#btnEdit').onclick = () => {
      const recent = S.lastClickBar != null && Date.now() - S.lastClickAt < 15000;
      const bar = recent ? S.lastClickBar : Math.floor(JP.timeToBeatPos(S.timing, mixer.currentTime) / N());
      open(bar);
    };
  }

  /** put a groove / fill / crash into the bar being edited */
  function applyPattern(p) {
    const n = N();
    if (p.crash) {
      E.cells.set(`49:0`, { vel: 110, art: '' });
      E.cells.set(`36:0`, { vel: 100, art: '' });
      for (const note of [42, 46, 51]) E.cells.delete(`${note}:0`);
      E.dirty = true; render();
      return;
    }
    if (p.sub && p.sub !== E.sub) {
      if (!confirm(`呢個要用「${p.sub === 3 ? '3 格（三連音）' : '4 格（16 分）'}」，轉咗佢先？（呢小節未儲存嘅改動會冇咗）`)) return;
      E.sub = p.sub; buildModel(true);
    }
    const sub = E.sub;
    const per = p.sub || 4;          // characters per beat in the pattern
    if (per !== sub) { toast('呢個節奏型要配合「' + (per === 3 ? '3 格' : '4 格') + '」'); return; }
    const span = Math.min(p.span || n, n);
    const firstBeat = n - span;
    // clear what the pattern covers (fills: only their beats)
    for (const k of [...E.cells.keys()]) {
      const s = Number(k.split(':')[1]);
      if (Math.floor(s / sub) >= firstBeat) E.cells.delete(k);
    }
    for (const [rowKey, str] of Object.entries(p.rows)) {
      const note = ROW_BY_KEY[rowKey];
      const beatsInPat = str.length / per;
      for (let b = firstBeat; b < n; b++) {
        // grooves repeat beat by beat for other meters; fills are laid out from their first beat
        const pb = p.span ? b - firstBeat : b % beatsInPat;
        for (let j = 0; j < per; j++) {
          const ch = str[pb * per + j];
          if (!ch || ch === '-') continue;
          const s = b * sub + j;
          const theNote = ch === 'o' ? 46 : note;
          E.cells.set(`${theNote}:${s}`, { vel: ch === 'g' ? 50 : ch === '>' ? 118 : 100, art: PAT_ART[ch] || '' });
          if (theNote === 42) E.cells.delete(`46:${s}`);
          if (theNote === 46) E.cells.delete(`42:${s}`);
        }
      }
    }
    E.dirty = true;
    render();
    toast(`已放入「${p.label}」— 撳「聽呢小節」之前記得儲存`);
  }

  window.JPEditor = { open, wire, updateUndo };
  wire();
  if (S.meta) updateUndo();
})();

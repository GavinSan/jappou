/* 執譜機 front-end */
'use strict';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const sleep = ms => new Promise(r => setTimeout(r, ms));

async function api(path, opts = {}) {
  const r = await fetch(path, opts);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}
function toast(msg, ms = 3000) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast._t);
  toast._t = setTimeout(() => (t.hidden = true), ms);
}
function fmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  const m = Math.floor(t / 60), s = Math.floor(t % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}
function fmtPrecise(t) {
  const m = Math.floor(t / 60), s = (t % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}
function parseTime(str) {
  const p = String(str).trim().split(':');
  const v = p.length === 2 ? Number(p[0]) * 60 + Number(p[1]) : Number(p[0]);
  return isFinite(v) ? v : null;
}
const esc = s => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

const STEM_LABEL = { drums: '鼓', bass: 'Bass', guitar: '結他', piano: '琴', vocals: '人聲', other: '其他' };
let handlerAttached = null;
const STEM_ORDER = ['drums', 'vocals', 'guitar', 'bass', 'piano', 'other'];
const CHIPS = JP.CHIPS; // score chips -> GP track keys (shared.js)
const STAGES = [
  ['download', '下載音訊'], ['separate', '分離樂器'], ['beats', '搵拍子同小節'], ['drums', '執鼓譜'],
  ['pitched', '執其他樂器譜'], ['lyrics', '搵歌詞'], ['score', '整樂譜'], ['encode', '整理音軌'],
];

const prefs = (() => {
  let p = {};
  try { p = JSON.parse(localStorage.getItem('jappou') || '{}'); } catch { /* private mode */ }
  return {
    get: (k, d) => (k in p ? p[k] : d),
    set: (k, v) => { p[k] = v; try { localStorage.setItem('jappou', JSON.stringify(p)); } catch { /* ignore */ } },
  };
})();

/* ======================================================================
   Audio: one <audio> per stem through Web Audio gains, kept in sync.
   ====================================================================== */
class Mixer {
  constructor() {
    this.ctx = null;
    this.stems = {};
    this.rate = 1;
    this.master = prefs.get('masterVol', 0.9);
    this.playing = false;
    this.listeners = {};
    this._syncTimer = null;
    this.drumSound = prefs.get('drumSound', 'orig');   // 'orig' = separated drums, 'std' = chart on a sampled kit
  }
  on(ev, fn) { (this.listeners[ev] ||= []).push(fn); }
  emit(ev, ...a) { (this.listeners[ev] || []).forEach(f => f(...a)); }
  ensureCtx() {
    if (!this.ctx) {
      this.ctx = new (window.AudioContext || window.webkitAudioContext)();
      this.out = this.ctx.createGain();
      this.out.gain.value = this.master;
      this.out.connect(this.ctx.destination);
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
    return this.ctx;
  }
  /** Each stem is downloaded completely and played from memory (blob URL).
   *  Streaming <audio> elements keep a connection open each, and browsers only
   *  allow 6 per server - six stems would block every other request (like the score). */
  async load(jobId, names, saved = {}, onProgress = () => {}) {
    this.dispose();
    this.ensureCtx();
    let done = 0;
    const fetchStem = async name => {
      const r = await fetch(`/api/jobs/${jobId}/stem/${name}.mp3`);
      if (!r.ok) throw new Error(`${name} ${r.status}`);
      const url = URL.createObjectURL(await r.blob());
      onProgress(++done, names.length);
      return url;
    };
    // two at a time leaves connections free for everything else
    const urls = {};
    const queue = names.slice();
    await Promise.all([0, 1].map(async () => {
      while (queue.length) {
        const name = queue.shift();
        try { urls[name] = await fetchStem(name); } catch (err) { console.warn('stem', err); }
      }
    }));
    const loads = [];
    for (const name of names) {
      if (!urls[name]) continue;
      const el = new Audio();
      el.preload = 'auto';
      el.preservesPitch = true;
      el.src = urls[name];
      const src = this.ctx.createMediaElementSource(el);
      const gain = this.ctx.createGain();
      src.connect(gain).connect(this.out);
      const st = saved[name] || {};
      this.stems[name] = { el, src, gain, url: urls[name], vol: st.vol ?? 1, mute: false, solo: false };
      loads.push(new Promise(res => {
        if (el.readyState >= 1) return res();
        el.addEventListener('loadedmetadata', res, { once: true });
        el.addEventListener('error', res, { once: true });
      }));
    }
    await Promise.all(loads);
    this.leader = (this.stems.drums || Object.values(this.stems)[0])?.el;
    if (this.leader) {
      this.leader.addEventListener('ended', () => { this.pause(); this.emit('ended'); });
    }
    this.updateGains();
    this.setRate(this.rate);
  }
  /** add one more stem later (the standard drum sound), in step with the rest */
  async addStem(jobId, name, version = 0) {
    if (this.stems[name]) this.removeStem(name);
    const r = await fetch(`/api/jobs/${jobId}/stem/${name}.mp3?v=${version}`);
    if (!r.ok) throw new Error(`${name} ${r.status}`);
    const url = URL.createObjectURL(await r.blob());
    const el = new Audio();
    el.preload = 'auto';
    el.preservesPitch = true;
    el.src = url;
    const src = this.ensureCtx().createMediaElementSource(el);
    const gain = this.ctx.createGain();
    gain.gain.value = 0;
    src.connect(gain).connect(this.out);
    this.stems[name] = { el, src, gain, url, vol: 1, mute: false, solo: false, extra: true };
    await new Promise(res => {
      if (el.readyState >= 1) return res();
      el.addEventListener('loadedmetadata', res, { once: true });
      el.addEventListener('error', res, { once: true });
    });
    el.playbackRate = this.rate;
    el.currentTime = this.currentTime;
    if (this.playing) { try { await el.play(); } catch { /* ignore */ } }
    this.updateGains();
  }
  removeStem(name) {
    const s = this.stems[name];
    if (!s) return;
    s.el.pause(); s.el.src = '';
    if (s.url) URL.revokeObjectURL(s.url);
    try { s.src.disconnect(); s.gain.disconnect(); } catch { /* ignore */ }
    delete this.stems[name];
  }
  get els() { return Object.values(this.stems).map(s => s.el); }
  get currentTime() { return this.leader ? this.leader.currentTime : 0; }
  get duration() {
    return Math.max(0, ...this.els.map(e => (isFinite(e.duration) ? e.duration : 0)));
  }
  async play() {
    if (!this.leader || this.playing) return;
    this.ensureCtx();
    const t = this.leader.currentTime;
    this.els.forEach(e => { if (Math.abs(e.currentTime - t) > 0.02) e.currentTime = t; });
    this.playing = true;
    try {
      await Promise.all(this.els.map(e => e.play()));
    } catch (err) {
      console.warn(err);
    }
    clearInterval(this._syncTimer);
    this._syncTimer = setInterval(() => this._resync(), 400);
    this.emit('play');
  }
  pause() {
    this.els.forEach(e => e.pause());
    const was = this.playing;
    this.playing = false;
    clearInterval(this._syncTimer);
    if (was) this.emit('pause');
  }
  seek(t) {
    t = Math.max(0, Math.min(t, this.duration || t));
    this.els.forEach(e => { e.currentTime = t; });
    this.emit('seek', t);
  }
  _resync() {
    if (!this.playing || !this.leader) return;
    const t = this.leader.currentTime;
    for (const e of this.els) {
      if (e === this.leader || e.ended) continue;
      if (Math.abs(e.currentTime - t) > 0.045) e.currentTime = t + 0.01;
    }
  }
  setRate(r) {
    this.rate = r;
    this.els.forEach(e => { e.playbackRate = r; e.preservesPitch = true; });
  }
  setMaster(v) {
    this.master = v;
    if (this.out) this.out.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02);
  }
  updateGains() {
    const anySolo = Object.values(this.stems).some(s => s.solo && !s.extra);
    const std = this.drumSound === 'std' && this.stems.drums_std;
    for (const [name, s] of Object.entries(this.stems)) {
      if (s.extra) continue;
      const audible = !s.mute && (!anySolo || s.solo);
      let g = audible ? s.vol : 0;
      if (name === 'drums' && std) {
        // the drum row's volume / mute / solo now drive the standard kit instead
        this.stems.drums_std.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
        g = 0;
      }
      if (this.ctx) s.gain.gain.setTargetAtTime(g, this.ctx.currentTime, 0.02);
    }
    if (this.stems.drums_std && !std && this.ctx) this.stems.drums_std.gain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
  }
  dispose() {
    this.pause();
    for (const s of Object.values(this.stems)) {
      s.el.src = '';
      if (s.url) URL.revokeObjectURL(s.url);
      try { s.src.disconnect(); s.gain.disconnect(); } catch { /* ignore */ }
    }
    this.stems = {};
    this.leader = null;
  }
}

/* ======================================================================
   Metronome: clicks scheduled on the detected beat times.
   ====================================================================== */
/* Metronome on the song's real beat times. Modes:
     click   - beep on every beat (accent on 1)
     beats   - spoken "one two three four"
     eighths - spoken "one and two and ..."
     sixteen - spoken "one e and a two e and a ..."
   Spoken counts use short voice clips made once by the computer's own speech
   engine (served by the backend); if that is unavailable it falls back to clicks. */
const COUNT_WORDS = ['one', 'two', 'three', 'four', 'five', 'six', 'seven'];
const METRO_MODES = { click: 1, beats: 1, eighths: 2, sixteen: 4 };
class Metronome {
  constructor(mixer) {
    this.mixer = mixer;
    this.enabled = prefs.get('metro', false);
    this.vol = prefs.get('metroVol', 0.7);
    this.mode = prefs.get('metroMode', 'click');
    this.timing = null;
    this.nextBeat = 0;
    this.nextSub = 0;
    this.timer = null;
    this.voices = {};        // word -> AudioBuffer
    this.voiceState = 'none'; // none | loading | ready | failed
    this.listeners = [];
    mixer.on('play', () => this.start());
    mixer.on('pause', () => this.stop());
    mixer.on('seek', () => this.resetIndex());
  }
  onCount(fn) { this.listeners.push(fn); }
  setTiming(t) { this.timing = t; this.resetIndex(); }
  setMode(m) {
    this.mode = METRO_MODES[m] ? m : 'click';
    prefs.set('metroMode', this.mode);
    this.resetIndex();
    if (this.mode !== 'click') this.loadVoices();
  }
  async loadVoices() {
    if (this.voiceState === 'ready' || this.voiceState === 'loading') return;
    this.voiceState = 'loading';
    const ctx = this.mixer.ensureCtx();
    const words = [...COUNT_WORDS, 'and', 'e', 'a'];
    try {
      await Promise.all(words.map(async w => {
        const r = await fetch(`/api/voice/${w}.wav`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
        this.voices[w] = await ctx.decodeAudioData(await r.arrayBuffer());
      }));
      this.voiceState = 'ready';
    } catch (err) {
      console.warn('metronome voices', err);
      this.voiceState = 'failed';
      toast('讀數聲整唔到（' + err.message + '），暫時用「嘀嗒」聲', 6000);
    }
  }
  beatTime(i) {
    const b = this.timing.beats;
    if (i < b.length) return b[i].time;
    return this.timing.endTime + (i - b.length) * 60 / this.timing.bpm;
  }
  resetIndex() {
    if (!this.timing) return;
    const now = this.mixer.currentTime;
    const b = this.timing.beats;
    const m = METRO_MODES[this.mode] || 1;
    let i = 0;
    while (i < b.length && b[i].time < now - 0.01) i++;
    // start in the previous beat: the next subdivision may still be ahead of us
    let k = Math.max(0, i - 1), j = 0;
    while (this.subTime(k, j, m) < now - 0.01 && k <= i) {
      j++;
      if (j >= m) { j = 0; k++; }
    }
    this.nextBeat = k;
    this.nextSub = j;
  }
  subTime(i, j, m) {
    const a = this.beatTime(i), b = this.beatTime(i + 1);
    return a + (b - a) * j / m;
  }
  wordFor(beatInBar, j, m) {
    if (j === 0) return COUNT_WORDS[beatInBar] || 'one';
    if (m === 2) return 'and';
    return ['', 'e', 'and', 'a'][j];
  }
  click(when, accent, soft = false) {
    const ctx = this.mixer.ensureCtx();
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = 'square';
    o.frequency.value = accent ? 1760 : soft ? 940 : 1175;
    const v = this.vol * (accent ? 0.5 : soft ? 0.16 : 0.32);
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(Math.max(v, 0.0002), when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g).connect(ctx.destination);
    o.start(when);
    o.stop(when + 0.06);
  }
  say(word, when, until, strong) {
    const buf = this.voices[word];
    if (!buf) return false;
    const ctx = this.mixer.ctx;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    // squeeze long words a little when counts come fast (16ths at a high tempo)
    const room = Math.max(0.05, until - when);
    src.playbackRate.value = Math.min(1.6, Math.max(1, buf.duration / room * 0.9));
    const g = ctx.createGain();
    const v = this.vol * (strong ? 1.0 : 0.62);
    g.gain.setValueAtTime(v, when);
    const end = when + Math.min(buf.duration / src.playbackRate.value, room);
    g.gain.setValueAtTime(v, Math.max(when, end - 0.02));
    g.gain.linearRampToValueAtTime(0.0001, end);
    src.connect(g).connect(ctx.destination);
    src.start(when);
    src.stop(end + 0.01);
    return true;
  }
  start() {
    this.resetIndex();
    clearInterval(this.timer);
    this.timer = setInterval(() => this.tick(), 20);
  }
  stop() { clearInterval(this.timer); this.timer = null; }
  tick() {
    if (!this.enabled || !this.timing || !this.mixer.playing) return;
    const ctx = this.mixer.ctx;
    const now = this.mixer.currentTime;
    const rate = this.mixer.rate;
    const N = this.timing.beatsPerBar;
    const m = METRO_MODES[this.mode] || 1;
    const voice = this.mode !== 'click' && this.voiceState === 'ready';
    if (this.mode !== 'click' && this.voiceState === 'none') this.loadVoices();
    for (let guard = 0; guard < 64; guard++) {
      const t = this.subTime(this.nextBeat, this.nextSub, m);
      if (t >= now + 0.15 * rate) break;
      if (t >= now - 0.02) {
        const when = ctx.currentTime + Math.max(0, (t - now) / rate);
        const tNext = this.nextSub + 1 < m ? this.subTime(this.nextBeat, this.nextSub + 1, m) : this.beatTime(this.nextBeat + 1);
        const until = ctx.currentTime + Math.max(0, (tNext - now) / rate);
        const bb = this.nextBeat < this.timing.beats.length ? this.timing.beats[this.nextBeat].beat : this.nextBeat % N;
        const word = this.wordFor(bb, this.nextSub, m);
        if (!(voice && this.say(word, when, until, this.nextSub === 0))) {
          if (this.nextSub === 0 || this.mode !== 'click') this.click(when, bb === 0 && this.nextSub === 0, this.nextSub !== 0);
        }
        const label = this.nextSub === 0 ? String(bb + 1) : (m === 2 ? '&' : ['', 'e', '&', 'a'][this.nextSub]);
        const delay = Math.max(0, (when - ctx.currentTime) * 1000);
        setTimeout(() => this.listeners.forEach(fn => fn(label, this.nextSub === 0)), delay);
      }
      this.nextSub++;
      if (this.nextSub >= m) { this.nextSub = 0; this.nextBeat++; }
    }
  }
  /** count one bar in, resolves when the music should start */
  countIn(beatsPerBar, bpm) {
    const ctx = this.mixer.ensureCtx();
    const iv = 60 / bpm / this.mixer.rate;
    const t0 = ctx.currentTime + 0.08;
    const voice = this.mode !== 'click' && this.voiceState === 'ready';
    for (let i = 0; i < beatsPerBar; i++) {
      const when = t0 + i * iv;
      if (!(voice && this.say(COUNT_WORDS[i] || 'one', when, when + iv, true))) this.click(when, i === 0);
    }
    return sleep((0.08 + beatsPerBar * iv) * 1000 - 15);
  }
}

/* ======================================================================
   App state
   ====================================================================== */
const mixer = new Mixer();
const metro = new Metronome(mixer);
const S = {
  jobId: null,
  meta: null,
  timing: null,
  lyrics: { lines: [] },
  at: null,              // alphaTab api
  score: null,
  chip: prefs.get('chip', 'drums'),
  lyricsMode: prefs.get('lyricsMode', 'line'),
  stave: prefs.get('stave', 'auto'),
  zoom: prefs.get('zoom', 1),
  loopA: null,
  loopB: null,
  countIn: prefs.get('countIn', false),
  drumless: false,
  posTimer: null,
  pollTimer: null,
  scoreVersion: null,
};

/* ---------------------------------------------------------------- routing */
window.addEventListener('hashchange', route);
async function route() {
  const m = location.hash.match(/^#\/song\/([a-f0-9]{12})/);
  clearTimeout(S.pollTimer);
  if (m) {
    await openSong(m[1]);
  } else {
    closeSong();
    showHome();
  }
}

/* ======================================================================
   HOME
   ====================================================================== */
function showHome() {
  $('#home').hidden = false;
  $('#song').hidden = true;
  $('#songHead').hidden = true;
  $('#headActions').hidden = true;
  document.title = '執譜機';
  refreshLibrary();
}

async function refreshLibrary() {
  if ($('#home').hidden) return;
  let jobs = [];
  try { jobs = await api('/api/jobs'); } catch (e) { $('#library').innerHTML = `<div class="empty">連唔到後端：${esc(e.message)}</div>`; return; }
  const lib = $('#library');
  if (!jobs.length) {
    lib.innerHTML = '<div class="empty">未有歌。貼條 YouTube 連結開始啦。</div>';
  } else {
    lib.innerHTML = jobs.map(j => {
      const inst = Object.entries(j.instruments || {}).filter(([, v]) => v.present).map(([k]) => STEM_LABEL[k]).join(' · ');
      let status = '';
      if (j.status === 'done') status = `${j.bpm ? Math.round(j.bpm) + ' BPM · ' : ''}${inst}`;
      else if (j.status === 'error') status = `<span class="badge err">出錯</span>${esc(j.error || '')}`;
      else status = `${esc(j.stageLabel || '排緊隊')}…`;
      const bar = j.status === 'running' || j.status === 'queued'
        ? `<div class="mini-bar"><div style="width:${Math.round((j.progress || 0) * 100)}%"></div></div>` : '';
      const thumb = j.thumbnail ? ` style="background-image:url('${esc(j.thumbnail)}')"` : '';
      return `<a class="card" href="#/song/${j.id}">
        <div class="thumb"${thumb}></div>
        <div class="info"><div class="t">${esc(j.title || '（未有歌名）')}</div>
        <div class="s">${status}</div>${bar}</div>
        <button class="del" data-del="${j.id}" title="刪除">✕</button></a>`;
    }).join('');
  }
  if (jobs.some(j => j.status === 'running' || j.status === 'queued')) {
    clearTimeout(S.pollTimer);
    S.pollTimer = setTimeout(refreshLibrary, 2000);
  }
}

$('#library').addEventListener('click', async e => {
  const id = e.target.dataset?.del;
  if (!id) return;
  e.preventDefault();
  if (!confirm('刪除呢首歌？')) return;
  try { await api(`/api/jobs/${id}`, { method: 'DELETE' }); refreshLibrary(); } catch (err) { toast(err.message); }
});

/** "1:23.5" / "83" -> seconds; "" -> null; throws on nonsense */
function parseTime(str) {
  const v = String(str || '').trim().replace('：', ':');
  if (!v || v === '完') return null;
  const parts = v.split(':').map(Number);
  if (parts.some(x => !Number.isFinite(x) || x < 0) || parts.length > 3) throw new Error(`時間「${v}」睇唔明（例子：0:30 或者 4:05）`);
  return parts.reduce((a, x) => a * 60 + x, 0);
}
function newJobExtras() {
  return {
    trimStart: parseTime($('#trimStart').value), trimEnd: parseTime($('#trimEnd').value),
    track: $('#newTrack').value.trim(), artist: $('#newArtist').value.trim(),
  };
}
function clearNewExtras() {
  for (const id of ['#trimStart', '#trimEnd', '#newTrack', '#newArtist']) $(id).value = '';
  $('#newAdv').open = false;
}
$('#newForm').addEventListener('submit', async e => {
  e.preventDefault();
  const url = $('#urlInput').value.trim();
  const language = $('#langSelect').value;
  prefs.set('lang', language);
  try {
    const job = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url, language, ...newJobExtras() }) });
    $('#urlInput').value = '';
    clearNewExtras();
    location.hash = `#/song/${job.id}`;
  } catch (err) { toast(err.message); }
});
$('#langSelect').value = prefs.get('lang', 'auto');

$('#fileInput').addEventListener('change', async e => {
  const f = e.target.files[0];
  if (!f) return;
  const fd = new FormData();
  fd.append('file', f);
  fd.append('language', $('#langSelect').value);
  try {
    const x = newJobExtras();
    fd.append('trimStart', x.trimStart ?? '');
    fd.append('trimEnd', x.trimEnd ?? '');
    fd.append('track', x.track);
    fd.append('artist', x.artist);
  } catch (err) { toast(err.message); e.target.value = ''; return; }
  toast('上載緊…');
  try {
    const job = await api('/api/upload', { method: 'POST', body: fd });
    clearNewExtras();
    location.hash = `#/song/${job.id}`;
  } catch (err) { toast(err.message); }
  e.target.value = '';
});

/* ======================================================================
   SONG
   ====================================================================== */
async function openSong(id) {
  $('#home').hidden = true;
  $('#song').hidden = false;
  if (S.jobId !== id) {
    closeSong();
    S.jobId = id;
    S.scoreVersion = null;
  }
  let meta;
  try { meta = await api(`/api/jobs/${id}`); } catch (e) { toast(e.message); location.hash = '#/'; return; }
  S.meta = meta;
  $('#songHead').hidden = false;
  $('#songTitle').value = meta.title || '';
  document.title = (meta.title || '執譜機') + ' · 執譜機';
  if (meta.status !== 'done') {
    showProgress(meta);
    S.pollTimer = setTimeout(() => { if (S.jobId === id) openSong(id); }, 1500);
    return;
  }
  if ((meta.tracks || []).some(t => t.key === 'drums') && (meta.drumsVersion || 1) < 3 && !prefs.get('redrumHint3:' + id)) {
    prefs.set('redrumHint3:' + id, 1);
    setTimeout(() => toast('有新版鼓譜偵測（全曲再聽一次執返漏咗嘅鼓、打 snare 邊唔會再變 tom）：去「⚙ 譜設定 → 用新版重新執鼓譜」', 8000), 2500);
  }
  $('#progressPanel').hidden = true;
  $('#workspace').hidden = false;
  $('#headActions').hidden = false;
  $('#songMeta').textContent = [meta.artist, meta.bpm ? `${Math.round(meta.bpm)} BPM` : '', meta.beatsPerBar ? `${meta.beatsPerBar}/4` : ''].filter(Boolean).join(' · ');
  watchExport();
  if (S.scoreVersion === (meta.scoreVersion ?? 0) && S.at) return; // already loaded
  await loadWorkspace(meta);
}

function showProgress(meta) {
  $('#workspace').hidden = true;
  $('#headActions').hidden = true;
  $('#progressPanel').hidden = false;
  const idx = STAGES.findIndex(s => s[0] === meta.stage);
  $('#ppStage').textContent = meta.status === 'error' ? '分析失敗' : meta.status === 'queued' ? '排緊隊…' : (meta.stageLabel || '分析緊') + '…';
  $('#ppBar').style.width = `${Math.round((meta.progress || 0) * 100)}%`;
  $('#ppSteps').innerHTML = STAGES.map(([k, l], i) =>
    `<li class="${i < idx ? 'done' : i === idx && meta.status === 'running' ? 'now' : ''}">${l}</li>`).join('');
  $('#ppLog').textContent = (meta.log || []).join('\n');
  $('#ppLog').scrollTop = 1e6;
  const err = $('#ppError');
  if (meta.status === 'error') {
    err.hidden = false;
    err.innerHTML = `${esc(meta.error)}<br><br><button class="btn" id="btnRetry">再試一次</button>`;
    $('#btnRetry').onclick = async () => { await api(`/api/jobs/${meta.id}/retry`, { method: 'POST' }); openSong(meta.id); };
  } else err.hidden = true;
}

function closeSong() {
  mixer.dispose();
  clearInterval(S.posTimer);
  if (S.at) { try { S.at.destroy(); } catch { /* ignore */ } }
  S.at = null;
  S.score = null;
  S.jobId = null;
  S.loopA = S.loopB = null;
  updateLoopUi();
  setPlayIcon(false);
}

async function loadWorkspace(meta) {
  S.chordsRebuilt = false;
  const id = meta.id;
  $('#scoreLoading').hidden = false;
  $('#scoreLoading').textContent = '載入緊樂譜…';
  const [timing, lyrics] = await Promise.all([
    api(`/api/jobs/${id}/file/timing.json`),
    api(`/api/jobs/${id}/file/lyrics.json`).catch(() => ({ lines: [] })),
  ]);
  S.timing = timing;
  S.lyrics = lyrics;
  metro.setTiming(timing);
  $('#bpmVal').textContent = `${Math.round(timing.bpm)} BPM`;
  // chords: computed once for songs analysed before chord support (takes a few seconds)
  if (!meta.key) $('#scoreLoading').textContent = '認緊和弦…（第一次要十幾秒）';
  await loadChords();
  if (S.chordsRebuilt) { try { S.meta = await api(`/api/jobs/${id}`); meta = S.meta; } catch { /* ignore */ } }

  buildChips();
  renderLyricsBar(0);
  showWarnings(meta);
  // the player works even if the score can't be drawn
  clearInterval(S.posTimer);
  S.posTimer = setInterval(tickPosition, 40);
  // score and audio load side by side
  const scoreP = initScore().catch(err => { console.error(err); scoreError(err); });
  if (!Object.keys(mixer.stems).length) {
    const saved = prefs.get('mix', {});
    $('#tDur').textContent = '載入音軌…';
    await mixer.load(id, (meta.stems || STEM_ORDER).filter(s => STEM_ORDER.includes(s)), saved,
      (n, total) => { $('#tDur').textContent = `音軌 ${n}/${total}`; });
    S.preset = 'full';
    $('#practice').value = 'full';
    buildMixer();
    attachHandler();
    pushPosition();
    if (mixer.drumSound === 'std' && (meta.stems || []).includes('drums')) setDrumSound('std');
  }
  $('#tDur').textContent = fmt(mixer.duration);
  await scoreP;
  S.scoreVersion = meta.scoreVersion ?? 0;
  if (window.JPEditor) JPEditor.updateUndo();
}

function scoreError(err) {
  const el = $('#scoreLoading');
  el.hidden = false;
  el.innerHTML = `<div style="max-width:560px;text-align:center;line-height:1.6">樂譜顯示唔到 😣<br><small>${esc(err && err.message || err)}</small><br>
    <small>播放、混音、拍子機照用得。樂譜引擎：${esc(window.ALPHATAB_ENGINE || '?')}。試吓撳 Ctrl+F5；仲係唔得就撳 F12 睇 Console 嘅錯誤再話我知。</small></div>`;
}

function showWarnings(meta) {
  const w = meta.warnings || [];
  const el = $('#songMeta');
  el.querySelector('.warn')?.remove();
  if (!w.length) return;
  const s = document.createElement('span');
  s.className = 'warn';
  s.textContent = ' ⚠ ' + w.length;
  s.title = w.join('\n');
  s.style.cssText = 'color:var(--bad);cursor:help';
  s.onclick = () => alert(w.join('\n\n'));
  el.appendChild(s);
}

/* ---------------------------------------------------------------- chips */
const chipAvailable = c => JP.chipAvailable(S.meta.tracks, c);
function buildChips() {
  const avail = CHIPS.filter(chipAvailable);
  if (!avail.find(c => c.key === S.chip)) S.chip = avail[0]?.key || 'drums';
  $('#trackChips').innerHTML = avail.map(c => {
    const n = (S.meta.tracks || []).filter(t => c.tracks.includes(t.key)).reduce((a, t) => a + t.notes, 0);
    return `<button class="chip" role="tab" data-chip="${c.key}" aria-selected="${c.key === S.chip}" title="${n} 粒音">${c.label}</button>`;
  }).join('') || '<span class="muted small">冇樂譜</span>';
}
$('#trackChips').addEventListener('click', e => {
  const k = e.target.dataset?.chip;
  if (!k || k === S.chip) return;
  S.chip = k;
  prefs.set('chip', k);
  $$('#trackChips .chip').forEach(b => b.setAttribute('aria-selected', b.dataset.chip === k));
  renderSelectedTracks();
});

/* ======================================================================
   alphaTab score
   ====================================================================== */
S.evenBars = prefs.get('evenBars', true);
/** how many equal-width bars fit on a line at the current window width / zoom */
function barsPerRow() {
  const w = ($('#scoreWrap')?.clientWidth || 1200) / Math.max(0.5, S.zoom);
  return Math.max(2, Math.min(6, Math.round(w / 300)));
}
let lastBpr = 0;
window.addEventListener('resize', () => {
  clearTimeout(window._bprT);
  window._bprT = setTimeout(() => { if (S.evenBars && S.at && S.score && barsPerRow() !== lastBpr) { lastBpr = barsPerRow(); renderSelectedTracks(); } }, 400);
});
const tracksForChip = () => JP.tracksForChip(S.score, S.meta.tracks, S.chip);
const staveProfileFor = chip => JP.staveProfileFor(chip, S.stave);

let scoreAttempt = 0;
async function initScore(opts = {}) {
  await window.alphaTabReady;
  const attempt = ++scoreAttempt;
  if (S.at) { try { S.at.destroy(); } catch { /* ignore */ } S.at = null; }
  handlerAttached = null;
  const el = $('#score');
  el.innerHTML = '';
  playhead.map = null; el.classList.remove('jp-own-cursor');
  const base = window.ALPHATAB_BASE;
  // Web workers render off the main thread; if they can't start (CDN script, some
  // browser setups) we fall back to rendering on the page itself.
  const useWorkers = opts.noWorkers ? false : (!window.ALPHATAB_REMOTE && prefs.get('atWorkers', true));
  const settings = {
    core: { fontDirectory: base + 'font/', engine: 'svg', logLevel: 'warning', useWorkers },
    display: {
      scale: S.zoom, staveProfile: staveProfileFor(S.chip), layoutMode: alphaTab.LayoutMode.Page,
      systemsLayoutMode: S.evenBars ? alphaTab.SystemsLayoutMode.UseModelLayout : alphaTab.SystemsLayoutMode.Automatic,
      resources: { secondaryGlyphColor: '#000000' }, // drum feet voice in black, not grey
    },
    notation: { elements: { effectDynamics: false } },
    importer: { encoding: 'utf-8' },
    player: {
      playerMode: alphaTab.PlayerMode.EnabledExternalMedia,
      enableCursor: true,
      enableAnimatedBeatCursor: true,
      enableElementHighlighting: true,
      enableUserInteraction: true,
      scrollElement: $('#scoreWrap'),
      scrollOffsetY: -40,
    },
  };
  const at = new alphaTab.AlphaTabApi(el, settings);
  S.at = at;
  // our GP5 files store names as UTF-8 (newer alphaTab versions default GP3-5 files to ANSI)
  if ('gp3To5encoding' in at.settings.importer) at.settings.importer.gp3To5encoding = 'utf-8';
  let lastError = null;
  at.error.on(e => {
    console.error(e);
    lastError = e;
    if (S.at === at && !S.score) scoreError(e);  // the file itself couldn't be read: say so right away
  });
  let rendered = false;
  at.renderFinished.on(() => { rendered = true; $('#scoreLoading').hidden = true; });
  at.postRenderFinished.on(() => { if (S.at === at) buildPlayheadMap(); });
  at.playerReady.on(() => attachHandler());
  at.scoreLoaded.on(score => {
    // runs before the first render: put title, sync points, lyrics and chords in place
    // now so the score is only drawn once
    S.score = score;
    try {
      JP.prepareScore(score, S.meta);
      if (S.evenBars) JP.evenBars(score, barsPerRow());
      JP.setRhythmStaff(score, S.meta.tracks, S.stave === 'tab');
      JP.applySyncPoints(score, S.timing);
      const tracks = tracksForChip();
      applyLyricsToScore(tracks[0]);
      applyChords(tracks);
      simUpdate(tracks);
    } catch (err) { console.error('score prep', err); }
  });
  let renderStarted = false;
  at.renderStarted.on(() => { renderStarted = true; });
  at.midiLoaded.on(() => { try { at.updateSyncPoints(); } catch { /* older versions */ } pushPosition(); });
  at.playerStateChanged.on(e => setPlayIcon(e.state === 1));
  at.playbackRangeChanged?.on(e => onRangeSelected(e.playbackRange));
  // remember which bar was clicked last, so ✏️ 改譜 opens that bar
  at.beatMouseDown.on(beat => {
    try { S.lastClickBar = beat.voice.bar.index; S.lastClickAt = Date.now(); } catch { /* ignore */ }
  });

  const r = await fetch(`/api/jobs/${S.jobId}/file/score.gp5?v=${S.meta.scoreVersion || 0}`);
  if (!r.ok) throw new Error('讀唔到樂譜檔（score.gp5）：' + r.status);
  const buf = await r.arrayBuffer();
  const keys = CHIPS.find(c => c.key === S.chip)?.tracks || [];
  const indexes = (S.meta.tracks || []).filter(t => keys.includes(t.key)).map(t => t.index);
  const loaded = new Promise(res => at.scoreLoaded.on(res));

  // watchdog: no picture after a while -> retry once without workers, then report the real error
  // retry without workers only if drawing never even started; a long song can
  // legitimately take a while to lay out
  const wait = useWorkers ? 15000 : 90000;
  const watchdog = () => {
    if (rendered || S.at !== at || attempt !== scoreAttempt) return;
    if (useWorkers && renderStarted) { setTimeout(watchdog, 15000); return; }
    if (useWorkers) {
      console.warn('alphaTab: no render with workers, retrying on the main thread');
      prefs.set('atWorkers', false);
      $('#scoreLoading').textContent = '換個方法再畫…';
      initScore({ noWorkers: true }).catch(scoreError);
    } else {
      scoreError(lastError || new Error(`等咗 ${wait / 1000} 秒都未畫到樂譜`));
    }
  };
  setTimeout(watchdog, wait);

  $('#scoreLoading').textContent = '畫緊樂譜…';
  at.load(new Uint8Array(buf), indexes.length ? indexes : [0]);
  await loaded;
  attachHandler();
}

function attachHandler() {
  const at = S.at;
  if (!at || !at.player || handlerAttached === at) return;
  const out = at.player.output;
  if (!out || !('handler' in out)) return;
  out.handler = {
    get backingTrackDuration() { return mixer.duration * 1000; },
    get playbackRate() { return mixer.rate; },
    set playbackRate(v) { /* speed is driven by our own slider */ },
    get masterVolume() { return mixer.master; },
    set masterVolume(v) { /* own slider */ },
    seekTo(ms) {
      mixer.seek(ms / 1000);
      pushPosition();
    },
    play() { startPlayback(); },
    pause() { mixer.pause(); },
  };
  handlerAttached = at;
  pushPosition();
}

function pushPosition(t) {
  const out = S.at?.player?.output;
  if (out && typeof out.updatePosition === 'function') out.updatePosition((t ?? mixer.currentTime) * 1000);
}

function renderSelectedTracks() {
  if (!S.at || !S.score) return;
  const tracks = tracksForChip();
  if (!tracks.length) return;
  JP.setRhythmStaff(S.score, S.meta.tracks, S.stave === 'tab');
  if (S.evenBars) JP.evenBars(S.score, barsPerRow());
  S.at.settings.display.systemsLayoutMode = S.evenBars ? alphaTab.SystemsLayoutMode.UseModelLayout : alphaTab.SystemsLayoutMode.Automatic;
  S.at.settings.display.staveProfile = staveProfileFor(S.chip);
  S.at.settings.display.scale = S.zoom;
  S.at.updateSettings();
  applyLyricsToScore(tracks[0]);
  applyChords(tracks);
  $('#scoreLoading').hidden = false;
  $('#scoreLoading').textContent = '畫緊樂譜…';
  S.at.renderTracks(tracks);
  simUpdate(tracks);
}

/* ======================================================================
   Simulator (drum kit / fretboard / keyboard)
   ====================================================================== */
const sim = new JPSimulator($('#sim'));
let simDirty = true;
let simTracks = null;
S.simOn = prefs.get('sim', true);
/* ---------------------------------------------------------------- chords */
S.chords = [];
S.showChords = prefs.get('showChords', true);
async function loadChords() {
  try {
    const before = S.meta?.scoreVersion;
    const d = await api(`/api/jobs/${S.jobId}/chords`);
    S.chords = d.chords || [];
    S.key = d.key || '';
    // computing chords for an old song rebuilds the score (notes split at chord changes)
    const m = await api(`/api/jobs/${S.jobId}`);
    S.chordsRebuilt = m.scoreVersion !== before;
    if (S.chordsRebuilt) S.meta = m;
  } catch (err) { console.warn('chords', err); S.chords = []; S.key = ''; }
  sim.setChords(S.chords, S.key);
}
function applyChords(tracks, chip = S.chip) {
  JP.applyChordsToScore(S.score, S.timing, S.showChords ? S.chords : [], tracks, { diagrams: chip === 'guitar' });
}

function simUpdate(tracks) {
  if (tracks) simTracks = tracks;
  simDirty = true;
  if (!S.simOn || !simTracks || !S.timing) return;
  sim.twoCrash = ((S.meta && S.meta.scoreOptions) || {}).crashes === '2';
  try { sim.setTracks(simTracks, S.chip, S.timing); sim.setChords(S.chords, S.key); simDirty = false; } catch (err) { console.error('simulator', err); }
  sim.render(smoothTime(), mixer.rate);
}
function setSimOn(on) {
  S.simOn = on;
  prefs.set('sim', on);
  setPressed($('#btnSim'), on);
  $('#sim').hidden = !on;
  if (on && simDirty) simUpdate();
}
$('#btnSim').onclick = () => setSimOn(!S.simOn);
// audio clocks tick coarsely; interpolate between updates for smooth animation
/* A steady playback clock. The audio element's currentTime advances in uneven
   steps, so feeding it straight to the cursor makes it stutter. Instead we run a
   clock from performance.now() at the playback rate and gently pull it towards
   the audio time (hard re-sync only if they drift apart, e.g. after a seek). */
const clock = { t0: 0, p0: 0, last: 0 };
function resetClock() {
  clock.t0 = mixer.currentTime; clock.p0 = performance.now(); clock.last = clock.t0;
}
function smoothTime() {
  const raw = mixer.currentTime;
  const now = performance.now();
  if (!mixer.playing) { clock.t0 = raw; clock.p0 = now; clock.last = raw; return raw; }
  let t = clock.t0 + (now - clock.p0) / 1000 * mixer.rate;
  const err = raw - t;
  if (Math.abs(err) > 0.15) { clock.t0 = raw; clock.p0 = now; clock.last = raw; return raw; }
  clock.t0 += err * 0.03;            // slow drift correction, no jumps
  t += err * 0.03;
  if (t < clock.last) t = clock.last; // never run backwards while playing
  clock.last = t;
  return t;
}
mixer.on('play', resetClock);
mixer.on('seek', resetClock);
/* Our own playhead. alphaTab's cursor jumps from note to note, and notes are
   spaced by how much room they need, not by time, so it seemed to speed up and
   slow down. This one is anchored at every beat of the bar (the beat positions on
   the page) and glides at an even speed between them, driven by the steady clock. */
const playhead = { el: null, map: null, beats: null, lastX: -1, lastY: -1 };
function buildPlayheadMap() {
  playhead.map = null;
  const bl = S.at && S.at.boundsLookup;
  if (!bl || !S.score || !S.timing || !S.timing.beats.length) { $('#score').classList.remove('jp-own-cursor'); return; }
  const N = S.timing.beatsPerBar;
  const map = [];
  for (let i = 0; i < S.score.masterBars.length; i++) {
    const mb = bl.findMasterBarByIndex(i);
    if (!mb) { map.push(null); continue; }
    const at = new Map();
    for (const bar of mb.bars) for (const b of bar.beats) {
      const tk = b.beat.playbackStart;
      if (!at.has(tk) || b.onNotesX < at.get(tk)) at.set(tk, b.onNotesX);
    }
    const pts = [...at].sort((a, b) => a[0] - b[0]);
    const barTicks = S.score.masterBars[i].calculateDuration() || N * 960;
    const vb = mb.visualBounds;
    pts.push([barTicks, vb.x + vb.w - 3]);
    if (pts[0][0] > 0) pts.unshift([0, pts[0][1]]);
    const xAt = tk => {
      let k = 0;
      while (k < pts.length - 2 && pts[k + 1][0] <= tk) k++;
      const [t0, x0] = pts[k], [t1, x1] = pts[k + 1];
      return t1 > t0 ? x0 + (x1 - x0) * Math.min(1, Math.max(0, (tk - t0) / (t1 - t0))) : x0;
    };
    const xs = [];
    // half way between "exactly on the notes" and "perfectly even through the bar":
    // stays on the notes while keeping the speed almost constant
    const x0 = xAt(0), x1 = vb.x + vb.w - 3;
    for (let k = 0; k <= N; k++) xs.push(0.5 * xAt(k * barTicks / N) + 0.5 * (x0 + (x1 - x0) * k / N));
    map.push({ xs, y: vb.y, h: vb.h });
  }
  playhead.map = map;
  playhead.beats = JP.steadyBeats(S.timing.beats);
  playhead.lastX = -1;
  $('#score').classList.add('jp-own-cursor');
}
function placePlayhead(t) {
  const map = playhead.map, b = playhead.beats;
  if (!map || !b) return;
  if (!playhead.el || !playhead.el.isConnected) {
    playhead.el = document.createElement('div');
    playhead.el.className = 'jp-playhead';
    $('#score').appendChild(playhead.el);
    playhead.lastX = -1;
  }
  let lo = 0;
  if (t > b[0].time) {
    let hi = b.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (b[mid].time <= t) lo = mid; else hi = mid - 1; }
  }
  const next = lo + 1 < b.length ? b[lo + 1].time : S.timing.endTime;
  const frac = next > b[lo].time ? Math.min(1, Math.max(0, (t - b[lo].time) / (next - b[lo].time))) : 0;
  const row = map[b[lo].bar];
  if (!row) { playhead.el.style.opacity = 0; return; }
  const k = Math.min(b[lo].beat, row.xs.length - 2);
  const x = row.xs[k] + (row.xs[k + 1] - row.xs[k]) * frac;
  if (Math.abs(x - playhead.lastX) < 0.2 && row.y === playhead.lastY) return;
  playhead.lastX = x; playhead.lastY = row.y;
  playhead.el.style.opacity = 1;
  playhead.el.style.height = row.h + 'px';
  playhead.el.style.transform = `translate(${x - 1.5}px, ${row.y}px)`;
}

(function frame() {
  const t = smoothTime();
  if (mixer.playing) pushPosition(t);
  placePlayhead(t);
  if (S.simOn && !$('#sim').hidden && !$('#workspace').hidden) {
    if (simDirty && simTracks) simUpdate();
    sim.render(t, mixer.rate);
  }
  requestAnimationFrame(frame);
})();

/* --- time <-> tick (alphaTab: 960 ticks per quarter, bar 0 at tick 0) --- */
const timeToBeatPos = t => JP.timeToBeatPos(S.timing, t);
const beatPosToTime = p => JP.beatPosToTime(S.timing, p);
const applyLyricsToScore = track => JP.applyLyricsToScore(S.score, S.timing, S.lyrics, track, S.lyricsMode);

/* ======================================================================
   Transport
   ====================================================================== */
let countingIn = false;
async function startPlayback() {
  if (mixer.playing || countingIn) return;
  if (S.loopA != null && S.loopB != null && (mixer.currentTime < S.loopA || mixer.currentTime >= S.loopB)) {
    mixer.seek(S.loopA);
  }
  if (S.countIn && S.timing) {
    countingIn = true;
    setPlayIcon(true);
    await metro.countIn(S.timing.beatsPerBar, S.timing.bpm);
    countingIn = false;
  }
  await mixer.play();
}
function togglePlay() {
  mixer.ensureCtx();
  if (S.at && S.at.player && handlerAttached === S.at && S.at.isReadyForPlayback) {
    S.at.playPause();
  } else if (mixer.playing) {
    mixer.pause();
  } else {
    startPlayback();
  }
}
function pausePlayback() {
  if (S.at && S.at.player && handlerAttached === S.at) S.at.pause();
  mixer.pause();
}
function seekTo(t) {
  mixer.seek(t);
  pushPosition();
  renderLyricsBar(t);
}
function setPlayIcon(playing) {
  $('#btnPlay').textContent = playing ? '❚❚' : '▶';
}
mixer.on('play', () => setPlayIcon(true));
mixer.on('pause', () => { if (!countingIn) setPlayIcon(false); pushPosition(); });
mixer.on('ended', () => { if (S.at?.player) S.at.pause(); });

let seeking = false;
function tickPosition() {
  const t = mixer.currentTime;
  if (S.loopA != null && S.loopB != null && mixer.playing && t >= S.loopB) {
    seekTo(S.loopA);
    metro.resetIndex();
  }
  if (!seeking) {
    const d = mixer.duration || 1;
    $('#seek').value = Math.round((t / d) * 1000);
  }
  $('#tNow').textContent = fmt(t);
  renderLyricsBar(t);
}

$('#btnPlay').onclick = togglePlay;
$('#btnBack').onclick = () => seekTo(S.loopA ?? 0);
$('#seek').addEventListener('input', () => { seeking = true; $('#tNow').textContent = fmt($('#seek').value / 1000 * mixer.duration); });
$('#seek').addEventListener('change', () => { seeking = false; seekTo($('#seek').value / 1000 * mixer.duration); });

/* --- speed (0.25x - 2x) and master volume (0 - 100) steppers --- */
function setSpeed(r) {
  r = Math.round(Math.min(2, Math.max(0.25, r)) * 100) / 100;
  S.speed = r;
  $('#speedVal').textContent = (Math.abs(r * 10 - Math.round(r * 10)) < 1e-6 ? r.toFixed(1) : r.toFixed(2)) + '×';
  mixer.setRate(r);
  if (S.at) { try { S.at.playbackSpeed = r; } catch { /* ignore */ } }
  if (S.timing) $('#bpmVal').textContent = `${Math.round(S.timing.bpm * r)} BPM`;
}
function setVolume(v) {
  v = Math.round(Math.min(100, Math.max(0, v)));
  $('#volVal').textContent = v;
  mixer.setMaster(v / 100);
  prefs.set('masterVol', v / 100);
}
S.speed = 1;
$$('[data-speed]').forEach(b => { b.onclick = () => setSpeed(S.speed + Number(b.dataset.speed)); });
$('#speedVal').onclick = () => setSpeed(1);
$$('[data-vol]').forEach(b => { b.onclick = () => setVolume(Math.round(mixer.master * 100) + Number(b.dataset.vol)); });
setVolume(Math.round(mixer.master * 100));

function setPressed(btn, v) { btn.setAttribute('aria-pressed', String(!!v)); }
setPressed($('#btnMetro'), metro.enabled);
$('#metroVol').value = Math.round(metro.vol * 100);
$('#metroMode').value = metro.mode;
$('#metroMode').addEventListener('change', e => {
  metro.setMode(e.target.value);
  if (!metro.enabled) { metro.enabled = true; prefs.set('metro', true); setPressed($('#btnMetro'), true); }
});
if (metro.mode !== 'click') metro.loadVoices();
metro.onCount((label, onBeat) => {
  const el = $('#countVal');
  el.textContent = label;
  el.classList.toggle('beat', onBeat);
  el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop');
});
$('#btnMetro').onclick = () => { metro.enabled = !metro.enabled; prefs.set('metro', metro.enabled); setPressed($('#btnMetro'), metro.enabled); metro.resetIndex(); };
$('#metroVol').addEventListener('input', e => { metro.vol = e.target.value / 100; prefs.set('metroVol', metro.vol); });
setPressed($('#btnCountIn'), S.countIn);
$('#btnCountIn').onclick = () => { S.countIn = !S.countIn; prefs.set('countIn', S.countIn); setPressed($('#btnCountIn'), S.countIn); };

/* --- practice presets: mute one part and show its chart --- */
const PRESETS = {
  full: { mute: [] },
  drums: { mute: ['drums'], chip: 'drums' },
  vocals: { mute: ['vocals'], chip: 'vocals' },
  guitar: { mute: ['guitar'], chip: 'guitar' },
  bass: { mute: ['bass'], chip: 'bass' },
  piano: { mute: ['piano'], chip: 'piano' },
  drumsOnly: { solo: ['drums'], chip: 'drums' },
  rhythm: { solo: ['drums', 'bass'], chip: 'drums' },
  vocalsOnly: { solo: ['vocals'], chip: 'vocals' },
};
function applyPreset(name) {
  const pr = PRESETS[name];
  if (!pr) return;
  for (const [n, st] of Object.entries(mixer.stems)) {
    st.mute = (pr.mute || []).includes(n);
    st.solo = (pr.solo || []).includes(n);
  }
  mixer.updateGains();
  buildMixer();
  S.preset = name;
  $('#practice').value = name;
  const chipBtn = pr.chip && $(`#trackChips [data-chip="${pr.chip}"]`);
  if (chipBtn && pr.chip !== S.chip) chipBtn.click();
  if (name !== 'full') toast($('#practice').selectedOptions[0].textContent.trim());
}
$('#practice').addEventListener('change', e => applyPreset(e.target.value));
function markCustomMix() {
  S.preset = 'custom';
  $('#practice').value = 'custom';
}

/* --- A/B loop --- */
$('#btnA').onclick = () => { S.loopA = mixer.currentTime; if (S.loopB != null && S.loopB <= S.loopA) S.loopB = null; updateLoopUi(); };
$('#btnB').onclick = () => {
  if (S.loopA == null) S.loopA = 0;
  const t = mixer.currentTime;
  if (t <= S.loopA + 0.3) { toast('B 點要喺 A 點之後'); return; }
  S.loopB = t;
  updateLoopUi();
};
$('#btnLoopClear').onclick = () => { S.loopA = S.loopB = null; updateLoopUi(); };
function onRangeSelected(range) {
  if (!range || !S.timing) return;
  // alphaTab selection (drag across notes) -> loop
  S.loopA = Math.max(0, beatPosToTime(range.startTick / 960));
  S.loopB = beatPosToTime(range.endTick / 960);
  updateLoopUi();
  toast('已設定循環：' + fmt(S.loopA) + ' – ' + fmt(S.loopB));
}
function updateLoopUi() {
  const has = S.loopA != null && S.loopB != null;
  $('#btnLoopClear').hidden = S.loopA == null && S.loopB == null;
  setPressed($('#btnA'), S.loopA != null);
  setPressed($('#btnB'), S.loopB != null);
  $('#btnA').classList.toggle('toggle', true);
  $('#btnB').classList.toggle('toggle', true);
  const lr = $('#loopRange');
  if (has && mixer.duration) {
    lr.hidden = false;
    lr.style.left = (S.loopA / mixer.duration * 100) + '%';
    lr.style.width = ((S.loopB - S.loopA) / mixer.duration * 100) + '%';
  } else lr.hidden = true;
}

/* --- keyboard --- */
document.addEventListener('keydown', e => {
  if ($('#workspace').hidden || e.target.closest('input[type=text], input[type=url], textarea, select, dialog[open]')) return;
  if (e.code === 'Space') { e.preventDefault(); togglePlay(); }
  else if (e.code === 'ArrowLeft') { e.preventDefault(); seekTo(Math.max(0, mixer.currentTime - 5)); }
  else if (e.code === 'ArrowRight') { e.preventDefault(); seekTo(mixer.currentTime + 5); }
  else if (e.code === 'Home') { e.preventDefault(); seekTo(S.loopA ?? 0); }
  else if (e.key === 'm' || e.key === 'M') $('#btnMetro').click();
  else if (e.key === 's' || e.key === 'S') $('#btnSim').click();
  else if (e.key === 'e' || e.key === 'E') $('#btnEdit').click();
  else if (e.key === '[' || e.key === ']') setSpeed(S.speed + (e.key === ']' ? 0.1 : -0.1));
  else if (e.code === 'ArrowUp') { e.preventDefault(); setVolume(Math.round(mixer.master * 100) + 5); }
  else if (e.code === 'ArrowDown') { e.preventDefault(); setVolume(Math.round(mixer.master * 100) - 5); }
});

/* ======================================================================
   Mixer panel
   ====================================================================== */
function buildMixer() {
  const rows = STEM_ORDER.filter(n => mixer.stems[n]).map(n => {
    const s = mixer.stems[n];
    const present = S.meta?.instruments?.[n]?.present;
    return `<div class="mix-row" data-stem="${n}">
      <span class="nm">${STEM_LABEL[n]}${present === false ? '<small>（好細聲）</small>' : ''}</span>
      <button class="ms m" aria-pressed="${s.mute}" title="靜音">M</button>
      <button class="ms s" aria-pressed="${s.solo}" title="獨奏">S</button>
      <input type="range" min="0" max="150" value="${Math.round(s.vol * 100)}" aria-label="${STEM_LABEL[n]} 音量">
      ${n === 'drums' ? `<span class="drum-sound" role="group" aria-label="鼓聲">
        <button type="button" class="btn ghost xs toggle" data-ds="orig" aria-pressed="${mixer.drumSound !== 'std'}" title="分離出嚟嘅原本鼓聲">原聲</button>
        <button type="button" class="btn ghost xs toggle" data-ds="std" aria-pressed="${mixer.drumSound === 'std'}" title="將鼓譜用標準鼓組重新打一次：冇雜音，聽到嘅就係譜上寫嘅">標準鼓聲</button>
      </span>` : ''}
    </div>`;
  }).join('');
  $('#mixerRows').innerHTML = rows;
}

/** switch the drums between the separated recording and the chart played on a sampled kit */
async function setDrumSound(mode) {
  mixer.drumSound = mode;
  prefs.set('drumSound', mode);
  if (mode === 'std') {
    const v = Number(S.meta.drumsStd || 0);
    if (!mixer.stems.drums_std || mixer.stems.drums_std.version !== v) {
      try {
        if (!v) {
          toast('整緊標準鼓聲…');
          S.meta = await api(`/api/jobs/${S.jobId}/drums-std`, { method: 'POST' });
        }
        await mixer.addStem(S.jobId, 'drums_std', Number(S.meta.drumsStd || 0));
        mixer.stems.drums_std.version = Number(S.meta.drumsStd || 0);
      } catch (err) {
        toast('標準鼓聲整唔到：' + err.message, 5000);
        mixer.drumSound = 'orig';
      }
    }
  }
  mixer.updateGains();
  buildMixer();
}
/** after an edit the standard drums are re-rendered on the server: reload them */
function refreshStdDrums() {
  if (mixer.drumSound === 'std' && mixer.stems.drums_std && mixer.stems.drums_std.version !== Number(S.meta.drumsStd || 0)) setDrumSound('std');
}
function saveMix() {
  const o = {};
  for (const [n, s] of Object.entries(mixer.stems)) o[n] = { vol: s.vol };  // mute / solo come from the practice preset
  prefs.set('mix', o);
}
$('#mixerRows').addEventListener('input', e => {
  const row = e.target.closest('.mix-row');
  if (!row || e.target.type !== 'range') return;
  mixer.stems[row.dataset.stem].vol = e.target.value / 100;
  mixer.updateGains();
  saveMix();
});
$('#mixerRows').addEventListener('click', e => {
  const ds = e.target.closest('[data-ds]');
  if (ds) { setDrumSound(ds.dataset.ds); return; }
  const row = e.target.closest('.mix-row');
  if (!row || !e.target.classList.contains('ms')) return;
  const s = mixer.stems[row.dataset.stem];
  if (e.target.classList.contains('m')) s.mute = !s.mute; else s.solo = !s.solo;
  markCustomMix();
  e.target.setAttribute('aria-pressed', e.target.classList.contains('m') ? s.mute : s.solo);
  mixer.updateGains();
  saveMix();
});
$('#mixReset').onclick = () => {
  for (const s of Object.values(mixer.stems)) { s.vol = 1; s.mute = false; s.solo = false; }
  S.preset = 'full'; $('#practice').value = 'full';
  mixer.updateGains(); buildMixer(); saveMix();
};
$('#btnMixer').onclick = () => {
  const m = $('#mixer');
  m.hidden = !m.hidden;
  setPressed($('#btnMixer'), !m.hidden);
};

/* ======================================================================
   Lyrics bar + editor
   ====================================================================== */
let lastLyIdx = -2, lastWordIdx = -2;
function renderLyricsBar(t) {
  const lines = S.lyrics?.lines || [];
  if (!lines.length) {
    if (lastLyIdx !== -3) { $('#lyNow').innerHTML = '<span class="muted small">（冇歌詞 — 可以㩒「改歌詞」自己加）</span>'; $('#lyNext').innerHTML = '&nbsp;'; lastLyIdx = -3; }
    return;
  }
  let idx = -1;
  for (let i = 0; i < lines.length; i++) { if (lines[i].start <= t + 0.15) idx = i; else break; }
  // after a long gap, show the upcoming line instead of a stale one
  if (idx >= 0 && t > (lines[idx].end || lines[idx].start) + 4) idx = -1 - idx - 1;
  const showIdx = idx >= 0 ? idx : -idx - 1;
  const cur = idx >= 0 ? lines[idx] : null;
  if (idx !== lastLyIdx) {
    lastLyIdx = idx;
    lastWordIdx = -2;
    const nowEl = $('#lyNow');
    if (cur) {
      if (cur.words?.length) {
        nowEl.className = 'ly-now';
        nowEl.innerHTML = cur.words.map((w, i) => `<span class="w" data-i="${i}">${esc(w.word)}</span>`).join('');
      } else { nowEl.className = 'ly-now plain'; nowEl.textContent = cur.text; }
    } else nowEl.innerHTML = '&nbsp;';
    const nxt = lines[cur ? idx + 1 : Math.max(0, showIdx)];
    $('#lyNext').textContent = nxt ? nxt.text : '';
  }
  if (cur?.words?.length) {
    let wi = -1;
    for (let i = 0; i < cur.words.length; i++) if (cur.words[i].start <= t + 0.05) wi = i;
    if (wi !== lastWordIdx) {
      lastWordIdx = wi;
      $$('#lyNow .w').forEach((el, i) => el.classList.toggle('on', i <= wi));
    }
  }
}

$('#lyricsMode').value = S.lyricsMode;
$('#lyricsMode').addEventListener('change', e => { S.lyricsMode = e.target.value; prefs.set('lyricsMode', S.lyricsMode); renderSelectedTracks(); });

/* Editor model: each row keeps a reference to its source line (with word timings),
   so shifting / editing times moves the word highlights along with it. */
let ED = { lines: [], shift: 0 };
function lyRowHtml(l, i) {
  return `<div class="ly-row" data-i="${i}"><input class="time" value="${fmtPrecise(l.start)}" aria-label="時間">
    <button class="btn ghost sm" type="button" data-act="now" title="設為而家位置">⏱</button>
    <input type="text" value="${esc(l.text)}" aria-label="歌詞">
    <button class="btn ghost sm danger" type="button" data-act="del" title="刪除">✕</button></div>`;
}
function edRender() {
  $('#lyEditRows').innerHTML = ED.lines.map(lyRowHtml).join('') || '<div class="small muted">（未有歌詞）</div>';
  $('#lyShiftVal').textContent = ED.shift ? `（已${ED.shift > 0 ? '延遲' : '提早'} ${Math.abs(ED.shift).toFixed(1)}s）` : '';
}
function edLoad(lines) {
  ED = { lines: (lines || []).map(l => ({ ...l, words: (l.words || []).map(w => ({ ...w })) })), shift: 0 };
  edRender();
}
/** read the rows back into ED (keeps words, moves them if the line's time was edited) */
function edSync() {
  const out = [];
  for (const row of $$('#lyEditRows .ly-row')) {
    const src = ED.lines[Number(row.dataset.i)] || { words: [] };
    const start = parseTime(row.querySelector('.time').value) ?? src.start ?? 0;
    const text = row.querySelector('input[type=text]').value.trim();
    const d = start - (src.start ?? start);
    const keepWords = text === src.text && src.words?.length;
    out.push({
      start, text,
      end: (src.end ?? start + 3) + d,
      words: keepWords ? src.words.map(w => ({ ...w, start: w.start + d, end: w.end + d })) : [],
    });
  }
  ED.lines = out;
}
function sourceLabel(ly) {
  if (ly.source === 'lrclib' && ly.sourceInfo) {
    const si = ly.sourceInfo;
    return `歌詞來源：網上（LRCLIB）${esc(si.artist || '')} - ${esc(si.track || '')}${si.quality != null ? `，同歌聲吻合度 ${Math.round(si.quality * 100)}%` : ''}`;
  }
  if (ly.source === 'whisper') return '歌詞來源：AI 聽寫（可能有錯字，可以喺下面網上搵）';
  if (ly.edited) return '歌詞來源：你改過嘅版本';
  return '';
}
$('#btnEditLyrics').onclick = async () => {
  edLoad(S.lyrics.lines);
  $('#lySource').innerHTML = sourceLabel(S.lyrics);
  $('#lyResults').innerHTML = '';
  $('#lySearchBox').open = !(S.lyrics.source === 'lrclib');
  $('#dlgLyrics').showModal();
  if (!$('#lyqTrack').value || $('#lyqTrack').dataset.job !== S.jobId) {
    try {
      const q = await api(`/api/jobs/${S.jobId}/lyrics/suggest`);
      $('#lyqTrack').value = q.track || S.meta.title || '';
      $('#lyqArtist').value = q.artist || '';
      $('#lyqTrack').dataset.job = S.jobId;
    } catch { $('#lyqTrack').value = S.meta.title || ''; }
  }
  renderChips();
};
$('#lyEditRows').addEventListener('click', e => {
  const act = e.target.dataset?.act;
  const row = e.target.closest('.ly-row');
  if (!act || !row) return;
  if (act === 'del') row.remove();
  if (act === 'now') row.querySelector('.time').value = fmtPrecise(mixer.currentTime);
});
$('#lyAdd').onclick = () => {
  edSync();
  ED.lines.push({ start: mixer.currentTime, end: mixer.currentTime + 3, text: '', words: [] });
  ED.lines.sort((a, b) => a.start - b.start);
  edRender();
  const rows = $$('#lyEditRows .ly-row');
  const r = rows.find(x => !x.querySelector('input[type=text]').value) || rows[rows.length - 1];
  r?.querySelector('input[type=text]').focus();
};
/** place plain (untimed) lyric lines onto the current timing, extra lines spread afterwards */
function placePlainLines(newLines) {
  edSync();
  const old = ED.lines.length ? ED.lines : (S.lyrics.lines || []);
  const dur = mixer.duration || 180;
  ED.lines = newLines.map((text, i) => {
    let start;
    if (i < old.length) start = old[i].start;
    else {
      const last = old.length ? old[old.length - 1].start : 0;
      start = last + (i - old.length + 1) * Math.max(2, (dur - last) / (newLines.length - old.length + 1));
    }
    return { start, end: start + 3, text, words: [] };
  });
  edRender();
}
$('#lyPaste').onclick = () => {
  const txt = prompt('貼全首歌詞（每行一句）。會盡量用返而家嘅時間；多出嚟嘅句會平均分佈喺後面。');
  if (!txt) return;
  placePlainLines(txt.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
};
$$('[data-shift]').forEach(b => {
  b.onclick = () => {
    edSync();
    const d = Number(b.dataset.shift);
    ED.lines = ED.lines.map(l => ({
      ...l, start: Math.max(0, l.start + d), end: l.end + d,
      words: (l.words || []).map(w => ({ ...w, start: w.start + d, end: w.end + d })),
    }));
    ED.shift = Math.round((ED.shift + d) * 10) / 10;
    edRender();
  };
});

/* --- online search (LRCLIB) --- */
async function lyricsSearch() {
  const track = $('#lyqTrack').value.trim(), artist = $('#lyqArtist').value.trim();
  if (!track) { toast('請輸入歌名'); return; }
  const box = $('#lyResults');
  box.innerHTML = '<div class="small muted">搵緊…</div>';
  try {
    const res = await api(`/api/lyrics/search?${new URLSearchParams({ track, artist })}`);
    if (!res.length) { box.innerHTML = '<div class="small muted">搵唔到。試吓改歌名 / 歌手（例如用英文名、或者唔填歌手）。</div>'; return; }
    box.innerHTML = res.map(r => `<button type="button" class="ly-res" data-id="${r.id}">
      <div>${esc(r.track)} — ${esc(r.artist)}<span class="tag ${r.synced ? '' : 'plain'}">${r.synced ? '有時間軸' : '只有文字'}</span></div>
      <div class="meta">${esc(r.album || '')}${r.duration ? ' · ' + fmt(r.duration) : ''}${r.preview ? ' · ' + esc(r.preview) : ''}</div></button>`).join('');
  } catch (err) { box.innerHTML = `<div class="small" style="color:var(--bad)">${esc(err.message)}</div>`; }
}
/* --- pick song name / singer out of a long YouTube title --- */
const LY_NOISE = /^(official|music video|mv|m\/v|lyrics?( video)?|audio|hd|4k|hq|live|官方|官方版|完整版|高清|歌詞|歌词|動態歌詞|动态歌词|字幕|pinyin|官方mv|official mv|official video|official music video|官方高畫質|高畫質)$/i;
const LY_SPLIT = /\s+[-–—|｜/]\s+|[|｜【】\[\]（）()「」《》『』〈〉“”"]|\s+[-–—]|[-–—]\s+|\s*(?:feat\.?|ft\.)\s*/i;
function titleChips(title) {
  const parts = String(title || '').split(LY_SPLIT)
    .map(x => (x || '').trim().replace(/^[-–—:：·•]+|[-–—:：·•]+$/g, '').trim())
    .filter(x => x && !LY_NOISE.test(x));
  return [...new Set(parts)].slice(0, 12);
}
let lyTarget = 'track';
function renderChips() {
  const chips = titleChips(S.meta.ytTitle || S.meta.title);
  $('#lyChipsBox').hidden = chips.length < 2;
  const tv = $('#lyqTrack').value.trim(), av = $('#lyqArtist').value.trim();
  $('#lyChips').innerHTML = chips.map(c =>
    `<button type="button" class="ly-chip ${c === tv ? 'in-track' : ''} ${c === av ? 'in-artist' : ''}" data-chip="${esc(c)}">${esc(c)}</button>`).join('');
}
function setLyTarget(t) {
  lyTarget = t;
  $$('.ly-target [data-target]').forEach(x => x.setAttribute('aria-pressed', x.dataset.target === t));
}
$('#lyChips').addEventListener('click', e => {
  const b = e.target.closest('.ly-chip');
  if (!b) return;
  const c = b.dataset.chip;
  const el = lyTarget === 'track' ? $('#lyqTrack') : $('#lyqArtist');
  const other = lyTarget === 'track' ? $('#lyqArtist') : $('#lyqTrack');
  if (other.value.trim() === c) other.value = '';
  el.value = c;
  setLyTarget(lyTarget === 'track' ? 'artist' : 'track');   // next click fills the other box
  renderChips();
});
$$('.ly-target [data-target]').forEach(x => x.addEventListener('click', () => setLyTarget(x.dataset.target)));
$('#lyqSwap').onclick = () => {
  const a = $('#lyqTrack').value; $('#lyqTrack').value = $('#lyqArtist').value; $('#lyqArtist').value = a;
  renderChips();
};
[$('#lyqTrack'), $('#lyqArtist')].forEach(el => el.addEventListener('input', renderChips));
$('#lyqGo').onclick = lyricsSearch;
[$('#lyqTrack'), $('#lyqArtist')].forEach(el => el.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); lyricsSearch(); } }));
$('#lyResults').addEventListener('click', async e => {
  const btn = e.target.closest('.ly-res');
  if (!btn) return;
  btn.disabled = true;
  btn.querySelector('.meta').textContent = '對緊時間…';
  try {
    const data = await api(`/api/jobs/${S.jobId}/lyrics/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ lrclibId: Number(btn.dataset.id) }) });
    if (data.plain !== undefined) {
      placePlainLines(data.plain.split(/\r?\n/).map(s => s.trim()).filter(Boolean));
      toast('呢份歌詞冇時間資料：已經放入下面，請用 ⏱ 對返時間再儲存', 6000);
      return;
    }
    S.lyrics = data;
    edLoad(data.lines);
    $('#lySource').innerHTML = sourceLabel(data);
    lastLyIdx = -2;
    renderLyricsBar(mixer.currentTime);
    renderSelectedTracks();
    refreshExportSoon();
    const q = data.sourceInfo?.quality;
    toast(q != null && q < 0.5 ? '已用呢份歌詞，但時間可能對得唔太準，可以用「提早 / 延遲」校正' : '已用網上歌詞 ✓', 5000);
  } catch (err) {
    toast(err.message, 5000);
    btn.disabled = false;
  }
});

$('#lySave').onclick = async () => {
  edSync();
  const lines = ED.lines.filter(l => l.text);
  lines.sort((a, b) => a.start - b.start);
  for (let i = 0; i < lines.length - 1; i++) if (!lines[i].words.length) lines[i].end = Math.min(lines[i].end, lines[i + 1].start);
  try {
    S.lyrics = await api(`/api/jobs/${S.jobId}/lyrics`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ language: S.lyrics.language, lines }) });
    $('#dlgLyrics').close();
    lastLyIdx = -2;
    renderLyricsBar(mixer.currentTime);
    renderSelectedTracks();
    toast('歌詞已儲存');
    refreshExportSoon();
  } catch (err) { toast(err.message); }
};

/* ======================================================================
   Header actions: title, score settings, PDF, zoom
   ====================================================================== */
$('#songTitle').addEventListener('change', async e => {
  const title = e.target.value.trim();
  try {
    S.meta = await api(`/api/jobs/${S.jobId}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title }) });
    if (S.score) { S.score.title = title; renderSelectedTracks(); }
    document.title = title + ' · 執譜機';
    refreshExportSoon();
  } catch (err) { toast(err.message); }
});

let optShift = 0;
$('#btnScoreSettings').onclick = () => {
  const o = S.meta.scoreOptions || {};
  $('#optMeter').value = o.meter || '';
  optShift = o.shift || 0;
  $('#optShiftVal').textContent = optShift;
  $('#optTempo').value = String(o.tempoFactor || 1);
  $('#optTriplets').checked = o.triplets !== false;
  $('#optGuitarSens').value = o.guitarSens || 'mid';
  $('#optCrashes').value = o.crashes || 'auto';
  const tr = S.meta.trim || {};
  $('#optTrimStart').value = tr.start ? fmtPrecise(tr.start) : '';
  $('#optTrimEnd').value = tr.end ? fmtPrecise(tr.end) : '';
  $('#optRedrums').hidden = !(S.meta.tracks || []).some(t => t.key === 'drums');
  $('#optStave').value = S.stave;
  $('#optEvenBars').value = S.evenBars ? 'even' : 'auto';
  $('#dlgScore').showModal();
};
$('#optReanalyze').onclick = async () => {
  const edits = Number(S.meta?.editCount || 0);
  if (!confirm(`由頭再分析成首歌？大約要幾分鐘。${edits ? `\n⚠ 你改過嘅譜（${edits} 處）同和弦會被覆蓋！` : ''}歌詞嘅修改都會被覆蓋。`)) return;
  $('#dlgScore').close();
  try {
    pausePlayback();
    await api(`/api/jobs/${S.jobId}/retry`, { method: 'POST' });
    const id = S.jobId;
    closeSong();
    openSong(id);
  } catch (err) { toast(err.message); }
};
$('#optRedrums').onclick = async () => {
  const btn = $('#optRedrums');
  btn.disabled = true;
  btn.textContent = '執緊鼓譜…（約半分鐘）';
  try {
    pausePlayback();
    const res = await api(`/api/jobs/${S.jobId}/redrums`, { method: 'POST' });
    $('#dlgScore').close();
    await window.jpReloadScore();
    toast(`鼓譜執好：${res.drumHits} 下 ✓（唔啱可以撳「↶ 還原」）`, 5000);
    refreshExportSoon();
  } catch (err) { toast('執唔到：' + err.message, 6000); }
  btn.disabled = false;
  btn.textContent = '🥁 用新版重新執鼓譜';
};
// trim times are in the ORIGINAL recording; the player plays the already-cut audio
const origNow = () => ((S.meta.trim && S.meta.trim.start) || 0) + mixer.currentTime;
$('#optTrimStartNow').onclick = () => { $('#optTrimStart').value = fmtPrecise(origNow()); };
$('#optTrimEndNow').onclick = () => { $('#optTrimEnd').value = fmtPrecise(origNow()); };
$('#optTrimGo').onclick = async () => {
  let start, end;
  try { start = parseTime($('#optTrimStart').value); end = parseTime($('#optTrimEnd').value); } catch (err) { toast(err.message); return; }
  const edits = Number(S.meta?.editCount || 0);
  if (!confirm(`剪成 ${start != null ? fmt(start) : '0:00'} – ${end != null ? fmt(end) : '完'}，再由頭分析？大約要幾分鐘。${edits ? `\n⚠ 你改過嘅譜（${edits} 處）會冇咗。` : ''}`)) return;
  $('#dlgScore').close();
  try {
    pausePlayback();
    await api(`/api/jobs/${S.jobId}/trim`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ start, end }) });
    const id = S.jobId;
    closeSong();
    openSong(id);
  } catch (err) { toast(err.message); }
};
$('#optShiftL').onclick = () => { optShift--; $('#optShiftVal').textContent = optShift; };
$('#optShiftR').onclick = () => { optShift++; $('#optShiftVal').textContent = optShift; };
$('#optApply').onclick = async () => {
  const body = {
    meter: $('#optMeter').value ? Number($('#optMeter').value) : null,
    shift: optShift,
    tempoFactor: Number($('#optTempo').value),
    triplets: $('#optTriplets').checked,
    guitarSens: $('#optGuitarSens').value,
    crashes: $('#optCrashes').value,
  };
  const evenNow = $('#optEvenBars').value === 'even';
  const staveChanged = $('#optStave').value !== S.stave || evenNow !== S.evenBars;
  S.evenBars = evenNow;
  prefs.set('evenBars', evenNow);
  S.stave = $('#optStave').value;
  prefs.set('stave', S.stave);
  const o = S.meta.scoreOptions || {};
  const same = (o.meter || null) === body.meter && (o.shift || 0) === body.shift && (o.tempoFactor || 1) === body.tempoFactor && (o.triplets !== false) === body.triplets && (o.guitarSens || 'mid') === body.guitarSens && (o.crashes || 'auto') === body.crashes;
  $('#dlgScore').close();
  if (same) { if (staveChanged) renderSelectedTracks(); return; }
  toast('重新整緊譜…');
  try {
    const wasPlaying = mixer.playing;
    pausePlayback();
    S.meta = await api(`/api/jobs/${S.jobId}/rescore`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    S.timing = await api(`/api/jobs/${S.jobId}/file/timing.json`);
    metro.setTiming(S.timing);
    $('#bpmVal').textContent = `${Math.round(S.timing.bpm * mixer.rate)} BPM`;
    $('#songMeta').textContent = [S.meta.artist, `${Math.round(S.meta.bpm)} BPM`, `${S.meta.beatsPerBar}/4`].filter(Boolean).join(' · ');
    buildChips();
    await initScore();
    S.scoreVersion = S.meta.scoreVersion;
    refreshStdDrums();
    if (wasPlaying) togglePlay();
    toast('整好');
    refreshExportSoon();
  } catch (err) { toast(err.message); }
};

function setZoom(z) {
  S.zoom = Math.round(Math.min(2, Math.max(0.5, z)) * 10) / 10;
  prefs.set('zoom', S.zoom);
  $('#zoomVal').textContent = Math.round(S.zoom * 100) + '%';
  if (S.at) {
    if (S.evenBars) renderSelectedTracks();   // bars per line depends on zoom
    else { S.at.settings.display.scale = S.zoom; S.at.updateSettings(); S.at.render(); }
  }
}
$('#zoomIn').onclick = () => setZoom(S.zoom + 0.1);
$('#zoomOut').onclick = () => setZoom(S.zoom - 0.1);
$('#zoomVal').textContent = Math.round(S.zoom * 100) + '%';

$('#btnPdf').onclick = () => {
  const avail = CHIPS.filter(chipAvailable);
  $('#pdfTracks').innerHTML = avail.map(c => `<label class="chip"><input type="radio" name="pdfChip" value="${c.key}" ${c.key === S.chip ? 'checked' : ''}> ${c.label}</label>`).join('');
  $('#dlgPdf').showModal();
};
$('#pdfGo').onclick = async () => {
  const chip = $('input[name=pdfChip]:checked')?.value || S.chip;
  const lyricsMode = $('#pdfLyrics').checked ? (S.lyricsMode === 'off' ? 'line' : S.lyricsMode) : 'off';
  const bars = Number($('#pdfBars').value);
  const btn = $('#pdfGo');
  btn.disabled = true;
  btn.textContent = '整緊 PDF…';
  try {
    const qs = new URLSearchParams({ chip, lyrics: lyricsMode, bars, stave: S.stave });
    const r = await fetch(`/api/jobs/${S.jobId}/pdf?${qs}`);
    if (r.status === 501) { $('#dlgPdf').close(); browserPrint(chip, lyricsMode, bars); return; }
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    const blob = await r.blob();
    const label = (CHIPS.find(c => c.key === chip) || {}).label || chip;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${S.meta.title || 'score'} - ${label}.pdf`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    $('#dlgPdf').close();
  } catch (err) {
    toast('PDF 失敗：' + err.message, 5000);
  } finally {
    btn.disabled = false;
    btn.textContent = '下載 PDF';
  }
};

/** fallback when the server can't render PDFs: browser print dialog */
function browserPrint(chip, lyricsMode, bars) {
  if (!S.at || !S.score) return;
  const prevChip = S.chip, prevMode = S.lyricsMode;
  S.chip = chip;
  S.lyricsMode = lyricsMode;
  const tracks = tracksForChip();
  applyLyricsToScore(tracks[0]);
  applyChords(tracks, chip);
  const extra = { display: { staveProfile: staveProfileFor(chip), barsPerRow: bars || -1 } };
  S.at.renderTracks(tracks); // print() prints the tracks currently shown
  setTimeout(() => {
    S.at.print(undefined, extra);
    S.chip = prevChip;
    S.lyricsMode = prevMode;
    setTimeout(renderSelectedTracks, 500);
  }, 150);
}

/* ---------------------------------------------------------------- Google Drive export */
let cfgCache = null;
async function loadConfig() {
  try { cfgCache = await api('/api/config'); } catch { cfgCache = null; }
  return cfgCache;
}
$('#btnDrive').onclick = async () => {
  const cfg = cfgCache || await loadConfig();
  if (!cfg?.exportDir) { toast('先揀匯出資料夾（Google Drive）'); openSettings(); return; }
  try {
    S.meta = await api(`/api/jobs/${S.jobId}/export`, { method: 'POST' });
    watchExport();
  } catch (err) { toast(err.message, 5000); }
};
function updateDriveBtn() {
  const b = $('#btnDrive');
  const st = S.meta?.exportStatus;
  b.disabled = st === 'running';
  b.textContent = st === 'running' ? '☁ 上緊 Drive…' : st === 'done' ? '☁ 已上 Drive ✓' : '☁ 上 Drive';
  b.title = S.meta?.exported?.dir ? `已匯出去：${S.meta.exported.dir}\n㩒一下再更新` : '匯出 PDF + 音軌去 Google Drive 資料夾';
}
let exportWatch = null;
/** after an edit the server may refresh the Drive export in the background */
function refreshExportSoon() {
  setTimeout(async () => {
    if (!S.jobId) return;
    try { const m = await api(`/api/jobs/${S.jobId}`); S.meta.exportStatus = m.exportStatus; S.meta.exported = m.exported; watchExport(); } catch { /* ignore */ }
  }, 600);
}
function watchExport() {
  updateDriveBtn();
  clearTimeout(exportWatch);
  if (S.meta?.exportStatus !== 'running') return;
  exportWatch = setTimeout(async () => {
    if (!S.jobId) return;
    try {
      const m = await api(`/api/jobs/${S.jobId}`);
      const was = S.meta.exportStatus;
      S.meta.exportStatus = m.exportStatus;
      S.meta.exported = m.exported;
      if (was === 'running' && m.exportStatus === 'done') toast('已經放咗入 Google Drive ✓');
      if (m.exportStatus === 'error') toast('匯出失敗：' + (m.exportError || ''), 6000);
    } catch { /* ignore */ }
    watchExport();
  }, 1500);
}

/* ---------------------------------------------------------------- settings */
async function openSettings() {
  const cfg = await loadConfig();
  if (!cfg) { toast('連唔到後端'); return; }
  $('#cfgDir').value = cfg.exportDir || cfg.detectedDrives?.[0] || '';
  $('#cfgDetected').innerHTML = cfg.detectedDrives?.length
    ? '搵到：' + cfg.detectedDrives.map(d => `<a href="#" class="link" data-dir="${esc(d)}">${esc(d)}</a>`).join('　')
    : '搵唔到 Google Drive for desktop — 可以手動貼資料夾路徑';
  $('#cfgAuto').checked = !!cfg.autoExport;
  $('#cfgStems').checked = !!cfg.exportStems;
  $('#cfgInst').value = cfg.exportInstruments || 'all';
  $('#cfgLyrics').value = cfg.pdfLyrics || 'line';
  $('#cfgBars').value = String(cfg.pdfBars ?? 4);
  $('#cfgWhisper').value = cfg.whisperModel || 'auto';
  $('#cfgSeparator').value = cfg.separator || 'auto';
  $('#cfgPdfWarn').textContent = cfg.pdfAvailable ? '' : '⚠ 未裝 PDF 引擎，請重新執行安裝程式';
  $('#dlgSettings').showModal();
}
$('#btnSettings').onclick = openSettings;
$('#cfgDetected').addEventListener('click', e => {
  const d = e.target.dataset?.dir;
  if (d) { e.preventDefault(); $('#cfgDir').value = d; }
});
$('#cfgSave').onclick = async () => {
  const body = {
    exportDir: $('#cfgDir').value.trim(),
    autoExport: $('#cfgAuto').checked,
    exportStems: $('#cfgStems').checked,
    exportInstruments: $('#cfgInst').value,
    pdfLyrics: $('#cfgLyrics').value,
    pdfBars: Number($('#cfgBars').value),
    whisperModel: $('#cfgWhisper').value,
    separator: $('#cfgSeparator').value,
  };
  try {
    cfgCache = { ...(cfgCache || {}), ...(await api('/api/config', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })) };
    $('#dlgSettings').close();
    toast('已儲存');
  } catch (err) { toast(err.message, 5000); }
};

/* ---------------------------------------------------------------- system info */
api('/api/system').then(s => {
  $('#sysInfo').textContent = s.gpu ? (s.vram ? `${s.gpu} · ${s.vram}GB` : s.gpu) : (s.device === 'cpu' ? 'CPU 模式（會慢啲）' : '');
}).catch(() => {});
loadConfig();

route();
setSimOn(S.simOn);

/* ---------------------------------------------------------------- editing hooks */
/** reload score + chords after an edit (keeps playback position) */
window.jpReloadScore = async function () {
  const m = await api(`/api/jobs/${S.jobId}`);
  S.meta = m;
  S.timing = await api(`/api/jobs/${S.jobId}/file/timing.json`);
  metro.setTiming(S.timing);
  await loadChords();
  await initScore();
  S.scoreVersion = S.meta.scoreVersion;
  if (window.JPEditor) JPEditor.updateUndo();
  refreshStdDrums();
};
setPressed($('#btnChords'), S.showChords);
$('#btnChords').onclick = () => {
  S.showChords = !S.showChords;
  prefs.set('showChords', S.showChords);
  setPressed($('#btnChords'), S.showChords);
  renderSelectedTracks();
};
// (editor.js wires itself up after this file has loaded)

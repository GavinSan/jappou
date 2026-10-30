// Loads alphaTab (music notation engine). The app ships its own tested, patched
// build under a unique file name, so an older alphaTab.js left in the folder by a
// previous version can never be picked up by mistake.
(function () {
  const ENGINE = 'vendor/alphatab/alphaTab-jp184.js';
  const ENGINE_VERSION = '1.8.4-jp2';
  const CDNS = [
    'https://cdn.jsdelivr.net/npm/@coderline/alphatab@1.8.4/dist/',
  ];
  function load(src) {
    return new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = src;
      s.onload = () => (window.alphaTab && window.alphaTab.AlphaTabApi ? resolve() : reject(new Error('alphaTab missing in ' + src)));
      s.onerror = () => reject(new Error('load failed: ' + src));
      document.head.appendChild(s);
    });
  }
  async function start() {
    const errors = [];
    try {
      await load(ENGINE + '?v=' + ENGINE_VERSION);
      window.ALPHATAB_REMOTE = false;
      window.ALPHATAB_ENGINE = ENGINE_VERSION;
      return 'vendor/alphatab/';
    } catch (e) { errors.push(String(e.message || e)); }
    for (const base of CDNS) {
      try {
        await load(base + 'alphaTab.js');
        window.ALPHATAB_REMOTE = true;
        window.ALPHATAB_ENGINE = 'cdn';
        return base;
      } catch (e) { errors.push(String(e.message || e)); }
    }
    throw new Error('樂譜引擎（alphaTab）載入唔到：' + errors.join(' | '));
  }
  window.alphaTabReady = start().then(base => {
    window.ALPHATAB_BASE = new URL(base, location.href).href;
    console.info('[jappou] alphaTab engine', window.ALPHATAB_ENGINE);
    return window.alphaTab;
  });
})();

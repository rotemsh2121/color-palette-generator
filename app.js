(() => {
  'use strict';

  const MIN_COLORS = 2;
  const MAX_COLORS = 10;
  const DEFAULT_COLORS = 5;
  const UNDO_LIMIT = 50;
  const LIBRARY_KEY = 'palette-generator:saved';
  const PREFS_KEY = 'palette-generator:prefs';
  const EXTRACT_COUNT = 5;
  const POOL_SIZE = 10; // colors kept from an image/cover for re-mixing on Space
  const SAMPLE_SIZE = 160; // longest side, in px, of the downscaled image we sample

  const $ = (sel) => document.querySelector(sel);

  const els = {
    palette: $('#palette'),
    mode: $('#mode'),
    format: $('#format'),
    generate: $('#generate'),
    undo: $('#undo'),
    add: $('#add'),
    save: $('#save'),
    image: $('#image'),
    imageInput: $('#image-input'),
    dropOverlay: $('#drop-overlay'),
    source: $('#source'),
    sourceImg: $('#source-img'),
    sourceClose: $('#source-close'),
    sourceCaption: $('#source-caption'),
    song: $('#song'),
    songDialog: $('#song-dialog'),
    songForm: $('#song-form'),
    songUrl: $('#song-url'),
    songGo: $('#song-go'),
    songStatus: $('#song-status'),
    library: $('#library'),
    exportBtn: $('#export'),
    exportDialog: $('#export-dialog'),
    exportTabs: $('#export-tabs'),
    exportCode: $('#export-code'),
    copyCode: $('#copy-code'),
    copyLink: $('#copy-link'),
    downloadPng: $('#download-png'),
    libraryDialog: $('#library-dialog'),
    libraryList: $('#library-list'),
    libraryEmpty: $('#library-empty'),
    toast: $('#toast'),
  };

  const state = {
    colors: [], // [{ hex: '#RRGGBB', locked: boolean }]
    mode: 'random',
    format: 'hex',
    exportKind: 'css',
  };
  const undoStack = [];
  // While a source thumbnail is shown, Generate re-mixes from it:
  // { kind: 'image', pool } or { kind: 'song', pool, ranked, confident }
  let activeSource = null;

  /* ---------------------------------------------------------------------- */
  /* Color math                                                              */
  /* ---------------------------------------------------------------------- */

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const rand = (lo, hi) => lo + Math.random() * (hi - lo);
  const wrapHue = (h) => ((h % 360) + 360) % 360;
  const mod = (n, m) => ((n % m) + m) % m;

  function hslToRgb(h, s, l) {
    s /= 100;
    l /= 100;
    const a = s * Math.min(l, 1 - l);
    const f = (n) => {
      const k = (n + h / 30) % 12;
      return l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    };
    return [f(0), f(8), f(4)].map((v) => Math.round(v * 255));
  }

  function rgbToHsl(r, g, b) {
    r /= 255; g /= 255; b /= 255;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const d = max - min;
    const l = (max + min) / 2;
    let h = 0;
    let s = 0;
    if (d) {
      s = d / (1 - Math.abs(2 * l - 1));
      if (max === r) h = ((g - b) / d) % 6;
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return [wrapHue(h), s * 100, l * 100];
  }

  const rgbToHex = (rgb) =>
    '#' + rgb.map((v) => v.toString(16).padStart(2, '0')).join('').toUpperCase();

  function hexToRgb(str) {
    let s = String(str).trim().replace(/^#/, '');
    if (/^[0-9a-f]{3}$/i.test(s)) s = s.split('').map((c) => c + c).join('');
    if (!/^[0-9a-f]{6}$/i.test(s)) return null;
    return [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16));
  }

  const normalizeHex = (str) => {
    const rgb = hexToRgb(str);
    return rgb ? rgbToHex(rgb) : null;
  };

  function luminance(rgb) {
    const [r, g, b] = rgb.map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  }

  function contrastRatio(a, b) {
    const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
    return (hi + 0.05) / (lo + 0.05);
  }

  /** Best readable text color (black or white) for a background, plus its contrast. */
  function textColorFor(hex) {
    const rgb = hexToRgb(hex);
    const onWhite = contrastRatio(rgb, [255, 255, 255]);
    const onBlack = contrastRatio(rgb, [0, 0, 0]);
    return onWhite >= onBlack
      ? { fg: '#FFFFFF', ratio: onWhite }
      : { fg: '#111111', ratio: onBlack };
  }

  const wcagLevel = (ratio) => (ratio >= 7 ? 'AAA' : ratio >= 4.5 ? 'AA' : ratio >= 3 ? 'AA Large' : 'Fail');

  function formatColor(hex, format) {
    const rgb = hexToRgb(hex);
    if (format === 'rgb') return `rgb(${rgb.join(', ')})`;
    if (format === 'hsl') {
      const [h, s, l] = rgbToHsl(...rgb).map(Math.round);
      return `hsl(${h}, ${s}%, ${l}%)`;
    }
    return hex;
  }

  /* ---------------------------------------------------------------------- */
  /* Generation                                                              */
  /* ---------------------------------------------------------------------- */

  const GOLDEN_ANGLE = 137.508;
  const HARMONY_OFFSETS = {
    complementary: [0, 180],
    split: [0, 150, 210],
    triadic: [0, 120, 240],
    tetradic: [0, 90, 180, 270],
  };

  function randomBase(mode) {
    if (mode === 'earthy') return { h: rand(10, 110), s: rand(20, 45), l: rand(35, 55) };
    return { h: rand(0, 360), s: rand(55, 85), l: rand(40, 62) };
  }

  /**
   * HSL for slot `i` of `n`. `k` is the slot's offset from the anchor
   * (a locked color, if any), so harmonies are built around what the user locked.
   */
  function generateHsl(mode, base, k, i, n) {
    if (HARMONY_OFFSETS[mode]) {
      const offsets = HARMONY_OFFSETS[mode];
      return [
        base.h + offsets[mod(k, offsets.length)] + rand(-8, 8),
        clamp(base.s + rand(-15, 15), 30, 95),
        clamp(base.l + rand(-24, 24), 22, 85),
      ];
    }
    switch (mode) {
      case 'analogous': {
        const step = n > 1 ? 80 / (n - 1) : 0;
        return [
          base.h + k * step + rand(-4, 4),
          clamp(base.s + rand(-15, 15), 35, 92),
          clamp(base.l + (i % 2 ? -1 : 1) * rand(4, 20), 22, 85),
        ];
      }
      case 'monochromatic': {
        const t = n > 1 ? i / (n - 1) : 0.5;
        return [base.h + rand(-3, 3), clamp(base.s + rand(-12, 12), 20, 90), 14 + t * 74];
      }
      case 'pastel':
        return [base.h + k * GOLDEN_ANGLE + rand(-10, 10), rand(55, 85), rand(78, 88)];
      case 'vivid':
        return [base.h + k * GOLDEN_ANGLE + rand(-10, 10), rand(80, 100), rand(46, 58)];
      case 'earthy':
        return [base.h + rand(-35, 35), rand(18, 45), rand(22, 70)];
      default: // random — golden-angle hue steps keep neighbours distinct
        return [base.h + k * GOLDEN_ANGLE + rand(-12, 12), rand(45, 90), rand(28, 78)];
    }
  }

  const hslToHex = ([h, s, l]) => rgbToHex(hslToRgb(wrapHue(h), clamp(s, 0, 100), clamp(l, 0, 100)));

  function generate() {
    if (activeSource) {
      generateFromSource();
      return;
    }
    pushUndo();
    const n = state.colors.length;
    const anchor = state.colors.findIndex((c) => c.locked);
    let base = randomBase(state.mode);
    if (anchor >= 0) {
      const [h, s, l] = rgbToHsl(...hexToRgb(state.colors[anchor].hex));
      base = { h, s, l };
    }
    const origin = anchor >= 0 ? anchor : 0;
    state.colors = state.colors.map((c, i) =>
      c.locked ? c : { hex: hslToHex(generateHsl(state.mode, base, i - origin, i, n)), locked: false }
    );
    render();
  }

  /* ---------------------------------------------------------------------- */
  /* Undo                                                                    */
  /* ---------------------------------------------------------------------- */

  const snapshot = () => state.colors.map((c) => ({ ...c }));

  function pushUndo() {
    undoStack.push(snapshot());
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();
    els.undo.disabled = false;
  }

  function undo() {
    if (!undoStack.length) return;
    state.colors = undoStack.pop();
    render();
  }

  /* ---------------------------------------------------------------------- */
  /* Rendering                                                               */
  /* ---------------------------------------------------------------------- */

  const ICONS = {
    locked: '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>',
    unlocked: '<svg viewBox="0 0 24 24"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/></svg>',
    remove: '<svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg>',
    drag: '<svg viewBox="0 0 24 24"><path d="M5 9l-3 3 3 3M19 9l3 3-3 3M2 12h20"/></svg>',
    edit: '<svg viewBox="0 0 24 24"><path d="M12 22a10 10 0 1 1 10-10c0 2.5-2 4-4.5 4H15a2 2 0 0 0-1.5 3.3A1.6 1.6 0 0 1 12 22z"/><circle cx="7.5" cy="10.5" r="1"/><circle cx="12" cy="7" r="1"/><circle cx="16.5" cy="10.5" r="1"/></svg>',
    copy: '<svg viewBox="0 0 24 24"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>',
  };

  function createSwatch() {
    const el = document.createElement('section');
    el.className = 'swatch';
    el.innerHTML = `
      <div class="swatch-actions">
        <button class="swatch-btn remove" data-action="remove" title="Remove color" aria-label="Remove color">${ICONS.remove}</button>
        <button class="swatch-btn drag" data-action="drag" title="Drag to reorder" aria-label="Drag to reorder">${ICONS.drag}</button>
        <label class="swatch-btn edit" title="Pick color">${ICONS.edit}<input type="color" aria-label="Pick color"></label>
        <button class="swatch-btn copy" data-action="copy" title="Copy" aria-label="Copy color">${ICONS.copy}</button>
        <button class="swatch-btn lock" data-action="lock"></button>
      </div>
      <div class="swatch-info">
        <button class="code-btn" data-action="copy" title="Click to copy"></button>
        <div class="meta"></div>
      </div>`;
    return el;
  }

  function paintSwatch(el, color) {
    const { fg, ratio } = textColorFor(color.hex);
    el.style.setProperty('--c', color.hex);
    el.style.setProperty('--fg', fg);
    el.classList.toggle('locked', color.locked);

    const code = el.querySelector('.code-btn');
    code.textContent = formatColor(color.hex, state.format);
    code.classList.toggle('small', state.format !== 'hex');

    el.querySelector('.meta').innerHTML =
      `<span class="badge">${wcagLevel(ratio)}</span><span>${ratio.toFixed(1)}:1</span>`;
    el.querySelector('.meta').title = `Contrast of ${fg === '#FFFFFF' ? 'white' : 'black'} text on this color`;

    const lock = el.querySelector('.lock');
    lock.innerHTML = color.locked ? ICONS.locked : ICONS.unlocked;
    lock.title = color.locked ? 'Unlock color' : 'Lock color';
    lock.setAttribute('aria-label', lock.title);
    lock.setAttribute('aria-pressed', String(color.locked));

    const input = el.querySelector('input[type="color"]');
    if (document.activeElement !== input) input.value = color.hex.toLowerCase();
  }

  function render() {
    const n = state.colors.length;
    const swatches = els.palette.children;
    while (swatches.length < n) els.palette.appendChild(createSwatch());
    while (swatches.length > n) els.palette.lastElementChild.remove();

    state.colors.forEach((color, i) => {
      const el = swatches[i];
      el.dataset.index = i;
      el.setAttribute('aria-label', `Color ${i + 1}: ${color.hex}${color.locked ? ' (locked)' : ''}`);
      el.querySelector('.remove').hidden = n <= MIN_COLORS;
      paintSwatch(el, color);
    });

    els.add.disabled = n >= MAX_COLORS;
    els.undo.disabled = undoStack.length === 0;
    updateUrl();
    document.title = `Palette · ${state.colors.map((c) => c.hex).join(' ')}`;
  }

  /* ---------------------------------------------------------------------- */
  /* URL sharing                                                             */
  /* ---------------------------------------------------------------------- */

  const paletteSlug = () => state.colors.map((c) => c.hex.slice(1)).join('-');

  function updateUrl() {
    try {
      history.replaceState(null, '', '#' + paletteSlug());
    } catch (_) { /* sandboxed or file:// — not fatal */ }
  }

  function colorsFromHash() {
    const parts = decodeURIComponent(location.hash.slice(1)).split(/[-,\s]+/).filter(Boolean);
    const hexes = parts.map(normalizeHex);
    if (hexes.length < MIN_COLORS || hexes.length > MAX_COLORS || hexes.some((h) => !h)) return null;
    return hexes;
  }

  const shareUrl = () => location.href.split('#')[0] + '#' + paletteSlug();

  /* ---------------------------------------------------------------------- */
  /* Storage (always optional — the app works without it)                    */
  /* ---------------------------------------------------------------------- */

  function readJson(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) {
      return fallback;
    }
  }

  function writeJson(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (_) {
      return false;
    }
  }

  const savePrefs = () => writeJson(PREFS_KEY, { mode: state.mode, format: state.format });

  function getLibrary() {
    const lib = readJson(LIBRARY_KEY, []);
    return Array.isArray(lib) ? lib.filter((p) => Array.isArray(p.colors)) : [];
  }

  function savePalette() {
    const colors = state.colors.map((c) => c.hex);
    const lib = getLibrary();
    const key = colors.join();
    if (lib.some((p) => p.colors.join() === key)) {
      toast('Already saved');
      return;
    }
    lib.unshift({ colors, created: Date.now() });
    toast(writeJson(LIBRARY_KEY, lib) ? 'Palette saved' : 'Could not save (storage unavailable)');
  }

  function renderLibrary() {
    const lib = getLibrary();
    els.libraryEmpty.hidden = lib.length > 0;
    els.libraryList.innerHTML = '';
    lib.forEach((p, idx) => {
      const li = document.createElement('li');
      li.className = 'library-item';

      const strip = document.createElement('button');
      strip.className = 'library-strip';
      strip.title = 'Load ' + p.colors.join(' ');
      strip.setAttribute('aria-label', strip.title);
      p.colors.forEach((hex) => {
        const span = document.createElement('span');
        span.style.background = normalizeHex(hex) || '#000';
        strip.appendChild(span);
      });
      strip.addEventListener('click', () => {
        loadColors(p.colors);
        els.libraryDialog.close();
        toast('Palette loaded');
      });

      const del = document.createElement('button');
      del.className = 'btn icon ghost';
      del.title = 'Delete';
      del.setAttribute('aria-label', 'Delete palette');
      del.innerHTML = '<svg viewBox="0 0 24 24"><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>';
      del.addEventListener('click', () => {
        const next = getLibrary();
        next.splice(idx, 1);
        writeJson(LIBRARY_KEY, next);
        renderLibrary();
      });

      li.append(strip, del);
      els.libraryList.appendChild(li);
    });
  }

  function loadColors(hexes) {
    const valid = hexes.map(normalizeHex).filter(Boolean).slice(0, MAX_COLORS);
    if (valid.length < MIN_COLORS) return;
    pushUndo();
    state.colors = valid.map((hex) => ({ hex, locked: false }));
    render();
  }

  /* ---------------------------------------------------------------------- */
  /* Export                                                                  */
  /* ---------------------------------------------------------------------- */

  function exportText(kind) {
    const hexes = state.colors.map((c) => c.hex);
    const values = hexes.map((h) => formatColor(h, state.format));
    switch (kind) {
      case 'scss':
        return values.map((v, i) => `$color-${i + 1}: ${v};`).join('\n');
      case 'tailwind':
        return [
          '// tailwind.config.js',
          'module.exports = {',
          '  theme: {',
          '    extend: {',
          '      colors: {',
          '        palette: {',
          ...hexes.map((h, i) => `          ${i + 1}: '${h}',`),
          '        },',
          '      },',
          '    },',
          '  },',
          '};',
        ].join('\n');
      case 'json':
        return JSON.stringify(
          hexes.map((hex) => ({
            hex,
            rgb: formatColor(hex, 'rgb'),
            hsl: formatColor(hex, 'hsl'),
          })),
          null,
          2
        );
      case 'array':
        return JSON.stringify(hexes);
      default:
        return `:root {\n${values.map((v, i) => `  --color-${i + 1}: ${v};`).join('\n')}\n}`;
    }
  }

  function showExport(kind) {
    state.exportKind = kind;
    els.exportTabs.querySelectorAll('[role="tab"]').forEach((tab) =>
      tab.setAttribute('aria-selected', String(tab.dataset.kind === kind))
    );
    els.exportCode.value = exportText(kind);
  }

  function downloadPng() {
    const W = 1600;
    const H = 900;
    const canvas = document.createElement('canvas');
    canvas.width = W;
    canvas.height = H;
    const ctx = canvas.getContext('2d');
    const n = state.colors.length;
    const colW = W / n;
    const fontSize = Math.round(Math.min(40, colW / 6));
    ctx.font = `600 ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';

    state.colors.forEach((c, i) => {
      const x = Math.floor(i * colW);
      ctx.fillStyle = c.hex;
      ctx.fillRect(x, 0, Math.ceil(colW) + 1, H);
      ctx.fillStyle = textColorFor(c.hex).fg;
      ctx.fillText(c.hex, x + colW / 2, H - 60);
    });

    const name = `palette-${paletteSlug()}.png`;
    canvas.toBlob((blob) => {
      if (!blob) return toast('Could not create image');
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    }, 'image/png');
  }

  /* ---------------------------------------------------------------------- */
  /* Image extraction (all local: the file never leaves the browser)         */
  /* ---------------------------------------------------------------------- */

  function loadImage(url, crossOrigin = false) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      if (crossOrigin) img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error('unreadable'));
      img.src = url;
    });
  }

  /** Show the source image as a small thumbnail; it keeps the object URL alive until replaced. */
  function showSource(url, caption = []) {
    hideSource();
    els.sourceImg.src = url;
    els.sourceCaption.replaceChildren(
      ...caption.map((text, i) => {
        const el = document.createElement(i === 0 ? 'strong' : 'span');
        el.textContent = text;
        el.title = text;
        return el;
      })
    );
    els.sourceCaption.hidden = caption.length === 0;
    els.source.hidden = false;
  }

  function hideSource() {
    if (els.sourceImg.src.startsWith('blob:')) URL.revokeObjectURL(els.sourceImg.src);
    els.sourceImg.removeAttribute('src');
    els.sourceCaption.replaceChildren();
    activeSource = null;
    els.source.hidden = true;
  }

  /**
   * Downscale the image and return its opaque pixels as [r, g, b] triples.
   * `cropY` trims that fraction off the top and bottom (e.g. letterbox bars).
   */
  function samplePixels(img, cropY = 0) {
    const srcH = img.naturalHeight * (1 - 2 * cropY);
    const scale = Math.min(1, SAMPLE_SIZE / Math.max(img.naturalWidth, srcH));
    const w = Math.max(1, Math.round(img.naturalWidth * scale));
    const h = Math.max(1, Math.round(srcH * scale));
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, img.naturalHeight * cropY, img.naturalWidth, srcH, 0, 0, w, h);
    const data = ctx.getImageData(0, 0, w, h).data;
    const pixels = [];
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] >= 128) pixels.push([data[i], data[i + 1], data[i + 2]]);
    }
    return pixels;
  }

  const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;

  /** k-means with k-means++ seeding. Returns clusters sorted by size, largest first. */
  function kmeans(points, k, maxIterations = 20) {
    const centers = [points[Math.floor(Math.random() * points.length)].slice()];
    const nearest = new Float64Array(points.length).fill(Infinity);
    while (centers.length < k) {
      const last = centers[centers.length - 1];
      let total = 0;
      for (let i = 0; i < points.length; i++) {
        nearest[i] = Math.min(nearest[i], dist2(points[i], last));
        total += nearest[i];
      }
      if (!total) break; // fewer distinct colors than k
      let r = Math.random() * total;
      let idx = 0;
      while (idx < points.length - 1 && (r -= nearest[idx]) > 0) idx++;
      centers.push(points[idx].slice());
    }

    let sums = [];
    for (let iter = 0; iter < maxIterations; iter++) {
      sums = centers.map(() => [0, 0, 0, 0]);
      for (const p of points) {
        let best = 0;
        let bestD = Infinity;
        for (let j = 0; j < centers.length; j++) {
          const d = dist2(p, centers[j]);
          if (d < bestD) { bestD = d; best = j; }
        }
        const s = sums[best];
        s[0] += p[0]; s[1] += p[1]; s[2] += p[2]; s[3]++;
      }
      let moved = false;
      sums.forEach((s, j) => {
        if (!s[3]) return;
        const next = [s[0] / s[3], s[1] / s[3], s[2] / s[3]];
        if (dist2(next, centers[j]) > 1) moved = true;
        centers[j] = next;
      });
      if (!moved) break;
    }

    return centers
      .map((c, j) => ({ rgb: c.map(Math.round), count: sums[j][3] }))
      .filter((c) => c.count > 0)
      .sort((a, b) => b.count - a.count);
  }

  /** Wider set of an image's colors, weighted so minor colors still get picked sometimes. */
  const colorPool = (pixels) =>
    kmeans(pixels, POOL_SIZE).map((c) => ({ hex: rgbToHex(c.rgb), weight: Math.sqrt(c.count) }));

  /** For images with fewer distinct colors than needed: add shades of the first color. */
  function padWithShades(hexes, n) {
    const out = hexes.slice(0, n);
    if (!out.length) return out; // nothing to base shades on; caller fills the rest
    const [h, s] = rgbToHsl(...hexToRgb(out[0]));
    for (let i = out.length; i < n; i++) out.push(hslToHex([h, s, 15 + (i / n) * 75]));
    return out;
  }

  const sortByLightness = (hexes) =>
    hexes.slice().sort((a, b) => rgbToHsl(...hexToRgb(a))[2] - rgbToHsl(...hexToRgb(b))[2]);

  /**
   * Weighted random pick of `count` pool colors, preferring ones that aren't
   * near-duplicates of each other or of `avoid` (e.g. locked colors).
   */
  function pickFromPool(pool, count, rng, avoid = []) {
    const MIN_DIST = 40 ** 2;
    const remaining = pool.slice();
    const chosen = [];
    const tooClose = [];
    while (chosen.length < count && remaining.length) {
      const total = remaining.reduce((sum, c) => sum + c.weight, 0);
      let r = rng() * total;
      let idx = 0;
      while (idx < remaining.length - 1 && (r -= remaining[idx].weight) > 0) idx++;
      const [c] = remaining.splice(idx, 1);
      const rgb = hexToRgb(c.hex);
      const near = [...avoid, ...chosen].some((h) => dist2(hexToRgb(h), rgb) < MIN_DIST);
      (near ? tooClose : chosen).push(c.hex);
    }
    return padWithShades(chosen.concat(tooClose), count);
  }

  /** Re-mix the palette from the active image or song, keeping locked colors. */
  function generateFromSource() {
    pushUndo();
    const locked = state.colors.filter((c) => c.locked).map((c) => c.hex);
    const free = state.colors.length - locked.length;
    if (free > 0) {
      const src = activeSource;
      const hexes =
        src.kind === 'song'
          ? songHexes(src, free, Math.random, pickFromPool(src.pool, free, Math.random, locked), Math.floor(Math.random() * 4))
          : sortByLightness(pickFromPool(src.pool, free, Math.random, locked));
      let k = 0;
      state.colors = state.colors.map((c) => (c.locked ? c : { hex: hexes[k++], locked: false }));
    }
    render();
  }

  async function extractFromImage(file) {
    if (!file || !file.type.startsWith('image/')) {
      toast('That file is not an image');
      return;
    }
    const url = URL.createObjectURL(file);
    let pixels;
    try {
      pixels = samplePixels(await loadImage(url));
    } catch (_) {
      URL.revokeObjectURL(url);
      toast('Could not read that image');
      return;
    }
    if (!pixels.length) {
      URL.revokeObjectURL(url);
      toast('Image has no visible pixels');
      return;
    }
    const hexes = padWithShades(kmeans(pixels, EXTRACT_COUNT).map((c) => rgbToHex(c.rgb)), EXTRACT_COUNT);
    loadColors(hexes);
    showSource(url, ['Your image', 'Space: new mix from this image']);
    activeSource = { kind: 'image', pool: colorPool(pixels) };
    toast('Palette extracted from image');
  }

  /* ---------------------------------------------------------------------- */
  /* Song → palette                                                          */
  /* Uses only keyless, CORS-enabled endpoints: YouTube oEmbed + thumbnails, */
  /* lyrics.ovh, lrclib.net. Mood is guessed locally from a word lexicon.    */
  /* ---------------------------------------------------------------------- */

  const MOODS = {
    happy: {
      label: 'Happy', weight: 1, hues: [48, 30, 58, 195], s: [75, 95], l: [55, 70],
      words: 'happy happiness smile smiling sun sunshine sunny laugh laughing joy joyful bright shine shining wonderful celebrate celebration fun glad lucky alive free freedom summer golden paradise hallelujah delight cheer good beautiful',
    },
    love: {
      // Nearly every song mentions love, so it counts for less
      label: 'Romantic', weight: 0.6, hues: [345, 330, 8, 318], s: [55, 80], l: [45, 75],
      words: 'love lover lovers baby babe darling kiss kisses heart hearts hold touch forever together honey romance romantic desire adore embrace sugar cherish wedding valentine',
    },
    sad: {
      label: 'Melancholy', weight: 1, hues: [215, 230, 200, 250], s: [22, 48], l: [25, 62],
      words: 'sad sadness cry tears alone lonely loneliness goodbye gone miss missing broken hurt hurts pain sorrow lost lose empty cold rain grief regret sorry die dying dead funeral apart leave leaving ballad heartbreak heartache hollow numb blue',
    },
    angry: {
      label: 'Intense', weight: 1, hues: [0, 12, 355, 22], s: [75, 95], l: [28, 48],
      words: 'hate fight fighting fire burn burning rage kill blood scream war gun mad angry anger enemy revenge destroy smash fury violent violence devil hell damn metal punk riot bullet',
    },
    calm: {
      label: 'Calm', weight: 1, hues: [170, 150, 195, 125], s: [25, 50], l: [60, 82],
      words: 'calm peace peaceful quiet slow gentle soft breathe ocean sea river wave waves breeze float rest sleep still easy lullaby acoustic lofi chill relax relaxing garden morning meadow',
    },
    energetic: {
      label: 'Energetic', weight: 1, hues: [300, 280, 180, 52], s: [85, 100], l: [50, 60],
      words: 'dance dancing party jump run wild crazy loud move shake club tonight fast beat bounce energy electric remix rave edm boom groove disco hype',
    },
    dark: {
      label: 'Dark', weight: 1, hues: [270, 260, 240, 340], s: [20, 50], l: [10, 30],
      words: 'dark darkness shadow shadows midnight ghost ghosts demon demons death black grave secret mystery haunt haunted fear nightmare moon poison sin void abyss smoke monster witch curse',
    },
    nostalgic: {
      label: 'Nostalgic', weight: 1, hues: [30, 280, 340, 200], s: [28, 55], l: [65, 82],
      words: 'remember memory memories yesterday youth young childhood photograph dream dreams dreaming ago faded vintage nostalgia reminisce someday wish',
    },
  };

  const MOOD_LEXICON = new Map();
  for (const [mood, def] of Object.entries(MOODS)) {
    for (const w of def.words.split(' ')) MOOD_LEXICON.set(w, mood);
  }

  function lexiconMood(token) {
    const candidates = [token, token.replace(/s$/, ''), token.replace(/(ing|in|ed)$/, ''), token.replace(/(ing|in|ed)$/, 'e')];
    for (const c of candidates) if (MOOD_LEXICON.has(c)) return MOOD_LEXICON.get(c);
    return null;
  }

  /** Score each mood from title (weighted ×3) and lyrics. Returns moods sorted by share. */
  function analyzeMood(title, lyrics) {
    const scores = Object.fromEntries(Object.keys(MOODS).map((m) => [m, 0]));
    const tally = (text, weight) => {
      const tokens = text.toLowerCase().replace(/[’']/g, '').match(/[a-z]+/g) || [];
      for (const t of tokens) {
        const mood = lexiconMood(t);
        if (mood) scores[mood] += weight * MOODS[mood].weight;
      }
    };
    tally(title, 3);
    tally(lyrics || '', 1);
    const total = Object.values(scores).reduce((a, b) => a + b, 0);
    return {
      total,
      ranked: Object.entries(scores)
        .filter(([, v]) => v > 0)
        .sort((a, b) => b[1] - a[1])
        .map(([mood, v]) => ({ mood, share: v / total })),
    };
  }

  /** Small deterministic PRNG so the same song always gives the same palette. */
  function seededRandom(seed) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    return () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return (h >>> 0) / 4294967296;
    };
  }

  function moodColor(mood, slot, rng) {
    const def = MOODS[mood];
    const between = ([lo, hi]) => lo + rng() * (hi - lo);
    return hslToHex([def.hues[slot % def.hues.length] + (rng() - 0.5) * 16, between(def.s), between(def.l)]);
  }

  function youtubeId(input) {
    const raw = input.trim();
    if (/^[\w-]{11}$/.test(raw)) return raw;
    let url;
    try {
      url = new URL(/^https?:\/\//i.test(raw) ? raw : 'https://' + raw);
    } catch (_) {
      return null;
    }
    const host = url.hostname.replace(/^(www|m|music)\./, '');
    let id = null;
    if (host === 'youtu.be') id = url.pathname.split('/')[1];
    else if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      id = url.searchParams.get('v') || (url.pathname.match(/^\/(?:shorts|embed|live|v)\/([\w-]{11})/) || [])[1];
    }
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  }

  /** Turn "Artist - Song (Official Video) ft. X" + channel name into { artist, track }. */
  function parseSong(title, channel) {
    let track = title
      .replace(/\s*[([][^)\]]*[)\]]/g, '') // (Official Video), [4K], (Lyrics) …
      .replace(/\s*\|.*$/, '')
      .replace(/\s+(ft\.?|feat\.?|featuring)\s.*$/i, '')
      .replace(/["“”]/g, '')
      .trim();
    let artist = channel.replace(/\s*-\s*Topic$/i, '').replace(/VEVO$/i, '').trim();
    const m = track.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    if (m) {
      artist = m[1].replace(/\s+(ft\.?|feat\.?|&|x)\s.*$/i, '').trim();
      track = m[2].trim();
    }
    return { artist, track: track || title };
  }

  async function fetchJson(url, ms = 8000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return await res.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function fetchLyrics(artist, track) {
    const a = encodeURIComponent(artist);
    const t = encodeURIComponent(track);
    try {
      const data = await fetchJson(`https://api.lyrics.ovh/v1/${a}/${t}`);
      if (data.lyrics && data.lyrics.trim()) return data.lyrics;
    } catch (_) { /* try the next source */ }
    try {
      const data = await fetchJson(`https://lrclib.net/api/get?artist_name=${a}&track_name=${t}`);
      if (data.plainLyrics) return data.plainLyrics;
    } catch (_) { /* no lyrics available */ }
    return null;
  }

  /**
   * Build `n` colors for a song: mostly from its top two moods, plus some from the cover.
   * `slotBase` shifts which mood hues are used, so re-mixes vary.
   */
  function songHexes(src, n, rng, coverHexes, slotBase = 0) {
    const { ranked, confident } = src;
    const hexes = [];
    if (confident) {
      const coverCount = Math.min(coverHexes.length, Math.round((n * 2) / 5));
      const moodCount = n - coverCount;
      const primary = ranked[0].mood;
      const secondary = ranked[1] && ranked[1].mood;
      const primaryCount = secondary ? Math.ceil((moodCount * 2) / 3) : moodCount;
      for (let j = 0; j < primaryCount; j++) hexes.push(moodColor(primary, slotBase + j, rng));
      for (let j = primaryCount; j < moodCount; j++) hexes.push(moodColor(secondary, slotBase + j - primaryCount, rng));
      hexes.push(...coverHexes.slice(0, coverCount));
    } else {
      hexes.push(...coverHexes.slice(0, n));
    }
    // Top up from the strongest mood (or a neutral fallback) if anything was missing
    const fill = ranked[0] ? ranked[0].mood : 'calm';
    for (let slot = slotBase + 3; hexes.length < n; slot++) hexes.push(moodColor(fill, slot, rng));
    return sortByLightness(hexes);
  }

  function setSongStatus(text, isError = false) {
    els.songStatus.textContent = text;
    els.songStatus.classList.toggle('error', isError);
  }

  async function paletteFromSong(input) {
    const id = youtubeId(input);
    if (!id) {
      setSongStatus('That doesn’t look like a YouTube link.', true);
      return;
    }

    els.songGo.disabled = true;
    try {
      setSongStatus('Finding the video…');
      let info;
      try {
        info = await fetchJson(
          'https://www.youtube.com/oembed?format=json&url=' + encodeURIComponent('https://www.youtube.com/watch?v=' + id)
        );
      } catch (_) {
        setSongStatus('Couldn’t find that video. It may be private, removed, or not embeddable.', true);
        return;
      }
      const { artist, track } = parseSong(info.title || '', info.author_name || '');

      setSongStatus(`Looking up lyrics for “${track}”…`);
      const lyrics = await fetchLyrics(artist, track);

      setSongStatus('Reading the cover art…');
      const thumbUrl = `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
      let coverColors = [];
      let pool = [];
      try {
        // hqdefault is 4:3 with letterbox bars on 16:9 videos — crop them off
        const pixels = samplePixels(await loadImage(thumbUrl, true), 0.125);
        coverColors = kmeans(pixels, EXTRACT_COUNT).map((c) => rgbToHex(c.rgb));
        pool = colorPool(pixels);
      } catch (_) { /* palette can still come from the mood */ }

      const { total, ranked } = analyzeMood(info.title || '', lyrics);
      const confident = total >= 3 && ranked.length > 0;
      const song = { kind: 'song', pool, ranked, confident };
      const hexes = songHexes(song, EXTRACT_COUNT, seededRandom(id), coverColors);

      const moodText = confident
        ? 'Mood: ' + ranked.slice(0, 2).map((r) => `${MOODS[r.mood].label} ${Math.round(r.share * 100)}%`).join(' · ')
        : 'Mood unclear — colors from the cover';
      const basis = lyrics ? 'Based on lyrics + cover' : 'No lyrics found — title + cover';

      loadColors(hexes);
      showSource(thumbUrl, [track, artist, moodText, basis, 'Space: new mix from this song']);
      activeSource = song;
      els.songDialog.close();
      setSongStatus('');
      toast(confident ? `${MOODS[ranked[0].mood].label} palette for “${track}”` : `Palette from “${track}” cover`);
    } finally {
      els.songGo.disabled = false;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* Clipboard & toast                                                       */
  /* ---------------------------------------------------------------------- */

  async function copyText(text, message = 'Copied ' + text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (_) {
      // Fallback for non-secure contexts (e.g. opening the file locally)
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); } catch (__) { /* ignore */ }
      ta.remove();
    }
    toast(message);
  }

  let toastTimer;
  function toast(message) {
    els.toast.textContent = message;
    els.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove('show'), 1600);
  }

  /* ---------------------------------------------------------------------- */
  /* Palette interactions                                                    */
  /* ---------------------------------------------------------------------- */

  const indexOf = (el) => Number(el.closest('.swatch').dataset.index);

  els.palette.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const i = indexOf(btn);
    const color = state.colors[i];
    switch (btn.dataset.action) {
      case 'lock':
        color.locked = !color.locked;
        render();
        break;
      case 'copy':
        copyText(formatColor(color.hex, state.format));
        break;
      case 'remove':
        if (state.colors.length <= MIN_COLORS) return;
        pushUndo();
        state.colors.splice(i, 1);
        render();
        break;
    }
  });

  // Color picker: snapshot once when the picker opens, then update live.
  els.palette.addEventListener('click', (e) => {
    if (e.target.matches('input[type="color"]')) pushUndo();
  });
  els.palette.addEventListener('input', (e) => {
    if (!e.target.matches('input[type="color"]')) return;
    const i = indexOf(e.target);
    state.colors[i].hex = normalizeHex(e.target.value);
    paintSwatch(e.target.closest('.swatch'), state.colors[i]);
  });
  els.palette.addEventListener('change', (e) => {
    if (!e.target.matches('input[type="color"]')) return;
    state.colors[indexOf(e.target)].locked = true; // a hand-picked color is worth keeping
    render();
  });

  // Drag to reorder — only starts from the drag handle so text stays selectable.
  let dragFrom = null;
  els.palette.addEventListener('pointerdown', (e) => {
    const handle = e.target.closest('[data-action="drag"]');
    if (handle) handle.closest('.swatch').draggable = true;
  });
  els.palette.addEventListener('pointerup', (e) => {
    const sw = e.target.closest('.swatch');
    if (sw && dragFrom === null) sw.draggable = false;
  });
  els.palette.addEventListener('dragstart', (e) => {
    const sw = e.target.closest('.swatch');
    if (!sw || !sw.draggable) return;
    dragFrom = Number(sw.dataset.index);
    sw.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', state.colors[dragFrom].hex);
  });
  els.palette.addEventListener('dragover', (e) => {
    if (dragFrom === null) return;
    e.preventDefault();
    const sw = e.target.closest('.swatch');
    els.palette.querySelectorAll('.drop-target').forEach((el) => el !== sw && el.classList.remove('drop-target'));
    if (sw && Number(sw.dataset.index) !== dragFrom) sw.classList.add('drop-target');
  });
  els.palette.addEventListener('drop', (e) => {
    e.preventDefault();
    const sw = e.target.closest('.swatch');
    if (dragFrom === null || !sw) return;
    const to = Number(sw.dataset.index);
    if (to !== dragFrom) {
      pushUndo();
      const [moved] = state.colors.splice(dragFrom, 1);
      state.colors.splice(to, 0, moved);
      render();
    }
  });
  els.palette.addEventListener('dragend', () => {
    dragFrom = null;
    els.palette.querySelectorAll('.swatch').forEach((el) => {
      el.draggable = false;
      el.classList.remove('dragging', 'drop-target');
    });
  });

  /* ---------------------------------------------------------------------- */
  /* Toolbar                                                                 */
  /* ---------------------------------------------------------------------- */

  els.generate.addEventListener('click', generate);
  els.undo.addEventListener('click', undo);

  els.add.addEventListener('click', () => {
    if (state.colors.length >= MAX_COLORS) return;
    pushUndo();
    const last = state.colors[state.colors.length - 1];
    const [h, s, l] = rgbToHsl(...hexToRgb(last.hex));
    const hex = hslToHex(generateHsl(state.mode, { h, s, l }, 1, state.colors.length, state.colors.length + 1));
    state.colors.push({ hex, locked: false });
    render();
  });

  els.mode.addEventListener('change', () => {
    state.mode = els.mode.value;
    savePrefs();
    generate();
  });

  els.format.addEventListener('change', () => {
    state.format = els.format.value;
    savePrefs();
    render();
  });

  els.save.addEventListener('click', savePalette);

  els.image.addEventListener('click', () => els.imageInput.click());
  els.sourceClose.addEventListener('click', hideSource);

  els.song.addEventListener('click', () => {
    setSongStatus('');
    els.songDialog.showModal();
    els.songUrl.select();
  });
  els.songForm.addEventListener('submit', (e) => {
    e.preventDefault();
    paletteFromSong(els.songUrl.value);
  });
  els.imageInput.addEventListener('change', () => {
    extractFromImage(els.imageInput.files[0]);
    els.imageInput.value = ''; // allow picking the same file again
  });

  // Drop an image anywhere on the page
  const hasFiles = (e) => e.dataTransfer && [...e.dataTransfer.types].includes('Files');
  let dragDepth = 0;
  document.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    dragDepth++;
    els.dropOverlay.hidden = false;
  });
  document.addEventListener('dragleave', (e) => {
    if (!hasFiles(e)) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      els.dropOverlay.hidden = true;
    }
  });
  document.addEventListener('dragover', (e) => {
    if (hasFiles(e)) e.preventDefault();
  });
  document.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    els.dropOverlay.hidden = true;
    extractFromImage(e.dataTransfer.files[0]);
  });

  // Paste an image (e.g. a screenshot) with Ctrl+V
  document.addEventListener('paste', (e) => {
    const file = [...(e.clipboardData?.files || [])].find((f) => f.type.startsWith('image/'));
    if (!file) return;
    e.preventDefault();
    extractFromImage(file);
  });

  els.library.addEventListener('click', () => {
    renderLibrary();
    els.libraryDialog.showModal();
  });

  els.exportBtn.addEventListener('click', () => {
    showExport(state.exportKind);
    els.exportDialog.showModal();
  });
  els.exportTabs.addEventListener('click', (e) => {
    const tab = e.target.closest('[role="tab"]');
    if (tab) showExport(tab.dataset.kind);
  });
  els.copyCode.addEventListener('click', () => copyText(els.exportCode.value, 'Code copied'));
  els.copyLink.addEventListener('click', () => copyText(shareUrl(), 'Link copied'));
  els.downloadPng.addEventListener('click', downloadPng);

  // Close dialogs when clicking the backdrop
  [els.exportDialog, els.libraryDialog, els.songDialog].forEach((dlg) =>
    dlg.addEventListener('click', (e) => {
      if (e.target === dlg) dlg.close();
    })
  );

  /* ---------------------------------------------------------------------- */
  /* Keyboard                                                                */
  /* ---------------------------------------------------------------------- */

  const isTyping = (el) => el && el.matches('input, select, textarea, [contenteditable="true"]');
  const dialogOpen = () => els.exportDialog.open || els.libraryDialog.open || els.songDialog.open;

  document.addEventListener('keydown', (e) => {
    if (dialogOpen() || isTyping(e.target)) return;
    if (e.code === 'Space' && !e.repeat && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault(); // also stops Space from "clicking" a focused button
      generate();
    } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      undo();
    }
  });
  document.addEventListener('keyup', (e) => {
    if (e.code === 'Space' && !dialogOpen() && !isTyping(e.target)) e.preventDefault();
  });

  window.addEventListener('hashchange', () => {
    const hexes = colorsFromHash();
    if (hexes && hexes.join('-') !== state.colors.map((c) => c.hex).join('-')) loadColors(hexes);
  });

  /* ---------------------------------------------------------------------- */
  /* Init                                                                    */
  /* ---------------------------------------------------------------------- */

  const prefs = readJson(PREFS_KEY, {});
  if ([...els.mode.options].some((o) => o.value === prefs.mode)) state.mode = prefs.mode;
  if ([...els.format.options].some((o) => o.value === prefs.format)) state.format = prefs.format;
  els.mode.value = state.mode;
  els.format.value = state.format;

  const fromHash = colorsFromHash();
  if (fromHash) {
    state.colors = fromHash.map((hex) => ({ hex, locked: false }));
    render();
  } else {
    state.colors = Array.from({ length: DEFAULT_COLORS }, () => ({ hex: '#000000', locked: false }));
    generate();
    undoStack.length = 0;
    els.undo.disabled = true;
  }
})();

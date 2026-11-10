'use strict';

/* =====================================================================
   Pixelizer – conversion d'images en pixel art guidée par pipettes
   ===================================================================== */

const $ = (id) => document.getElementById(id);

const MAX_SRC = 1600;   // taille max (px) du côté le plus long de l'image de travail
const MAX_PICKS = 32;
const ZOOMS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 48, 64];

const state = {
  src: null,            // { w, h, data }  image de travail (RGBA)
  picks: [],            // [{ id, u, v, color:[r,g,b] }]
  nextId: 1,
  art: null,            // { w, h, data }  pixel art courant
  dirty: false,         // retouches manuelles effectuées ?
  undo: [],
  redo: [],
  view: 1,
  tool: 'pen',
  color: [231, 76, 60],
  zoom: 8,
  sel: null,            // sélection de recadrage { x0, y0, x1, y1 } (cellules)
};

/* ------------------------------ utilitaires ------------------------------ */

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const fromHex = (h) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

let toastTimer = 0;
function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
}

// Distance perceptuelle approchée entre deux couleurs RGB ("redmean").
function dist(r1, g1, b1, r2, g2, b2) {
  const rm = (r1 + r2) >> 1;
  const dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

/* ------------------------------ chargement ------------------------------ */

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    toast('Ce fichier n’est pas une image.');
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => {
    URL.revokeObjectURL(url);
    setSource(img);
  };
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast('Impossible de lire cette image.');
  };
  img.src = url;
}

function setSource(img) {
  let w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) {
    toast('Image sans dimensions exploitables.');
    return;
  }
  const s = Math.min(1, MAX_SRC / Math.max(w, h));
  w = Math.max(1, Math.round(w * s));
  h = Math.max(1, Math.round(h * s));

  const c = $('srcCanvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, 0, 0, w, h);
  state.src = { w, h, data: ctx.getImageData(0, 0, w, h).data };

  state.picks = [];
  $('srcInfo').textContent = `${w} × ${h} px`;
  $('controls').disabled = false;
  $('dropzone').hidden = true;
  $('panes').hidden = false;
  renderMarkers();
  renderPickList();
  if (state.view !== 1) showView(1, true);
  generate();
}

/* ------------------------------ pixellisation ------------------------------ */

function readParams() {
  return {
    width: clamp(parseInt($('width').value, 10) || 64, 8, 256),
    base: $('baseMode').value,
    alpha: parseInt($('alphaT').value, 10) / 100,
    tol: parseInt($('tol').value, 10),
    minShare: Math.max(0.02, 1 - parseInt($('priority').value, 10) / 100),
    exact: $('exact').checked,
    snap: $('snap').checked,
  };
}

function pixelate(src, P, picks) {
  const sw = src.w, sh = src.h, sd = src.data;
  const W = P.width;
  const H = Math.max(1, Math.round((W * sh) / sw));
  const out = new Uint8ClampedArray(W * H * 4);

  const K = picks.length;
  const pcR = picks.map((p) => p.color[0]);
  const pcG = picks.map((p) => p.color[1]);
  const pcB = picks.map((p) => p.color[2]);
  const cnt = new Uint32Array(K);
  const pr = new Float64Array(K), pg = new Float64Array(K), pb = new Float64Array(K);

  const dom = P.base === 'dominant';
  const bCnt = new Uint32Array(4096);
  const bR = new Float64Array(4096), bG = new Float64Array(4096), bB = new Float64Array(4096);
  const touched = [];

  for (let cy = 0; cy < H; cy++) {
    const y0 = Math.floor((cy * sh) / H);
    let y1 = Math.floor(((cy + 1) * sh) / H);
    if (y1 <= y0) y1 = y0 + 1;
    if (y1 > sh) y1 = sh;

    for (let cx = 0; cx < W; cx++) {
      const x0 = Math.floor((cx * sw) / W);
      let x1 = Math.floor(((cx + 1) * sw) / W);
      if (x1 <= x0) x1 = x0 + 1;
      if (x1 > sw) x1 = sw;

      let total = 0, opaque = 0, sR = 0, sG = 0, sB = 0;
      if (K) { cnt.fill(0); pr.fill(0); pg.fill(0); pb.fill(0); }
      touched.length = 0;

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * sw + x) * 4;
          total++;
          if (sd[i + 3] < 128) continue;       // pixel transparent : ignoré
          const r = sd[i], g = sd[i + 1], b = sd[i + 2];
          opaque++;
          sR += r; sG += g; sB += b;

          if (dom) {
            const bk = ((r >> 4) << 8) | ((g >> 4) << 4) | (b >> 4);
            if (bCnt[bk] === 0) touched.push(bk);
            bCnt[bk]++; bR[bk] += r; bG[bk] += g; bB[bk] += b;
          }
          if (K) {
            let best = -1, bd = P.tol;
            for (let k = 0; k < K; k++) {
              const d = dist(r, g, b, pcR[k], pcG[k], pcB[k]);
              if (d <= bd) { bd = d; best = k; }
            }
            if (best >= 0) { cnt[best]++; pr[best] += r; pg[best] += g; pb[best] += b; }
          }
        }
      }

      if (opaque > 0 && opaque / total >= P.alpha) {
        let r, g, b;
        if (dom) {
          let bestB = -1, bc = 0;
          for (const bk of touched) if (bCnt[bk] > bc) { bc = bCnt[bk]; bestB = bk; }
          r = bR[bestB] / bc; g = bG[bestB] / bc; b = bB[bestB] / bc;
        } else {
          r = sR / opaque; g = sG / opaque; b = sB / opaque;
        }

        if (K) {
          let kb = -1, kc = 0;
          for (let k = 0; k < K; k++) if (cnt[k] > kc) { kc = cnt[k]; kb = k; }
          if (kb >= 0 && kc / opaque >= P.minShare) {
            if (P.exact) { r = pcR[kb]; g = pcG[kb]; b = pcB[kb]; }
            else { r = pr[kb] / kc; g = pg[kb] / kc; b = pb[kb] / kc; }
          }
          if (P.snap) {
            let kn = 0, dn = Infinity;
            for (let k = 0; k < K; k++) {
              const d = dist(r, g, b, pcR[k], pcG[k], pcB[k]);
              if (d < dn) { dn = d; kn = k; }
            }
            r = pcR[kn]; g = pcG[kn]; b = pcB[kn];
          }
        }

        const o = (cy * W + cx) * 4;
        out[o] = r; out[o + 1] = g; out[o + 2] = b; out[o + 3] = 255;
      }

      if (dom) for (const bk of touched) { bCnt[bk] = 0; bR[bk] = 0; bG[bk] = 0; bB[bk] = 0; }
    }
  }
  return { w: W, h: H, data: out };
}

let genTimer = 0;
function scheduleGenerate() {
  clearTimeout(genTimer);
  genTimer = setTimeout(generate, 50);
}

function generate() {
  clearTimeout(genTimer);
  if (!state.src) return;
  state.art = pixelate(state.src, readParams(), state.picks);
  state.dirty = false;
  state.undo = [];
  state.redo = [];
  $('btnDownload').disabled = false;
  $('tab2').disabled = false;
  renderArt();
  layoutViews();
  updateInfo();
  updateUndoButtons();
}

/* ------------------------------ affichage ------------------------------ */

function renderArt() {
  const a = state.art;
  if (!a) return;
  for (const id of ['previewCanvas', 'editCanvas']) {
    const c = $(id);
    if (c.width !== a.w || c.height !== a.h) { c.width = a.w; c.height = a.h; }
    c.getContext('2d').putImageData(new ImageData(a.data, a.w, a.h), 0, 0);
  }
}

function fitCanvas(canvas, box, integer) {
  const bw = box.clientWidth - 16, bh = box.clientHeight - 16;
  if (bw <= 0 || bh <= 0 || !canvas.width) return;
  let s = Math.min(bw / canvas.width, bh / canvas.height);
  if (integer && s >= 1) s = Math.floor(s);
  canvas.style.width = Math.max(1, Math.round(canvas.width * s)) + 'px';
  canvas.style.height = Math.max(1, Math.round(canvas.height * s)) + 'px';
}

function layoutViews() {
  if (state.view !== 1 || !state.src) return;
  fitCanvas($('srcCanvas'), $('srcBox'), false);
  if (state.art) fitCanvas($('previewCanvas'), $('outBox'), true);
}

function countColors(a) {
  const set = new Set();
  const d = a.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] >= 128) set.add((d[i] << 16) | (d[i + 1] << 8) | d[i + 2]);
  }
  return set.size;
}

function updateInfo() {
  const a = state.art;
  if (!a) return;
  const txt = `${a.w} × ${a.h} px · ${countColors(a)} couleur(s)`;
  $('outInfo').textContent = txt;
  $('editInfo').textContent = txt;
  const s = parseInt($('exportScale').value, 10);
  $('exportInfo').textContent = `${a.w * s} × ${a.h * s} px`;
}

function updateSizeOut() {
  const W = clamp(parseInt($('width').value, 10) || 64, 8, 256);
  $('widthOut').textContent = state.src
    ? `${W} × ${Math.max(1, Math.round((W * state.src.h) / state.src.w))} px`
    : `${W} px`;
}

/* ------------------------------ pipettes ------------------------------ */

function sampleSource(u, v) {
  const { w, h, data } = state.src;
  const cx = clamp(Math.floor(u * w), 0, w - 1);
  const cy = clamp(Math.floor(v * h), 0, h - 1);
  const rr = Math.max(1, Math.round(Math.max(w, h) / 500));
  let n = 0, r = 0, g = 0, b = 0;
  for (let y = Math.max(0, cy - rr); y <= Math.min(h - 1, cy + rr); y++) {
    for (let x = Math.max(0, cx - rr); x <= Math.min(w - 1, cx + rr); x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 128) continue;
      n++; r += data[i]; g += data[i + 1]; b += data[i + 2];
    }
  }
  return n ? [Math.round(r / n), Math.round(g / n), Math.round(b / n)] : null;
}

function renderMarkers() {
  const host = $('markers');
  host.textContent = '';
  state.picks.forEach((p, i) => {
    const m = document.createElement('div');
    m.className = 'marker';
    m.dataset.id = p.id;
    m.style.left = p.u * 100 + '%';
    m.style.top = p.v * 100 + '%';
    m.style.setProperty('--c', hex(p.color));
    m.title = `Pipette ${i + 1} · glisser pour déplacer, double-clic pour supprimer`;
    m.textContent = i + 1;
    host.appendChild(m);
  });
}

function renderPickList() {
  const host = $('pickList');
  host.textContent = '';
  if (!state.picks.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Aucune pipette pour l’instant.';
    host.appendChild(p);
    return;
  }
  state.picks.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pick';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = i + 1;
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = hex(p.color);
    inp.addEventListener('input', () => {
      p.color = fromHex(inp.value);
      renderMarkers();
      scheduleGenerate();
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = '×';
    del.title = 'Supprimer cette pipette';
    del.addEventListener('click', () => removePick(p.id));
    row.append(badge, inp, del);
    host.appendChild(row);
  });
}

function removePick(id) {
  state.picks = state.picks.filter((p) => p.id !== id);
  renderMarkers();
  renderPickList();
  scheduleGenerate();
}

$('srcStage').addEventListener('click', (e) => {
  if (!state.src || e.target.closest('.marker')) return;
  const r = $('srcCanvas').getBoundingClientRect();
  const u = (e.clientX - r.left) / r.width;
  const v = (e.clientY - r.top) / r.height;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return;
  const col = sampleSource(u, v);
  if (!col) { toast('Ce point est transparent : visez une zone de l’image.'); return; }
  if (state.picks.length >= MAX_PICKS) { toast(`${MAX_PICKS} pipettes maximum.`); return; }
  state.picks.push({ id: state.nextId++, u, v, color: col });
  renderMarkers();
  renderPickList();
  scheduleGenerate();
});

(function setupMarkerDrag() {
  const host = $('markers');
  let drag = null;
  host.addEventListener('pointerdown', (e) => {
    const m = e.target.closest('.marker');
    if (!m) return;
    e.preventDefault();
    drag = { m, id: Number(m.dataset.id) };
    m.setPointerCapture(e.pointerId);
  });
  host.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const p = state.picks.find((x) => x.id === drag.id);
    if (!p) return;
    const r = $('srcCanvas').getBoundingClientRect();
    const u = clamp((e.clientX - r.left) / r.width, 0, 0.9999);
    const v = clamp((e.clientY - r.top) / r.height, 0, 0.9999);
    const col = sampleSource(u, v);
    if (!col) return;
    p.u = u; p.v = v; p.color = col;
    drag.m.style.left = u * 100 + '%';
    drag.m.style.top = v * 100 + '%';
    drag.m.style.setProperty('--c', hex(col));
    scheduleGenerate();
  });
  const end = () => {
    if (!drag) return;
    drag = null;
    renderPickList();
  };
  host.addEventListener('pointerup', end);
  host.addEventListener('pointercancel', end);
  host.addEventListener('dblclick', (e) => {
    const m = e.target.closest('.marker');
    if (m) removePick(Number(m.dataset.id));
  });
})();

$('btnClearPicks').addEventListener('click', () => {
  state.picks = [];
  renderMarkers();
  renderPickList();
  scheduleGenerate();
});

/* ------------------------------ réglages ------------------------------ */

function updateOutputs() {
  for (const r of document.querySelectorAll('input[type="range"]')) {
    if (r.id === 'width') continue;
    const o = $(r.id + 'Out');
    if (o) o.textContent = r.value;
  }
}

function setWidth(v) {
  v = clamp(parseInt(v, 10) || 64, 8, 256);
  $('width').value = v;
  $('widthNum').value = v;
  updateSizeOut();
  scheduleGenerate();
}

$('width').addEventListener('input', (e) => setWidth(e.target.value));
$('widthNum').addEventListener('change', (e) => setWidth(e.target.value));
for (const b of document.querySelectorAll('.chip')) {
  b.addEventListener('click', () => setWidth(b.dataset.w));
}
for (const id of ['baseMode', 'alphaT', 'tol', 'priority', 'exact', 'snap']) {
  $(id).addEventListener('input', () => {
    updateOutputs();
    scheduleGenerate();
  });
}
$('exportScale').addEventListener('input', updateInfo);

/* ------------------------------ navigation ------------------------------ */

function showView(n, force) {
  if (n === 2 && !state.art) return;
  if (n === 1 && state.view === 2 && state.dirty && !force) {
    if (!confirm('Revenir aux réglages régénère l’image et efface vos retouches. Continuer ?')) return;
  }
  state.view = n;
  $('view1').hidden = n !== 1;
  $('view2').hidden = n !== 2;
  $('tab1').classList.toggle('active', n === 1);
  $('tab2').classList.toggle('active', n === 2);
  if (n === 1) {
    generate();
  } else {
    const a = state.art, box = $('editBox');
    state.zoom = clamp(Math.floor(Math.min((box.clientWidth - 28) / a.w, (box.clientHeight - 28) / a.h)), 1, 64);
    state.sel = null;
    applyZoom();
    renderArt();
    renderPalette();
    updateInfo();
    updateUndoButtons();
  }
  window.scrollTo(0, 0);
}

$('tab1').addEventListener('click', () => showView(1));
$('tab2').addEventListener('click', () => showView(2));
$('btnToEdit').addEventListener('click', () => showView(2));
$('btnBack').addEventListener('click', () => showView(1));
window.addEventListener('resize', layoutViews);

/* ------------------------------ retouche ------------------------------ */

function setTool(t) {
  state.tool = t;
  for (const b of document.querySelectorAll('.tool')) b.classList.toggle('active', b.dataset.tool === t);
}
$('tools').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tool]');
  if (b) setTool(b.dataset.tool);
});

function setColor(rgb) {
  state.color = rgb;
  $('curColor').value = hex(rgb);
  highlightPalette();
}
$('curColor').addEventListener('input', (e) => setColor(fromHex(e.target.value)));
$('brush').addEventListener('input', (e) => { $('brushOut').textContent = e.target.value; });
$('wtol').addEventListener('input', (e) => { $('wtolOut').textContent = e.target.value; });

function applyZoom() {
  const a = state.art;
  if (!a) return;
  const c = $('editCanvas');
  c.style.width = a.w * state.zoom + 'px';
  c.style.height = a.h * state.zoom + 'px';
  $('zoomOut').textContent = state.zoom + '×';
  const g = $('gridOverlay');
  g.style.backgroundSize = `${state.zoom}px ${state.zoom}px`;
  g.hidden = !($('showGrid').checked && state.zoom >= 6);
  updateCropBox();
}

function stepZoom(dir) {
  let i = ZOOMS.findIndex((z) => z >= state.zoom);
  if (i < 0) i = ZOOMS.length - 1;
  if (dir > 0) i = ZOOMS[i] > state.zoom ? i : Math.min(ZOOMS.length - 1, i + 1);
  else i = Math.max(0, i - 1);
  state.zoom = ZOOMS[i];
  applyZoom();
}
$('btnZoomIn').addEventListener('click', () => stepZoom(1));
$('btnZoomOut').addEventListener('click', () => stepZoom(-1));
$('showGrid').addEventListener('input', applyZoom);
$('editBox').addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;
  e.preventDefault();
  stepZoom(e.deltaY < 0 ? 1 : -1);
}, { passive: false });

/* annuler / rétablir */
function snapshot() {
  const a = state.art;
  return { w: a.w, h: a.h, data: a.data.slice() };
}
function restore(s) {
  const resized = s.w !== state.art.w || s.h !== state.art.h;
  state.art = { w: s.w, h: s.h, data: s.data };
  if (resized) {
    state.sel = null;
    applyZoom();
  }
}
function pushUndo() {
  state.undo.push(snapshot());
  if (state.undo.length > 60) state.undo.shift();
  state.redo = [];
  state.dirty = true;
  updateUndoButtons();
}
function undo() {
  if (!state.undo.length) return;
  state.redo.push(snapshot());
  restore(state.undo.pop());
  afterEdit();
}
function redo() {
  if (!state.redo.length) return;
  state.undo.push(snapshot());
  restore(state.redo.pop());
  afterEdit();
}
function updateUndoButtons() {
  $('btnUndo').disabled = !state.undo.length;
  $('btnRedo').disabled = !state.redo.length;
}
function afterEdit() {
  renderArt();
  renderPalette();
  updateInfo();
  updateUndoButtons();
}
$('btnUndo').addEventListener('click', undo);
$('btnRedo').addEventListener('click', redo);

/* palette de l'image */
function renderPalette() {
  const a = state.art, host = $('palette');
  host.textContent = '';
  if (!a) return;
  const map = new Map();
  const d = a.data;
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue;
    const k = (d[i] << 16) | (d[i + 1] << 8) | d[i + 2];
    map.set(k, (map.get(k) || 0) + 1);
  }
  const top = [...map.entries()].sort((x, y) => y[1] - x[1]).slice(0, 48);
  for (const [k] of top) {
    const rgb = [(k >> 16) & 255, (k >> 8) & 255, k & 255];
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'swatch';
    b.dataset.hex = hex(rgb);
    b.style.background = hex(rgb);
    b.title = hex(rgb);
    b.addEventListener('click', () => setColor(rgb));
    host.appendChild(b);
  }
  highlightPalette();
}
function highlightPalette() {
  const h = hex(state.color);
  for (const s of document.querySelectorAll('.swatch')) s.classList.toggle('current', s.dataset.hex === h);
}

/* outils de dessin */
function paintBrush(x, y, erase) {
  const a = state.art, d = a.data;
  const s = parseInt($('brush').value, 10);
  const start = -Math.floor((s - 1) / 2);
  const [r, g, b] = state.color;
  for (let dy = 0; dy < s; dy++) {
    for (let dx = 0; dx < s; dx++) {
      const px = x + start + dx, py = y + start + dy;
      if (px < 0 || py < 0 || px >= a.w || py >= a.h) continue;
      const i = (py * a.w + px) * 4;
      if (erase) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; }
      else { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
    }
  }
}

function line(x0, y0, x1, y1, fn) {
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    fn(x0, y0);
    if (x0 === x1 && y0 === y1) break;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

// Remplissage (couleur active) ou effacement (transparent) d'une zone.
function floodApply(x, y, erase) {
  const a = state.art, d = a.data, W = a.w, H = a.h;
  const tol = parseInt($('wtol').value, 10);
  const i0 = (y * W + x) * 4;
  const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2], tt = d[i0 + 3] < 128;
  const [nr, ng, nb] = state.color;

  const match = (i) => {
    const t = d[i + 3] < 128;
    if (t || tt) return t && tt;
    return dist(d[i], d[i + 1], d[i + 2], tr, tg, tb) <= tol;
  };
  const apply = (i) => {
    if (erase) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; }
    else { d[i] = nr; d[i + 1] = ng; d[i + 2] = nb; d[i + 3] = 255; }
  };

  if (!$('contig').checked) {
    for (let p = 0; p < W * H; p++) if (match(p * 4)) apply(p * 4);
    return;
  }
  const seen = new Uint8Array(W * H);
  const start = y * W + x;
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const p = stack.pop();
    const i = p * 4;
    if (!match(i)) continue;
    apply(i);
    const px = p % W, py = (p / W) | 0;
    if (px > 0 && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
    if (px < W - 1 && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
    if (py > 0 && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
    if (py < H - 1 && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
  }
}

function pickColorAt(x, y) {
  const a = state.art;
  const i = (y * a.w + x) * 4;
  if (a.data[i + 3] < 128) { toast('Ce pixel est transparent.'); return; }
  setColor([a.data[i], a.data[i + 1], a.data[i + 2]]);
}

function cellFromEvent(e) {
  const c = $('editCanvas'), r = c.getBoundingClientRect();
  return {
    x: clamp(Math.floor(((e.clientX - r.left) / r.width) * c.width), 0, c.width - 1),
    y: clamp(Math.floor(((e.clientY - r.top) / r.height) * c.height), 0, c.height - 1),
  };
}

(function setupEditCanvas() {
  const canvas = $('editCanvas');
  let stroke = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !state.art) return;
    e.preventDefault();
    const { x, y } = cellFromEvent(e);
    const tool = e.altKey ? 'pick' : state.tool;

    if (tool === 'pick') { pickColorAt(x, y); return; }
    if (tool === 'crop') {
      const r = selRect();
      if (r && x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) {
        // clic dans la sélection existante : on la déplace
        stroke = { crop: true, move: true, sx: x, sy: y, r };
      } else {
        stroke = { crop: true };
        state.sel = { x0: x, y0: y, x1: x, y1: y };
      }
      canvas.setPointerCapture(e.pointerId);
      updateCropBox();
      return;
    }
    pushUndo();
    if (tool === 'pen' || tool === 'eraser') {
      stroke = { x, y, erase: tool === 'eraser' };
      paintBrush(x, y, stroke.erase);
      canvas.setPointerCapture(e.pointerId);
      renderArt();
    } else {
      floodApply(x, y, tool === 'wand');
      afterEdit();
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!stroke) {
      // curseur « déplacer » quand on survole la sélection avec l'outil Recadrer
      if (state.tool === 'crop') {
        const r = selRect();
        const c = cellFromEvent(e);
        const inside = r && c.x >= r.x && c.x < r.x + r.w && c.y >= r.y && c.y < r.y + r.h;
        canvas.style.cursor = inside ? 'move' : '';
      } else if (canvas.style.cursor) {
        canvas.style.cursor = '';
      }
      return;
    }
    const { x, y } = cellFromEvent(e);
    if (stroke.crop) {
      if (stroke.move) {
        const r = stroke.r, a = state.art;
        const nx = clamp(r.x + x - stroke.sx, 0, a.w - r.w);
        const ny = clamp(r.y + y - stroke.sy, 0, a.h - r.h);
        state.sel = { x0: nx, y0: ny, x1: nx + r.w - 1, y1: ny + r.h - 1 };
      } else {
        state.sel.x1 = x;
        state.sel.y1 = y;
      }
      updateCropBox();
      return;
    }
    if (x === stroke.x && y === stroke.y) return;
    line(stroke.x, stroke.y, x, y, (px, py) => paintBrush(px, py, stroke.erase));
    stroke.x = x; stroke.y = y;
    renderArt();
  });

  const end = () => {
    if (!stroke) return;
    if (stroke.crop) {
      const moved = stroke.move;
      stroke = null;
      const s = state.sel;
      if (!moved && s && s.x0 === s.x1 && s.y0 === s.y1) clearSelection(); // simple clic : pas de sélection
      return;
    }
    stroke = null;
    afterEdit();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
})();

/* ------------------------------ recadrage ------------------------------ */

function selRect() {
  const s = state.sel;
  if (!s) return null;
  const x = Math.min(s.x0, s.x1), y = Math.min(s.y0, s.y1);
  return { x, y, w: Math.abs(s.x1 - s.x0) + 1, h: Math.abs(s.y1 - s.y0) + 1 };
}

function updateCropBox() {
  const box = $('cropBox'), r = state.art ? selRect() : null;
  if (!r) {
    box.hidden = true;
    $('btnCrop').disabled = true;
    $('btnCropClear').disabled = true;
    $('cropInfo').textContent = 'Aucune sélection';
    return;
  }
  box.hidden = false;
  box.style.left = r.x * state.zoom + 'px';
  box.style.top = r.y * state.zoom + 'px';
  box.style.width = r.w * state.zoom + 'px';
  box.style.height = r.h * state.zoom + 'px';
  $('btnCrop').disabled = false;
  $('btnCropClear').disabled = false;
  $('cropInfo').textContent = `Sélection : ${r.w} × ${r.h} px`;
}

function clearSelection() {
  state.sel = null;
  updateCropBox();
}

function cropTo(x, y, w, h) {
  const a = state.art;
  pushUndo();
  const out = new Uint8ClampedArray(w * h * 4);
  for (let row = 0; row < h; row++) {
    const si = ((y + row) * a.w + x) * 4;
    out.set(a.data.subarray(si, si + w * 4), row * w * 4);
  }
  state.art = { w, h, data: out };
  state.sel = null;
  const box = $('editBox');
  state.zoom = clamp(Math.floor(Math.min((box.clientWidth - 28) / w, (box.clientHeight - 28) / h)), 1, 64);
  applyZoom();
  afterEdit();
}

function applyCrop() {
  const r = selRect();
  if (!r || !state.art) return;
  if (r.w === state.art.w && r.h === state.art.h) { clearSelection(); return; }
  cropTo(r.x, r.y, r.w, r.h);
}

function trimTransparent() {
  const a = state.art;
  if (!a) return;
  let minX = a.w, minY = a.h, maxX = -1, maxY = -1;
  for (let y = 0; y < a.h; y++) {
    for (let x = 0; x < a.w; x++) {
      if (a.data[(y * a.w + x) * 4 + 3] === 0) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) { toast('L’image est entièrement transparente.'); return; }
  const w = maxX - minX + 1, h = maxY - minY + 1;
  if (w === a.w && h === a.h) { toast('Aucun bord transparent à rogner.'); return; }
  cropTo(minX, minY, w, h);
}

$('btnCrop').addEventListener('click', applyCrop);
$('btnCropClear').addEventListener('click', clearSelection);
$('btnTrim').addEventListener('click', trimTransparent);

/* ------------------------------ export ------------------------------ */

$('btnDownload').addEventListener('click', () => {
  const a = state.art;
  if (!a) return;
  const s = parseInt($('exportScale').value, 10);

  const tmp = document.createElement('canvas');
  tmp.width = a.w;
  tmp.height = a.h;
  tmp.getContext('2d').putImageData(new ImageData(a.data, a.w, a.h), 0, 0);

  const out = document.createElement('canvas');
  out.width = a.w * s;
  out.height = a.h * s;
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(tmp, 0, 0, out.width, out.height);

  out.toBlob((blob) => {
    if (!blob) { toast('Export impossible.'); return; }
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'pixel-art-' + a.w + 'x' + a.h + (s > 1 ? '-x' + s : '') + '.png';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1500);
  }, 'image/png');
});

/* ------------------------------ entrées de fichiers ------------------------------ */

$('btnOpen').addEventListener('click', () => $('fileInput').click());
$('dropzone').addEventListener('click', () => $('fileInput').click());
$('dropzone').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('fileInput').click(); }
});
$('fileInput').addEventListener('change', (e) => {
  loadFile(e.target.files[0]);
  e.target.value = '';
});

window.addEventListener('dragover', (e) => {
  e.preventDefault();
  $('dropzone').classList.add('over');
});
window.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) $('dropzone').classList.remove('over');
});
window.addEventListener('drop', (e) => {
  e.preventDefault();
  $('dropzone').classList.remove('over');
  const f = e.dataTransfer && e.dataTransfer.files[0];
  if (f) loadFile(f);
});
window.addEventListener('paste', (e) => {
  const items = (e.clipboardData && e.clipboardData.items) || [];
  for (const it of items) {
    if (it.type.startsWith('image/')) { loadFile(it.getAsFile()); break; }
  }
});

/* ------------------------------ raccourcis clavier ------------------------------ */

window.addEventListener('keydown', (e) => {
  if (state.view !== 2) return;
  // On ne bloque que la saisie de texte : les curseurs, cases et sélecteurs de couleur
  // gardent le focus après un clic et ne doivent pas empêcher Ctrl+Z / Ctrl+Y.
  const tag = (e.target.tagName || '').toLowerCase();
  const type = (e.target.type || '').toLowerCase();
  const typing = tag === 'textarea' || (tag === 'input' && ['text', 'number', 'search', 'email', 'url', 'password'].includes(type));
  if (typing) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod || e.altKey) return;
  if (k === 'enter' && state.sel) { e.preventDefault(); applyCrop(); return; }
  if (k === 'escape' && state.sel) { clearSelection(); return; }
  const tools = { p: 'pen', e: 'eraser', f: 'fill', w: 'wand', i: 'pick', c: 'crop' };
  if (tools[k]) setTool(tools[k]);
});

/* ------------------------------ init ------------------------------ */

updateOutputs();
updateSizeOut();
renderPickList();
setColor(state.color);
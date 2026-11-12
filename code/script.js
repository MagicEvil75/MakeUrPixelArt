'use strict';

/* =====================================================================
   MakeUrPixelArt – conversion d'images en pixel art guidée par pipettes
   ===================================================================== */

const $ = (id) => document.getElementById(id);

const MAX_SRC = 1600;   // taille max (px) du côté le plus long de l'image de travail
const MAX_PICKS = 32;
const ZOOMS = [1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 48, 64];          // retouche
const SRC_ZOOMS = [1, 1.5, 2, 3, 4, 6, 8, 12, 16, 24, 32];                     // original

const state = {
  orig: null,           // { img, url, w, h } image d'origine, pleine résolution
  rect: null,           // { x, y, w, h } zone de l'original utilisée (recadrage avant pixellisation)
  src: null,            // { w, h, data } image de travail (RGBA), dérivée de rect
  picks: [],            // [{ id, ox, oy, color:[r,g,b] }]  (ox, oy : coordonnées dans l'original)
  nextId: 1,
  srcZoom: 1,           // zoom de la vue de l'original (1 = image entière visible)
  srcMode: 'pick',      // 'pick' | 'crop'
  thickAuto: true,      // épaisseur des traits réglée automatiquement tant qu'on n'y touche pas
  lineCache: null,      // { key, mask, drawn }
  art: null,            // { w, h, data }  pixel art courant
  dirty: false,         // retouches manuelles effectuées ?
  undo: [],
  redo: [],
  view: 1,
  tool: 'pen',
  color: [231, 76, 60],
  zoom: 8,              // zoom de la vue de retouche
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

/* ------------------------------ sélecteur rectangulaire ------------------------------ */
/* Sélection à poignées (déplacer, redimensionner par les bords et coins), partagée par le
   recadrage de l'original et le recadrage de la retouche. Les coordonnées sont celles du
   canvas (une "cellule" = un pixel du canvas) ; l'affichage de l'overlay est en pourcentages
   et suit donc n'importe quel zoom. */

const HANDLE_CURSORS = {
  move: 'move', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize',
};

function makeSelector(canvas, overlay, onChange) {
  const S = { sel: null, drag: null };

  const cell = (e) => {
    const r = canvas.getBoundingClientRect();
    return {
      x: clamp(Math.floor(((e.clientX - r.left) / r.width) * canvas.width), 0, canvas.width - 1),
      y: clamp(Math.floor(((e.clientY - r.top) / r.height) * canvas.height), 0, canvas.height - 1),
    };
  };
  // Position fractionnaire en coordonnées canvas (les entiers sont les lignes de grille).
  const grid = (e) => {
    const r = canvas.getBoundingClientRect();
    return {
      fx: ((e.clientX - r.left) / r.width) * canvas.width,
      fy: ((e.clientY - r.top) / r.height) * canvas.height,
    };
  };

  S.rect = () => {
    const s = S.sel;
    if (!s) return null;
    const x = Math.min(s.x0, s.x1), y = Math.min(s.y0, s.y1);
    return { x, y, w: Math.abs(s.x1 - s.x0) + 1, h: Math.abs(s.y1 - s.y0) + 1 };
  };

  S.draw = () => {
    const r = S.rect();
    overlay.hidden = !r;
    if (!r) return;
    overlay.style.left = (r.x / canvas.width) * 100 + '%';
    overlay.style.top = (r.y / canvas.height) * 100 + '%';
    overlay.style.width = (r.w / canvas.width) * 100 + '%';
    overlay.style.height = (r.h / canvas.height) * 100 + '%';
  };
  S.change = () => { S.draw(); if (onChange) onChange(); };
  S.clear = () => { S.sel = null; S.drag = null; S.change(); };

  // Où est le pointeur par rapport à la sélection ? 'n', 'se', 'move'… ou null (hors sélection).
  S.hit = (e) => {
    const r = S.rect();
    if (!r) return null;
    const c = canvas.getBoundingClientRect();
    const sc = c.width / canvas.width;                   // pixels d'écran par cellule
    const L = c.left + r.x * sc, R = c.left + (r.x + r.w) * sc;
    const T = c.top + r.y * sc, B = c.top + (r.y + r.h) * sc;
    const m = clamp(Math.min(R - L, B - T) / 3, 4, 10);  // zone de prise, réduite si la sélection est petite
    const px = e.clientX, py = e.clientY;
    if (px < L - m || px > R + m || py < T - m || py > B + m) return null;
    let h = '';
    if (py <= T + m) h += 'n'; else if (py >= B - m) h += 's';
    if (px <= L + m) h += 'w'; else if (px >= R - m) h += 'e';
    return h || 'move';
  };
  S.cursor = (e) => {
    const h = S.hit(e);
    return h ? HANDLE_CURSORS[h] : '';
  };

  S.down = (e) => {
    const { x, y } = cell(e);
    const hit = S.hit(e);
    if (hit === 'move') {
      S.drag = { mode: 'move', sx: x, sy: y, r: S.rect() };
    } else if (hit) {
      const r = S.rect();
      S.sel = { x0: r.x, y0: r.y, x1: r.x + r.w - 1, y1: r.y + r.h - 1 };  // normalisée
      S.drag = { mode: hit };
    } else {
      S.sel = { x0: x, y0: y, x1: x, y1: y };
      S.drag = { mode: 'new' };
    }
    S.change();
  };

  S.move = (e) => {
    const d = S.drag;
    if (!d) return false;
    const { x, y } = cell(e), m = d.mode, s = S.sel;
    if (m === 'move') {
      const r = d.r;
      const nx = clamp(r.x + x - d.sx, 0, canvas.width - r.w);
      const ny = clamp(r.y + y - d.sy, 0, canvas.height - r.h);
      S.sel = { x0: nx, y0: ny, x1: nx + r.w - 1, y1: ny + r.h - 1 };
    } else if (m === 'new') {
      s.x1 = x;
      s.y1 = y;
    } else {
      // le côté tiré s'aligne sur la ligne de grille la plus proche, sans dépasser le côté opposé
      const g = grid(e);
      if (m.includes('w')) s.x0 = clamp(Math.round(g.fx), 0, s.x1);
      if (m.includes('e')) s.x1 = clamp(Math.round(g.fx) - 1, s.x0, canvas.width - 1);
      if (m.includes('n')) s.y0 = clamp(Math.round(g.fy), 0, s.y1);
      if (m.includes('s')) s.y1 = clamp(Math.round(g.fy) - 1, s.y0, canvas.height - 1);
    }
    S.change();
    return true;
  };

  S.up = () => {
    const d = S.drag;
    if (!d) return false;
    S.drag = null;
    const s = S.sel;
    if (d.mode === 'new' && s && s.x0 === s.x1 && s.y0 === s.y1) S.clear();   // simple clic : pas de sélection
    return true;
  };

  return S;
}

const srcSel = makeSelector($('srcCanvas'), $('srcCropBox'), updateSrcCropUi);
const editSel = makeSelector($('editCanvas'), $('editCropBox'), updateEditCropUi);

/* ------------------------------ chargement ------------------------------ */

function loadFile(file) {
  if (!file || !file.type.startsWith('image/')) {
    toast('Ce fichier n’est pas une image.');
    return;
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.onload = () => setSource(img, url);
  img.onerror = () => {
    URL.revokeObjectURL(url);
    toast('Impossible de lire cette image.');
  };
  img.src = url;
}

function setSource(img, url) {
  const w = img.naturalWidth, h = img.naturalHeight;
  if (!w || !h) {
    URL.revokeObjectURL(url);
    toast('Image sans dimensions exploitables.');
    return;
  }
  // L'image d'origine reste en mémoire (et son URL valide) : le recadrage repart d'elle,
  // pas de la copie de travail réduite, pour ne perdre aucune résolution.
  if (state.orig) URL.revokeObjectURL(state.orig.url);
  state.orig = { img, url, w, h };
  state.rect = { x: 0, y: 0, w, h };
  state.picks = [];
  state.thickAuto = true;
  state.srcZoom = 1;
  setSrcMode('pick');

  $('controls').disabled = false;
  $('dropzone').hidden = true;
  $('panes').hidden = false;
  if (state.view !== 1) showView(1, true);
  rebuildSource();
  generate();
}

// Reconstruit l'image de travail à partir de l'original et du cadrage courant.
function rebuildSource() {
  const { img } = state.orig, r = state.rect;
  const s = Math.min(1, MAX_SRC / Math.max(r.w, r.h));
  const w = Math.max(1, Math.round(r.w * s));
  const h = Math.max(1, Math.round(r.h * s));

  const c = $('srcCanvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.clearRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, r.x, r.y, r.w, r.h, 0, 0, w, h);
  state.src = { w, h, data: ctx.getImageData(0, 0, w, h).data };
  state.lineCache = null;

  if (state.thickAuto) {
    $('lineThick').value = clamp(Math.round(w / 200), 2, 16);
    updateOutputs();
  }
  const full = r.w === state.orig.w && r.h === state.orig.h;
  $('srcInfo').textContent = `${w} × ${h} px` + (full ? '' : ` · recadré (original ${state.orig.w} × ${state.orig.h})`);
  $('btnSrcReset').disabled = full;

  srcSel.clear();
  renderMarkers();
  renderPickList();
  updateSizeOut();
  layoutViews();
}

/* ------------------------------ détection des traits fins ------------------------------ */

// Filtre max/min glissant 1D (fenêtre [i-r, i+r]) en temps linéaire, par file monotone.
function morph(src, dst, w, h, r, isMax, horiz) {
  const n = horiz ? w : h, lines = horiz ? h : w;
  const stride = horiz ? 1 : w, lineStep = horiz ? w : 1;
  const dq = new Int32Array(n);
  for (let l = 0; l < lines; l++) {
    const base = l * lineStep;
    let head = 0, tail = 0, next = 0;
    for (let i = 0; i < n; i++) {
      const hi = Math.min(n - 1, i + r);
      while (next <= hi) {
        const v = src[base + next * stride];
        while (tail > head) {
          const u = src[base + dq[tail - 1] * stride];
          if (isMax ? u <= v : u >= v) tail--; else break;
        }
        dq[tail++] = next++;
      }
      while (dq[head] < i - r) head++;
      dst[base + i * stride] = src[base + dq[head] * stride];
    }
  }
}

// Masque des traits sombres fins : "top-hat noir" = fermeture(luminance) - luminance.
// Un trait plus étroit que la fenêtre est comblé par la fermeture, d'où un fort écart ;
// une grande zone sombre, elle, n'est pas comblée et n'est donc pas détectée.
// Valeurs : 2 = trait, 1 = bordure adoucie du trait, 0 = rien.
function computeLineMask(src, r, sens) {
  const { w, h, data } = src, n = w * h;
  const L = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    L[i] = data[j + 3] < 128 ? 255 : (0.299 * data[j] + 0.587 * data[j + 1] + 0.114 * data[j + 2]) | 0;
  }
  const A = new Uint8Array(n), B = new Uint8Array(n);
  morph(L, A, w, h, r, true, true);
  morph(A, B, w, h, r, true, false);
  morph(B, A, w, h, r, false, true);
  morph(A, B, w, h, r, false, false);       // B = fermeture
  const mask = new Uint8Array(n);
  const halo = sens * 0.4;
  for (let i = 0; i < n; i++) {
    const t = B[i] - L[i];
    mask[i] = t >= sens ? 2 : (t >= halo ? 1 : 0);
  }
  return mask;
}

function getLineMask() {
  const thick = parseInt($('lineThick').value, 10), sens = parseInt($('lineSens').value, 10);
  const key = thick + '|' + sens;
  if (state.lineCache && state.lineCache.key === key) return state.lineCache.mask;
  const mask = computeLineMask(state.src, Math.ceil(thick / 2), sens);
  state.lineCache = { key, mask, drawn: false };
  return mask;
}

// Squelette (lignes de 1 pixel) des traits, à la résolution de l'image de travail. Un trait posé
// pile sur la frontière de deux blocs se répartirait 50/50 entre eux ; avec le squelette, un seul
// des deux est choisi, ce qui donne des traits de 1 bloc sans fusionner deux traits voisins.
function getLineSkeleton() {
  getLineMask();
  const lc = state.lineCache;
  if (!lc.skel) {
    const { w, h } = state.src, n = w * h;
    const bin = new Uint8Array(n);
    for (let i = 0; i < n; i++) bin[i] = lc.mask[i] === 2 ? 1 : 0;
    zhangSuen(bin, w, h);
    lc.skel = bin;
  }
  return lc.skel;
}

function drawLineOverlay(mask) {
  const c = $('lineOverlay');
  if (!mask || !$('showLines').checked) { c.hidden = true; return; }
  if (!state.lineCache.drawn) {
    const { w, h } = state.src;
    c.width = w;
    c.height = h;
    const id = new ImageData(w, h), d = id.data;
    for (let i = 0; i < mask.length; i++) {
      const m = mask[i];
      if (!m) continue;
      const j = i * 4;
      d[j] = 255; d[j + 1] = 0; d[j + 2] = 200; d[j + 3] = m === 2 ? 220 : 80;
    }
    c.getContext('2d').putImageData(id, 0, 0);
    state.lineCache.drawn = true;
  }
  c.hidden = false;
}

// Amincissement de Zhang-Suen sur la grille de cellules "trait" : lignes de 1 pixel, connexité conservée.
function zhangSuen(grid, W, H) {
  const PW = W + 2, P = new Uint8Array(PW * (H + 2));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) P[(y + 1) * PW + x + 1] = grid[y * W + x];
  const del = [];
  let changed = true;
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 1; y <= H; y++) {
        for (let x = 1; x <= W; x++) {
          const i = y * PW + x;
          if (!P[i]) continue;
          const p2 = P[i - PW], p3 = P[i - PW + 1], p4 = P[i + 1], p5 = P[i + PW + 1];
          const p6 = P[i + PW], p7 = P[i + PW - 1], p8 = P[i - 1], p9 = P[i - PW - 1];
          const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
          if (B < 2 || B > 6) continue;
          const A = (!p2 && p3 ? 1 : 0) + (!p3 && p4 ? 1 : 0) + (!p4 && p5 ? 1 : 0) + (!p5 && p6 ? 1 : 0) +
                    (!p6 && p7 ? 1 : 0) + (!p7 && p8 ? 1 : 0) + (!p8 && p9 ? 1 : 0) + (!p9 && p2 ? 1 : 0);
          if (A !== 1) continue;
          if (pass === 0) { if (p2 * p4 * p6 || p4 * p6 * p8) continue; }
          else if (p2 * p4 * p8 || p2 * p6 * p8) continue;
          del.push(i);
        }
      }
      if (del.length) { changed = true; for (const i of del) P[i] = 0; }
    }
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) grid[y * W + x] = P[(y + 1) * PW + x + 1];
}

// Retire les pixels de coin des "marches" (forme en L) pour obtenir des lignes nettes de 1 pixel,
// comme les lignes "pixel perfect". Les vrais angles droits (bras prolongés des deux côtés) et la
// connexité des traits sont conservés.
function cleanCorners(grid, W, H) {
  const g = (x, y) => (x >= 0 && y >= 0 && x < W && y < H ? grid[y * W + x] : 0);
  const DIRS = [[0, -1], [1, 0], [0, 1], [-1, 0]];     // haut, droite, bas, gauche
  for (let pass = 0, changed = true; changed && pass < 4; pass++) {
    changed = false;
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!grid[y * W + x]) continue;
        const n4 = DIRS.map(([dx, dy]) => g(x + dx, y + dy));
        if (n4[0] + n4[1] + n4[2] + n4[3] !== 2) continue;
        let a = -1;
        for (let k = 0; k < 4; k++) if (n4[k] && n4[(k + 1) % 4]) a = k;   // deux bras perpendiculaires
        if (a < 0) continue;
        const A = DIRS[a], B = DIRS[(a + 1) % 4];
        if (g(x + A[0] + B[0], y + A[1] + B[1])) continue;                   // diagonale entre les bras : vide
        if (g(x + 2 * A[0], y + 2 * A[1]) && g(x + 2 * B[0], y + 2 * B[1])) continue;   // vrai angle droit
        // les voisins restants doivent rester d'un seul tenant (connexité 8) une fois le pixel retiré
        const nb = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if ((dx || dy) && g(x + dx, y + dy)) nb.push([dx, dy]);
        const seen = new Array(nb.length).fill(false), stack = [0];
        seen[0] = true;
        let reached = 1;
        while (stack.length) {
          const [ux, uy] = nb[stack.pop()];
          for (let j = 0; j < nb.length; j++) {
            if (!seen[j] && Math.abs(nb[j][0] - ux) <= 1 && Math.abs(nb[j][1] - uy) <= 1) { seen[j] = true; reached++; stack.push(j); }
          }
        }
        if (reached !== nb.length) continue;
        grid[y * W + x] = 0;
        changed = true;
      }
    }
  }
}

function thinGrid(grid, W, H) {
  const orig = grid.slice();
  zhangSuen(grid, W, H);
  cleanCorners(grid, W, H);
  // Un petit amas (point, 2×2) peut disparaître entièrement : on en garde alors une cellule.
  const seen = new Uint8Array(W * H);
  for (let s = 0; s < W * H; s++) {
    if (!orig[s] || seen[s]) continue;
    const comp = [s], stack = [s];
    seen[s] = 1;
    let alive = false, sx = 0, sy = 0;
    while (stack.length) {
      const p = stack.pop();
      const px = p % W, py = (p / W) | 0;
      if (grid[p]) alive = true;
      sx += px; sy += py;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx, ny = py + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const q = ny * W + nx;
          if (orig[q] && !seen[q]) { seen[q] = 1; stack.push(q); comp.push(q); }
        }
      }
    }
    if (!alive) {
      const cx = sx / comp.length, cy = sy / comp.length;
      let best = comp[0], bd = Infinity;
      for (const q of comp) {
        const d = (q % W - cx) ** 2 + ((q / W | 0) - cy) ** 2;
        if (d < bd) { bd = d; best = q; }
      }
      grid[best] = 1;
    }
  }
}

/* ------------------------------ pixellisation ------------------------------ */

function readParams() {
  const pr = parseInt($('priority').value, 10) / 100;
  const contrast = $('contrast').checked;
  return {
    width: clamp(parseInt($('width').value, 10) || 64, 8, 256),
    base: $('baseMode').value,
    alpha: parseInt($('alphaT').value, 10) / 100,
    tol: parseInt($('tol').value, 10),
    contrast,
    // Part minimale d'un bloc qui doit ressembler à une pipette pour qu'elle l'emporte.
    // Mode contraste : courbe plus sensible (les petits détails comptent).
    minShare: contrast ? Math.max(0.005, 0.6 * Math.pow(1 - pr, 2)) : Math.max(0.02, 1 - pr),
    exact: $('exact').checked,
    snap: $('snap').checked,
    lines: $('lines').checked,
    lineShare: parseInt($('lineShare').value, 10) / 100,
    lineColor: fromHex($('lineColor').value),
    thin: $('thin').checked,
  };
}

// `mask` : masque des traits (ou null). Les pixels de trait sont écartés de la couleur de base et
// des pipettes ; les blocs où les traits sont assez présents sont ensuite redessinés d'une couleur.
function pixelate(src, P, picks, mask, skel) {
  const sw = src.w, sh = src.h, sd = src.data;
  const W = P.width;
  const H = Math.max(1, Math.round((W * sh) / sw));
  const out = new Uint8ClampedArray(W * H * 4);
  const lineGrid = mask ? new Uint8Array(W * H) : null;

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

      let total = 0, opaque = 0, aR = 0, aG = 0, aB = 0;     // tous les pixels opaques
      let kN = 0, kR = 0, kG = 0, kB = 0, lineCnt = 0, skelCnt = 0;   // pixels hors traits / traits
      if (K) { cnt.fill(0); pr.fill(0); pg.fill(0); pb.fill(0); }
      touched.length = 0;

      for (let y = y0; y < y1; y++) {
        for (let x = x0; x < x1; x++) {
          const i = (y * sw + x) * 4;
          total++;
          if (sd[i + 3] < 128) continue;       // pixel transparent : ignoré
          const r = sd[i], g = sd[i + 1], b = sd[i + 2];
          opaque++;
          aR += r; aG += g; aB += b;

          if (mask) {
            const m = mask[y * sw + x];
            if (m) {                            // trait ou bordure de trait : hors couleur de base
              lineCnt += m === 2 ? 1 : 0.5;     // la bordure compte à moitié (trait flou ou mal échantillonné)
              if (skel && skel[y * sw + x]) skelCnt++;
              continue;
            }
          }
          kN++; kR += r; kG += g; kB += b;

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
        if (kN === 0) {                          // bloc entièrement fait de traits : moyenne complète
          r = aR / opaque; g = aG / opaque; b = aB / opaque;
        } else if (dom) {
          let bestB = -1, bc = 0;
          for (const bk of touched) if (bCnt[bk] > bc) { bc = bCnt[bk]; bestB = bk; }
          r = bR[bestB] / bc; g = bG[bestB] / bc; b = bB[bestB] / bc;
        } else {
          r = kR / kN; g = kG / kN; b = kB / kN;
        }

        if (K) {
          if (kN > 0) {
            // Guide retenu : celui qui domine le bloc ; avec l'option contraste, celui qui se démarque
            // le plus de la couleur de base (un détail rare mais très contrasté peut l'emporter).
            let kb = -1, best = 0;
            for (let k = 0; k < K; k++) {
              if (!cnt[k]) continue;
              const share = cnt[k] / kN;
              if (share < P.minShare) continue;
              let score = share;
              if (P.contrast) {
                const c = 0.1 + dist(r, g, b, pcR[k], pcG[k], pcB[k]) / 765;
                score = share * c * c;
              }
              if (score > best) { best = score; kb = k; }
            }
            if (kb >= 0) {
              const kc = cnt[kb];
              if (P.exact) { r = pcR[kb]; g = pcG[kb]; b = pcB[kb]; }
              else { r = pr[kb] / kc; g = pg[kb] / kc; b = pb[kb] / kc; }
            }
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
        // bloc "trait" : assez de trait dedans, et (si affinage) le squelette du trait le traverse
        if (lineGrid && lineCnt / opaque >= P.lineShare && (!skel || skelCnt > 0)) lineGrid[cy * W + cx] = 1;
      }

      if (dom) for (const bk of touched) { bCnt[bk] = 0; bR[bk] = 0; bG[bk] = 0; bB[bk] = 0; }
    }
  }

  if (lineGrid) {
    if (P.thin) thinGrid(lineGrid, W, H);
    const [lr, lg, lb] = P.lineColor;
    for (let i = 0; i < W * H; i++) {
      if (!lineGrid[i]) continue;
      const o = i * 4;
      out[o] = lr; out[o + 1] = lg; out[o + 2] = lb; out[o + 3] = 255;
    }
  }
  return { w: W, h: H, data: out };
}

let genTimer = 0, genPending = false;
function scheduleGenerate() {
  clearTimeout(genTimer);
  genPending = true;
  genTimer = setTimeout(generate, 50);
}

function generate() {
  clearTimeout(genTimer);
  genPending = false;
  if (!state.src) return;
  const P = readParams();
  const mask = (P.lines || $('showLines').checked) ? getLineMask() : null;
  state.art = pixelate(state.src, P, state.picks, P.lines ? mask : null, P.lines && P.thin ? getLineSkeleton() : null);
  drawLineOverlay(mask);
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
  const box = $('srcBox'), c = $('srcCanvas');
  // taille de référence : offsetWidth inclut les barres de défilement, donc stable quand on zoome
  const bw = box.offsetWidth - 18, bh = box.offsetHeight - 18;     // bordures (2) + marges internes (16)
  if (bw > 0 && bh > 0 && c.width) {
    const s = Math.min(bw / c.width, bh / c.height) * state.srcZoom;
    const cw = Math.max(1, Math.round(c.width * s)), ch = Math.max(1, Math.round(c.height * s));
    c.style.width = cw + 'px';
    c.style.height = ch + 'px';
    const pixelated = cw / c.width >= 2;               // à fort zoom, on voit les vrais pixels
    c.classList.toggle('px', pixelated);
    $('lineOverlay').classList.toggle('px', pixelated);
  }
  $('srcZoomVal').textContent = '×' + Math.round(state.srcZoom * 10) / 10;
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

/* ------------------------------ zoom et déplacement de l'original ------------------------------ */

function setSrcZoom(z, ev) {
  if (!state.src) return;
  z = clamp(z, 1, 32);
  const canvas = $('srcCanvas'), box = $('srcBox');
  const r = canvas.getBoundingClientRect();
  let cx, cy;
  if (ev) { cx = ev.clientX; cy = ev.clientY; }
  else { const b = box.getBoundingClientRect(); cx = b.left + b.width / 2; cy = b.top + b.height / 2; }
  const u = clamp((cx - r.left) / r.width, 0, 1), v = clamp((cy - r.top) / r.height, 0, 1);
  state.srcZoom = z;
  layoutViews();
  // on garde sous le curseur le point qui y était avant le zoom
  const n = canvas.getBoundingClientRect();
  box.scrollLeft += (n.left + u * n.width) - cx;
  box.scrollTop += (n.top + v * n.height) - cy;
}

function stepSrcZoom(dir) {
  const z = state.srcZoom;
  let target;
  if (dir > 0) target = SRC_ZOOMS.find((v) => v > z + 1e-6) || SRC_ZOOMS[SRC_ZOOMS.length - 1];
  else target = [...SRC_ZOOMS].reverse().find((v) => v < z - 1e-6) || 1;
  setSrcZoom(target);
}

$('srcZoomInBtn').addEventListener('click', () => stepSrcZoom(1));
$('srcZoomOutBtn').addEventListener('click', () => stepSrcZoom(-1));
$('srcZoomFit').addEventListener('click', () => {
  state.srcZoom = 1;
  layoutViews();
  $('srcBox').scrollLeft = 0;
  $('srcBox').scrollTop = 0;
});
$('srcBox').addEventListener('wheel', (e) => {
  if (!e.ctrlKey && !e.metaKey) return;     // sans Ctrl : défilement normal
  e.preventDefault();
  setSrcZoom(state.srcZoom * Math.exp(-e.deltaY * 0.002), e);
}, { passive: false });

let spaceDown = false;
(function setupPan() {
  const box = $('srcBox');
  let pan = null;
  box.addEventListener('mousedown', (e) => { if (e.button === 1) e.preventDefault(); });   // pas d'autoscroll
  // En phase de capture : le déplacement de vue prend le pas sur la pose de pipettes et le recadrage.
  box.addEventListener('pointerdown', (e) => {
    if (!(e.button === 1 || (e.button === 0 && spaceDown))) return;
    e.preventDefault();
    e.stopPropagation();
    pan = { x: e.clientX, y: e.clientY, sl: box.scrollLeft, st: box.scrollTop };
    box.setPointerCapture(e.pointerId);
    box.classList.add('panning');
  }, true);
  box.addEventListener('pointermove', (e) => {
    if (!pan) return;
    box.scrollLeft = pan.sl - (e.clientX - pan.x);
    box.scrollTop = pan.st - (e.clientY - pan.y);
  });
  const end = () => { pan = null; box.classList.remove('panning'); };
  box.addEventListener('pointerup', end);
  box.addEventListener('pointercancel', end);
})();

function setSpace(on) {
  spaceDown = on;
  $('srcBox').classList.toggle('canpan', on);
}

/* ------------------------------ modes de l'original ------------------------------ */

function setSrcMode(m) {
  state.srcMode = m;
  for (const b of document.querySelectorAll('#srcMode .segbtn')) b.classList.toggle('active', b.dataset.mode === m);
  $('srcStage').classList.toggle('crop-mode', m === 'crop');
  $('srcCanvas').style.cursor = '';
}
$('srcMode').addEventListener('click', (e) => {
  const b = e.target.closest('[data-mode]');
  if (b) setSrcMode(b.dataset.mode);
});

/* ------------------------------ recadrage de l'original ------------------------------ */

function updateSrcCropUi() {
  const r = srcSel.rect();
  $('btnSrcCrop').disabled = !r;
  $('btnSrcCropClear').disabled = !r;
  if (r && state.rect) {
    const c = $('srcCanvas'), R = state.rect;
    const w = Math.max(1, Math.round((r.w / c.width) * R.w)), h = Math.max(1, Math.round((r.h / c.height) * R.h));
    $('srcCropInfo').textContent = `Sélection : ${w} × ${h} px (original)`;
  } else {
    $('srcCropInfo').textContent = 'Aucune sélection';
  }
}

function applySrcCrop() {
  const r = srcSel.rect();
  if (!r || !state.orig) return;
  const c = $('srcCanvas'), R = state.rect, O = state.orig;
  const fx = R.w / c.width, fy = R.h / c.height;
  let x = clamp(R.x + Math.round(r.x * fx), 0, O.w - 1);
  let y = clamp(R.y + Math.round(r.y * fy), 0, O.h - 1);
  let w = Math.max(1, Math.round(r.w * fx)), h = Math.max(1, Math.round(r.h * fy));
  w = Math.min(w, O.w - x);
  h = Math.min(h, O.h - y);
  if (x === R.x && y === R.y && w === R.w && h === R.h) { srcSel.clear(); return; }
  state.rect = { x, y, w, h };
  state.srcZoom = 1;
  setSrcMode('pick');
  rebuildSource();
  generate();
  toast(`Original recadré : ${w} × ${h} px`);
}

function resetSrcCrop() {
  if (!state.orig) return;
  state.rect = { x: 0, y: 0, w: state.orig.w, h: state.orig.h };
  state.srcZoom = 1;
  rebuildSource();
  generate();
}

$('btnSrcCrop').addEventListener('click', applySrcCrop);
$('btnSrcCropClear').addEventListener('click', () => srcSel.clear());
$('btnSrcReset').addEventListener('click', resetSrcCrop);

(function setupSrcSelection() {
  const c = $('srcCanvas');
  c.addEventListener('pointerdown', (e) => {
    if (state.srcMode !== 'crop' || e.button !== 0) return;
    e.preventDefault();
    srcSel.down(e);
    c.setPointerCapture(e.pointerId);
  });
  c.addEventListener('pointermove', (e) => {
    if (state.srcMode !== 'crop') return;
    if (!srcSel.move(e)) c.style.cursor = srcSel.cursor(e);
  });
  const end = () => srcSel.up();
  c.addEventListener('pointerup', end);
  c.addEventListener('pointercancel', end);
})();

/* ------------------------------ pipettes ------------------------------ */

// Les pipettes sont stockées en coordonnées de l'original : elles survivent aux recadrages.
const toDisp = (p) => ({ u: (p.ox - state.rect.x) / state.rect.w, v: (p.oy - state.rect.y) / state.rect.h });
const fromDisp = (u, v) => ({ ox: state.rect.x + u * state.rect.w, oy: state.rect.y + v * state.rect.h });
const inFrame = ({ u, v }) => u >= 0 && u < 1 && v >= 0 && v < 1;

function sampleSource(u, v) {
  const { w, h, data } = state.src;
  const cx = clamp(Math.floor(u * w), 0, w - 1);
  const cy = clamp(Math.floor(v * h), 0, h - 1);
  // Rayon = ce que couvre un pixel d'écran sur l'image de travail (au moins 1).
  const shown = $('srcCanvas').getBoundingClientRect().width || w;
  const rr = Math.max(1, Math.ceil(w / shown));
  const lum = (i) => 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
  let n = 0, r = 0, g = 0, b = 0, dark = -1, dl = 1e9;
  for (let y = Math.max(0, cy - rr); y <= Math.min(h - 1, cy + rr); y++) {
    for (let x = Math.max(0, cx - rr); x <= Math.min(w - 1, cx + rr); x++) {
      const i = (y * w + x) * 4;
      if (data[i + 3] < 128) continue;
      n++; r += data[i]; g += data[i + 1]; b += data[i + 2];
      const l = lum(i);
      if (l < dl) { dl = l; dark = i; }
    }
  }
  if (!n) return null;
  // Pipette magnétique : si un trait nettement plus sombre passe sous le curseur,
  // on prend sa vraie couleur plutôt qu'une moyenne grisâtre fond + trait.
  const avgLum = 0.299 * (r / n) + 0.587 * (g / n) + 0.114 * (b / n);
  if ($('magnet').checked && avgLum - dl > 40) return [data[dark], data[dark + 1], data[dark + 2]];
  return [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
}

function renderMarkers() {
  const host = $('markers');
  host.textContent = '';
  if (!state.rect) return;
  state.picks.forEach((p, i) => {
    const d = toDisp(p);
    if (!inFrame(d)) return;               // pipette hors du cadrage actuel : non affichée
    const m = document.createElement('div');
    m.className = 'marker';
    m.dataset.id = p.id;
    m.style.left = d.u * 100 + '%';
    m.style.top = d.v * 100 + '%';
    m.style.setProperty('--c', hex(p.color));
    m.title = `Pipette ${i + 1} · glisser pour déplacer, double-clic pour supprimer`;
    m.textContent = i + 1;
    host.appendChild(m);
  });
}

function renderPickList() {
  const host = $('pickList');
  host.textContent = '';
  $('pickCount').textContent = `${state.picks.length}/${MAX_PICKS}`;
  if (!state.picks.length) {
    const p = document.createElement('p');
    p.className = 'hint';
    p.textContent = 'Aucune pipette pour l’instant.';
    host.appendChild(p);
    return;
  }
  state.picks.forEach((p, i) => {
    const row = document.createElement('div');
    row.className = 'pick' + (state.rect && !inFrame(toDisp(p)) ? ' off' : '');
    if (row.classList.contains('off')) row.title = 'Hors du cadrage actuel (toujours utilisée comme guide)';
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

let swallowClick = false;
$('srcStage').addEventListener('click', (e) => {
  if (swallowClick) { swallowClick = false; return; }
  if (!state.src || state.srcMode !== 'pick' || e.target.closest('.marker')) return;
  const r = $('srcCanvas').getBoundingClientRect();
  const u = (e.clientX - r.left) / r.width;
  const v = (e.clientY - r.top) / r.height;
  if (u < 0 || u >= 1 || v < 0 || v >= 1) return;
  const col = sampleSource(u, v);
  if (!col) { toast('Ce point est transparent : visez une zone de l’image.'); return; }
  if (state.picks.length >= MAX_PICKS) { toast(`${MAX_PICKS} pipettes maximum.`); return; }
  state.picks.push({ id: state.nextId++, ...fromDisp(u, v), color: col });
  renderMarkers();
  renderPickList();
  scheduleGenerate();
});

(function setupMarkerDrag() {
  const host = $('markers');
  let drag = null;
  host.addEventListener('pointerdown', (e) => {
    const m = e.target.closest('.marker');
    if (!m || e.button !== 0) return;
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
    Object.assign(p, fromDisp(u, v));
    p.color = col;
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

function updateLineUi() {
  $('lineOpts').classList.toggle('on', $('lines').checked);
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
for (const id of ['baseMode', 'alphaT', 'tol', 'priority', 'exact', 'snap', 'contrast',
  'lines', 'lineSens', 'lineThick', 'lineShare', 'lineColor', 'thin', 'showLines']) {
  $(id).addEventListener('input', () => {
    if (id === 'lineThick') state.thickAuto = false;
    updateOutputs();
    updateLineUi();
    scheduleGenerate();
  });
}
$('exportScale').addEventListener('input', updateInfo);

// Bascule d'une option par raccourci clavier.
function toggleOption(id, label) {
  const el = $(id);
  el.checked = !el.checked;
  updateLineUi();
  scheduleGenerate();
  toast(`${label} : ${el.checked ? 'activé' : 'désactivé'}`);
}

/* ------------------------------ navigation ------------------------------ */

function showView(n, force) {
  if (n === 2 && genPending) generate();   // une régénération en attente ne doit pas écraser les retouches
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
    editSel.clear();
    fitZoom();
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
  $('outlineOpts').hidden = t !== 'outline';
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
}

// Zoom entier qui fait tenir l'image entière dans la zone d'édition.
function fitZoom() {
  const a = state.art, box = $('editBox');
  state.zoom = clamp(Math.floor(Math.min((box.clientWidth - 28) / a.w, (box.clientHeight - 28) / a.h)), 1, 64);
  applyZoom();
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

/* annuler / rétablir (les recadrages changent la taille : on sauvegarde w, h et données) */
function snapshot() {
  const a = state.art;
  return { w: a.w, h: a.h, data: a.data.slice() };
}
function restore(s) {
  const resized = s.w !== state.art.w || s.h !== state.art.h;
  state.art = { w: s.w, h: s.h, data: s.data };
  if (resized) {
    editSel.clear();
    fitZoom();
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

// Masque de la zone de même couleur que le pixel (x, y) (contiguë ou non, selon l'option).
function regionAt(x, y) {
  const a = state.art, d = a.data, W = a.w, H = a.h;
  const tol = parseInt($('wtol').value, 10);
  const i0 = (y * W + x) * 4;
  const tr = d[i0], tg = d[i0 + 1], tb = d[i0 + 2], tt = d[i0 + 3] < 128;
  const mask = new Uint8Array(W * H);

  const match = (i) => {
    const t = d[i + 3] < 128;
    if (t || tt) return t && tt;
    return dist(d[i], d[i + 1], d[i + 2], tr, tg, tb) <= tol;
  };

  if (!$('contig').checked) {
    for (let p = 0; p < W * H; p++) if (match(p * 4)) mask[p] = 1;
    return mask;
  }
  const seen = new Uint8Array(W * H);
  const start = y * W + x;
  const stack = [start];
  seen[start] = 1;
  while (stack.length) {
    const p = stack.pop();
    if (!match(p * 4)) continue;
    mask[p] = 1;
    const px = p % W, py = (p / W) | 0;
    if (px > 0 && !seen[p - 1]) { seen[p - 1] = 1; stack.push(p - 1); }
    if (px < W - 1 && !seen[p + 1]) { seen[p + 1] = 1; stack.push(p + 1); }
    if (py > 0 && !seen[p - W]) { seen[p - W] = 1; stack.push(p - W); }
    if (py < H - 1 && !seen[p + W]) { seen[p + W] = 1; stack.push(p + W); }
  }
  return mask;
}

// Pixels du contour d'une zone. Voisinage à 4 (haut, bas, gauche, droite) : seuls les pixels au
// contact direct du bord sont retenus, si bien qu'une oblique donne une ligne de 1 pixel sans
// pixels de coin. Les bords de l'image ne comptent pas comme des bords de zone.
function outlineMask(mask, W, H, outer, corners) {
  const out = new Uint8Array(W * H);
  const inR = (x, y) => x >= 0 && y >= 0 && x < W && y < H && mask[y * W + x] === 1;
  const DIRS = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = y * W + x;
      if (outer) {
        if (mask[p]) continue;
        for (const [dx, dy] of DIRS) if (inR(x + dx, y + dy)) { out[p] = 1; break; }
      } else {
        if (!mask[p]) continue;
        for (const [dx, dy] of DIRS) {
          const nx = x + dx, ny = y + dy;
          if (nx >= 0 && ny >= 0 && nx < W && ny < H && !mask[ny * W + nx]) { out[p] = 1; break; }
        }
      }
    }
  }
  if (outer && corners) {
    // Angle droit saillant : on complète le coin seulement si toute la rangée et la colonne voisines
    // sont hors zone (sur une oblique, un voisin diagonal est dans la zone : le coin est alors ignoré).
    for (let y = 0; y < H; y++) {
      for (let x = 0; x < W; x++) {
        if (!mask[y * W + x]) continue;
        for (const dx of [-1, 1]) {
          for (const dy of [-1, 1]) {
            const tx = x + dx, ty = y + dy;
            if (tx < 0 || ty < 0 || tx >= W || ty >= H) continue;
            if (!inR(tx, y) && !inR(x, ty) && !inR(x - dx, ty) && !inR(tx, y - dy) && !inR(tx, ty)) out[ty * W + tx] = 1;
          }
        }
      }
    }
  }
  return out;
}

function paintMask(mask, erase) {
  const d = state.art.data, [r, g, b] = state.color;
  for (let p = 0; p < mask.length; p++) {
    if (!mask[p]) continue;
    const i = p * 4;
    if (erase) { d[i] = d[i + 1] = d[i + 2] = d[i + 3] = 0; }
    else { d[i] = r; d[i + 1] = g; d[i + 2] = b; d[i + 3] = 255; }
  }
}

function applyRegionTool(tool, x, y) {
  const a = state.art;
  const region = regionAt(x, y);
  let mask = region;
  if (tool === 'outline') {
    const outer = document.querySelector('input[name="olSide"]:checked').value === 'outer';
    mask = outlineMask(region, a.w, a.h, outer, $('olCorners').checked);
    if (!mask.some((v) => v)) { toast('Aucun contour à tracer pour cette zone.'); return; }
  }
  pushUndo();
  paintMask(mask, tool === 'wand');
  afterEdit();
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
      editSel.down(e);
      canvas.setPointerCapture(e.pointerId);
      return;
    }
    if (tool === 'fill' || tool === 'wand' || tool === 'outline') {
      applyRegionTool(tool, x, y);
      return;
    }
    pushUndo();
    stroke = { x, y, erase: tool === 'eraser' };
    paintBrush(x, y, stroke.erase);
    canvas.setPointerCapture(e.pointerId);
    renderArt();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (editSel.drag) { editSel.move(e); return; }
    if (!stroke) {
      // curseur adapté (déplacer / redimensionner) au survol de la sélection de recadrage
      if (state.tool === 'crop') canvas.style.cursor = editSel.cursor(e);
      else if (canvas.style.cursor) canvas.style.cursor = '';
      return;
    }
    const { x, y } = cellFromEvent(e);
    if (x === stroke.x && y === stroke.y) return;
    line(stroke.x, stroke.y, x, y, (px, py) => paintBrush(px, py, stroke.erase));
    stroke.x = x; stroke.y = y;
    renderArt();
  });

  const end = () => {
    if (editSel.drag) { editSel.up(); return; }
    if (!stroke) return;
    stroke = null;
    afterEdit();
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);
})();

/* ------------------------------ recadrage de la retouche ------------------------------ */

function updateEditCropUi() {
  const r = editSel.rect();
  $('btnCrop').disabled = !r;
  $('btnCropClear').disabled = !r;
  $('cropInfo').textContent = r ? `Sélection : ${r.w} × ${r.h} px` : 'Aucune sélection';
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
  editSel.clear();
  fitZoom();
  afterEdit();
}

function applyCrop() {
  const r = editSel.rect();
  if (!r || !state.art) return;
  if (r.w === state.art.w && r.h === state.art.h) { editSel.clear(); return; }
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
$('btnCropClear').addEventListener('click', () => editSel.clear());
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

function isTyping(e) {
  // On ne bloque que la saisie de texte : les curseurs, cases et sélecteurs de couleur
  // gardent le focus après un clic et ne doivent pas empêcher les raccourcis.
  const tag = (e.target.tagName || '').toLowerCase();
  const type = (e.target.type || '').toLowerCase();
  return tag === 'textarea' || (tag === 'input' && ['text', 'number', 'search', 'email', 'url', 'password'].includes(type));
}

window.addEventListener('keydown', (e) => {
  if (isTyping(e)) return;
  const mod = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();

  if (state.view === 1) {
    if (!state.src) return;
    if (e.code === 'Space' && !mod) {
      // Espace maintenu + glisser = déplacer la vue de l'original
      e.preventDefault();
      if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();
      setSpace(true);
      return;
    }
    if (mod || e.altKey) return;
    if (k === 'c') toggleOption('contrast', 'Favoriser le contraste');
    else if (k === 't') toggleOption('lines', 'Détection des traits fins');
    else if (k === 'enter' && srcSel.sel && state.srcMode === 'crop') { e.preventDefault(); applySrcCrop(); }
    else if (k === 'escape' && srcSel.sel) srcSel.clear();
    return;
  }

  if (mod && k === 'z') { e.preventDefault(); e.shiftKey ? redo() : undo(); return; }
  if (mod && k === 'y') { e.preventDefault(); redo(); return; }
  if (mod || e.altKey) return;
  if (k === 'enter' && editSel.sel) { e.preventDefault(); applyCrop(); return; }
  if (k === 'escape' && editSel.sel) { editSel.clear(); return; }
  const tools = { p: 'pen', e: 'eraser', f: 'fill', w: 'wand', o: 'outline', i: 'pick', c: 'crop' };
  if (tools[k]) setTool(tools[k]);
});

window.addEventListener('keyup', (e) => {
  if (e.code === 'Space' && spaceDown) { e.preventDefault(); setSpace(false); }
});
window.addEventListener('blur', () => setSpace(false));

/* ------------------------------ init ------------------------------ */

updateOutputs();
updateLineUi();
updateSizeOut();
updateSrcCropUi();
updateEditCropUi();
renderPickList();
setColor(state.color);

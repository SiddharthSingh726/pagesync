/* PageSync — PDF viewer, annotation tools and live sync. */
import * as pdfjsLib from '../vendor/pdfjs/pdf.min.mjs';
import * as backend from './backend.js';

const { icon, escapeHtml, toast, storage, timeAgo, device, clientId, uid } = PS;
PS.hydrateIcons();
// Never switch versions under an open PDF; reload only if a switch happens before it has finished loading.
backend.registerServiceWorker({ autoUpdate: false, reloadOnChange: () => !state.ready });
const PDFJS_BASE = new URL('../vendor/pdfjs/', import.meta.url).href;
pdfjsLib.GlobalWorkerOptions.workerSrc = PDFJS_BASE + 'pdf.worker.min.mjs';

const $ = (id) => document.getElementById(id);
const viewer = $('viewer');
const pagesEl = $('pages');
const docId = new URLSearchParams(location.search).get('id');

const MIN_ZOOM = 0.4;
const MAX_ZOOM = 5;
const PAGE_GAP = 14;

const COLORS = ['#ffd400', '#ffa14a', '#ff6b8b', '#7bd389', '#5ec8f2', '#9b8cff', '#1f1f1f', '#e5383b', '#1e6fd9', '#2a9d55', '#7b4ae2', '#ffffff'];
const TOOL_STYLE_DEFAULTS = {
  texthl: { color: '#ffd400', mode: 'highlight' },
  highlight: { color: '#ffd400' },
  marker: { color: '#ffd400', size: 14, min: 4, max: 32, step: 1, label: 'Thickness' },
  pen: { color: '#1e6fd9', size: 2, min: 0.5, max: 12, step: 0.5, label: 'Thickness' },
  text: { color: '#1f1f1f', size: 14, min: 6, max: 48, step: 1, label: 'Font size' },
  note: { color: '#ffd400' },
};

const state = {
  doc: null,
  pdf: null,
  pages: [], // { num, width, height, el, svg, html, canvas, renderedScale, rendering, task }
  scale: 1,
  zoom: storage.get('ps_zoom_' + docId, 1),
  tool: 'hand',
  styles: mergeStyles(storage.get('ps_styles', {})),
  anns: new Map(),
  pending: storage.get('ps_pending_' + docId, []),
  undo: [],
  redo: [],
  flushing: false,
  online: true,
  ready: false,
  editor: null, // open text editor
  gesture: null, // current pointer gesture
  penSeen: false,
  lastPos: null,
  knownPositionAt: null,
  remotePosition: null,
  dirtyPages: new Set(),
  search: null, // { q, matches: [{ page, start, end }], index }
  outline: null,
  panelTab: 'notes',
  lastCommitAt: 0,
  aiEnabled: false,
};

function mergeStyles(saved) {
  const out = {};
  for (const [tool, def] of Object.entries(TOOL_STYLE_DEFAULTS)) out[tool] = { ...def, ...(saved[tool] || {}), min: def.min, max: def.max, step: def.step, label: def.label };
  return out;
}

/* =================================================================== init */

async function init() {
  if (!docId) return fatal('No document selected.');
  await backend.requireAuth();
  try {
    const res = await backend.getDoc(docId);
    state.doc = res.doc;
    state.online = !res.offline;
  } catch (err) {
    return fatal(err.status === 404 ? 'This PDF was deleted.' : err.offline ? err.message : 'Could not open: ' + err.message);
  }
  document.title = `${state.doc.name} · PageSync`;
  $('doc-title').textContent = state.doc.name.replace(/\.pdf$/i, '');
  state.anns = new Map(state.doc.annotations.map((a) => [a.id, a]));
  for (const op of state.pending) applyOpLocally(op);
  state.knownPositionAt = state.doc.position?.at || null;

  let bytes;
  try {
    ({ bytes } = await backend.getPdfBytes(state.doc, (f) => {
      $('loader-text').textContent = `Downloading PDF… ${Math.round(f * 100)}%`;
    }));
  } catch (err) {
    return fatal(err.offline ? "You're offline and this PDF isn't saved on this device yet. Open it once while online and it will work offline after that." : 'Could not download the PDF: ' + err.message);
  }
  $('loader-text').textContent = 'Opening PDF…';

  const task = pdfjsLib.getDocument({
    data: bytes,
    cMapUrl: PDFJS_BASE + 'cmaps/',
    cMapPacked: true,
    standardFontDataUrl: PDFJS_BASE + 'standard_fonts/',
    wasmUrl: PDFJS_BASE + 'wasm/',
    iccUrl: PDFJS_BASE + 'iccs/',
  });
  task.onPassword = (updatePassword, reason) => {
    const again = reason === pdfjsLib.PasswordResponses.INCORRECT_PASSWORD;
    PS.prompt(again ? 'Wrong password, try again' : 'This PDF is password protected', '', { label: 'Open' }).then((pw) =>
      pw === null ? fatal('Password required.') : updatePassword(pw)
    );
  };
  try {
    state.pdf = await task.promise;
  } catch (err) {
    return fatal('This PDF could not be read: ' + err.message);
  }

  $('page-count').textContent = `/ ${state.pdf.numPages}`;
  await buildPages();
  layout();
  $('loader').hidden = true;

  restorePosition();
  state.ready = true;
  setupTools();
  setupInput();
  setupSelectionBar();
  setupSearch();
  setupPanelTabs();
  setNight(storage.get('ps_night', false));
  backend.getLimits().then((l) => (state.aiEnabled = !!l?.aiEnabled)).catch(() => {});
  renderAllAnnotations();
  scheduleVisible();
  updateUndoButtons();
  connectLive();
  setSync(state.online ? 'saved' : 'offline');
  flushSoon(0);
  makeThumbnail();
}

function fatal(message) {
  $('loader').innerHTML = `<div class="box" style="max-width:420px;text-align:center;padding:16px"><div>${escapeHtml(message)}</div><a class="btn" href="index.html">Back to library</a></div>`;
  $('loader').hidden = false;
}

/* ================================================================= layout */

async function buildPages() {
  const n = state.pdf.numPages;
  const sizes = new Array(n);
  // Read page sizes in parallel chunks (needed to lay out pages before rendering).
  for (let start = 1; start <= n; start += 24) {
    const batch = [];
    for (let i = start; i < Math.min(n + 1, start + 24); i++) {
      batch.push(
        state.pdf.getPage(i).then((page) => {
          const vp = page.getViewport({ scale: 1 });
          sizes[i - 1] = { width: vp.width, height: vp.height };
        })
      );
    }
    await Promise.all(batch);
    if (n > 60) $('loader-text').textContent = `Preparing pages… ${Math.min(n, start + 23)}/${n}`;
  }

  const frag = document.createDocumentFragment();
  state.pages = sizes.map((s, i) => {
    const el = document.createElement('div');
    el.className = 'page';
    el.dataset.page = i + 1;
    el.innerHTML = `<div class="loading-ph">${i + 1}</div>
      <svg class="annots" viewBox="0 0 ${s.width} ${s.height}" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg"></svg>
      <div class="search-layer"></div>
      <div class="html-layer"></div>
      <div class="page-num">${i + 1}</div>`;
    frag.appendChild(el);
    return {
      num: i + 1,
      width: s.width,
      height: s.height,
      el,
      svg: el.querySelector('svg'),
      html: el.querySelector('.html-layer'),
      searchLayer: el.querySelector('.search-layer'),
      textLayer: null,
      textDivs: null,
      textContent: null,
      ph: el.querySelector('.loading-ph'),
      canvas: null,
      renderedScale: null,
      rendering: false,
    };
  });
  pagesEl.appendChild(frag);
}

function fitScale() {
  const widest = Math.max(...state.pages.map((p) => p.width));
  const available = Math.min(viewer.clientWidth - 24, 980);
  return Math.max(0.1, available / widest);
}

function layout() {
  state.scale = fitScale() * state.zoom;
  pagesEl.style.setProperty('--total-scale-factor', String(state.scale));
  pagesEl.style.setProperty('--scale-round-x', '1px');
  pagesEl.style.setProperty('--scale-round-y', '1px');
  for (const p of state.pages) {
    p.el.style.width = `${Math.round(p.width * state.scale)}px`;
    p.el.style.height = `${Math.round(p.height * state.scale)}px`;
  }
}

/** Where in the document the top of the screen is: { page, offset (0..1 within page) }. */
function topPosition() {
  const y = viewer.scrollTop + 4;
  let p = state.pages[0];
  for (const page of state.pages) {
    if (page.el.offsetTop - PAGE_GAP <= y) p = page;
    else break;
  }
  const offset = Math.min(1, Math.max(0, (y - p.el.offsetTop) / p.el.offsetHeight));
  return { page: p.num, offset: Math.round(offset * 1000) / 1000 };
}

/** The page you're reading: the one under a line a little below the top of the screen. */
function currentPage() {
  const y = viewer.scrollTop + Math.min(viewer.clientHeight * 0.3, 160);
  let p = state.pages[0];
  for (const page of state.pages) {
    if (page.el.offsetTop - PAGE_GAP <= y) p = page;
    else break;
  }
  return p ? p.num : 1;
}

function scrollToPosition(page, offset = 0, smooth = false) {
  const p = state.pages[Math.min(state.pages.length, Math.max(1, page)) - 1];
  if (!p) return;
  viewer.scrollTo({ top: p.el.offsetTop + offset * p.el.offsetHeight - (offset ? 4 : 10), behavior: smooth ? 'smooth' : 'auto' });
}

function setZoom(z, anchor) {
  z = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z));
  if (Math.abs(z - state.zoom) < 0.001) return;
  // Keep the point under the anchor (or screen centre) in place.
  const ax = anchor ? anchor.x : viewer.clientWidth / 2;
  const ay = anchor ? anchor.y : viewer.clientHeight / 3;
  const docY = viewer.scrollTop + ay;
  let p = state.pages[0];
  for (const page of state.pages) {
    if (page.el.offsetTop <= docY) p = page;
    else break;
  }
  const fy = (docY - p.el.offsetTop) / p.el.offsetHeight;
  const fx = (viewer.scrollLeft + ax - p.el.offsetLeft) / p.el.offsetWidth;

  state.zoom = z;
  storage.set('ps_zoom_' + docId, z);
  layout();
  viewer.scrollTop = p.el.offsetTop + fy * p.el.offsetHeight - ay;
  viewer.scrollLeft = p.el.offsetLeft + fx * p.el.offsetWidth - ax;
  renderAllAnnotations();
  scheduleVisible();
}

/* ============================================================== rendering */

let visibleQueued = false;
function scheduleVisible() {
  if (visibleQueued) return;
  visibleQueued = true;
  requestAnimationFrame(() => {
    visibleQueued = false;
    updateVisible();
  });
}

let renderingNow = false;
function updateVisible() {
  const top = viewer.scrollTop;
  const bottom = top + viewer.clientHeight;
  const near = viewer.clientHeight * 1.2;
  const far = viewer.clientHeight * 4;
  const centre = (top + bottom) / 2;
  const wanted = [];

  for (const p of state.pages) {
    const pTop = p.el.offsetTop;
    const pBottom = pTop + p.el.offsetHeight;
    if (pBottom > top - near && pTop < bottom + near) {
      if (p.renderedScale !== state.scale) wanted.push(p);
    } else if ((pBottom < top - far || pTop > bottom + far) && p.canvas && !p.rendering) {
      // Free memory for pages far away (important on phones).
      p.canvas.width = 0;
      p.canvas.remove();
      p.canvas = null;
      p.renderedScale = null;
      p.ph.hidden = false;
      p.textLayer?.remove();
      p.textLayer = null;
      p.textDivs = null;
      p.searchLayer.innerHTML = '';
    }
  }
  if (renderingNow || !wanted.length) return;
  wanted.sort((a, b) => Math.abs(a.el.offsetTop - centre) - Math.abs(b.el.offsetTop - centre));
  renderingNow = true;
  renderPage(wanted[0]).finally(() => {
    renderingNow = false;
    scheduleVisible();
  });
}

async function renderPage(p) {
  const scale = state.scale;
  p.rendering = true;
  try {
    const page = await state.pdf.getPage(p.num);
    const cssW = p.width * scale;
    const cssH = p.height * scale;
    let dpr = Math.min(window.devicePixelRatio || 1, 2);
    const maxPixels = 14e6; // phones refuse giant canvases
    if (cssW * cssH * dpr * dpr > maxPixels) dpr = Math.sqrt(maxPixels / (cssW * cssH));
    const viewport = page.getViewport({ scale: scale * dpr });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    p.task = page.render({ canvas, viewport });
    await p.task.promise;
    if (scale !== state.scale) {
      canvas.width = 0;
      return; // zoom changed while rendering; will re-render
    }
    if (p.canvas) {
      p.canvas.width = 0;
      p.canvas.remove();
    }
    p.el.insertBefore(canvas, p.el.firstChild);
    p.canvas = canvas;
    p.renderedScale = scale;
    p.ph.hidden = true;
    await renderTextLayer(p, page, scale);
  } catch (err) {
    if (err?.name !== 'RenderingCancelledException') console.error(`Page ${p.num}:`, err);
  } finally {
    p.rendering = false;
    p.task = null;
  }
}

/** The invisible, selectable text on top of a page (what makes text highlighting snap to words). */
async function renderTextLayer(p, page, scale) {
  try {
    if (!p.textContent) p.textContent = await page.getTextContent();
    if (scale !== state.scale) return;
    const div = document.createElement('div');
    div.className = 'textLayer';
    const tc = p.textContent;
    const layer = new pdfjsLib.TextLayer({
      textContentSource: { items: tc.items, styles: tc.styles, lang: tc.lang },
      container: div,
      viewport: page.getViewport({ scale }),
    });
    await layer.render();
    if (scale !== state.scale || p.renderedScale !== scale) return;
    p.textLayer?.remove();
    p.el.insertBefore(div, p.svg);
    p.textLayer = div;
    p.textDivs = layer.textDivs;
    if (state.search) drawSearchHits(p);
  } catch (err) {
    console.warn(`Text layer for page ${p.num}:`, err);
  }
}

async function pageTextContent(n) {
  const p = state.pages[n - 1];
  if (!p.textContent) p.textContent = await (await state.pdf.getPage(n)).getTextContent();
  return p.textContent;
}

const pageHasText = (p) => !!p.textContent && p.textContent.items.some((it) => it.str && it.str.trim());

/* ===================================================== annotation drawing */

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

function strokePath(points, W, H) {
  if (!points.length) return '';
  const pts = points.map(([x, y]) => [x * W, y * H]);
  const f = (n) => n.toFixed(2);
  if (pts.length === 1) return `M${f(pts[0][0])} ${f(pts[0][1])}l0.01 0`;
  if (pts.length === 2) return `M${f(pts[0][0])} ${f(pts[0][1])}L${f(pts[1][0])} ${f(pts[1][1])}`;
  let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const mx = (pts[i][0] + pts[i + 1][0]) / 2;
    const my = (pts[i][1] + pts[i + 1][1]) / 2;
    d += `Q${f(pts[i][0])} ${f(pts[i][1])} ${f(mx)} ${f(my)}`;
  }
  const last = pts[pts.length - 1];
  return d + `L${f(last[0])} ${f(last[1])}`;
}

function drawAnnotation(p, a) {
  const W = p.width;
  const H = p.height;
  if (a.type === 'highlight') {
    const g = svgEl('g', { 'data-id': a.id });
    g.appendChild(svgEl('rect', { class: 'ann-highlight', x: a.x * W, y: a.y * H, width: a.w * W, height: a.h * H, fill: a.color, 'fill-opacity': 0.38 }));
    p.svg.appendChild(g);
  } else if (a.type === 'texthl') {
    const g = svgEl('g', { 'data-id': a.id });
    for (const [x, y, w, h] of a.rects || []) {
      const X = x * W, Y = y * H, RW = w * W, RH = h * H;
      if (a.mode === 'underline') {
        const t = Math.max(0.8, RH * 0.08);
        g.appendChild(svgEl('rect', { x: X, y: Y + RH * 0.94 - t / 2, width: RW, height: t, fill: a.color }));
      } else if (a.mode === 'strike') {
        const t = Math.max(0.8, RH * 0.075);
        g.appendChild(svgEl('rect', { x: X, y: Y + RH * 0.52 - t / 2, width: RW, height: t, fill: a.color }));
      } else {
        g.appendChild(svgEl('rect', { class: 'ann-texthl', x: X, y: Y, width: RW, height: RH, rx: Math.min(2, RH * 0.15), fill: a.color, 'fill-opacity': 0.4 }));
      }
      g.appendChild(svgEl('rect', { class: 'hl-hit', x: X, y: Y, width: RW, height: RH }));
    }
    p.svg.appendChild(g);
  } else if (a.type === 'pen' || a.type === 'marker') {
    const d = strokePath(a.points, W, H);
    const g = svgEl('g', { 'data-id': a.id });
    g.appendChild(
      svgEl('path', {
        class: a.type === 'marker' ? 'ann-marker' : 'ann-pen',
        d,
        fill: 'none',
        stroke: a.color,
        'stroke-width': a.size,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-opacity': a.type === 'marker' ? 0.4 : 1,
      })
    );
    g.appendChild(svgEl('path', { class: 'hit', d, 'stroke-width': Math.max(a.size, 10 / state.scale), 'stroke-linecap': 'round' }));
    p.svg.appendChild(g);
  } else if (a.type === 'text') {
    if (state.editor && state.editor.id === a.id) return;
    const div = document.createElement('div');
    div.className = 'text-annot';
    div.dataset.id = a.id;
    div.textContent = a.text;
    Object.assign(div.style, {
      left: a.x * 100 + '%',
      top: a.y * 100 + '%',
      maxWidth: (a.w || 0.45) * 100 + '%',
      color: a.color,
      fontSize: a.size * state.scale + 'px',
    });
    p.html.appendChild(div);
  } else if (a.type === 'note') {
    const pin = document.createElement('div');
    pin.className = 'note-pin';
    pin.dataset.id = a.id;
    pin.title = a.text || 'Note';
    pin.style.left = a.x * 100 + '%';
    pin.style.top = a.y * 100 + '%';
    pin.style.background = a.color;
    pin.innerHTML = icon('note');
    p.html.appendChild(pin);
  }
  // A small note marker on highlights that have a comment
  if (a.note && (a.type === 'texthl' || a.type === 'highlight')) {
    const r = a.type === 'texthl' ? a.rects?.[0] : [a.x, a.y, a.w, a.h];
    if (!r) return;
    const badge = document.createElement('div');
    badge.className = 'hl-note-badge';
    badge.dataset.id = a.id;
    badge.dataset.badge = '1';
    badge.title = a.note;
    badge.style.left = (r[0] + r[2]) * 100 + '%';
    badge.style.top = r[1] * 100 + '%';
    badge.style.background = a.color;
    badge.innerHTML = icon('note');
    p.html.appendChild(badge);
  }
}

function renderPageAnnotations(p) {
  // keep any in-progress drawing (class "live") and the open text editor
  for (const el of [...p.svg.children]) if (!el.classList.contains('live')) el.remove();
  for (const el of [...p.html.children]) if (!el.classList.contains('text-editor')) el.remove();
  const list = [...state.anns.values()].filter((a) => a.page === p.num).sort((a, b) => a.createdAt - b.createdAt);
  for (const a of list) drawAnnotation(p, a);
}

function renderAllAnnotations() {
  for (const p of state.pages) renderPageAnnotations(p);
  renderPanel();
}

let dirtyQueued = false;
function markDirty(...pageNums) {
  for (const n of pageNums) if (n) state.dirtyPages.add(n);
  if (dirtyQueued) return;
  dirtyQueued = true;
  requestAnimationFrame(() => {
    dirtyQueued = false;
    for (const n of state.dirtyPages) if (state.pages[n - 1]) renderPageAnnotations(state.pages[n - 1]);
    state.dirtyPages.clear();
    renderPanel();
  });
}

/* ============================================ changes, undo/redo, sync */

/** Set (or with ann=null, delete) one annotation locally and queue it for the server. */
function setAnn(id, ann) {
  const prev = state.anns.get(id);
  if (ann) {
    const restore = !prev; // re-adding (e.g. undo of a delete)
    ann = { ...ann, updatedAt: Date.now() };
    state.anns.set(id, ann);
    queueOp({ type: 'upsert', ann, restore });
  } else {
    if (!prev) return;
    state.anns.delete(id);
    queueOp({ type: 'delete', id, at: Date.now() });
  }
  markDirty(prev?.page, ann?.page);
}

/** Apply a user change and remember it for undo. changes = [{ id, before, after }] */
function commit(changes) {
  changes = changes.filter((c) => c.before || c.after);
  if (!changes.length) return;
  for (const c of changes) setAnn(c.id, c.after);
  state.lastCommitAt = Date.now();
  state.undo.push(changes);
  if (state.undo.length > 200) state.undo.shift();
  state.redo = [];
  updateUndoButtons();
}

function undo() {
  const changes = state.undo.pop();
  if (!changes) return;
  for (const c of [...changes].reverse()) setAnn(c.id, c.before);
  state.redo.push(changes);
  updateUndoButtons();
  revealChange(changes);
}

function redo() {
  const changes = state.redo.pop();
  if (!changes) return;
  for (const c of changes) setAnn(c.id, c.after);
  state.undo.push(changes);
  updateUndoButtons();
  revealChange(changes);
}

function revealChange(changes) {
  const a = changes[0].after || changes[0].before;
  if (!a) return;
  const p = state.pages[a.page - 1];
  const y = p.el.offsetTop + (a.y ?? a.points?.[0]?.[1] ?? 0) * p.el.offsetHeight;
  if (y < viewer.scrollTop || y > viewer.scrollTop + viewer.clientHeight) scrollToPosition(a.page, a.y ?? 0, true);
}

function updateUndoButtons() {
  $('undo').disabled = !state.undo.length;
  $('redo').disabled = !state.redo.length;
}

function applyOpLocally(op) {
  if (op.type === 'upsert') {
    const cur = state.anns.get(op.ann.id);
    if (cur && cur.updatedAt > op.ann.updatedAt) return null;
    state.anns.set(op.ann.id, op.ann);
    return [cur?.page, op.ann.page];
  }
  if (op.type === 'delete') {
    const cur = state.anns.get(op.id);
    state.anns.delete(op.id);
    if (state.editor && state.editor.id === op.id) closeTextEditor(false);
    return [cur?.page];
  }
  return null;
}

function queueOp(op) {
  state.pending.push(op);
  storage.set('ps_pending_' + docId, state.pending);
  setSync(state.online ? 'saving' : 'offline');
  flushSoon();
  saveLocalCopySoon();
}

/** Keep an up-to-date copy of this document on the device, for offline use. */
let localCopyTimer;
function saveLocalCopySoon() {
  clearTimeout(localCopyTimer);
  localCopyTimer = setTimeout(saveLocalCopy, 800);
}
function saveLocalCopy() {
  clearTimeout(localCopyTimer);
  if (!state.doc) return;
  backend.cacheDocState({ ...state.doc, annotations: [...state.anns.values()] });
}

/** A change pushed live from another device. row = { id, data, deleted, updated_at } */
function applyRemoteRow(row) {
  const cur = state.anns.get(row.id);
  if (row.deleted) {
    if (!cur || (cur.updatedAt || 0) > Number(row.updated_at)) return; // a newer local change (e.g. undo) wins
    state.anns.delete(row.id);
    if (state.editor && state.editor.id === row.id) closeTextEditor(false);
    markDirty(cur.page);
  } else {
    const ann = row.data;
    if (!ann || (cur && (cur.updatedAt || 0) >= (ann.updatedAt || 0))) return; // our own echo, or older
    state.anns.set(ann.id, ann);
    markDirty(cur?.page, ann.page);
  }
  saveLocalCopySoon();
}

let flushTimer;
function flushSoon(delay = 250) {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, delay);
}

async function flush() {
  if (state.flushing || !state.pending.length) {
    if (!state.pending.length) setSync(state.online ? 'saved' : 'offline');
    return;
  }
  state.flushing = true;
  const batch = state.pending.slice(0, 300);
  try {
    await backend.applyOps(docId, batch);
    state.pending.splice(0, batch.length);
    storage.set('ps_pending_' + docId, state.pending);
    state.online = true;
    state.flushing = false;
    saveLocalCopySoon();
    if (state.pending.length) flush();
    else setSync('saved');
  } catch (err) {
    state.flushing = false;
    if (err.status === 404) return fatal('This PDF was deleted on another device.');
    if (err.offline || err.status === 401 || !err.status || err.status >= 500) {
      // no connection (or a hiccup): keep the changes on this device and retry
      state.online = !err.offline;
      setSync(err.offline ? 'offline' : 'saving');
      flushSoon(err.offline ? 5000 : 8000);
      return;
    }
    // The cloud refused these changes (should not happen) — don't retry forever.
    console.error('Changes rejected:', err);
    state.pending.splice(0, batch.length);
    storage.set('ps_pending_' + docId, state.pending);
    toast('Some changes could not be saved: ' + err.message, { error: true, duration: 7000 });
    if (state.pending.length) flushSoon(0);
    else setSync('saved');
  }
}

function setSync(kind) {
  const el = $('sync');
  el.className = 'sync ' + kind;
  const n = state.pending.length;
  $('sync-text').textContent =
    kind === 'saving' ? 'Saving…' : kind === 'offline' ? (n ? `Offline · ${n} change${n === 1 ? '' : 's'} saved on this device` : 'Offline') : 'Synced';
}

/* ============================================================ live updates */

function connectLive() {
  let hadError = false;
  backend.subscribeDoc(docId, {
    onAnnotation: applyRemoteRow,
    onDocument: (d) => {
      const pos = d.position;
      state.doc = { ...state.doc, ...d, annotations: undefined };
      $('doc-title').textContent = d.name.replace(/\.pdf$/i, '');
      document.title = `${d.name} · PageSync`;
      if (pos && pos.at !== state.knownPositionAt) {
        state.knownPositionAt = pos.at;
        if (pos.clientId !== clientId) {
          state.remotePosition = pos;
          if (document.visibilityState === 'visible' && document.hasFocus()) state.remotePosition = null; // you're reading here
        }
      }
    },
    onDeleted: () => fatal('This PDF was deleted on another device.'),
    onStatus: (status) => {
      if (status === 'SUBSCRIBED') {
        if (hadError) resync();
        hadError = false;
      } else hadError = true;
    },
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') resync();
  });
  addEventListener('focus', () => offerRemotePosition());
  addEventListener('online', () => resync());
  addEventListener('offline', () => {
    state.online = false;
    setSync('offline');
  });
}

/** Reload everything from the cloud (after being offline / in the background). */
let resyncing = false;
async function resync() {
  if (resyncing) return;
  resyncing = true;
  try {
    const { doc, offline } = await backend.getDoc(docId);
    if (offline) {
      state.online = false;
      setSync('offline');
      return;
    }
    state.doc = doc;
    state.anns = new Map(doc.annotations.map((a) => [a.id, a]));
    for (const op of state.pending) applyOpLocally(op);
    renderAllAnnotations();
    state.online = true;
    flushSoon(0);
    if (state.positionUnsaved) savePosition(true);
    const pos = doc.position;
    if (pos && pos.clientId !== clientId && pos.at !== state.knownPositionAt) state.remotePosition = pos;
    state.knownPositionAt = pos?.at || state.knownPositionAt;
    offerRemotePosition();
    saveLocalCopy();
  } catch (err) {
    if (err.status === 404) return fatal('This PDF was deleted on another device.');
    state.online = false;
    setSync('offline');
  } finally {
    resyncing = false;
  }
}

function offerRemotePosition() {
  const pos = state.remotePosition;
  state.remotePosition = null;
  if (!pos || Math.abs(pos.page - topPosition().page) < 1) return;
  toast(`You were on page ${pos.page} on ${pos.device}`, {
    action: { label: 'Jump there', run: () => scrollToPosition(pos.page, pos.offset, false) },
  });
}

/* ======================================================== reading position */

function restorePosition() {
  const pos = state.doc.position;
  if (pos && pos.page > 1 || (pos && pos.offset > 0.02)) {
    scrollToPosition(pos.page, pos.offset);
    const where = pos.clientId === clientId || pos.device === device.name ? '' : ` from ${pos.device}`;
    toast(`Resumed on page ${pos.page}${where} · ${timeAgo(pos.at)}`, {
      action: pos.page > 1 ? { label: 'Go to start', run: () => scrollToPosition(1) } : undefined,
      duration: 4000,
    });
  }
  state.lastPos = topPosition();
  updatePager();
}

let posTimer;
function onScrolled() {
  updatePager();
  scheduleVisible();
  if (!state.ready) return;
  if (document.hasFocus()) state.remotePosition = null;
  clearTimeout(posTimer);
  posTimer = setTimeout(savePosition, 1200);
}

function positionPayload() {
  return { ...topPosition(), pageCount: state.pdf.numPages, device: device.name, clientId };
}

function rememberPositionLocally(payload) {
  const at = new Date().toISOString();
  state.doc.position = { page: payload.page, offset: payload.offset, device: payload.device, clientId, at };
  state.doc.pageCount = payload.pageCount;
  state.knownPositionAt = at;
  saveLocalCopySoon();
}

function savePosition(force = false) {
  const pos = topPosition();
  if (!force && state.lastPos && pos.page === state.lastPos.page && Math.abs(pos.offset - state.lastPos.offset) < 0.03) return;
  state.lastPos = pos;
  const payload = positionPayload();
  rememberPositionLocally(payload);
  backend
    .savePosition(docId, payload)
    .then(() => (state.positionUnsaved = false))
    .catch(() => (state.positionUnsaved = true)); // offline: sent when we reconnect
}

function savePositionOnExit() {
  if (!state.ready) return;
  clearTimeout(posTimer);
  const payload = positionPayload();
  rememberPositionLocally(payload);
  saveLocalCopy();
  if (navigator.onLine) backend.savePosition(docId, payload, { keepalive: true });
  if (state.pending.length) storage.set('ps_pending_' + docId, state.pending);
}

function updatePager() {
  const input = $('page-input');
  if (document.activeElement !== input) input.value = currentPage();
}

/* ================================================================== tools */

function setupTools() {
  const dock = $('dock');
  dock.addEventListener('click', (e) => {
    const b = e.target.closest('[data-tool]');
    if (b) setTool(b.dataset.tool);
  });
  $('undo').onclick = undo;
  $('redo').onclick = redo;
  $('style-btn').onclick = (e) => {
    e.stopPropagation();
    toggleStylePop();
  };
  document.addEventListener('pointerdown', (e) => {
    if (!$('style-pop').hidden && !e.target.closest('#style-pop, #style-btn')) $('style-pop').hidden = true;
  });
  $('swatches').innerHTML = COLORS.map((c) => `<button data-color="${c}" style="background:${c}" aria-label="Color ${c}"></button>`).join('');
  $('swatches').onclick = (e) => {
    const c = e.target.closest('[data-color]')?.dataset.color;
    if (!c) return;
    styleFor().color = c;
    saveStyles();
    refreshStyleUi();
  };
  $('markup-modes').onclick = (e) => {
    const m = e.target.closest('[data-mode]')?.dataset.mode;
    if (!m) return;
    styleFor('texthl').mode = m;
    saveStyles();
    refreshStyleUi();
  };
  $('size').oninput = (e) => {
    styleFor().size = Number(e.target.value);
    saveStyles();
    refreshStyleUi();
  };

  $('zoom-in').onclick = () => setZoom(state.zoom * 1.2);
  $('zoom-out').onclick = () => setZoom(state.zoom / 1.2);
  $('zoom-fit').onclick = () => setZoom(1);
  $('panel-btn').onclick = () => togglePanel();
  $('panel-close').onclick = () => togglePanel(false);
  $('more-btn').onclick = openMoreMenu;

  const pageInput = $('page-input');
  pageInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      const n = parseInt(pageInput.value, 10);
      if (n >= 1 && n <= state.pdf.numPages) scrollToPosition(n);
      pageInput.blur();
    }
  });
  pageInput.addEventListener('focus', () => pageInput.select());
  pageInput.addEventListener('blur', updatePager);

  setTool(storage.get('ps_tool', 'hand'));
}

const styleFor = (tool = state.tool) => state.styles[tool];

function saveStyles() {
  const out = {};
  for (const [t, s] of Object.entries(state.styles)) out[t] = { color: s.color, size: s.size, mode: s.mode };
  storage.set('ps_styles', out);
}

function setTool(tool) {
  if (!TOOL_STYLE_DEFAULTS[tool] && tool !== 'hand' && tool !== 'eraser') tool = 'hand';
  closeTextEditor(true);
  state.tool = tool;
  storage.set('ps_tool', tool);
  const keep = [...document.body.classList].filter((c) => c !== 'drawing' && !c.startsWith('tool-'));
  document.body.className = [...keep, ...(tool !== 'hand' ? ['drawing', 'tool-' + tool] : [])].join(' ');
  hideSelBar();
  closeAnnMenu();
  for (const b of document.querySelectorAll('[data-tool]')) b.classList.toggle('active', b.dataset.tool === tool);
  $('style-pop').hidden = true;
  refreshStyleUi();
}

function refreshStyleUi() {
  const s = styleFor();
  $('markup-modes').hidden = state.tool !== 'texthl';
  if (state.tool === 'texthl') for (const b of $('markup-modes').children) b.classList.toggle('on', b.dataset.mode === (s.mode || 'highlight'));
  const btn = $('style-btn');
  btn.style.display = s ? '' : 'none';
  btn.previousElementSibling.style.display = s ? '' : 'none';
  if (!s) return;
  $('swatch').style.background = s.color;
  for (const b of $('swatches').children) b.classList.toggle('on', b.dataset.color === s.color);
  const size = $('size');
  const hasSize = s.size !== undefined;
  size.parentElement.hidden = !hasSize;
  if (hasSize) {
    Object.assign(size, { min: s.min, max: s.max, step: s.step });
    size.value = s.size;
    $('size-label').textContent = s.label;
    $('size-value').textContent = state.tool === 'text' ? `${s.size} pt` : s.size;
  }
}

function toggleStylePop() {
  if (!styleFor()) return;
  $('style-pop').hidden = !$('style-pop').hidden;
  refreshStyleUi();
}

/* ================================================================ input */

function pageFromEvent(e) {
  const el = e.target.closest?.('.page');
  return el ? state.pages[Number(el.dataset.page) - 1] : null;
}

function normPoint(e, p) {
  const r = p.el.getBoundingClientRect();
  return [Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height))];
}

function setupInput() {
  viewer.addEventListener('scroll', onScrolled, { passive: true });
  addEventListener('resize', () => {
    const pos = topPosition();
    layout();
    scrollToPosition(pos.page, pos.offset);
    renderAllAnnotations();
    scheduleVisible();
  });

  document.addEventListener('selectstart', (e) => {
    const el = e.target.nodeType === 3 ? e.target.parentElement : e.target;
    if (state.tool !== 'hand' && el?.closest?.('#pages')) e.preventDefault();
  });
  pagesEl.addEventListener('pointerdown', onPointerDown);
  addEventListener('pointermove', onPointerMove, { passive: false });
  addEventListener('pointerup', onPointerUp);
  addEventListener('pointercancel', () => cancelGesture());
  pagesEl.addEventListener('click', onClick);

  // Ctrl + wheel / trackpad pinch = zoom
  viewer.addEventListener(
    'wheel',
    (e) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const r = viewer.getBoundingClientRect();
      setZoom(state.zoom * Math.exp(-e.deltaY * 0.0025), { x: e.clientX - r.left, y: e.clientY - r.top });
    },
    { passive: false }
  );

  setupTouchGestures();

  addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      return openSearch();
    }
    if (e.target.closest('input, textarea, [contenteditable]')) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      return openSearch();
    }
    if (mod && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      e.shiftKey ? redo() : undo();
    } else if (mod && e.key.toLowerCase() === 'y') {
      e.preventDefault();
      redo();
    } else if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault();
      setZoom(state.zoom * 1.2);
    } else if (mod && e.key === '-') {
      e.preventDefault();
      setZoom(state.zoom / 1.2);
    } else if (mod && e.key === '0') {
      e.preventDefault();
      setZoom(1);
    } else if (!mod && !e.altKey) {
      if (e.key === 'Escape' && (annMenu || !$('searchbar').hidden)) {
        closeAnnMenu();
        return closeSearch();
      }
      const map = { h: 'hand', l: 'texthl', a: 'highlight', m: 'marker', p: 'pen', t: 'text', n: 'note', e: 'eraser', Escape: 'hand' };
      if (map[e.key]) setTool(map[e.key]);
    }
  });

  addEventListener('pagehide', savePositionOnExit);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') savePositionOnExit();
  });
}

function onPointerDown(e) {
  if (state.tool === 'hand' || e.button > 0) return;
  if (state.gesture) return;
  const p = pageFromEvent(e);
  if (!p) return;
  if (e.pointerType === 'pen') state.penSeen = true;
  // With a stylus, fingers scroll instead of drawing (palm rejection).
  if (state.penSeen && e.pointerType === 'touch' && state.tool !== 'eraser') return startTouchPan(e);

  if (state.editor) {
    closeTextEditor(true);
    return;
  }
  if (e.target.closest('.text-annot, .note-pin, .text-editor') && state.tool !== 'eraser') return;

  const pt = normPoint(e, p);
  const s = styleFor();
  switch (state.tool) {
    case 'texthl': {
      if (p.textContent && !pageHasText(p)) {
        // Scanned page (just a picture): fall back to an area highlight.
        if (!state.warnedNoText) toast('This page has no selectable text (it may be a scan), so it will highlight the area you drag over.', { duration: 6000 });
        state.warnedNoText = true;
        const rect = svgEl('rect', { class: 'live ann-highlight', fill: s.color, 'fill-opacity': 0.38, x: 0, y: 0, width: 0, height: 0 });
        p.svg.appendChild(rect);
        state.gesture = { kind: 'highlight', p, start: pt, end: pt, rect, pointerId: e.pointerId, color: s.color };
        break;
      }
      if (!p.textLayer) {
        toast('This page is still loading. Try again in a moment.');
        return;
      }
      const live = svgEl('g', { class: 'live' });
      p.svg.appendChild(live);
      const anchor = caretAt(e.clientX, e.clientY, p);
      state.gesture = { kind: 'textsel', p, anchor, focus: anchor, live, rects: [], text: '', pointerId: e.pointerId };
      break;
    }
    case 'highlight': {
      const rect = svgEl('rect', { class: 'live ann-highlight', fill: s.color, 'fill-opacity': 0.38, x: 0, y: 0, width: 0, height: 0 });
      p.svg.appendChild(rect);
      state.gesture = { kind: 'highlight', p, start: pt, end: pt, rect, pointerId: e.pointerId };
      break;
    }
    case 'pen':
    case 'marker': {
      const path = svgEl('path', {
        class: 'live',
        fill: 'none',
        stroke: s.color,
        'stroke-width': s.size,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        'stroke-opacity': state.tool === 'marker' ? 0.4 : 1,
        style: state.tool === 'marker' ? 'mix-blend-mode:multiply' : '',
      });
      p.svg.appendChild(path);
      state.gesture = { kind: 'stroke', p, points: [pt], path, pointerId: e.pointerId };
      path.setAttribute('d', strokePath(state.gesture.points, p.width, p.height));
      break;
    }
    case 'text':
      e.preventDefault();
      openTextEditor(p, null, pt);
      return;
    case 'note':
      e.preventDefault();
      createNote(p, pt);
      return;
    case 'eraser':
      state.gesture = { kind: 'erase', changes: [], pointerId: e.pointerId };
      eraseAt(e.clientX, e.clientY);
      break;
    default:
      return;
  }
  e.preventDefault();
}

function onPointerMove(e) {
  const g = state.gesture;
  if (!g || e.pointerId !== g.pointerId) return;
  e.preventDefault();
  if (g.kind === 'pan') {
    viewer.scrollLeft -= e.clientX - g.x;
    viewer.scrollTop -= e.clientY - g.y;
    g.x = e.clientX;
    g.y = e.clientY;
  } else if (g.kind === 'textsel') {
    const c = caretAt(e.clientX, e.clientY, g.p);
    if (!c) return;
    if (!g.anchor) g.anchor = c;
    g.focus = c;
    const geo = geometryFromRange(g.p, rangeBetween(g.anchor, g.focus));
    g.rects = geo.rects;
    g.text = geo.text;
    drawLiveRects(g);
  } else if (g.kind === 'highlight') {
    g.end = normPoint(e, g.p);
    const [x, y, w, h] = rectFrom(g.start, g.end);
    Object.entries({ x: x * g.p.width, y: y * g.p.height, width: w * g.p.width, height: h * g.p.height }).forEach(([k, v]) => g.rect.setAttribute(k, v));
  } else if (g.kind === 'stroke') {
    const events = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
    const minDist = 1.2 / (g.p.width * state.scale); // ~1px on screen
    for (const ev of events.length ? events : [e]) {
      const pt = normPoint(ev, g.p);
      const last = g.points[g.points.length - 1];
      if (Math.hypot(pt[0] - last[0], (pt[1] - last[1]) * (g.p.height / g.p.width)) >= minDist) g.points.push(pt);
    }
    g.path.setAttribute('d', strokePath(g.points, g.p.width, g.p.height));
  } else if (g.kind === 'erase') {
    eraseAt(e.clientX, e.clientY);
  }
}

function onPointerUp(e) {
  const g = state.gesture;
  if (!g || e.pointerId !== g.pointerId) return;
  state.gesture = null;
  if (g.kind === 'textsel') {
    g.live.remove();
    if (!g.rects.length || !g.text.trim()) return; // a tap (may open the menu of an existing highlight)
    const s = styleFor('texthl');
    const a = { id: uid(), type: 'texthl', page: g.p.num, rects: g.rects, mode: s.mode || 'highlight', color: s.color, text: g.text.slice(0, 5000), createdAt: Date.now() };
    commit([{ id: a.id, before: null, after: a }]);
  } else if (g.kind === 'highlight') {
    g.rect.remove();
    const [x, y, w, h] = rectFrom(g.start, g.end);
    if (w * g.p.width * state.scale < 4 || h * g.p.height * state.scale < 4) return; // just a tap
    const a = { id: uid(), type: 'highlight', page: g.p.num, x, y, w, h, color: g.color || styleFor('highlight').color, createdAt: Date.now() };
    commit([{ id: a.id, before: null, after: a }]);
  } else if (g.kind === 'stroke') {
    g.path.remove();
    const type = state.tool === 'marker' ? 'marker' : 'pen';
    const s = styleFor(type);
    const points = g.points.map(([x, y]) => [Math.round(x * 1e5) / 1e5, Math.round(y * 1e5) / 1e5]).slice(0, 4000);
    const a = { id: uid(), type, page: g.p.num, points, color: s.color, size: s.size, createdAt: Date.now() };
    commit([{ id: a.id, before: null, after: a }]);
  } else if (g.kind === 'erase' && g.changes.length) {
    // one undo step for the whole eraser swipe (already applied while erasing)
    state.undo.push(g.changes);
    state.redo = [];
    updateUndoButtons();
  }
}

function cancelGesture() {
  const g = state.gesture;
  if (!g) return;
  state.gesture = null;
  g.rect?.remove();
  g.path?.remove();
  g.live?.remove();
  if (g.kind === 'erase' && g.changes.length) {
    state.undo.push(g.changes);
    updateUndoButtons();
  }
}

function startTouchPan(e) {
  state.gesture = { kind: 'pan', x: e.clientX, y: e.clientY, pointerId: e.pointerId };
}

function rectFrom(a, b) {
  return [Math.min(a[0], b[0]), Math.min(a[1], b[1]), Math.abs(a[0] - b[0]), Math.abs(a[1] - b[1])];
}

function eraseAt(x, y) {
  const el = document.elementFromPoint(x, y);
  const id = el?.closest?.('[data-id]')?.dataset.id;
  if (!id || !state.anns.has(id)) return;
  const before = state.anns.get(id);
  setAnn(id, null);
  state.gesture?.changes?.push({ id, before, after: null });
}

function onClick(e) {
  if (e.target.closest('[data-badge]')) {
    const a = state.anns.get(e.target.closest('[data-badge]').dataset.id);
    if (a && state.tool !== 'eraser') openAnnMenu(a, e.clientX, e.clientY);
    return;
  }
  if ((state.tool === 'hand' || state.tool === 'texthl') && Date.now() - state.lastCommitAt > 400) {
    const sel = getSelection();
    if (!sel || sel.isCollapsed) {
      const hit = markAt(e);
      if (hit) return openAnnMenu(hit, e.clientX, e.clientY);
    }
  }
  const target = e.target.closest('.text-annot, .note-pin');
  if (!target || state.tool === 'eraser') return;
  const a = state.anns.get(target.dataset.id);
  if (!a) return;
  if (a.type === 'note') openNote(a);
  else if (a.type === 'text' && (state.tool === 'hand' || state.tool === 'text')) openTextEditor(state.pages[a.page - 1], a);
}

/* Two fingers: pan + pinch-zoom, in every tool. */
function setupTouchGestures() {
  let pinch = null;
  const dist = (a, b) => Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  const mid = (a, b) => ({ x: (a.clientX + b.clientX) / 2, y: (a.clientY + b.clientY) / 2 });

  viewer.addEventListener(
    'touchstart',
    (e) => {
      if (e.touches.length !== 2) return;
      cancelGesture();
      const [a, b] = e.touches;
      const m = mid(a, b);
      pinch = { d0: dist(a, b), z0: state.zoom, last: m, ratio: 1, anchor: m };
    },
    { passive: true }
  );

  viewer.addEventListener(
    'touchmove',
    (e) => {
      if (!pinch || e.touches.length < 2) return;
      e.preventDefault();
      const [a, b] = e.touches;
      const m = mid(a, b);
      viewer.scrollLeft -= m.x - pinch.last.x;
      viewer.scrollTop -= m.y - pinch.last.y;
      pinch.last = m;
      pinch.anchor = m;
      pinch.ratio = Math.min(MAX_ZOOM / pinch.z0, Math.max(MIN_ZOOM / pinch.z0, dist(a, b) / pinch.d0));
      const r = viewer.getBoundingClientRect();
      pagesEl.style.transformOrigin = `${m.x - r.left + viewer.scrollLeft}px ${m.y - r.top + viewer.scrollTop}px`;
      pagesEl.style.transform = `scale(${pinch.ratio})`;
    },
    { passive: false }
  );

  const end = (e) => {
    if (!pinch || e.touches.length >= 2) return;
    const { ratio, z0, anchor } = pinch;
    pinch = null;
    pagesEl.style.transform = '';
    if (Math.abs(ratio - 1) > 0.03) {
      const r = viewer.getBoundingClientRect();
      setZoom(z0 * ratio, { x: anchor.x - r.left, y: anchor.y - r.top });
    }
  };
  viewer.addEventListener('touchend', end);
  viewer.addEventListener('touchcancel', end);
}

/* ============================================================ text boxes */

function openTextEditor(p, existing, pt) {
  closeTextEditor(true);
  const s = styleFor('text');
  const a = existing || {
    id: uid(),
    type: 'text',
    page: p.num,
    x: pt[0],
    y: pt[1],
    w: Math.max(0.15, Math.min(0.45, 1 - pt[0])),
    color: s.color,
    size: s.size,
    text: '',
    createdAt: Date.now(),
  };
  const ta = document.createElement('textarea');
  ta.className = 'text-editor';
  ta.value = a.text;
  ta.placeholder = 'Type here';
  Object.assign(ta.style, {
    left: a.x * 100 + '%',
    top: a.y * 100 + '%',
    width: (a.w || 0.45) * 100 + '%',
    color: a.color,
    fontSize: a.size * state.scale + 'px',
  });
  const grow = () => {
    ta.style.height = 'auto';
    ta.style.height = ta.scrollHeight + 2 + 'px';
  };
  ta.addEventListener('input', grow);
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      closeTextEditor(false);
    } else if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      closeTextEditor(true);
    }
  });
  ta.addEventListener('blur', () => setTimeout(() => state.editor?.ta === ta && closeTextEditor(true), 0));
  state.editor = { id: a.id, ta, ann: a, existing, p };
  if (existing) markDirty(p.num); // hide the static copy while editing
  p.html.appendChild(ta);
  grow();
  ta.focus({ preventScroll: true }); // focus now so the first keystroke isn't lost
  setTimeout(() => document.activeElement !== ta && state.editor?.ta === ta && ta.focus({ preventScroll: true }), 0);
}

function closeTextEditor(save) {
  const ed = state.editor;
  if (!ed) return;
  state.editor = null;
  ed.ta.remove();
  const text = ed.ta.value.replace(/\s+$/, '');
  if (save) {
    if (ed.existing) {
      const current = state.anns.get(ed.id);
      if (!text && current) commit([{ id: ed.id, before: current, after: null }]);
      else if (current && text !== current.text) commit([{ id: ed.id, before: current, after: { ...current, text } }]);
    } else if (text) {
      commit([{ id: ed.id, before: null, after: { ...ed.ann, text } }]);
    }
  }
  markDirty(ed.p.num);
}

/* ================================================================= notes */

function createNote(p, pt) {
  const a = { id: uid(), type: 'note', page: p.num, x: pt[0], y: pt[1], color: styleFor('note').color, text: '', createdAt: Date.now() };
  openNote(a, true);
}

async function openNote(a, isNew = false) {
  const ta = document.createElement('textarea');
  ta.className = 'field';
  ta.value = a.text || '';
  ta.placeholder = 'Write a note…';
  const result = await PS.modal({
    title: `Note · page ${a.page}`,
    html: ta,
    actions: [
      ...(isNew ? [] : [{ label: 'Delete', kind: 'danger', value: 'delete' }, 'spacer']),
      { label: 'Cancel', value: null },
      { label: 'Save', kind: 'primary', value: 'save' },
    ],
    onOpen: (box, done) => {
      ta.focus();
      ta.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) done('save');
      });
    },
  });
  const current = state.anns.get(a.id);
  if (result === 'delete' && current) commit([{ id: a.id, before: current, after: null }]);
  if (result !== 'save') return;
  const text = ta.value.trim();
  if (isNew) {
    if (text) commit([{ id: a.id, before: null, after: { ...a, text } }]);
  } else if (current) {
    if (!text) commit([{ id: a.id, before: current, after: null }]);
    else if (text !== current.text) commit([{ id: a.id, before: current, after: { ...current, text } }]);
  }
}

/* ================================================================= panel */

function togglePanel(force) {
  const panel = $('panel');
  panel.hidden = force === undefined ? !panel.hidden : !force;
  $('panel-btn').classList.toggle('active', !panel.hidden);
  renderPanel();
  // On phones the panel floats over the page, so the page layout doesn't change.
  const overlay = getComputedStyle(panel).position === 'absolute' || innerWidth <= 760;
  if (!overlay) {
    const pos = topPosition();
    requestAnimationFrame(() => {
      layout();
      scrollToPosition(pos.page, pos.offset);
      renderAllAnnotations();
      scheduleVisible();
    });
  }
}

const TYPE_LABEL = { highlight: 'Area highlight', marker: 'Highlighter', pen: 'Drawing', text: 'Text', note: 'Note', texthl: 'Highlight' };
const MODE_LABEL = { highlight: 'Highlight', underline: 'Underline', strike: 'Strikethrough' };
const labelOf = (a) => (a.type === 'texthl' ? MODE_LABEL[a.mode] || 'Highlight' : TYPE_LABEL[a.type]);

const yOfAnn = (a) => a.y ?? a.rects?.[0]?.[1] ?? a.points?.[0]?.[1] ?? 0;

function renderPanel() {
  const panel = $('panel');
  if (panel.hidden) return;
  for (const b of panel.querySelectorAll('[data-ptab]')) b.setAttribute('aria-selected', String(b.dataset.ptab === state.panelTab));
  const body = $('panel-body');
  if (state.panelTab === 'contents') return renderContents(body);

  const list = [...state.anns.values()].sort((a, b) => a.page - b.page || yOfAnn(a) - yOfAnn(b));
  if (!list.length) {
    body.innerHTML = '<div class="panel-empty">Nothing marked yet. Choose <b>Highlight text</b> at the bottom and drag across a sentence, or select text and tap <b>Highlight</b>. Everything shows up on all your devices.</div>';
    return;
  }
  body.innerHTML =
    list
      .map((a) => {
        const quote = a.type === 'texthl' ? `<span class="txt quote">“${escapeHtml(a.text || '')}”</span>` : a.text ? `<span class="txt">${escapeHtml(a.text)}</span>` : '';
        const note = a.note ? `<span class="note">${escapeHtml(a.note)}</span>` : '';
        return `<button class="ann-item" data-jump="${a.id}">
        <span class="sw" style="background:${a.color}"></span>
        <span><span class="pg">Page ${a.page} · ${labelOf(a)}</span>${quote}${note}</span>
      </button>`;
      })
      .join('') +
    `<div class="panel-actions"><button class="btn" data-pact="md">${icon('markdown')}Export notes</button><button class="btn" data-pact="copy">${icon('copy')}Copy all</button></div>`;
  body.onclick = async (e) => {
    const act = e.target.closest('[data-pact]')?.dataset.pact;
    if (act === 'md') return exportNotesMarkdown();
    if (act === 'copy') {
      await copyText(notesMarkdown());
      return;
    }
    const id = e.target.closest('[data-jump]')?.dataset.jump;
    const a = id && state.anns.get(id);
    if (!a) return;
    if (innerWidth <= 760) togglePanel(false); // close first on phones, then move
    scrollToPosition(a.page, Math.max(0, yOfAnn(a) - 0.08), true);
    flashMark(a);
  };
}

function flashMark(a) {
  setTimeout(() => {
    const g = state.pages[a.page - 1]?.svg.querySelector(`[data-id="${a.id}"]`);
    if (!g) return;
    g.animate([{ opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }, { opacity: 0.2 }, { opacity: 1 }], { duration: 1200 });
  }, 450);
}

/* --------------------------------------------- table of contents (outline) */

async function loadOutline() {
  if (state.outline) return state.outline;
  const flat = [];
  try {
    const walk = (items, depth) => {
      for (const it of items || []) {
        flat.push({ title: it.title, dest: it.dest, url: it.url, depth, page: null });
        walk(it.items, depth + 1);
      }
    };
    walk(await state.pdf.getOutline(), 0);
    await Promise.all(flat.map(async (it) => (it.page = (await resolveDest(it.dest))?.page ?? null)));
  } catch (err) {
    console.warn('Outline:', err);
  }
  state.outline = flat;
  return flat;
}

async function resolveDest(dest) {
  try {
    if (typeof dest === 'string') dest = await state.pdf.getDestination(dest);
    if (!Array.isArray(dest)) return null;
    const ref = dest[0];
    const index = typeof ref === 'object' && ref ? await state.pdf.getPageIndex(ref) : Number(ref);
    if (!Number.isInteger(index)) return null;
    const page = index + 1;
    let offset = 0;
    const kind = dest[1]?.name;
    const top = kind === 'XYZ' ? dest[3] : kind === 'FitH' || kind === 'FitBH' ? dest[2] : null;
    if (top != null) {
      const vp = (await state.pdf.getPage(page)).getViewport({ scale: 1 });
      const [, vy] = vp.convertToViewportPoint(kind === 'XYZ' ? dest[2] || 0 : 0, top);
      offset = Math.min(0.98, Math.max(0, vy / vp.height - 0.015));
    }
    return { page, offset };
  } catch {
    return null;
  }
}

async function renderContents(body) {
  body.innerHTML = '<div class="panel-empty">Loading contents…</div>';
  const items = await loadOutline();
  if (state.panelTab !== 'contents') return;
  if (!items.length) {
    body.innerHTML = "<div class=\"panel-empty\">This PDF doesn't have a table of contents. Use search (🔍 at the top) to find things instead.</div>";
    return;
  }
  body.innerHTML = items
    .map(
      (it, i) =>
        `<button class="toc-item" data-toc="${i}" style="padding-left:${8 + it.depth * 16}px;${it.depth ? '' : 'font-weight:600'}">${it.page ? `<span class="pg">${it.page}</span>` : ''}${escapeHtml(it.title || 'Untitled')}</button>`
    )
    .join('');
  body.onclick = async (e) => {
    const it = items[Number(e.target.closest('[data-toc]')?.dataset.toc)];
    if (!it) return;
    if (it.url) return window.open(it.url, '_blank', 'noopener');
    const d = await resolveDest(it.dest);
    if (innerWidth <= 760) togglePanel(false); // close first on phones, then move
    if (d) scrollToPosition(d.page, d.offset, true);
  };
}

/* ============================================================ more menu */

function openMoreMenu(e) {
  e.stopPropagation();
  document.querySelector('.popmenu')?.remove();
  const menu = document.createElement('div');
  menu.className = 'popmenu';
  menu.innerHTML = `
    <button data-act="export">${icon('download')}Download with my marks</button>
    <button data-act="original">${icon('file')}Download original</button>
    <button data-act="notes">${icon('markdown')}Export notes (Markdown)</button>
    <button data-act="contents">${icon('toc')}Table of contents</button>
    <button data-act="night">${icon('moon')}${document.body.classList.contains('night') ? 'Turn off night reading' : 'Night reading'}</button>
    <button data-act="zoom-in" class="show-sm">${icon('zoomIn')}Zoom in</button>
    <button data-act="zoom-out" class="show-sm">${icon('zoomOut')}Zoom out</button>
    <button data-act="fit" class="show-sm">${icon('fit')}Fit width</button>
    <div class="menu-foot">PageSync v${backend.APP_VERSION}</div>`;
  document.body.appendChild(menu);
  if (innerWidth > 760) menu.querySelectorAll('.show-sm').forEach((b) => b.remove());
  const r = e.currentTarget.getBoundingClientRect();
  menu.style.top = r.bottom + 6 + 'px';
  menu.style.left = Math.max(8, r.right - menu.offsetWidth) + 'px';
  const close = (ev) => {
    if (!menu.contains(ev.target)) {
      menu.remove();
      document.removeEventListener('pointerdown', close);
    }
  };
  setTimeout(() => document.addEventListener('pointerdown', close), 0);
  menu.onclick = (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    menu.remove();
    document.removeEventListener('pointerdown', close);
    if (act === 'export') exportAnnotated();
    if (act === 'original') downloadOriginal();
    if (act === 'notes') exportNotesMarkdown();
    if (act === 'night') setNight(!document.body.classList.contains('night'));
    if (act === 'contents') {
      state.panelTab = 'contents';
      togglePanel(true);
    }
    if (act === 'zoom-in') setZoom(state.zoom * 1.25);
    if (act === 'zoom-out') setZoom(state.zoom / 1.25);
    if (act === 'fit') setZoom(1);
  };
}

/* ======================================================== export to PDF */

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.PDFLib) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load ' + src));
    document.head.appendChild(s);
  });
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return PDFLib.rgb(((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255);
}

/**
 * Convert a point given as fractions of the *displayed* page (u right, v down)
 * into PDF user-space coordinates, taking page rotation and crop box into account.
 */
function mapPoint(u, v, box, rot) {
  const { x: bx, y: by, width: bw, height: bh } = box;
  switch (rot) {
    case 90:
      return [bx + v * bw, by + u * bh];
    case 180:
      return [bx + (1 - u) * bw, by + v * bh];
    case 270:
      return [bx + (1 - v) * bw, by + (1 - u) * bh];
    default:
      return [bx + u * bw, by + bh - v * bh];
  }
}

function wrapText(text, font, size, maxWidth) {
  const lines = [];
  for (const para of text.split('\n')) {
    let line = '';
    for (const word of para.split(/(\s+)/)) {
      const test = line + word;
      if (line && font.widthOfTextAtSize(test.trimEnd(), size) > maxWidth) {
        lines.push(line.trimEnd());
        line = word.trimStart();
        // a single very long word: hard-break it
        while (font.widthOfTextAtSize(line, size) > maxWidth && line.length > 1) {
          let cut = line.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(line.slice(0, cut), size) > maxWidth) cut--;
          lines.push(line.slice(0, cut));
          line = line.slice(cut);
        }
      } else line = test;
    }
    lines.push(line.trimEnd());
  }
  return lines;
}

async function exportAnnotated() {
  const close = toast('Preparing your PDF…', { duration: 0 });
  try {
    await loadScript(new URL('../vendor/pdf-lib/pdf-lib.min.js', import.meta.url).href);
    const { PDFDocument, StandardFonts, degrees, BlendMode, LineCapStyle, PDFName, PDFHexString } = PDFLib;
    const { bytes } = await backend.getPdfBytes(state.doc);
    const pdf = await PDFDocument.load(bytes, { ignoreEncryption: true });
    const font = await pdf.embedFont(StandardFonts.Helvetica);
    const charset = new Set(font.getCharacterSet());
    const clean = (s) => [...s].map((ch) => (ch === '\n' || charset.has(ch.codePointAt(0)) ? ch : '?')).join('');
    const pages = pdf.getPages();
    const anns = [...state.anns.values()].sort((a, b) => a.createdAt - b.createdAt);
    const rgb01 = (hex) => [((parseInt(hex.slice(1), 16) >> 16) & 255) / 255, ((parseInt(hex.slice(1), 16) >> 8) & 255) / 255, (parseInt(hex.slice(1), 16) & 255) / 255];
    // A real PDF sticky note that opens in Acrobat, Edge, Chrome, Preview, etc.
    const addPdfNote = (page, X, Y, text, hex) => {
      const note = pdf.context.obj({
        Type: 'Annot',
        Subtype: 'Text',
        Rect: [X, Y - 20, X + 20, Y],
        Contents: PDFHexString.fromText(text || ''),
        T: PDFHexString.fromText(device.name),
        Name: 'Comment',
        C: rgb01(hex),
        F: 4,
        Open: false,
      });
      const ref = pdf.context.register(note);
      const existing = page.node.lookup(PDFName.of('Annots'));
      if (existing && typeof existing.push === 'function') existing.push(ref);
      else page.node.set(PDFName.of('Annots'), pdf.context.obj([ref]));
    };

    for (const a of anns) {
      const page = pages[a.page - 1];
      if (!page) continue;
      const box = page.getCropBox();
      const rot = ((page.getRotation().angle % 360) + 360) % 360;
      const Wd = rot % 180 ? box.height : box.width; // displayed size in points
      const Hd = rot % 180 ? box.width : box.height;
      const color = hexToRgb(a.color);

      if (a.type === 'texthl') {
        for (const [x, y, w, h] of a.rects || []) {
          let top = y, bottom = y + h;
          if (a.mode === 'underline') (top = y + h * 0.9), (bottom = y + h * 0.98);
          if (a.mode === 'strike') (top = y + h * 0.48), (bottom = y + h * 0.56);
          const [x1, y1] = mapPoint(x, top, box, rot);
          const [x2, y2] = mapPoint(x + w, bottom, box, rot);
          page.drawRectangle({
            x: Math.min(x1, x2),
            y: Math.min(y1, y2),
            width: Math.abs(x2 - x1),
            height: Math.abs(y2 - y1),
            color,
            opacity: a.mode === 'underline' || a.mode === 'strike' ? 1 : 0.4,
            blendMode: a.mode === 'underline' || a.mode === 'strike' ? BlendMode.Normal : BlendMode.Multiply,
          });
        }
      } else if (a.type === 'highlight') {
        const [x1, y1] = mapPoint(a.x, a.y, box, rot);
        const [x2, y2] = mapPoint(a.x + a.w, a.y + a.h, box, rot);
        page.drawRectangle({
          x: Math.min(x1, x2),
          y: Math.min(y1, y2),
          width: Math.abs(x2 - x1),
          height: Math.abs(y2 - y1),
          color,
          opacity: 0.38,
          blendMode: BlendMode.Multiply,
        });
      } else if (a.type === 'pen' || a.type === 'marker') {
        const top = box.y + box.height;
        const pts = a.points.map(([u, v]) => {
          const [X, Y] = mapPoint(u, v, box, rot);
          return `${(X - box.x).toFixed(2)} ${(top - Y).toFixed(2)}`;
        });
        if (pts.length === 1) pts.push(pts[0].replace(/^(\S+)/, (m) => (Number(m) + 0.01).toFixed(2)));
        page.drawSvgPath('M' + pts.join(' L'), {
          x: box.x,
          y: top,
          borderColor: color,
          borderWidth: a.size,
          borderOpacity: a.type === 'marker' ? 0.4 : 1,
          borderLineCap: LineCapStyle.Round,
          blendMode: a.type === 'marker' ? BlendMode.Multiply : BlendMode.Normal,
        });
      } else if (a.type === 'text' && a.text) {
        const lines = wrapText(clean(a.text), font, a.size, (a.w || 0.45) * Wd);
        lines.forEach((line, i) => {
          if (!line) return;
          const dy = a.y * Hd + a.size * (0.9 + 1.25 * i);
          const [X, Y] = mapPoint(a.x, dy / Hd, box, rot);
          page.drawText(line, { x: X, y: Y, size: a.size, font, color, rotate: degrees(rot) });
        });
      } else if (a.type === 'note') {
        const [X, Y] = mapPoint(a.x, a.y, box, rot);
        addPdfNote(page, X, Y, a.text, a.color);
      }
      // comments attached to highlights become sticky notes next to them
      if (a.note && (a.type === 'texthl' || a.type === 'highlight')) {
        const r = a.type === 'texthl' ? a.rects?.[0] : [a.x, a.y, a.w, a.h];
        if (r) {
          const [X, Y] = mapPoint(Math.min(0.97, r[0] + r[2]), r[1], box, rot);
          addPdfNote(page, X, Y, a.note, a.color);
        }
      }
    }

    const out = await pdf.save();
    const blob = new Blob([out], { type: 'application/pdf' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = state.doc.name.replace(/\.pdf$/i, '') + ' (with notes).pdf';
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60e3);
    close();
    toast('Downloaded a copy with your marks.');
  } catch (err) {
    console.error(err);
    close();
    toast('Export failed: ' + err.message, { error: true, duration: 6000 });
  }
}

/* ============================================================ thumbnail */

async function downloadOriginal() {
  try {
    const { bytes } = await backend.getPdfBytes(state.doc);
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    link.download = state.doc.name;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 60e3);
  } catch (err) {
    toast('Download failed: ' + err.message, { error: true });
  }
}

async function makeThumbnail() {
  if (state.doc.thumb || !state.online) return;
  try {
    const page = await state.pdf.getPage(1);
    const vp1 = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: 240 / vp1.width });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, viewport }).promise;
    const dataUrl = canvas.toDataURL('image/jpeg', 0.7);
    await backend.saveThumb(docId, dataUrl);
    state.doc.thumb = dataUrl;
    canvas.width = 0;
  } catch (err) {
    console.warn('Thumbnail skipped:', err);
  }
}

/* ================================================== text selection geometry */

/** Text position (text node + offset) under a screen point, on page p. */
function caretAt(x, y, p) {
  if (!p.textLayer) return null;
  let node = null;
  let offset = 0;
  if (document.caretPositionFromPoint) {
    const c = document.caretPositionFromPoint(x, y);
    if (c) (node = c.offsetNode), (offset = c.offset);
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) (node = r.startContainer), (offset = r.startOffset);
  }
  if (node && node.nodeType === 3 && p.textLayer.contains(node)) return { node, offset };

  // Between words / lines: use the closest piece of text on this line (or nearby).
  let best = null;
  let bestD = Infinity;
  for (const span of p.textDivs || []) {
    const t = span.firstChild;
    if (!t || t.nodeType !== 3 || !t.length) continue;
    const r = span.getBoundingClientRect();
    if (!r.width || !r.height) continue;
    const dy = y < r.top ? r.top - y : y > r.bottom ? y - r.bottom : 0;
    const dx = x < r.left ? r.left - x : x > r.right ? x - r.right : 0;
    const d = dy * 4 + dx; // strongly prefer the same line
    if (d < bestD) (bestD = d), (best = { t, r });
  }
  if (!best || bestD > 120) return null;
  return { node: best.t, offset: charOffsetAt(best.t, x) };
}

function charOffsetAt(t, x) {
  const r = document.createRange();
  for (let i = 0; i < t.length; i++) {
    r.setStart(t, i);
    r.setEnd(t, i + 1);
    const b = r.getBoundingClientRect();
    if (x < b.left + b.width / 2) return i;
  }
  return t.length;
}

function rangeBetween(a, b) {
  const r = document.createRange();
  r.setStart(a.node, a.offset);
  r.collapse(true);
  let start = a;
  let end = b;
  try {
    if (r.comparePoint(b.node, b.offset) < 0) (start = b), (end = a);
  } catch {}
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return range;
}

/** Line-snapped boxes (fractions of the page) + the selected text, for the part of `range` on page p. */
function geometryFromRange(p, range) {
  const out = { rects: [], text: '' };
  if (!p.textLayer || !range.intersectsNode(p.textLayer)) return out;
  const pr = p.el.getBoundingClientRect();
  const raw = [];
  let text = '';
  let lastTop = null;
  const walker = document.createTreeWalker(p.textLayer, NodeFilter.SHOW_TEXT);
  const sub = document.createRange();
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) continue;
    const s0 = n === range.startContainer ? range.startOffset : 0;
    const e0 = n === range.endContainer ? range.endOffset : n.length;
    if (e0 <= s0) continue;
    sub.setStart(n, s0);
    sub.setEnd(n, e0);
    const rects = [...sub.getClientRects()].filter((r) => r.width > 0.5 && r.height > 0.5);
    if (!rects.length) continue;
    const top = rects[0].top;
    const piece = n.data.slice(s0, e0);
    if (text && lastTop !== null && Math.abs(top - lastTop) > rects[0].height * 0.5 && !/\s$/.test(text)) text += ' ';
    text += piece;
    lastTop = top;
    for (const r of rects) raw.push({ x: r.left - pr.left, y: r.top - pr.top, w: r.width, h: r.height });
  }
  out.text = text.replace(/\s+/g, ' ').trim();
  out.rects = mergeLineRects(raw).map((r) => [r.x / pr.width, r.y / pr.height, r.w / pr.width, r.h / pr.height].map((v) => Math.round(v * 1e5) / 1e5));
  return out;
}

/** Join word boxes into one neat box per line. */
function mergeLineRects(rects) {
  const lines = [];
  for (const r of [...rects].sort((a, b) => a.y + a.h / 2 - (b.y + b.h / 2))) {
    const line = lines.find((L) => Math.min(L.y + L.h, r.y + r.h) - Math.max(L.y, r.y) >= 0.5 * Math.min(L.h, r.h));
    if (line) {
      line.items.push(r);
      const y1 = Math.min(line.y, r.y);
      const y2 = Math.max(line.y + line.h, r.y + r.h);
      line.y = y1;
      line.h = y2 - y1;
    } else lines.push({ y: r.y, h: r.h, items: [r] });
  }
  const out = [];
  for (const L of lines) {
    let cur = null;
    for (const r of L.items.sort((a, b) => a.x - b.x)) {
      if (cur && r.x <= cur.x + cur.w + Math.max(4, L.h * 0.9)) {
        cur.w = Math.max(cur.x + cur.w, r.x + r.w) - cur.x;
      } else {
        if (cur) out.push(cur);
        cur = { x: r.x, y: L.y, w: r.w, h: L.h };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

function drawLiveRects(g) {
  g.live.innerHTML = '';
  const s = styleFor('texthl');
  for (const [x, y, w, h] of g.rects) {
    g.live.appendChild(svgEl('rect', { x: x * g.p.width, y: y * g.p.height, width: w * g.p.width, height: h * g.p.height, fill: s.color, 'fill-opacity': 0.4, rx: 1.5, style: 'mix-blend-mode:multiply' }));
  }
}

/** The highlight under a click, if any (newest on top). */
function markAt(e) {
  const p = pageFromEvent(e);
  if (!p) return null;
  const [u, v] = normPoint(e, p);
  const inside = ([x, y, w, h]) => u >= x && u <= x + w && v >= y && v <= y + h;
  let hit = null;
  for (const a of state.anns.values()) {
    if (a.page !== p.num) continue;
    const ok = a.type === 'texthl' ? (a.rects || []).some(inside) : a.type === 'highlight' ? inside([a.x, a.y, a.w, a.h]) : false;
    if (ok && (!hit || a.createdAt > hit.createdAt)) hit = a;
  }
  return hit;
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied');
  } catch {
    const ta = Object.assign(document.createElement('textarea'), { value: text });
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
    toast('Copied');
  }
}

function placeFloat(el, rect, preferBelow = false) {
  const w = el.offsetWidth;
  const h = el.offsetHeight;
  let top = preferBelow ? rect.bottom + 10 : rect.top - h - 10;
  if (top < 60) top = rect.bottom + 10;
  if (top + h > innerHeight - 8) top = Math.max(8, rect.top - h - 10);
  const left = Math.min(innerWidth - w - 8, Math.max(8, rect.left + rect.width / 2 - w / 2));
  el.style.top = top + 'px';
  el.style.left = left + 'px';
}

/* ======================================= select text → highlight (hand tool) */

let selBar = null;
function hideSelBar() {
  selBar?.remove();
  selBar = null;
}

function selectionParts() {
  const sel = getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return [];
  const range = sel.getRangeAt(0);
  const parts = [];
  for (const p of state.pages) {
    if (!p.textLayer || !range.intersectsNode(p.textLayer)) continue;
    const g = geometryFromRange(p, range);
    if (g.rects.length && g.text) parts.push({ p, ...g });
  }
  return parts;
}

function createMarks(parts, mode) {
  const s = styleFor('texthl');
  const now = Date.now();
  const changes = parts.map((part) => {
    const a = { id: uid(), type: 'texthl', page: part.p.num, rects: part.rects, mode, color: s.color, text: part.text.slice(0, 5000), createdAt: now };
    return { id: a.id, before: null, after: a };
  });
  commit(changes);
  getSelection()?.removeAllRanges();
  hideSelBar();
}

function setupSelectionBar() {
  let timer;
  const update = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (state.tool !== 'hand') return hideSelBar();
      const parts = selectionParts();
      if (!parts.length) return hideSelBar();
      const rect = getSelection().getRangeAt(0).getBoundingClientRect();
      if (!selBar) {
        selBar = document.createElement('div');
        selBar.className = 'floatbar';
        selBar.setAttribute('role', 'toolbar');
        selBar.innerHTML = `
          <button data-sel="highlight"><span class="dot-inline" style="width:12px;height:12px;border-radius:50%;background:${styleFor('texthl').color}"></span>Highlight</button>
          <button data-sel="underline" title="Underline">${icon('underline')}</button>
          <button data-sel="strike" title="Strikethrough">${icon('strike')}</button>
          <span class="sep"></span>
          ${state.aiEnabled ? `<button data-sel="explain" title="Explain with AI">${icon('sparkle')}Explain</button>` : ''}
          <button data-sel="copy" title="Copy text">${icon('copy')}Copy</button>`;
        selBar.addEventListener('pointerdown', (e) => e.preventDefault()); // keep the selection
        selBar.onclick = async (e) => {
          const act = e.target.closest('[data-sel]')?.dataset.sel;
          const now = selectionParts();
          if (!act || !now.length) return hideSelBar();
          if (act === 'copy') {
            await copyText(now.map((x) => x.text).join(' '));
            getSelection()?.removeAllRanges();
            return hideSelBar();
          }
          if (act === 'explain') {
            const text = now.map((x) => x.text).join(' ');
            const range = getSelection().getRangeAt(0);
            const { starts } = await pageString(now[0].p.num);
            const near = offsetInPage(now[0].p, range.startContainer, range.startOffset, starts);
            getSelection()?.removeAllRanges();
            hideSelBar();
            return openExplain({ text, page: now[0].p.num, parts: now, near });
          }
          createMarks(now, act);
        };
        document.body.appendChild(selBar);
      }
      placeFloat(selBar, rect, matchMedia('(pointer: coarse)').matches);
    }, 150);
  };
  document.addEventListener('selectionchange', update);
  viewer.addEventListener('scroll', () => selBar && update(), { passive: true });
}

/* ================================================ menu for an existing mark */

let annMenu = null;
function closeAnnMenu() {
  annMenu?.remove();
  annMenu = null;
}

function openAnnMenu(a, x, y) {
  closeAnnMenu();
  hideSelBar();
  const swatches = ['#ffd400', '#7bd389', '#5ec8f2', '#ff6b8b', '#ffa14a', '#9b8cff'];
  annMenu = document.createElement('div');
  annMenu.className = 'floatbar';
  annMenu.dataset.for = a.id;
  annMenu.innerHTML =
    swatches.map((c) => `<button class="dot${c === a.color ? ' on' : ''}" data-color="${c}" title="Color"><span style="background:${c}"></span></button>`).join('') +
    '<span class="sep"></span>' +
    (a.type === 'texthl'
      ? ['highlight', 'underline', 'strike']
          .map((m) => `<button data-mode="${m}" class="${(a.mode || 'highlight') === m ? 'on' : ''}" title="${MODE_LABEL[m]}">${icon(m === 'highlight' ? 'textHl' : m)}</button>`)
          .join('') + '<span class="sep"></span>'
      : '') +
    `<button data-act="note" title="${a.note ? 'Edit note' : 'Add note'}">${icon('note')}${a.note ? 'Note' : 'Add note'}</button>` +
    (a.type === 'texthl' && state.aiEnabled ? `<button data-act="explain" title="Explain with AI">${icon('sparkle')}Explain</button>` : '') +
    (a.type === 'texthl' ? `<button data-act="copy" title="Copy text">${icon('copy')}</button>` : '') +
    `<button data-act="delete" class="danger" title="Delete">${icon('trash')}</button>`;
  document.body.appendChild(annMenu);
  placeFloat(annMenu, { left: x - 1, right: x + 1, top: y - 6, bottom: y + 6, width: 2, height: 12 });

  const change = (patch) => {
    const before = state.anns.get(a.id);
    if (!before) return closeAnnMenu();
    const after = { ...before, ...patch };
    for (const k of Object.keys(after)) if (after[k] === undefined) delete after[k];
    commit([{ id: a.id, before, after }]);
    openAnnMenu(after, x, y);
  };
  annMenu.onclick = async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.color) return change({ color: b.dataset.color });
    if (b.dataset.mode) return change({ mode: b.dataset.mode });
    const act = b.dataset.act;
    if (act === 'copy') {
      await copyText(a.text || '');
      return closeAnnMenu();
    }
    if (act === 'explain') {
      closeAnnMenu();
      const { starts } = await pageString(a.page);
      return openExplain({ text: a.text || '', page: a.page, fromAnnId: a.id, near: offsetOfMark(a, starts) });
    }
    if (act === 'delete') {
      closeAnnMenu();
      const before = state.anns.get(a.id);
      if (before) commit([{ id: a.id, before, after: null }]);
      toast('Deleted', { action: { label: 'Undo', run: undo } });
      return;
    }
    if (act === 'note') {
      closeAnnMenu();
      const ta = document.createElement('textarea');
      ta.className = 'field';
      ta.value = a.note || '';
      ta.placeholder = 'Your note about this…';
      const quote = a.type === 'texthl' && a.text ? `“${a.text.length > 160 ? a.text.slice(0, 160) + '…' : a.text}”` : undefined;
      const res = await PS.modal({
        title: `Note · page ${a.page}`,
        body: quote,
        html: ta,
        actions: [
          { label: 'Cancel', value: null },
          { label: 'Save', kind: 'primary', value: 'save' },
        ],
        onOpen: (box, done) => {
          ta.focus();
          ta.addEventListener('keydown', (ev) => ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey) && done('save'));
        },
      });
      if (res !== 'save') return;
      const before = state.anns.get(a.id);
      if (!before) return;
      const note = ta.value.trim();
      if ((before.note || '') === note) return;
      const after = { ...before, note };
      if (!note) delete after.note;
      commit([{ id: a.id, before, after }]);
    }
  };
}

document.addEventListener('pointerdown', (e) => {
  if (annMenu && !annMenu.contains(e.target)) closeAnnMenu();
});

/* ===================================================================== search */

let searchToken = 0;

function openSearch() {
  $('searchbar').hidden = false;
  const input = $('search-input');
  input.focus();
  input.select();
  if (input.value.trim()) runSearch(input.value);
}

function closeSearch() {
  $('searchbar').hidden = true;
  searchToken++;
  state.search = null;
  for (const p of state.pages) p.searchLayer.innerHTML = '';
  $('search-count').textContent = '';
}

/** Lower-case page text with single spaces, plus where each character came from. */
async function pageSearchText(n) {
  const p = state.pages[n - 1];
  if (p.searchText) return p.searchText;
  const tc = await pageTextContent(n);
  let str = '';
  const map = [];
  tc.items.forEach((it, idx) => {
    const t = (it.str || '').toLowerCase();
    for (let k = 0; k < t.length; k++) {
      const ch = /\s/.test(t[k]) ? ' ' : t[k];
      if (ch === ' ' && (str.endsWith(' ') || !str)) continue;
      str += ch;
      map.push([idx, k]);
    }
    if (it.hasEOL && str && !str.endsWith(' ')) {
      str += ' ';
      map.push([idx, t.length]);
    }
  });
  p.searchText = { str, map };
  return p.searchText;
}

function setupSearch() {
  const input = $('search-input');
  let timer;
  $('search-btn').onclick = () => ($('searchbar').hidden ? openSearch() : closeSearch());
  $('search-close').onclick = closeSearch;
  $('search-next').onclick = () => stepMatch(1);
  $('search-prev').onclick = () => stepMatch(-1);
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(() => runSearch(input.value), 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!state.search || state.search.q !== normalizeQuery(input.value)) runSearch(input.value);
      else stepMatch(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearch();
    }
  });
}

const normalizeQuery = (q) => q.trim().toLowerCase().replace(/\s+/g, ' ');

async function runSearch(raw) {
  const token = ++searchToken;
  const q = normalizeQuery(raw);
  for (const p of state.pages) p.searchLayer.innerHTML = '';
  if (q.length < 2) {
    state.search = null;
    $('search-count').textContent = '';
    return;
  }
  const search = (state.search = { q, matches: [], index: -1 });
  const n = state.pdf.numPages;
  for (let page = 1; page <= n; page++) {
    const { str } = await pageSearchText(page);
    if (token !== searchToken) return;
    for (let i = str.indexOf(q); i !== -1; i = str.indexOf(q, i + 1)) search.matches.push({ page, start: i, end: i + q.length });
    if (search.index === -1 && search.matches.length) {
      // jump to the first match at or after the page you're reading
      const here = currentPage();
      if (page >= here || page === n) goToMatch(Math.max(0, search.matches.findIndex((m) => m.page >= here)));
    }
    if (page % 20 === 0 || page === n) $('search-count').textContent = page < n ? `${search.matches.length}… (${page}/${n})` : '';
  }
  if (token !== searchToken) return;
  if (search.index === -1 && search.matches.length) goToMatch(0);
  updateSearchCount();
  for (const p of state.pages) if (p.textDivs) drawSearchHits(p);
}

function updateSearchCount() {
  const s = state.search;
  $('search-count').textContent = !s ? '' : s.matches.length ? `${s.index + 1} of ${s.matches.length}` : 'No results';
}

function stepMatch(dir) {
  const s = state.search;
  if (!s || !s.matches.length) return;
  goToMatch((s.index + dir + s.matches.length) % s.matches.length);
}

async function goToMatch(i) {
  const s = state.search;
  s.index = i;
  updateSearchCount();
  const m = s.matches[i];
  const p = state.pages[m.page - 1];
  // scroll so the match sits in the upper third of the screen
  try {
    const { map } = await pageSearchText(m.page);
    const item = p.textContent.items[map[m.start][0]];
    const vp = (await state.pdf.getPage(m.page)).getViewport({ scale: 1 });
    const [, vy] = vp.convertToViewportPoint(item.transform[4], item.transform[5]);
    viewer.scrollTop = p.el.offsetTop + (vy / vp.height) * p.el.offsetHeight - viewer.clientHeight * 0.3;
  } catch {
    scrollToPosition(m.page);
  }
  for (const pg of state.pages) if (pg.textDivs) drawSearchHits(pg);
}

function drawSearchHits(p) {
  p.searchLayer.innerHTML = '';
  const s = state.search;
  if (!s || !p.textDivs || !p.searchText) return;
  const { map } = p.searchText;
  const pr = p.el.getBoundingClientRect();
  s.matches.forEach((m, i) => {
    if (m.page !== p.num) return;
    const [si, so] = map[m.start];
    const [ei, eo] = map[m.end - 1];
    const raw = [];
    const r = document.createRange();
    for (let idx = si; idx <= ei; idx++) {
      const t = p.textDivs[idx]?.firstChild;
      if (!t || t.nodeType !== 3) continue;
      const a = idx === si ? Math.min(so, t.length) : 0;
      const b = idx === ei ? Math.min(eo + 1, t.length) : t.length;
      if (b <= a) continue;
      r.setStart(t, a);
      r.setEnd(t, b);
      for (const c of r.getClientRects()) raw.push({ x: c.left - pr.left, y: c.top - pr.top, w: c.width, h: c.height });
    }
    for (const box of mergeLineRects(raw)) {
      const d = document.createElement('div');
      if (i === s.index) d.className = 'current';
      Object.assign(d.style, {
        left: (box.x / pr.width) * 100 + '%',
        top: (box.y / pr.height) * 100 + '%',
        width: (box.w / pr.width) * 100 + '%',
        height: (box.h / pr.height) * 100 + '%',
      });
      p.searchLayer.appendChild(d);
    }
  });
}

/* ============================================== export notes as Markdown */

function notesMarkdown() {
  const title = state.doc.name.replace(/\.pdf$/i, '');
  const list = [...state.anns.values()].filter((a) => a.type !== 'pen' && a.type !== 'marker').sort((a, b) => a.page - b.page || yOfAnn(a) - yOfAnn(b));
  const lines = [`# ${title}`, '', `_Notes exported from PageSync on ${new Date().toLocaleString()}_`, ''];
  let page = 0;
  for (const a of list) {
    if (a.page !== page) {
      page = a.page;
      lines.push(`## Page ${page}`, '');
    }
    if (a.type === 'texthl') {
      const t = (a.text || '').replace(/\s+/g, ' ');
      lines.push(a.mode === 'strike' ? `- ~~${t}~~` : a.mode === 'underline' ? `- <u>${t}</u>` : `- > ${t}`);
    } else if (a.type === 'highlight') lines.push('- _(highlighted area)_');
    else if (a.type === 'text') lines.push(`- **Text:** ${a.text}`);
    else if (a.type === 'note') lines.push(`- **Note:** ${a.text}`);
    if (a.note) lines.push(`  - 📝 ${a.note.replace(/\n+/g, ' ')}`);
  }
  if (!list.length) lines.push('_No highlights or notes yet._');
  return lines.join('\n') + '\n';
}

function exportNotesMarkdown() {
  const blob = new Blob([notesMarkdown()], { type: 'text/markdown' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = state.doc.name.replace(/\.pdf$/i, '') + ' - notes.md';
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(link.href), 60e3);
  toast('Notes downloaded as a Markdown file.');
}

/* ============================================================== night mode */

function setNight(on) {
  document.body.classList.toggle('night', on);
  storage.set('ps_night', on);
}

function setupPanelTabs() {
  for (const b of document.querySelectorAll('[data-ptab]')) {
    b.onclick = () => {
      state.panelTab = b.dataset.ptab;
      renderPanel();
    };
  }
}

/* =========================================================== AI "Explain" */

const EXPLAIN_LANGS = [
  ['english', 'English'],
  ['simple', 'Simple English'],
  ['hinglish', 'Hinglish'],
  ['hindi', 'हिंदी (Hindi)'],
];
let explain = null; // { text, page, sentence, context, mode, answer, fromAnnId, parts, card }
const explainCache = new Map();

/** Page text plus where each text piece starts in it (pieces are in the same order as the text layer's spans). */
async function pageString(n) {
  const tc = await pageTextContent(n);
  const starts = [];
  let page = '';
  for (const it of tc.items) {
    starts.push(page.length);
    page += (it.str || '') + (it.hasEOL ? ' ' : '');
  }
  return { page, starts };
}

/** Where a text-layer position (span + offset) sits in the page text. */
function offsetInPage(p, node, offset, starts) {
  const span = node?.nodeType === 3 ? node.parentElement : node;
  const idx = p.textDivs ? p.textDivs.indexOf(span) : -1;
  return idx >= 0 ? starts[idx] + (node.nodeType === 3 ? offset : 0) : null;
}

/** Where a saved highlight starts in the page text (from its first box on screen). */
function offsetOfMark(a, starts) {
  const p = state.pages[a.page - 1];
  const r = a.rects?.[0];
  if (!p?.textDivs || !r) return null;
  const pr = p.el.getBoundingClientRect();
  const x = pr.left + (r[0] + 0.002) * pr.width;
  const y = pr.top + (r[1] + r[3] / 2) * pr.height;
  for (let i = 0; i < p.textDivs.length; i++) {
    const b = p.textDivs[i].getBoundingClientRect();
    if (x >= b.left - 1 && x <= b.right + 1 && y >= b.top && y <= b.bottom) return starts[i];
  }
  return null;
}

/**
 * The sentence around `text` on page n, plus nearby text, for context.
 * `near` = where the selection really is (the same word can appear many times on a page).
 */
async function contextFor(n, text, near = null) {
  try {
    const { page } = await pageString(n);
    const words = text.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const re = new RegExp(words.join('\\s*'), 'gi');
    let best = null;
    for (const m of page.matchAll(re)) {
      if (best === null || (near !== null && Math.abs(m.index - near) < Math.abs(best.index - near))) best = { index: m.index, len: m[0].length };
      if (near === null) break;
    }
    const flat = (t) => t.replace(/\s+/g, ' ').trim();
    if (!best) return { sentence: flat(text), context: flat(page.slice(0, 1400)) };
    const i = best.index;
    const end = i + best.len;
    let st = i;
    while (st > 0 && i - st < 500 && !/[.!?]\s/.test(page.slice(st - 2, st))) st--;
    let e = end;
    while (e < page.length && e - end < 500 && !/[.!?]/.test(page[e - 1] || '')) e++;
    return { sentence: flat(page.slice(st, e)), context: flat(page.slice(Math.max(0, i - 700), Math.min(page.length, end + 700))) };
  } catch {
    return { sentence: text, context: '' };
  }
}

function renderAnswer(text) {
  const inline = (t) => escapeHtml(t).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  const out = [];
  let list = [];
  const flush = () => {
    if (list.length) out.push(`<ul>${list.map((li) => `<li>${inline(li)}</li>`).join('')}</ul>`);
    list = [];
  };
  for (const raw of text.split(/\n+/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^[-*•]\s+(.*)$/.exec(line);
    if (m) list.push(m[1]);
    else {
      flush();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  flush();
  return out.join('');
}

const plainAnswer = (t) => t.replace(/\*\*(.+?)\*\*/g, '$1').trim();

function closeExplain() {
  explain?.card.remove();
  explain = null;
}

async function openExplain({ text, page, fromAnnId = null, parts = null, near = null }) {
  closeExplain();
  text = text.replace(/\s+/g, ' ').trim();
  if (!text) return;
  const words = text.split(' ').length;
  const card = document.createElement('div');
  card.className = 'explain-card';
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-label', 'Explain');
  card.innerHTML = `
    <div class="ex-head">
      <span class="ex-title">${icon('sparkle')}Explain</span>
      <select class="ex-lang" aria-label="Language">${EXPLAIN_LANGS.map(([v, l]) => `<option value="${v}">${l}</option>`).join('')}</select>
      <button class="icon-btn ex-close" title="Close">${icon('x')}</button>
    </div>
    <blockquote class="ex-quote"></blockquote>
    <div class="ex-body"></div>
    <div class="ex-actions" hidden>
      <button class="btn" data-ex="simpler">Explain simpler</button>
      <button class="btn" data-ex="save">${icon('note')}Save as note</button>
      <button class="btn" data-ex="copy">${icon('copy')}Copy</button>
    </div>
    <div class="ex-foot"></div>`;
  card.querySelector('.ex-quote').textContent = text.length > 280 ? text.slice(0, 280) + '…' : text;
  const lang = card.querySelector('.ex-lang');
  lang.value = storage.get('ps_explain_lang', 'english');
  document.body.appendChild(card);
  explain = { text, page, fromAnnId, parts, card, mode: words <= 4 ? 'word' : 'passage', answer: '', sentence: '', context: '' };
  const mine = explain;

  card.querySelector('.ex-close').onclick = closeExplain;
  lang.onchange = () => {
    storage.set('ps_explain_lang', lang.value);
    runExplain(mine.mode === 'simpler' ? (mine.baseMode || 'word') : mine.mode);
  };
  card.querySelector('.ex-actions').onclick = async (e) => {
    const act = e.target.closest('[data-ex]')?.dataset.ex;
    if (!act || !mine.answer) return;
    if (act === 'copy') return copyText(plainAnswer(mine.answer));
    if (act === 'simpler') return runExplain('simpler');
    if (act === 'save') return saveExplanation(mine);
  };

  const ctx = await contextFor(page, text, near);
  if (explain !== mine) return;
  Object.assign(mine, ctx);
  runExplain(mine.mode);
}

async function runExplain(mode) {
  const ex = explain;
  if (!ex) return;
  const language = ex.card.querySelector('.ex-lang').value;
  if (mode !== 'simpler') ex.baseMode = mode;
  const previous = mode === 'simpler' ? plainAnswer(ex.answer) : '';
  ex.mode = mode;
  const body = ex.card.querySelector('.ex-body');
  const actions = ex.card.querySelector('.ex-actions');
  const foot = ex.card.querySelector('.ex-foot');
  const key = [mode, language, ex.text, ex.sentence, previous].join('|');
  body.innerHTML = '<div class="ex-loading"><div class="spinner"></div>Thinking…</div>';
  actions.hidden = true;
  try {
    let res = explainCache.get(key);
    if (!res) {
      if (!navigator.onLine) throw Object.assign(new Error("You're offline. Explain needs an internet connection."), { offline: true });
      res = await backend.explainText({ text: ex.text, sentence: ex.sentence, context: ex.context, docName: state.doc.name, mode, language, previous });
      explainCache.set(key, res);
    }
    if (explain !== ex) return;
    ex.answer = res.explanation;
    body.innerHTML = renderAnswer(res.explanation);
    actions.hidden = false;
    actions.querySelector('[data-ex="simpler"]').hidden = mode === 'simpler';
    foot.textContent = (res.remaining != null ? `${res.remaining} of ${res.dailyLimit} explanations left today · ` : '') + 'AI can make mistakes; check important facts.';
  } catch (err) {
    if (explain !== ex) return;
    body.innerHTML = `<p class="ex-error">${escapeHtml(err.offline ? "You're offline. Explain needs an internet connection." : err.message || 'Something went wrong.')}</p>`;
    foot.textContent = '';
  }
}

function saveExplanation(ex) {
  const text = plainAnswer(ex.answer).slice(0, 4000);
  if (ex.fromAnnId) {
    const before = state.anns.get(ex.fromAnnId);
    if (!before) return toast('That highlight was deleted.', { error: true });
    const note = before.note ? `${before.note}\n\n${text}` : text;
    commit([{ id: before.id, before, after: { ...before, note } }]);
  } else if (ex.parts?.length) {
    const s = styleFor('texthl');
    const now = Date.now();
    const changes = ex.parts.map((part, i) => {
      const a = { id: uid(), type: 'texthl', page: part.p.num, rects: part.rects, mode: 'highlight', color: s.color, text: part.text.slice(0, 5000), createdAt: now };
      if (i === 0) a.note = text;
      return { id: a.id, before: null, after: a };
    });
    commit(changes);
    ex.fromAnnId = changes[0].id; // saving again adds to the same note
    ex.parts = null;
  }
  toast('Saved as a note on this text.');
}

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && explain) closeExplain();
});

init();

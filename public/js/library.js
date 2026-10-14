/* PageSync — library page */
import * as backend from './backend.js';

const { icon, escapeHtml, timeAgo, formatSize, toast, device } = PS;
PS.hydrateIcons();
backend.registerServiceWorker();

const $ = (id) => document.getElementById(id);
const grid = $('grid');
const fileInput = $('file-input');
let docs = [];
let cached = new Set();
let offline = false;
let filter = '';

await backend.requireAuth();

/* ---------------- device name ---------------- */
function renderDevice() {
  $('device').querySelector('span').textContent = device.name;
}
$('device').onclick = async () => {
  const name = await PS.prompt('Name this device', device.name, { placeholder: 'e.g. Laptop, Phone' });
  if (name) {
    device.name = name;
    renderDevice();
    toast('Other devices will see “' + device.name + '” as where you last read.');
  }
};
renderDevice();
$('app-version').textContent = `PageSync v${backend.APP_VERSION}`;

/* ---------------- list ---------------- */
async function load() {
  try {
    const res = await backend.listDocs();
    docs = res.docs;
    offline = res.offline;
    cached = await backend.cachedPdfIds();
    render();
    if (!offline) backend.getLimits().then(renderUsage);
  } catch (err) {
    $('summary').textContent = 'Could not load your library: ' + err.message;
  }
}

function progressOf(d) {
  if (!d.position || !d.pageCount) return 0;
  return Math.min(1, (d.position.page - 1 + (d.position.offset || 0)) / d.pageCount);
}

function subline(d) {
  if (d.position && d.pageCount) return `Page ${d.position.page} of ${d.pageCount} · ${timeAgo(d.position.at)}`;
  return `${formatSize(d.size)} · added ${timeAgo(d.createdAt)}`;
}

const cover = (d) => (d.thumb ? `<img loading="lazy" alt="" src="${d.thumb}">` : icon('file'));

function render() {
  const total = docs.length;
  $('summary').textContent = total ? `${total} PDF${total === 1 ? '' : 's'} · synced across your devices` : 'Nothing here yet';
  const net = $('net');
  net.hidden = !offline;
  net.innerHTML = offline ? `${icon('cloudOff')}<span>You're offline. PDFs marked “on this device” can still be opened, and your changes will sync later.</span>` : '';
  $('empty').hidden = total > 0 || offline;
  $('search').hidden = total < 6;

  const last = docs.find((d) => d.position);
  const cont = $('continue');
  if (last && !filter) {
    cont.hidden = false;
    cont.href = `viewer.html?id=${encodeURIComponent(last.id)}`;
    cont.innerHTML = `
      ${last.thumb ? `<img alt="" src="${last.thumb}">` : '<div class="ph"></div>'}
      <div class="meta">
        <div class="label">Continue reading</div>
        <div class="title">${escapeHtml(last.name)}</div>
        <div class="sub">Page ${last.position.page}${last.pageCount ? ' of ' + last.pageCount : ''} · last on ${escapeHtml(last.position.device || 'another device')}, ${timeAgo(last.position.at)}</div>
      </div>
      <span class="btn primary">Open</span>`;
  } else cont.hidden = true;

  const q = filter.toLowerCase();
  const shown = docs.filter((d) => !q || d.name.toLowerCase().includes(q));
  grid.innerHTML = shown
    .map((d) => {
      const local = cached.has(d.id);
      const unavailable = offline && !local;
      return `
    <a class="card${unavailable ? ' unavailable' : ''}" href="viewer.html?id=${encodeURIComponent(d.id)}" data-id="${escapeHtml(d.id)}">
      <div class="cover">${cover(d)}${local ? `<span class="badge" title="Saved on this device — opens without internet">${icon('check')}</span>` : ''}</div>
      ${d.position && d.pageCount ? `<div class="progress"><div style="width:${(progressOf(d) * 100).toFixed(1)}%"></div></div>` : ''}
      <div>
        <div class="name" title="${escapeHtml(d.name)}">${escapeHtml(d.name.replace(/\.pdf$/i, ''))}</div>
        <div class="sub">${subline(d)}${d.annotationCount ? ` · ${d.annotationCount} mark${d.annotationCount === 1 ? '' : 's'}` : ''}${unavailable ? ' · needs internet' : ''}</div>
      </div>
      <button class="menu-btn" data-menu="${escapeHtml(d.id)}" aria-label="More actions">${icon('more')}</button>
    </a>`;
    })
    .join('');
}

const gb = (n) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(n >= 10 * 1024 ** 3 ? 0 : 1)} GB` : `${Math.max(n ? 1 : 0, Math.round(n / 1024 ** 2))} MB`);
let limits = null;

function renderUsage(l) {
  limits = l;
  const el = $('usage');
  if (!l || l.usedBytes == null) return (el.hidden = true);
  el.hidden = false;
  const perFile = `PDFs up to ${gb(l.maxFileBytes)} each${l.isAdmin ? ' · <a href="check.html">Setup check</a>' : ''}`;
  if (l.quotaBytes == null) {
    el.className = 'usage';
    el.innerHTML = `<span>Using ${gb(l.usedBytes)} · ${perFile}</span>`;
    return;
  }
  const pct = Math.min(100, (l.usedBytes / l.quotaBytes) * 100);
  el.className = 'usage' + (pct >= 90 ? ' full' : '');
  el.innerHTML = `<div class="meter" aria-hidden="true"><div style="width:${pct.toFixed(1)}%"></div></div><span>${gb(l.usedBytes)} of ${gb(l.quotaBytes)} used · ${perFile}</span>`;
}

$('search').addEventListener('input', (e) => {
  filter = e.target.value.trim();
  render();
});

grid.addEventListener('click', (e) => {
  const card = e.target.closest('.card.unavailable');
  if (card && !e.target.closest('[data-menu]')) {
    e.preventDefault();
    toast("This PDF isn't saved on this device yet. Open it once while online and it will work offline after that.");
  }
});

/* ---------------- card menu ---------------- */
let openMenu = null;
function closeMenu() {
  if (openMenu) openMenu.remove();
  openMenu = null;
}
document.addEventListener('pointerdown', (e) => {
  if (openMenu && !openMenu.contains(e.target)) closeMenu();
});

async function downloadOriginal(d) {
  const close = toast('Preparing download…', { duration: 0 });
  try {
    const { bytes } = await backend.getPdfBytes(d);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([bytes], { type: 'application/pdf' }));
    a.download = d.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 60e3);
    cached = await backend.cachedPdfIds();
    render();
  } catch (err) {
    toast(err.message, { error: true });
  } finally {
    close();
  }
}

grid.addEventListener('click', (e) => {
  const btn = e.target.closest('[data-menu]');
  if (!btn) return;
  e.preventDefault();
  e.stopPropagation();
  const d = docs.find((x) => x.id === btn.dataset.menu);
  if (!d) return;
  closeMenu();
  const menu = document.createElement('div');
  menu.className = 'popmenu';
  menu.innerHTML = `
    <button data-act="rename">${icon('edit')}Rename</button>
    <button data-act="download">${icon('download')}Download original</button>
    <button data-act="delete" class="danger">${icon('trash')}Delete</button>`;
  document.body.appendChild(menu);
  const r = btn.getBoundingClientRect();
  menu.style.top = Math.min(r.bottom + 6, innerHeight - menu.offsetHeight - 8) + 'px';
  menu.style.left = Math.max(8, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 8)) + 'px';
  openMenu = menu;
  menu.onclick = async (ev) => {
    const act = ev.target.closest('[data-act]')?.dataset.act;
    if (!act) return;
    closeMenu();
    try {
      if (act === 'rename') {
        const name = await PS.prompt('Rename PDF', d.name);
        if (name && name.trim() && name !== d.name) {
          await backend.renameDoc(d.id, name);
          await load();
        }
      } else if (act === 'download') {
        await downloadOriginal(d);
      } else if (act === 'delete') {
        const ok = await PS.confirm(`Delete “${d.name}”?`, 'The PDF and all its highlights and notes will be removed from every device. This cannot be undone.');
        if (ok) {
          await backend.deleteDoc(d);
          await load();
        }
      }
    } catch (err) {
      toast(err.offline ? 'You need to be online for that.' : err.message, { error: true });
    }
  };
});

/* ---------------- upload ---------------- */
async function uploadFile(file) {
  const item = document.createElement('div');
  item.className = 'upload-item';
  item.innerHTML = `<div>Uploading <strong>${escapeHtml(file.name)}</strong>…</div><div class="progress"><div style="width:0%"></div></div>`;
  $('uploads').appendChild(item);
  const bar = item.querySelector('.progress > div');
  try {
    const doc = await backend.uploadPdf(file, (f) => (bar.style.width = (f * 100).toFixed(1) + '%'));
    return doc;
  } catch (err) {
    toast(`${file.name}: ${err.message}`, { error: true, duration: 7000 });
    return null;
  } finally {
    item.remove();
  }
}

async function uploadFiles(list) {
  const files = [...list].filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name));
  if (!files.length) return toast('Only PDF files can be added.', { error: true });
  if (offline || !navigator.onLine) return toast('You need to be online to add PDFs.', { error: true });
  if (limits) {
    const tooBig = files.find((f) => f.size > limits.maxFileBytes);
    if (tooBig) return toast(`${tooBig.name} is ${gb(tooBig.size)}. The limit is ${gb(limits.maxFileBytes)} per PDF.`, { error: true, duration: 7000 });
  }
  let lastDoc = null;
  for (const f of files) lastDoc = (await uploadFile(f)) || lastDoc;
  await load();
  if (files.length === 1 && lastDoc) {
    toast('Added. Open it?', { action: { label: 'Open', run: () => (location.href = `viewer.html?id=${encodeURIComponent(lastDoc.id)}`) } });
  }
}

$('upload-btn').onclick = $('empty-upload').onclick = () => fileInput.click();
fileInput.onchange = () => {
  uploadFiles(fileInput.files);
  fileInput.value = '';
};

let dragDepth = 0;
addEventListener('dragenter', (e) => {
  if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
  e.preventDefault();
  dragDepth++;
  $('dropzone').hidden = false;
});
addEventListener('dragover', (e) => e.preventDefault());
addEventListener('dragleave', () => {
  dragDepth = Math.max(0, dragDepth - 1);
  if (!dragDepth) $('dropzone').hidden = true;
});
addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropzone').hidden = true;
  if (e.dataTransfer?.files?.length) uploadFiles(e.dataTransfer.files);
});

/* ---------------- sign out ---------------- */
$('logout').onclick = async () => {
  const email = await backend.currentEmail();
  const ok = await PS.confirm('Sign out on this device?', `${email ? `You're signed in as ${email}. ` : ''}PDFs saved on this device for offline reading will be removed. Everything stays safe in your cloud.`, {
    label: 'Sign out',
    kind: 'primary',
  });
  if (!ok) return;
  await backend.signOut();
  location.replace('login.html');
};

/* ---------------- live refresh ---------------- */
let refreshTimer;
const refreshSoon = (delay = 300) => {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(load, delay);
};
let hadError = false;
backend.subscribeLibrary(
  () => refreshSoon(),
  (status) => {
    if (status === 'SUBSCRIBED' && hadError) refreshSoon(0);
    hadError = status !== 'SUBSCRIBED';
  }
);
addEventListener('online', () => refreshSoon(0));
addEventListener('offline', () => {
  offline = true;
  render();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refreshSoon(0);
});
setInterval(() => document.visibilityState === 'visible' && render(), 60e3); // keep "x min ago" fresh

load();

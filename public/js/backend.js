/* PageSync — everything that talks to the cloud (Supabase) and the on-device cache. */
import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.105.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from '../config.js';

export const BUCKET = 'pdfs';
export const MAX_UPLOAD_BYTES = 50 * 1024 * 1024; // Supabase free plan: 50 MB per file
const CACHE_LIMIT_BYTES = 1500 * 1024 * 1024; // PDFs kept on this device for offline reading

/**
 * Clean up the Project URL. People often paste the "RESTful endpoint"
 * (https://xxxx.supabase.co/rest/v1/) or the dashboard address; we only need
 * https://xxxx.supabase.co — anything after that breaks login with
 * "Invalid path specified in request URL".
 */
function normalizeUrl(raw) {
  let s = String(raw || '').trim().replace(/^['"]|['"]$/g, '');
  const dash = /supabase\.com\/dashboard\/project\/([a-z0-9]{10,})/i.exec(s);
  if (dash) return `https://${dash[1].toLowerCase()}.supabase.co`;
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  try {
    const u = new URL(s);
    return /^[a-z0-9.-]+$/i.test(u.hostname) ? u.origin : '';
  } catch {
    return '';
  }
}

const baseUrl = normalizeUrl(SUPABASE_URL);
const apiKey = String(SUPABASE_KEY || '').trim().replace(/^['"]|['"]$/g, '');

function keyRole(key) {
  if (key.startsWith('sb_secret_')) return 'secret';
  if (key.startsWith('sb_publishable_')) return 'publishable';
  try {
    return JSON.parse(atob(key.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).role || 'unknown';
  } catch {
    return 'unknown';
  }
}

/** A human-readable problem with config.js, or '' if it looks fine. */
export const configProblem = (() => {
  if (!SUPABASE_URL || /YOUR-/.test(SUPABASE_URL) || !apiKey || /YOUR-/.test(apiKey)) return 'not-set';
  if (!baseUrl) return 'SUPABASE_URL in config.js is not a valid web address. It should look like https://abcdxyz.supabase.co';
  const role = keyRole(apiKey);
  if (role === 'secret' || role === 'service_role') {
    return 'config.js contains your SECRET key. Never put that on a website. Use the "Publishable" (or "anon public") key instead, and consider rotating the secret key in Supabase.';
  }
  return '';
})();

export const configured = !configProblem;

export const sb = configured
  ? createClient(baseUrl, apiKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true, flowType: 'implicit' },
      realtime: { params: { eventsPerSecond: 20 } },
    })
  : null;

/* ------------------------------------------------------------------ errors */

export class BackendError extends Error {
  constructor(message, { status, offline = false, code } = {}) {
    super(message);
    this.status = status;
    this.offline = offline;
    this.code = code;
  }
}

function isNetworkError(e) {
  const text = `${e?.name || ''} ${e?.message || e || ''}`;
  return (
    !navigator.onLine ||
    /failed to fetch|networkerror|network request failed|load failed|fetch failed|AuthRetryableFetchError|ERR_INTERNET|timed? ?out/i.test(text)
  );
}

function wrap(error) {
  if (error instanceof BackendError) return error;
  if (isNetworkError(error)) return new BackendError('You are offline', { offline: true });
  const status = error?.code === 'P0002' || error?.code === 'PGRST116' ? 404 : Number(error?.status) || undefined;
  return new BackendError(error?.message || 'Something went wrong', { status, code: error?.code });
}

/** Run a Supabase call, return its data or throw a BackendError. */
async function run(promiseLike) {
  let result;
  try {
    result = await promiseLike;
  } catch (e) {
    throw wrap(e);
  }
  if (result?.error) throw wrap(result.error);
  return result?.data;
}

/* ------------------------------------------------------- tiny IndexedDB */

let dbPromise;
function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open('pagesync', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function idbTx(mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction('kv', mode);
    const req = fn(t.objectStore('kv'));
    t.oncomplete = () => resolve(req?.result);
    t.onerror = t.onabort = () => reject(t.error);
  });
}

export const idb = {
  get: (key) => idbTx('readonly', (s) => s.get(key)).catch(() => undefined),
  set: (key, value) => idbTx('readwrite', (s) => s.put(value, key)).catch((e) => console.warn('Cache write failed', e)),
  del: (key) => idbTx('readwrite', (s) => s.delete(key)).catch(() => {}),
  clear: () => idbTx('readwrite', (s) => s.clear()).catch(() => {}),
};

/* -------------------------------------------------------------- auth */

let accessToken = null;
let currentUserId = null;
if (sb) {
  sb.auth.onAuthStateChange((_event, session) => {
    accessToken = session?.access_token || null;
    currentUserId = session?.user?.id || currentUserId;
  });
}

/** Returns { session, offline }. Never throws. */
export async function getSession() {
  if (!sb) return { session: null, offline: false };
  try {
    const { data, error } = await sb.auth.getSession();
    if (data?.session) {
      accessToken = data.session.access_token;
      currentUserId = data.session.user.id;
      return { session: data.session, offline: false };
    }
    return { session: null, offline: !!error && isNetworkError(error) };
  } catch (e) {
    return { session: null, offline: isNetworkError(e) };
  }
}

/** Use on every page that needs login. Redirects to the login page if needed. */
export async function requireAuth() {
  if (!configured) {
    location.replace('login.html');
    return new Promise(() => {});
  }
  const { session, offline } = await getSession();
  if (session) return session;
  if (offline) return null; // offline: keep going with what's saved on this device
  const here = location.pathname.split('/').pop() + location.search;
  location.replace('login.html?next=' + encodeURIComponent(here || 'index.html'));
  return new Promise(() => {});
}

export async function signIn(email, password) {
  if (!sb) throw new BackendError('PageSync is not set up yet (see config.js).');
  await run(sb.auth.signInWithPassword({ email: email.trim(), password }));
}

/** Create an account. Returns { needsConfirmation } when the project requires email confirmation. */
export async function signUp(email, password) {
  if (!sb) throw new BackendError('PageSync is not set up yet (see config.js).');
  const data = await run(
    sb.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: new URL('login.html', location.href).href } })
  );
  if (data?.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
    throw new BackendError('An account with this email already exists. Try signing in.');
  }
  return { needsConfirmation: !data?.session };
}

export async function sendPasswordReset(email) {
  if (!sb) throw new BackendError('PageSync is not set up yet (see config.js).');
  await run(sb.auth.resetPasswordForEmail(email.trim(), { redirectTo: new URL('reset.html', location.href).href }));
}

export async function updatePassword(password) {
  await run(sb.auth.updateUser({ password }));
}

/** Fires when the user arrives from a password-reset email. */
export function onPasswordRecovery(cb) {
  if (!sb) return;
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY' || (event === 'SIGNED_IN' && session)) cb(session);
  });
}

export async function currentEmail() {
  const { session } = await getSession();
  return session?.user?.email || null;
}

export async function signOut() {
  await idb.clear(); // remove this account's offline copies from the device
  try {
    for (const k of Object.keys(localStorage)) if (k.startsWith('ps_pending_') || k.startsWith('ps_pos_')) localStorage.removeItem(k);
  } catch {}
  if (sb) await sb.auth.signOut().catch(() => {});
}

/* ---------------------------------------------------------- documents */

function toDoc(r) {
  return {
    id: r.id,
    owner: r.owner,
    name: r.name,
    size: Number(r.size) || 0,
    pageCount: r.page_count,
    position: r.position,
    thumb: r.thumb,
    annotationCount: r.annotation_count || 0,
    storage: r.storage || 'supabase',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    lastOpenedAt: r.last_opened_at,
  };
}

export function sortDocs(docs) {
  const key = (d) => String(d.lastOpenedAt || d.createdAt || '');
  return [...docs].sort((a, b) => key(b).localeCompare(key(a)));
}

/** Library list. Falls back to the copy saved on this device when offline. */
export async function listDocs() {
  try {
    const rows = await run(sb.from('documents').select('*'));
    const docs = sortDocs(rows.map(toDoc));
    idb.set('library', docs);
    return { docs, offline: false };
  } catch (e) {
    if (e.offline) return { docs: sortDocs((await idb.get('library')) || []), offline: true };
    throw e;
  }
}

/** Fetch all rows of a query, 1000 at a time (Supabase returns at most 1000 per request). */
async function fetchAll(makeQuery) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await run(makeQuery().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}

/** One document with all its annotations. Offline: the copy saved on this device. */
export async function getDoc(id) {
  try {
    const [row, annRows] = await Promise.all([
      run(sb.from('documents').select('*').eq('id', id).maybeSingle()),
      fetchAll(() => sb.from('annotations').select('id,data,updated_at').eq('doc_id', id).eq('deleted', false).order('id')),
    ]);
    if (!row) throw new BackendError('This PDF was deleted.', { status: 404 });
    const doc = { ...toDoc(row), annotations: annRows.map((r) => r.data).filter(Boolean) };
    idb.set('doc:' + id, doc);
    return { doc, offline: false };
  } catch (e) {
    if (e.offline) {
      const doc = await idb.get('doc:' + id);
      if (doc) return { doc, offline: true };
      throw new BackendError("You're offline and this PDF hasn't been opened on this device yet.", { offline: true });
    }
    throw e;
  }
}

/** Save the latest state of a document on this device (for offline use). */
export function cacheDocState(doc) {
  return idb.set('doc:' + doc.id, doc);
}

function newId(len = 12) {
  const abc = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  return [...bytes].map((b) => abc[b % abc.length]).join('');
}

export function cleanFileName(raw) {
  const name = String(raw || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (name || 'Untitled.pdf').slice(0, 200);
}

/* ------------------------------------------- big-file storage (R2) */

const FUNCTION_NAME = 'pdf-storage';
const local = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {}
  },
};
const LEGACY_LIMITS = { cloudStorage: false, maxFileBytes: MAX_UPLOAD_BYTES, quotaBytes: null, usedBytes: null };

/** Call the pdf-storage Edge Function. */
export async function callStorage(action, payload = {}) {
  const { session, offline } = await getSession();
  if (!session) throw new BackendError(offline ? "You're offline." : 'Please sign in again.', { offline, status: 401 });
  let res;
  try {
    res = await fetch(`${baseUrl}/functions/v1/${FUNCTION_NAME}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', apikey: apiKey, Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ action, ...payload }),
    });
  } catch (e) {
    throw wrap(e);
  }
  let data = {};
  try {
    data = await res.json();
  } catch {}
  if (!res.ok) {
    if (res.status === 404 && !data.error) throw new BackendError('The pdf-storage function is not deployed.', { status: 404, code: 'NO_FUNCTION' });
    throw new BackendError(data.error || data.message || data.msg || `Storage service error (${res.status})`, { status: res.status });
  }
  return data;
}

/**
 * Upload limits for the signed-in user:
 *   { cloudStorage, maxFileBytes, quotaBytes (null = unlimited), usedBytes }
 * Falls back to the Supabase-only limits (50 MB) if the function isn't set up.
 */
export async function getLimits() {
  try {
    const limits = await callStorage('limits');
    local.set('ps_limits', limits);
    return limits;
  } catch (e) {
    if (e.code === 'NO_FUNCTION' || e.status === 501) return LEGACY_LIMITS;
    if (e.offline) return local.get('ps_limits', LEGACY_LIMITS);
    console.warn('Could not read storage limits:', e);
    return local.get('ps_limits', LEGACY_LIMITS);
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function putPart(url, blob, onLoaded) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.upload.onprogress = (e) => onLoaded(e.loaded);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new BackendError(`Upload piece failed (${xhr.status})`, { status: xhr.status }));
    xhr.onerror = () => reject(new BackendError('Network error while uploading.', { offline: !navigator.onLine }));
    xhr.send(blob);
  });
}

/** Upload all pieces, 3 at a time, retrying each piece on a bad connection. */
async function uploadParts(file, { urls, partSize }, onProgress) {
  const loaded = new Array(urls.length).fill(0);
  const report = () => onProgress(Math.min(1, loaded.reduce((a, b) => a + b, 0) / file.size));
  let next = 0;
  async function worker() {
    while (next < urls.length) {
      const i = next++;
      const blob = file.slice(i * partSize, Math.min(file.size, (i + 1) * partSize));
      for (let attempt = 1; ; attempt++) {
        try {
          await putPart(urls[i], blob, (n) => {
            loaded[i] = n;
            report();
          });
          loaded[i] = blob.size;
          report();
          break;
        } catch (e) {
          loaded[i] = 0;
          report();
          if (attempt >= 5 || (e.status && e.status < 500 && e.status !== 408 && e.status !== 429)) throw e;
          await sleep(1000 * 2 ** attempt); // 2s, 4s, 8s, 16s
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(3, urls.length) }, worker));
}

/** Upload a PDF file. onProgress(0..1). Returns the new document. */
export async function uploadPdf(file, onProgress = () => {}) {
  const head = new Uint8Array(await file.slice(0, 1024).arrayBuffer());
  if (!String.fromCharCode(...head).includes('%PDF-')) throw new BackendError('That file is not a PDF.');
  const { session, offline } = await getSession();
  if (!session) throw new BackendError(offline ? 'You need to be online to add PDFs.' : 'Please sign in again.', { offline });

  const limits = await getLimits();
  const mb = (n) => Math.round(n / 1048576);
  if (file.size > limits.maxFileBytes) {
    throw new BackendError(`This PDF is ${mb(file.size)} MB. The limit is ${mb(limits.maxFileBytes)} MB per file.`);
  }
  if (limits.quotaBytes != null && limits.usedBytes != null && limits.usedBytes + file.size > limits.quotaBytes) {
    throw new BackendError(`Not enough space: you have ${mb(Math.max(0, limits.quotaBytes - limits.usedBytes))} MB left of your ${mb(limits.quotaBytes)} MB.`);
  }

  const id = newId();
  if (limits.cloudStorage) {
    const start = await callStorage('upload-start', { docId: id, size: file.size, name: cleanFileName(file.name) });
    try {
      await uploadParts(file, start, onProgress);
      const { document } = await callStorage('upload-complete', { docId: id, uploadId: start.uploadId });
      await cachePdf(id, file); // first open on this device is instant
      return toDoc(document);
    } catch (e) {
      callStorage('upload-abort', { docId: id, uploadId: start.uploadId }).catch(() => {});
      if (e.offline || /network/i.test(e.message)) throw new BackendError('Upload stopped: the connection dropped. Please try again.', { offline: e.offline });
      throw e;
    }
  }

  // Supabase Storage (used when the pdf-storage function isn't set up)
  const path = `${session.user.id}/${id}.pdf`;
  await new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `${baseUrl}/storage/v1/object/${BUCKET}/${path}`);
    xhr.setRequestHeader('Authorization', `Bearer ${session.access_token}`);
    xhr.setRequestHeader('apikey', apiKey);
    xhr.setRequestHeader('Content-Type', 'application/pdf');
    xhr.setRequestHeader('x-upsert', 'false');
    xhr.setRequestHeader('cache-control', 'max-age=31536000');
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = `Upload failed (${xhr.status})`;
      try {
        const body = JSON.parse(xhr.responseText);
        msg = body.message || body.error || msg;
      } catch {}
      if (xhr.status === 413 || /exceeded the maximum/i.test(msg)) msg = 'This PDF is larger than your storage allows (50 MB per file on the free plan).';
      reject(new BackendError(msg, { status: xhr.status }));
    };
    xhr.onerror = () => reject(new BackendError('Network error while uploading.', { offline: !navigator.onLine }));
    xhr.send(file);
  });

  let row;
  try {
    row = await run(sb.from('documents').insert({ id, name: cleanFileName(file.name), size: file.size }).select().single());
  } catch (e) {
    await sb.storage.from(BUCKET).remove([path]).catch(() => {});
    throw e;
  }
  await cachePdf(id, file);
  return toDoc(row);
}

export async function renameDoc(id, name) {
  await run(sb.from('documents').update({ name: cleanFileName(name) }).eq('id', id));
}

export async function deleteDoc(doc) {
  if (doc.storage === 'r2') {
    await callStorage('delete', { docId: doc.id }); // removes the file and the document
  } else {
    await run(sb.from('documents').delete().eq('id', doc.id)); // also removes its annotations
    await sb.storage.from(BUCKET).remove([`${doc.owner}/${doc.id}.pdf`]).catch(() => {});
  }
  await forgetPdf(doc.id);
  await idb.del('doc:' + doc.id);
}

export async function saveThumb(id, dataUrl) {
  await run(sb.from('documents').update({ thumb: dataUrl }).eq('id', id));
}

/* ------------------------------------------------- PDF file (with cache) */

async function cachePdf(id, blob) {
  await idb.set('pdf:' + id, blob);
  const meta = (await idb.get('pdfmeta')) || {};
  meta[id] = { size: blob.size, at: Date.now() };
  // Keep the cache under the limit by dropping the least recently opened PDFs.
  let total = Object.values(meta).reduce((s, m) => s + m.size, 0);
  for (const [oldId] of Object.entries(meta).sort((a, b) => a[1].at - b[1].at)) {
    if (total <= CACHE_LIMIT_BYTES || oldId === id) break;
    total -= meta[oldId].size;
    delete meta[oldId];
    await idb.del('pdf:' + oldId);
  }
  await idb.set('pdfmeta', meta);
}

async function forgetPdf(id) {
  await idb.del('pdf:' + id);
  const meta = (await idb.get('pdfmeta')) || {};
  delete meta[id];
  await idb.set('pdfmeta', meta);
}

export async function isPdfCached(id) {
  const meta = (await idb.get('pdfmeta')) || {};
  return !!meta[id];
}

export async function cachedPdfIds() {
  return new Set(Object.keys((await idb.get('pdfmeta')) || {}));
}

/** The PDF bytes: from this device if downloaded before, otherwise from the cloud. */
export async function getPdfBytes(doc, onProgress = () => {}) {
  const cached = await idb.get('pdf:' + doc.id);
  if (cached) {
    const meta = (await idb.get('pdfmeta')) || {};
    if (meta[doc.id]) {
      meta[doc.id].at = Date.now();
      idb.set('pdfmeta', meta);
    }
    return { bytes: new Uint8Array(await cached.arrayBuffer()), fromCache: true };
  }

  const url =
    doc.storage === 'r2'
      ? (await callStorage('download', { docId: doc.id })).url
      : (await run(sb.storage.from(BUCKET).createSignedUrl(`${doc.owner}/${doc.id}.pdf`, 600))).signedUrl;
  let res;
  try {
    res = await fetch(url);
  } catch (e) {
    throw wrap(e);
  }
  if (!res.ok) throw new BackendError(`Could not download the PDF (${res.status}).`, { status: res.status });

  const total = Number(res.headers.get('content-length')) || doc.size || 0;
  const reader = res.body.getReader();
  const chunks = [];
  let loaded = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    loaded += value.length;
    if (total) onProgress(Math.min(1, loaded / total));
  }
  const blob = new Blob(chunks, { type: 'application/pdf' });
  await cachePdf(doc.id, blob);
  return { bytes: new Uint8Array(await blob.arrayBuffer()), fromCache: false };
}

/* ------------------------------------------------------ syncing marks */

/** Send a batch of annotation changes. Returns how many were applied. */
export async function applyOps(docId, ops) {
  return run(sb.rpc('apply_annotation_ops', { p_doc: docId, p_ops: ops }));
}

/** Save "where I am" in a document. keepalive: true when the page is closing. */
export async function savePosition(docId, { page, offset, pageCount, device, clientId }, { keepalive = false } = {}) {
  const at = new Date().toISOString();
  const patch = { position: { page, offset, device, clientId, at }, last_opened_at: at };
  if (pageCount) patch.page_count = pageCount;

  if (keepalive) {
    if (!accessToken) return;
    // fetch with keepalive survives the tab being closed
    fetch(`${baseUrl}/rest/v1/documents?id=eq.${encodeURIComponent(docId)}`, {
      method: 'PATCH',
      keepalive: true,
      headers: {
        apikey: apiKey,
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        Prefer: 'return=minimal',
      },
      body: JSON.stringify(patch),
    }).catch(() => {});
    return;
  }
  await run(sb.from('documents').update(patch).eq('id', docId));
}

/* ------------------------------------------------------- live updates */

function channelName(prefix) {
  return `${prefix}-${newId(6)}`;
}

/** Calls onChange() whenever any of your documents changes. */
export function subscribeLibrary(onChange, onStatus = () => {}) {
  if (!sb) return () => {};
  const ch = sb
    .channel(channelName('library'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'documents' }, (payload) => onChange(payload))
    .subscribe((status) => onStatus(status));
  return () => sb.removeChannel(ch);
}

/**
 * Live updates for one open document.
 *   onAnnotation(row)  row = { id, data, deleted, updated_at }
 *   onDocument(doc)    name / position changed
 *   onDeleted()        the document was deleted on another device
 *   onStatus(status)   'SUBSCRIBED' | 'CHANNEL_ERROR' | 'TIMED_OUT' | 'CLOSED'
 */
export function subscribeDoc(docId, { onAnnotation, onDocument, onDeleted, onStatus = () => {} }) {
  if (!sb) return () => {};
  const ch = sb
    .channel(channelName('doc'))
    .on('postgres_changes', { event: '*', schema: 'public', table: 'annotations', filter: `doc_id=eq.${docId}` }, (p) => {
      if (p.eventType !== 'DELETE' && p.new) onAnnotation(p.new);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'documents', filter: `id=eq.${docId}` }, (p) => {
      if (p.new) onDocument(toDoc(p.new));
    })
    .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'documents' }, (p) => {
      if (p.old?.id === docId) onDeleted();
    })
    .subscribe((status) => onStatus(status));
  return () => sb.removeChannel(ch);
}

/* -------------------------------------------------------- service worker */

/** Shown in the ⋮ menu and the library, so you can check which version a device is running.
 *  Keep it equal to VERSION in sw.js ("pagesync-v" + this). */
export const APP_VERSION = '3.2.2';

/**
 * Offline support + safe updates.
 * A new version of the app installs in the background and then WAITS. It only takes over at a safe
 * moment — when a page that can simply reload (library, sign-in) asks it to — so an open PDF is never
 * cut off halfway through loading.
 *   autoUpdate:     this page may switch to a waiting new version (then reloads once)
 *   reloadOnChange: if another tab switches versions, should this page reload?
 */
export function registerServiceWorker({ autoUpdate = true, reloadOnChange = () => true } = {}) {
  if (!('serviceWorker' in navigator) || !isSecureContext) return;
  const sw = navigator.serviceWorker;
  const hadController = !!sw.controller;
  let reloading = false;
  sw.addEventListener('controllerchange', () => {
    if (!hadController || reloading || !reloadOnChange()) return;
    if (document.querySelector('.text-editor, .modal-backdrop')) return; // don't interrupt typing
    try {
      const last = Number(sessionStorage.getItem('ps_sw_reload') || 0);
      if (Date.now() - last < 15000) return; // never loop
      sessionStorage.setItem('ps_sw_reload', String(Date.now()));
    } catch {
      return;
    }
    reloading = true;
    location.reload();
  });
  const takeOver = (worker) => {
    if (autoUpdate && worker && sw.controller) worker.postMessage('skip-waiting');
  };
  const register = () =>
    sw
      .register('sw.js', { updateViaCache: 'none' })
      .then((reg) => {
        if (reg.waiting) takeOver(reg.waiting);
        reg.addEventListener('updatefound', () => {
          const w = reg.installing;
          w?.addEventListener('statechange', () => w.state === 'installed' && takeOver(w));
        });
        reg.update().catch(() => {});
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') reg.update().catch(() => {});
        });
      })
      .catch((e) => console.warn('Offline mode unavailable:', e));
  if (document.readyState === 'complete') register();
  else addEventListener('load', register);
}

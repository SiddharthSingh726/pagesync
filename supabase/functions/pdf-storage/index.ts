// @ts-nocheck  — plain JavaScript style; skip strict type checks on deploy.
// PageSync — "pdf-storage" Supabase Edge Function.
//
// Keeps big PDFs in S3-compatible storage: Backblaze B2 (no card needed), Cloudflare R2 or AWS S3.
// Browsers never see your storage keys: this function checks who is asking, enforces
// the per-file limit and each user's quota, then hands out short-lived signed links.
//
// Secrets to set (Supabase → Edge Functions → Secrets):
//   S3_ENDPOINT           Backblaze: https://s3.<region>.backblazeb2.com
//                         R2:        https://<account-id>.r2.cloudflarestorage.com
//                         AWS:       https://s3.<region>.amazonaws.com
//   S3_BUCKET             your bucket name
//   S3_ACCESS_KEY_ID      Backblaze keyID / R2 or AWS access key id
//   S3_SECRET_ACCESS_KEY  Backblaze applicationKey / R2 or AWS secret
// Optional:
//   S3_REGION             normally worked out from S3_ENDPOINT ("auto" for R2)
//   ADMIN_EMAILS          emails allowed to run the setup check fixes (UNLIMITED_EMAILS count too)
// AI "Explain" (optional):
//   AI_API_KEY            e.g. a free Google Gemini key from https://aistudio.google.com
//   AI_PROVIDER           gemini (default) | anthropic | groq | openai
//   AI_MODEL              override the model (defaults below)
//   AI_FALLBACK_MODELS    Gemini only: comma-separated models to try when the main one is busy
//                         (default gemini-3.5-flash,gemini-3.5-flash-lite,gemini-2.5-flash-lite)
//   AI_DAILY_LIMIT        explanations per person per day (default 50; UNLIMITED_EMAILS have none)
//   MAX_FILE_MB           largest PDF allowed (default 300)
//   USER_QUOTA_MB         storage per user (default 1024 = 1 GB)
//   UNLIMITED_EMAILS      comma-separated emails with no quota (e.g. yours)
// SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY are provided by Supabase.
//
// Written without dependencies, as plain JavaScript-compatible TypeScript.

const MB = 1024 * 1024;
const PART_SIZE = 10 * MB; // upload in 10 MB pieces (R2 needs equal-sized parts)
const DOC_ID = /^[A-Za-z0-9_-]{6,32}$/;
const enc = new TextEncoder();

/* ------------------------------------------------------------ settings */

function env(name, fallback = undefined) {
  // deno-lint-ignore no-explicit-any
  const g = globalThis as any;
  const v = g.Deno ? g.Deno.env.get(name) : g.process?.env?.[name];
  return v === undefined || v === '' ? fallback : v;
}

/** Accepts "s3.region.backblazeb2.com", "https://…/", quotes or spaces, and returns "https://host". */
export function normalizeEndpoint(raw) {
  let e = String(raw || '').trim().replace(/^['"]|['"]$/g, '').trim();
  if (!e) return '';
  if (!/^https?:\/\//i.test(e)) e = 'https://' + e;
  try {
    return new URL(e).origin;
  } catch {
    return '';
  }
}

function settings() {
  const endpoint = normalizeEndpoint(env('S3_ENDPOINT', ''));
  const b2 = /s3\.([a-z0-9-]+)\.backblazeb2\.com/i.exec(endpoint);
  const aws = /(?:^|\/\/)s3[.-]([a-z0-9-]+)\.amazonaws\.com/i.exec(endpoint);
  const awsGlobal = /\/\/s3\.amazonaws\.com/i.test(endpoint);
  const emails = (name) =>
    String(env(name, ''))
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean);
  return {
    supabaseUrl: (env('SUPABASE_URL', '') || '').replace(/\/+$/, ''),
    anonKey: env('SUPABASE_ANON_KEY') || env('SUPABASE_PUBLISHABLE_KEY') || env('SERVICE_ROLE_KEY') || env('SUPABASE_SERVICE_ROLE_KEY'),
    serviceKey: env('SUPABASE_SERVICE_ROLE_KEY') || env('SERVICE_ROLE_KEY') || env('SUPABASE_SECRET_KEY'),
    s3: {
      endpoint,
      bucket: env('S3_BUCKET', ''),
      region: env('S3_REGION') || (b2 ? b2[1] : aws ? aws[1] : awsGlobal ? 'us-east-1' : 'auto'),
      // AWS wants https://bucket.s3.region.amazonaws.com/key; B2 and R2 use https://endpoint/bucket/key
      virtualHost: env('S3_FORCE_PATH_STYLE') === 'true' ? false : !!(aws || awsGlobal),
      provider: b2 ? 'Backblaze B2' : aws || awsGlobal ? 'AWS S3' : /r2\.cloudflarestorage\.com/i.test(endpoint) ? 'Cloudflare R2' : 'S3-compatible storage',
      accessKeyId: env('S3_ACCESS_KEY_ID', ''),
      secretAccessKey: env('S3_SECRET_ACCESS_KEY', ''),
    },
    maxFileBytes: Number(env('MAX_FILE_MB', 300)) * MB,
    quotaBytes: Number(env('USER_QUOTA_MB', 1024)) * MB,
    unlimited: emails('UNLIMITED_EMAILS'),
    admins: [...emails('ADMIN_EMAILS'), ...emails('UNLIMITED_EMAILS')],
    ai: {
      provider: String(env('AI_PROVIDER', 'gemini')).trim().toLowerCase(),
      key: String(env('AI_API_KEY') || env('GEMINI_API_KEY') || '').trim(),
      model: String(env('AI_MODEL', '')).trim(),
      fallbacks: String(env('AI_FALLBACK_MODELS', 'gemini-3.5-flash,gemini-3.5-flash-lite,gemini-2.5-flash-lite'))
        .split(',')
        .map((m) => m.trim())
        .filter(Boolean),
      baseUrl: String(env('AI_BASE_URL', '')).trim().replace(/\/+$/, ''),
      dailyLimit: Math.max(1, Number(env('AI_DAILY_LIMIT', 50)) || 50),
    },
  };
}

const s3Ready = (s3) => !!(s3.endpoint && s3.bucket && s3.accessKeyId && s3.secretAccessKey);

/* ------------------------------------------- AWS Signature V4 (presigned) */

function hex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function sha256Hex(text) {
  return hex(await crypto.subtle.digest('SHA-256', enc.encode(text)));
}

async function hmac(key, message) {
  const raw = typeof key === 'string' ? enc.encode(key) : key;
  const k = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', k, enc.encode(message)));
}

/** RFC 3986 encoding as required by SigV4. */
function uriEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase());
}

/**
 * Build a presigned URL. Path-style (https://endpoint/bucket/key) unless virtualHost is set.
 */
export async function presign({
  method,
  key,
  s3,
  expires = 3600,
  query = {},
  date = new Date(),
  virtualHost = s3.virtualHost || false,
}) {
  const u = new URL(s3.endpoint);
  const host = virtualHost ? `${s3.bucket}.${u.host}` : u.host;
  const encodedKey = key ? key.split('/').map(uriEncode).join('/') : '';
  const path = virtualHost ? `/${encodedKey}` : `/${uriEncode(s3.bucket)}${key ? '/' + encodedKey : ''}`;
  const amzDate = date.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const day = amzDate.slice(0, 8);
  const scope = `${day}/${s3.region}/s3/aws4_request`;
  const params = {
    ...query,
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${s3.accessKeyId}/${scope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expires),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = Object.keys(params)
    .sort()
    .map((k) => `${uriEncode(k)}=${uriEncode(String(params[k]))}`)
    .join('&');
  const canonicalRequest = [method, path, canonicalQuery, `host:${host}\n`, 'host', 'UNSIGNED-PAYLOAD'].join('\n');
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, await sha256Hex(canonicalRequest)].join('\n');
  let k = await hmac('AWS4' + s3.secretAccessKey, day);
  k = await hmac(k, s3.region);
  k = await hmac(k, 's3');
  k = await hmac(k, 'aws4_request');
  const signature = hex(await hmac(k, stringToSign));
  return `${u.protocol}//${host}${path}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

/** Call the storage API from this function (signed the same way). */
async function s3Call(s3, method, key, { query = {}, body, headers = {} } = {}) {
  const url = await presign({ method, key, s3, expires: 300, query });
  const res = await fetch(url, { method, body, headers });
  const text = method === 'HEAD' ? '' : await res.text();
  if (!res.ok || /<Error>/.test(text)) {
    const code = /<Code>([^<]+)<\/Code>/.exec(text)?.[1] || res.status;
    const err = new Error(`Storage error (${code})`);
    // deno-lint-ignore no-explicit-any
    (err as any).status = res.status === 404 ? 404 : 502;
    throw err;
  }
  return { res, text };
}

const xmlAll = (xml, tag) => [...xml.matchAll(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`, 'g'))].map((m) => m[1]);
const xmlOne = (xml, tag) => xmlAll(xml, tag)[0];

/** MD5 as base64 (S3 requires a Content-MD5 header when changing CORS rules). */
export function md5Base64(text) {
  const bytes = enc.encode(text);
  const K = new Uint32Array(64).map((_, i) => Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32));
  const R = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const len = (((bytes.length + 8) >>> 6) + 1) * 64;
  const m = new Uint8Array(len);
  m.set(bytes);
  m[bytes.length] = 0x80;
  const view = new DataView(m.buffer);
  view.setUint32(len - 8, (bytes.length * 8) >>> 0, true);
  view.setUint32(len - 4, Math.floor(bytes.length / 0x20000000), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  for (let off = 0; off < len; off += 64) {
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) % 16; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) % 16; }
      else { f = c ^ (b | ~d); g = (7 * i) % 16; }
      const tmp = d;
      d = c;
      c = b;
      const x = (a + f + K[i] + view.getUint32(off + g * 4, true)) | 0;
      const r = R[(i >> 4) * 4 + (i % 4)];
      b = (b + ((x << r) | (x >>> (32 - r)))) | 0;
      a = tmp;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  [a0, b0, c0, d0].forEach((v, i) => ov.setUint32(i * 4, v >>> 0, true));
  let bin = '';
  for (const byte of out) bin += String.fromCharCode(byte);
  return btoa(bin);
}

/* ------------------------------------------------------------- Supabase */

function keyHeaders(key, bearer = null) {
  const h = { apikey: key };
  if (bearer) h['Authorization'] = `Bearer ${bearer}`;
  else if (!String(key).startsWith('sb_')) h['Authorization'] = `Bearer ${key}`; // legacy JWT keys
  return h;
}

async function getUser(cfg, req) {
  const token = (req.headers.get('authorization') || '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const res = await fetch(`${cfg.supabaseUrl}/auth/v1/user`, { headers: keyHeaders(cfg.anonKey, token) });
  if (!res.ok) return null;
  const user = await res.json();
  return user?.id ? user : null;
}

/** PostgREST request with the service key (bypasses row security — we check ownership ourselves). */
async function db(cfg, method, path, body = undefined, prefer = 'return=representation') {
  const headers = { ...keyHeaders(cfg.serviceKey), 'Content-Type': 'application/json' };
  if (prefer) headers['Prefer'] = prefer;
  const res = await fetch(`${cfg.supabaseUrl}/rest/v1/${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`Database error: ${text.slice(0, 200)}`);
    // deno-lint-ignore no-explicit-any
    (err as any).status = res.status === 409 ? 409 : 500;
    throw err;
  }
  return text ? JSON.parse(text) : null;
}

/* --------------------------------------------------------------- helpers */

class HttpError extends Error {
  status: number;
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, 'Content-Type': 'application/json' } });
}

function cleanName(raw) {
  const name = String(raw || '').replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim();
  return (name || 'Untitled.pdf').slice(0, 200);
}

const objectKey = (userId, docId) => `${userId}/${docId}.pdf`;

async function usedBytes(cfg, userId) {
  return Number(await db(cfg, 'POST', 'rpc/storage_used', { p_owner: userId }, '')) || 0;
}

function quotaFor(cfg, user) {
  return cfg.unlimited.includes(String(user.email || '').toLowerCase()) ? null : cfg.quotaBytes;
}

/* --------------------------------------------------------------- actions */

const isAdmin = (cfg, user) => cfg.admins.includes(String(user.email || '').toLowerCase());

async function limits(cfg, user) {
  return {
    cloudStorage: s3Ready(cfg.s3),
    provider: s3Ready(cfg.s3) ? cfg.s3.provider : null,
    isAdmin: isAdmin(cfg, user),
    maxFileBytes: cfg.maxFileBytes,
    quotaBytes: quotaFor(cfg, user),
    usedBytes: await usedBytes(cfg, user.id),
    aiEnabled: !!cfg.ai.key,
    aiDailyLimit: quotaFor(cfg, user) === null ? null : cfg.ai.dailyLimit,
  };
}

async function uploadStart(cfg, user, { docId, size, name }) {
  if (!s3Ready(cfg.s3)) throw new HttpError(501, 'Big-file storage is not set up on this PageSync yet.');
  size = Number(size);
  if (!DOC_ID.test(String(docId))) throw new HttpError(400, 'Bad document id');
  if (!Number.isFinite(size) || size <= 0) throw new HttpError(400, 'Bad file size');
  if (size > cfg.maxFileBytes) {
    throw new HttpError(413, `This PDF is ${Math.ceil(size / MB)} MB. The limit is ${Math.round(cfg.maxFileBytes / MB)} MB per file.`);
  }
  const quota = quotaFor(cfg, user);
  if (quota !== null) {
    const used = await usedBytes(cfg, user.id);
    if (used + size > quota) {
      const left = Math.max(0, quota - used);
      throw new HttpError(413, `Not enough space: you have ${(left / MB).toFixed(0)} MB left of your ${(quota / MB).toFixed(0)} MB.`);
    }
  }
  const existing = await db(cfg, 'GET', `documents?id=eq.${encodeURIComponent(docId)}&select=id`);
  if (existing.length) throw new HttpError(409, 'Document id already used');

  await db(cfg, 'POST', 'upload_reservations?on_conflict=doc_id', { doc_id: docId, owner: user.id, size, name: cleanName(name) }, 'resolution=merge-duplicates,return=minimal');
  const owned = await db(cfg, 'GET', `upload_reservations?doc_id=eq.${encodeURIComponent(docId)}&owner=eq.${user.id}&select=doc_id`);
  if (!owned.length) throw new HttpError(409, 'Document id already used');

  const key = objectKey(user.id, docId);
  const { text } = await s3Call(cfg.s3, 'POST', key, { query: { uploads: '' } });
  const uploadId = xmlOne(text, 'UploadId');
  if (!uploadId) throw new HttpError(502, 'Storage did not start the upload');
  await db(cfg, 'PATCH', `upload_reservations?doc_id=eq.${encodeURIComponent(docId)}`, { upload_id: uploadId }, 'return=minimal');

  const count = Math.max(1, Math.ceil(size / PART_SIZE));
  const urls = [];
  for (let n = 1; n <= count; n++) {
    urls.push(await presign({ method: 'PUT', key, s3: cfg.s3, expires: 6 * 3600, query: { partNumber: String(n), uploadId } }));
  }
  return { uploadId, partSize: PART_SIZE, urls };
}

async function reservationFor(cfg, user, docId, uploadId) {
  const rows = await db(cfg, 'GET', `upload_reservations?doc_id=eq.${encodeURIComponent(String(docId))}&owner=eq.${user.id}&select=*`);
  const r = rows[0];
  if (!r || (uploadId && r.upload_id !== uploadId)) throw new HttpError(404, 'Upload not found (it may have expired). Please try again.');
  return r;
}

async function uploadComplete(cfg, user, { docId, uploadId }) {
  const r = await reservationFor(cfg, user, docId, uploadId);
  const key = objectKey(user.id, docId);

  // Ask storage which pieces arrived (so the browser never needs to read ETags).
  const { text } = await s3Call(cfg.s3, 'GET', key, { query: { uploadId, 'max-parts': '10000' } });
  const parts = xmlAll(text, 'Part')
    .map((p) => ({ n: Number(xmlOne(p, 'PartNumber')), etag: xmlOne(p, 'ETag'), size: Number(xmlOne(p, 'Size')) }))
    .sort((a, b) => a.n - b.n);
  const expected = Math.max(1, Math.ceil(r.size / PART_SIZE));
  const total = parts.reduce((s, p) => s + p.size, 0);
  if (parts.length !== expected || total !== Number(r.size)) {
    throw new HttpError(409, `Upload incomplete (${parts.length}/${expected} pieces). Please try again.`);
  }

  const xml =
    '<CompleteMultipartUpload>' +
    parts.map((p) => `<Part><PartNumber>${p.n}</PartNumber><ETag>${p.etag}</ETag></Part>`).join('') +
    '</CompleteMultipartUpload>';
  await s3Call(cfg.s3, 'POST', key, { query: { uploadId }, body: xml });

  const head = await s3Call(cfg.s3, 'HEAD', key);
  const size = Number(head.res.headers.get('content-length')) || total;
  if (size > cfg.maxFileBytes) {
    await s3Call(cfg.s3, 'DELETE', key).catch(() => {});
    await db(cfg, 'DELETE', `upload_reservations?doc_id=eq.${encodeURIComponent(docId)}`, undefined, 'return=minimal');
    throw new HttpError(413, 'File is larger than allowed.');
  }

  const rows = await db(cfg, 'POST', 'documents', { id: docId, owner: user.id, name: cleanName(r.name), size, storage: 'r2' });
  await db(cfg, 'DELETE', `upload_reservations?doc_id=eq.${encodeURIComponent(docId)}`, undefined, 'return=minimal');
  return { document: rows[0] };
}

async function uploadAbort(cfg, user, { docId, uploadId }) {
  const r = await reservationFor(cfg, user, docId, null).catch(() => null);
  if (!r) return { ok: true };
  if (r.upload_id) await s3Call(cfg.s3, 'DELETE', objectKey(user.id, docId), { query: { uploadId: r.upload_id } }).catch(() => {});
  await db(cfg, 'DELETE', `upload_reservations?doc_id=eq.${encodeURIComponent(String(docId))}&owner=eq.${user.id}`, undefined, 'return=minimal');
  return { ok: true, uploadId };
}

async function download(cfg, user, { docId }) {
  const rows = await db(cfg, 'GET', `documents?id=eq.${encodeURIComponent(String(docId))}&owner=eq.${user.id}&select=id,storage`);
  if (!rows.length) throw new HttpError(404, 'Document not found');
  if (rows[0].storage !== 'r2') throw new HttpError(400, 'This document is stored in Supabase Storage');
  return { url: await presign({ method: 'GET', key: objectKey(user.id, docId), s3: cfg.s3, expires: 3600 }) };
}

async function remove(cfg, user, { docId }) {
  if (!DOC_ID.test(String(docId))) throw new HttpError(400, 'Bad document id');
  const rows = await db(cfg, 'GET', `documents?id=eq.${encodeURIComponent(docId)}&owner=eq.${user.id}&select=id,storage`);
  if (rows[0]?.storage === 'r2' && s3Ready(cfg.s3)) {
    await s3Call(cfg.s3, 'DELETE', objectKey(user.id, docId)).catch((e) => {
      if (e.status !== 404) throw e;
    });
  }
  await db(cfg, 'DELETE', `documents?id=eq.${encodeURIComponent(docId)}&owner=eq.${user.id}`, undefined, 'return=minimal');
  return { ok: true };
}

/* ------------------------------------------------------- AI "Explain" */

const LANGUAGES = {
  english: 'English',
  simple: 'very simple English (short sentences, everyday words)',
  hindi: 'Hindi in Devanagari script, keeping technical terms in English in brackets',
  hinglish: 'Hinglish (Hindi written in Latin letters, naturally mixing in English words)',
};

const clip = (v, n) => String(v || '').replace(/\s+/g, ' ').trim().slice(0, n);

export function buildPrompt({ text, sentence, context, docName, mode, language, previous }) {
  const lang = LANGUAGES[language] || LANGUAGES.english;
  const system =
    'You are a patient tutor helping a student understand the PDF they are reading. ' +
    'Be accurate and clear. Base your answer on the given text; if it is not enough, give the most likely meaning and say so briefly. ' +
    `No greetings or closing remarks. Write in ${lang}. Use **bold** only for the labels in the format. Keep the whole answer under 140 words.`;
  const doc = docName ? `Document: "${docName}"\n` : '';
  if (mode === 'simpler') {
    return {
      system,
      prompt:
        `${doc}Original text: "${text}"\n\nA student still found this explanation hard:\n"${previous}"\n\n` +
        'Explain it again much more simply, as if to a 12-year-old: 2–4 very short sentences, everyday words, and one small analogy if it helps. No labels.',
    };
  }
  if (mode === 'word') {
    const kind = /\s/.test(text) ? 'phrase' : 'word';
    return {
      system,
      prompt:
        `${doc}Sentence: "${sentence || text}"\n` +
        (context ? `Nearby text: "${context}"\n` : '') +
        `\nExplain the ${kind} "${text}" as it is used in that sentence.\n\nFormat exactly:\n` +
        '**Meaning here:** 1–2 sentences on what it means in this sentence.\n' +
        '**Simple definition:** a short everyday definition.\n' +
        '**Example:** one short new example sentence.\n' +
        'If it has a quite different common meaning, add **Also means:** in one line.',
    };
  }
  return {
    system,
    prompt:
      `${doc}` +
      (context ? `Nearby text: "${context}"\n` : '') +
      `\nExplain this passage: "${text}"\n\nFormat exactly:\n` +
      '**In simple words:** 2–4 plain sentences saying what it means.\n' +
      '**Key terms:** up to 4 lines, each "- term: meaning", for the hardest words (leave out if there are none).\n' +
      '**Why it matters here:** one sentence linking it to the nearby text.',
  };
}

/** Ask the configured AI provider. Returns plain text. */
export async function callAI(ai, system, prompt, fetchImpl = fetch) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 45000);
  const post = async (url, headers, body) => {
    let res;
    try {
      res = await fetchImpl(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body), signal: controller.signal });
    } catch (e) {
      throw new HttpError(504, e?.name === 'AbortError' ? 'The AI took too long to answer. Please try again.' : 'Could not reach the AI service.');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const msg = data?.error?.message || data?.error?.type || data?.message || `status ${res.status}`;
      const busy = res.status === 429 || res.status === 500 || res.status === 503 || res.status === 529 || /overload|high demand|unavailable/i.test(msg);
      if (busy) throw Object.assign(new HttpError(res.status === 429 ? 429 : 503, 'The free AI service is busy right now. Please try again in a minute.'), { retryable: true });
      if (res.status === 401 || res.status === 403) throw new HttpError(502, `The AI service rejected the key (${msg}). Check the AI_API_KEY secret.`);
      if (res.status === 404 || (res.status === 400 && /model/i.test(msg) && /not (found|supported|available)|no longer/i.test(msg)))
        throw Object.assign(new HttpError(502, `The AI model wasn't found (${msg}). Check the AI_MODEL secret.`), { missingModel: true });
      throw new HttpError(502, `AI service error: ${msg}`);
    }
    return data;
  };
  try {
    const p = ai.provider;
    if (p === 'anthropic' || p === 'claude') {
      const data = await post(`${ai.baseUrl || 'https://api.anthropic.com'}/v1/messages`, { 'x-api-key': ai.key, 'anthropic-version': '2023-06-01' }, {
        model: ai.model || 'claude-haiku-5-5',
        max_tokens: 800,
        system,
        messages: [{ role: 'user', content: prompt }],
      });
      return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    }
    if (p === 'groq' || p === 'openai' || p === 'openai-compatible') {
      const base = ai.baseUrl || (p === 'groq' ? 'https://api.groq.com/openai/v1' : 'https://api.openai.com/v1');
      const data = await post(`${base}/chat/completions`, { Authorization: `Bearer ${ai.key}` }, {
        model: ai.model || (p === 'groq' ? 'llama-3.3-70b-versatile' : 'gpt-4o-mini'),
        temperature: 0.3,
        max_tokens: 800,
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
      });
      return String(data.choices?.[0]?.message?.content || '').trim();
    }
    // default: Google Gemini. If the main model is busy (or retired), quietly try the fallbacks.
    const models = [...new Set([ai.model || 'gemini-3.8-flash', ...(ai.fallbacks || [])])];
    let firstErr = null;
    for (let i = 0; i < models.length; i++) {
      let data;
      try {
        data = await post(`${ai.baseUrl || 'https://generativelanguage.googleapis.com/v1beta'}/models/${encodeURIComponent(models[i])}:generateContent`, { 'x-goog-api-key': ai.key }, {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.3, maxOutputTokens: 8192 },
        });
      } catch (e) {
        if (!(e?.retryable || e?.missingModel) || controller.signal.aborted) throw e;
        if (!firstErr || (firstErr.missingModel && e.retryable)) firstErr = e;
        continue;
      }
      const cand = data.candidates?.[0];
      const out = (cand?.content?.parts || []).map((x) => x.text || '').join('').trim();
      if (!out && (cand?.finishReason === 'SAFETY' || data.promptFeedback?.blockReason)) throw new HttpError(422, "The AI declined to explain this text. Try selecting a different part.");
      return out;
    }
    throw firstErr || new HttpError(502, 'AI service error.');
  } finally {
    clearTimeout(timer);
  }
}

async function explain(cfg, user, body) {
  if (!cfg.ai.key) throw new HttpError(501, 'Explain is not set up yet. The owner needs to add an AI_API_KEY secret to the pdf-storage function (see the setup guide).');
  const text = clip(body.text, 1500);
  if (!text) throw new HttpError(400, 'Select some text to explain.');
  const mode = ['word', 'passage', 'simpler'].includes(body.mode) ? body.mode : text.split(' ').length <= 4 ? 'word' : 'passage';
  const args = {
    text,
    mode,
    sentence: clip(body.sentence, 800),
    context: clip(body.context, 2500),
    docName: clip(body.docName, 200),
    language: LANGUAGES[body.language] ? body.language : 'english',
    previous: clip(body.previous, 1500),
  };
  let remaining = null;
  if (quotaFor(cfg, user) !== null) {
    const n = Number(await db(cfg, 'POST', 'rpc/bump_ai_usage', { p_owner: user.id, p_limit: cfg.ai.dailyLimit }, ''));
    if (n === -1) throw new HttpError(429, `You've used all ${cfg.ai.dailyLimit} explanations for today. They reset every day at midnight UTC (5:30 AM in India).`);
    remaining = Math.max(0, cfg.ai.dailyLimit - n);
  }
  const { system, prompt } = buildPrompt(args);
  const explanation = await callAI(cfg.ai, system, prompt);
  if (!explanation) throw new HttpError(502, 'The AI returned an empty answer. Please try again.');
  return { explanation, mode, remaining, dailyLimit: remaining === null ? null : cfg.ai.dailyLimit };
}

/* ---------------------------------------------- setup check (check.html) */

const SELFTEST_KEY = (userId) => `${userId}/_pagesync_selftest.txt`;

/** Signed links so the browser can test an upload and download, plus the current CORS rules. */
async function selftest(cfg, user) {
  if (!s3Ready(cfg.s3)) {
    const missing = ['S3_ENDPOINT', 'S3_BUCKET', 'S3_ACCESS_KEY_ID', 'S3_SECRET_ACCESS_KEY'].filter((n) => !env(n));
    throw new HttpError(501, `Missing function secrets: ${missing.join(', ')}`);
  }
  const key = SELFTEST_KEY(user.id);
  // 1) can this function reach the bucket with these keys?
  try {
    const { text } = await s3Call(cfg.s3, 'POST', key, { query: { uploads: '' } });
    const uploadId = xmlOne(text, 'UploadId');
    if (uploadId) await s3Call(cfg.s3, 'DELETE', key, { query: { uploadId } }).catch(() => {});
  } catch (e) {
    throw new HttpError(502, `The function can't use your bucket (${e.message}). Check S3_ENDPOINT, S3_BUCKET and the two keys.`);
  }
  // 2) current CORS rules (may be unreadable with a restricted key — that's fine)
  let cors = null;
  try {
    const { text } = await s3Call(cfg.s3, 'GET', '', { query: { cors: '' } });
    cors = xmlAll(text, 'CORSRule').map((r) => ({ origins: xmlAll(r, 'AllowedOrigin'), methods: xmlAll(r, 'AllowedMethod') }));
  } catch (e) {
    cors = e.status === 404 ? [] : null;
  }
  return {
    provider: cfg.s3.provider,
    bucket: cfg.s3.bucket,
    region: cfg.s3.region,
    isAdmin: isAdmin(cfg, user),
    cors,
    putUrl: await presign({ method: 'PUT', key, s3: cfg.s3, expires: 600 }),
    getUrl: await presign({ method: 'GET', key, s3: cfg.s3, expires: 600 }),
  };
}

async function selftestCleanup(cfg, user) {
  if (s3Ready(cfg.s3)) await s3Call(cfg.s3, 'DELETE', SELFTEST_KEY(user.id)).catch(() => {});
  return { ok: true };
}

/** Let the website upload/download straight to the bucket (admins only). */
async function fixCors(cfg, user, { origins = [] }, req) {
  if (!isAdmin(cfg, user)) throw new HttpError(403, 'Only the owner can change storage settings. Add your email to the UNLIMITED_EMAILS or ADMIN_EMAILS secret.');
  const list = [...new Set([req.headers.get('origin'), ...origins, 'http://localhost:5173'].filter((o) => /^https?:\/\/[^/\s]+$/.test(String(o))))];
  const esc = (t) => String(t).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const xml =
    '<CORSConfiguration><CORSRule>' +
    list.map((o) => `<AllowedOrigin>${esc(o)}</AllowedOrigin>`).join('') +
    '<AllowedMethod>GET</AllowedMethod><AllowedMethod>PUT</AllowedMethod><AllowedMethod>HEAD</AllowedMethod>' +
    '<AllowedHeader>*</AllowedHeader><ExposeHeader>ETag</ExposeHeader><ExposeHeader>Content-Length</ExposeHeader>' +
    '<MaxAgeSeconds>3600</MaxAgeSeconds></CORSRule></CORSConfiguration>';
  try {
    await s3Call(cfg.s3, 'PUT', '', { query: { cors: '' }, body: xml, headers: { 'Content-MD5': md5Base64(xml), 'Content-Type': 'application/xml' } });
  } catch (e) {
    throw new HttpError(502, `Couldn't change the bucket's CORS rules automatically (${e.message}). Your key may not be allowed to change bucket settings. Set them by hand as shown in the README.`);
  }
  return { ok: true, origins: list };
}

const ACTIONS = {
  explain,
  selftest,
  'selftest-cleanup': selftestCleanup,
  'fix-cors': fixCors,
  limits,
  'upload-start': uploadStart,
  'upload-complete': uploadComplete,
  'upload-abort': uploadAbort,
  download,
  delete: remove,
};

/* --------------------------------------------------------------- server */

export async function handler(req) {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json(405, { error: 'Use POST' });
  const cfg = settings();
  try {
    if (!cfg.supabaseUrl || !cfg.serviceKey) throw new HttpError(500, 'Function is missing SUPABASE_URL / service key');
    const user = await getUser(cfg, req);
    if (!user) throw new HttpError(401, 'Please sign in again.');
    const body = await req.json().catch(() => ({}));
    const action = ACTIONS[body.action];
    if (!action) throw new HttpError(400, 'Unknown action');
    return json(200, await action(cfg, user, body, req));
  } catch (err) {
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    return json(status, { error: err.message || 'Server error' });
  }
}

// deno-lint-ignore no-explicit-any
if ((globalThis as any).Deno?.serve) (globalThis as any).Deno.serve(handler);

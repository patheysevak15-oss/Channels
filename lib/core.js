// SevakTV's server logic, shared by the home server (server.js) and the
// Vercel function (api/sevak.js): the stream relay, stream check, device
// MACs, online subtitles and the optional access password.
'use strict';

const crypto = require('crypto');
const { Readable } = require('stream');

const DEFAULT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const ON_VERCEL = !!process.env.VERCEL;
// On Vercel each request must finish quickly, so open-ended video downloads
// are answered in pieces of this size; the player asks for the next piece.
const VERCEL_CHUNK = Number(process.env.SEVAK_CHUNK_BYTES) || 8 * 1024 * 1024;

/* ---------------------------------------------------------------- helpers */

function cors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Final-Url');
}
function sendJson(res, status, obj, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(obj));
}
function readCookie(req, name) {
  const m = (req.headers.cookie || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
}
function readJson(req) {
  // Vercel has already read the body; at home it is read from the stream.
  if (ON_VERCEL && req.body !== undefined) {
    const b = req.body;
    if (b && typeof b === 'object' && !Buffer.isBuffer(b)) return Promise.resolve(b);
    try { return Promise.resolve(b ? JSON.parse(String(b)) : {}); } catch { return Promise.reject(new Error('bad json')); }
  }
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size > 50000) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new Error('bad json')); } });
    req.on('error', reject);
  });
}
const isHttps = (req) => (req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
const cookie = (req, name, value, maxAge) =>
  `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax; HttpOnly${isHttps(req) ? '; Secure' : ''}`;

/* ------------------------------------------------------------ the relay */

function proxied(absUrl, ua, ref, h) {
  let q = '/proxy?url=' + encodeURIComponent(absUrl);
  if (ua) q += '&ua=' + encodeURIComponent(ua);
  if (ref) q += '&ref=' + encodeURIComponent(ref);
  if (h) q += '&h=' + encodeURIComponent(h);
  return q;
}

// Extra headers a Stalker/MAG portal expects. Only these names are forwarded.
const EXTRA_HEADERS = new Set(['cookie', 'authorization', 'x-user-agent']);
function extraHeaders(h) {
  const out = {};
  if (!h) return out;
  try {
    const obj = JSON.parse(Buffer.from(h, 'base64url').toString('utf8'));
    for (const [k, v] of Object.entries(obj)) {
      if (EXTRA_HEADERS.has(k.toLowerCase()) && typeof v === 'string' && !/[\r\n]/.test(v)) out[k] = v;
    }
  } catch {}
  return out;
}
function upstreamHeaders(params) {
  const ua = params.get('ua') || '', ref = params.get('ref') || '';
  const headers = { 'User-Agent': ua || DEFAULT_UA, Accept: '*/*', ...extraHeaders(params.get('h') || '') };
  if (ref) {
    headers.Referer = ref;
    try { headers.Origin = new URL(ref).origin; } catch {}
  }
  return headers;
}

// Rewrites every URI inside an HLS playlist so segments, keys and variant
// playlists also go through the relay.
function rewriteHls(text, baseUrl, ua, ref, h) {
  const abs = (u) => { try { return new URL(u, baseUrl).href; } catch { return u; } };
  return text.split(/\r?\n/).map((line) => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (_, u) => `URI="${proxied(abs(u), ua, ref, h)}"`);
    return proxied(abs(t), ua, ref, h);
  }).join('\n');
}
function looksLikeHls(contentType, url) {
  if ((contentType || '').toLowerCase().includes('mpegurl')) return true;
  try { return /\.m3u8?$/i.test(new URL(url).pathname); } catch { return false; }
}

async function handleProxy(req, res, params) {
  let parsed;
  try { parsed = new URL(params.get('url')); } catch { parsed = null; }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    res.writeHead(400, { 'Content-Type': 'text/plain' }).end('Give a full http:// or https:// address in ?url=');
    return;
  }
  const ua = params.get('ua') || '', ref = params.get('ref') || '', h = params.get('h') || '';
  const raw = params.get('raw') === '1'; // raw=1: never rewrite (channel lists)
  const headers = upstreamHeaders(params);
  if (req.headers.range) {
    headers.Range = req.headers.range;
    const open = ON_VERCEL && req.headers.range.match(/^bytes=(\d+)-$/);
    if (open) headers.Range = `bytes=${open[1]}-${Number(open[1]) + VERCEL_CHUNK - 1}`;
  }

  // Stop fetching if the viewer goes away (the response closes before it finished).
  const ac = new AbortController();
  res.on('close', () => { if (!res.writableFinished) ac.abort(); });
  let upstream;
  try {
    upstream = await fetch(parsed.href, { headers, redirect: 'follow', signal: ac.signal });
  } catch (e) {
    if (ac.signal.aborted) return;
    res.writeHead(502, { 'Content-Type': 'text/plain' }).end('Could not reach ' + parsed.host + ': ' + (e.cause?.code || e.message));
    return;
  }
  const finalUrl = upstream.url || parsed.href;
  res.setHeader('X-Final-Url', encodeURI(finalUrl)); // lets the app see where a portal address redirected
  const ctype = upstream.headers.get('content-type') || '';

  if (!raw && upstream.ok && looksLikeHls(ctype, finalUrl)) {
    const text = await upstream.text();
    if (text.trimStart().startsWith('#EXTM3U')) {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' });
      res.end(rewriteHls(text, finalUrl, ua, ref, h));
      return;
    }
    res.writeHead(upstream.status, { 'Content-Type': ctype || 'text/plain' }).end(text);
    return;
  }

  const out = {};
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
    const v = upstream.headers.get(k);
    if (v) out[k] = v;
  }
  if (upstream.headers.get('content-encoding')) delete out['content-length']; // fetch() already decompressed it
  res.writeHead(upstream.status, out);
  if (!upstream.body || req.method === 'HEAD') return res.end();
  const stream = Readable.fromWeb(upstream.body);
  stream.on('error', () => res.destroy());
  stream.pipe(res);
}

/* ---------------------------------------------------------- stream check */

const TS_TYPES = {
  0x01: 'mpeg1-video', 0x02: 'mpeg2-video', 0x1b: 'h264', 0x24: 'hevc', 0x0f: 'aac', 0x11: 'aac-latm',
  0x03: 'mpeg-audio', 0x04: 'mpeg-audio', 0x81: 'ac-3', 0x87: 'e-ac-3',
};

// Reads the program map of an MPEG-TS stream to find its video/audio codecs.
function tsCodecs(buf) {
  let start = buf.indexOf(0x47);
  while (start >= 0 && start + 188 * 2 < buf.length && buf[start + 188] !== 0x47) start = buf.indexOf(0x47, start + 1);
  if (start < 0) return null;
  const pkts = [];
  for (let i = start; i + 188 <= buf.length; i += 188) if (buf[i] === 0x47) pkts.push(buf.subarray(i, i + 188));
  const payload = (p) => {
    const afc = (p[3] >> 4) & 3;
    let off = 4;
    if (afc === 2) return null;
    if (afc === 3) off += 1 + p[4];
    return off < 188 ? p.subarray(off) : null;
  };
  const pid = (p) => ((p[1] & 0x1f) << 8) | p[2];
  const pusi = (p) => (p[1] & 0x40) !== 0;
  let pmtPid = null;
  for (const p of pkts) {
    if (pid(p) !== 0 || !pusi(p)) continue;
    const pl = payload(p); if (!pl) continue;
    const t = pl.subarray(1 + pl[0]);
    const len = ((t[1] & 0x0f) << 8) | t[2];
    for (let i = 8; i + 4 <= 3 + len - 4; i += 4) {
      const prog = (t[i] << 8) | t[i + 1];
      if (prog !== 0) { pmtPid = ((t[i + 2] & 0x1f) << 8) | t[i + 3]; break; }
    }
    if (pmtPid != null) break;
  }
  if (pmtPid == null) return null;
  for (const p of pkts) {
    if (pid(p) !== pmtPid || !pusi(p)) continue;
    const pl = payload(p); if (!pl) continue;
    const t = pl.subarray(1 + pl[0]);
    const len = ((t[1] & 0x0f) << 8) | t[2];
    const end = Math.min(t.length, 3 + len - 4);
    let i = 12 + (((t[10] & 0x0f) << 8) | t[11]);
    const out = { video: [], audio: [] };
    while (i + 5 <= end) {
      const type = t[i];
      const esLen = ((t[i + 3] & 0x0f) << 8) | t[i + 4];
      let name = TS_TYPES[type];
      if (type === 0x06) {
        for (let d = i + 5; d + 2 <= i + 5 + esLen; d += 2 + t[d + 1]) {
          if (t[d] === 0x6a) name = 'ac-3';
          if (t[d] === 0x7a) name = 'e-ac-3';
        }
      }
      if (name) (/video|h264|hevc/.test(name) ? out.video : out.audio).push(name);
      i += 5 + esLen;
    }
    return out;
  }
  return null;
}

async function peek(url, headers, limit = 262144) {
  const r = await fetch(url, { headers: { ...headers, Range: 'bytes=0-' + (limit - 1) }, redirect: 'follow', signal: AbortSignal.timeout(12000) });
  const chunks = [];
  let size = 0;
  if (r.body) {
    const reader = r.body.getReader();
    try {
      while (size < limit) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value); size += value.length;
      }
    } catch (e) {
      if (!size) throw e; // keep what arrived if the connection broke midway
    }
    try { await reader.cancel(); } catch {}
  }
  return { status: r.status, type: r.headers.get('content-type') || '', url: r.url || url, buf: Buffer.concat(chunks.map((c) => Buffer.from(c))) };
}

function sniff(buf, type) {
  const head = buf.subarray(0, 512).toString('utf8');
  if (head.trimStart().startsWith('#EXTM3U')) return 'hls';
  if (buf[0] === 0x47 && (buf.length < 189 || buf[188] === 0x47)) return 'ts';
  if (buf.subarray(4, 8).toString('latin1') === 'ftyp') return 'mp4';
  if (buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'mkv';
  if (/^\s*<(!doctype|html|head|body)/i.test(head) || /text\/html/i.test(type)) return 'html';
  if (/^[\x09\x0a\x0d\x20-\x7e -￿]*$/.test(head.slice(0, 200))) return 'text';
  return 'other';
}

async function handleDiagnose(req, res, params) {
  let target;
  try { target = new URL(params.get('url')); } catch {}
  if (!target || !/^https?:$/.test(target.protocol)) return sendJson(res, 400, { error: 'Give a full address in ?url=' });
  const headers = upstreamHeaders(params);
  const out = { status: 0 };
  try {
    let r = await peek(target.href, headers);
    out.status = r.status;
    out.kind = sniff(r.buf, r.type);
    if (out.kind === 'html' || out.kind === 'text') out.text = r.buf.subarray(0, 400).toString('utf8').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
    // Follow an HLS playlist down to its first segment to see the codecs.
    for (let depth = 0; out.kind === 'hls' && depth < 3; depth++) {
      const text = r.buf.toString('utf8');
      const m = text.match(/#EXT-X-STREAM-INF:[^\n]*CODECS="([^"]+)"/);
      if (m && !out.declared) out.declared = m[1];
      const next = text.split(/\r?\n/).map((l) => l.trim()).find((l) => l && !l.startsWith('#'));
      if (!next) break;
      try { r = await peek(new URL(next, r.url).href, headers); } catch (e) { out.segmentError = e.cause?.code || e.message; break; }
      out.segmentStatus = r.status;
      const k = sniff(r.buf, r.type);
      if (k !== 'hls') { out.segment = k; if (k === 'ts') out.codecs = tsCodecs(r.buf); break; }
    }
    if (out.kind === 'ts') out.codecs = tsCodecs(r.buf);
  } catch (e) {
    out.error = e.cause?.code || e.name || e.message;
  }
  return sendJson(res, 200, out);
}

/* ------------------------------------------------------------- devices */
// Each device (phone, TV, laptop) gets its own MAC address for Stalker portals.

const ANY_MAC_RE = /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/;
const DEVICE_COOKIE = 'sevak_device';

function normMac(v) {
  const hex = String(v || '').replace(/[^0-9a-f]/gi, '').toUpperCase();
  return hex.length === 12 ? hex.match(/.{2}/g).join(':') : null;
}
function newMac(devices) {
  for (;;) {
    const mac = '00:1A:79:' + [...crypto.randomBytes(3)].map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
    if (!devices.some((d) => d.mac === mac)) return mac;
  }
}
function guessName(ua, devices) {
  ua = ua || '';
  const base =
    /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /AFT\w+|Fire TV/i.test(ua) ? 'Fire TV' :
    /Tizen|SMART-TV.*Samsung/i.test(ua) ? 'Samsung TV' : /Web0S|webOS/i.test(ua) ? 'LG TV' :
    /Android TV|BRAVIA|GoogleTV|SmartTV|SMART-TV/i.test(ua) ? 'TV' : /Android/.test(ua) ? 'Android' :
    /Macintosh/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : /CrOS/.test(ua) ? 'Chromebook' : /Linux/.test(ua) ? 'Linux' : 'Device';
  let name = base, n = 2;
  while (devices.some((d) => d.name === name)) name = `${base} ${n++}`;
  return name;
}

async function handleDevices(req, res, pathname, store) {
  const body = req.method === 'POST' ? await readJson(req).catch(() => null) : {};
  if (body === null) return sendJson(res, 400, { error: 'The request was not valid.' });
  const devices = await store.listDevices();
  const withWatching = async (list) => {
    const vals = await store.getTemp(list.map((d) => 'watch:' + d.id));
    return list.map((d, i) => ({ id: d.id, name: d.name, mac: d.mac, createdAt: d.createdAt, lastSeen: d.lastSeen, watching: vals[i] || null }));
  };
  const one = async (d) => (await withWatching([d]))[0];

  // Called by every browser on start: returns this device, creating it if new.
  if (pathname === '/api/device/register' && req.method === 'POST') {
    const id = (typeof body.id === 'string' && body.id) || readCookie(req, DEVICE_COOKIE);
    let dev = id && devices.find((d) => d.id === id);
    if (!dev) {
      const preferred = normMac(body.preferredMac);
      dev = {
        id: crypto.randomUUID(),
        name: guessName(req.headers['user-agent'], devices),
        mac: preferred && !devices.some((d) => d.mac === preferred) ? preferred : newMac(devices),
        createdAt: new Date().toISOString(),
      };
    }
    dev.lastSeen = new Date().toISOString();
    await store.putDevice(dev);
    return sendJson(res, 200, await one(dev), { 'Set-Cookie': cookie(req, DEVICE_COOKIE, dev.id, 315360000) });
  }

  // Tells the server what a device is playing, so the Devices list can show it.
  if (pathname === '/api/device/ping' && req.method === 'POST') {
    const dev = devices.find((d) => d.id === body.id);
    if (!dev) return sendJson(res, 404, { error: 'Unknown device.' });
    await store.setTemp('watch:' + dev.id, body.watching ? String(body.watching).slice(0, 120) : null, 75);
    return sendJson(res, 200, { ok: true });
  }

  if (pathname === '/api/devices' && req.method === 'GET') {
    return sendJson(res, 200, { devices: await withWatching(devices) });
  }

  const m = pathname.match(/^\/api\/devices\/([\w-]+)(\/new-mac)?$/);
  const dev = m && devices.find((d) => d.id === m[1]);
  if (m && !dev) return sendJson(res, 404, { error: 'That device no longer exists.' });

  if (m && m[2] && req.method === 'POST') {
    dev.mac = newMac(devices);
    await store.putDevice(dev);
    return sendJson(res, 200, await one(dev));
  }
  if (m && req.method === 'POST') {
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 40);
      if (!name) return sendJson(res, 400, { error: 'Give the device a name.' });
      dev.name = name;
    }
    if (body.mac !== undefined) {
      const mac = normMac(body.mac);
      if (!mac || !ANY_MAC_RE.test(mac)) return sendJson(res, 400, { error: 'A MAC address looks like 00:1A:79:12:34:56.' });
      if (devices.some((d) => d.mac === mac && d.id !== dev.id)) return sendJson(res, 409, { error: 'Another device already uses that MAC address.' });
      dev.mac = mac;
    }
    await store.putDevice(dev);
    return sendJson(res, 200, await one(dev));
  }
  if (m && req.method === 'DELETE') {
    await store.deleteDevice(dev.id);
    await store.setTemp('watch:' + dev.id, null, 1);
    return sendJson(res, 200, { ok: true });
  }
  return sendJson(res, 404, { error: 'Not found.' });
}

/* ------------------------------------------------------ online subtitles */

const OS_API = process.env.OPENSUBTITLES_API || 'https://api.opensubtitles.com/api/v1';
const OS_UA = 'SevakTV v1.0';

async function osRequest(cfg, method, pathAndQuery, body, base = OS_API, token) {
  const headers = { 'Api-Key': cfg.apiKey, 'User-Agent': OS_UA, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  let r;
  try {
    r = await fetch(base + pathAndQuery, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw Object.assign(new Error('Couldn’t reach OpenSubtitles (' + (e.cause?.code || e.name) + ').'), { status: 502 });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data.message || data.errors?.join(' ') || 'OpenSubtitles answered with an error';
    const hint = r.status === 401 || r.status === 403 ? ' Check the API key (and account) in Settings.' : '';
    throw Object.assign(new Error(msg + ' (' + r.status + ').' + hint), { status: r.status === 406 ? 429 : 502 });
  }
  return data;
}

async function osToken(cfg, store, fresh) {
  if (!cfg.username || !cfg.password) return null;
  if (!fresh) { const [cached] = await store.getTemp(['oslogin']); if (cached) return cached; }
  const d = await osRequest(cfg, 'POST', '/login', { username: cfg.username, password: cfg.password });
  const base = d.base_url ? (/^https?:/.test(d.base_url) ? d.base_url : 'https://' + d.base_url) + '/api/v1' : OS_API;
  const login = { token: d.token, base: process.env.OPENSUBTITLES_API ? OS_API : base };
  await store.setTemp('oslogin', login, 20 * 3600);
  return login;
}

async function handleSubs(req, res, pathname, params, store) {
  const settings = await store.getSettings();
  const cfg = settings.opensubtitles || {};
  if (pathname === '/api/subs/config' && req.method === 'GET') {
    return sendJson(res, 200, {
      configured: !!cfg.apiKey, keyHint: cfg.apiKey ? '…' + cfg.apiKey.slice(-4) : '',
      username: cfg.username || '', hasPassword: !!cfg.password, languages: cfg.languages || 'en',
    });
  }
  if (pathname === '/api/subs/config' && req.method === 'POST') {
    const b = await readJson(req).catch(() => null);
    if (!b) return sendJson(res, 400, { error: 'The request was not valid.' });
    if (b.clear) { delete settings.opensubtitles; await store.saveSettings(settings); await store.setTemp('oslogin', null, 1); return sendJson(res, 200, { ok: true }); }
    const c = { ...cfg };
    if (typeof b.apiKey === 'string' && b.apiKey.trim()) c.apiKey = b.apiKey.trim();
    if (typeof b.username === 'string') c.username = b.username.trim();
    if (typeof b.password === 'string' && b.password) c.password = b.password;
    if (b.username === '') delete c.password;
    if (typeof b.languages === 'string') c.languages = b.languages.toLowerCase().replace(/[^a-z,-]/g, '') || 'en';
    if (!c.apiKey) return sendJson(res, 400, { error: 'Enter your OpenSubtitles API key.' });
    if (typeof b.apiKey === 'string' && b.apiKey.trim()) {
      try { await osRequest(c, 'GET', '/infos/languages'); } catch (e) {
        if (e.status === 502 && !/\((401|403)\)/.test(e.message)) return sendJson(res, 502, { error: e.message });
        return sendJson(res, 400, { error: 'OpenSubtitles didn’t accept that API key. Copy it again from your API consumers page.' });
      }
    }
    settings.opensubtitles = c;
    await store.saveSettings(settings);
    await store.setTemp('oslogin', null, 1);
    if (c.username && c.password) {
      try { await osToken(c, store, true); } catch (e) { return sendJson(res, 400, { error: 'Saved, but signing in to OpenSubtitles failed: ' + e.message }); }
    }
    return sendJson(res, 200, { ok: true });
  }
  if (!cfg.apiKey) return sendJson(res, 400, { error: 'Online subtitles aren’t set up yet. Add your OpenSubtitles API key in Settings.' });

  if (pathname === '/api/subs/search' && req.method === 'GET') {
    const q = new URLSearchParams();
    const query = (params.get('query') || '').trim();
    if (!query) return sendJson(res, 400, { error: 'Type a title to search for.' });
    q.set('query', query.toLowerCase());
    q.set('languages', (params.get('languages') || cfg.languages || 'en').toLowerCase());
    for (const [k, v] of [['season_number', params.get('season')], ['episode_number', params.get('episode')], ['year', params.get('year')]]) {
      if (v && /^\d+$/.test(v)) q.set(k, v);
    }
    if (params.get('season')) q.set('type', 'episode');
    q.set('order_by', 'download_count');
    // OpenSubtitles wants the parameters sorted alphabetically.
    const sorted = new URLSearchParams([...q.entries()].sort(([a], [b]) => a.localeCompare(b)));
    try {
      const d = await osRequest(cfg, 'GET', '/subtitles?' + sorted.toString());
      const results = (d.data || []).flatMap((it) => {
        const a = it.attributes || {};
        return (a.files || []).slice(0, 1).map((f) => ({
          fileId: f.file_id, language: a.language, release: a.release || f.file_name || '',
          downloads: a.download_count || 0, hearingImpaired: !!a.hearing_impaired, machine: !!(a.machine_translated || a.ai_translated),
          title: a.feature_details?.title || '', year: a.feature_details?.year || '',
          season: a.feature_details?.season_number, episode: a.feature_details?.episode_number,
        }));
      });
      return sendJson(res, 200, { results: results.slice(0, 40) });
    } catch (e) { return sendJson(res, e.status || 502, { error: e.message }); }
  }

  if (pathname === '/api/subs/download' && req.method === 'POST') {
    const b = await readJson(req).catch(() => null);
    const fileId = Number(b && b.fileId);
    if (!fileId) return sendJson(res, 400, { error: 'Pick a subtitle first.' });
    try {
      const login = await osToken(cfg, store).catch(() => null);
      const d = await osRequest(cfg, 'POST', '/download', { file_id: fileId, sub_format: 'webvtt' }, login?.base, login?.token);
      if (!d.link) return sendJson(res, 502, { error: 'OpenSubtitles didn’t give a download link.' });
      const f = await fetch(d.link, { headers: { 'User-Agent': OS_UA }, signal: AbortSignal.timeout(20000) });
      if (!f.ok) return sendJson(res, 502, { error: 'Downloading the subtitle failed (' + f.status + ').' });
      return sendJson(res, 200, { text: await f.text(), remaining: d.remaining, resetIn: d.reset_time || '' });
    } catch (e) {
      const quota = e.status === 429 || /download limit|quota|406/i.test(e.message);
      return sendJson(res, e.status || 502, { error: quota ? 'Today’s OpenSubtitles download limit is used up. ' + (cfg.username ? '' : 'Adding your free account in Settings raises it. ') + 'It resets within 24 hours.' : e.message });
    }
  }
  return sendJson(res, 404, { error: 'Not found.' });
}

/* ------------------------------------------------- optional access password */
// Set SEVAK_PASSWORD (e.g. in Vercel's settings) and every browser has to
// enter it once. Without it SevakTV is open, as it is at home.

const AUTH_COOKIE = 'sevak_auth';
const PASSWORD = process.env.SEVAK_PASSWORD || '';
const authToken = () => crypto.createHmac('sha256', PASSWORD).update('sevaktv-access-v1').digest('hex');
function signedIn(req) {
  if (!PASSWORD) return true;
  const c = readCookie(req, AUTH_COOKIE) || '';
  const want = authToken();
  return c.length === want.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(want));
}
async function handleLogin(req, res) {
  if (!PASSWORD) return sendJson(res, 200, { ok: true });
  const b = await readJson(req).catch(() => ({}));
  const given = crypto.createHash('sha256').update(String(b.password || '')).digest();
  const want = crypto.createHash('sha256').update(PASSWORD).digest();
  if (!crypto.timingSafeEqual(given, want)) {
    await new Promise((r) => setTimeout(r, 800));
    return sendJson(res, 401, { error: 'That password isn’t right.' });
  }
  return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, AUTH_COOKIE, authToken(), 30 * 86400) });
}

/* ---------------------------------------------------------------- routing */

// Handles /api/* and /proxy. Returns false for anything else (static files).
function createHandler({ storage }) {
  return async function handle(req, res, pathname, params) {
    if (!pathname.startsWith('/api/') && pathname !== '/proxy') return false;
    cors(res);
    if (req.method === 'OPTIONS') { res.writeHead(204).end(); return true; }
    try {
      if (pathname === '/api/status') {
        sendJson(res, 200, { proxy: true, devices: !!storage, subtitles: !!storage, password: !!PASSWORD, signedIn: signedIn(req), host: ON_VERCEL ? 'vercel' : 'home', version: 5 });
        return true;
      }
      if (pathname === '/api/login' && req.method === 'POST') { await handleLogin(req, res); return true; }
      if (pathname === '/api/logout' && req.method === 'POST') {
        sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, AUTH_COOKIE, '', 0) });
        return true;
      }
      if (!signedIn(req)) { sendJson(res, 401, { error: 'Sign in to SevakTV first.', signIn: true }); return true; }

      if (pathname === '/proxy') { await handleProxy(req, res, params); return true; }
      if (pathname === '/api/diagnose') { await handleDiagnose(req, res, params); return true; }
      if (pathname.startsWith('/api/subs/') || pathname.startsWith('/api/device')) {
        if (!storage) {
          sendJson(res, 503, { error: 'No database is connected yet. In Vercel, open Storage → connect an Upstash Redis database to this project, then redeploy.' });
          return true;
        }
        if (pathname.startsWith('/api/subs/')) await handleSubs(req, res, pathname, params, storage);
        else await handleDevices(req, res, pathname, storage);
        return true;
      }
      sendJson(res, 404, { error: 'Not found.' });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 500, { error: e.message });
      else res.end();
    }
    return true;
  };
}

module.exports = { createHandler, tsCodecs, sniff };

// SevakTV on Cloudflare Workers: serves the app from public/ and runs the
// stream relay, stream check, device MACs, online subtitles and the optional
// access password. Device list and settings live in Workers KV (SEVAK_KV).
import tools from '../lib/stream-tools.js';

const { upstreamHeaders, rewriteHls, looksLikeHls, diagnose, normMac, newMac, guessName, ANY_MAC_RE } = tools;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
  'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges, Content-Type, X-Final-Url',
};
const json = (status, obj, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...CORS, ...headers } });
const plain = (status, body) => new Response(body, { status, headers: { 'Content-Type': 'text/plain', ...CORS } });
const readCookie = (req, name) => {
  const m = (req.headers.get('cookie') || '').match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
  return m ? decodeURIComponent(m[1]) : null;
};
const cookie = (name, value, maxAge) => `${name}=${encodeURIComponent(value)}; Max-Age=${maxAge}; Path=/; SameSite=Lax; HttpOnly; Secure`;
const readBody = async (req) => { try { return await req.json(); } catch { return null; } };

/* ---------------------------------------------------------------- storage */

function kvStore(kv) {
  return {
    async listDevices() { return (await kv.get('devices', 'json')) || []; },
    async saveDevices(list) { await kv.put('devices', JSON.stringify(list)); },
    async getSettings() { return (await kv.get('settings', 'json')) || {}; },
    async saveSettings(s) { await kv.put('settings', JSON.stringify(s)); },
    async setTemp(key, value, seconds) {
      if (value == null) await kv.delete('tmp:' + key);
      else await kv.put('tmp:' + key, JSON.stringify(value), { expirationTtl: Math.max(60, Math.round(seconds)) });
    },
    async getTemp(key) { return kv.get('tmp:' + key, 'json'); },
  };
}

/* ------------------------------------------------------------ the relay */

async function handleProxy(req, params) {
  let target;
  try { target = new URL(params.get('url')); } catch {}
  if (!target || !/^https?:$/.test(target.protocol)) return plain(400, 'Give a full http:// or https:// address in ?url=');
  const ua = params.get('ua') || '', ref = params.get('ref') || '', h = params.get('h') || '';
  const headers = upstreamHeaders(params);
  const range = req.headers.get('range');
  if (range) headers.Range = range;
  let upstream;
  try {
    upstream = await fetch(target.href, { headers, redirect: 'follow', signal: req.signal });
  } catch (e) {
    return plain(502, 'Could not reach ' + target.host + ': ' + (e.message || 'connection failed'));
  }
  const finalUrl = upstream.url || target.href;
  const ctype = upstream.headers.get('content-type') || '';
  const base = { ...CORS, 'X-Final-Url': encodeURI(finalUrl) };

  if (params.get('raw') !== '1' && upstream.ok && looksLikeHls(ctype, finalUrl)) {
    const body = await upstream.text();
    if (body.trimStart().startsWith('#EXTM3U')) {
      return new Response(rewriteHls(body, finalUrl, ua, ref, h), { status: 200, headers: { ...base, 'Content-Type': 'application/vnd.apple.mpegurl', 'Cache-Control': 'no-cache' } });
    }
    return new Response(body, { status: upstream.status, headers: { ...base, 'Content-Type': ctype || 'text/plain' } });
  }
  const out = { ...base };
  for (const k of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'last-modified']) {
    const v = upstream.headers.get(k);
    if (v) out[k] = v;
  }
  if (upstream.headers.get('content-encoding')) delete out['content-length'];
  // The body streams straight through for as long as the viewer watches.
  return new Response(req.method === 'HEAD' ? null : upstream.body, { status: upstream.status, headers: out });
}

/* ------------------------------------------------------------- devices */

async function handleDevices(req, pathname, store) {
  const body = req.method === 'POST' ? await readBody(req) : {};
  if (body === null) return json(400, { error: 'The request was not valid.' });
  const devices = await store.listDevices();
  const view = async (d) => ({ id: d.id, name: d.name, mac: d.mac, createdAt: d.createdAt, lastSeen: d.lastSeen, watching: (await store.getTemp('watch:' + d.id)) || null });

  if (pathname === '/api/device/register' && req.method === 'POST') {
    const id = (typeof body.id === 'string' && body.id) || readCookie(req, 'sevak_device');
    let dev = id && devices.find((d) => d.id === id);
    if (!dev) {
      const preferred = normMac(body.preferredMac);
      dev = {
        id: crypto.randomUUID(),
        name: guessName(req.headers.get('user-agent'), devices),
        mac: preferred && !devices.some((d) => d.mac === preferred) ? preferred : newMac(devices),
        createdAt: new Date().toISOString(),
      };
      devices.push(dev);
    }
    // Only write when something changed or an hour passed, to spare KV writes.
    const stale = !dev.lastSeen || Date.now() - Date.parse(dev.lastSeen) > 3600000;
    if (stale || !id) { dev.lastSeen = new Date().toISOString(); await store.saveDevices(devices); }
    return json(200, await view(dev), { 'Set-Cookie': cookie('sevak_device', dev.id, 315360000) });
  }
  if (pathname === '/api/device/ping' && req.method === 'POST') {
    const dev = devices.find((d) => d.id === body.id);
    if (!dev) return json(404, { error: 'Unknown device.' });
    await store.setTemp('watch:' + dev.id, body.watching ? String(body.watching).slice(0, 120) : null, 90);
    return json(200, { ok: true });
  }
  if (pathname === '/api/devices' && req.method === 'GET') {
    return json(200, { devices: await Promise.all(devices.map(view)) });
  }
  const m = pathname.match(/^\/api\/devices\/([\w-]+)(\/new-mac)?$/);
  const dev = m && devices.find((d) => d.id === m[1]);
  if (m && !dev) return json(404, { error: 'That device no longer exists.' });
  if (m && m[2] && req.method === 'POST') {
    dev.mac = newMac(devices);
    await store.saveDevices(devices);
    return json(200, await view(dev));
  }
  if (m && req.method === 'POST') {
    if (body.name !== undefined) {
      const name = String(body.name).trim().slice(0, 40);
      if (!name) return json(400, { error: 'Give the device a name.' });
      dev.name = name;
    }
    if (body.mac !== undefined) {
      const mac = normMac(body.mac);
      if (!mac || !ANY_MAC_RE.test(mac)) return json(400, { error: 'A MAC address looks like 00:1A:79:12:34:56.' });
      if (devices.some((d) => d.mac === mac && d.id !== dev.id)) return json(409, { error: 'Another device already uses that MAC address.' });
      dev.mac = mac;
    }
    await store.saveDevices(devices);
    return json(200, await view(dev));
  }
  if (m && req.method === 'DELETE') {
    await store.saveDevices(devices.filter((d) => d !== dev));
    await store.setTemp('watch:' + dev.id, null, 60);
    return json(200, { ok: true });
  }
  return json(404, { error: 'Not found.' });
}

/* ------------------------------------------------------ online subtitles */

const OS_UA = 'SevakTV v1.0';
async function osRequest(env, cfg, method, path, body, base, token) {
  const api = base || env.OPENSUBTITLES_API || 'https://api.opensubtitles.com/api/v1';
  const headers = { 'Api-Key': cfg.apiKey, 'User-Agent': OS_UA, Accept: 'application/json' };
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = 'Bearer ' + token;
  let r;
  try {
    r = await fetch(api + path, { method, headers, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(20000) });
  } catch (e) {
    throw Object.assign(new Error('Couldn’t reach OpenSubtitles (' + (e.name || 'error') + ').'), { status: 502 });
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = data.message || data.errors?.join(' ') || 'OpenSubtitles answered with an error';
    const hint = r.status === 401 || r.status === 403 ? ' Check the API key (and account) in Settings.' : '';
    throw Object.assign(new Error(msg + ' (' + r.status + ').' + hint), { status: r.status === 406 ? 429 : 502 });
  }
  return data;
}
async function osToken(env, cfg, store, fresh) {
  if (!cfg.username || !cfg.password) return null;
  if (!fresh) { const cached = await store.getTemp('oslogin'); if (cached) return cached; }
  const d = await osRequest(env, cfg, 'POST', '/login', { username: cfg.username, password: cfg.password });
  const base = env.OPENSUBTITLES_API ? null : d.base_url ? (/^https?:/.test(d.base_url) ? d.base_url : 'https://' + d.base_url) + '/api/v1' : null;
  const login = { token: d.token, base };
  await store.setTemp('oslogin', login, 20 * 3600);
  return login;
}

async function handleSubs(req, pathname, params, store, env) {
  const settings = await store.getSettings();
  const cfg = settings.opensubtitles || {};
  if (pathname === '/api/subs/config' && req.method === 'GET') {
    return json(200, { configured: !!cfg.apiKey, keyHint: cfg.apiKey ? '…' + cfg.apiKey.slice(-4) : '', username: cfg.username || '', hasPassword: !!cfg.password, languages: cfg.languages || 'en' });
  }
  if (pathname === '/api/subs/config' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b) return json(400, { error: 'The request was not valid.' });
    if (b.clear) { delete settings.opensubtitles; await store.saveSettings(settings); await store.setTemp('oslogin', null, 60); return json(200, { ok: true }); }
    const c = { ...cfg };
    if (typeof b.apiKey === 'string' && b.apiKey.trim()) c.apiKey = b.apiKey.trim();
    if (typeof b.username === 'string') c.username = b.username.trim();
    if (typeof b.password === 'string' && b.password) c.password = b.password;
    if (b.username === '') delete c.password;
    if (typeof b.languages === 'string') c.languages = b.languages.toLowerCase().replace(/[^a-z,-]/g, '') || 'en';
    if (!c.apiKey) return json(400, { error: 'Enter your OpenSubtitles API key.' });
    if (typeof b.apiKey === 'string' && b.apiKey.trim()) {
      try { await osRequest(env, c, 'GET', '/infos/languages'); } catch (e) {
        if (e.status === 502 && !/\((401|403)\)/.test(e.message)) return json(502, { error: e.message });
        return json(400, { error: 'OpenSubtitles didn’t accept that API key. Copy it again from your API consumers page.' });
      }
    }
    settings.opensubtitles = c;
    await store.saveSettings(settings);
    await store.setTemp('oslogin', null, 60);
    if (c.username && c.password) {
      try { await osToken(env, c, store, true); } catch (e) { return json(400, { error: 'Saved, but signing in to OpenSubtitles failed: ' + e.message }); }
    }
    return json(200, { ok: true });
  }
  if (!cfg.apiKey) return json(400, { error: 'Online subtitles aren’t set up yet. Add your OpenSubtitles API key in Settings.' });
  if (pathname === '/api/subs/search' && req.method === 'GET') {
    const query = (params.get('query') || '').trim();
    if (!query) return json(400, { error: 'Type a title to search for.' });
    const q = new URLSearchParams();
    q.set('query', query.toLowerCase());
    q.set('languages', (params.get('languages') || cfg.languages || 'en').toLowerCase());
    for (const [k, v] of [['season_number', params.get('season')], ['episode_number', params.get('episode')], ['year', params.get('year')]]) {
      if (v && /^\d+$/.test(v)) q.set(k, v);
    }
    if (params.get('season')) q.set('type', 'episode');
    q.set('order_by', 'download_count');
    const sorted = new URLSearchParams([...q.entries()].sort(([a], [b]) => a.localeCompare(b)));
    try {
      const d = await osRequest(env, cfg, 'GET', '/subtitles?' + sorted.toString());
      const results = (d.data || []).flatMap((it) => {
        const a = it.attributes || {};
        return (a.files || []).slice(0, 1).map((f) => ({
          fileId: f.file_id, language: a.language, release: a.release || f.file_name || '',
          downloads: a.download_count || 0, hearingImpaired: !!a.hearing_impaired, machine: !!(a.machine_translated || a.ai_translated),
          title: a.feature_details?.title || '', year: a.feature_details?.year || '',
          season: a.feature_details?.season_number, episode: a.feature_details?.episode_number,
        }));
      });
      return json(200, { results: results.slice(0, 40) });
    } catch (e) { return json(e.status || 502, { error: e.message }); }
  }
  if (pathname === '/api/subs/download' && req.method === 'POST') {
    const b = await readBody(req);
    const fileId = Number(b && b.fileId);
    if (!fileId) return json(400, { error: 'Pick a subtitle first.' });
    try {
      const login = await osToken(env, cfg, store).catch(() => null);
      const d = await osRequest(env, cfg, 'POST', '/download', { file_id: fileId, sub_format: 'webvtt' }, login?.base, login?.token);
      if (!d.link) return json(502, { error: 'OpenSubtitles didn’t give a download link.' });
      const f = await fetch(d.link, { headers: { 'User-Agent': OS_UA }, signal: AbortSignal.timeout(20000) });
      if (!f.ok) return json(502, { error: 'Downloading the subtitle failed (' + f.status + ').' });
      return json(200, { text: await f.text(), remaining: d.remaining, resetIn: d.reset_time || '' });
    } catch (e) {
      const quota = e.status === 429 || /download limit|quota|406/i.test(e.message);
      return json(e.status || 502, { error: quota ? 'Today’s OpenSubtitles download limit is used up. ' + (cfg.username ? '' : 'Adding your free account in Settings raises it. ') + 'It resets within 24 hours.' : e.message });
    }
  }
  return json(404, { error: 'Not found.' });
}

/* ------------------------------------------------- optional access password */

async function sha256Hex(s) {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function authToken(env) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(env.SEVAK_PASSWORD), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('sevaktv-access-v1'));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
async function signedIn(req, env) {
  if (!env.SEVAK_PASSWORD) return true;
  return (readCookie(req, 'sevak_auth') || '') === (await authToken(env));
}

/* ---------------------------------------------------------------- routing */

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path !== '/proxy' && !path.startsWith('/api/')) return env.ASSETS.fetch(req);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS });
    const store = env.SEVAK_KV ? kvStore(env.SEVAK_KV) : null;
    try {
      if (path === '/api/status') {
        return json(200, { proxy: true, devices: !!store, subtitles: !!store, password: !!env.SEVAK_PASSWORD, signedIn: await signedIn(req, env), host: 'cloudflare', version: 5 });
      }
      if (path === '/api/login' && req.method === 'POST') {
        if (!env.SEVAK_PASSWORD) return json(200, { ok: true });
        const b = (await readBody(req)) || {};
        if ((await sha256Hex(String(b.password || ''))) !== (await sha256Hex(env.SEVAK_PASSWORD))) {
          await new Promise((r) => setTimeout(r, 800));
          return json(401, { error: 'That password isn’t right.' });
        }
        return json(200, { ok: true }, { 'Set-Cookie': cookie('sevak_auth', await authToken(env), 30 * 86400) });
      }
      if (path === '/api/logout' && req.method === 'POST') return json(200, { ok: true }, { 'Set-Cookie': cookie('sevak_auth', '', 0) });
      if (!(await signedIn(req, env))) return json(401, { error: 'Sign in to SevakTV first.', signIn: true });

      if (path === '/proxy') return await handleProxy(req, url.searchParams);
      if (path === '/api/diagnose') {
        let target;
        try { target = new URL(url.searchParams.get('url')); } catch {}
        if (!target || !/^https?:$/.test(target.protocol)) return json(400, { error: 'Give a full address in ?url=' });
        return json(200, await diagnose(target.href, upstreamHeaders(url.searchParams)));
      }
      if (path.startsWith('/api/subs/') || path.startsWith('/api/device')) {
        if (!store) return json(503, { error: 'No storage is connected yet. Add a KV namespace binding named SEVAK_KV to this Worker.' });
        return path.startsWith('/api/subs/') ? await handleSubs(req, path, url.searchParams, store, env) : await handleDevices(req, path, store);
      }
      return json(404, { error: 'Not found.' });
    } catch (e) {
      return json(500, { error: e.message });
    }
  },
};
